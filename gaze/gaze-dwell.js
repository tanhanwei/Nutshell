(function() {
  'use strict';

  const POINT_EVENT = 'gaze:point';
  const STATUS_EVENT = 'gaze:status';
  const TOOLTIP_ID = 'gaze-summary-tooltip';
  const TOOLTIP_STYLE_ID = 'gaze-summary-tooltip-styles';
  const DEBUG_DWELL = true;
  const DEFAULT_DWELL_MS = 600;
  const RECENT_WINDOW_MS = 20000;
  const MAX_RECENT_ENTRIES = 32;

  let gazeEnabled = false;
  let dwellThreshold = DEFAULT_DWELL_MS;
  let phase = 'ready';
  let tooltip = null;
  let currentJob = null;
  let dwellTarget = null;
  let dwellAccum = 0;
  let lastPointTs = performance.now();
  let recentSummaries = new Map();
  let requestSeq = 0;
  let debugLastHref = null;

  const processingMessage = '<div style="opacity:0.6;font-style:italic;">Generating summary...</div>';

  function ensureTooltipStyles() {
    if (document.getElementById(TOOLTIP_STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = TOOLTIP_STYLE_ID;
    style.textContent = `
      #${TOOLTIP_ID} {
        position: fixed;
        z-index: 2147483647;
        background: #ffffff;
        border-radius: 12px;
        box-shadow: 0 12px 48px rgba(15, 18, 32, 0.22);
        padding: 16px;
        max-width: 420px;
        max-height: 520px;
        overflow-y: auto;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        line-height: 1.6;
        color: #1a1a1a;
        display: none;
        opacity: 0;
        transition: opacity 0.2s ease;
        pointer-events: auto;
        user-select: text;
      }
      #${TOOLTIP_ID} ul {
        margin: 12px 0;
        padding-left: 22px;
        list-style: disc;
      }
      #${TOOLTIP_ID} li {
        margin-bottom: 8px;
      }
      #${TOOLTIP_ID} h2,
      #${TOOLTIP_ID} h3,
      #${TOOLTIP_ID} h4 {
        margin: 12px 0 8px;
        font-weight: 600;
        color: #111827;
      }
      #${TOOLTIP_ID} strong { font-weight: 600; }
      #${TOOLTIP_ID} em { font-style: italic; }
    `;
    document.head.appendChild(style);
  }

  function ensureTooltip() {
    if (tooltip) {
      return tooltip;
    }
    ensureTooltipStyles();
    tooltip = document.createElement('div');
    tooltip.id = TOOLTIP_ID;
    tooltip.addEventListener('mouseenter', () => {
      dwellAccum = 0;
    });
    document.body.appendChild(tooltip);
    return tooltip;
  }

  function showTooltipForLink(link, html) {
    if (!link) {
      return;
    }
    const tip = ensureTooltip();
    tip.innerHTML = html;
    tip.style.display = 'block';
    tip.style.opacity = '0';
    positionTooltip(link);
    requestAnimationFrame(() => {
      tip.style.opacity = '1';
    });
  }

  function hideTooltip() {
    if (!tooltip) return;
    tooltip.style.opacity = '0';
    setTimeout(() => {
      if (tooltip) {
        tooltip.style.display = 'none';
        tooltip.innerHTML = '';
      }
    }, 180);
  }

  function positionTooltip(link) {
    if (!tooltip || !link) return;
    const rect = link.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 14;
    let top = rect.bottom + margin;
    let left = rect.left;
    const tipRect = tooltip.getBoundingClientRect();
    if (top + tipRect.height > viewportHeight - margin) {
      top = rect.top - tipRect.height - margin;
      if (top < margin) {
        top = Math.max(margin, (viewportHeight - tipRect.height) / 2);
      }
    }
    if (left + tipRect.width > viewportWidth - margin) {
      left = viewportWidth - tipRect.width - margin;
    }
    if (left < margin) {
      left = margin;
    }
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }

  function findLink(element) {
    let node = element;
    for (let i = 0; i < 6 && node; i += 1) {
      if (node.tagName === 'A' && node.href) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function cleanRecentSummaries() {
    if (recentSummaries.size <= MAX_RECENT_ENTRIES) {
      return;
    }
    const threshold = Date.now() - RECENT_WINDOW_MS;
    recentSummaries = new Map(Array.from(recentSummaries.entries()).filter(([_, ts]) => ts >= threshold));
  }

  function shouldSkipUrl(url) {
    const lastTs = recentSummaries.get(url);
    if (!lastTs) return false;
    return (Date.now() - lastTs) < RECENT_WINDOW_MS;
  }

  function updateRecent(url) {
    recentSummaries.set(url, Date.now());
    cleanRecentSummaries();
  }

  function handlePointEvent(event) {
    if (!gazeEnabled || phase !== 'live') {
      return;
    }
    const detail = event.detail || {};
    const x = clamp(detail.x, 0, window.innerWidth - 1);
    const y = clamp(detail.y, 0, window.innerHeight - 1);
    const ts = typeof detail.ts === 'number' ? detail.ts : performance.now();
    const delta = Math.max(0, Math.min(500, ts - lastPointTs));
    lastPointTs = ts;

    const targetElement = document.elementFromPoint(x, y);
    const link = targetElement ? findLink(targetElement) : null;
    if (DEBUG_DWELL) {
      const href = link && link.href ? link.href : null;
      if (href !== debugLastHref) {
        console.debug('[GazeDwell] target:', href);
        debugLastHref = href;
      }
    }

    if (link !== dwellTarget) {
      dwellTarget = link;
      dwellAccum = 0;
      if (!link) {
        return;
      }
    }

    if (!link) {
      return;
    }

    dwellAccum += delta;
    if (dwellAccum >= dwellThreshold) {
      dwellAccum = 0;
      triggerSummary(link);
    }
  }

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }

  function triggerSummary(link) {
    if (!link || !link.href) {
      return;
    }
    const url = normalizeUrl(link.href);
    if (!url) {
      return;
    }
    if (currentJob && currentJob.url === url) {
      return;
    }
    if (shouldSkipUrl(url)) {
      return;
    }

    updateRecent(url);
    cancelActiveJob('replaced_by_new_link');

    requestSeq += 1;
    const requestId = requestSeq;
    const host = safeHostname(url);
    const isYouTube = isYouTubeUrl(host);
    const videoId = isYouTube ? extractYouTubeVideoId(url) : null;

    currentJob = {
      id: requestId,
      url,
      element: link,
      type: isYouTube ? 'youtube' : 'page',
      videoId,
      startedAt: Date.now()
    };

    showTooltipForLink(link, processingMessage);

    if (isYouTube && videoId) {
      handleYouTubeSummary(url, videoId, requestId);
      return;
    }

    handlePageSummary(url, link, requestId).catch((error) => {
      console.error('[GazeDwell] Summary failed:', error);
      if (currentJob && currentJob.id === requestId) {
        renderError('Unable to summarize this page.');
        clearCurrentJob();
      }
    });
  }

  function cancelActiveJob(reason) {
    if (!currentJob) {
      return;
    }
    if (currentJob.type === 'youtube' && currentJob.videoId) {
      try {
        chrome.runtime.sendMessage({
          action: 'ABORT_YOUTUBE_SUMMARY',
          videoId: currentJob.videoId,
          reason
        });
      } catch (error) {
        console.warn('[GazeDwell] Failed to send abort message:', error);
      }
    }
    currentJob = null;
    hideTooltip();
  }

  async function handleYouTubeSummary(url, videoId, requestId) {
    try {
      const response = await sendMessagePromise({
        action: 'GET_YOUTUBE_SUMMARY',
        videoId,
        url
      });
      if (!currentJob || currentJob.id !== requestId) {
        return;
      }
      if (!response) {
        renderError('No response from background.');
        clearCurrentJob();
        return;
      }
      if (response.status === 'complete' && response.summary) {
        renderFinalSummary(response.summary);
        clearCurrentJob();
        return;
      }
      if (response.status === 'aborted') {
        renderError('Summary cancelled.');
        clearCurrentJob();
        return;
      }
      if (response.status === 'error') {
        const message = response.message || response.error || 'Summary failed.';
        renderError(message);
        clearCurrentJob();
        return;
      }
    } catch (error) {
      if (currentJob && currentJob.id === requestId) {
        renderError(error && error.message ? error.message : 'Summary failed.');
        clearCurrentJob();
      }
    }
  }

  async function handlePageSummary(url, link, requestId) {
    const fetchResponse = await sendMessagePromise({ type: 'FETCH_CONTENT', url });
    if (currentJob && currentJob.id !== requestId) {
      return;
    }
    if (!fetchResponse || fetchResponse.error) {
      const message = fetchResponse && fetchResponse.error ? fetchResponse.error : 'Unable to fetch page content.';
      renderError(message);
      clearCurrentJob();
      return;
    }

    const { title, textContent } = extractContent(fetchResponse.html, url, link);
    renderProcessing();

    const summaryResponse = await sendMessagePromise({
      type: 'SUMMARIZE_CONTENT',
      url,
      title,
      textContent
    });

    if (!currentJob || currentJob.id !== requestId) {
      return;
    }

    if (!summaryResponse || summaryResponse.status === 'error') {
      const message = summaryResponse && summaryResponse.error ? summaryResponse.error : 'Failed to summarize content.';
      renderError(message);
      clearCurrentJob();
      return;
    }

    if (summaryResponse.status === 'aborted') {
      renderError('Summary cancelled.');
      clearCurrentJob();
      return;
    }

    if (summaryResponse.status === 'complete' && summaryResponse.summary) {
      renderFinalSummary(summaryResponse.summary);
      clearCurrentJob();
      return;
    }

    renderError('Summary unavailable.');
    clearCurrentJob();
  }

  function renderProcessing() {
    if (currentJob) {
      showTooltipForLink(currentJob.element, processingMessage);
    }
  }

  function renderFinalSummary(summary) {
    if (!currentJob) return;
    const html = formatAISummary(summary || '');
    showTooltipForLink(currentJob.element, html);
  }

  function renderStreamUpdate(html) {
    if (!currentJob) return;
    showTooltipForLink(currentJob.element, html);
  }

  function renderError(message) {
    if (!currentJob) return;
    const safe = escapeHtml(message || 'Something went wrong.');
    const html = `<div style="padding:12px 14px;background:#fee2e2;border-radius:10px;color:#b91c1c;">${safe}</div>`;
    showTooltipForLink(currentJob.element, html);
  }

  function clearCurrentJob() {
    currentJob = null;
  }

  function extractContent(html, url, link) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const clone = doc.cloneNode(true);
    let title = doc.title || link.textContent || url;
    let textContent = '';

    try {
      // eslint-disable-next-line no-undef
      const reader = new Readability(clone);
      const article = reader.parse();
      if (article && article.textContent && article.textContent.trim().length > 120) {
        title = article.title || title;
        textContent = article.textContent;
      }
    } catch (error) {
      console.warn('[GazeDwell] Readability parse failed:', error);
    }

    if (!textContent || textContent.trim().length < 80) {
      const fallback = doc.querySelector('meta[name="description"]')?.getAttribute('content') ||
        doc.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
      textContent = fallback || link.textContent || 'No extractable content available.';
    }

    return { title, textContent };
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function normalizeUrl(url) {
    try {
      return new URL(url, window.location.href).toString();
    } catch (error) {
      return null;
    }
  }

  function safeHostname(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (error) {
      return '';
    }
  }

  function isYouTubeUrl(hostname) {
    if (!hostname) return false;
    return hostname.includes('youtube.com') || hostname === 'youtu.be' || hostname.endsWith('.youtu.be');
  }

  function extractYouTubeVideoId(url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'youtu.be' || parsed.hostname.endsWith('.youtu.be')) {
        const segments = parsed.pathname.split('/').filter(Boolean);
        return segments[0] || null;
      }
      if (parsed.searchParams.has('v')) {
        return parsed.searchParams.get('v');
      }
      if (parsed.pathname.startsWith('/shorts/')) {
        const parts = parsed.pathname.split('/').filter(Boolean);
        return parts[1] || parts[0] || null;
      }
      if (parsed.pathname.startsWith('/live/')) {
        const parts = parsed.pathname.split('/').filter(Boolean);
        return parts[1] || parts[0] || null;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  function sendMessagePromise(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message || 'Unknown runtime error'));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function handleRuntimeMessage(message) {
    if (!currentJob) {
      return;
    }
    if (message.type === 'STREAMING_UPDATE') {
      if (message.url && message.url === currentJob.url) {
        renderStreamUpdate(message.content);
      }
    }
    if (message.type === 'PROCESSING_STATUS') {
      if (message.url && currentJob && message.url === currentJob.url && message.status === 'started') {
        renderProcessing();
      }
    }
  }

  function handleStorageChange(changes, area) {
    if (area !== 'local') return;
    if (changes.gazeEnabled) {
      gazeEnabled = Boolean(changes.gazeEnabled.newValue);
      if (!gazeEnabled) {
        cancelActiveJob('feature_disabled');
      }
    }
    if (changes.gazeDwellMs) {
      const value = changes.gazeDwellMs.newValue;
      if (typeof value === 'number' && value >= 200) {
        dwellThreshold = value;
      }
    }
  }

  function handleKeydown(event) {
    if (event.key === 'Escape' && currentJob) {
      event.preventDefault();
      cancelActiveJob('user_cancelled');
    }
  }

  function handleScroll() {
    if (currentJob && currentJob.element) {
      positionTooltip(currentJob.element);
    }
  }

  function init() {
    ensureTooltipStyles();
    window.addEventListener(POINT_EVENT, handlePointEvent);
    window.addEventListener(STATUS_EVENT, (event) => {
      const detail = event.detail || {};
      phase = detail.phase || phase;
      if (phase !== 'live') {
        dwellAccum = 0;
      }
    });
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    chrome.storage.onChanged.addListener(handleStorageChange);
    document.addEventListener('keydown', handleKeydown, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);

    chrome.storage.local.get(['gazeEnabled', 'gazeDwellMs'], (result) => {
      gazeEnabled = Boolean(result && result.gazeEnabled);
      const dwell = result && typeof result.gazeDwellMs === 'number' ? result.gazeDwellMs : DEFAULT_DWELL_MS;
      dwellThreshold = dwell >= 200 ? dwell : DEFAULT_DWELL_MS;
    });
  }

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
      .replace(/^[\*-•] (.+)$/gm, '<li>$1</li>');

    formatted = formatted
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    formatted = formatted
      .replace(/(<li>.*?<\/li>\n?)+/g, (match) => {
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

  init();
})();
