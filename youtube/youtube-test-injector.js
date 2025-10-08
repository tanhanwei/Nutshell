/**
 * YouTube Method 4 Test Injector
 * Injects network intercept testing into YouTube.com
 * Bypasses Trusted Types by injecting code directly
 */

(function() {
  'use strict';
  
  console.log('%c🧪 YouTube Caption Test Injector Loaded', 'color: #4ECDC4; font-weight: bold; font-size: 14px;');
  
  let interceptCleanup = null;
  let capturedVideos = new Map();
  
  // Inject the network interceptor code directly into the page
  function injectMethod4() {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        console.log('%c4️⃣ [Method 4] Injecting network intercept...', 'color: #4ECDC4; font-weight: bold;');
        
        // Store captured data
        window.__ytCaptureData = new Map();
        
        // Store original functions
        const originalFetch = window.fetch.bind(window);
        const originalXHROpen = XMLHttpRequest.prototype.open;
        const originalXHRSend = XMLHttpRequest.prototype.send;
        
        // Helper: Extract video ID
        function extractVideoId(url) {
          const patterns = [
            /[?&]v=([^&\\n?#]+)/,
            /\\/vi\\/([^\\/]+)/,
            /\\/vi_webp\\/([^\\/]+)/,
            /youtu\\.be\\/([^&\\n?#]+)/,
            /\\/embed\\/([^&\\n?#]+)/,
            /\\/shorts\\/([^&\\n?#]+)/
          ];
          
          for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match && match[1]) return match[1];
          }
          return null;
        }
        
        // Helper: Parse captions
        function parseCaptions(data) {
          try {
            // Try JSON3 format
            if (data.includes('"events"')) {
              const json = JSON.parse(data);
              if (json.events) {
                return json.events.filter(e => e.segs).map(e => ({
                  start: e.tStartMs / 1000,
                  duration: e.dDurationMs / 1000,
                  text: e.segs.map(s => s.utf8).join('')
                }));
              }
            }
            
            // Try XML format
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
            console.error('Parse error:', e);
          }
          return [];
        }
        
        // Override fetch
        window.fetch = function(...args) {
          const url = args[0]?.url || args[0]?.toString() || args[0];
          
          if (typeof url === 'string' && 
             (url.includes('timedtext') || url.includes('caption'))) {
            
            const videoId = extractVideoId(url);
            console.log('%c4️⃣ [Method 4] Intercepted FETCH:', 'color: #4ECDC4; font-weight: bold;', url.substring(0, 100));
            
            return originalFetch(...args).then(async (response) => {
              const clone = response.clone();
              
              try {
                const text = await clone.text();
                const captions = parseCaptions(text);
                
                if (captions.length > 0 && videoId) {
                  window.__ytCaptureData.set(videoId, {
                    videoId,
                    captions,
                    method: 'fetch',
                    url,
                    timestamp: Date.now()
                  });
                  
                  console.log('%c✅ [Method 4] CAPTURED via FETCH!', 'color: #4CAF50; font-weight: bold; font-size: 16px;');
                  console.log('%c   Video ID:', 'color: #4CAF50;', videoId);
                  console.log('%c   Captions:', 'color: #4CAF50;', captions.length);
                  console.log('%c   First 3:', 'color: #4CAF50;', captions.slice(0, 3).map(c => c.text).join(' | '));
                  
                  // Dispatch event
                  window.dispatchEvent(new CustomEvent('yt-caption-captured', {
                    detail: { videoId, captions, method: 'fetch' }
                  }));
                }
              } catch (err) {
                console.error('Error processing fetch:', err);
              }
              
              return response;
            });
          }
          
          return originalFetch(...args);
        };
        
        // Override XMLHttpRequest
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this._ytInterceptUrl = url;
          return originalXHROpen.apply(this, [method, url, ...rest]);
        };
        
        XMLHttpRequest.prototype.send = function(...args) {
          const xhr = this;
          
          if (xhr._ytInterceptUrl && 
             (xhr._ytInterceptUrl.includes('timedtext') || 
              xhr._ytInterceptUrl.includes('caption'))) {
            
            const videoId = extractVideoId(xhr._ytInterceptUrl);
            console.log('%c4️⃣ [Method 4] Intercepted XHR:', 'color: #4ECDC4; font-weight: bold;', xhr._ytInterceptUrl.substring(0, 100));
            
            xhr.addEventListener('load', function() {
              try {
                const text = xhr.responseText;
                const captions = parseCaptions(text);
                
                if (captions.length > 0 && videoId) {
                  window.__ytCaptureData.set(videoId, {
                    videoId,
                    captions,
                    method: 'xhr',
                    url: xhr._ytInterceptUrl,
                    timestamp: Date.now()
                  });
                  
                  console.log('%c✅ [Method 4] CAPTURED via XHR!', 'color: #4CAF50; font-weight: bold; font-size: 16px;');
                  console.log('%c   Video ID:', 'color: #4CAF50;', videoId);
                  console.log('%c   Captions:', 'color: #4CAF50;', captions.length);
                  console.log('%c   First 3:', 'color: #4CAF50;', captions.slice(0, 3).map(c => c.text).join(' | '));
                  
                  // Dispatch event
                  window.dispatchEvent(new CustomEvent('yt-caption-captured', {
                    detail: { videoId, captions, method: 'xhr' }
                  }));
                }
              } catch (err) {
                console.error('Error processing XHR:', err);
              }
            });
          }
          
          return originalXHRSend.apply(this, args);
        };
        
        console.log('%c✅ [Method 4] Network intercept ACTIVE!', 'color: #4CAF50; font-weight: bold; font-size: 14px;');
        console.log('%cHover over video thumbnails and wait for previews to load...', 'color: #999;');
        
        // Store cleanup function
        window.__ytCleanup = function() {
          window.fetch = originalFetch;
          XMLHttpRequest.prototype.open = originalXHROpen;
          XMLHttpRequest.prototype.send = originalXHRSend;
          console.log('%c🔌 [Method 4] Network intercept REMOVED', 'color: #f44336; font-weight: bold;');
        };
        
        // Helper to check results
        window.__ytResults = function() {
          console.log('%c📊 Captured Videos:', 'color: #667eea; font-weight: bold; font-size: 14px;');
          if (window.__ytCaptureData.size === 0) {
            console.log('%cNo videos captured yet. Hover over thumbnails!', 'color: #999;');
          } else {
            window.__ytCaptureData.forEach((data, videoId) => {
              console.log(\`  ✅ \${videoId}: \${data.captions.length} captions via \${data.method}\`);
            });
            console.log(\`\\nTotal: \${window.__ytCaptureData.size} videos captured\`);
          }
        };
      })();
    `;
    
    // Inject at document start
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    
    console.log('%c✅ Method 4 injected successfully!', 'color: #4CAF50; font-weight: bold;');
  }
  
  // Listen for captures from injected script
  window.addEventListener('yt-caption-captured', (event) => {
    const { videoId, captions, method } = event.detail;
    capturedVideos.set(videoId, { captions, method, timestamp: Date.now() });
    
    // Show notification
    showNotification(`✅ Captured: ${videoId} (${captions.length} captions via ${method})`);
  });
  
  // Show visual notification
  function showNotification(message) {
    const notif = document.createElement('div');
    notif.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #4CAF50;
      color: white;
      padding: 16px 24px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 999999;
      font-family: -apple-system, sans-serif;
      font-size: 14px;
      font-weight: 600;
      animation: slideIn 0.3s ease;
    `;
    notif.textContent = message;
    document.body.appendChild(notif);
    
    setTimeout(() => {
      notif.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => notif.remove(), 300);
    }, 3000);
  }
  
  // Expose functions directly to window (outside IIFE)
  const ytTestStart = function() {
    if (interceptCleanup) {
      console.warn('Method 4 already active!');
      return;
    }
    
    injectMethod4();
    console.log('%c🎬 Ready to capture! Hover over video thumbnails...', 'color: #667eea; font-weight: bold;');
  };
  
  const ytTestStop = function() {
    if (window.__ytCleanup) {
      window.__ytCleanup();
    }
    console.log('%c🛑 Method 4 stopped', 'color: #f44336; font-weight: bold;');
  };
  
  const ytTestResults = function() {
    if (window.__ytResults) {
      window.__ytResults();
    } else {
      console.log('%cMethod 4 not started yet. Run: ytTestStart()', 'color: #999;');
    }
  };
  
  // Expose to window
  window.ytTestStart = ytTestStart;
  window.ytTestStop = ytTestStop;
  window.ytTestResults = ytTestResults;
  
  // Auto-start on YouTube
  if (window.location.hostname.includes('youtube.com')) {
    console.log('%c🎯 YouTube Caption Test Ready!', 'color: #667eea; font-weight: bold; font-size: 14px;');
    console.log('%c' + '─'.repeat(50), 'color: #667eea;');
    console.log('%cRun: %cytTestStart()%c to start capturing', 'color: #667eea;', 'color: #4CAF50; font-weight: bold;', 'color: #667eea;');
    console.log('%c' + '─'.repeat(50), 'color: #667eea;');
  }
})();

