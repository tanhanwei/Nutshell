/**
 * YouTube Caption Extraction Methods
 * Isolated implementations for testing and comparison
 */

// Import debug logger if available
let logger = null;
if (typeof window !== 'undefined' && window.YouTubeDebugLogger) {
  logger = window.YouTubeDebugLogger;
}

/**
 * UTILITY: Extract video ID from various YouTube URL patterns
 * @param {string} url - YouTube URL or element with href/src
 * @returns {string|null} - Video ID or null
 */
function extractVideoId(url) {
  if (!url) return null;
  
  // If it's an element, try to get URL from href or src
  if (typeof url === 'object' && url.href) {
    url = url.href;
  } else if (typeof url === 'object' && url.src) {
    url = url.src;
  }
  
  // Convert to string
  url = String(url);
  
  const patterns = [
    // Standard watch URLs
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    // Shorts URLs
    /youtube\.com\/shorts\/([^&\n?#]+)/,
    // Thumbnail/image URLs
    /\/vi\/([^\/]+)/,
    /\/vi_webp\/([^\/]+)/,
    // From timedtext API URLs
    /[?&]v=([^&\n?#]+)/,
    // From any URL with video ID parameter
    /video_id=([^&\n?#]+)/,
    // YouTube image server
    /ytimg\.com\/vi\/([^\/]+)/,
    /ytimg\.com\/vi_webp\/([^\/]+)/,
    // Mobile URLs
    /youtube\.com\/v\/([^&\n?#]+)/,
    // Live URLs
    /youtube\.com\/live\/([^&\n?#]+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      const videoId = match[1];
      if (logger) {
        logger.debugLog('YT_API', `Extracted video ID: ${videoId} from URL`);
      }
      return videoId;
    }
  }
  
  console.warn('[VideoID] Could not extract from URL:', url.substring(0, 100));
  return null;
}

/**
 * UTILITY: Parse caption data from different formats
 * @param {string|object} data - Raw caption data
 * @param {string} format - Format hint: 'json3', 'xml', 'auto'
 * @returns {Array} - Parsed captions [{start, duration, text}, ...]
 */
function parseCaptionData(data, format = 'auto') {
  try {
    if (typeof data === 'string') {
      // Check for JSON3 format (YouTube's newer format)
      if (data.includes('"wireMagic"') || data.includes('"events"')) {
        const jsonData = JSON.parse(data);
        
        // Extract events (full caption data)
        if (jsonData.events) {
          if (logger) {
            logger.debugLog('YT_API', `Found YouTube JSON3 format with ${jsonData.events.length} events`);
          }
          
          return jsonData.events.map(event => {
            // Handle different event structures
            if (event.segs) {
              // Multi-segment event
              const text = event.segs.map(seg => seg.utf8).join('');
              return {
                start: event.tStartMs / 1000,
                duration: event.dDurationMs / 1000,
                text: text
              };
            } else if (event.aAppend && event.aAppend.segs) {
              // Append event
              const text = event.aAppend.segs.map(seg => seg.utf8).join('');
              return {
                start: event.tStartMs / 1000,
                duration: event.dDurationMs / 1000,
                text: text
              };
            }
            return null;
          }).filter(Boolean);
        }
      }
      
      // Try standard JSON array
      if (data.trim().startsWith('[')) {
        const jsonData = JSON.parse(data);
        if (Array.isArray(jsonData)) {
          if (logger) {
            logger.debugLog('YT_API', `Found JSON array format with ${jsonData.length} captions`);
          }
          return jsonData;
        }
      }
      
      // Try XML format
      if (data.includes('<?xml') || data.includes('<transcript>') || data.includes('<text ')) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(data, 'text/xml');
        const texts = xmlDoc.getElementsByTagName('text');
        
        if (logger) {
          logger.debugLog('YT_API', `Found XML format with ${texts.length} caption elements`);
        }
        
        return Array.from(texts).map(node => ({
          start: parseFloat(node.getAttribute('start')) || 0,
          duration: parseFloat(node.getAttribute('dur')) || 0,
          text: node.textContent || ''
        }));
      }
    }
    
    // If data is already an array, return it
    if (Array.isArray(data)) {
      return data;
    }
    
    console.warn('[Parser] Unknown caption format:', typeof data);
    return [];
  } catch (error) {
    console.error('[Parser] Error parsing caption data:', error);
    if (logger) {
      logger.debugLog('YT_ERROR', 'Caption parsing failed', { error: error.message });
    }
    return [];
  }
}

/**
 * UTILITY: Convert captions array to plain text
 * @param {Array} captions - Parsed captions
 * @returns {string} - Full transcript text
 */
function captionsToText(captions) {
  if (!Array.isArray(captions)) return '';
  return captions.map(c => c.text).join(' ').trim();
}

/**
 * METHOD: Direct API Fetch
 * Directly fetch captions from YouTube's timedtext API
 * Works anywhere (YouTube.com or external sites)
 * 
 * @param {string} videoId - YouTube video ID
 * @param {string} lang - Language code (default: 'en')
 * @returns {Promise<Object>} - {success, captions, raw, error}
 */
async function fetchCaptionsDirect(videoId, lang = 'en') {
  if (logger) {
    logger.logAPI.attempt(videoId);
  }
  
  try {
    // Try multiple API endpoints
    const endpoints = [
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}`,
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=json3`,
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=srv3`
    ];
    
    let lastError = null;
    
    for (const url of endpoints) {
      try {
        if (logger) {
          logger.debugLog('YT_API', `Trying endpoint: ${url.substring(0, 80)}...`);
        }
        
        // Use background script to avoid CORS if in extension context
        let response;
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          // Extension context - use background script
          const result = await chrome.runtime.sendMessage({
            action: 'FETCH_YOUTUBE_CAPTIONS',
            url: url
          });
          
          if (!result.success) {
            throw new Error(result.error || 'Background fetch failed');
          }
          
          response = { text: () => Promise.resolve(result.data) };
        } else {
          // Web context - direct fetch
          response = await fetch(url);
          
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
        }
        
        const data = await response.text();
        
        // Check if we got actual caption data (not error page)
        if (!data || data.length < 10) {
          throw new Error('Empty response');
        }
        
        // Parse captions
        const captions = parseCaptionData(data);
        
        if (captions.length === 0) {
          throw new Error('No captions found in response');
        }
        
        if (logger) {
          logger.logAPI.success(videoId, captions.length);
        }
        
        return {
          success: true,
          videoId,
          captions,
          raw: data,
          method: 'directAPI',
          endpoint: url
        };
        
      } catch (err) {
        lastError = err;
        if (logger) {
          logger.debugLog('YT_API', `Endpoint failed: ${err.message}`);
        }
        continue; // Try next endpoint
      }
    }
    
    // All endpoints failed
    throw lastError || new Error('All endpoints failed');
    
  } catch (error) {
    if (logger) {
      logger.logAPI.failure(videoId, error.message);
    }
    
    return {
      success: false,
      videoId,
      error: error.message,
      method: 'directAPI'
    };
  }
}

/**
 * METHOD 4: Network Intercept
 * Intercept fetch() and XMLHttpRequest to capture YouTube's caption API calls
 * Only works on youtube.com where YouTube's player makes the calls
 * 
 * @returns {Function} - Cleanup function to remove interceptors
 */
function setupNetworkIntercept() {
  if (logger) {
    logger.debugLog('YT_METHOD_4', 'Setting up network intercept');
  }
  
  // Store original functions
  const originalFetch = window.fetch.bind(window);
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  
  // Captured data storage
  const capturedData = new Map(); // videoId -> caption data
  
  // Override fetch
  window.fetch = function(...args) {
    const url = args[0]?.url || args[0]?.toString() || args[0];
    
    if (typeof url === 'string' && 
       (url.includes('timedtext') || 
        url.includes('caption') || 
        url.includes('/api/timedtext'))) {
      
      if (logger) {
        logger.logMethod4.intercept(url);
      }
      
      const videoId = extractVideoId(url);
      
      return originalFetch(...args).then(async (response) => {
        // Clone response before reading
        const clone = response.clone();
        
        try {
          const text = await clone.text();
          const captions = parseCaptionData(text);
          
          if (captions.length > 0 && videoId) {
            capturedData.set(videoId, {
              success: true,
              videoId,
              captions,
              raw: text,
              method: 'method4-fetch',
              url
            });
            
            if (logger) {
              logger.logMethod4.success(videoId, captions.length);
            }
            
            // Notify listeners
            window.dispatchEvent(new CustomEvent('youtube-captions-captured', {
              detail: { videoId, captions, method: 'method4-fetch' }
            }));
          }
        } catch (err) {
          if (logger) {
            logger.logMethod4.failure(videoId, err.message);
          }
        }
        
        // Return original response
        return response;
      });
    }
    
    return originalFetch(...args);
  };
  
  // Override XMLHttpRequest
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._interceptedUrl = url;
    this._interceptedMethod = method;
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };
  
  XMLHttpRequest.prototype.send = function(...args) {
    const xhr = this;
    
    if (xhr._interceptedUrl && 
       (xhr._interceptedUrl.includes('timedtext') || 
        xhr._interceptedUrl.includes('caption'))) {
      
      if (logger) {
        logger.logMethod4.intercept(xhr._interceptedUrl);
      }
      
      const videoId = extractVideoId(xhr._interceptedUrl);
      
      // Add load listener
      xhr.addEventListener('load', function() {
        try {
          const text = xhr.responseText;
          const captions = parseCaptionData(text);
          
          if (captions.length > 0 && videoId) {
            capturedData.set(videoId, {
              success: true,
              videoId,
              captions,
              raw: text,
              method: 'method4-xhr',
              url: xhr._interceptedUrl
            });
            
            if (logger) {
              logger.logMethod4.success(videoId, captions.length);
            }
            
            // Notify listeners
            window.dispatchEvent(new CustomEvent('youtube-captions-captured', {
              detail: { videoId, captions, method: 'method4-xhr' }
            }));
          }
        } catch (err) {
          if (logger) {
            logger.logMethod4.failure(videoId, err.message);
          }
        }
      });
    }
    
    return originalXHRSend.apply(this, args);
  };
  
  if (logger) {
    logger.debugLog('YT_METHOD_4', '✅ Network intercept active');
  }
  
  // Return cleanup function
  return function cleanup() {
    window.fetch = originalFetch;
    XMLHttpRequest.prototype.open = originalXHROpen;
    XMLHttpRequest.prototype.send = originalXHRSend;
    
    if (logger) {
      logger.debugLog('YT_METHOD_4', '🔌 Network intercept removed');
    }
    
    return capturedData;
  };
}

/**
 * METHOD 1: WebRequest API (Background Script Only)
 * This method runs in background.js and uses chrome.webRequest API
 * Requires 'webRequest' and 'webRequestBlocking' permissions
 * 
 * Note: This must be called from background.js, not content script
 */
function setupWebRequestIntercept() {
  // This only works in background script
  if (typeof chrome === 'undefined' || !chrome.webRequest) {
    console.error('[Method 1] chrome.webRequest not available. Must run in background script.');
    return null;
  }
  
  if (logger) {
    logger.debugLog('YT_METHOD_1', 'Setting up webRequest intercept');
  }
  
  const capturedData = new Map();
  
  // Listener for caption requests
  const listener = function(details) {
    if (details.url.includes('timedtext') || 
        details.url.includes('caption') ||
        details.url.includes('/api/timedtext')) {
      
      const videoId = extractVideoId(details.url);
      
      if (logger) {
        logger.logMethod1.attempt(videoId);
      }
      
      // Fetch the caption data
      fetch(details.url)
        .then(response => response.text())
        .then(text => {
          const captions = parseCaptionData(text);
          
          if (captions.length > 0 && videoId) {
            capturedData.set(videoId, {
              success: true,
              videoId,
              captions,
              raw: text,
              method: 'method1-webRequest',
              url: details.url
            });
            
            if (logger) {
              logger.logMethod1.success(videoId, captions.length);
            }
            
            // Notify content script
            chrome.tabs.sendMessage(details.tabId, {
              action: 'YOUTUBE_CAPTIONS_CAPTURED',
              videoId,
              captions,
              method: 'method1'
            }).catch(() => {});
          }
        })
        .catch(error => {
          if (logger) {
            logger.logMethod1.failure(videoId, error.message);
          }
        });
    }
  };
  
  // Register listener
  chrome.webRequest.onBeforeRequest.addListener(
    listener,
    { urls: ["*://*.youtube.com/*", "*://*.googlevideo.com/*"] },
    []
  );
  
  if (logger) {
    logger.debugLog('YT_METHOD_1', '✅ WebRequest intercept active');
  }
  
  // Return cleanup function
  return function cleanup() {
    chrome.webRequest.onBeforeRequest.removeListener(listener);
    
    if (logger) {
      logger.debugLog('YT_METHOD_1', '🔌 WebRequest intercept removed');
    }
    
    return capturedData;
  };
}

/**
 * HELPER: Wait for captions to be captured (for testing)
 * @param {string} videoId - Video ID to wait for
 * @param {number} timeout - Timeout in ms (default: 10000)
 * @returns {Promise<Object>} - Captured caption data
 */
function waitForCaptions(videoId, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timeout waiting for captions for ${videoId}`));
    }, timeout);
    
    const listener = (event) => {
      if (event.detail.videoId === videoId) {
        clearTimeout(timeoutId);
        window.removeEventListener('youtube-captions-captured', listener);
        resolve(event.detail);
      }
    };
    
    window.addEventListener('youtube-captions-captured', listener);
  });
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractVideoId,
    parseCaptionData,
    captionsToText,
    fetchCaptionsDirect,
    setupNetworkIntercept,
    setupWebRequestIntercept,
    waitForCaptions
  };
}

// Make available globally for testing
if (typeof window !== 'undefined') {
  window.YouTubeMethods = {
    extractVideoId,
    parseCaptionData,
    captionsToText,
    fetchCaptionsDirect,
    setupNetworkIntercept,
    waitForCaptions
  };
  
  console.log('%c🔧 YouTube Methods Loaded', 'color: #4ECDC4; font-weight: bold; font-size: 14px;');
  console.log('%cAvailable in window.YouTubeMethods', 'color: #4ECDC4;');
  console.log('%cTry: YouTubeMethods.extractVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ")', 'color: #4ECDC4;');
}

