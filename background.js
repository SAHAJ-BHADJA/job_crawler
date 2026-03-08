const STORAGE_KEY = "crawlHistory";
const MAX_ENTRIES = 200;
const LOAD_TIMEOUT_MS = 25000;
const PAGE_DELAY_MS = 1200;
const AUTO_MAX_PAGES = 20;
const ANALYZE_PAGE_DELAY_MS = 900;
const ANALYZE_LOAD_TIMEOUT_MS = 30000;
const MAX_ANALYZE_LINKS = 120;
const F1_REJECT_TERMS = ["us citizen", "citizenship required", "security clearance"];
const F1_NO_SPONSOR_TERMS = [
  "no visa sponsorship",
  "will not sponsor now or in the future",
  "will not sponsor now or future",
  "cannot provide sponsorship",
  "unable to provide sponsorship"
];
const F1_ELIGIBLE_TERMS = [
  "visa sponsorship available",
  "sponsorship available",
  "cpt",
  "opt",
  "f-1",
  "f1 visa"
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get([STORAGE_KEY], (result) => {
    if (!Array.isArray(result[STORAGE_KEY])) {
      chrome.storage.local.set({ [STORAGE_KEY]: [] });
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "RUN_CRAWL") {
    runCrawlForActiveTab({ maxPages: message?.payload?.maxPages })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "Failed to run crawl." }));
    return true;
  }

  if (message?.type === "ANALYZE_F1_ENTRY") {
    analyzeF1EligibilityForEntry(message?.payload?.entryId)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "Failed to analyze F1 eligibility."
        })
      );
    return true;
  }

  if (message?.type === "OPEN_F1_ELIGIBLE_TABS") {
    openEligibleTabsForEntry(message?.payload?.entryId)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "Failed to open eligible links."
        })
      );
    return true;
  }

  if (message?.type === "CRAWL_RESULTS") {
    saveCrawlResult(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "Failed to save crawl results."
        })
      );
    return true;
  }

  if (message?.type === "GET_CRAWL_HISTORY") {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      sendResponse({ ok: true, data: result[STORAGE_KEY] || [] });
    });
    return true;
  }

  if (message?.type === "CLEAR_CRAWL_HISTORY") {
    chrome.storage.local.set({ [STORAGE_KEY]: [] }, () => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "EXPORT_CRAWL_HISTORY") {
    exportHistory()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "Failed to export crawl history."
        })
      );
    return true;
  }

  return false;
});

async function runCrawlForActiveTab(options = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");
  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("edge://")) {
    throw new Error("Open a standard webpage before crawling.");
  }

  const maxPages = clampNumber(options.maxPages, 1, 30, AUTO_MAX_PAGES);
  const pageResults = [];
  const visited = new Set();
  const seenJobLinkKeys = new Set();
  let noNewJobLinksStreak = 0;
  let crawlUrl = tab.url;

  while (pageResults.length < maxPages) {
    const normalized = normalizeUrl(crawlUrl);
    if (visited.has(normalized)) break;
    visited.add(normalized);

    await updateTabUrl(tab.id, crawlUrl);
    await waitForTabComplete(tab.id, LOAD_TIMEOUT_MS);
    await sleep(PAGE_DELAY_MS);

    const result = await extractLinksFromTab(tab.id);
    pageResults.push({
      pageUrl: result.pageUrl || crawlUrl,
      pageTitle: result.pageTitle || "(untitled)",
      totalLinks: Array.isArray(result.links) ? result.links.length : 0,
      links: Array.isArray(result.links) ? result.links : []
    });

    const currentLinks = Array.isArray(result.links) ? result.links : [];
    const pageJobLinks = currentLinks.filter((link) => isLikelyJobLink(link.href, link.text));
    let newJobLinks = 0;
    for (const link of pageJobLinks) {
      const key = canonicalizeJobUrl(link.href);
      if (seenJobLinkKeys.has(key)) continue;
      seenJobLinkKeys.add(key);
      newJobLinks += 1;
    }

    if (newJobLinks === 0) {
      noNewJobLinksStreak += 1;
    } else {
      noNewJobLinksStreak = 0;
    }

    if (noNewJobLinksStreak >= 2) break;
    if (!result.nextPageUrl) break;
    crawlUrl = result.nextPageUrl;
  }

  const mergedLinks = dedupeByHref(pageResults.flatMap((page) => page.links));
  const payload = {
    pageUrl: pageResults[0]?.pageUrl || tab.url,
    pageTitle: pageResults[0]?.pageTitle || "(untitled)",
    crawledAt: new Date().toISOString(),
    pagesCrawled: pageResults.length,
    crawledPages: pageResults.map((page) => ({
      pageUrl: page.pageUrl,
      pageTitle: page.pageTitle,
      totalLinks: page.totalLinks
    })),
    links: mergedLinks
  };

  await saveCrawlResult(payload);
  return { pagesCrawled: payload.pagesCrawled, uniqueLinks: mergedLinks.length };
}

async function analyzeF1EligibilityForEntry(entryId) {
  if (!entryId) throw new Error("Missing entry id.");

  const history = await getHistory();
  const index = history.findIndex((item) => item.id === entryId);
  if (index === -1) throw new Error("Crawl session not found.");

  const entry = history[index];
  const candidateLinks = getJobCandidateLinks(entry).slice(0, MAX_ANALYZE_LINKS);
  if (!candidateLinks.length) {
    const analysis = {
      analyzedAt: new Date().toISOString(),
      rejectTerms: F1_REJECT_TERMS,
      noSponsorTerms: F1_NO_SPONSOR_TERMS,
      eligibleTerms: F1_ELIGIBLE_TERMS,
      scannedLinks: 0,
      eligibleCount: 0,
      rejectedCount: 0,
      noSponsorCount: 0,
      reviewCount: 0,
      failedCount: 0,
      eligibleLinks: [],
      rejectedLinks: [],
      noSponsorLinks: [],
      reviewLinks: [],
      failedLinks: []
    };
    history[index] = { ...entry, f1Analysis: analysis };
    await chrome.storage.local.set({ [STORAGE_KEY]: history });
    return analysis;
  }

  const eligibleLinks = [];
  const rejectedLinks = [];
  const noSponsorLinks = [];
  const reviewLinks = [];
  const failedLinks = [];

  for (const link of candidateLinks) {
    const result = await analyzeLinkContentForF1(link.href);
    const base = {
      sourceHref: link.href,
      href: result.analyzedUrl || link.href,
      text: link.text || "",
      internal: !!link.internal,
      pageTitle: result.pageTitle || ""
    };

    if (result.failed) {
      failedLinks.push({ ...base, error: result.error || "Failed to inspect page." });
    } else if (result.bucket === "rejected") {
      rejectedLinks.push({ ...base, matchedTerms: result.matchedRejectTerms || [] });
    } else if (result.bucket === "no_sponsor") {
      noSponsorLinks.push({ ...base, matchedTerms: result.matchedNoSponsorTerms || [] });
    } else if (result.bucket === "eligible") {
      eligibleLinks.push({ ...base, matchedTerms: result.matchedEligibleTerms || [] });
    } else {
      reviewLinks.push(base);
    }

    await sleep(ANALYZE_PAGE_DELAY_MS);
  }

  const analysis = {
    analyzedAt: new Date().toISOString(),
    rejectTerms: F1_REJECT_TERMS,
    noSponsorTerms: F1_NO_SPONSOR_TERMS,
    eligibleTerms: F1_ELIGIBLE_TERMS,
    scannedLinks: candidateLinks.length,
    eligibleCount: eligibleLinks.length,
    rejectedCount: rejectedLinks.length,
    noSponsorCount: noSponsorLinks.length,
    reviewCount: reviewLinks.length,
    failedCount: failedLinks.length,
    eligibleLinks,
    rejectedLinks,
    noSponsorLinks,
    reviewLinks,
    failedLinks
  };

  history[index] = { ...entry, f1Analysis: analysis };
  await chrome.storage.local.set({ [STORAGE_KEY]: history });
  return analysis;
}

async function openEligibleTabsForEntry(entryId) {
  if (!entryId) throw new Error("Missing entry id.");
  const history = await getHistory();
  const entry = history.find((item) => item.id === entryId);
  if (!entry) throw new Error("Crawl session not found.");

  const analysis = entry.f1Analysis || {};
  const eligibleLinks = Array.isArray(analysis.eligibleLinks) ? analysis.eligibleLinks : [];
  const noSponsorLinks = Array.isArray(analysis.noSponsorLinks) ? analysis.noSponsorLinks : [];
  const reviewLinks = Array.isArray(analysis.reviewLinks) ? analysis.reviewLinks : [];

  const merged = dedupeByHref([...eligibleLinks, ...noSponsorLinks, ...reviewLinks]);
  if (!merged.length) {
    throw new Error("No links found in Eligible / No-Sponsor / Review. Run analysis first.");
  }

  for (const link of merged) {
    await createBackgroundTab(link.href);
    await sleep(120);
  }

  return { openedTabs: merged.length };
}

async function saveCrawlResult(payload) {
  if (!payload || !Array.isArray(payload.links)) {
    throw new Error("Invalid crawl payload.");
  }

  const history = await getHistory();
  const normalizedLinks = dedupeByHref(payload.links).map((link) => ({
    href: link.href,
    text: link.text || "",
    internal: !!link.internal
  }));

  const entry = {
    id: crypto.randomUUID(),
    pageUrl: payload.pageUrl,
    pageTitle: payload.pageTitle || "(untitled)",
    crawledAt: payload.crawledAt || new Date().toISOString(),
    pagesCrawled: payload.pagesCrawled || 1,
    crawledPages: Array.isArray(payload.crawledPages) ? payload.crawledPages : [],
    totalLinks: normalizedLinks.length,
    internalCount: normalizedLinks.filter((link) => link.internal).length,
    externalCount: normalizedLinks.filter((link) => !link.internal).length,
    links: normalizedLinks
  };

  const updated = [entry, ...history].slice(0, MAX_ENTRIES);
  await chrome.storage.local.set({ [STORAGE_KEY]: updated });
}

async function getHistory() {
  const current = await chrome.storage.local.get([STORAGE_KEY]);
  return Array.isArray(current[STORAGE_KEY]) ? current[STORAGE_KEY] : [];
}

function getJobCandidateLinks(entry) {
  const links = Array.isArray(entry?.links) ? entry.links : [];
  const deduped = dedupeByHref(links);
  const unique = new Map();
  for (const link of deduped) {
    if (!isLikelyJobLink(link.href, link.text)) continue;
    const key = canonicalizeJobUrl(link.href);
    if (!unique.has(key)) unique.set(key, link);
  }
  return Array.from(unique.values());
}

function isLikelyJobLink(href, text = "") {
  if (!href) return false;
  let url;
  try {
    url = new URL(href);
  } catch (_error) {
    return false;
  }
  if (!["http:", "https:"].includes(url.protocol)) return false;

  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();
  const textLower = (text || "").toLowerCase();

  if (hostname.includes("linkedin.com")) {
    return pathname.includes("/jobs/view/");
  }

  const blockedSegments = [
    "/help",
    "/support",
    "/privacy",
    "/terms",
    "/contact",
    "/about",
    "/blog",
    "/pricing",
    "/premium"
  ];
  if (blockedSegments.some((segment) => pathname.includes(segment))) return false;

  const jobPathPattern =
    /(^|\/)(job|jobs|career|careers|position|positions|requisition|requisitions|opening|openings|vacancy|vacancies)(\/|$|-)/;
  if (jobPathPattern.test(pathname)) return true;

  const hostHints = hostname.startsWith("jobs.") || hostname.includes(".jobs.");
  if (hostHints && (pathname.includes("apply") || textLower.includes("apply"))) return true;

  return false;
}

function canonicalizeJobUrl(href) {
  try {
    const url = new URL(href);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (host.includes("linkedin.com") && path.includes("/jobs/view/")) {
      return `${url.origin}${url.pathname}`;
    }

    url.hash = "";
    const dropParams = [
      "trk",
      "trackingid",
      "refid",
      "ref",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content"
    ];
    for (const key of dropParams) url.searchParams.delete(key);
    return url.toString();
  } catch (_error) {
    return String(href || "");
  }
}

async function analyzeLinkContentForF1(url) {
  if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) {
      return {
        failed: true,
        error: "Invalid URL.",
        bucket: "review",
        matchedRejectTerms: [],
        matchedNoSponsorTerms: [],
        matchedEligibleTerms: [],
        pageTitle: "",
        analyzedUrl: url || ""
      };
  }

  let analyzeUrl = url;
  if (isLinkedInJobUrl(url)) {
    const externalApplyUrl = await extractLinkedInExternalApplyUrl(url);
    if (externalApplyUrl) {
      analyzeUrl = externalApplyUrl;
    }
  }

  if (isLinkedInRedirectApplyUrl(analyzeUrl)) {
    const resolved = await resolveLinkedInRedirectToExternal(analyzeUrl);
    if (resolved) {
      analyzeUrl = resolved;
    } else {
      // If external apply cannot be resolved, analyze the LinkedIn JD itself.
      analyzeUrl = url;
    }
  }

  let tabId;
  try {
    const created = await createBackgroundTab(analyzeUrl);
    tabId = created.id;
    if (!tabId) {
      return {
        failed: true,
        error: "Unable to open tab.",
        bucket: "review",
        matchedRejectTerms: [],
        matchedNoSponsorTerms: [],
        matchedEligibleTerms: [],
        pageTitle: "",
        analyzedUrl: analyzeUrl
      };
    }

    await waitForTabComplete(tabId, ANALYZE_LOAD_TIMEOUT_MS);
    await sleep(700);

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (rejectTerms, noSponsorTerms, eligibleTerms) => {
        const text = (document.body?.innerText || "").toLowerCase();
        const matchedRejectTerms = rejectTerms.filter((term) => text.includes(term));
        const matchedNoSponsorTerms = noSponsorTerms.filter((term) => text.includes(term));
        const matchedEligibleTerms = eligibleTerms.filter((term) => text.includes(term));

        let bucket = "review";
        if (matchedRejectTerms.length) {
          bucket = "rejected";
        } else if (matchedNoSponsorTerms.length) {
          bucket = "no_sponsor";
        } else if (matchedEligibleTerms.length) {
          bucket = "eligible";
        }

        return {
          pageTitle: document.title || "",
          bucket,
          matchedRejectTerms,
          matchedNoSponsorTerms,
          matchedEligibleTerms
        };
      },
      args: [F1_REJECT_TERMS, F1_NO_SPONSOR_TERMS, F1_ELIGIBLE_TERMS]
    });

    return {
      failed: false,
      analyzedUrl: analyzeUrl,
      bucket: result?.bucket || "review",
      pageTitle: result?.pageTitle || "",
      matchedRejectTerms: Array.isArray(result?.matchedRejectTerms) ? result.matchedRejectTerms : [],
      matchedNoSponsorTerms: Array.isArray(result?.matchedNoSponsorTerms)
        ? result.matchedNoSponsorTerms
        : [],
      matchedEligibleTerms: Array.isArray(result?.matchedEligibleTerms) ? result.matchedEligibleTerms : []
    };
  } catch (error) {
    return {
      failed: true,
      error: error?.message || "Failed to inspect page.",
      bucket: "review",
      matchedRejectTerms: [],
      matchedNoSponsorTerms: [],
      matchedEligibleTerms: [],
      pageTitle: "",
      analyzedUrl: analyzeUrl
    };
  } finally {
    if (tabId) {
      await removeTabSafe(tabId);
    }
  }
}

function isLinkedInJobUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes("linkedin.com") && parsed.pathname.includes("/jobs/view/");
  } catch (_error) {
    return false;
  }
}

function isLinkedInRedirectApplyUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("linkedin.com")) return false;
    const path = parsed.pathname.toLowerCase();
    return path.includes("/jobs/redirect/") || path.includes("/jobs/view/externalapply/");
  } catch (_error) {
    return false;
  }
}

async function extractLinkedInExternalApplyUrl(linkedinJobUrl) {
  let tabId;
  try {
    const created = await createBackgroundTab(linkedinJobUrl);
    tabId = created.id;
    if (!tabId) return null;

    await waitForTabComplete(tabId, ANALYZE_LOAD_TIMEOUT_MS);
    await sleep(700);

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const anchors = Array.from(document.querySelectorAll("a[href]"));
        const buttons = Array.from(document.querySelectorAll("button"));
        const candidates = anchors.map((anchor) => {
          const href = anchor.href ? anchor.href.trim() : "";
          const text = (anchor.textContent || "").toLowerCase();
          const control = (anchor.getAttribute("data-control-name") || "").toLowerCase();
          return { href, text, control };
        });

        for (const button of buttons) {
          const attrs = [
            "data-apply-url",
            "data-url",
            "data-href",
            "data-redirect-url",
            "data-tracking-control-name"
          ];
          const text = (button.textContent || "").toLowerCase();
          const control = (button.getAttribute("data-control-name") || "").toLowerCase();
          for (const attr of attrs) {
            const raw = (button.getAttribute(attr) || "").trim();
            if (!raw) continue;
            candidates.push({ href: raw, text, control });
          }

          const onclick = (button.getAttribute("onclick") || "").trim();
          if (onclick) {
            const extracted = extractUrlFromText(onclick);
            if (extracted) candidates.push({ href: extracted, text, control });
          }
        }

        const scriptDerived = extractFromScripts();
        for (const href of scriptDerived) {
          candidates.push({ href, text: "script-url", control: "script-url" });
        }

        const sorted = candidates
          .filter((item) => item.href)
          .sort((a, b) => score(b) - score(a));

        for (const item of sorted) {
          const resolved = resolveExternal(item.href);
          if (resolved) return resolved;
        }
        return null;

        function score(item) {
          let s = 0;
          if (item.text.includes("apply")) s += 6;
          if (item.text.includes("company")) s += 2;
          if (item.control.includes("inapply") || item.control.includes("offsite")) s += 8;
          if (item.href.includes("/jobs/redirect/")) s += 7;
          if (item.href.includes("apply")) s += 3;
          return s;
        }

        function resolveExternal(href) {
          try {
            const parsed = new URL(href, window.location.href);
            let candidate = parsed;
            if (
              parsed.pathname.toLowerCase().includes("/jobs/redirect/") ||
              parsed.pathname.toLowerCase().includes("/jobs/view/externalapply/")
            ) {
              const target =
                parsed.searchParams.get("url") ||
                parsed.searchParams.get("target") ||
                parsed.searchParams.get("destRedirectURL");
              if (target) {
                candidate = new URL(decodeURIComponent(target));
              }
            }

            if (!["http:", "https:"].includes(candidate.protocol)) return null;
            if (candidate.hostname.includes("linkedin.com")) {
              if (isLinkedInApplyRedirect(candidate)) return candidate.toString();
              return null;
            }
            return candidate.toString();
          } catch (_error) {
            return null;
          }
        }

        function isLinkedInApplyRedirect(urlObj) {
          const path = urlObj.pathname.toLowerCase();
          return path.includes("/jobs/redirect/") || path.includes("/jobs/view/externalapply/");
        }

        function extractFromScripts() {
          const out = [];
          const scripts = Array.from(document.querySelectorAll("script"));
          for (const script of scripts) {
            const text = script.textContent || "";
            if (!text) continue;

            const keys = ["offsiteApplyUrl", "externalApplyUrl", "companyApplyUrl", "applyUrl"];
            for (const key of keys) {
              const re = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "gi");
              let match;
              while ((match = re.exec(text)) !== null) {
                const raw = match[1];
                const cleaned = decodeJsEscapedUrl(raw);
                if (cleaned) out.push(cleaned);
              }
            }

            const generic = new RegExp("https?:\\\\/\\\\/[^\\s\"'<>\\\\]+", "gi");
            let any;
            while ((any = generic.exec(text)) !== null) {
              const raw = any[0];
              if (!raw.toLowerCase().includes("apply")) continue;
              const cleaned = decodeJsEscapedUrl(raw);
              if (cleaned) out.push(cleaned);
            }
          }
          return out;
        }

        function decodeJsEscapedUrl(value) {
          if (!value) return "";
          const cleaned = value
            .replace(/\\u002F/g, "/")
            .replace(/\\\//g, "/")
            .replace(/&amp;/g, "&")
            .trim();
          return cleaned;
        }

        function extractUrlFromText(text) {
          if (!text) return "";
          const found = text.match(/https?:\/\/[^\s"'<>\\)]+/i);
          return found ? found[0] : "";
        }
      }
    });

    if (result) return result;
    return null;
  } catch (_error) {
    return null;
  } finally {
    if (tabId) {
      await removeTabSafe(tabId);
    }
  }
}

function normalizeExternalCandidate(url) {
  if (!url) return null;
  const decoded = decodeRedirectParam(url) || url;
  try {
    const parsed = new URL(decoded);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.hostname.includes("linkedin.com")) {
      if (isLinkedInRedirectApplyUrl(parsed.toString())) return null;
      return null;
    }
    return parsed.toString();
  } catch (_error) {
    return null;
  }
}

async function resolveLinkedInRedirectToExternal(redirectUrl) {
  let tabId;
  try {
    const created = await createBackgroundTab(redirectUrl);
    tabId = created.id;
    if (!tabId) return null;

    await waitForTabComplete(tabId, ANALYZE_LOAD_TIMEOUT_MS);
    await sleep(1000);

    let current = await getTabSafe(tabId);
    for (let i = 0; i < 8; i += 1) {
      if (!current.url) break;
      if (!current.url.includes("linkedin.com")) return current.url;
      await sleep(400);
      current = await getTabSafe(tabId);
    }

    const decoded = decodeRedirectParam(redirectUrl);
    if (decoded && !decoded.includes("linkedin.com")) return decoded;
    return null;
  } catch (_error) {
    return null;
  } finally {
    if (tabId) {
      await removeTabSafe(tabId);
    }
  }
}

function decodeRedirectParam(url) {
  try {
    const parsed = new URL(url);
    const value =
      parsed.searchParams.get("url") ||
      parsed.searchParams.get("target") ||
      parsed.searchParams.get("destRedirectURL");
    if (!value) return null;
    const decoded = decodeURIComponent(value);
    const finalUrl = new URL(decoded);
    if (!["http:", "https:"].includes(finalUrl.protocol)) return null;
    return finalUrl.toString();
  } catch (_error) {
    return null;
  }
}

function dedupeByHref(links) {
  const seen = new Set();
  const out = [];
  for (const link of links) {
    if (!link?.href || seen.has(link.href)) continue;
    seen.add(link.href);
    out.push(link);
  }
  return out;
}

async function waitForTabComplete(tabId, timeoutMs) {
  const tab = await getTabSafe(tabId);
  if (tab.status === "complete") return;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for page load."));
    }, timeoutMs);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        cleanup();
        resolve();
      }
    }

    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function withTabRetry(action, attempts = 5, delayMs = 250) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      const msg = (error?.message || "").toLowerCase();
      const retryable =
        msg.includes("tabs cannot be edited right now") ||
        msg.includes("tab strip not editable") ||
        msg.includes("dragging a tab");
      if (!retryable || i === attempts - 1) throw error;
      await sleep(delayMs * (i + 1));
    }
  }
  throw lastError || new Error("Tab operation failed.");
}

async function createBackgroundTab(url) {
  return withTabRetry(() => chrome.tabs.create({ url, active: false }));
}

async function updateTabUrl(tabId, url) {
  return withTabRetry(() => chrome.tabs.update(tabId, { url }));
}

async function getTabSafe(tabId) {
  return withTabRetry(() => chrome.tabs.get(tabId));
}

async function removeTabSafe(tabId) {
  try {
    await withTabRetry(() => chrome.tabs.remove(tabId), 3, 150);
  } catch (_error) {
    // ignore close failures
  }
}

async function extractLinksFromTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const currentUrl = window.location.href;
      const current = new URL(currentUrl);
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const links = anchors
        .map((anchor) => {
          const href = anchor.href ? anchor.href.trim() : "";
          if (!href) return null;
          const text = (anchor.textContent || "").replace(/\s+/g, " ").trim();
          return {
            href,
            text,
            internal: href.startsWith(window.location.origin)
          };
        })
        .filter(Boolean);

      const nextPageUrl = detectNextPageUrl(anchors, current);

      return {
        pageUrl: currentUrl,
        pageTitle: document.title || "(untitled)",
        links,
        nextPageUrl
      };

      function detectNextPageUrl(anchorElements, currentUrlObj) {
        const relNext = document.querySelector("a[rel='next']");
        const ariaNext = document.querySelector("a[aria-label*='next' i]");
        const textNext = anchorElements.find((anchor) => {
          const text = (anchor.textContent || "").trim().toLowerCase();
          return text === "next" || text.startsWith("next ");
        });

        const direct = relNext?.href || ariaNext?.href || textNext?.href || "";
        if (isValidCandidate(direct, currentUrlObj)) {
          return new URL(direct, currentUrlObj.href).toString();
        }

        const linkedInNext = detectLinkedInSearchNext(currentUrlObj);
        if (linkedInNext) return linkedInNext;

        const candidates = [];
        for (const anchor of anchorElements) {
          const href = anchor.href ? anchor.href.trim() : "";
          if (!isValidCandidate(href, currentUrlObj)) continue;
          const parsed = new URL(href, currentUrlObj.href);
          const value = getNumericPageValue(parsed);
          if (value === null) continue;
          candidates.push({ href: parsed.toString(), value });
        }

        if (!candidates.length) return null;
        const currentValue = getNumericPageValue(currentUrlObj) ?? 0;
        const next = candidates
          .filter((candidate) => candidate.value > currentValue)
          .sort((a, b) => a.value - b.value)[0];
        return next ? next.href : null;
      }

      function detectLinkedInSearchNext(currentUrlObj) {
        if (!currentUrlObj.hostname.includes("linkedin.com")) return null;
        if (!currentUrlObj.pathname.includes("/jobs/search")) return null;

        const currentStartRaw = currentUrlObj.searchParams.get("start");
        const currentStart = Number.isFinite(Number(currentStartRaw)) ? Number(currentStartRaw) : 0;
        const currentPage = Math.floor(currentStart / 25) + 1;

        const pageNums = Array.from(
          document.querySelectorAll(
            ".artdeco-pagination__indicator--number, .artdeco-pagination__indicator button, .artdeco-pagination__pages button, .artdeco-pagination__pages li"
          )
        )
          .map((el) => Number((el.textContent || "").trim()))
          .filter((num) => Number.isFinite(num) && num > 0);

        const maxPage = pageNums.length ? Math.max(...pageNums) : null;
        const nextBtn =
          document.querySelector("button[aria-label='Next']") ||
          document.querySelector("button[aria-label*='next' i]") ||
          document.querySelector(".artdeco-pagination__button--next");

        const nextDisabled =
          !nextBtn ||
          nextBtn.hasAttribute("disabled") ||
          nextBtn.getAttribute("aria-disabled") === "true" ||
          nextBtn.classList.contains("artdeco-button--disabled");

        if (nextDisabled && maxPage !== null && currentPage >= maxPage) {
          return null;
        }
        if (nextDisabled && maxPage === null) {
          return null;
        }

        const next = new URL(currentUrlObj.toString());
        next.searchParams.set("start", String(currentStart + 25));
        return next.toString();
      }

      function getNumericPageValue(urlObj) {
        const keys = ["start", "page", "p"];
        for (const key of keys) {
          const raw = urlObj.searchParams.get(key);
          if (raw === null) continue;
          const num = Number(raw);
          if (Number.isFinite(num)) return num;
        }
        return null;
      }

      function isValidCandidate(href, currentUrlObj) {
        if (!href) return false;
        try {
          const parsed = new URL(href, currentUrlObj.href);
          if (!["http:", "https:"].includes(parsed.protocol)) return false;
          if (parsed.href === currentUrlObj.href) return false;
          if (parsed.origin !== currentUrlObj.origin) return false;

          if (parsed.searchParams.has("start") || parsed.searchParams.has("page") || parsed.searchParams.has("p")) {
            return true;
          }

          return parsed.pathname === currentUrlObj.pathname && parsed.search !== currentUrlObj.search;
        } catch (_error) {
          return false;
        }
      }
    }
  });

  return result || { pageUrl: "", pageTitle: "(untitled)", links: [], nextPageUrl: null };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return String(url || "");
  }
}

async function exportHistory() {
  const history = await getHistory();
  const blob = new Blob([JSON.stringify(history, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  await chrome.downloads.download({
    url,
    filename: `crawl-history-${Date.now()}.json`,
    saveAs: true
  });

  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
