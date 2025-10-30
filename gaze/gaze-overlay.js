(function() {
  'use strict';

  if (window.__gazeOverlayInitialized) {
    return;
  }
  window.__gazeOverlayInitialized = true;

  const OVERLAY_ID = 'gaze-calibration-overlay';
  const STYLE_ID = 'gaze-overlay-style';
  const POINTER_ID = 'gaze-pointer';
  const DEBUG_HUD_ID = 'gaze-debug-hud';
  const PREPARE_MS = 350;
  const SAMPLE_MS = 700;
  const BETWEEN_MS = 180;
  const RELATIVE_POINTS = [
    [0.12, 0.12], [0.5, 0.12], [0.88, 0.12],
    [0.12, 0.5], [0.5, 0.5], [0.88, 0.5],
    [0.12, 0.88], [0.5, 0.88], [0.88, 0.88]
  ];

  let overlay = null;
  let overlayContent = null;
  let overlayMessage = null;
  let currentCalibration = null;

  let debugHud = null;
  let pointerEl = null;
  let hudVisible = true;
  let pointerVisible = true;
  let statusPhase = 'ready';
  let statusNote = '';
  let lastPointTimestamp = 0;
  let fpsEMA = 0;
  let lastConfidence = null;
  let hasPointerPosition = false;
  let previewCanvas = null;
  let previewVisible = true;
  let sampleCount = 0;

  if (typeof window.__gazeNoseFallback !== 'boolean') {
    window.__gazeNoseFallback = false;
  }

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
      console.warn('[GazeOverlay] Failed to load overlay stylesheet, injecting fallback styles.', error);
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        #gaze-calibration-overlay { position: fixed; inset: 0; z-index: 2147483646; background: rgba(10, 12, 24, 0.55); }
        #gaze-calibration-overlay.gaze-overlay-visible { display: flex; align-items: center; justify-content: center; }
        .gaze-calibration-dot { position: absolute; width: 18px; height: 18px; margin-left: -9px; margin-top: -9px; border-radius: 50%; background: #5aa7ff; }
      `;
      document.head.appendChild(style);
    }
  }

  function ensureOverlay() {
    if (overlay) {
      return overlay;
    }
    injectStyles();
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.tabIndex = -1;
    overlay.setAttribute('aria-hidden', 'true');

    overlayContent = document.createElement('div');
    overlayContent.className = 'gaze-overlay-content';

    overlayMessage = document.createElement('div');
    overlayMessage.className = 'gaze-overlay-message';
    overlayMessage.textContent = 'Look at the highlighted dot until it fades';

    overlayContent.appendChild(overlayMessage);
    overlay.appendChild(overlayContent);
    document.body.appendChild(overlay);
    return overlay;
  }

  function ensurePreviewCanvas() {
    injectStyles();
    if (!previewCanvas) {
      previewCanvas = document.createElement('canvas');
      previewCanvas.id = 'gaze-cam';
      previewCanvas.width = 320;
      previewCanvas.height = 240;
      previewCanvas.style.display = previewVisible ? 'block' : 'none';
      document.documentElement.appendChild(previewCanvas);
      console.debug('[GazeOverlay] Preview canvas mounted');
    }
    return previewCanvas;
  }

  function setPreviewVisible(visible) {
    previewVisible = Boolean(visible);
    const canvas = ensurePreviewCanvas();
    canvas.style.display = previewVisible ? 'block' : 'none';
    window.dispatchEvent(new CustomEvent('gaze:preview-toggle', {
      detail: { on: previewVisible }
    }));
    refreshDebugHud();
    window.dispatchEvent(new CustomEvent('gaze:preview-toggle', {
      detail: { on: previewVisible }
    }));
  }

  function ensureDebugElements() {
    injectStyles();
    if (!debugHud) {
      debugHud = document.createElement('div');
      debugHud.id = DEBUG_HUD_ID;
      debugHud.style.display = hudVisible ? 'block' : 'none';
      document.documentElement.appendChild(debugHud);
      refreshDebugHud();
    }
    if (!pointerEl) {
      pointerEl = document.createElement('div');
      pointerEl.id = POINTER_ID;
      pointerEl.style.display = 'none';
      document.documentElement.appendChild(pointerEl);
    }
    ensurePreviewCanvas();
  }

  function setHudVisible(visible) {
    hudVisible = Boolean(visible);
    ensureDebugElements();
    debugHud.style.display = hudVisible ? 'block' : 'none';
    if (hudVisible) {
      refreshDebugHud();
    }
  }

  function setPointerVisible(visible) {
    pointerVisible = Boolean(visible);
    ensureDebugElements();
    pointerEl.style.display = (pointerVisible && hasPointerPosition) ? 'block' : 'none';
  }

  function refreshDebugHud() {
    if (!debugHud || !hudVisible) {
      return;
    }
    const parts = [`Gaze: ${statusPhase}`];
    if (statusNote) {
      parts.push(statusNote);
    }
    if (fpsEMA) {
      parts.push(`${Math.round(fpsEMA)} fps`);
    }
    if (typeof lastConfidence === 'number') {
      parts.push(`conf=${lastConfidence.toFixed(2)}`);
    }
    debugHud.textContent = parts.join(' · ');
  }

  function createAbortToken() {
    const handlers = [];
    return {
      aborted: false,
      onAbort(callback) {
        if (this.aborted) {
          callback();
          return;
        }
        handlers.push(callback);
      },
      abort() {
        if (this.aborted) {
          return;
        }
        this.aborted = true;
        while (handlers.length) {
          const cb = handlers.shift();
          try {
            cb();
          } catch (error) {
            console.warn('[GazeOverlay] Abort callback failed:', error);
          }
        }
      }
    };
  }

  function delay(ms, token) {
    if (token && token.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, ms);
      if (token) {
        token.onAbort(() => {
          clearTimeout(timer);
          resolve();
        });
      }
    });
  }

  async function presentDot(point, token) {
    if (!overlayContent) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const x = Math.round(point[0] * width);
    const y = Math.round(point[1] * height);

    const dot = document.createElement('div');
    dot.className = 'gaze-calibration-dot';
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
    overlayContent.appendChild(dot);

    await delay(PREPARE_MS, token);
    if (token && token.aborted) {
      dot.remove();
      return;
    }

    dot.classList.add('gaze-calibration-active');
    window.dispatchEvent(new CustomEvent('gaze:calibrate-sample', {
      detail: {
        target: [x, y],
        capture: true
      }
    }));

    await delay(SAMPLE_MS, token);

    window.dispatchEvent(new CustomEvent('gaze:calibrate-sample', {
      detail: {
        target: [x, y],
        capture: false
      }
    }));

    dot.classList.remove('gaze-calibration-active');
    dot.remove();
    await delay(BETWEEN_MS, token);
  }

  async function runCalibration(token) {
    ensureOverlay();
    ensureDebugElements();
    overlay.classList.add('gaze-overlay-visible');
    overlay.setAttribute('aria-hidden', 'false');
    overlay.focus({ preventScroll: true });
    overlayMessage.textContent = 'Follow each dot with your gaze';

    window.dispatchEvent(new CustomEvent('gaze:calibrate-start'));

    for (let i = 0; i < RELATIVE_POINTS.length; i += 1) {
      if (token.aborted) {
        break;
      }
      overlayMessage.textContent = `Calibration ${i + 1} / ${RELATIVE_POINTS.length}`;
      await presentDot(RELATIVE_POINTS[i], token);
    }

    window.dispatchEvent(new CustomEvent('gaze:calibrate-end', {
      detail: { aborted: token.aborted }
    }));

    overlayMessage.textContent = token.aborted ? 'Calibration cancelled' : 'Calibration finished';
    await delay(450, token);
    overlay.classList.remove('gaze-overlay-visible');
    overlay.setAttribute('aria-hidden', 'true');
  }

  function setGazeEnabled(enabled) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ gazeEnabled: enabled }, () => resolve());
      } catch (error) {
        console.warn('[GazeOverlay] Failed to update gazeEnabled flag:', error);
        resolve();
      }
    });
  }

  function cancelCalibration() {
    if (!currentCalibration) {
      return;
    }
    currentCalibration.abort();
    currentCalibration = null;
  }

  async function startCalibration() {
    if (currentCalibration) {
      cancelCalibration();
      return;
    }
    ensureOverlay();
    ensureDebugElements();
    const token = createAbortToken();
    currentCalibration = token;
    try {
      await setGazeEnabled(true);
      await runCalibration(token);
    } catch (error) {
      console.warn('[GazeOverlay] Calibration failed:', error);
    } finally {
      token.abort();
      currentCalibration = null;
    }
  }

  function handleKeydown(event) {
    if (event.defaultPrevented) return;
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const code = event.code || event.key;
      if (code === 'KeyG') {
        event.preventDefault();
        startCalibration();
        return;
      }
      if (code === 'KeyH') {
        event.preventDefault();
        setHudVisible(!hudVisible);
        return;
      }
      if (code === 'KeyP') {
        event.preventDefault();
        setPointerVisible(!pointerVisible);
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
        window.__gazeNoseFallback = !window.__gazeNoseFallback;
        statusPhase = 'live';
        statusNote = window.__gazeNoseFallback ? 'nose-pointer' : 'iris';
        refreshDebugHud();
        window.dispatchEvent(new CustomEvent('gaze:status', {
          detail: {
            phase: 'live',
            note: window.__gazeNoseFallback ? 'nose-pointer' : 'iris'
          }
        }));
        console.debug('[GazeOverlay] Nose fallback', window.__gazeNoseFallback ? 'ENABLED' : 'DISABLED');
        return;
      }
    }
    if (event.key === 'Escape' && currentCalibration) {
      event.preventDefault();
      cancelCalibration();
    }
  }

  function handleStatus(event) {
    const detail = event.detail || {};
    if (detail.phase) {
      statusPhase = detail.phase;
    } else if (!statusPhase) {
      statusPhase = 'ready';
    }
    if (Object.prototype.hasOwnProperty.call(detail, 'note')) {
      statusNote = detail.note || '';
    }
    if (statusPhase !== 'live') {
      hasPointerPosition = false;
      if (pointerEl) {
        pointerEl.style.display = 'none';
      }
    } else if (pointerEl) {
      pointerEl.style.display = (pointerVisible && hasPointerPosition) ? 'block' : 'none';
    }
    refreshDebugHud();
  }

  function handlePoint(event) {
    if (!event || !event.detail) return;
    ensureDebugElements();
    const { x, y, conf, ts } = event.detail;
    if (typeof x !== 'number' || typeof y !== 'number') {
      return;
    }
    const now = typeof ts === 'number' ? ts : performance.now();
    if (lastPointTimestamp) {
      const dt = Math.max(1, now - lastPointTimestamp);
      const instantaneous = 1000 / dt;
      fpsEMA = fpsEMA ? (fpsEMA * 0.8 + instantaneous * 0.2) : instantaneous;
    }
    lastPointTimestamp = now;
    if (typeof conf === 'number') {
      lastConfidence = conf;
    }
    hasPointerPosition = true;
    if (pointerEl) {
      pointerEl.style.display = (pointerVisible && hasPointerPosition) ? 'block' : 'none';
      pointerEl.style.left = `${Math.round(x)}px`;
      pointerEl.style.top = `${Math.round(y)}px`;
    }
    refreshDebugHud();
  }

  function handleFeatures(event) {
    if (!window.__gazeCalibrating) {
      return;
    }
    sampleCount += 1;
    statusPhase = 'calibrating';
    statusNote = `${sampleCount} samples`;
    refreshDebugHud();
  }

  function handleCalibrateStartEvent() {
    sampleCount = 0;
    statusPhase = 'calibrating';
    statusNote = '0 samples';
    refreshDebugHud();
  }

  function handleCalibrateEndEvent() {
    console.debug('[GazeOverlay] Total calibration samples:', sampleCount);
    statusPhase = 'calibrating';
    statusNote = `samples: ${sampleCount}`;
    refreshDebugHud();
  }

  document.addEventListener('keydown', handleKeydown, true);
  window.addEventListener('gaze:status', handleStatus);
  window.addEventListener('gaze:point', handlePoint);
  window.addEventListener('gaze:features', handleFeatures);
  window.addEventListener('gaze:calibrate-start', handleCalibrateStartEvent);
  window.addEventListener('gaze:calibrate-end', handleCalibrateEndEvent);

  ensureOverlay();
  ensureDebugElements();
  refreshDebugHud();
})();
