(function() {
  'use strict';

  const DWELL_THRESHOLD_MS = 750;
  const RETRIGGER_COOLDOWN_MS = 600;
  const STATUS_OK = 'var(--status-ok, #16a34a)';
  const STATUS_WARN = 'var(--status-warn, #dc2626)';
  const PREDICTION_BUFFER_SIZE = 14;
  const PREDICTION_BUFFER_WINDOW_MS = 450;
  const MIN_STABLE_ANCHOR_HITS = 4;
  const ANCHOR_DRIFT_THRESHOLD_PX = 68;
  const RECT_PADDING_PX = 14;
  const CALIBRATION_SAMPLE_WINDOW_MS = 420;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  const state = {
    webgazerReady: false,
    calibrationMode: false,
    calibrationOverlay: null,
    calibrationConfig: {
      stage: 'primary',
      points: [],
      clicksPerPoint: 3,
      counts: new Map(),
      completed: false,
      primaryComplete: false
    },
    hoverActive: false,
    smoothX: null,
    smoothY: null,
    dwellAnchor: null,
    dwellStart: 0,
    lastTriggerByNode: new WeakMap(),
    activeUrl: null,
    activeToken: 0,
    summaryCache: new Map(),
    tooltipEl: null,
    statusEl: null,
    highlightClass: 'webgazer-gaze-highlight',
    runtimeListener: null,
    predictionBuffer: [],
    selectedCameraId: null,
    cameraDevices: [],
    restartInProgress: false,
    customGazeDot: null,
    calibrationSamples: [],
    calibrationTransform: {
      matrix: [
        [1, 0, 0],
        [0, 1, 0]
      ],
      ready: false
    },
    calibrationCapture: null
  };

  const controls = {};

  document.addEventListener('DOMContentLoaded', () => {
    cacheControls();
    attachControlHandlers();
    populateCameraOptions();
    ensureTooltip();
    ensureCustomGazeIndicator();
    setupRuntimeListener();
  });

  function cacheControls() {
    controls.startBtn = document.getElementById('wg-start-calibration');
    controls.beginBtn = document.getElementById('wg-begin-hover');
    controls.stopBtn = document.getElementById('wg-stop-hover');
    controls.previewToggle = document.getElementById('wg-toggle-preview');
    controls.status = document.getElementById('webgazer-status');
    controls.dwellInput = document.getElementById('wg-dwell-threshold');
    controls.cameraSelect = document.getElementById('wg-camera-select');
    controls.refreshCameras = document.getElementById('wg-refresh-cameras');
    controls.refineBtn = document.getElementById('wg-refine-calibration');
    state.statusEl = controls.status;
  }

  function attachControlHandlers() {
    if (controls.startBtn) {
      controls.startBtn.addEventListener('click', handleStartCalibration);
    }
    if (controls.beginBtn) {
      controls.beginBtn.addEventListener('click', handleBeginHover);
    }
    if (controls.stopBtn) {
      controls.stopBtn.addEventListener('click', stopHoverMode);
    }
    if (controls.dwellInput) {
      controls.dwellInput.addEventListener('input', (event) => {
        const value = Number.parseInt(event.target.value, 10);
        if (!Number.isNaN(value) && value >= 350) {
          state.customDwell = value;
          updateStatus(`Dwell threshold set to ${value} ms`, STATUS_OK);
        }
      });
    }
    if (controls.cameraSelect) {
      controls.cameraSelect.addEventListener('change', handleCameraSelectionChange);
    }
    if (controls.refreshCameras) {
      controls.refreshCameras.addEventListener('click', refreshCameraOptions);
    }
    if (controls.refineBtn) {
      controls.refineBtn.addEventListener('click', handleRefineCalibration);
    }
  }

  async function populateCameraOptions() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
      if (controls.cameraSelect) {
        controls.cameraSelect.disabled = true;
      }
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter((device) => device.kind === 'videoinput');
      state.cameraDevices = videoInputs;
      if (!controls.cameraSelect) return;

      const previous = controls.cameraSelect.value;
      controls.cameraSelect.innerHTML = '';

      const defaultOption = document.createElement('option');
      defaultOption.value = '';
      defaultOption.textContent = 'Default camera';
      controls.cameraSelect.appendChild(defaultOption);

      videoInputs.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Camera ${index + 1}`;
        controls.cameraSelect.appendChild(option);
      });

      if (state.selectedCameraId) {
        controls.cameraSelect.value = state.selectedCameraId;
      } else if (previous) {
        controls.cameraSelect.value = previous;
      }

      controls.cameraSelect.disabled = false;
    } catch (error) {
      console.warn('[WebGazer Prototype] enumerateDevices failed:', error);
      if (controls.cameraSelect) {
        controls.cameraSelect.disabled = true;
      }
      updateStatus('Unable to list cameras. Grant camera access and try again.', STATUS_WARN);
    }
  }

  function refreshCameraOptions() {
    populateCameraOptions();
    updateStatus('Refreshing camera list…', STATUS_OK);
  }

  async function handleCameraSelectionChange(event) {
    const deviceId = event.target.value || null;
    state.selectedCameraId = deviceId;
    if (state.webgazerReady && !state.restartInProgress) {
      if (deviceId) {
        const label = state.cameraDevices.find((device) => device.deviceId === deviceId)?.label || 'Selected camera';
        updateStatus(`${label} selected. Restarting calibration…`, STATUS_OK);
      } else {
        updateStatus('Using default camera. Restarting calibration…', STATUS_OK);
      }
      await restartCalibrationAfterCameraSwitch();
    } else {
      updateStatus(deviceId ? 'Camera selected. Start calibration to use it.' : 'Default camera selected. Start calibration to continue.', STATUS_OK);
    }
  }

  async function restartCalibrationAfterCameraSwitch() {
    if (state.restartInProgress) return;
    state.restartInProgress = true;
    try {
      stopHoverMode();
      state.hoverActive = false;
      state.calibrationConfig.completed = false;
      state.calibrationConfig.primaryComplete = false;
      state.predictionBuffer = [];
      if (controls.beginBtn) controls.beginBtn.disabled = true;
      if (controls.refineBtn) controls.refineBtn.disabled = true;
      await cleanupWebGazer();
      await startCalibrationWorkflow({ triggeredByCameraChange: true });
    } finally {
      state.restartInProgress = false;
    }
  }

  function applyCameraConstraint(gaze) {
    if (!gaze || !gaze.params) return;
    const constraints = gaze.params.camConstraints || {};
    const videoConstraints = constraints.video || {};
    if (state.selectedCameraId) {
      videoConstraints.deviceId = { exact: state.selectedCameraId };
    } else if (videoConstraints.deviceId) {
      delete videoConstraints.deviceId;
    }
    constraints.video = videoConstraints;
    gaze.params.camConstraints = constraints;
  }

  async function handleStartCalibration() {
    await startCalibrationWorkflow({ triggeredByCameraChange: false });
  }

  async function startCalibrationWorkflow({ triggeredByCameraChange = false } = {}) {
    if (controls.startBtn && !triggeredByCameraChange) {
      controls.startBtn.disabled = true;
    }
    if (controls.beginBtn) controls.beginBtn.disabled = true;
    if (controls.refineBtn) controls.refineBtn.disabled = true;
    state.predictionBuffer = [];
    updateStatus('Loading WebGazer… please allow camera access.');
    try {
      await ensureWebGazerLoaded();
      const gaze = window.webgazer;
      if (!gaze) throw new Error('WebGazer unavailable after load.');

      applyCameraConstraint(gaze);

      try {
        if (typeof gaze.pause === 'function') gaze.pause();
      } catch (error) {
        console.debug('[WebGazer Prototype] pause() during restart failed:', error);
      }
      try {
        if (typeof gaze.end === 'function') await gaze.end();
      } catch (error) {
        console.debug('[WebGazer Prototype] end() during restart failed:', error);
      }

      if (typeof gaze.clearData === 'function') {
        try {
          await gaze.clearData();
        } catch (error) {
          console.debug('[WebGazer Prototype] clearData() failed:', error);
        }
      }

      await gaze.setRegression('ridge');
      await selectAvailableTracker(gaze);

      gaze.params.showGazeDot = true;
      gaze.params.saveDataAcrossSessions = false;
      gaze.params.storingPoints = false;
      applyCameraConstraint(gaze);
      gaze.setGazeListener(handleGazePrediction);
      await gaze.begin();

      await waitForWebgazerDomElements();
      ensureWebgazerSupportCanvases();

      try {
        gaze.showVideoPreview(Boolean(controls.previewToggle?.checked));
      } catch (error) {
        console.debug('[WebGazer Prototype] showVideoPreview failed:', error);
      }
      try {
        gaze.showPredictionPoints(true);
      } catch (error) {
        console.warn('[WebGazer Prototype] Failed to show prediction points after begin:', error);
      }

      state.webgazerReady = true;
      state.calibrationMode = true;
      state.hoverActive = false;
      state.dwellAnchor = null;
      state.dwellStart = 0;
      state.predictionBuffer = [];
      state.calibrationConfig.stage = 'primary';
      state.calibrationConfig.completed = false;
      state.calibrationConfig.primaryComplete = false;
      state.calibrationConfig.points = [];
      state.calibrationConfig.counts = new Map();
      state.calibrationSamples = [];
      state.calibrationTransform = {
        matrix: [
          [1, 0, 0],
          [0, 1, 0]
        ],
        ready: false
      };
      finalizeCalibrationCapture(true);
      updateCustomGazeIndicator(null);

      initialiseCalibrationTargets('primary');
      try {
        gaze.showPredictionPoints(true);
      } catch (error) {
        console.warn('[WebGazer Prototype] Unable to show prediction points after calibration init:', error);
      }
      gaze.showVideoPreview(Boolean(controls.previewToggle?.checked));
      updateStatus('Calibration running — click each blue dot three times to improve accuracy.', STATUS_OK);
      if (controls.stopBtn) controls.stopBtn.disabled = false;
      populateCameraOptions();
    } catch (error) {
      console.error('[WebGazer Prototype] Failed to initialise WebGazer:', error);
      updateStatus(`WebGazer failed to start: ${error.message}`, STATUS_WARN);
      state.webgazerReady = false;
    } finally {
      if (controls.startBtn) controls.startBtn.disabled = !state.webgazerReady;
    }
  }

  function handleRefineCalibration() {
    if (!state.webgazerReady) {
      updateStatus('Start calibration before running fine-tune mode.', STATUS_WARN);
      return;
    }
    const gaze = window.webgazer;
    if (gaze) {
      waitForWebgazerDomElements(1500).then(() => {
        try {
          gaze.showVideoPreview(Boolean(controls.previewToggle?.checked));
        } catch (error) {
          console.debug('[WebGazer Prototype] showVideoPreview during fine-tune failed:', error);
        }
        try {
          gaze.showPredictionPoints(true);
        } catch (error) {
          console.debug('[WebGazer Prototype] showPredictionPoints during fine-tune failed:', error);
        }
      });
    }
    state.calibrationMode = true;
    state.hoverActive = false;
    state.calibrationConfig.stage = 'fine';
    state.calibrationConfig.completed = false;
    state.calibrationConfig.points = [];
    state.calibrationConfig.counts = new Map();
    state.predictionBuffer = [];
    updateCustomGazeIndicator(null);
    initialiseCalibrationTargets('fine');
    if (controls.beginBtn) controls.beginBtn.disabled = true;
    if (controls.refineBtn) controls.refineBtn.disabled = true;
    updateStatus('Fine-tune calibration: click each orange dot twice.', STATUS_OK);
  }

  function handleBeginHover() {
    if (!state.webgazerReady) {
      updateStatus('Start calibration before enabling hover mode.', STATUS_WARN);
      return;
    }
    if (!state.calibrationConfig.primaryComplete && !state.calibrationConfig.completed) {
      updateStatus('Complete the calibration dots before starting hover mode.', STATUS_WARN);
      return;
    }
    state.hoverActive = true;
    state.calibrationMode = false;
    state.predictionBuffer = [];
    state.dwellAnchor = null;
    state.dwellStart = 0;
    updateCustomGazeIndicator(null);
    const gaze = window.webgazer;
    if (gaze) {
      try {
        gaze.showPredictionPoints(false);
      } catch (error) {
        console.debug('[WebGazer Prototype] Failed to hide prediction points:', error);
      }
      gaze.showVideoPreview(Boolean(controls.previewToggle?.checked));
    }
    teardownCalibrationTargets();
    updateStatus('Gaze hover active — look at a link and dwell to trigger.', STATUS_OK);
    if (controls.stopBtn) controls.stopBtn.disabled = false;
  }

  function stopHoverMode() {
    state.hoverActive = false;
    state.calibrationMode = false;
    if (state.dwellAnchor) {
      clearHighlight(state.dwellAnchor);
      state.dwellAnchor = null;
    }
    state.dwellStart = 0;
    state.activeUrl = null;
    state.smoothX = null;
    state.smoothY = null;
    state.predictionBuffer = [];
    if (controls.startBtn) controls.startBtn.disabled = false;
    if (controls.stopBtn) controls.stopBtn.disabled = true;
    updateCustomGazeIndicator(null);
    updateStatus('Hover mode paused. You can resume after recalibrating if needed.');
  }

  async function selectAvailableTracker(gaze) {
    if (!gaze || typeof gaze.getAvailableTrackers !== 'function') {
      return;
    }
    const available = gaze.getAvailableTrackers() || [];
    if (!available.length) {
      return;
    }
    const preferred = ['clmtrackr', 'clmtrackr + ridge', 'TFFacemesh', 'No stream'];
    for (const candidate of preferred) {
      if (available.includes(candidate)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await gaze.setTracker(candidate);
          console.log('[WebGazer Prototype] Using tracker:', candidate);
          return;
        } catch (error) {
          console.warn('[WebGazer Prototype] Failed to set tracker', candidate, error);
        }
      }
    }
    const fallback = available[0];
    try {
      await gaze.setTracker(fallback);
      console.log('[WebGazer Prototype] Fallback tracker:', fallback);
    } catch (error) {
      console.warn('[WebGazer Prototype] Unable to set fallback tracker:', error);
    }
  }

  async function ensureWebGazerLoaded() {
    if (window.webgazer) {
      return window.webgazer;
    }

    const candidateUrls = [];
    try {
      const runtimeApi = globalThis.chrome && globalThis.chrome.runtime;
      if (runtimeApi && typeof runtimeApi.getURL === 'function') {
        candidateUrls.push(runtimeApi.getURL('lib/webgazer.js'));
      }
    } catch (error) {
      console.debug('[WebGazer Prototype] runtime.getURL unavailable:', error);
    }

    candidateUrls.push('../lib/webgazer.js');
    candidateUrls.push('lib/webgazer.js');
    candidateUrls.push('https://webgazer.cs.brown.edu/webgazer.js');

    for (const src of candidateUrls) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await loadScript(src);
        if (window.webgazer) {
          console.log('[WebGazer Prototype] Loaded WebGazer from', src);
          return window.webgazer;
        }
      } catch (error) {
        console.warn('[WebGazer Prototype] Failed to load', src, error);
      }
    }

    throw new Error('Unable to load WebGazer library.');
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = () => resolve();
      script.onerror = (event) => reject(new Error(`Script load failed for ${src}: ${event?.type || 'unknown error'}`));
      document.head.appendChild(script);
    });
  }

  function handleGazePrediction(data /*, timestamp */) {
    if (!data) {
      updateCustomGazeIndicator(null);
      return;
    }

    const rawPoint = { x: data.x, y: data.y };
    captureCalibrationSample(rawPoint);

    const calibrated = applyCalibrationTransform(rawPoint);
    updateCustomGazeIndicator(calibrated);

    if (state.calibrationMode) {
      return;
    }

    if (!state.hoverActive) {
      return;
    }

    const threshold = state.customDwell || DWELL_THRESHOLD_MS;
    addPredictionSample(calibrated);
    const { anchor, centroid } = resolveDominantAnchor();

    if (anchor !== state.dwellAnchor) {
      if (state.dwellAnchor) {
        clearHighlight(state.dwellAnchor);
      }
      if (anchor) {
        highlightAnchor(anchor);
        state.dwellStart = performance.now();
      } else {
        state.dwellStart = 0;
      }
      state.dwellAnchor = anchor;
      return;
    }

    if (!anchor || !centroid) {
      state.dwellStart = 0;
      return;
    }

    state.smoothX = centroid.x;
    state.smoothY = centroid.y;

    if (state.dwellStart === 0) {
      state.dwellStart = performance.now();
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const drift = Math.hypot(centerX - centroid.x, centerY - centroid.y);
    if (drift > ANCHOR_DRIFT_THRESHOLD_PX) {
      state.dwellStart = performance.now();
      return;
    }

    const now = performance.now();
    const elapsed = now - state.dwellStart;
    const lastTrigger = state.lastTriggerByNode.get(anchor) || 0;

    if (elapsed >= threshold && (now - lastTrigger) >= RETRIGGER_COOLDOWN_MS) {
      state.lastTriggerByNode.set(anchor, now);
      triggerGazeHover(anchor);
      state.dwellStart = now;
    }
  }

  function anchorFromViewportPoint(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      return null;
    }
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    return el.closest('a[href]');
  }

  function highlightAnchor(anchor) {
    anchor.classList.add(state.highlightClass);
  }

  function clearHighlight(anchor) {
    anchor.classList.remove(state.highlightClass);
  }

  function ensureTooltip() {
    if (state.tooltipEl) return state.tooltipEl;
    const tooltip = document.createElement('div');
    tooltip.id = 'webgazer-tooltip';
    tooltip.innerHTML = `
      <div class="tooltip-title">Gaze Hover</div>
      <div class="tooltip-body webgazer-note">Look at a link to begin.</div>
    `;
    document.body.appendChild(tooltip);
    state.tooltipEl = tooltip;
    return tooltip;
  }

  function showTooltip(contentHtml, anchor) {
    const tooltip = ensureTooltip();
    const titleEl = tooltip.querySelector('.tooltip-title');
    const bodyEl = tooltip.querySelector('.tooltip-body');
    if (titleEl) {
      titleEl.textContent = 'Gaze Hover';
    }
    if (bodyEl) {
      bodyEl.innerHTML = contentHtml;
    }
    tooltip.classList.add('visible');
    positionTooltipNearAnchor(tooltip, anchor);
  }

  function updateTooltipContent(contentHtml) {
    const tooltip = ensureTooltip();
    const bodyEl = tooltip.querySelector('.tooltip-body');
    if (bodyEl) {
      bodyEl.innerHTML = contentHtml;
    }
    tooltip.classList.add('visible');
  }

  function positionTooltipNearAnchor(tooltip, anchor) {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const top = Math.max(20, rect.bottom + 12);
    let left = rect.left + rect.width / 2;
    left = Math.min(window.innerWidth - tooltip.offsetWidth / 2 - 20, left);
    left = Math.max(tooltip.offsetWidth / 2 + 20, left);
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    tooltip.style.transform = 'translateX(-50%)';
  }

  function hideTooltip() {
    if (state.tooltipEl) {
      state.tooltipEl.classList.remove('visible');
    }
  }

  function triggerGazeHover(anchor) {
    if (!anchor || !anchor.href) {
      return;
    }
    const url = anchor.href;
    state.activeUrl = url;
    state.activeToken += 1;
    const token = state.activeToken;

    const contentHtml = `
      <div><strong>Capturing:</strong> ${escapeHtml(anchor.textContent || url)}</div>
      <div class="webgazer-note">Hold your gaze to keep streaming this link.</div>
    `;
    showTooltip(contentHtml, anchor);

    const runtimeApi = globalThis.chrome && globalThis.chrome.runtime;
    if (!runtimeApi || typeof runtimeApi.sendMessage !== 'function') {
      const note = `
        <p><em>chrome.runtime API unavailable — summaries require loading this page as part of the extension.</em></p>
      `;
      updateTooltipContent(contentHtml + note);
      return;
    }

    if (state.summaryCache.has(url)) {
      const cachedSummary = state.summaryCache.get(url);
      updateTooltipContent(renderSummaryHtml(cachedSummary, true));
      return;
    }

    requestSummaryForUrl(url, token).catch((error) => {
      console.error('[WebGazer Prototype] Summary request failed:', error);
      if (state.activeUrl === url && state.activeToken === token) {
        updateTooltipContent(`<div style="color:#dc2626;"><strong>Error:</strong> ${escapeHtml(error.message)}</div>`);
      }
    });
  }

  function initialiseCalibrationTargets(stage = 'primary') {
    teardownCalibrationTargets();

    const overlay = document.createElement('div');
    overlay.id = 'webgazer-calibration-overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = stage === 'primary' ? 'rgba(15, 23, 42, 0.05)' : 'rgba(37, 99, 235, 0.05)';
    overlay.style.zIndex = '2147483600';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.pointerEvents = 'none';

    const grid = document.createElement('div');
    grid.style.position = 'absolute';
    grid.style.inset = '5%';
    grid.style.pointerEvents = 'none';

    overlay.appendChild(grid);
    document.body.appendChild(overlay);

    state.calibrationOverlay = overlay;
    state.calibrationConfig.stage = stage;
    state.calibrationConfig.points = [];
    state.calibrationConfig.counts = new Map();
    state.calibrationConfig.completed = false;

    const primaryPositions = [
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 90, y: 10 },
      { x: 10, y: 50 },
      { x: 50, y: 50 },
      { x: 90, y: 50 },
      { x: 10, y: 90 },
      { x: 50, y: 90 },
      { x: 90, y: 90 }
    ];

    const finePositions = [
      { x: 20, y: 20 },
      { x: 50, y: 18 },
      { x: 80, y: 20 },
      { x: 20, y: 50 },
      { x: 80, y: 50 },
      { x: 20, y: 80 },
      { x: 50, y: 82 },
      { x: 80, y: 80 },
      { x: 35, y: 35 },
      { x: 65, y: 35 },
      { x: 35, y: 65 },
      { x: 65, y: 65 }
    ];

    const positions = stage === 'primary' ? primaryPositions : finePositions;
    state.calibrationConfig.clicksPerPoint = stage === 'primary' ? 3 : 2;

    positions.forEach((position) => {
      const point = document.createElement('button');
      point.type = 'button';
      point.className = 'webgazer-calibration-point';
      point.style.position = 'absolute';
      point.style.width = '28px';
      point.style.height = '28px';
      point.style.borderRadius = '50%';
      point.style.background = stage === 'primary' ? '#2563eb' : '#ea580c';
      point.style.border = stage === 'primary' ? '3px solid #1d4ed8' : '3px solid #c2410c';
      point.style.opacity = '0.9';
      point.style.pointerEvents = 'auto';
      point.style.cursor = 'crosshair';
      point.style.left = `calc(${position.x}% - 14px)`;
      point.style.top = `calc(${position.y}% - 14px)`;
      point.title = 'Click to calibrate';
      point.addEventListener('click', (event) => handleCalibrationClick(event, point));

      grid.appendChild(point);
      state.calibrationConfig.points.push(point);
      state.calibrationConfig.counts.set(point, 0);
    });

    const overlayMessage = document.createElement('div');
    overlayMessage.textContent = stage === 'primary'
      ? 'Click each blue dot three times to calibrate gaze tracking.'
      : 'Fine-tune: click each orange dot twice to sharpen accuracy.';
    overlayMessage.style.position = 'absolute';
    overlayMessage.style.bottom = '40px';
    overlayMessage.style.left = '50%';
    overlayMessage.style.transform = 'translateX(-50%)';
    overlayMessage.style.background = '#0f172a';
    overlayMessage.style.color = 'white';
    overlayMessage.style.padding = '10px 18px';
    overlayMessage.style.borderRadius = '999px';
    overlayMessage.style.fontSize = '0.95rem';
    overlayMessage.style.pointerEvents = 'none';
    overlay.appendChild(overlayMessage);

    const gaze = window.webgazer;
    if (gaze) {
      try {
        gaze.showPredictionPoints(true);
      } catch (error) {
        console.debug('[WebGazer Prototype] Unable to show prediction points while building calibration overlay:', error);
      }
    }
  }

  function handleCalibrationClick(event, point) {
    event.preventDefault();
    event.stopPropagation();
    const gaze = window.webgazer;
    if (!gaze) return;

    const x = event.clientX;
    const y = event.clientY;
    const rect = point.getBoundingClientRect();
    const targetX = rect.left + rect.width / 2;
    const targetY = rect.top + rect.height / 2;
    beginCalibrationCapture(targetX, targetY);

    const currentCount = state.calibrationConfig.counts.get(point) || 0;
    const nextCount = currentCount + 1;
    state.calibrationConfig.counts.set(point, nextCount);
    point.style.transform = `scale(${1 + (nextCount * 0.2)})`;
    point.style.opacity = String(Math.max(0.15, 1 - (nextCount * 0.3)));
    if (nextCount >= state.calibrationConfig.clicksPerPoint) {
      point.style.background = '#16a34a';
      point.style.borderColor = '#15803d';
    }

    const remaining = state.calibrationConfig.points.filter((target) => {
      const count = state.calibrationConfig.counts.get(target) || 0;
      return count < state.calibrationConfig.clicksPerPoint;
    }).length;

    if (remaining === 0) {
      state.calibrationConfig.completed = true;
      if (state.calibrationConfig.stage === 'primary') {
        state.calibrationConfig.primaryComplete = true;
        updateStatus('Baseline calibration complete! Run fine-tune calibration or begin gaze hover.', STATUS_OK);
        if (controls.refineBtn) controls.refineBtn.disabled = false;
        if (controls.beginBtn) controls.beginBtn.disabled = false;
      } else {
        updateStatus('Fine-tune calibration complete! Begin gaze hover when ready.', STATUS_OK);
        if (controls.beginBtn) controls.beginBtn.disabled = false;
        if (controls.refineBtn) controls.refineBtn.disabled = true;
      }
      finalizeCalibrationCapture();
      teardownCalibrationTargets();
    } else {
      updateStatus(`Calibration in progress… ${remaining} dots remaining.`, STATUS_OK);
    }
  }

  function teardownCalibrationTargets() {
    if (state.calibrationOverlay && state.calibrationOverlay.parentElement) {
      state.calibrationOverlay.parentElement.removeChild(state.calibrationOverlay);
    }
    state.calibrationOverlay = null;
  }

  async function requestSummaryForUrl(url, token) {
    const fetchingHtml = '<div class="webgazer-note">Fetching article content…</div>';
    if (state.activeUrl === url && state.activeToken === token) {
      updateTooltipContent(fetchingHtml);
    }

    let fetchResponse;
    try {
      fetchResponse = await sendRuntimeMessage({ type: 'FETCH_CONTENT', url });
    } catch (error) {
      throw new Error(`Content fetch failed: ${error.message}`);
    }

    if (fetchResponse?.error) {
      throw new Error(fetchResponse.error);
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(fetchResponse.html, 'text/html');
    if (typeof Readability !== 'function') {
      throw new Error('Readability helper missing. Ensure lib/Readability.js is loaded.');
    }

    const reader = new Readability(doc);
    const article = reader.parse();

    let title;
    let textContent;

    if (article && article.textContent && article.textContent.trim().length > 80) {
      title = article.title || doc.title || 'Untitled';
      textContent = article.textContent;
    } else {
      const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content') ||
        doc.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
        '';
      title = doc.title || 'Untitled';
      textContent = metaDesc || 'No readable article content detected.';
    }

    if (state.activeUrl === url && state.activeToken === token) {
      updateTooltipContent('<div class="webgazer-note">Generating summary…</div>');
    }

    const summaryResult = await sendRuntimeMessage({
      type: 'SUMMARIZE_CONTENT',
      url,
      title,
      textContent
    });

    if (state.activeUrl !== url || state.activeToken !== token) {
      return;
    }

    handleSummaryResult(url, summaryResult);
  }

  function handleSummaryResult(url, result) {
    if (!result) {
      updateTooltipContent('<div style="color:#dc2626;">No response from summarizer.</div>');
      return;
    }

    if (result.status === 'complete') {
      state.summaryCache.set(url, result.summary);
      updateTooltipContent(renderSummaryHtml(result.summary, Boolean(result.cached)));
      return;
    }

    if (result.status === 'cached') {
      state.summaryCache.set(url, result.summary);
      updateTooltipContent(renderSummaryHtml(result.summary, true));
      return;
    }

    if (result.status === 'duplicate' || result.status === 'streaming') {
      // Streaming updates will handle UI.
      return;
    }

    if (result.status === 'aborted') {
      updateTooltipContent('<div class="webgazer-note">Summary aborted.</div>');
      return;
    }

    if (result.error) {
      updateTooltipContent(`<div style="color:#dc2626;"><strong>Error:</strong> ${escapeHtml(result.error)}</div>`);
      return;
    }

    updateTooltipContent('<div class="webgazer-note">Summary status unknown.</div>');
  }

  function renderSummaryHtml(summary, cached) {
    const cachedNote = cached
      ? '<div class="webgazer-note">Served from cache.</div>'
      : '';
    return `${cachedNote}<div>${summary}</div>`;
  }

  function setupRuntimeListener() {
    const runtimeApi = globalThis.chrome && globalThis.chrome.runtime;
    if (!runtimeApi || !runtimeApi.onMessage) {
      return;
    }
    state.runtimeListener = (message) => {
      if (!message) return;

      if (message.type === 'STREAMING_UPDATE') {
        if (message.url && message.url === state.activeUrl) {
          updateTooltipContent(message.content);
        }
      }

      if (message.type === 'PROCESSING_STATUS') {
        if (message.url && message.url === state.activeUrl && message.status === 'started') {
          updateTooltipContent('<div class="webgazer-note">Generating summary…</div>');
        }
      }

      if (message.type === 'DISPLAY_CACHED_SUMMARY' && message.url === state.activeUrl) {
        if (message.summary) {
          updateTooltipContent(renderSummaryHtml(message.summary, true));
        }
      }
    };
    runtimeApi.onMessage.addListener(state.runtimeListener);

    window.addEventListener('beforeunload', () => {
      const api = globalThis.chrome && globalThis.chrome.runtime;
      if (api?.onMessage && state.runtimeListener) {
        api.onMessage.removeListener(state.runtimeListener);
      }
      cleanupWebGazer();
    });
  }

  function cleanupWebGazer() {
    if (window.webgazer) {
      try {
        window.webgazer.pause();
        window.webgazer.end();
      } catch (error) {
        console.warn('[WebGazer Prototype] Failed to stop WebGazer:', error);
      }
      try {
        window.webgazer.setGazeListener(null);
      } catch (error) {
        console.debug('[WebGazer Prototype] Unable to remove gaze listener:', error);
      }
    }
    state.webgazerReady = false;
    state.predictionBuffer = [];
    updateCustomGazeIndicator(null);
    finalizeCalibrationCapture(true);
    state.calibrationSamples = [];
    state.calibrationTransform = {
      matrix: [
        [1, 0, 0],
        [0, 1, 0]
      ],
      ready: false
    };
  }

  async function waitForWebgazerDomElements(timeoutMs = 2500) {
    const start = performance.now();
    let elapsed = 0;
    while (elapsed <= timeoutMs) {
      const videoCanvas = document.getElementById('webgazerVideoCanvas');
      const videoPreview = document.getElementById('webgazerVideoFeed');
      if (videoCanvas || videoPreview) {
        return { videoCanvas, videoPreview };
      }
      await sleep(50);
      elapsed = performance.now() - start;
    }
    return { videoCanvas: null, videoPreview: null };
  }

  function ensureWebgazerSupportCanvases() {
    let videoCanvas = document.getElementById('webgazerVideoCanvas');
    if (!videoCanvas) {
      videoCanvas = document.createElement('canvas');
      videoCanvas.id = 'webgazerVideoCanvas';
      videoCanvas.width = 320;
      videoCanvas.height = 240;
      videoCanvas.style.position = 'fixed';
      videoCanvas.style.top = '-9999px';
      videoCanvas.style.left = '-9999px';
      videoCanvas.style.opacity = '0';
      document.body.appendChild(videoCanvas);
    }
    let heatmapCanvas = document.getElementById('webgazerHeatmap');
    if (!heatmapCanvas) {
      heatmapCanvas = document.createElement('canvas');
      heatmapCanvas.id = 'webgazerHeatmap';
      heatmapCanvas.width = window.innerWidth || 1920;
      heatmapCanvas.height = window.innerHeight || 1080;
      heatmapCanvas.style.position = 'fixed';
      heatmapCanvas.style.top = '-9999px';
      heatmapCanvas.style.left = '-9999px';
      heatmapCanvas.style.opacity = '0';
      document.body.appendChild(heatmapCanvas);
    }
  }

  function sendRuntimeMessage(payload) {
    const runtimeApi = globalThis.chrome && globalThis.chrome.runtime;
    return new Promise((resolve, reject) => {
      if (!runtimeApi || typeof runtimeApi.sendMessage !== 'function') {
        reject(new Error('chrome.runtime.sendMessage is unavailable'));
        return;
      }
      try {
        runtimeApi.sendMessage(payload, (response) => {
          const runtimeError = runtimeApi.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function updateStatus(message, color) {
    if (!state.statusEl) return;
    state.statusEl.textContent = message;
    state.statusEl.style.color = color || '#0f172a';
  }

  function ensureCustomGazeIndicator() {
    if (!state.customGazeDot) {
      state.customGazeDot = document.createElement('div');
      state.customGazeDot.id = 'custom-gaze-indicator';
      state.customGazeDot.style.position = 'fixed';
      state.customGazeDot.style.width = '18px';
      state.customGazeDot.style.height = '18px';
      state.customGazeDot.style.borderRadius = '50%';
      state.customGazeDot.style.pointerEvents = 'none';
      state.customGazeDot.style.zIndex = '2147483630';
      state.customGazeDot.style.transform = 'translate(-50%, -50%)';
      state.customGazeDot.style.display = 'none';
      state.customGazeDot.style.background = 'rgba(239, 68, 68, 0.95)';
      state.customGazeDot.style.border = '2px solid #b91c1c';
      state.customGazeDot.style.boxShadow = '0 0 8px rgba(239, 68, 68, 0.55)';
    }
    if (!state.customGazeDot.parentElement) {
      document.body.appendChild(state.customGazeDot);
    }
    return state.customGazeDot;
  }

  function updateCustomGazeIndicator(sample) {
    const dot = ensureCustomGazeIndicator();
    if (!sample || !Number.isFinite(sample.x) || !Number.isFinite(sample.y) || !state.calibrationMode) {
      dot.style.display = 'none';
      return;
    }
    dot.style.left = `${sample.x}px`;
    dot.style.top = `${sample.y}px`;
    dot.style.display = 'block';
  }
  function addPredictionSample(sample) {
    const now = performance.now();
    state.predictionBuffer.push({
      x: sample.x,
      y: sample.y,
      t: now
    });
    while (state.predictionBuffer.length > PREDICTION_BUFFER_SIZE) {
      state.predictionBuffer.shift();
    }
    while (state.predictionBuffer.length && (now - state.predictionBuffer[0].t) > PREDICTION_BUFFER_WINDOW_MS) {
      state.predictionBuffer.shift();
    }
  }

  function resolveDominantAnchor() {
    if (!state.predictionBuffer.length) {
      return { anchor: null, centroid: null };
    }
    const counts = new Map();
    const pointsByAnchor = new Map();

    state.predictionBuffer.forEach((sample) => {
      const anchor = anchorFromViewportPoint(sample.x, sample.y);
      if (!anchor) return;
      const count = (counts.get(anchor) || 0) + 1;
      counts.set(anchor, count);
      if (!pointsByAnchor.has(anchor)) {
        pointsByAnchor.set(anchor, []);
      }
      pointsByAnchor.get(anchor).push(sample);
    });

    if (!counts.size) {
      return { anchor: null, centroid: null };
    }

    let bestAnchor = null;
    let bestCount = 0;
    counts.forEach((count, anchor) => {
      if (count > bestCount) {
        bestAnchor = anchor;
        bestCount = count;
      }
    });

    if (!bestAnchor || bestCount < MIN_STABLE_ANCHOR_HITS) {
      return { anchor: null, centroid: null };
    }

    const samples = pointsByAnchor.get(bestAnchor) || [];
    const centroid = samples.reduce((acc, sample) => {
      acc.x += sample.x;
      acc.y += sample.y;
      return acc;
    }, { x: 0, y: 0 });
    if (samples.length > 0) {
      centroid.x /= samples.length;
      centroid.y /= samples.length;
    }

    const rect = bestAnchor.getBoundingClientRect();
    if (!pointInsideRectWithPadding(centroid, rect, RECT_PADDING_PX)) {
      return { anchor: null, centroid: null };
    }

    return { anchor: bestAnchor, centroid };
  }

  function pointInsideRectWithPadding(point, rect, padding) {
    if (!point || !rect) return false;
    return (
      point.x >= rect.left - padding &&
      point.x <= rect.right + padding &&
      point.y >= rect.top - padding &&
      point.y <= rect.bottom + padding
    );
  }

  function beginCalibrationCapture(targetX, targetY) {
    if (state.calibrationCapture) {
      const hasSamples = state.calibrationCapture.samples && state.calibrationCapture.samples.length >= 3;
      finalizeCalibrationCapture(!hasSamples);
    }
    const capture = {
      target: { x: targetX, y: targetY },
      samples: [],
      expires: performance.now() + CALIBRATION_SAMPLE_WINDOW_MS,
      timeoutId: setTimeout(() => {
        finalizeCalibrationCapture();
      }, CALIBRATION_SAMPLE_WINDOW_MS + 30)
    };
    state.calibrationCapture = capture;
  }

  function captureCalibrationSample(rawPoint) {
    const capture = state.calibrationCapture;
    if (!capture) return;
    capture.samples.push({ x: rawPoint.x, y: rawPoint.y });
    if (performance.now() >= capture.expires) {
      finalizeCalibrationCapture();
    }
  }

  function finalizeCalibrationCapture(discard = false) {
    const capture = state.calibrationCapture;
    if (!capture) return;
    if (capture.timeoutId) {
      clearTimeout(capture.timeoutId);
    }
    state.calibrationCapture = null;
    if (discard || !capture.samples.length) {
      return;
    }

    const sum = capture.samples.reduce((acc, sample) => {
      acc.x += sample.x;
      acc.y += sample.y;
      return acc;
    }, { x: 0, y: 0 });
    const count = capture.samples.length;
    const averaged = {
      x: sum.x / count,
      y: sum.y / count
    };

    state.calibrationSamples.push({
      raw: averaged,
      target: { x: capture.target.x, y: capture.target.y }
    });
    if (state.calibrationSamples.length > 24) {
      state.calibrationSamples.shift();
    }
    recomputeCalibrationTransform();
  }

  function applyCalibrationTransform(point) {
    const transform = state.calibrationTransform;
    if (!transform.ready) {
      return {
        x: clamp(point.x, 0, window.innerWidth),
        y: clamp(point.y, 0, window.innerHeight)
      };
    }
    const [[a, b, c], [d, e, f]] = transform.matrix;
    const calibratedX = a * point.x + b * point.y + c;
    const calibratedY = d * point.x + e * point.y + f;
    return {
      x: clamp(calibratedX, 0, window.innerWidth),
      y: clamp(calibratedY, 0, window.innerHeight)
    };
  }

  function recomputeCalibrationTransform() {
    const samples = state.calibrationSamples;
    if (!samples || samples.length < 3) {
      state.calibrationTransform = {
        matrix: [
          [1, 0, 0],
          [0, 1, 0]
        ],
        ready: false
      };
      return;
    }

    const coeffX = solveLeastSquaresCoefficients(samples, 'x');
    const coeffY = solveLeastSquaresCoefficients(samples, 'y');

    if (!coeffX || !coeffY) {
      return;
    }

    state.calibrationTransform = {
      matrix: [coeffX, coeffY],
      ready: true
    };
  }

  function solveLeastSquaresCoefficients(samples, axis) {
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    let sumTarget = 0;
    let sumXTarget = 0;
    let sumYTarget = 0;
    const n = samples.length;

    for (const sample of samples) {
      const rawX = sample.raw.x;
      const rawY = sample.raw.y;
      const targetVal = axis === 'x' ? sample.target.x : sample.target.y;
      sumX += rawX;
      sumY += rawY;
      sumXX += rawX * rawX;
      sumYY += rawY * rawY;
      sumXY += rawX * rawY;
      sumTarget += targetVal;
      sumXTarget += rawX * targetVal;
      sumYTarget += rawY * targetVal;
    }

    const matrix = [
      [sumXX, sumXY, sumX],
      [sumXY, sumYY, sumY],
      [sumX, sumY, n]
    ];
    const vector = [sumXTarget, sumYTarget, sumTarget];
    return solve3x3(matrix, vector);
  }

  function solve3x3(m, v) {
    const det = determinant3(m);
    if (Math.abs(det) < 1e-6) {
      return null;
    }
    const detX = determinant3([
      [v[0], m[0][1], m[0][2]],
      [v[1], m[1][1], m[1][2]],
      [v[2], m[2][1], m[2][2]]
    ]);
    const detY = determinant3([
      [m[0][0], v[0], m[0][2]],
      [m[1][0], v[1], m[1][2]],
      [m[2][0], v[2], m[2][2]]
    ]);
    const detZ = determinant3([
      [m[0][0], m[0][1], v[0]],
      [m[1][0], m[1][1], v[1]],
      [m[2][0], m[2][1], v[2]]
    ]);
    return [detX / det, detY / det, detZ / det];
  }

  function determinant3(m) {
    const [[a, b, c], [d, e, f], [g, h, i]] = m;
    return (
      a * (e * i - f * h) -
      b * (d * i - f * g) +
      c * (d * h - e * g)
    );
  }
})();
