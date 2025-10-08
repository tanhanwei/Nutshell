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
  
  // Use postMessage to communicate with page context
  // Content scripts can't directly access page context variables
  
  const pendingCaptionRequests = new Map(); // requestId -> {resolve, reject}
  let requestIdCounter = 0;
  
  // Listen for responses from page context
  window.addEventListener('message', (event) => {
    // Only accept messages from same origin
    if (event.source !== window) return;
    
    if (event.data.type === 'YT_CAPTIONS_RESPONSE') {
      const { requestId, success, data, videoId } = event.data;
      const pending = pendingCaptionRequests.get(requestId);
      
      if (pending) {
        pendingCaptionRequests.delete(requestId);
        if (success) {
          console.log('[YouTube Bridge] Received captions for:', videoId);
          pending.resolve(data);
        } else {
          console.warn('[YouTube Bridge] No captions for:', videoId);
          pending.reject(new Error('NO_CAPTIONS'));
        }
      }
    }
  });
  
  // Function to request captions from page context
  function getCaptionsFromPage(videoId) {
    return new Promise((resolve, reject) => {
      const requestId = ++requestIdCounter;
      pendingCaptionRequests.set(requestId, { resolve, reject });
      
      // Send request to page context
      window.postMessage({
        type: 'YT_GET_CAPTIONS',
        requestId: requestId,
        videoId: videoId
      }, '*');
      
      // Timeout after 1 second
      setTimeout(() => {
        if (pendingCaptionRequests.has(requestId)) {
          pendingCaptionRequests.delete(requestId);
          reject(new Error('TIMEOUT'));
        }
      }, 1000);
    });
  }
  
  // Expose function for content.js
  window.getYouTubeCaptions = async function(videoId) {
    try {
      return await getCaptionsFromPage(videoId);
    } catch (error) {
      return null;
    }
  };
  
  window.hasYouTubeCaptions = async function(videoId) {
    try {
      const captions = await getCaptionsFromPage(videoId);
      return captions !== null;
    } catch (error) {
      return false;
    }
  };
  
  // Listen for messages from background.js
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'GET_YOUTUBE_CAPTIONS') {
      const videoId = message.videoId;
      console.log('[YouTube Bridge] Caption request for:', videoId);
      
      // Request captions from page context
      getCaptionsFromPage(videoId)
        .then(captions => {
          console.log('[YouTube Bridge] Captions found!');
          sendResponse({
            success: true,
            data: captions,
            videoId: videoId
          });
        })
        .catch(error => {
          console.warn('[YouTube Bridge] Failed to get captions:', error.message);
          sendResponse({
            success: false,
            error: error.message,
            videoId: videoId
          });
        });
      
      return true; // Async response
    }
  });
  
  console.log('[YouTube Bridge] Ready!');
})();

