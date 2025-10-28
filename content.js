(function() {
  'use strict';

  // --- CONFIGURATION & STATE ---
  const HOVER_DELAY = 300;
  const IS_YOUTUBE = window.location.hostname.includes('youtube.com');
  const COOLDOWN_PERIOD = 2000; // 2 seconds

  let tooltip = null;
  let currentHoverTimeout = null;
  let hideTimeout = null;
  let isMouseInTooltip = false;

  // The *only* state variables that now matter.
  let requestCounter = 0;
  let activeRequest = null; // { token, videoId, url, targetElement }
  let lastCompletedRequest = { videoId: null, timestamp: 0 };

  // --- DOM & UI ---

  function createTooltip() {
    if (tooltip && document.body.contains(tooltip)) {
      return tooltip;
    }

    tooltip = document.createElement('div');
    tooltip.id = 'hover-summary-tooltip';
    tooltip.style.cssText = `
      position: fixed; z-index: 2147483647; background: white; border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2), 0 2px 8px rgba(0,0,0,0.1);
      padding: 16px; max-width: 400px; width: 400px; max-height: 500px; overflow-y: auto;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px; line-height: 1.6; color: #1a1a1a; display: none;
      pointer-events: auto; opacity: 0; transition: opacity 0.2s ease;
      cursor: auto; user-select: text;
    `;
    // Corrected, isolated HTML structure to prevent overwriting the debug panel.
    tooltip.innerHTML = `
      <div id="summarizer-content"></div>
      <div id="summarizer-footer" style="padding-top: 8px; margin-top: 12px; border-top: 1px solid #eee; display: flex; justify-content: flex-end;">
        <button id="summarizer-inspect-btn" style="border:1px solid #ccc; background:#fff; border-radius:20px; padding:4px 12px; font-size:12px; cursor:pointer;">Inspect</button>
      </div>
      <div id="summarizer-debug-panel" style="display:none; margin-top:12px; border-top: 1px dashed #ccc; padding-top: 12px;">
        <h4 style="margin:0 0 8px; font-size:13px; font-weight:600;">Summary Input Data</h4>
        <pre id="summarizer-debug-content" style="white-space:pre-wrap;max-height:200px;overflow:auto;border:1px solid #eee;border-radius:8px;padding:8px;background:#f9f9f9;color:#333;font-size:11px;line-height:1.4;"></pre>
      </div>
    `;

    tooltip.addEventListener('mouseenter', () => { isMouseInTooltip = true; clearTimeout(hideTimeout); });
    tooltip.addEventListener('mouseleave', () => { isMouseInTooltip = false; scheduleHide(200); });
    tooltip.querySelector('#summarizer-inspect-btn').addEventListener('click', () => {
      const panel = tooltip.querySelector('#summarizer-debug-panel');
      if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    document.body.appendChild(tooltip);
    return tooltip;
  }

  function showTooltip(element, content) {
    const tooltipEl = createTooltip();
    tooltipEl.querySelector('#summarizer-content').innerHTML = content;
    tooltipEl.querySelector('#summarizer-debug-panel').style.display = 'none';
    tooltipEl.querySelector('#summarizer-debug-content').textContent = '';

    const rect = element.getBoundingClientRect();
    tooltipEl.style.display = 'block';
    
    let top = rect.bottom + 10;
    let left = rect.left;
    if (top + 300 > window.innerHeight) { // Approximate height
        top = rect.top - 300 - 10;
    }
     if (left + 400 > window.innerWidth) {
        left = window.innerWidth - 410;
    }
    tooltipEl.style.top = `${Math.max(10, top)}px`;
    tooltipEl.style.left = `${Math.max(10, left)}px`;
    
    requestAnimationFrame(() => { tooltipEl.style.opacity = '1'; });
  }

  function scheduleHide(delay) {
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      if (isMouseInTooltip) return;
      if (tooltip) tooltip.style.opacity = '0';
      setTimeout(() => { if (!isMouseInTooltip && tooltip) tooltip.style.display = 'none'; }, 200);
    }, delay);
  }

  // --- CORE LOGIC ---

  function startNewSummaryRequest(targetElement, url) {
    const videoId = getYouTubeVideoId(url);
    if (!videoId) return;

    // --- NEW GUARDS ---
    // 1. If a request is already active, do nothing. This is our primary debounce.
    if (activeRequest) return;
    // 2. If we just finished a summary for this video, enforce a cooldown.
    if (lastCompletedRequest.videoId === videoId && (Date.now() - lastCompletedRequest.timestamp < COOLDOWN_PERIOD)) {
      return;
    }

    const token = ++requestCounter;
    activeRequest = { token, videoId, url, targetElement };

    console.log(`[YouTube] STARTING request #${token} for video ${videoId}`);

    clearTimeout(hideTimeout);
    showTooltip(targetElement, '<div style="padding:16px;text-align:center;opacity:0.75;">Generating summary…</div>');

    chrome.runtime.sendMessage({
      action: 'GET_YOUTUBE_SUMMARY',
      videoId,
      url,
      requestToken: token
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    // This guard is now the single source of truth for message validation.
    if (!activeRequest || message.requestToken !== activeRequest.token) {
      return;
    }

    const tooltipEl = createTooltip();

    switch (message.type) {
      case 'start':
        const debugContent = tooltipEl.querySelector('#summarizer-debug-content');
        if (debugContent && message.debugInfo) {
          const info = message.debugInfo;
          debugContent.textContent = `Token: #${message.requestToken}\n`
                                   + `Video ID: ${info.videoId}\n`
                                   + `Caption Source: ${info.captionSource}\n`
                                   + `Caption Length: ${info.captionLength} chars\n`
                                   + `Description Length: ${info.descriptionLength} chars\n`
                                   + `Total Input Length: ${info.totalInputLength} chars\n\n`
                                   + `----- FINAL INPUT SENT TO SUMMARIZER -----\n${info.finalInputText}`;
        }
        break;

      case 'stream':
        const contentDivStream = tooltipEl.querySelector('#summarizer-content');
        if (contentDivStream) {
          contentDivStream.innerHTML = message.data;
        }
        break;

      case 'end':
        console.log(`[YouTube] FINISHED request #${activeRequest.token} with status: end`);
        // ** THE FIX **: Update the cooldown timer. Do NOT clear activeRequest here.
        lastCompletedRequest = { videoId: activeRequest.videoId, timestamp: Date.now() };
        // The tooltip stays visible until mouseout.
        break;

      case 'error':
        console.log(`[YouTube] FINISHED request #${activeRequest.token} with status: error`);
        const contentDivError = tooltipEl.querySelector('#summarizer-content');
        if (contentDivError) {
          contentDivError.innerHTML = `<div style="padding:12px;background:#fee;border-radius:8px;">Error: ${message.data || 'Failed to get summary.'}</div>`;
        }
        // Also apply cooldown on error to prevent hammering.
        lastCompletedRequest = { videoId: activeRequest.videoId, timestamp: Date.now() };
        break;
    }
  });

  // --- EVENT HANDLERS ---

  function handleMouseOver(e) {
    clearTimeout(currentHoverTimeout);
    const link = findLink(e.target);
    if (!link || !isYouTubeVideoLink(link.href)) return;

    currentHoverTimeout = setTimeout(() => {
      startNewSummaryRequest(link, link.href);
    }, HOVER_DELAY);
  }

  function handleMouseOut(e) {
    clearTimeout(currentHoverTimeout);

    // If mouse is moving to a child of the link, or to the tooltip, do nothing.
    const relatedTarget = e.relatedTarget;
    if (relatedTarget) {
      if (e.target.contains(relatedTarget) || (tooltip && tooltip.contains(relatedTarget))) {
        return;
      }
    }
    
    // ** THE FIX **: `mouseout` is now responsible for clearing state.
    if (activeRequest) {
      console.log(`[YouTube] Mouse Out: Clearing active request #${activeRequest.token}`);
      activeRequest = null;
    }

    scheduleHide(300);
  }

  // --- UTILITIES ---

  function findLink(element) {
    return element.closest('a[href]');
  }

  function isYouTubeVideoLink(url) {
    return url && url.includes('youtube.com/watch');
  }

  function getYouTubeVideoId(url) {
    try {
      return new URL(url).searchParams.get('v');
    } catch { return null; }
  }

  // --- INITIALIZATION ---
  if (IS_YOUTUBE) {
    document.body.addEventListener('mouseover', handleMouseOver);
    document.body.addEventListener('mouseout', handleMouseOut);
    console.log('[Content] YouTube Hover initialized with cooldown logic.');
  }
})();
