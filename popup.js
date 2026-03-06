const crawlBtn = document.getElementById("crawlBtn");
const statusEl = document.getElementById("status");
const openHistoryBtn = document.getElementById("openHistoryBtn");
const maxPagesInput = document.getElementById("maxPagesInput");

crawlBtn.addEventListener("click", async () => {
  const maxPages = clampNumber(maxPagesInput.value, 1, 20, 1);
  setStatus(`Crawling up to ${maxPages} page(s)...`);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "RUN_CRAWL",
      payload: { maxPages }
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Crawl failed.");
    }
    const pages = response?.data?.pagesCrawled ?? maxPages;
    const links = response?.data?.uniqueLinks ?? 0;
    setStatus(`Saved: ${links} unique links from ${pages} page(s).`);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  }
});

openHistoryBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

function setStatus(message) {
  statusEl.textContent = message;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}
