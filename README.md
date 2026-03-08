# Link Crawler Collector (Browser Extension)

This extension crawls the current webpage, collects all links (`<a href>`), and stores crawl sessions in browser local storage for analysis.

## Features
- Crawl links from the active tab
- Multi-page crawl loop with auto-detected pagination (`next`, `start`, `page`, `p`)
- Save each crawl session with metadata:
  - page URL
  - page title
  - crawl time
  - pages crawled
  - total/internal/external link counts
- Analyze job links for F1 suitability with 4 outputs:
  - `Eligible`
  - `Rejected` (US citizen / citizenship required / security clearance)
  - `No-Sponsor` (no visa sponsorship language)
  - `Review` (no clear signal)
- For LinkedIn job links, analysis targets the company external apply page URL (no LinkedIn fallback)
- If no external apply URL is available, analyzer falls back to LinkedIn job description content
- Store an `F1 eligible links` list per crawl session
- Open all F1 eligible links in new tabs with one click
- View crawl history in the options page
- Export history as JSON
- Clear stored crawl data

## Install (Chrome / Edge)
1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `crawler-extension`.

## How to use
1. Open any webpage.
2. Click the extension icon.
3. Click **Crawl Current Page**.
4. Click **Open History** to review saved data.
5. Use **Export JSON** for analysis.

## Storage
Data is stored in `chrome.storage.local` under key `crawlHistory`.
