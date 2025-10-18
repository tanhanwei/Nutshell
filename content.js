(function() {
  'use strict';
  
  // Configuration
  const HOVER_DELAY = 300;
  const IS_YOUTUBE = window.location.hostname.includes('youtube.com');
  const IS_TWITTER = window.location.hostname.includes('twitter.com') || window.location.hostname.includes('x.com');
  const DEBUG_ENABLED = !IS_YOUTUBE; // Disable logs on YouTube to reduce clutter
  
  // Debug logging helper
  const debugLog = (...args) => {
    if (DEBUG_ENABLED) console.log(...args);
  };
  
  const REDDIT_HOSTS = [
    'reddit.com',
    'www.reddit.com',
    'old.reddit.com',
    'new.reddit.com',
    'np.reddit.com',
    'redd.it'
  ];
  const TWITTER_HOSTS = new Set([
    'twitter.com',
    'www.twitter.com',
    'x.com',
    'www.x.com'
  ]);
  const YOUTUBE_HOSTS = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com'
  ]);
  
  // State management
  let currentHoverTimeout = null;
  let hideTimeout = null;
  let lastProcessedUrl = null;
  let currentlyProcessingUrl = null;
  let currentlyDisplayedUrl = null; // Track what URL the tooltip is currently showing
  let processingElement = null; // Track element being processed for positioning
  let tooltip = null;
  let tooltipCloseHandlerAttached = false;
  let twitterHoverTimeout = null;
  let currentTwitterArticle = null;
  let currentTwitterTweetId = null;
  let pendingTwitterThreadId = null;
  let pendingTwitterStartedAt = 0;
  let displayMode = 'both';
  let currentTooltipPlacement = 'auto';
  let currentHoveredElement = null;
  let isMouseInTooltip = false;
  let displayTimes = new Map(); // Track when each URL was displayed (url -> timestamp)
  let hoverTimeouts = new Map(); // Track hover timeouts per URL (url -> timeout ID)
  
  // Twitter-specific state
  const twitterGqlCache = new Map(); // tweetId -> array of captured JSON blobs
  let twitterInterceptorInstalled = false;
  
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  
  // Create tooltip
  function createTooltip() {
    if (tooltip) return tooltip;
    
    // Inject CSS for tooltip list styling
    if (!document.getElementById('hover-tooltip-styles')) {
      const style = document.createElement('style');
      style.id = 'hover-tooltip-styles';
      style.textContent = `
        #hover-summary-tooltip ul {
          margin: 12px 0;
          padding-left: 24px;
          list-style-type: disc;
          list-style-position: outside;
        }
        #hover-summary-tooltip li {
          margin-bottom: 8px;
          line-height: 1.6;
          display: list-item;
        }
        #hover-summary-tooltip strong {
          font-weight: 600;
        }
        #hover-summary-tooltip em {
          font-style: italic;
        }
      `;
      document.head.appendChild(style);
    }
    
    tooltip = document.createElement('div');
    tooltip.id = 'hover-summary-tooltip';
    tooltip.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      background: white;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2), 0 2px 8px rgba(0,0,0,0.1);
      padding: 16px;
      max-width: 400px;
      max-height: 500px;
      overflow-y: auto;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #1a1a1a;
      display: none;
      pointer-events: auto;
      opacity: 0;
      transition: opacity 0.2s ease;
      cursor: auto;
      user-select: text;
    `;
    
    // Make tooltip interactive - prevent hiding when mouse enters
    tooltip.addEventListener('mouseenter', () => {
      isMouseInTooltip = true;
      clearTimeout(hideTimeout);
      hideTimeout = null;
    });
    
    // Hide with delay when mouse leaves tooltip
    tooltip.addEventListener('mouseleave', () => {
      isMouseInTooltip = false;
      scheduleHide(200); // Short delay when leaving tooltip
    });
    
    document.body.appendChild(tooltip);
    return tooltip;
  }
  
  // Position tooltip
  function positionTooltip(element, placement = 'auto') {
    if (!tooltip || !element) return;
    
    const rect = element.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const gap = 12;
    
    let top = rect.top;
    let left = rect.left;
    
    if (placement === 'right') {
      left = rect.right + gap;
      if (left + tooltipRect.width > viewportWidth - gap) {
        left = rect.left - gap - tooltipRect.width;
      }
      if (left < gap) {
        left = Math.max(gap, rect.left);
      }
      top = Math.max(gap, Math.min(rect.top, viewportHeight - tooltipRect.height - gap));
    } else if (placement === 'left') {
      left = rect.left - gap - tooltipRect.width;
      if (left < gap) {
        left = rect.right + gap;
      }
      if (left + tooltipRect.width > viewportWidth - gap) {
        left = Math.max(gap, viewportWidth - tooltipRect.width - gap);
      }
      top = Math.max(gap, Math.min(rect.top, viewportHeight - tooltipRect.height - gap));
    } else {
      if (rect.bottom + gap + tooltipRect.height < viewportHeight) {
        top = rect.bottom + gap;
      } else if (rect.top - gap - tooltipRect.height > 0) {
        top = rect.top - gap - tooltipRect.height;
      } else {
        top = Math.max(gap, (viewportHeight - tooltipRect.height) / 2);
      }
      left = rect.left;
      if (left + tooltipRect.width > viewportWidth - gap) {
        left = Math.max(gap, rect.right - tooltipRect.width);
      }
      if (left < gap) {
        left = gap;
      }
    }
    
    top = Math.max(gap, Math.min(top, viewportHeight - tooltipRect.height - gap));
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }
  
  const handleTooltipPointerDown = (event) => {
    if (!tooltip || tooltip.style.display !== 'block') return;
    if (tooltip.contains(event.target)) {
      return;
    }
    hideTooltip();
  };
  
  const handleTooltipKeyDown = (event) => {
    if (event.key === 'Escape' && tooltip && tooltip.style.display === 'block') {
      hideTooltip();
    }
  };
  
  function attachTooltipDismissHandlers() {
    if (tooltipCloseHandlerAttached) return;
    document.addEventListener('pointerdown', handleTooltipPointerDown, true);
    document.addEventListener('keydown', handleTooltipKeyDown, true);
    tooltipCloseHandlerAttached = true;
  }
  
  function detachTooltipDismissHandlers() {
    if (!tooltipCloseHandlerAttached) return;
    document.removeEventListener('pointerdown', handleTooltipPointerDown, true);
    document.removeEventListener('keydown', handleTooltipKeyDown, true);
    tooltipCloseHandlerAttached = false;
  }
  
  // ============ Twitter-Specific Helpers ============
  
  function ensureTwitterInterceptor() {
    if (!IS_TWITTER || twitterInterceptorInstalled) return;
    twitterInterceptorInstalled = true;
    injectTwitterInterceptor();
    window.addEventListener('message', handleTwitterPostMessage);
  }
  
  function injectTwitterInterceptor() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('twitter/twitter-interceptor.js');
    script.type = 'text/javascript';
    script.onload = () => {
      script.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }
  
  function handleTwitterPostMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'hover-preview-twitter' || data.type !== 'TWITTER_GQL_RESPONSE') return;
    try {
      const payload = data.payload;
      if (!payload || !payload.json) return;
      recordTwitterGqlPayload(payload.json);
    } catch (error) {
      console.warn('[Twitter] Failed to process intercepted payload:', error);
    }
  }
  
  function recordTwitterGqlPayload(json) {
    const tweetIds = extractTweetIdsFromJson(json);
    if (!tweetIds.length) return;
    tweetIds.forEach((id) => {
      if (!twitterGqlCache.has(id)) {
        twitterGqlCache.set(id, []);
      }
      const entries = twitterGqlCache.get(id);
      entries.push(json);
      if (entries.length > 8) {
        entries.shift();
      }
    });
  }
  
  function extractTweetIdsFromJson(obj) {
    const ids = new Set();
    const visited = new Set();
    
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);
      
      if (node.rest_id || node.restId) {
        const id = String(node.rest_id || node.restId);
        if (id) ids.add(id);
      }
      
      if (node.legacy && node.legacy.id_str) {
        ids.add(String(node.legacy.id_str));
      }
      
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        const value = node[key];
        if (typeof value === 'object' && value !== null) {
          walk(value);
        }
      }
    }
    
    try {
      walk(obj);
    } catch (error) {
      console.warn('[Twitter] Failed to extract tweet IDs:', error);
    }
    
    return Array.from(ids);
  }
  
  function buildThreadFromCache(tweetId) {
    if (!tweetId) return null;
    const blobs = twitterGqlCache.get(tweetId);
    if (!blobs || !blobs.length) return null;
    
    const nodesById = new Map();
    blobs.forEach((blob) => {
      collectTweetsFromPayload(blob, nodesById);
    });
    
    if (!nodesById.size) return null;
    
    const rootNode = nodesById.get(tweetId) || Array.from(nodesById.values())[0];
    if (!rootNode) return null;
    
    const conversationId = rootNode.conversationId || null;
    const collectedNodes = [];
    
    nodesById.forEach((node) => {
      if (conversationId && node.conversationId && node.conversationId !== conversationId) {
        return;
      }
      collectedNodes.push(Object.assign({}, node));
    });
    
    if (!collectedNodes.length) return null;
    
    collectedNodes.sort((a, b) => {
      const aTime = a.timestamp || '';
      const bTime = b.timestamp || '';
      return aTime.localeCompare(bTime);
    });
    
    const limitedNodes = collectedNodes.slice(0, 20);
    if (!limitedNodes.some((node) => node.id === rootNode.id)) {
      limitedNodes.unshift(Object.assign({}, rootNode));
    }
    limitedNodes.forEach((node, index) => {
      node.order = index;
    });
    
    return {
      rootId: rootNode.id,
      conversationId,
      nodes: limitedNodes,
      source: 'interceptor'
    };
  }
  
  function collectTweetsFromPayload(obj, map) {
    const visited = new Set();
    
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);
      
      const candidate = extractTweetCandidate(node);
      if (candidate) {
        const id = candidate.id;
        if (!map.has(id) || (candidate.text && candidate.text.length > (map.get(id).text || '').length)) {
          map.set(id, candidate);
        }
      }
      
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        const value = node[key];
        if (typeof value === 'object' && value !== null) {
          walk(value);
        }
      }
    }
    
    walk(obj);
  }
  
  function extractTweetCandidate(node) {
    const result = resolveTweetResult(node);
    if (!result) return null;
    
    const legacy = result.legacy || (result.tweet && result.tweet.legacy);
    if (!legacy) return null;
    
    const id = result.rest_id || (legacy && legacy.id_str);
    if (!id) return null;
    
    const userLegacy = (result.core && result.core.user_results && result.core.user_results.result && result.core.user_results.result.legacy) ||
                       (result.author && result.author.legacy) ||
                       null;
    
    const text = extractTweetText(result, legacy);
    const timestamp = legacy.created_at ? new Date(legacy.created_at).toISOString() : null;
    const conversationId = legacy.conversation_id_str || null;
    const handle = userLegacy ? userLegacy.screen_name : (legacy && legacy.screen_name) || null;
    const authorName = userLegacy ? userLegacy.name : null;
    const avatarUrl = userLegacy ? userLegacy.profile_image_url_https : null;
    const permalink = handle ? `https://x.com/${handle}/status/${id}` : (legacy.url || null);
    const inReplyToId = legacy.in_reply_to_status_id_str ? String(legacy.in_reply_to_status_id_str) : null;
    
    const media = extractTweetMedia(legacy);
    
    return {
      id: String(id),
      conversationId: conversationId ? String(conversationId) : null,
      authorName: authorName || null,
      handle: handle ? `@${handle}` : null,
      avatarUrl: avatarUrl || null,
      timestamp,
      permalink,
      text,
      media,
      inReplyToId,
      order: 0
    };
  }
  
  function resolveTweetResult(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.__typename === 'Tweet') return node;
    if (node.result && node.result.__typename === 'Tweet') return node.result;
    if (node.tweet && node.tweet.__typename === 'Tweet') return node.tweet;
    if (node.tweet_results && node.tweet_results.result && node.tweet_results.result.__typename === 'Tweet') return node.tweet_results.result;
    if (node.itemContent && node.itemContent.tweet_results && node.itemContent.tweet_results.result) {
      return node.itemContent.tweet_results.result;
    }
    if (node.item && node.item.itemContent && node.item.itemContent.tweet_results && node.item.itemContent.tweet_results.result) {
      return node.item.itemContent.tweet_results.result;
    }
    if (node.content && node.content.tweetResult && node.content.tweetResult.result) {
      return node.content.tweetResult.result;
    }
    if (node.content && node.content.itemContent && node.content.itemContent.tweet_results && node.content.itemContent.tweet_results.result) {
      return node.content.itemContent.tweet_results.result;
    }
    if (node.tweetResult && node.tweetResult.result) {
      return node.tweetResult.result;
    }
    if (node.tweet && node.tweet.core && node.tweet.core.tweet && node.tweet.core.tweet.legacy) {
      return node.tweet.core.tweet;
    }
    return null;
  }
  
  function extractTweetText(result, legacy) {
    if (!legacy) return '';
    if (result.note_tweet && result.note_tweet.note_tweet_results && result.note_tweet.note_tweet_results.result) {
      const note = result.note_tweet.note_tweet_results.result;
      if (note && note.text) {
        return note.text;
      }
      if (note && Array.isArray(note.entity_set?.note_inline_media)) {
        const textPieces = [];
        if (note.entity_set?.richtext?.plain_text) {
          textPieces.push(note.entity_set.richtext.plain_text);
        }
        if (note.entity_set?.media) {
          note.entity_set.media.forEach((mediaItem) => {
            if (mediaItem.alt_text) {
              textPieces.push(`[Image: ${mediaItem.alt_text}]`);
            }
          });
        }
        if (textPieces.length) {
          return textPieces.join('\n');
        }
      }
    }
    
    if (legacy.full_text) {
      return legacy.full_text;
    }
    
    if (legacy.text) {
      return legacy.text;
    }
    
    return '';
  }
  
  function extractTweetMedia(legacy) {
    const media = [];
    const entities = (legacy.extended_entities && legacy.extended_entities.media) ||
                     (legacy.entities && legacy.entities.media) ||
                     [];
    
    entities.forEach((item) => {
      if (!item) return;
      if (item.type === 'photo') {
        media.push({
          kind: 'photo',
          urls: item.media_url_https ? [item.media_url_https] : []
        });
      } else if (item.type === 'animated_gif') {
        const variants = (item.video_info && item.video_info.variants) || [];
        const urls = variants.filter((variant) => variant.url).map((variant) => variant.url);
        media.push({
          kind: 'gif',
          urls
        });
      } else if (item.type === 'video') {
        const variants = (item.video_info && item.video_info.variants) || [];
        const urls = variants.filter((variant) => variant.url).map((variant) => variant.url);
        media.push({
          kind: 'video',
          urls,
          poster: item.media_url_https || null
        });
      }
    });
    
    return media;
  }
  
  async function extractThreadFromDom(articleElement, tweetId) {
    try {
      await expandTwitterThread(articleElement);
    } catch (error) {
      console.warn('[Twitter] Expand thread failed:', error);
    }
    
    const articles = collectThreadArticles(articleElement);
    if (!articles.length) return null;
    
    const nodes = [];
    articles.forEach((article, index) => {
      const node = extractNodeFromArticle(article, index === 0, tweetId);
      if (node) {
        nodes.push(node);
      }
    });
    
    if (!nodes.length) return null;
    
    const deduped = new Map();
    nodes.forEach((node) => {
      const existing = deduped.get(node.id);
      if (!existing || (node.text && node.text.length > (existing.text || '').length)) {
        deduped.set(node.id, node);
      }
    });
    const uniqueNodes = Array.from(deduped.values());
    if (!uniqueNodes.length) return null;
    
    uniqueNodes.sort((a, b) => {
      const aTime = a.timestamp || '';
      const bTime = b.timestamp || '';
      return aTime.localeCompare(bTime);
    });
    
    const limitedNodes = uniqueNodes.slice(0, 12);
    limitedNodes.forEach((node, index) => {
      node.order = index;
    });
    
    const rootNode = limitedNodes.find((node) => node.id === tweetId) || limitedNodes[0];
    return {
      rootId: rootNode.id,
      conversationId: rootNode.conversationId || null,
      nodes: limitedNodes,
      source: 'dom'
    };
  }
  
  async function waitForPrimaryTwitterArticle(timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const article = document.querySelector('article[role="article"]');
      if (article) return article;
      await sleep(150);
    }
    return null;
  }
  
  async function captureThreadForBackground(tweetId) {
    const start = Date.now();
    let lastPayload = null;
    while (Date.now() - start < 12000) {
      const cached = buildThreadFromCache(tweetId);
      if (cached && cached.nodes && cached.nodes.length > 1) {
        cached.source = 'background-intercept';
        return cached;
      }
      const rootArticle = await waitForPrimaryTwitterArticle();
      if (rootArticle) {
        await sleep(400);
        await preloadTwitterConversation(rootArticle, { passes: 6, skipRestore: true });
        await sleep(500);
        const payload = await extractThreadFromDom(rootArticle, tweetId);
        if (payload && Array.isArray(payload.nodes) && payload.nodes.length > 1) {
          payload.source = payload.source === 'dom' ? 'background-dom' : payload.source;
          return payload;
        }
        if (payload) {
          lastPayload = payload;
        }
      } else {
        await sleep(400);
      }
    }
    if (lastPayload && lastPayload.nodes && lastPayload.nodes.length) {
      lastPayload.source = 'background-dom';
    }
    return lastPayload;
  }

  async function expandTwitterThread(articleElement, options = {}) {
    const { skipRestore = false } = options || {};
    const scrollElement = document.scrollingElement || document.documentElement;
    const originalScrollTop = scrollElement.scrollTop;
    const originalBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    
    const expandButtons = [];
    const buttonSelector = 'div[role="button"], button, a[role="link"]';
    const EXPAND_LABEL_REGEX = /(show|view|reveal).*(repl|thread|tweet)/i;
    
    try {
      for (let i = 0; i < 6; i++) {
        const candidates = Array.from(document.querySelectorAll(buttonSelector));
        candidates.forEach((btn) => {
          const text = (btn.textContent || '').trim();
          if (text && EXPAND_LABEL_REGEX.test(text)) {
            expandButtons.push(btn);
          }
        });
        await sleep(160);
      }
      
      expandButtons.forEach((btn) => {
        try {
          btn.click();
        } catch (error) {}
      });
      
      if (articleElement && articleElement.scrollIntoView) {
        articleElement.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      }
      await sleep(260);
    } finally {
      if (!skipRestore) {
        scrollElement.scrollTop = originalScrollTop;
      }
      document.documentElement.style.scrollBehavior = originalBehavior || '';
    }
  }
  
  async function preloadTwitterConversation(articleElement, options = {}) {
    const { passes = 6, skipRestore = false } = options || {};
    const scrollElement = document.scrollingElement || document.documentElement;
    const originalScrollTop = scrollElement.scrollTop;
    const originalBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    
    try {
      for (let i = 0; i < passes; i++) {
        await expandTwitterThread(articleElement, { skipRestore: true });
        scrollElement.scrollBy(0, Math.max(window.innerHeight * 0.9, 600));
        await sleep(420 + (i * 90));
        await expandTwitterThread(articleElement, { skipRestore: true });
        await sleep(220);
      }
      scrollElement.scrollTo(0, document.body.scrollHeight);
      await sleep(600);
      await expandTwitterThread(articleElement, { skipRestore: true });
    } finally {
      if (!skipRestore) {
        scrollElement.scrollTop = originalScrollTop;
      }
      document.documentElement.style.scrollBehavior = originalBehavior || '';
    }
  }
  
  function collectThreadArticles(rootArticle) {
    const articles = new Set();
    if (rootArticle) {
      articles.add(rootArticle);
    }
    
    const timelineSelectors = [
      '[aria-label^="Timeline:"]',
      '[data-testid="primaryColumn"]',
      'main[role="main"]'
    ];
    timelineSelectors.forEach((selector) => {
      const container = document.querySelector(selector);
      if (container) {
        container.querySelectorAll('article[role="article"]').forEach((article) => articles.add(article));
      }
    });
    
    document.querySelectorAll('article[role="article"]').forEach((article) => articles.add(article));
    
    return Array.from(articles);
  }
  
  function extractNodeFromArticle(article, isRoot, fallbackTweetId) {
    const link = article.querySelector('a[href*="/status/"]');
    const match = link && link.getAttribute('href') ? link.getAttribute('href').match(/status\/(\d+)/) : null;
    const id = match ? match[1] : (isRoot && fallbackTweetId ? fallbackTweetId : null);
    if (!id) return null;
    
    const handleEl = article.querySelector('div[dir="ltr"] span');
    const handle = handleEl ? handleEl.textContent : null;
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const text = textEl ? textEl.innerText.trim() : '';
    const timeEl = article.querySelector('time');
    const timestamp = timeEl ? timeEl.getAttribute('datetime') : null;
    
    const media = [];
    const imageEls = Array.from(article.querySelectorAll('img'));
    imageEls.forEach((img) => {
      if (!img || !img.src) return;
      const alt = img.alt || '';
      const dimensions = img.width && img.height ? img.width * img.height : 0;
      if (dimensions > 40000 || alt.toLowerCase().includes('image')) {
        media.push({
          kind: 'photo',
          urls: [img.src]
        });
      }
    });
    
    return {
      id: String(id),
      conversationId: null,
      authorName: null,
      handle: handle || null,
      avatarUrl: null,
      timestamp,
      permalink: link ? link.href : null,
      text,
      media,
      inReplyToId: null,
      order: 0,
      source: 'dom'
    };
  }
  
  function formatTwitterThreadForSummary(threadPayload) {
    if (!threadPayload || !threadPayload.nodes || !threadPayload.nodes.length) {
      return '';
    }
    
    const lines = [];
    threadPayload.nodes.forEach((node, index) => {
      const indexLabel = index === 0 ? 'Original tweet' : `Reply ${index}`;
      const authorLabel = node.handle || node.authorName || 'Unknown user';
      let timestampText = '';
      if (node.timestamp) {
        const date = new Date(node.timestamp);
        if (!Number.isNaN(date.getTime())) {
          timestampText = date.toLocaleString();
        }
      }
      lines.push(`${indexLabel} — ${authorLabel}${timestampText ? ` (${timestampText})` : ''}`);
      if (node.text) {
        lines.push(node.text);
      }
      if (node.media && node.media.length) {
        const mediaSummary = node.media.map((item) => item.kind).join(', ');
        lines.push(`[Media: ${mediaSummary}]`);
      }
      lines.push('');
    });
    
    return lines.join('\n').trim();
  }
  
  function clearTwitterState() {
    currentTwitterArticle = null;
    currentTwitterTweetId = null;
    pendingTwitterThreadId = null;
    pendingTwitterStartedAt = 0;
  }
  
  function getTweetInfoFromArticle(article) {
    if (!article) return null;
    const link = article.querySelector('a[href*="/status/"]');
    if (!link) return null;
    const href = link.getAttribute('href') || '';
    const match = href.match(/status\/(\d+)/);
    if (!match) return null;
    const id = match[1];
    const displayUrl = link.href || (`https://x.com${href.startsWith('/') ? href : `/${href}`}`);
    const canonicalUrl = `https://x.com/i/status/${id}`;
    return { id, url: canonicalUrl, displayUrl };
  }
  
  async function processTwitterHover(article, presetInfo = null) {
    const info = presetInfo || getTweetInfoFromArticle(article);
    if (!info) {
      debugLog('[Twitter] No tweet info found for hovered article');
      return;
    }
    
    const { id, url, displayUrl } = info;
    const requestUrl = displayUrl || url;
    const shortUrl = getShortUrl(url);
    
    currentTwitterArticle = article;
    currentTwitterTweetId = id;
    currentlyProcessingUrl = url;
    processingElement = article;
    currentHoveredElement = article;
    pendingTwitterThreadId = id;
    pendingTwitterStartedAt = Date.now();
    
    if (displayMode === 'tooltip' || displayMode === 'both') {
      showTooltip(article, '<div style="text-align:center;padding:16px;opacity:0.75;">Capturing thread…</div>', url);
    }
    
    const isPermalinkView = window.location.pathname.includes('/status/');
    let threadPayload = null;
    
    if (isPermalinkView) {
      threadPayload = buildThreadFromCache(id);
      if (!threadPayload) {
        threadPayload = await extractThreadFromDom(article, id);
      }
    }
    
    if (!isPermalinkView && threadPayload && threadPayload.nodes && threadPayload.nodes.length < 2) {
      threadPayload = null;
    }
    
    if (!threadPayload || !threadPayload.nodes || threadPayload.nodes.length < 2) {
      if (displayMode === 'tooltip' || displayMode === 'both') {
        showTooltip(article, '<div style="text-align:center;padding:16px;opacity:0.75;">Opening conversation…</div>', url);
      }
      
      for (let attempt = 0; attempt < 3 && (!threadPayload || !threadPayload.nodes || threadPayload.nodes.length < 2); attempt++) {
        try {
          const response = await chrome.runtime.sendMessage({
            type: 'SCRAPE_TWITTER_THREAD',
            url,
            tweetId: id,
            requestUrl
          });
          
          if (response && response.status === 'ok' && response.payload && response.payload.nodes && response.payload.nodes.length) {
            threadPayload = response.payload;
            debugLog(`[Twitter] Background scrape returned ${threadPayload.nodes.length} tweets`);
            break;
          } else if (response && response.error) {
            debugLog(`[Twitter] Background scrape error: ${response.error} (attempt ${attempt + 1})`);
          }
        } catch (error) {
          debugLog('[Twitter] Background scrape failed', error);
        }
        await sleep(400 * (attempt + 1));
      }
    }
    
    if (!threadPayload || !threadPayload.nodes || threadPayload.nodes.length < 2) {
      if (displayMode === 'tooltip' || displayMode === 'both') {
        showTooltip(article, '<div style="padding:10px;background:#fee;border-radius:8px;">Unable to capture replies right now. Try again once the conversation loads.</div>', url);
      }
      currentlyProcessingUrl = null;
      processingElement = null;
      currentHoveredElement = null;
      clearTwitterState();
      return;
    }
    
    debugLog(`[Twitter] Thread captured via ${threadPayload.source || 'unknown'} with ${threadPayload.nodes.length} tweets`);
    const summaryInput = formatTwitterThreadForSummary(threadPayload);
    const leadNode = threadPayload.nodes[0];
    const title = leadNode && (leadNode.handle || leadNode.authorName)
      ? `Thread by ${leadNode.handle || leadNode.authorName}`
      : 'Twitter Thread';
    
    const result = await chrome.runtime.sendMessage({
      type: 'SUMMARIZE_CONTENT',
      url,
      title,
      textContent: summaryInput
    });
    
    const isStillCurrent = (currentlyProcessingUrl === url);
    handleSummaryResult(result, article, url, shortUrl, isStillCurrent);
    pendingTwitterThreadId = null;
    pendingTwitterStartedAt = 0;
    if (!currentHoveredElement && (displayMode === 'tooltip' || displayMode === 'both')) {
      scheduleHide(800, url);
    }
  }
  
  // Schedule hiding tooltip with delay
  function scheduleHide(delay = 500, forUrl = null) {
    const shortUrl = forUrl ? getShortUrl(forUrl) : 'none';
    debugLog(`⏲️ SCHEDULE HIDE: for "${shortUrl}" in ${delay}ms (currently showing: "${currentlyDisplayedUrl ? getShortUrl(currentlyDisplayedUrl) : 'none'}")`);
    
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      const currentShortUrl = currentlyDisplayedUrl ? getShortUrl(currentlyDisplayedUrl) : 'none';
      // Only hide if:
      // 1. Mouse is not in tooltip
      // 2. Either no URL specified, or the tooltip is still showing this URL's content
      if (!isMouseInTooltip && (!forUrl || currentlyDisplayedUrl === forUrl)) {
        debugLog(`🔽 EXECUTING HIDE: scheduled for "${shortUrl}", currently showing "${currentShortUrl}" - HIDING NOW`);
        hideTooltip();
      } else {
        debugLog(`🚫 SKIP HIDE: scheduled for "${shortUrl}", currently showing "${currentShortUrl}" (mouse in tooltip: ${isMouseInTooltip}, URL match: ${currentlyDisplayedUrl === forUrl})`);
      }
    }, delay);
  }
  
  // Show tooltip
  function showTooltip(element, content, url, options = {}) {
    if (displayMode === 'panel') return;
    
    const placement = options.placement || 'auto';
    currentTooltipPlacement = placement;
    const shortUrl = url ? getShortUrl(url) : 'unknown';
    debugLog(`📤 SHOW TOOLTIP: "${shortUrl}" (was showing: "${currentlyDisplayedUrl ? getShortUrl(currentlyDisplayedUrl) : 'none'}")`);
    
    clearTimeout(hideTimeout);
    hideTimeout = null;
    
    const tooltipEl = createTooltip();
    tooltipEl.innerHTML = content;
    tooltipEl.style.display = 'block';
    attachTooltipDismissHandlers();
    
    currentlyDisplayedUrl = url;
    
    const anchor = element || processingElement || currentHoveredElement;
    positionTooltip(anchor, placement);
    
    if (url) {
      displayTimes.set(url, Date.now());
    }
    
    requestAnimationFrame(() => {
      tooltipEl.style.opacity = '1';
    });
  }
  
  // Hide tooltip immediately
  function hideTooltip() {
    if (tooltip) {
      const wasShowing = currentlyDisplayedUrl ? getShortUrl(currentlyDisplayedUrl) : 'none';
      debugLog(`📥 HIDE TOOLTIP: was showing "${wasShowing}"`);
      
      tooltip.style.opacity = '0';
      currentlyDisplayedUrl = null; // Clear displayed URL when hiding
      setTimeout(() => {
        if (tooltip && !isMouseInTooltip) {
          tooltip.style.display = 'none';
          debugLog(`🔒 TOOLTIP CLOSED: display set to none`);
        }
      }, 200);
      
      detachTooltipDismissHandlers();
      currentlyProcessingUrl = null;
      processingElement = null;
      currentHoveredElement = null;
      currentTooltipPlacement = 'auto';
    }
  }
  
  // Update tooltip content
  function updateTooltipContent(content, url) {
    if (displayMode === 'panel') return;
    
    const shortUrl = url ? getShortUrl(url) : 'unknown';
    const wasShowing = currentlyDisplayedUrl ? getShortUrl(currentlyDisplayedUrl) : 'none';
    debugLog(`🔄 UPDATE TOOLTIP: "${shortUrl}" (was showing: "${wasShowing}", visible: ${tooltip && tooltip.style.display === 'block'})`);
    
    // Cancel any pending hide when new content arrives (keep tooltip visible during streaming)
    clearTimeout(hideTimeout);
    hideTimeout = null;
    
    if (tooltip) {
      // Show tooltip if it's not visible (streaming content arrived)
      if (tooltip.style.display !== 'block') {
        tooltip.style.display = 'block';
        debugLog(`  └─ 👁️ Making tooltip visible`);
        // Record display time when showing for first time
        if (url) {
          displayTimes.set(url, Date.now());
        }
      }
      
      // Track what URL is currently displayed
      currentlyDisplayedUrl = url;
      
      tooltip.innerHTML = content;
      tooltip.style.opacity = '1';
      
      const elementForPositioning = currentHoveredElement || processingElement;
      if (elementForPositioning) {
        positionTooltip(elementForPositioning, currentTooltipPlacement);
      }
    }
  }
  
  // Find link element
  function findLink(element) {
    let current = element;
    for (let i = 0; i < 10 && current; i++) {
      if (current.tagName === 'A' && current.href) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }
  
  // Get link type for debugging
  function getLinkType(link, target) {
    // Check if the immediate target or any child is an image
    const hasImage = link.querySelector('img') !== null;
    const targetIsImage = target.tagName === 'IMG';
    
    if (targetIsImage || hasImage) {
      return '🖼️ IMAGE-LINK';
    }
    return '📝 TEXT-LINK';
  }
  
  // Get short URL for logging
  function getShortUrl(url) {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname;
      // Get last 2 segments of path or domain
      const segments = path.split('/').filter(s => s);
      const lastSegments = segments.slice(-2).join('/');
      return lastSegments || urlObj.hostname;
    } catch {
      return url.substring(0, 50);
    }
  }
  
  function isRedditPostUrl(url) {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      
      const matchesRedditHost = REDDIT_HOSTS.some(host => {
        if (hostname === host) return true;
        return hostname.endsWith(`.${host}`);
      });
      
      if (!matchesRedditHost) {
        return false;
      }
      
      if (hostname === 'redd.it' || hostname.endsWith('.redd.it')) {
        const slug = parsed.pathname.replace(/\//g, '').trim();
        return /^[a-z0-9]+$/i.test(slug);
      }
      
      return /\/comments\/[a-z0-9]+/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }
  
  function isInternalTwitterLink(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      return TWITTER_HOSTS.has(parsed.hostname.toLowerCase());
    } catch {
      return false;
    }
  }
  
  function extractYouTubeVideoId(url) {
    if (!url) return null;
    const patterns = [
      /(?:youtube\.com\/(watch\?v=|embed\/)|youtu\.be\/)([^&\n?#]+)/,
      /youtube\.com\/shorts\/([^&\n?#]+)/,
      /[?&]v=([^&\n?#]+)/
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[2]) return match[2];
      if (match && match[1] && pattern.source.includes('shorts')) return match[1];
      if (!pattern.source.includes('shorts') && match && match[1]) return match[1];
    }
    return null;
  }
  
  function isYouTubeVideoLink(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) return false;
      const videoId = extractYouTubeVideoId(url);
      return !!videoId;
    } catch {
      return false;
    }
  }
  
  // Handle mouseover
  function handleMouseOver(e) {
    const link = findLink(e.target);
    if (!link) {
      if (IS_TWITTER) {
        const article = e.target.closest && e.target.closest('article[role="article"]');
        if (article) {
          const info = getTweetInfoFromArticle(article);
          if (!info) return;
          
          ensureTwitterInterceptor();
          
          const isSameTweet = (currentTwitterTweetId === info.id && currentlyProcessingUrl === info.url);
          if (isSameTweet) {
            return;
          }
          
          if (twitterHoverTimeout) {
            clearTimeout(twitterHoverTimeout);
            twitterHoverTimeout = null;
          }
          
          twitterHoverTimeout = setTimeout(() => {
            twitterHoverTimeout = null;
            processTwitterHover(article, info);
          }, HOVER_DELAY);
          return;
        }
      }
      // Not a link, skip (don't log - too noisy on YouTube)
      return;
    }
    
    let url = link.href;
    let tweetInfoForLink = null;
    const linkType = getLinkType(link, e.target);
    
    if (IS_TWITTER) {
      const article = link.closest && link.closest('article[role="article"]');
      if (article) {
        tweetInfoForLink = getTweetInfoFromArticle(article);
        if (tweetInfoForLink) {
          ensureTwitterInterceptor();
          const canonicalUrl = tweetInfoForLink.url;
          const linkUrlObj = (() => {
            try {
              return new URL(link.getAttribute('href') || '', window.location.origin);
            } catch (error) {
              return null;
            }
          })();
          const isAuxiliaryMediaLink = linkUrlObj ? /\/status\/[^/]+\/(photo|video|media|audio)/i.test(linkUrlObj.pathname) : false;
          if (isAuxiliaryMediaLink && (pendingTwitterThreadId === tweetInfoForLink.id || currentTwitterTweetId === tweetInfoForLink.id || currentlyProcessingUrl === canonicalUrl)) {
            return;
          }
          link.__hoverTweetInfo = tweetInfoForLink;
          link.__hoverArticle = article;
          link.__hoverCanonicalUrl = canonicalUrl;
          url = canonicalUrl;
        } else {
          delete link.__hoverTweetInfo;
          delete link.__hoverArticle;
          delete link.__hoverCanonicalUrl;
        }
      }
    }
    
    if (IS_TWITTER) {
      try {
        const parsedUrl = new URL(url, window.location.origin);
        if (isInternalTwitterLink(parsedUrl.href) && !/\/status\//.test(parsedUrl.pathname)) {
          return;
        }
      } catch (error) {
        // Ignore parsing issues and proceed
      }
    }
    if (IS_YOUTUBE) {
      try {
        const parsedUrl = new URL(url, window.location.origin);
        if (YOUTUBE_HOSTS.has(parsedUrl.hostname.toLowerCase()) && !isYouTubeVideoLink(url)) {
          return;
        }
      } catch (error) {
        return;
      }
    }
    const shortUrl = getShortUrl(url);

    // Check if this is a YouTube thumbnail first
    if (IS_YOUTUBE && isYouTubeThumbnail(e.target)) {
      console.log(`🎬 YOUTUBE THUMBNAIL: "${shortUrl}" (will trigger in ${HOVER_DELAY}ms)`);
      const videoId = extractYouTubeVideoId(url);
      const canonicalUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
      const isSameVideo = currentlyProcessingUrl === canonicalUrl;
      if (isSameVideo) {
        console.log('[YouTube] ⏭️  Already processing/displaying this video, ignoring re-hover');
        return;
      }
      
      let thumbnailElement = e.target.closest('ytd-thumbnail');
      if (!thumbnailElement) {
        thumbnailElement = e.target.closest('ytd-video-preview') || 
                          e.target.closest('ytd-playlist-thumbnail');
      }
      
      if (!thumbnailElement) {
        console.warn('[YouTube] Could not find thumbnail element, skipping');
        return;
      }
      
      const isSwitch = currentlyProcessingUrl && currentlyProcessingUrl !== canonicalUrl;
      if (isSwitch) {
        console.log(`[YouTube] 🔴 SWITCHING FROM ${currentlyProcessingUrl} TO ${canonicalUrl}`);
        const oldVideoId = extractYouTubeVideoId(currentlyProcessingUrl);
        chrome.runtime.sendMessage({
          action: 'ABORT_YOUTUBE_SUMMARY',
          videoId: oldVideoId,
          newVideoId: videoId
        }, response => {
          console.log(`[YouTube] Abort response:`, response);
        });
      }
      
      currentlyProcessingUrl = canonicalUrl;
      link.__hoverCanonicalUrl = canonicalUrl;
      
      // 2. Clear old hover timeout
      if (currentHoverTimeout) {
        clearTimeout(currentHoverTimeout);
        currentHoverTimeout = null;
      }
      
      // 3. Clear this URL's previous timeout if any
      const oldTimeout = hoverTimeouts.get(canonicalUrl);
      if (oldTimeout) {
        clearTimeout(oldTimeout);
      }
      
      // 4. Clear hide timeout
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
      
      currentHoveredElement = link;
      
      // Schedule hover (DON'T set currentlyProcessingUrl yet - that happens when timeout fires!)
      const hoverTimeout = setTimeout(() => {
        hoverTimeouts.delete(canonicalUrl); // Clean up
        handleYouTubeVideoHover(thumbnailElement, link, canonicalUrl);
      }, HOVER_DELAY);
      
      // Store timeout for this URL
      hoverTimeouts.set(canonicalUrl, hoverTimeout);
      currentHoverTimeout = hoverTimeout; // Keep for compatibility
      
      return; // Don't process as regular link
    }
    
    if (IS_YOUTUBE && isYouTubeVideoLink(url)) {
      const videoId = extractYouTubeVideoId(url);
      if (!videoId) return;
      const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
      link.__hoverCanonicalUrl = canonicalUrl;
      const isSameVideo = currentlyProcessingUrl === canonicalUrl;
      if (isSameVideo) {
        console.log('[YouTube] ⏭️  Already processing/displaying this video link, ignoring re-hover');
        return;
      }
      const isSwitch = currentlyProcessingUrl && currentlyProcessingUrl !== canonicalUrl;
      if (isSwitch) {
        console.log(`[YouTube] 🔴 SWITCHING FROM ${currentlyProcessingUrl} TO ${canonicalUrl}`);
        const oldVideoId = extractYouTubeVideoId(currentlyProcessingUrl);
        chrome.runtime.sendMessage({
          action: 'ABORT_YOUTUBE_SUMMARY',
          videoId: oldVideoId,
          newVideoId: videoId
        }, response => {
          console.log(`[YouTube] Abort response:`, response);
        });
      }
      currentlyProcessingUrl = canonicalUrl;
      if (currentHoverTimeout) {
        clearTimeout(currentHoverTimeout);
        currentHoverTimeout = null;
      }
      const oldTimeout = hoverTimeouts.get(canonicalUrl);
      if (oldTimeout) {
        clearTimeout(oldTimeout);
      }
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
      currentHoveredElement = link;
      const hoverTimeout = setTimeout(() => {
        hoverTimeouts.delete(canonicalUrl);
        handleYouTubeVideoHover(link, link, canonicalUrl);
      }, HOVER_DELAY);
      hoverTimeouts.set(canonicalUrl, hoverTimeout);
      currentHoverTimeout = hoverTimeout;
      return;
    }
    
    // Don't re-trigger if we're already processing this exact URL
    if (currentlyProcessingUrl === url) {
      debugLog(`🚫 BLOCKED: ${linkType} "${shortUrl}" (already processing)`);
      return;
    }
    
    // Cancel any pending hide when hovering a new link (critical for preventing blinks!)
    if (hideTimeout) {
      debugLog(`🚫 CANCEL HIDE: starting hover on "${shortUrl}"`);
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
    
    debugLog(`✅ HOVER: ${linkType} "${shortUrl}" (will trigger in ${HOVER_DELAY}ms)`);
    
    currentHoveredElement = link;
    
    clearTimeout(currentHoverTimeout);
    currentHoverTimeout = setTimeout(() => {
      processLinkHover(link);
    }, HOVER_DELAY);
  }
  
  // Handle mouseout
  function handleMouseOut(e) {
    const link = findLink(e.target);
    if (!link) {
      if (IS_TWITTER) {
        const article = e.target.closest && e.target.closest('article[role="article"]');
        if (article) {
          const relatedArticle = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('article[role="article"]');
          if (relatedArticle === article) {
            return;
          }
          
          const info = getTweetInfoFromArticle(article);
          if (info && pendingTwitterThreadId === info.id) {
            debugLog(`[Twitter] Mouseout while background pending for ${info.id}, keeping tooltip visible`);
            return;
          }
          
          if (twitterHoverTimeout) {
            clearTimeout(twitterHoverTimeout);
            twitterHoverTimeout = null;
          }
          
          if (currentlyProcessingUrl && (!info || info.id !== pendingTwitterThreadId)) {
            scheduleHide(400, currentlyProcessingUrl);
          }
          
          if (!info || info.id !== pendingTwitterThreadId) {
            currentTwitterArticle = null;
            currentTwitterTweetId = null;
          }
          currentHoveredElement = null;
        }
      }
      return;
    }
    
    const url = link.__hoverCanonicalUrl || link.href;
    const tweetInfoMouseOut = link.__hoverTweetInfo || (IS_TWITTER ? getTweetInfoFromArticle(link.closest && link.closest('article[role="article"]')) : null);
    const shortUrl = getShortUrl(url);
    
    // Handle YouTube thumbnail mouseout
    if (IS_YOUTUBE && isYouTubeThumbnail(e.target)) {
      const relatedTarget = e.relatedTarget;
      const thumbnailElement = e.target.closest('ytd-thumbnail') || 
                              e.target.closest('ytd-video-preview') || 
                              e.target.closest('ytd-playlist-thumbnail');
      
      if (relatedTarget && thumbnailElement && thumbnailElement.contains(relatedTarget)) {
        return;
      }
      
      const pendingTimeout = hoverTimeouts.get(url);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        hoverTimeouts.delete(url);
      }
      
      // Allow general logic below to decide whether to hide tooltip; skip additional handling
    }
    
    // Check if we're actually leaving the link (not just moving to a child element or tooltip)
    const relatedTarget = e.relatedTarget;
    if (relatedTarget) {
      // Don't hide if moving to a child element
      if (link.contains(relatedTarget) || link === relatedTarget) {
        debugLog(`⏭️ MOUSEOUT: "${shortUrl}" (child element, ignored)`);
        return;
      }
      // Don't hide if moving into the tooltip
      if (tooltip && (tooltip.contains(relatedTarget) || tooltip === relatedTarget)) {
        debugLog(`⏭️ MOUSEOUT: "${shortUrl}" (into tooltip, ignored)`);
        return;
      }
    }
    
    if (IS_TWITTER && tweetInfoMouseOut && pendingTwitterThreadId === tweetInfoMouseOut.id) {
      debugLog(`[Twitter] Mouseout ignored for pending thread ${tweetInfoMouseOut.id}`);
      return;
    }
    
    // Don't schedule hide if we're actively processing/streaming this URL
    if (currentlyProcessingUrl === url) {
      debugLog(`👋 MOUSEOUT: "${shortUrl}" (streaming active, tooltip will stay visible)`);
      // Don't schedule hide - streaming updates will keep it visible
      // It will only hide when streaming completes or user switches to different URL
    } else {
      // Check if THIS URL's content was just displayed (protection window)
      const urlDisplayTime = displayTimes.get(url) || 0;
      const timeSinceDisplay = urlDisplayTime > 0 ? Date.now() - urlDisplayTime : Infinity;
      const MIN_DISPLAY_TIME = 500; // Minimum time to show content before allowing hide
      
      debugLog(`[DEBUG] URL: "${shortUrl}", displayTime: ${urlDisplayTime}, timeSinceDisplay: ${timeSinceDisplay}ms`);
      
      if (timeSinceDisplay < MIN_DISPLAY_TIME && urlDisplayTime > 0) {
        // Content was just displayed, use longer delay to give user time to see it
        const remainingTime = MIN_DISPLAY_TIME - timeSinceDisplay;
        debugLog(`👋 MOUSEOUT: "${shortUrl}" (content just shown, waiting ${Math.round(remainingTime)}ms before scheduling hide)`);
        
        // Schedule hide after the protection window expires
        setTimeout(() => {
          if (!isMouseInTooltip && !currentHoveredElement) {
            debugLog(`⏰ Protection window expired for "${shortUrl}", now scheduling hide`);
            scheduleHide(500, url); // 500ms > 300ms hover delay to prevent race condition
          }
        }, remainingTime);
      } else {
        debugLog(`👋 MOUSEOUT: "${shortUrl}" (scheduling hide in 500ms, reason: ${urlDisplayTime === 0 ? 'never displayed' : `too long ago (${timeSinceDisplay}ms)`})`);
        scheduleHide(500, url); // 500ms > 300ms hover delay to prevent race condition
      }
    }
    
    // Cancel pending hover
    clearTimeout(currentHoverTimeout);
    currentHoverTimeout = null;
    
    currentHoveredElement = null;
  }
  
  // Process link hover
  async function processLinkHover(link) {
    const url = link.__hoverCanonicalUrl || link.href;
    const shortUrl = getShortUrl(url);
    const isReddit = isRedditPostUrl(url);
    const tweetInfo = link.__hoverTweetInfo || null;
    const tweetArticle = link.__hoverArticle || (link.closest && link.closest('article[role="article"]'));
    
    if (IS_TWITTER && tweetInfo && tweetArticle) {
      await processTwitterHover(tweetArticle, tweetInfo);
      return;
    }
    
    if (IS_TWITTER) {
      try {
        const parsed = new URL(url, window.location.origin);
        if (isInternalTwitterLink(parsed.href) && !/\/status\//.test(parsed.pathname)) {
          currentlyProcessingUrl = null;
          processingElement = null;
          return;
        }
      } catch (error) {
        currentlyProcessingUrl = null;
        processingElement = null;
        return;
      }
    }
    
    // Clear previous processing URL when starting a new one
    if (currentlyProcessingUrl && currentlyProcessingUrl !== url) {
      debugLog(`🔄 SWITCHING: from "${getShortUrl(currentlyProcessingUrl)}" to "${shortUrl}"`);
    }
    
    // Mark this URL as currently being processed
    currentlyProcessingUrl = url;
    processingElement = link; // Track element for positioning during streaming
    
    debugLog(`🔄 PROCESSING: "${shortUrl}"${isReddit ? ' [Reddit]' : ''}`);
    
    // Show loading state in tooltip
    if (displayMode === 'tooltip' || displayMode === 'both') {
      const loadingMessage = isReddit
        ? '<div style="text-align:center;padding:20px;opacity:0.6;">Gathering Reddit discussion...</div>'
        : '<div style="text-align:center;padding:20px;opacity:0.6;">Extracting content...</div>';
      showTooltip(link, loadingMessage, url);
    }
    
    if (isReddit) {
      await processRedditPost(link, url, shortUrl);
      return;
    }
    
    // Fetch HTML
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_CONTENT',
      url: url
    });
    
    if (response.error) {
      console.error('[Content] Fetch error:', response.error);
      if (displayMode === 'tooltip' || displayMode === 'both') {
        showTooltip(link, `<div style="padding:10px;background:#fee;border-radius:8px;">Error: ${response.error}</div>`, url);
      }
      currentlyProcessingUrl = null;
      processingElement = null;
      return;
    }
    
    // Extract content with Readability
    const parser = new DOMParser();
    const doc = parser.parseFromString(response.html, 'text/html');
    const documentClone = doc.cloneNode(true);
    
    // Readability is already loaded via manifest
    const reader = new Readability(documentClone);
    const article = reader.parse();
    
    let title, textContent;
    
    if (article && article.textContent && article.textContent.trim().length > 100) {
      title = article.title || 'Untitled';
      textContent = article.textContent;
    } else {
      const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content') || 
                       doc.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
                       'No content could be extracted from this page.';
      
      title = doc.title || 'Untitled';
      textContent = metaDesc;
    }
    
    // Show generating state
    if (displayMode === 'tooltip' || displayMode === 'both') {
      showTooltip(link, `<div style="opacity:0.6;font-style:italic;">Generating summary...</div>`, url);
    }
    
    // Request summarization from background
    const result = await chrome.runtime.sendMessage({
      type: 'SUMMARIZE_CONTENT',
      url: url,
      title: title,
      textContent: textContent
    });
    
    // Check if this result is still for the current URL we care about
    const isStillCurrent = (currentlyProcessingUrl === url);
    handleSummaryResult(result, link, url, shortUrl, isStillCurrent);
  }
  
  async function processRedditPost(link, url, shortUrl) {
    debugLog(`🧵 REDDIT REQUEST: "${shortUrl}"`);
    
    if (displayMode === 'tooltip' || displayMode === 'both') {
      showTooltip(link, '<div style="opacity:0.6;font-style:italic;">Summarizing Reddit discussion...</div>', url);
    }
    
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'SUMMARIZE_REDDIT_POST',
        url: url
      });
      
      const isStillCurrent = (currentlyProcessingUrl === url);
      handleSummaryResult(result, link, url, shortUrl, isStillCurrent);
    } catch (error) {
      console.error(`[Reddit] Summary failed for "${shortUrl}":`, error);
      if (displayMode === 'tooltip' || displayMode === 'both') {
        const message = (error && error.message) ? error.message : 'Unable to summarize Reddit thread';
        showTooltip(link, `<div style="padding:10px;background:#fee;border-radius:8px;">Error: ${message}</div>`, url);
      }
      if (currentlyProcessingUrl === url) {
        currentlyProcessingUrl = null;
        processingElement = null;
      }
    }
  }
  
  function handleSummaryResult(result, link, url, shortUrl, isStillCurrent) {
    if (!isStillCurrent && IS_TWITTER && pendingTwitterThreadId) {
      pendingTwitterThreadId = null;
      pendingTwitterStartedAt = 0;
    }
  if (!result || !result.status) {
      debugLog(`❌ INVALID RESULT: "${shortUrl}"`);
      if (displayMode === 'tooltip' || displayMode === 'both') {
        showTooltip(link, '<div style="padding:10px;background:#fee;border-radius:8px;">Error: No summary result returned.</div>', url);
      }
      if (isStillCurrent) {
        currentlyProcessingUrl = null;
        processingElement = null;
        clearTwitterState();
      }
      return;
    }
    
    if (result.status === 'duplicate') {
      debugLog(`❌ DUPLICATE: "${shortUrl}" (ignoring)`);
      if (isStillCurrent) {
        currentlyProcessingUrl = null;
        processingElement = null;
        clearTwitterState();
      }
      return;
    }
    
    if (result.status === 'aborted') {
      debugLog(`❌ ABORTED: "${shortUrl}" (was canceled, ${isStillCurrent ? 'clearing' : 'already moved on'})`);
      return;
    }
    
    if (result.status === 'error') {
      const errorMessage = result.error || result.message || 'Unknown error';
      console.error(`❌ ERROR: "${shortUrl}" - ${errorMessage}`);
      if (displayMode === 'tooltip' || (displayMode === 'both' && isStillCurrent)) {
        showTooltip(link, `<div style="padding:10px;background:#fee;border-radius:8px;">Error: ${errorMessage}</div>`, url);
      }
      if (isStillCurrent) {
        currentlyProcessingUrl = null;
        processingElement = null;
        clearTwitterState();
      }
      return;
    }
    
    if (result.status === 'complete' && result.cached) {
      debugLog(`💾 CACHED: "${shortUrl}" (instant display, still current: ${isStillCurrent})`);
      
      if (isStillCurrent) {
        const formattedSummary = formatAISummary(result.summary);
        
        if (displayMode === 'tooltip' || displayMode === 'both') {
          showTooltip(link, formattedSummary, url);
        }
        
        if (displayMode === 'panel' || displayMode === 'both') {
          chrome.runtime.sendMessage({
            type: 'DISPLAY_CACHED_SUMMARY',
            title: result.title,
            summary: formattedSummary
          }).catch(() => {});
        }
        
        currentlyProcessingUrl = null;
        processingElement = null;
        clearTwitterState();
        debugLog(`✅ COMPLETE: "${shortUrl}" (ready for next hover)`);
      } else {
        debugLog(`⚠️ STALE CACHED: "${shortUrl}" (user moved on, ignoring)`);
      }
      return;
    }
    
    if (isStillCurrent) {
      debugLog(`📡 STREAMING: "${shortUrl}" (will receive updates)`);
    } else {
      debugLog(`⚠️ STALE STREAMING: "${shortUrl}" (user moved on, ignoring)`);
    }
    // Streaming updates are handled via STREAMING_UPDATE messages.
  }
  
  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CAPTURE_TWITTER_THREAD') {
      if (!IS_TWITTER) {
        sendResponse({ status: 'error', error: 'NOT_TWITTER_CONTEXT' });
        return false;
      }
      (async () => {
        try {
          const payload = await captureThreadForBackground(message.tweetId);
          if (payload && payload.nodes && payload.nodes.length) {
            sendResponse({ status: 'ok', payload });
          } else {
            sendResponse({ status: 'error', error: 'NO_THREAD_DATA' });
          }
        } catch (error) {
          sendResponse({ status: 'error', error: error ? error.message : 'CAPTURE_FAILED' });
        }
      })();
      return true;
    }
    
    if (message.type === 'STREAMING_UPDATE') {
      // Only accept updates for the EXACT URL we're currently processing
      const isValid = message.url === currentlyProcessingUrl;
      if (!isValid) {
        if (IS_YOUTUBE) {
          console.log(`[YouTube] REJECTED stale update for: ${message.url}`);
          console.log(`  Currently processing: ${currentlyProcessingUrl}`);
        }
        return;
      }
      updateTooltipContent(message.content, message.url);
    }
    
    if (message.type === 'PROCESSING_STATUS') {
      if (message.status === 'started' && currentHoveredElement) {
        if (displayMode === 'tooltip' || displayMode === 'both') {
          showTooltip(currentHoveredElement, `<div style="opacity:0.6;font-style:italic;">Generating summary...</div>`, message.url);
        }
      }
    }
    
    if (message.type === 'DISPLAY_MODE_CHANGED') {
      displayMode = message.displayMode;
      debugLog('[Content] Display mode updated:', displayMode);
      if (displayMode === 'panel') {
        hideTooltip();
      }
    }
  });
  
  // Get initial display mode
  chrome.storage.local.get(['displayMode'], (result) => {
    if (result.displayMode) {
      displayMode = result.displayMode;
      debugLog('[Content] Initial display mode:', displayMode);
    }
  });
  
  // Initialize hover detection
  if (IS_TWITTER) {
    ensureTwitterInterceptor();
  }
  document.body.addEventListener('mouseover', handleMouseOver, true);
  document.body.addEventListener('mouseout', handleMouseOut, true);
  
  debugLog('[Content] Hover link extension initialized');
  
  // Format AI summary (same as background.js)
  function formatAISummary(text) {
    if (!text) return '';
    
    let formatted = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    
    formatted = formatted
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^# (.+)$/gm, '<h2>$1</h2>');
    
    formatted = formatted
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>');
    
    formatted = formatted
      .replace(/\*([^\*\s][^\*]*?[^\*\s])\*/g, '<em>$1</em>')
      .replace(/_([^_\s][^_]*?[^_\s])_/g, '<em>$1</em>');
    
    formatted = formatted
      .replace(/^[\*\-•] (.+)$/gm, '<li>$1</li>');
    
    formatted = formatted
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    
    formatted = formatted
      .replace(/(<li>.*?<\/li>\n?)+/g, (match) => {
        // Remove newlines from inside the list before wrapping
        return '<ul>' + match.replace(/\n/g, '') + '</ul>';
      });
    
    formatted = formatted
      .replace(/\n\n+/g, '</p><p>');
    
    formatted = formatted
      .replace(/\n/g, '<br>');
    
    if (!formatted.startsWith('<h') && !formatted.startsWith('<ul') && !formatted.startsWith('<p>')) {
      formatted = '<p>' + formatted;
    }
    if (!formatted.endsWith('</p>') && !formatted.endsWith('</ul>') && !formatted.endsWith('</h2>') && !formatted.endsWith('</h3>') && !formatted.endsWith('</h4>')) {
      formatted = formatted + '</p>';
    }
    
    formatted = formatted
      .replace(/<p><\/p>/g, '')
      .replace(/<p>\s*<\/p>/g, '');
    
    formatted = formatted
      .replace(/<p>(<h\d>)/g, '$1')
      .replace(/(<\/h\d>)<\/p>/g, '$1')
      .replace(/<p>(<ul>)/g, '$1')
      .replace(/(<\/ul>)<\/p>/g, '$1');
    
    return formatted;
  }
  
  // ============ YouTube-Specific Functions ============
  
  /**
   * Create YouTube summary overlay inside thumbnail
   */
  
  /**
   * Check if an element is a YouTube thumbnail
   */
  function isYouTubeThumbnail(element) {
    if (!IS_YOUTUBE) return false;
    
    // Only check for actual thumbnail elements, not entire video cards
    // This ensures consistent overlay sizing
    const thumbnailSelectors = [
      'ytd-thumbnail',
      'ytd-video-preview',
      'ytd-playlist-thumbnail',
      'a#thumbnail'
    ];
    
    for (const selector of thumbnailSelectors) {
      if (element.matches(selector) || element.closest(selector)) {
        return true;
      }
    }
    
    return false;
  }
  
  function waitForYouTubeCaptions(videoId) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        window.removeEventListener('youtube-captions-ready', captionListener);
        clearTimeout(timeout);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timeout waiting for captions'));
      }, 5000);
      const captionListener = (event) => {
        if (event.detail && event.detail.videoId === videoId) {
          cleanup();
          resolve();
        }
      };
      window.addEventListener('youtube-captions-ready', captionListener);
      if (window.hasYouTubeCaptions) {
        window.hasYouTubeCaptions(videoId)
          .then((hasCaptions) => {
            if (hasCaptions) {
              cleanup();
              resolve();
            }
          })
          .catch(() => {});
      }
    });
  }

  async function handleYouTubeVideoHover(anchorElement, linkElement, url) {
    console.log('[YouTube] Video hover detected:', url);
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) {
      console.warn('[YouTube] Could not extract video ID from:', url);
      currentlyProcessingUrl = null;
      return;
    }
    currentlyProcessingUrl = url;
    processingElement = linkElement || anchorElement;
    currentHoveredElement = anchorElement || linkElement;
    const tooltipOptions = { placement: 'right' };
    if (displayMode === 'tooltip' || displayMode === 'both') {
      showTooltip(anchorElement || linkElement, '<div style="text-align:center;padding:16px;opacity:0.75;">Capturing captions…</div>', url, tooltipOptions);
    }
    const summaryTimeout = setTimeout(() => {
      if (currentlyProcessingUrl === url) {
        chrome.runtime.sendMessage({
          action: 'ABORT_YOUTUBE_SUMMARY',
          videoId
        });
        if (displayMode === 'tooltip' || displayMode === 'both') {
          showTooltip(anchorElement || linkElement, '<div style="padding:10px;background:#fee;border-radius:8px;">Summary timed out. Try hovering again.</div>', url, tooltipOptions);
        }
        currentlyProcessingUrl = null;
      }
    }, 30000);
    try {
      await waitForYouTubeCaptions(videoId);
    } catch (error) {
      console.warn('[YouTube] Captions not ready:', error.message);
      if (displayMode === 'tooltip' || displayMode === 'both') {
        showTooltip(anchorElement || linkElement, '<div style="padding:10px;background:#fee;border-radius:8px;">Captions not available yet. Hover again after the preview loads.</div>', url, tooltipOptions);
      }
      currentlyProcessingUrl = null;
      clearTimeout(summaryTimeout);
      return;
    }
    if (displayMode === 'tooltip' || displayMode === 'both') {
      showTooltip(anchorElement || linkElement, '<div style="text-align:center;padding:16px;opacity:0.75;">Generating summary…</div>', url, tooltipOptions);
    }
    chrome.runtime.sendMessage({
      action: 'GET_YOUTUBE_SUMMARY',
      videoId,
      url
    }, (response) => {
      clearTimeout(summaryTimeout);
      if (chrome.runtime.lastError) {
        console.error('[YouTube] Runtime error:', chrome.runtime.lastError);
        if (displayMode === 'tooltip' || displayMode === 'both') {
          showTooltip(anchorElement || linkElement, '<div style="padding:10px;background:#fee;border-radius:8px;">Error generating summary.</div>', url, tooltipOptions);
        }
        currentlyProcessingUrl = null;
        return;
      }
      if (!response) {
        currentlyProcessingUrl = null;
        return;
      }
      if (response.status === 'complete') {
        const summary = response.summary || 'No summary generated';
        const formatted = formatAISummary(summary);
        showTooltip(anchorElement || linkElement, formatted, url, tooltipOptions);
        if (displayMode === 'sidepanel' || displayMode === 'both') {
          chrome.runtime.sendMessage({
            action: 'DISPLAY_CACHED_SUMMARY',
            summary,
            url
          });
        }
        currentlyProcessingUrl = null;
        processingElement = null;
        return;
      }
      if (response.status === 'streaming') {
        return;
      }
      if (response.error) {
        const errorMsg = response.error === 'NO_CAPTIONS'
          ? 'No captions available for this video yet.'
          : `Error: ${response.error}`;
        if (displayMode === 'tooltip' || displayMode === 'both') {
          showTooltip(anchorElement || linkElement, `<div style="padding:10px;background:#fee;border-radius:8px;">${errorMsg}</div>`, url, tooltipOptions);
        }
        currentlyProcessingUrl = null;
        processingElement = null;
      }
    });
  }
  
})();
