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
  
  // Listen for messages from background.js
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'GET_YOUTUBE_CAPTIONS') {
      const videoId = message.videoId;
      console.log('[YouTube Bridge] Caption request for:', videoId);
      
      try {
        // Try to get captions from page context
        const captions = window.getYouTubeCaptions(videoId);
        
        if (captions) {
          console.log('[YouTube Bridge] Captions found!');
          sendResponse({
            success: true,
            data: captions,
            videoId: videoId
          });
        } else {
          console.warn('[YouTube Bridge] No captions found for:', videoId);
          sendResponse({
            success: false,
            error: 'NO_CAPTIONS',
            videoId: videoId
          });
        }
      } catch (error) {
        console.error('[YouTube Bridge] Error getting captions:', error);
        sendResponse({
          success: false,
          error: error.message,
          videoId: videoId
        });
      }
      
      return false; // Synchronous response
    }
  });
  
  console.log('[YouTube Bridge] Ready!');
})();

