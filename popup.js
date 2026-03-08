const crawlBtn = document.getElementById("crawlBtn");
const statusEl = document.getElementById("status");
const openHistoryBtn = document.getElementById("openHistoryBtn");

crawlBtn.addEventListener("click", async () => {
  setStatus("Crawling pages (auto-detecting pagination)...");
  try {
    const response = await chrome.runtime.sendMessage({ type: "RUN_CRAWL" });
    if (!response?.ok) {
      throw new Error(response?.error || "Crawl failed.");
    }
    const pages = response?.data?.pagesCrawled ?? 1;
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
