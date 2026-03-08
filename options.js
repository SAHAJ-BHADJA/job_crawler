const listEl = document.getElementById("list");
const metaEl = document.getElementById("meta");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");
const searchInput = document.getElementById("searchInput");
const typeFilter = document.getElementById("typeFilter");

let historyCache = [];

exportBtn.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "EXPORT_CRAWL_HISTORY" });
  if (!response?.ok) alert(response?.error || "Export failed.");
});

clearBtn.addEventListener("click", async () => {
  const confirmed = confirm("Delete all crawl history?");
  if (!confirmed) return;

  await chrome.runtime.sendMessage({ type: "CLEAR_CRAWL_HISTORY" });
  await loadHistory();
});

searchInput.addEventListener("input", () => renderHistory());
typeFilter.addEventListener("change", () => renderHistory());

loadHistory();

async function loadHistory() {
  const response = await chrome.runtime.sendMessage({ type: "GET_CRAWL_HISTORY" });
  historyCache = response?.data || [];
  renderHistory();
}

function renderHistory() {
  const query = searchInput.value.trim().toLowerCase();
  const filter = typeFilter.value;
  const filteredEntries = historyCache
    .map((entry) => applyLinkFilter(entry, filter, query))
    .filter(Boolean);

  metaEl.textContent = `${filteredEntries.length} of ${historyCache.length} crawl session(s)`;
  listEl.innerHTML = "";

  if (!historyCache.length) {
    listEl.appendChild(makeEmpty("No crawl history yet. Crawl a page from the extension popup."));
    return;
  }
  if (!filteredEntries.length) {
    listEl.appendChild(makeEmpty("No sessions match your filters."));
    return;
  }

  for (const entry of filteredEntries) listEl.appendChild(renderEntry(entry));
}

function renderEntry(entry) {
  const card = document.createElement("article");
  card.className = "entry";

  const header = document.createElement("div");
  header.className = "entry-header";

  const left = document.createElement("div");
  const heading = document.createElement("h2");
  heading.textContent = entry.pageTitle || "(untitled)";
  left.appendChild(heading);

  const sourceLink = document.createElement("a");
  sourceLink.className = "source-link";
  sourceLink.href = entry.pageUrl;
  sourceLink.target = "_blank";
  sourceLink.rel = "noopener noreferrer";
  sourceLink.title = entry.pageUrl;
  sourceLink.textContent = entry.pageUrl;
  left.appendChild(sourceLink);

  const details = document.createElement("p");
  details.className = "details";
  details.textContent = `${formatDate(entry.crawledAt)} | pages: ${entry.pagesCrawled || 1}`;
  left.appendChild(details);

  const chips = document.createElement("div");
  chips.className = "chips";
  chips.appendChild(makeChip(`total ${entry.totalLinks}`));
  chips.appendChild(makeChip(`internal ${entry.internalCount}`));
  chips.appendChild(makeChip(`external ${entry.externalCount}`));
  chips.appendChild(makeChip(`job links ${countJobLinks(entry.links || [])}`, true));

  header.appendChild(left);
  header.appendChild(chips);
  card.appendChild(header);

  const actions = document.createElement("div");
  actions.className = "entry-actions";

  const analyzeBtn = document.createElement("button");
  analyzeBtn.className = "action-btn";
  analyzeBtn.textContent = "Analyze F1 Eligibility";
  analyzeBtn.addEventListener("click", async () => {
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = "Analyzing...";
    try {
      const response = await chrome.runtime.sendMessage({
        type: "ANALYZE_F1_ENTRY",
        payload: { entryId: entry.id }
      });
      if (!response?.ok) throw new Error(response?.error || "Analysis failed.");
      await loadHistory();
    } catch (error) {
      alert(error.message);
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = "Analyze F1 Eligibility";
    }
  });

  const openEligibleBtn = document.createElement("button");
  openEligibleBtn.className = "action-btn secondary";
  openEligibleBtn.textContent = "Open Shortlisted Tabs";
  const eligibleCount = entry.f1Analysis?.eligibleCount || 0;
  const noSponsorCount = entry.f1Analysis?.noSponsorCount || 0;
  const reviewCount = entry.f1Analysis?.reviewCount || 0;
  const openCount = eligibleCount + noSponsorCount + reviewCount;
  openEligibleBtn.disabled = openCount === 0;
  openEligibleBtn.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({
      type: "OPEN_F1_ELIGIBLE_TABS",
      payload: { entryId: entry.id }
    });
    if (!response?.ok) {
      alert(response?.error || "Failed to open tabs.");
      return;
    }
    alert(`Opened ${response.data.openedTabs} eligible tab(s).`);
  });

  actions.appendChild(analyzeBtn);
  actions.appendChild(openEligibleBtn);
  card.appendChild(actions);

  const f1Section = renderF1Section(entry);
  if (f1Section) card.appendChild(f1Section);

  card.appendChild(renderLinksBox(entry.links || []));
  return card;
}

function renderF1Section(entry) {
  const analysis = entry.f1Analysis;
  if (!analysis) return null;

  const section = document.createElement("section");
  section.className = "f1-section";

  const title = document.createElement("h3");
  title.textContent = "F1 Analysis";
  section.appendChild(title);

  const summary = document.createElement("p");
  summary.className = "details";
  summary.textContent =
    `${formatDate(analysis.analyzedAt)} | scanned: ${analysis.scannedLinks} | ` +
    `eligible: ${analysis.eligibleCount || 0} | rejected: ${analysis.rejectedCount || 0} | ` +
    `no-sponsor: ${analysis.noSponsorCount || 0} | review: ${analysis.reviewCount || 0} | failed: ${analysis.failedCount || 0}`;
  section.appendChild(summary);

  const rejectTerms = document.createElement("p");
  rejectTerms.className = "muted";
  rejectTerms.textContent = `Rejected terms: ${(analysis.rejectTerms || []).join(", ")}`;
  section.appendChild(rejectTerms);

  const noSponsorTerms = document.createElement("p");
  noSponsorTerms.className = "muted";
  noSponsorTerms.textContent = `No-Sponsor terms: ${(analysis.noSponsorTerms || []).join(", ")}`;
  section.appendChild(noSponsorTerms);

  const eligibleLinks = analysis.eligibleLinks || [];
  const eligibleBox = document.createElement("details");
  eligibleBox.className = "links-box";
  const eligibleSummary = document.createElement("summary");
  eligibleSummary.textContent = `F1 eligible links (${eligibleLinks.length})`;
  eligibleBox.appendChild(eligibleSummary);
  eligibleBox.appendChild(renderSimpleLinks(eligibleLinks, "No eligible links found."));
  section.appendChild(eligibleBox);

  const noSponsorLinks = analysis.noSponsorLinks || [];
  const noSponsorBox = document.createElement("details");
  noSponsorBox.className = "links-box";
  const noSponsorSummary = document.createElement("summary");
  noSponsorSummary.textContent = `No-Sponsor links (${noSponsorLinks.length})`;
  noSponsorBox.appendChild(noSponsorSummary);
  noSponsorBox.appendChild(renderMatchedLinks(noSponsorLinks, "No no-sponsor links."));
  section.appendChild(noSponsorBox);

  const reviewLinks = analysis.reviewLinks || [];
  const reviewBox = document.createElement("details");
  reviewBox.className = "links-box";
  const reviewSummary = document.createElement("summary");
  reviewSummary.textContent = `Review links (${reviewLinks.length})`;
  reviewBox.appendChild(reviewSummary);
  reviewBox.appendChild(renderSimpleLinks(reviewLinks, "No review links."));
  section.appendChild(reviewBox);

  const rejectedLinks = analysis.rejectedLinks || [];
  const rejectedBox = document.createElement("details");
  rejectedBox.className = "links-box";
  const rejectedSummary = document.createElement("summary");
  rejectedSummary.textContent = `Rejected links (${rejectedLinks.length})`;
  rejectedBox.appendChild(rejectedSummary);
  rejectedBox.appendChild(renderMatchedLinks(rejectedLinks, "No rejected links."));
  section.appendChild(rejectedBox);

  const failedLinks = analysis.failedLinks || [];
  const failedBox = document.createElement("details");
  failedBox.className = "links-box";
  const failedSummary = document.createElement("summary");
  failedSummary.textContent = `Failed links (${failedLinks.length})`;
  failedBox.appendChild(failedSummary);
  failedBox.appendChild(renderFailedLinks(failedLinks, "No failed links."));
  section.appendChild(failedBox);

  return section;
}

function renderLinksBox(links) {
  const linksBox = document.createElement("details");
  linksBox.className = "links-box";
  linksBox.open = false;

  const linksSummary = document.createElement("summary");
  const shownCount = Math.min(links.length, 200);
  linksSummary.textContent = `Show crawled links (${shownCount})`;
  linksBox.appendChild(linksSummary);

  const linksList = document.createElement("ul");
  linksList.className = "links-list";

  const linkSlice = links.slice(0, 200);
  for (const link of linkSlice) {
    linksList.appendChild(makeLinkRow(link.href, link.text));
  }

  if (links.length > 200) {
    const li = document.createElement("li");
    li.className = "muted list-note";
    li.textContent = `Showing first 200 links out of ${links.length}.`;
    linksList.appendChild(li);
  }

  linksBox.appendChild(linksList);
  return linksBox;
}

function renderSimpleLinks(links, emptyText) {
  const list = document.createElement("ul");
  list.className = "links-list";
  if (!links.length) {
    const li = document.createElement("li");
    li.className = "muted list-note";
    li.textContent = emptyText;
    list.appendChild(li);
    return list;
  }

  for (const link of links) {
    list.appendChild(makeLinkRow(link.href, link.pageTitle || link.text));
  }
  return list;
}

function renderMatchedLinks(links, emptyText) {
  const list = document.createElement("ul");
  list.className = "links-list";
  if (!links.length) {
    const li = document.createElement("li");
    li.className = "muted list-note";
    li.textContent = emptyText;
    list.appendChild(li);
    return list;
  }

  for (const link of links) {
    const li = makeLinkRow(link.href, link.pageTitle || link.text);
    if (Array.isArray(link.matchedTerms) && link.matchedTerms.length) {
      const reason = document.createElement("div");
      reason.className = "link-url";
      reason.textContent = `Matched: ${link.matchedTerms.join(", ")}`;
      li.appendChild(reason);
    }
    list.appendChild(li);
  }
  return list;
}

function renderFailedLinks(links, emptyText) {
  const list = document.createElement("ul");
  list.className = "links-list";
  if (!links.length) {
    const li = document.createElement("li");
    li.className = "muted list-note";
    li.textContent = emptyText;
    list.appendChild(li);
    return list;
  }

  for (const link of links) {
    const li = makeLinkRow(link.sourceHref || link.href, link.pageTitle || link.text);
    const reason = document.createElement("div");
    reason.className = "link-url";
    reason.textContent = `Reason: ${link.error || "Unknown error"}`;
    li.appendChild(reason);
    list.appendChild(li);
  }
  return list;
}

function makeLinkRow(href, text) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  a.className = "link-row";
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";

  const textEl = document.createElement("span");
  textEl.className = "link-text";
  textEl.textContent = text || "(no anchor text)";

  const urlEl = document.createElement("span");
  urlEl.className = "link-url";
  urlEl.textContent = href;

  a.appendChild(textEl);
  a.appendChild(urlEl);
  li.appendChild(a);
  return li;
}

function makeEmpty(text) {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = text;
  return empty;
}

function formatDate(isoDate) {
  try {
    return new Date(isoDate).toLocaleString();
  } catch (_error) {
    return isoDate;
  }
}

function applyLinkFilter(entry, filter, query) {
  const originalLinks = Array.isArray(entry.links) ? entry.links : [];
  let links = originalLinks;

  if (filter === "jobs") {
    links = links.filter((link) => isLikelyJobLink(link.href, link.text));
  } else if (filter === "internal") {
    links = links.filter((link) => link.internal);
  } else if (filter === "external") {
    links = links.filter((link) => !link.internal);
  }

  if (query) {
    const entryMatches =
      (entry.pageTitle || "").toLowerCase().includes(query) ||
      (entry.pageUrl || "").toLowerCase().includes(query);
    links = links.filter(
      (link) =>
        (link.href || "").toLowerCase().includes(query) ||
        (link.text || "").toLowerCase().includes(query)
    );
    if (!entryMatches && !links.length) return null;
  }

  if (!links.length && filter !== "all") return null;
  return rebuildEntryWithLinks(entry, links);
}

function rebuildEntryWithLinks(entry, links) {
  const totalLinks = links.length;
  const internalCount = links.filter((link) => link.internal).length;
  const externalCount = totalLinks - internalCount;
  return { ...entry, links, totalLinks, internalCount, externalCount };
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

function countJobLinks(links) {
  return links.filter((link) => isLikelyJobLink(link.href, link.text)).length;
}

function makeChip(label, isJobs = false) {
  const chip = document.createElement("span");
  chip.className = isJobs ? "chip jobs" : "chip";
  chip.textContent = label;
  return chip;
}
