(() => {
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const pageUrl = window.location.href;
  const pageTitle = document.title || "(untitled)";

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

  chrome.runtime.sendMessage({
    type: "CRAWL_RESULTS",
    payload: {
      pageUrl,
      pageTitle,
      crawledAt: new Date().toISOString(),
      totalLinks: links.length,
      links
    }
  });
})();
