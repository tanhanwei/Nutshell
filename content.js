let hoverTimeout = null;
let currentRequest = null;

// Listen for mouseover on all links
document.addEventListener('mouseover', (e) => {
  const link = e.target.closest('a');
  
  if (!link || !link.href) return;
  
  // Clear any existing timeout
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
  }
  
  // Set 300ms delay before triggering
  hoverTimeout = setTimeout(() => {
    const url = link.href;
    
    // Skip if same URL as last request
    if (currentRequest === url) {
      return;
    }
    
    // Cancel previous request if exists
    currentRequest = url;
    
    // Send SINGLE message to background to fetch content
    chrome.runtime.sendMessage({
      type: 'FETCH_CONTENT',
      url: url
    }, (response) => {
      // Only process if this is still the current request
      if (currentRequest === url) {
        // Forward to side panel - response already has the right structure
        chrome.runtime.sendMessage({
          type: 'DISPLAY_CONTENT',
          url: response.url,
          cached: response.cached || false,
          data: response
        });
        
        // Clear current request after sending
        currentRequest = null;
      }
    });
  }, 300);
});

// Clear timeout when mouse leaves
document.addEventListener('mouseout', (e) => {
  const link = e.target.closest('a');
  if (link && hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }
});
