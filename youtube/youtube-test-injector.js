/**
 * YouTube Method 4 Test Injector (Content Script)
 * Loads the page-context script via web_accessible_resource
 */

(function() {
  'use strict';
  
  // Get extension URL for the inject script
  const scriptUrl = chrome.runtime.getURL('youtube/youtube-inject-page.js');
  
  // Create script element pointing to web_accessible_resource
  const script = document.createElement('script');
  script.src = scriptUrl;
  script.onload = () => {
    console.log('[YT Test Injector] Page script loaded successfully');
    script.remove();
  };
  script.onerror = (e) => {
    console.error('[YT Test Injector] Failed to load page script:', e);
  };
  
  // Inject into page
  (document.head || document.documentElement).appendChild(script);
})();
