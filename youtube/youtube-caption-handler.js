/**
 * YouTube Caption Handler (Production)
 * Injects into YouTube.com to capture captions via XHR interception
 */

(function() {
  'use strict';
  
  // Only run on YouTube
  if (!window.location.hostname.includes('youtube.com')) {
    return;
  }
  
  console.log('[YouTube Handler] Initializing caption handler...');
  
  // Store captured captions
  const captionCache = new Map(); // videoId -> {captions, timestamp}
  
  // Helper: Extract video ID from URL
  function extractVideoId(url) {
    if (!url) return null;
    
    const patterns = [
      /[?&]v=([^&\n?#]+)/,
      /\/vi\/([^\/]+)/,
      /\/vi_webp\/([^\/]+)/,
      /youtu\.be\/([^&\n?#]+)/,
      /\/embed\/([^&\n?#]+)/,
      /\/shorts\/([^&\n?#]+)/
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  }
  
  // Helper: Parse captions from API response
  function parseCaptions(data) {
    try {
      // Try JSON3 format (newer YouTube format)
      if (data.includes('"events"')) {
        const json = JSON.parse(data);
        if (json.events) {
          return json.events
            .filter(e => e.segs)
            .map(e => ({
              start: e.tStartMs / 1000,
              duration: e.dDurationMs / 1000,
              text: e.segs.map(s => s.utf8).join('')
            }));
        }
      }
      
      // Try XML format (older YouTube format)
      if (data.includes('<text ')) {
        const parser = new DOMParser();
        const xml = parser.parseFromString(data, 'text/xml');
        const texts = xml.getElementsByTagName('text');
        return Array.from(texts).map(node => ({
          start: parseFloat(node.getAttribute('start')) || 0,
          duration: parseFloat(node.getAttribute('dur')) || 0,
          text: node.textContent || ''
        }));
      }
    } catch (e) {
      console.error('[YouTube Handler] Parse error:', e);
    }
    return [];
  }
  
  // Helper: Convert captions to plain text
  function captionsToText(captions) {
    if (!Array.isArray(captions) || captions.length === 0) {
      return '';
    }
    return captions.map(c => c.text).join(' ').trim();
  }
  
  // Setup XHR interception
  function setupInterception() {
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    
    // Override XMLHttpRequest
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this._ytCaptionUrl = url;
      return originalXHROpen.apply(this, [method, url, ...rest]);
    };
    
    XMLHttpRequest.prototype.send = function(...args) {
      const xhr = this;
      
      // Check if this is a caption request
      if (xhr._ytCaptionUrl && 
         (xhr._ytCaptionUrl.includes('timedtext') || 
          xhr._ytCaptionUrl.includes('caption'))) {
        
        const videoId = extractVideoId(xhr._ytCaptionUrl);
        
        if (videoId) {
          console.log(`[YouTube Handler] Intercepting captions for: ${videoId}`);
          
          xhr.addEventListener('load', function() {
            try {
              const responseText = xhr.responseText;
              const captions = parseCaptions(responseText);
              
              if (captions.length > 0) {
                // Cache the captions
                captionCache.set(videoId, {
                  videoId,
                  captions,
                  text: captionsToText(captions),
                  timestamp: Date.now()
                });
                
                console.log(`[YouTube Handler] ✅ Captured ${captions.length} captions for ${videoId}`);
                
                // Notify content script that captions are ready
                window.dispatchEvent(new CustomEvent('youtube-captions-ready', {
                  detail: {
                    videoId,
                    captionCount: captions.length
                  }
                }));
              }
            } catch (err) {
              console.error('[YouTube Handler] Error processing captions:', err);
            }
          });
        }
      }
      
      return originalXHRSend.apply(this, args);
    };
    
    console.log('[YouTube Handler] ✅ XHR interception active');
  }
  
  // Expose API for content script to access captions
  window.__ytGetCaptions = function(videoId) {
    return captionCache.get(videoId) || null;
  };
  
  window.__ytHasCaptions = function(videoId) {
    return captionCache.has(videoId);
  };
  
  window.__ytClearCache = function() {
    captionCache.clear();
    console.log('[YouTube Handler] Cache cleared');
  };
  
  // Listen for caption requests from content script (via postMessage)
  window.addEventListener('message', (event) => {
    // Only accept messages from same origin
    if (event.source !== window) return;
    
    if (event.data.type === 'YT_GET_CAPTIONS') {
      const { requestId, videoId } = event.data;
      const captionData = captionCache.get(videoId);
      
      // Send response back
      window.postMessage({
        type: 'YT_CAPTIONS_RESPONSE',
        requestId: requestId,
        videoId: videoId,
        success: !!captionData,
        data: captionData || null
      }, '*');
    }
  });
  
  // Initialize interception
  setupInterception();
  
  console.log('[YouTube Handler] Ready! Monitoring for caption requests...');
})();

