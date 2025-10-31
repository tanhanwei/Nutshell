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
  const EDGE_PAD_PX = 180;
  const EDGE_HOLD_MS = 400;
  const MAX_LINK_SCAN = 500;
  const DEADZONE_PX = 12;
  const STICKY_RADIUS_PX = 45;
  const SCROLL_ZONE_ID = 'gaze-scroll-zones';
  const DWELL_INDICATOR_ID = 'gaze-dwell-indicator';

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
  let lastPointerX = 0;
  let lastPointerY = 0;
  let effectiveX = null;
  let effectiveY = null;
  let snappedLink = null;
  let lastSnapLink = null;
  let scrollZones = null;
  let dwellIndicator = null;
  const edgeHold = {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0
  };

  const processingMessage = '<div style="opacity:0.6;font-style:italic;">Generating summary...</div>';

  function ensureScrollZones() {
    if (scrollZones) {
      return scrollZones;
    }
    scrollZones = document.createElement('div');
    scrollZones.id = SCROLL_ZONE_ID;
    scrollZones.style.cssText = `
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483645;
    `;

    const topZone = document.createElement('div');
    topZone.id = 'gaze-scroll-top';
    topZone.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: ${EDGE_PAD_PX}px;
      background: linear-gradient(180deg, rgba(59, 130, 246, 0.15) 0%, rgba(59, 130, 246, 0) 100%);
      border-bottom: 1px solid rgba(59, 130, 246, 0.3);
      opacity: 0;
      transition: opacity 0.2s ease;
    `;

    const bottomZone = document.createElement('div');
    bottomZone.id = 'gaze-scroll-bottom';
    bottomZone.style.cssText = `
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: ${EDGE_PAD_PX}px;
      background: linear-gradient(0deg, rgba(34, 197, 94, 0.15) 0%, rgba(34, 197, 94, 0) 100%);
      border-top: 1px solid rgba(34, 197, 94, 0.3);
      opacity: 0;
      transition: opacity 0.2s ease;
    `;

    scrollZones.appendChild(topZone);
    scrollZones.appendChild(bottomZone);
    document.body.appendChild(scrollZones);
    return scrollZones;
  }

  function updateScrollZoneVisibility(topIntensity, bottomIntensity) {
    if (!scrollZones) return;
    const topZone = document.getElementById('gaze-scroll-top');
    const bottomZone = document.getElementById('gaze-scroll-bottom');
    if (topZone) {
      topZone.style.opacity = topIntensity > 0.5 ? String(Math.min(1, topIntensity)) : '0';
    }
    if (bottomZone) {
      bottomZone.style.opacity = bottomIntensity > 0.5 ? String(Math.min(1, bottomIntensity)) : '0';
    }
  }

  function ensureDwellIndicator() {
    if (dwellIndicator) {
      return dwellIndicator;
    }
    dwellIndicator = document.createElement('div');
    dwellIndicator.id = DWELL_INDICATOR_ID;
    dwellIndicator.style.cssText = `
      position: fixed;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: rgba(59, 130, 246, 0.8);
      box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.6);
      pointer-events: none;
      z-index: 2147483646;
      display: none;
      transition: box-shadow 0.1s ease-out;
    `;
    document.body.appendChild(dwellIndicator);
    return dwellIndicator;
  }

  function updateDwellIndicator(link, progress) {
    const indicator = ensureDwellIndicator();
    if (!link || progress <= 0) {
      indicator.style.display = 'none';
      return;
    }
    const rect = link.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    indicator.style.display = 'block';
    indicator.style.left = `${centerX - 4}px`;
    indicator.style.top = `${centerY - 4}px`;

    const ringSize = Math.round(progress * 20);
    indicator.style.boxShadow = `0 0 0 ${ringSize}px rgba(59, 130, 246, ${0.4 * (1 - progress)})`;
  }

  function hideDwellIndicator() {
    if (dwellIndicator) {
      dwellIndicator.style.display = 'none';
    }
  }

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
      snappedLink = null;
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

  function beep(frequency = 440, duration = 120) {
    try {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) return;
      const ctx = new AudioContextCtor();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration / 1000);
      osc.start(now);
      osc.stop(now + duration / 1000 + 0.05);
      osc.onended = () => ctx.close();
    } catch (error) {
      // ignore audio errors
    }
  }

  function nearestLink(x, y, maxDistance = 42) {
    const baseElement = document.elementFromPoint(x, y);
    const immediate = baseElement ? baseElement.closest('a,[role="link"]') : null;
    if (immediate) {
      return immediate;
    }
    const anchors = document.querySelectorAll('a,[role="link"]');
    let best = null;
    let bestDistance = maxDistance;
    let count = 0;
    for (const candidate of anchors) {
      if (count++ > MAX_LINK_SCAN) break;
      const rect = candidate.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) {
        continue;
      }
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = Math.hypot(cx - x, cy - y);
      if (dist < bestDistance) {
        bestDistance = dist;
        best = candidate;
      }
    }
    return best;
  }

  function applyDeadzone(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { x, y };
    }
    if (effectiveX === null || effectiveY === null) {
      effectiveX = x;
      effectiveY = y;
      return { x, y };
    }
    const dist = Math.hypot(x - effectiveX, y - effectiveY);
    if (dist < DEADZONE_PX) {
      return { x: effectiveX, y: effectiveY };
    }
    effectiveX = x;
    effectiveY = y;
    return { x, y };
  }

  function snapLink(x, y) {
    if (snappedLink && (!document.contains(snappedLink))) {
      snappedLink = null;
    }
    if (snappedLink) {
      const rect = snappedLink.getBoundingClientRect();
      if (rect && rect.width && rect.height) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        if (Math.hypot(cx - x, cy - y) < STICKY_RADIUS_PX) {
          return snappedLink;
        }
      }
      snappedLink = null;
    }
    const next = nearestLink(x, y, 42);
    if (next) {
      snappedLink = next;
      lastSnapLink = next;
    }
    return snappedLink;
  }

  function edgeLoop(x, y) {
    const now = performance.now();
    const w = window.innerWidth;
    const h = window.innerHeight;
    const topIntensity = y < EDGE_PAD_PX ? 1 - (y / EDGE_PAD_PX) : 0;
    const bottomIntensity = y > h - EDGE_PAD_PX ? (y - (h - EDGE_PAD_PX)) / EDGE_PAD_PX : 0;
    const leftIntensity = x < EDGE_PAD_PX ? 1 - (x / EDGE_PAD_PX) : 0;
    const rightIntensity = x > w - EDGE_PAD_PX ? (x - (w - EDGE_PAD_PX)) / EDGE_PAD_PX : 0;

    const intents = {
      top: topIntensity,
      bottom: bottomIntensity,
      left: leftIntensity,
      right: rightIntensity
    };

    for (const key of Object.keys(intents)) {
      const intensity = intents[key];
      if (intensity > 0.65) {
        if (!edgeHold[key]) {
          edgeHold[key] = now;
        } else if (now - edgeHold[key] > EDGE_HOLD_MS) {
          if (key === 'top') {
            window.scrollBy({ top: -(120 + 360 * intensity), behavior: 'smooth' });
            beep(520, 120);
          } else if (key === 'bottom') {
            window.scrollBy({ top: 120 + 360 * intensity, behavior: 'smooth' });
            beep(420, 120);
          }
          edgeHold[key] = now;
        }
      } else {
        edgeHold[key] = 0;
      }
    }

    updateScrollZoneVisibility(topIntensity, bottomIntensity);
  }

  function synthClick(target, button = 0) {
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const clientX = clamp(lastPointerX, rect.left, rect.right);
    const clientY = clamp(lastPointerY, rect.top, rect.bottom);
    if (typeof target.focus === 'function') {
      try {
        target.focus({ preventScroll: true });
      } catch (error) {
        // ignore focus errors
      }
    }
    const downInit = {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button,
      buttons: button === 2 ? 2 : 1
    };
    const upInit = {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button,
      buttons: 0
    };

    ['pointerover', 'pointerenter', 'mousemove', 'pointerdown', 'mousedown'].forEach((type) => {
      target.dispatchEvent(new MouseEvent(type, downInit));
    });
    ['mouseup', 'pointerup', 'click'].forEach((type) => {
      target.dispatchEvent(new MouseEvent(type, upInit));
    });
    if (button === 2) {
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: 2
      }));
    }
  }

  function handlePointEvent(event) {
    if (!gazeEnabled || phase !== 'live') {
      return;
    }
    const detail = event.detail || {};
    if (!Number.isFinite(detail.x) || !Number.isFinite(detail.y)) {
      return;
    }
    const rawX = clamp(detail.x, 0, window.innerWidth - 1);
    const rawY = clamp(detail.y, 0, window.innerHeight - 1);
    lastPointerX = rawX;
    lastPointerY = rawY;
    edgeLoop(rawX, rawY);

    const { x, y } = applyDeadzone(rawX, rawY);

    const ts = typeof detail.ts === 'number' ? detail.ts : performance.now();
    const delta = Math.max(0, Math.min(500, ts - lastPointTs));
    lastPointTs = ts;

    const link = snapLink(x, y);
    if (link) {
      lastSnapLink = link;
    } else {
      lastSnapLink = null;
    }

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
      hideDwellIndicator();
    }

    if (!link) {
      hideDwellIndicator();
      return;
    }

    dwellAccum += delta;
    const progress = Math.min(1, dwellAccum / dwellThreshold);
    updateDwellIndicator(link, progress);

    if (dwellAccum >= dwellThreshold) {
      dwellAccum = 0;
      hideDwellIndicator();
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

  window.addEventListener('blink:click', (event) => {
    const button = event && event.detail && event.detail.button === 'right' ? 2 : 0;
    const target = lastSnapLink || nearestLink(lastPointerX, lastPointerY) || document.elementFromPoint(lastPointerX, lastPointerY);
    if (!target) {
      beep(280, 140);
      return;
    }
    synthClick(target, button);
    beep(button === 2 ? 320 : 560, 150);
  });

  function init() {
    ensureTooltipStyles();
    ensureScrollZones();
    window.addEventListener(POINT_EVENT, handlePointEvent);
    window.addEventListener(STATUS_EVENT, (event) => {
      const detail = event.detail || {};
      phase = detail.phase || phase;
      if (phase !== 'live') {
        dwellAccum = 0;
      }
    });
    window.addEventListener('gaze:calibration-started', () => {
      // Forcibly hide tooltip during calibration (both active and completed)
      cancelActiveJob('calibration_started');
      hideTooltip();
      console.debug('[GazeDwell] Tooltip forcibly hidden for calibration');
    });
    window.addEventListener('gaze:calibration-stopped', () => {
      // Tooltip will naturally reappear when user looks at links
      console.debug('[GazeDwell] Calibration ended, tooltip can reappear');
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
