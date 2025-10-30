(function() {
  'use strict';

  if (window.__gazeOverlayInitialized) {
    return;
  }
  window.__gazeOverlayInitialized = true;

  const STYLE_ID = 'gaze-overlay-style';
  const POINTER_ID = 'gaze-pointer';
  const HUD_ID = 'gaze-debug-hud';
  const PREVIEW_ID = 'gaze-cam';

  let pointerEl = null;
  let hudEl = null;
  let previewCanvas = null;
  let hudVisible = true;
  let pointerVisible = true;
  let previewVisible = true;
  let statusPhase = 'loading';
  let statusNote = '';
  let lastPointTs = 0;
  let fpsEMA = 0;
  let lastConfidence = null;
  let hasPointerPosition = false;

  injectStyles();
  ensureElements();
  setPreviewVisible(true);

  document.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('gaze:status', handleStatus);
  window.addEventListener('gaze:point', handlePoint);

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    try {
      const url = chrome.runtime.getURL('gaze/gaze-overlay.css');
      const link = document.createElement('link');
      link.id = STYLE_ID;
      link.rel = 'stylesheet';
      link.href = url;
      document.documentElement.appendChild(link);
    } catch (error) {
      console.warn('[GazeOverlay] Failed to load stylesheet:', error);
    }
  }

  function ensureElements() {
    if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.id = HUD_ID;
      hudEl.style.display = hudVisible ? 'block' : 'none';
      hudEl.textContent = 'Gaze: loading';
      document.documentElement.appendChild(hudEl);
    }
    if (!pointerEl) {
      pointerEl = document.createElement('div');
      pointerEl.id = POINTER_ID;
      pointerEl.style.display = 'none';
      document.documentElement.appendChild(pointerEl);
    }
    if (!previewCanvas) {
      previewCanvas = document.createElement('canvas');
      previewCanvas.id = PREVIEW_ID;
      previewCanvas.width = 320;
      previewCanvas.height = 240;
      previewCanvas.style.display = previewVisible ? 'block' : 'none';
      document.documentElement.appendChild(previewCanvas);
      window.dispatchEvent(new CustomEvent('gaze:preview-toggle', { detail: { on: previewVisible } }));
    }
  }

  function setHudVisible(visible) {
    hudVisible = Boolean(visible);
    ensureElements();
    hudEl.style.display = hudVisible ? 'block' : 'none';
    if (hudVisible) {
      updateHud();
    }
  }

  function setPointerVisible(visible) {
    pointerVisible = Boolean(visible);
    ensureElements();
    pointerEl.style.display = (pointerVisible && hasPointerPosition) ? 'block' : 'none';
  }

  function setPreviewVisible(visible) {
    previewVisible = Boolean(visible);
    ensureElements();
    previewCanvas.style.display = previewVisible ? 'block' : 'none';
    window.dispatchEvent(new CustomEvent('gaze:preview-toggle', { detail: { on: previewVisible } }));
    updateHud();
  }

  function handleKeyDown(event) {
    if (event.defaultPrevented) return;
    const code = event.code || event.key;
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      if (code === 'KeyP') {
        event.preventDefault();
        setPointerVisible(!pointerVisible);
        console.debug('[GazeOverlay] Pointer', pointerVisible ? 'ON' : 'OFF');
        return;
      }
      if (code === 'KeyV') {
        event.preventDefault();
        setPreviewVisible(!previewVisible);
        console.debug('[GazeOverlay] Preview', previewVisible ? 'ON' : 'OFF');
        return;
      }
      if (code === 'KeyN') {
        event.preventDefault();
        window.__gazeHeadMode = !window.__gazeHeadMode;
        window.dispatchEvent(new CustomEvent('gaze:status', {
          detail: {
            phase: 'live',
            note: window.__gazeHeadMode ? 'head-pointer' : 'iris-pointer'
          }
        }));
        console.debug('[GazeOverlay] Head pointer mode', window.__gazeHeadMode ? 'ENABLED' : 'DISABLED');
        return;
      }
    }
    if (!event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (code === 'KeyH') {
        event.preventDefault();
        setHudVisible(!hudVisible);
        console.debug('[GazeOverlay] HUD', hudVisible ? 'ON' : 'OFF');
      }
    }
  }

  function handleStatus(event) {
    const detail = event && event.detail ? event.detail : {};
    if (detail.phase) {
      statusPhase = detail.phase;
    }
    if (Object.prototype.hasOwnProperty.call(detail, 'note')) {
      statusNote = detail.note || '';
    }
    updateHud();
  }

  function handlePoint(event) {
    if (!event || !event.detail) return;
    const { x, y, conf, ts } = event.detail;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    ensureElements();

    hasPointerPosition = true;
    if (pointerVisible && pointerEl) {
      pointerEl.style.display = 'block';
      pointerEl.style.left = `${Math.round(x)}px`;
      pointerEl.style.top = `${Math.round(y)}px`;
    }

    if (typeof ts === 'number') {
      if (lastPointTs) {
        const dt = Math.max(1, ts - lastPointTs);
        const inst = 1000 / dt;
        fpsEMA = fpsEMA ? (fpsEMA * 0.8 + inst * 0.2) : inst;
      }
      lastPointTs = ts;
    } else if (lastPointTs) {
      const dt = Math.max(1, performance.now() - lastPointTs);
      const inst = 1000 / dt;
      fpsEMA = fpsEMA ? (fpsEMA * 0.8 + inst * 0.2) : inst;
      lastPointTs = performance.now();
    }

    if (typeof conf === 'number') {
      lastConfidence = conf;
    }

    updateHud();
  }

  function updateHud() {
    if (!hudEl || !hudVisible) {
      return;
    }
    const parts = [];
    if (statusPhase) {
      parts.push(`Gaze: ${statusPhase}`);
    }
    if (statusNote) {
      parts.push(statusNote);
    }
    if (previewVisible) {
      parts.push('preview on');
    }
    if (fpsEMA) {
      parts.push(`${Math.round(fpsEMA)} fps`);
    }
    if (typeof lastConfidence === 'number') {
      parts.push(`conf=${lastConfidence.toFixed(2)}`);
    }
    hudEl.textContent = parts.length ? parts.join(' · ') : 'Gaze: live';
  }

  ensureElements();
  updateHud();
})();
