/**
 * YouTube Content Bridge (Content Script)
 * Bridges between page context (caption handler) and extension (content.js)
 * Only runs on YouTube.com
 */

(function() {
  'use strict';
  
  console.log('[YouTube Bridge] Initializing...');
  
  // Inject the caption handler into page context
  const scriptUrl = chrome.runtime.getURL('youtube/youtube-caption-handler.js');
  const script = document.createElement('script');
  script.src = scriptUrl;
  script.onload = () => {
    console.log('[YouTube Bridge] Caption handler injected');
    script.remove();
  };
  script.onerror = (e) => {
    console.error('[YouTube Bridge] Failed to load handler:', e);
  };
  (document.head || document.documentElement).appendChild(script);
  
  // Listen for caption-ready events from page context
  window.addEventListener('youtube-captions-ready', (event) => {
    const { videoId, captionCount } = event.detail;
    console.log(`[YouTube Bridge] Captions ready for ${videoId}: ${captionCount} captions`);
    
    // Notify our content.js that captions are available
    window.dispatchEvent(new CustomEvent('yt-captions-available', {
      detail: { videoId, captionCount }
    }));
  });
  
  // Expose function for content.js to get captions
  window.getYouTubeCaptions = function(videoId) {
    // Access page context function
    if (window.__ytGetCaptions) {
      return window.__ytGetCaptions(videoId);
    }
    return null;
  };
  
  window.hasYouTubeCaptions = function(videoId) {
    if (window.__ytHasCaptions) {
      return window.__ytHasCaptions(videoId);
    }
    return false;
  };
  
  console.log('[YouTube Bridge] Ready!');
})();

