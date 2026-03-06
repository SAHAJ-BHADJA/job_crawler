const STORAGE_KEY = "crawlHistory";
const MAX_ENTRIES = 200;
const PAGINATION_STEP = 25;
const LOAD_TIMEOUT_MS = 25000;
const PAGE_DELAY_MS = 1200;
const ANALYZE_PAGE_DELAY_MS = 900;
const ANALYZE_LOAD_TIMEOUT_MS = 30000;
const MAX_ANALYZE_LINKS = 120;
const F1_BLOCK_TERMS = ["us citizen", "citizenship required", "security clearance"];

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

  const maxPages = clampNumber(options.maxPages, 1, 20, 1);
  const crawlTargets = buildPaginatedUrls(tab.url, maxPages);
  const pageResults = [];

  for (const crawlUrl of crawlTargets) {
    await chrome.tabs.update(tab.id, { url: crawlUrl });
    await waitForTabComplete(tab.id, LOAD_TIMEOUT_MS);
    await sleep(PAGE_DELAY_MS);

    const result = await extractLinksFromTab(tab.id);
    pageResults.push({
      pageUrl: result.pageUrl || crawlUrl,
      pageTitle: result.pageTitle || "(untitled)",
      totalLinks: Array.isArray(result.links) ? result.links.length : 0,
      links: Array.isArray(result.links) ? result.links : []
    });
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
      blockedTerms: F1_BLOCK_TERMS,
      scannedLinks: 0,
      eligibleCount: 0,
      rejectedCount: 0,
      failedCount: 0,
      eligibleLinks: [],
      rejectedLinks: [],
      failedLinks: []
    };
    history[index] = { ...entry, f1Analysis: analysis };
    await chrome.storage.local.set({ [STORAGE_KEY]: history });
    return analysis;
  }

  const eligibleLinks = [];
  const rejectedLinks = [];
  const failedLinks = [];

  for (const link of candidateLinks) {
    const result = await analyzeLinkContentForF1(link.href);
    const base = {
      href: link.href,
      text: link.text || "",
      internal: !!link.internal,
      pageTitle: result.pageTitle || ""
    };

    if (result.failed) {
      failedLinks.push({ ...base, error: result.error || "Failed to inspect page." });
    } else if (result.matchedTerms.length > 0) {
      rejectedLinks.push({ ...base, matchedTerms: result.matchedTerms });
    } else {
      eligibleLinks.push(base);
    }

    await sleep(ANALYZE_PAGE_DELAY_MS);
  }

  const analysis = {
    analyzedAt: new Date().toISOString(),
    blockedTerms: F1_BLOCK_TERMS,
    scannedLinks: candidateLinks.length,
    eligibleCount: eligibleLinks.length,
    rejectedCount: rejectedLinks.length,
    failedCount: failedLinks.length,
    eligibleLinks,
    rejectedLinks,
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

  const eligibleLinks = entry.f1Analysis?.eligibleLinks || [];
  if (!eligibleLinks.length) {
    throw new Error("No F1 eligible links found. Run analysis first.");
  }

  for (const link of eligibleLinks) {
    await chrome.tabs.create({ url: link.href, active: false });
    await sleep(120);
  }

  return { openedTabs: eligibleLinks.length };
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
  return deduped.filter((link) => isLikelyJobLink(link.href, link.text));
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

  const haystack = `${url.hostname}${url.pathname}${url.search} ${text}`.toLowerCase();
  const markers = [
    "job",
    "jobs",
    "career",
    "careers",
    "position",
    "opening",
    "requisition",
    "vacancy",
    "apply"
  ];
  return markers.some((marker) => haystack.includes(marker));
}

async function analyzeLinkContentForF1(url) {
  if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) {
    return { failed: true, error: "Invalid URL.", matchedTerms: [], pageTitle: "" };
  }

  let tabId;
  try {
    const created = await chrome.tabs.create({ url, active: false });
    tabId = created.id;
    if (!tabId) {
      return { failed: true, error: "Unable to open tab.", matchedTerms: [], pageTitle: "" };
    }

    await waitForTabComplete(tabId, ANALYZE_LOAD_TIMEOUT_MS);
    await sleep(700);

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (terms) => {
        const text = (document.body?.innerText || "").toLowerCase();
        const matchedTerms = terms.filter((term) => text.includes(term));
        return {
          pageTitle: document.title || "",
          matchedTerms
        };
      },
      args: [F1_BLOCK_TERMS]
    });

    return {
      failed: false,
      pageTitle: result?.pageTitle || "",
      matchedTerms: Array.isArray(result?.matchedTerms) ? result.matchedTerms : []
    };
  } catch (error) {
    return {
      failed: true,
      error: error?.message || "Failed to inspect page.",
      matchedTerms: [],
      pageTitle: ""
    };
  } finally {
    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (_error) {
        // ignore close failures
      }
    }
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

function buildPaginatedUrls(baseUrl, maxPages) {
  const urls = [baseUrl];
  if (maxPages <= 1) return urls;

  const parsed = new URL(baseUrl);
  const rawStart = parsed.searchParams.get("start");
  const initialStart = Number.isFinite(Number(rawStart)) ? Number(rawStart) : 0;

  for (let i = 1; i < maxPages; i += 1) {
    const next = new URL(baseUrl);
    next.searchParams.set("start", String(initialStart + i * PAGINATION_STEP));
    urls.push(next.toString());
  }

  return urls;
}

async function waitForTabComplete(tabId, timeoutMs) {
  const tab = await chrome.tabs.get(tabId);
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

async function extractLinksFromTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
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

      return {
        pageUrl: window.location.href,
        pageTitle: document.title || "(untitled)",
        links
      };
    }
  });

  return result || { pageUrl: "", pageTitle: "(untitled)", links: [] };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
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
