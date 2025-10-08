// This file runs in PAGE context (injected via web_accessible_resource)
(function() {
  'use strict';
  
  console.log('%c🧪 YouTube Caption Test Ready!', 'color: #667eea; font-weight: bold; font-size: 14px;');
  console.log('%c' + '─'.repeat(50), 'color: #667eea;');
  console.log('%cRun: %cytTestStart()%c to start capturing', 'color: #667eea;', 'color: #4CAF50; font-weight: bold;', 'color: #667eea;');
  console.log('%c' + '─'.repeat(50), 'color: #667eea;');
  
  let isActive = false;
  
  function extractVideoId(url) {
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
      if (match && match[1]) return match[1];
    }
    return null;
  }
  
  function parseCaptions(data) {
    try {
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
  
  window.__ytCaptureData = new Map();
  
  function setupIntercept() {
    if (isActive) {
      console.warn('Method 4 already active!');
      return;
    }
    
    console.log('%c4️⃣ [Method 4] Setting up network intercept...', 'color: #4ECDC4; font-weight: bold;');
    
    const originalFetch = window.fetch.bind(window);
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    
    window.fetch = function(...args) {
      const url = args[0]?.url || args[0]?.toString() || args[0];
      if (typeof url === 'string' && (url.includes('timedtext') || url.includes('caption'))) {
        const videoId = extractVideoId(url);
        console.log('%c4️⃣ Intercepted FETCH:', 'color: #4ECDC4; font-weight: bold;', url.substring(0, 100));
        return originalFetch(...args).then(async (response) => {
          const clone = response.clone();
          try {
            const text = await clone.text();
            const captions = parseCaptions(text);
            if (captions.length > 0 && videoId) {
              window.__ytCaptureData.set(videoId, { videoId, captions, method: 'fetch', url, timestamp: Date.now() });
              console.log('%c✅ CAPTURED via FETCH!', 'color: #4CAF50; font-weight: bold; font-size: 16px;');
              console.log('%c   Video:', 'color: #4CAF50;', videoId, '- Captions:', captions.length);
              console.log('%c   Sample:', 'color: #4CAF50;', captions.slice(0, 3).map(c => c.text).join(' | '));
              showNotification('✅ Captured: ' + videoId + ' (' + captions.length + ' captions)');
            }
          } catch (err) {
            console.error('Error:', err);
          }
          return response;
        });
      }
      return originalFetch(...args);
    };
    
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this._ytUrl = url;
      return originalXHROpen.apply(this, [method, url, ...rest]);
    };
    
    XMLHttpRequest.prototype.send = function(...args) {
      const xhr = this;
      if (xhr._ytUrl && (xhr._ytUrl.includes('timedtext') || xhr._ytUrl.includes('caption'))) {
        const videoId = extractVideoId(xhr._ytUrl);
        console.log('%c4️⃣ Intercepted XHR:', 'color: #4ECDC4; font-weight: bold;', xhr._ytUrl.substring(0, 100));
        xhr.addEventListener('load', function() {
          try {
            const text = xhr.responseText;
            const captions = parseCaptions(text);
            if (captions.length > 0 && videoId) {
              window.__ytCaptureData.set(videoId, { videoId, captions, method: 'xhr', url: xhr._ytUrl, timestamp: Date.now() });
              console.log('%c✅ CAPTURED via XHR!', 'color: #4CAF50; font-weight: bold; font-size: 16px;');
              console.log('%c   Video:', 'color: #4CAF50;', videoId, '- Captions:', captions.length);
              console.log('%c   Sample:', 'color: #4CAF50;', captions.slice(0, 3).map(c => c.text).join(' | '));
              showNotification('✅ Captured: ' + videoId + ' (' + captions.length + ' captions)');
            }
          } catch (err) {
            console.error('Error:', err);
          }
        });
      }
      return originalXHRSend.apply(this, args);
    };
    
    isActive = true;
    console.log('%c✅ Network intercept ACTIVE!', 'color: #4CAF50; font-weight: bold; font-size: 14px;');
    console.log('%cHover over video thumbnails and wait for previews...', 'color: #999;');
    
    window.__ytCleanup = function() {
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.open = originalXHROpen;
      XMLHttpRequest.prototype.send = originalXHRSend;
      isActive = false;
      console.log('%c🔌 Intercept REMOVED', 'color: #f44336; font-weight: bold;');
    };
  }
  
  function showNotification(message) {
    const notif = document.createElement('div');
    notif.style.cssText = 'position:fixed;top:20px;right:20px;background:#4CAF50;color:white;padding:16px 24px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:999999;font-family:-apple-system,sans-serif;font-size:14px;font-weight:600;';
    notif.textContent = message;
    document.body.appendChild(notif);
    setTimeout(() => notif.remove(), 3000);
  }
  
  window.ytTestStart = function() { setupIntercept(); };
  window.ytTestStop = function() { window.__ytCleanup ? window.__ytCleanup() : console.log('Not started'); };
  window.ytTestResults = function() {
    console.log('%c📊 Captured Videos:', 'color: #667eea; font-weight: bold; font-size: 14px;');
    if (window.__ytCaptureData.size === 0) {
      console.log('%cNone yet. Run ytTestStart() and hover thumbnails!', 'color: #999;');
    } else {
      window.__ytCaptureData.forEach((data, id) => {
        console.log('  ✅ ' + id + ': ' + data.captions.length + ' captions via ' + data.method);
      });
      console.log('Total: ' + window.__ytCaptureData.size + ' videos');
    }
  };
  
  console.log('%cFunctions ready: ytTestStart(), ytTestResults(), ytTestStop()', 'color: #999;');
})();

