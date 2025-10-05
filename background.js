// Handle extension icon click to open side panel
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Cache for fetched HTML: { url: htmlString }
const htmlCache = {};

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_CONTENT') {
    const url = message.url;
    
    // Check cache first
    if (htmlCache[url]) {
      sendResponse({ cached: true, html: htmlCache[url], url: url });
      return true;
    }
    
    // Fetch HTML
    fetch(url)
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response.text();
      })
      .then(html => {
        htmlCache[url] = html;
        sendResponse({ cached: false, html: html, url: url });
      })
      .catch(error => {
        sendResponse({ error: error.message, url: url });
      });
    
    return true; // Keep channel open for async response
  }
});
