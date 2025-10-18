'use strict';

(function installTwitterInterceptor() {
  if (window.__hoverTwitterInterceptorInstalled) return;
  window.__hoverTwitterInterceptorInstalled = true;
  
  function safePost(payload) {
    try {
      window.postMessage({
        source: 'hover-preview-twitter',
        type: 'TWITTER_GQL_RESPONSE',
        payload
      }, '*');
    } catch (error) {
      console.error('[HoverPreview][Twitter] postMessage failed:', error);
    }
  }
  
  function shouldCapture(url) {
    if (!url) return false;
    if (url.indexOf('/i/api/graphql/') === -1) return false;
    return /TweetDetail|TweetResultByRestId|ConversationTimeline|threaded_conversation/i.test(url);
  }
  
  function handleResponse(url, body, clonePromise) {
    if (!shouldCapture(url)) return;
    clonePromise.then((clone) => {
      clone.json().then((json) => {
        safePost({ url, json });
      }).catch(() => {});
    }).catch(() => {});
  }
  
  const originalFetch = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    try {
      const requestUrl = typeof input === 'string' ? input : (input && input.url);
      const body = init && init.body;
      return originalFetch.apply(this, arguments).then((response) => {
        try {
          handleResponse(requestUrl, body, Promise.resolve(response.clone()));
        } catch (error) {}
        return response;
      });
    } catch (error) {
      return originalFetch.apply(this, arguments);
    }
  };
  
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__hoverTwitterUrl = url;
    return originalOpen.apply(this, arguments);
  };
  
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(body) {
    this.addEventListener('load', function onLoad() {
      try {
        const responseType = this.responseType;
        if (!responseType || responseType === '' || responseType === 'text') {
          const url = this.__hoverTwitterUrl;
          const text = this.responseText;
          if (!shouldCapture(url)) return;
          handleResponse(url, body, Promise.resolve(new Response(text)));
        }
      } catch (error) {}
    });
    return originalSend.apply(this, arguments);
  };
})();
