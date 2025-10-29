(function() {
  'use strict';

  const DWELL_THRESHOLD_MS = 750;
  const RETRIGGER_COOLDOWN_MS = 600;
  const STATUS_OK = 'var(--status-ok, #16a34a)';
  const STATUS_WARN = 'var(--status-warn, #dc2626)';
  const PREDICTION_BUFFER_SIZE = 60;
  const PREDICTION_BUFFER_WINDOW_MS = 1000;
  const MIN_STABLE_ANCHOR_HITS = 4;
  const ANCHOR_DRIFT_THRESHOLD_PX = 68;
  const RECT_PADDING_PX = 14;
  const CALIBRATION_SAMPLE_WINDOW_MS = 560;
  const REFINEMENT_SAMPLE_WINDOW_MS = 320;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const SMOOTHING_WINDOW = 5;
  const MAX_JUMP_DISTANCE = 180;
  const MAX_CALIBRATION_SAMPLES = 120;
  const RECENCY_HALF_LIFE_MS = 60000;
  const POSE_CONFIDENCE_THRESHOLD = 0.25;
  const POSE_BASELINE_TARGET = 40;
  const POSE_BASELINE_MIN_FRAMES = 22;
  const POSE_NEUTRAL_TOLERANCE = 0.22;
  const POSE_SMOOTH_ALPHA = 0.35;
  const POSE_HOLD_DURATION_MS = 700;
  const POSE_TIER_PREP_MS = 700;
  const POSE_BASELINE_FALLBACK_MS = 9000;
  // --- Stability / smoothing config ---
  const STABILITY_WINDOW_MS = 1000;
  const STABILITY_MIN_SAMPLES = 8;
  const TRANSFORM_UPDATE_MIN_INTERVAL_MS = 350;
  const poseTiers = [
    { id: 'center', instruction: 'Keep your head centered and look at the dot.', yaw: 0, pitch: 0 },
    { id: 'left', instruction: 'Turn your head LEFT slightly, keep eyes on the dot.', yaw: -0.35, pitch: 0 },
    { id: 'right', instruction: 'Turn your head RIGHT slightly, keep eyes on the dot.', yaw: 0.35, pitch: 0 },
    { id: 'up', instruction: 'Tilt your head UP slightly, keep eyes on the dot.', yaw: 0, pitch: -0.25 },
    { id: 'down', instruction: 'Tilt your head DOWN slightly, keep eyes on the dot.', yaw: 0, pitch: 0.25 },
    { id: 'return', instruction: 'Return your head to center and keep eyes on the dot.', yaw: 0, pitch: 0 }
  ];

  let clmEnsurePromise = null;
  let clmTrackerModuleReady = false;
  let clmModelEnsurePromise = null;

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
    trackerFallbackTimer: null,
    trackerFallbackDelay: null,
    predictionBuffer: [],
    selectedCameraId: null,
    cameraDevices: [],
    restartInProgress: false,
    customGazeDot: null,
    poseBtnDefaultLabel: null,
    calibrationSamples: [],
    calibrationTransform: {
      matrix: [
        [1, 0, 0, 0, 0],
        [0, 1, 0, 0, 0]
      ],
      ready: false
    },
    calibrationCapture: null,
    smoothing: {
      history: [],
      smoothed: null,
      pendingJump: null
    },
    pose: {
      smoothed: null,
      baseline: { yaw: 0, pitch: 0, roll: 0, count: 0, ready: false }
    },
    poseTierIndex: 0,
    poseTierActive: false,
    poseTierTimer: null,
    poseTierMonitor: null,
    poseTierHoldStart: null,
    poseTierCapturing: false,
    indicatorAlwaysOn: false,
    lastRefinementAt: 0,
    poseBaselineReadyMonitor: null,
    poseBaselineMonitorStartedAt: null,
    poseBaselineFallbackTriggered: false,
    lastStatusMessage: null,
    poseDebug: {
      lastMeasurementLog: 0,
      lastMissingLog: 0,
      missingActive: false
    },
    stability: {
      lastRecomputeAt: 0,
      hardGateUntil: 0,
      stable: false,
      stableSince: null,
      unstableSince: null
    },
    euro: null
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

  function debugLog(event, details = undefined) {
    if (typeof console !== 'object' || typeof console.info !== 'function') return;
    try {
      const label = `[WebGazer Prototype] ${event}`;
      if (details === undefined) {
        console.info(label);
      } else if (details && typeof details === 'object') {
        let snapshot = details;
        let stringified = null;
        try {
          snapshot = Object.assign({}, details);
          stringified = JSON.stringify(details, null, 2);
        } catch (_err) {
          // fall back to direct reference
        }
        console.info(label, snapshot);
        if (stringified) {
          console.info(`${label} ${stringified}`);
        }
      } else {
        console.info(label, details);
      }
    } catch (_error) {
      // ignore logging failures
    }
  }

  // --- One-Euro filter (2D) ---
  function _alpha(dt, cutoff) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  class _LPF {
    constructor() {
      this.y = null;
      this.ready = false;
    }
    filter(x, alpha) {
      if (!this.ready) {
        this.y = x;
        this.ready = true;
        return x;
      }
      this.y = this.y + alpha * (x - this.y);
      return this.y;
    }
  }
  class OneEuro {
    constructor({ minCutoff = 1.0, beta = 0.02, dCutoff = 1.0 } = {}) {
      this.minCutoff = minCutoff;
      this.beta = beta;
      this.dCutoff = dCutoff;
      this.x = new _LPF();
      this.y = new _LPF();
      this.dx = new _LPF();
      this.dy = new _LPF();
      this._t = null;
    }
    filter(point, tSec = performance.now() / 1000) {
      const dt = this._t ? Math.max(1 / 240, tSec - this._t) : 1 / 60;
      this._t = tSec;
      const alphaD = _alpha(dt, this.dCutoff);
      const dx = this.dx.filter(this.x.ready ? (point.x - this.x.y) / Math.max(dt, 1e-3) : 0, alphaD);
      const dy = this.dy.filter(this.y.ready ? (point.y - this.y.y) / Math.max(dt, 1e-3) : 0, alphaD);
      const cutoffX = this.minCutoff + this.beta * Math.abs(dx);
      const cutoffY = this.minCutoff + this.beta * Math.abs(dy);
      const alphaX = _alpha(dt, cutoffX);
      const alphaY = _alpha(dt, cutoffY);
      return {
        x: this.x.filter(point.x, alphaX),
        y: this.y.filter(point.y, alphaY)
      };
    }
  }

  function isPromiseLike(value) {
    return value != null && typeof value === 'object' && typeof value.then === 'function';
  }

  async function getCurrentPredictionAsync() {
    try {
      const raw = window.webgazer?.getCurrentPrediction?.();
      if (isPromiseLike(raw)) {
        return await raw;
      }
      return raw || null;
    } catch (error) {
      debugLog('get-prediction-error', { error: error?.message || String(error) });
      return null;
    }
  }

  window.getCurrentPredictionAsync = getCurrentPredictionAsync;

  function cacheControls() {
    controls.startBtn = document.getElementById('wg-start-calibration');
    controls.beginBtn = document.getElementById('wg-begin-hover');
    controls.stopBtn = document.getElementById('wg-stop-hover');
    controls.poseBtn = document.getElementById('wg-start-pose');
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
    if (controls.poseBtn) {
      controls.poseBtn.addEventListener('click', () => {
        startPoseCalibrationSequence();
      });
      state.poseBtnDefaultLabel = controls.poseBtn.textContent || 'Run Pose Calibration';
    }
  }

  function clearPoseBaselineMonitor(options = {}) {
    if (state.poseBaselineReadyMonitor) {
      clearInterval(state.poseBaselineReadyMonitor);
      state.poseBaselineReadyMonitor = null;
    }
    state.poseBaselineMonitorStartedAt = null;
    if (options.resetFallback) {
      state.poseBaselineFallbackTriggered = false;
    }
    state.poseDebug.lastMeasurementLog = 0;
    state.poseDebug.lastMissingLog = 0;
    state.poseDebug.missingActive = false;
    updatePoseBaselineProgressDisplay(null);
  }

  function markPoseBaselineUnavailable() {
    state.poseBaselineFallbackTriggered = true;
    updatePoseBaselineProgressDisplay(null);
    debugLog('pose-baseline-landmarks-missing');
    if (!controls.poseBtn) return;
    const label = state.poseBtnDefaultLabel || 'Run Pose Calibration';
    controls.poseBtn.textContent = `${label} — landmarks unavailable`;
  }

  function updatePoseBaselineProgressDisplay(progressPercent) {
    if (!controls.poseBtn) return;
    const label = state.poseBtnDefaultLabel || 'Run Pose Calibration';
    if (progressPercent == null || Number.isNaN(progressPercent)) {
      controls.poseBtn.textContent = label;
      return;
    }
    const clamped = clamp(Math.round(progressPercent), 0, 100);
    controls.poseBtn.textContent = `${label} — stabilising ${clamped}%`;
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
      state.stability.hardGateUntil = performance.now() + 1500;
      state.stability.stable = false;
      state.stability.stableSince = null;
      state.stability.unstableSince = null;
      if (controls.beginBtn) controls.beginBtn.disabled = true;
      if (controls.refineBtn) controls.refineBtn.disabled = true;
      await cleanupWebGazer({ hard: false });
      await startCalibrationWorkflow({ triggeredByCameraChange: true });
    } finally {
      state.restartInProgress = false;
    }
  }

  function applyCameraConstraint() {
    const gaze = window.webgazer;
    if (!gaze) return;
    const hasPublicSetter = typeof gaze.setCameraConstraints === 'function';
    const constraints = state.selectedCameraId
      ? { video: { deviceId: { exact: state.selectedCameraId } } }
      : { video: true };
    try {
      if (hasPublicSetter) {
        gaze.setCameraConstraints(constraints);
      } else if (gaze.params) {
        gaze.params.camConstraints = constraints;
      }
    } catch (error) {
      debugLog('camera-constraint-error', { error: error?.message || String(error) });
    }
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
    if (controls.poseBtn) controls.poseBtn.disabled = true;
    updatePoseBaselineProgressDisplay(null);
    state.indicatorAlwaysOn = false;
    clearPoseBaselineMonitor({ resetFallback: true });
    updateCustomGazeIndicator(null);
    state.poseTierActive = false;
    state.poseTierCapturing = false;
    state.poseTierHoldStart = null;
    if (state.poseTierTimer) {
      clearTimeout(state.poseTierTimer);
      state.poseTierTimer = null;
    }
    if (state.poseTierMonitor) {
      clearInterval(state.poseTierMonitor);
      state.poseTierMonitor = null;
    }
    state.predictionBuffer = [];
    debugLog('calibration-started', { cameraChange: triggeredByCameraChange });
    updateStatus('Loading WebGazer… please allow camera access.');
    try {
      await ensureWebGazerLoaded();
      const gaze = window.webgazer;
      if (!gaze) throw new Error('WebGazer unavailable after load.');

      applyCameraConstraint();

      try {
        if (typeof gaze.pause === 'function') await gaze.pause();
      } catch (error) {
        debugLog('webgazer-pause-warning', { error: error?.message || String(error) });
      }

      if (typeof gaze.clearData === 'function') {
        try {
          await gaze.clearData();
        } catch (error) {
          debugLog('webgazer-clear-warning', { error: error?.message || String(error) });
        }
      }

      ensureClmTrackerModuleRegistered();
      try {
        if (typeof gaze.setTracker === 'function') {
          gaze.setTracker('clmtrackr');
        }
      } catch (error) {
        debugLog('setTracker-error', { error: error?.message || String(error) });
      }

      try {
        if (typeof gaze.setRegression === 'function') {
          gaze.setRegression('ridge');
        }
      } catch (error) {
        debugLog('setRegression-error', { error: error?.message || String(error) });
      }

      if (typeof gaze.saveDataAcrossSessions === 'function') {
        try {
          gaze.saveDataAcrossSessions(false);
        } catch (error) {
          debugLog('save-data-sessions-error', { error: error?.message || String(error) });
        }
      } else {
        gaze.params.saveDataAcrossSessions = false;
      }

      applyCameraConstraint();

      if (typeof gaze.showPredictionPoints === 'function') {
        try {
          gaze.showPredictionPoints(true);
        } catch (error) {
          debugLog('show-prediction-points-error', { error: error?.message || String(error) });
        }
      } else if (gaze.params) {
        gaze.params.showGazeDot = true;
      }

      if (typeof gaze.setGazeListener === 'function') {
        gaze.setGazeListener(handleGazePrediction);
      }

      if (typeof gaze.begin === 'function') {
        await gaze.begin();
      }

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
          [1, 0, 0, 0, 0],
          [0, 1, 0, 0, 0]
        ],
        ready: false
      };
      state.smoothing = {
        history: [],
        smoothed: null,
        pendingJump: null
      };
      state.euro = new OneEuro({ minCutoff: 0.7, beta: 0.02, dCutoff: 1.0 });
      state.stability.lastRecomputeAt = 0;
      state.stability.hardGateUntil = performance.now() + 1500;
      state.stability.stable = false;
      state.stability.stableSince = null;
      state.stability.unstableSince = null;
      state.pose.baseline = { yaw: 0, pitch: 0, roll: 0, count: 0, ready: false };
      state.pose.smoothed = null;
      state.poseTierIndex = 0;
      state.poseTierActive = false;
      if (state.poseTierTimer) {
        clearTimeout(state.poseTierTimer);
        state.poseTierTimer = null;
      }
      if (state.poseTierMonitor) {
        clearInterval(state.poseTierMonitor);
        state.poseTierMonitor = null;
      }
      state.poseTierHoldStart = null;
      state.poseTierCapturing = false;
      state.indicatorAlwaysOn = false;
      state.lastRefinementAt = 0;
      state.flags = state.flags || {};
      if (typeof state.flags.lockTrackerToCLM !== 'boolean') {
        state.flags.lockTrackerToCLM = true;
      }
      if (state.trackerFallbackTimer) {
        clearInterval(state.trackerFallbackTimer);
        state.trackerFallbackTimer = null;
      }
      if (state.trackerFallbackDelay) {
        clearTimeout(state.trackerFallbackDelay);
        state.trackerFallbackDelay = null;
      }
      if (gaze) {
        const FALLBACK_PROBE_DELAY_MS = 9000;
        const FALLBACK_PROBE_INTERVAL_MS = 500;
        const FALLBACK_MIN_FRAMES = 180;
        const FALLBACK_REQUIRED_LOST_MS = 8000;
        const FALLBACK_STRIKES_TO_SWITCH = 4;

        const startProbe = () => {
          if (state.trackerFallbackTimer) {
            clearInterval(state.trackerFallbackTimer);
            state.trackerFallbackTimer = null;
          }
          let consecutiveStrikes = 0;
          let clmReacquireAttempts = 0;
          state.trackerFallbackTimer = setInterval(async () => {
            try {
              if (!state.webgazerReady) return;
              if (state.calibrationMode || state.poseTierActive || state.poseTierCapturing) return;
              const tracker = typeof gaze.getTracker === 'function' ? gaze.getTracker() : null;
              const name = (tracker?.name || tracker?.constructor?.name || '').toLowerCase();
              if (!name.includes('clm')) {
                clearInterval(state.trackerFallbackTimer);
                state.trackerFallbackTimer = null;
                return;
              }

              const sourceStatus = _resolveTrackTarget(null);
              if (!sourceStatus.videoReady) {
                return;
              }

              const health = typeof tracker?.getHealth === 'function' ? tracker.getHealth() : null;
              const frames = Number.isFinite(health?.frames) ? health.frames : 0;
              const points = Number.isFinite(health?.points) ? health.points : 0;
              const lastAt = Number.isFinite(health?.lastAt) ? health.lastAt : 0;
              const lastGoodAt = Number.isFinite(health?.lastGoodAt) ? health.lastGoodAt : 0;
              const score = Number.isFinite(health?.score) ? health.score : 0;
              const now = performance.now();
              const lostMs = lastAt ? (now - lastAt) : Infinity;
              const lostFromGoodMs = lastGoodAt ? (now - lastGoodAt) : Infinity;

              if ((points >= 32 && lostMs < 1200) || score >= 0.25) {
                debugLog('tracker-health-ok', { frames, points, score, lastAt, lastGoodAt });
                clearInterval(state.trackerFallbackTimer);
                state.trackerFallbackTimer = null;
                return;
              }

              const strike = frames >= 60 && lostMs >= 1500;
              consecutiveStrikes = strike ? (consecutiveStrikes + 1) : 0;

              if (
                lostFromGoodMs < 15000 &&
                lostMs >= 2500 &&
                frames >= 90 &&
                clmReacquireAttempts < 2
              ) {
                try {
                  if (tracker && typeof tracker._reacquire === 'function') {
                    tracker._reacquire();
                  }
                  clmReacquireAttempts += 1;
                  debugLog('tracker-clm-reacquire', { attempt: clmReacquireAttempts, frames, lostMs, points, score });
                  return;
                } catch (reacquireError) {
                  debugLog('tracker-clm-reacquire-error', { error: reacquireError?.message || String(reacquireError) });
                }
              }

              const longLost = frames >= FALLBACK_MIN_FRAMES && lostMs >= FALLBACK_REQUIRED_LOST_MS;
              if (longLost && consecutiveStrikes >= FALLBACK_STRIKES_TO_SWITCH) {
                if (state.flags?.lockTrackerToCLM) {
                  debugLog('tracker-stay-clm', { reason: 'lockTrackerToCLM', frames, lostMs, points, score });
                  consecutiveStrikes = 0;
                  return;
                }
                if (typeof gaze.setTracker === 'function') {
                  await gaze.setTracker('TFFacemesh');
                  debugLog('tracker-switched-fallback', { to: 'TFFacemesh', reason: { frames, lostMs, points, lastAt, score } });
                }
                clearInterval(state.trackerFallbackTimer);
                state.trackerFallbackTimer = null;
              }
            } catch (error) {
              debugLog('tracker-fallback-error', { error: error?.message || String(error) });
            }
          }, FALLBACK_PROBE_INTERVAL_MS);
        };

        state.trackerFallbackDelay = setTimeout(() => {
          state.trackerFallbackDelay = null;
          startProbe();
        }, FALLBACK_PROBE_DELAY_MS);
      }
    finalizeCalibrationCapture(true);
    if (controls.poseBtn) controls.poseBtn.disabled = true;
      state.calibrationConfig.stage = 'primary';
      state.calibrationConfig.primaryComplete = false;
      state.calibrationConfig.completed = false;
      state.calibrationConfig.points = [];
      state.calibrationConfig.counts = new Map();
      if (controls.poseBtn) controls.poseBtn.disabled = true;
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
    clearPoseBaselineMonitor({ resetFallback: true });
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
    state.stability.hardGateUntil = performance.now() + 1500;
    state.stability.stable = false;
    state.stability.stableSince = null;
    state.stability.unstableSince = null;
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
    clearPoseBaselineMonitor();
    state.hoverActive = true;
    state.indicatorAlwaysOn = true;
    state.calibrationMode = false;
    updateCustomGazeIndicator(state.smoothing.smoothed || null);
    state.predictionBuffer = [];
    state.dwellAnchor = null;
    state.dwellStart = 0;
    state.stability.hardGateUntil = performance.now() + 1200;
    state.stability.stable = false;
    state.stability.stableSince = null;
    state.stability.unstableSince = null;
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
    clearPoseBaselineMonitor();
    if (state.dwellAnchor) {
      clearHighlight(state.dwellAnchor);
      state.dwellAnchor = null;
    }
    state.dwellStart = 0;
    state.activeUrl = null;
    state.smoothX = null;
    state.smoothY = null;
    state.predictionBuffer = [];
    state.stability.hardGateUntil = 0;
    state.stability.stable = false;
    state.stability.stableSince = null;
    state.stability.unstableSince = null;
    if (state.trackerFallbackTimer) {
      clearInterval(state.trackerFallbackTimer);
      state.trackerFallbackTimer = null;
    }
    if (state.trackerFallbackDelay) {
      clearTimeout(state.trackerFallbackDelay);
      state.trackerFallbackDelay = null;
    }
    if (controls.startBtn) controls.startBtn.disabled = false;
    if (controls.stopBtn) controls.stopBtn.disabled = true;
    state.indicatorAlwaysOn = true;
    updateCustomGazeIndicator(state.smoothing.smoothed || null);
    updateStatus('Hover mode paused. You can resume after recalibrating if needed.');
  }

  async function selectAvailableTracker(gaze) {
    if (!gaze) {
      debugLog('tracker-selection-skipped', { reason: 'no-gaze-instance' });
      return;
    }
    ensureClmTrackerModuleRegistered();

    let available = [];
    let source = 'unknown';
    if (typeof gaze.getAvailableTrackers === 'function') {
      try {
        available = gaze.getAvailableTrackers() || [];
        source = 'getAvailableTrackers';
      } catch (error) {
        debugLog('tracker-list-error', { error: error?.message || String(error) });
      }
    }

    if (!available.length && gaze.algorithms && typeof gaze.algorithms === 'object') {
      const trackerKeys = Object.keys(gaze.algorithms.trackers || {});
      if (trackerKeys.length) {
        available = trackerKeys;
        source = 'algorithms.trackers';
      }
    }

    if (!available.length && window.webgazerGlobalSettings && Array.isArray(window.webgazerGlobalSettings.trackers)) {
      available = [...window.webgazerGlobalSettings.trackers];
      source = 'globalSettings';
    }

    debugLog('tracker-available', { list: available, source });

    if (typeof gaze.setTracker !== 'function') {
      debugLog('tracker-selection-skipped', { reason: 'setTracker-missing' });
      return;
    }

    const normalized = new Set(available.map((name) => String(name || '').toLowerCase()));
    const attempted = new Set();
    const candidateMatrix = [
      { canonical: 'clmtrackr', options: ['clmtrackr', 'clmtrackr + ridge', 'clm', 'clmtracker'] },
      { canonical: 'TFFacemesh', options: ['tffacemesh', 'tf facemesh', 'facemesh'] },
      { canonical: 'No stream', options: ['no stream', 'nostream'] }
    ];

    for (const candidate of candidateMatrix) {
      const alias = candidate.options.find((opt) => normalized.has(opt.toLowerCase()));
      if (!alias) continue;
      attempted.add(alias.toLowerCase());
      try {
        // eslint-disable-next-line no-await-in-loop
        await gaze.setTracker(alias);
        debugLog('tracker-selected', { tracker: alias, canonical: candidate.canonical });
        return;
      } catch (error) {
        debugLog('tracker-select-failed', { tracker: alias, error: error?.message || String(error) });
      }
    }

    const forcedCandidates = ['clmtrackr', 'clmtrackr + ridge'];
    for (const forced of forcedCandidates) {
      const key = forced.toLowerCase();
      if (attempted.has(key)) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await gaze.setTracker(forced);
        debugLog('tracker-selected-forced', { tracker: forced });
        return;
      } catch (error) {
        debugLog('tracker-select-forced-failed', { tracker: forced, error: error?.message || String(error) });
      }
    }

    if (available.length) {
      const fallback = available[0];
      try {
        await gaze.setTracker(fallback);
        debugLog('tracker-selected-fallback', { tracker: fallback });
      } catch (error) {
        debugLog('tracker-select-fallback-failed', { tracker: fallback, error: error?.message || String(error) });
      }
    } else {
      debugLog('tracker-selection-skipped', { reason: 'no-trackers-detected' });
    }
  }

  async function ensureWebGazerLoaded() {
    if (window.webgazer) {
      await ensureClmTrackrLoaded();
      ensureClmTrackerModuleRegistered();
      debugLog('webgazer-present');
      return window.webgazer;
    }

    await ensureClmTrackrLoaded();

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
          debugLog('webgazer-loaded', { src });
          ensureClmTrackerModuleRegistered();
          return window.webgazer;
        }
      } catch (error) {
        console.warn('[WebGazer Prototype] Failed to load', src, error);
        debugLog('webgazer-load-failed', { src, error: error?.message || String(error) });
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

  async function ensureClmTrackrLoaded() {
    if (window.clm?.tracker) {
      debugLog('clmtrackr-present', { source: 'global' });
      const hasModel = Boolean(window.pModel || (window.clm && window.clm.models && window.clm.models.faceModel));
      if (!hasModel) {
        if (!clmModelEnsurePromise) {
          clmModelEnsurePromise = loadScript('https://unpkg.com/clmtrackr@1.1.2/models/model_pca_20_svm.js')
            .then(() => {
              debugLog('clmtrackr-model-loaded');
            })
            .catch((error) => {
              debugLog('clmtrackr-model-missing', { error: error?.message || String(error) });
              throw error;
            })
            .finally(() => {
              clmModelEnsurePromise = null;
            });
        }
        try {
          await clmModelEnsurePromise;
        } catch (_error) {
          // model load failed; continue so caller can handle downstream
        }
      }
      return;
    }

    if (clmEnsurePromise) {
      await clmEnsurePromise;
      return;
    }

    clmEnsurePromise = (async () => {
      const candidateUrls = [];
      try {
        const runtimeApi = globalThis.chrome && globalThis.chrome.runtime;
        if (runtimeApi && typeof runtimeApi.getURL === 'function') {
          candidateUrls.push(runtimeApi.getURL('vendor/clmtrackr.js'));
        }
      } catch (error) {
        debugLog('clmtrackr-runtime-url-error', { error: error?.message || String(error) });
      }
      candidateUrls.push('../vendor/clmtrackr.js');
      candidateUrls.push('vendor/clmtrackr.js');
      candidateUrls.push('https://unpkg.com/clmtrackr@1.1.2/build/clmtrackr.js');

      for (const src of candidateUrls) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await loadScript(src);
          if (window.clm?.tracker) {
            debugLog('clmtrackr-loaded', { src });
            const hasModel = Boolean(window.pModel || (window.clm && window.clm.models && window.clm.models.faceModel));
            if (!hasModel) {
              if (!clmModelEnsurePromise) {
                clmModelEnsurePromise = loadScript('https://unpkg.com/clmtrackr@1.1.2/models/model_pca_20_svm.js')
                  .then(() => {
                    debugLog('clmtrackr-model-loaded', { via: 'module-load' });
                  })
                  .catch((error) => {
                    debugLog('clmtrackr-model-missing', { error: error?.message || String(error), via: 'module-load' });
                    throw error;
                  })
                  .finally(() => {
                    clmModelEnsurePromise = null;
                  });
              }
              try {
                await clmModelEnsurePromise;
              } catch (_error) {
                // continue even if the model fails to load; downstream logic will handle fallback
              }
            }
            return;
          }
          debugLog('clmtrackr-no-global', { src });
        } catch (error) {
          debugLog('clmtrackr-load-failed', { src, error: error?.message || String(error) });
        }
      }
      debugLog('clmtrackr-unavailable');
    })();

    await clmEnsurePromise;
  }

  function createKalmanPair() {
    const wg = window.webgazer;
    const numericLib = window.numeric;
    const KalmanFilter = wg?.util?.KalmanFilter;
    if (!wg || !numericLib || typeof KalmanFilter !== 'function') {
      debugLog('clmtrackr-kalman-unavailable', {
        hasWebgazer: Boolean(wg),
        hasNumeric: Boolean(numericLib),
        hasKalman: typeof KalmanFilter === 'function'
      });
      return null;
    }
    const F = [
      [1, 0, 0, 0, 1, 0],
      [0, 1, 0, 0, 0, 1],
      [0, 0, 1, 0, 1, 0],
      [0, 0, 0, 1, 0, 1],
      [0, 0, 0, 0, 1, 0],
      [0, 0, 0, 0, 0, 1]
    ];
    const baseQ = [
      [0.25, 0, 0, 0, 0.5, 0],
      [0, 0.25, 0, 0, 0, 0.5],
      [0, 0, 0.25, 0, 0.5, 0],
      [0, 0, 0, 0.25, 0, 0.5],
      [0.5, 0, 0.5, 0, 1, 0],
      [0, 0.5, 0, 0.5, 0, 1]
    ];
    const H = [
      [1, 0, 0, 0, 0, 0],
      [0, 1, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0],
      [0, 0, 0, 1, 0, 0]
    ];
    const deltaT = 0.1;
    const Q = numericLib.mul(baseQ, deltaT);
    const pixelError = 6.5;
    const R = numericLib.mul(numericLib.identity(4), pixelError);
    const P0 = numericLib.mul(numericLib.identity(6), 0.0001);
    const x0 = [[200], [150], [250], [180], [0], [0]];

    return {
      left: new KalmanFilter(F, H, Q, R, P0, x0),
      right: new KalmanFilter(F, H, Q, R, P0, x0)
    };
  }

  function clampRect(x, y, width, height, maxWidth, maxHeight) {
    let rectX = Math.max(0, Math.min(x, maxWidth - 1));
    let rectY = Math.max(0, Math.min(y, maxHeight - 1));
    let rectW = Math.max(1, Math.min(width, maxWidth - rectX));
    let rectH = Math.max(1, Math.min(height, maxHeight - rectY));
    return { x: rectX, y: rectY, width: rectW, height: rectH };
  }

  function _resolveTrackTarget(imageCanvas) {
    const video = document.getElementById('webgazerVideo') || document.getElementById('webgazerVideoFeed') || null;
    const canvas = imageCanvas || document.getElementById('webgazerVideoCanvas') || null;
    const haveVideo = Boolean(
      video &&
      (video.readyState >= (video.HAVE_CURRENT_DATA || 2)) &&
      video.videoWidth > 0 &&
      video.videoHeight > 0
    );
    const target = haveVideo ? video : null;
    const width = target ? (target.videoWidth || target.width || 0) : 0;
    const height = target ? (target.videoHeight || target.height || 0) : 0;
    return {
      video,
      canvas,
      target,
      videoReady: haveVideo,
      width,
      height
    };
  }

  function _isFeedMirrored() {
    try {
      const wg = window.webgazer;
      if (wg && wg.params && typeof wg.params.flipVideo === 'boolean') {
        return Boolean(wg.params.flipVideo);
      }
      const feed = document.getElementById('webgazerVideoFeed');
      if (!feed) return false;
      const cs = getComputedStyle(feed);
      const transform = cs.transform || cs.webkitTransform || '';
      if (!transform || transform === 'none') {
        return false;
      }
      const match = transform.match(/matrix\(([^)]+)\)/);
      if (match) {
        const first = parseFloat(match[1].split(',')[0]);
        return Number.isFinite(first) && first < 0;
      }
      return /scaleX\(\s*-1/.test(transform) || /scale\(\s*-1\s*,\s*1/.test(transform);
    } catch (_error) {
      return false;
    }
  }

  function ensureClmTrackerModuleRegistered() {
    if (clmTrackerModuleReady) {
      return;
    }

    const wg = window.webgazer;
    if (!wg || typeof wg.addTrackerModule !== 'function') {
      debugLog('clmtracker-register-skipped', { reason: 'webgazer-unavailable' });
      return;
    }
    if (!window.clm || !window.clm.tracker) {
      debugLog('clmtracker-register-skipped', { reason: 'clmtrackr-missing' });
      return;
    }
    if (wg.tracker?.ClmTrackr) {
      clmTrackerModuleReady = true;
      return;
    }

    function getVideoEl() {
      return document.getElementById('webgazerVideo') ||
             document.getElementById('webgazerVideoFeed') || null;
    }

    function videoReady(videoEl) {
      return Boolean(
        videoEl &&
        (videoEl.readyState >= (videoEl.HAVE_CURRENT_DATA || 2)) &&
        videoEl.videoWidth > 0 &&
        videoEl.videoHeight > 0
      );
    }

    function resolveTrackTarget(imageCanvas) {
      const videoEl = getVideoEl();
      const ready = videoReady(videoEl);
      return {
        video: videoEl,
        videoReady: ready,
        width: ready ? videoEl.videoWidth : 0,
        height: ready ? videoEl.videoHeight : 0,
        canvas: imageCanvas || document.getElementById('webgazerVideoCanvas') || null
      };
    }

    function isMirrored(videoEl) {
      try {
        if (wg?.params && typeof wg.params.flipVideo === 'boolean') {
          return Boolean(wg.params.flipVideo);
        }
        const computed = getComputedStyle(videoEl);
        const transform = computed.transform || computed.webkitTransform || '';
        if (!transform || transform === 'none') {
          return false;
        }
        const match = transform.match(/matrix\(([^)]+)\)/);
        if (!match) {
          return false;
        }
        const a = parseFloat(match[1].split(',')[0]);
        return Number.isFinite(a) && a < 0;
      } catch (_error) {
        return false;
      }
    }

  const ClmTrackrAdapter = function() {
    this.clm = null;
    try {
      const params = Object.assign({ useWebGL: true }, wg?.params?.clmParams || {});
      this.clm = new window.clm.tracker(params);
        const model = window.pModel || window.clm?.models?.faceModel || undefined;
        this.clm.init(model);
      } catch (error) {
        debugLog('clmtrackr-init-error', { error: error?.message || String(error) });
        this.clm = null;
      }

      this._started = false;
      this._starting = false;
      this._armed = false;
    this._startHandler = null;
    this._frames = 0;
    this._lastPositionsAt = 0;
    this.positionsArray = null;
    this._lastGoodAt = 0;
    this._restarts = 0;
  };

  ClmTrackrAdapter.prototype._startOnce = function() {
    const videoEl = getVideoEl();
      if (!videoEl) {
        return false;
      }
      if (this._started || this._starting) {
        return this._started;
      }

      const startOnVideo = () => {
        if (this._started || this._starting) {
          return;
        }
        if (!videoReady(videoEl) || !this.clm || typeof this.clm.start !== 'function') {
          return;
        }
        this._starting = true;
        try {
          try { videoEl.removeEventListener('loadeddata', this._startHandler); } catch (_err) {}
          try { videoEl.removeEventListener('canplay', this._startHandler); } catch (_err) {}
          this._startHandler = null;

          this.clm.start(videoEl);
          this._started = true;
          this._frames = 0;
          this._lastPositionsAt = performance.now();
          debugLog('clmtrackr-started', {
            width: videoEl.videoWidth,
            height: videoEl.videoHeight,
            mirrored: isMirrored(videoEl)
          });
        } catch (error) {
          debugLog('clmtrackr-start-error', { error: error?.message || String(error) });
        } finally {
          this._starting = false;
          this._armed = false;
        }
      };

      if (videoReady(videoEl)) {
        startOnVideo();
        return this._started;
      }

      if (!this._armed) {
        this._armed = true;
        this._startHandler = () => startOnVideo();
        videoEl.addEventListener('loadeddata', this._startHandler, { once: true });
        videoEl.addEventListener('canplay', this._startHandler, { once: true });
      }
      return false;
    };

    ClmTrackrAdapter.prototype.trackFrame = function(imageCanvas) {
      if (!this.clm) {
        return null;
      }
      if (!this._started && !this._starting) {
        if (!this._startOnce()) {
          return null;
        }
      }
      let positions = null;
      try {
        positions = this.clm.getCurrentPosition ? this.clm.getCurrentPosition() : null;
      } catch (error) {
        debugLog('clmtrackr-getPositions-error', { error: error?.message || String(error) });
        return null;
      }
    this._frames += 1;
    if (Array.isArray(positions) && positions.length) {
      this.positionsArray = positions;
      this._lastPositionsAt = performance.now();
      if (positions.length >= 32) {
        this._lastGoodAt = this._lastPositionsAt;
      }
      return positions;
    }
    return null;
  };

    ClmTrackrAdapter.prototype.getEyePatches = function(imageCanvas) {
      if (!imageCanvas || imageCanvas.width === 0) {
        return null;
      }

      const positions = this.trackFrame(imageCanvas);
      if (!Array.isArray(positions) || positions.length < 33) {
        return false;
      }

      const source = resolveTrackTarget(imageCanvas);
      const width = source.width || imageCanvas.width;
      const height = source.height || imageCanvas.height;
      const scaleX = width ? (imageCanvas.width / width) : 1;
      const scaleY = height ? (imageCanvas.height / height) : 1;

      let leftX0 = positions[23][0] * scaleX;
      let leftY0 = positions[24][1] * scaleY;
      let leftX1 = positions[25][0] * scaleX;
      let leftY1 = positions[26][1] * scaleY;
      let rightX0 = positions[30][0] * scaleX;
      let rightY0 = positions[29][1] * scaleY;
      let rightX1 = positions[28][0] * scaleX;
      let rightY1 = positions[31][1] * scaleY;

      let leftMinX = Math.min(leftX0, leftX1);
      let leftMaxX = Math.max(leftX0, leftX1);
      let leftMinY = Math.min(leftY0, leftY1);
      let leftMaxY = Math.max(leftY0, leftY1);
      let rightMinX = Math.min(rightX0, rightX1);
      let rightMaxX = Math.max(rightX0, rightX1);
      let rightMinY = Math.min(rightY0, rightY1);
      let rightMaxY = Math.max(rightY0, rightY1);

      const leftPadX = Math.max(2, 0.1 * (leftMaxX - leftMinX));
      const leftPadY = Math.max(2, 0.1 * (leftMaxY - leftMinY));
      const rightPadX = Math.max(2, 0.1 * (rightMaxX - rightMinX));
      const rightPadY = Math.max(2, 0.1 * (rightMaxY - rightMinY));

      leftMinX = Math.max(0, Math.floor(leftMinX - leftPadX));
      leftMaxX = Math.min(imageCanvas.width, Math.ceil(leftMaxX + leftPadX));
      leftMinY = Math.max(0, Math.floor(leftMinY - leftPadY));
      leftMaxY = Math.min(imageCanvas.height, Math.ceil(leftMaxY + leftPadY));

      rightMinX = Math.max(0, Math.floor(rightMinX - rightPadX));
      rightMaxX = Math.min(imageCanvas.width, Math.ceil(rightMaxX + rightPadX));
      rightMinY = Math.max(0, Math.floor(rightMinY - rightPadY));
      rightMaxY = Math.min(imageCanvas.height, Math.ceil(rightMaxY + rightPadY));

      const leftWidth = Math.max(1, leftMaxX - leftMinX);
      const leftHeight = Math.max(1, leftMaxY - leftMinY);
      const rightWidth = Math.max(1, rightMaxX - rightMinX);
      const rightHeight = Math.max(1, rightMaxY - rightMinY);

      if (leftWidth <= 0 || leftHeight <= 0 || rightWidth <= 0 || rightHeight <= 0) {
        return false;
      }

      let leftPatch = null;
      let rightPatch = null;
      try {
        const ctx = imageCanvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          return null;
        }
        leftPatch = ctx.getImageData(leftMinX, leftMinY, leftWidth, leftHeight);
        rightPatch = ctx.getImageData(rightMinX, rightMinY, rightWidth, rightHeight);
      } catch (_error) {
        return false;
      }

      return {
        left: {
          patch: leftPatch,
          imagex: leftMinX,
          imagey: leftMinY,
          width: leftWidth,
          height: leftHeight,
          blink: false
        },
        right: {
          patch: rightPatch,
          imagex: rightMinX,
          imagey: rightMinY,
          width: rightWidth,
          height: rightHeight,
          blink: false
        },
        positions
      };
  };

  ClmTrackrAdapter.prototype.getPositions = function() {
    try {
      return this.clm?.getCurrentPosition?.() || this.positionsArray || null;
    } catch (_error) {
      return this.positionsArray || null;
    }
  };

  ClmTrackrAdapter.prototype.drawFaceOverlay = function(ctxOrCanvas, positionsArg) {
    try {
      let ctx = null;
      if (ctxOrCanvas && typeof ctxOrCanvas.canvas === 'object' && typeof ctxOrCanvas.beginPath === 'function') {
        ctx = ctxOrCanvas;
      } else if (ctxOrCanvas && typeof ctxOrCanvas.getContext === 'function') {
        ctx = ctxOrCanvas.getContext('2d', { willReadFrequently: true });
      } else {
        const fallback = document.getElementById('webgazerFaceOverlay') ||
          document.getElementById('webgazerVideoCanvas');
        if (fallback && typeof fallback.getContext === 'function') {
          ctx = fallback.getContext('2d', { willReadFrequently: true });
        }
      }

      if (!ctx) {
        return false;
      }

      const canvas = ctx.canvas || null;
      try {
        if (canvas) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      } catch (_error) {
        // ignore clear failures; continue rendering
      }

      if (this.clm && typeof this.clm.draw === 'function' && canvas) {
        this.clm.draw(canvas);
        return true;
      }

      const points = Array.isArray(positionsArg) && positionsArg.length
        ? positionsArg
        : (Array.isArray(this.positionsArray) && this.positionsArray.length ? this.positionsArray : null);
      if (!points || !canvas) {
        return true;
      }

      const target = resolveTrackTarget(null);
      const scaleX = target && target.width ? (canvas.width / target.width) : 1;
      const scaleY = target && target.height ? (canvas.height / target.height) : 1;

      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.9)';

      for (let i = 0; i < points.length; i += 1) {
        const point = points[i];
        if (!point || point.length < 2) {
          continue;
        }
        const x = point[0] * scaleX;
        const y = point[1] * scaleY;
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, 2 * Math.PI);
        ctx.stroke();
      }

      ctx.restore();
      return true;
    } catch (error) {
      debugLog('clmtrackr-drawFaceOverlay-error', { error: error?.message || String(error) });
      return false;
    }
  };

  ClmTrackrAdapter.prototype.drawEyeFeatures = function() {
    return true;
  };

  ClmTrackrAdapter.prototype.getHealth = function() {
    const now = performance.now();
    let points = 0;
    let score = 0;
    try {
      score = typeof this.clm?.getScore === 'function' ? (this.clm.getScore() || 0) : 0;
      const latest = this.clm?.getCurrentPosition?.();
      if (Array.isArray(latest)) {
        points = latest.length;
      }
    } catch (_error) {
      points = Array.isArray(this.positionsArray) ? this.positionsArray.length : 0;
    }
    return {
      recent: Boolean(this._lastPositionsAt && (now - this._lastPositionsAt) < 1600),
      lastAt: this._lastPositionsAt || 0,
      lastGoodAt: this._lastGoodAt || 0,
      frames: this._frames || 0,
      points,
      score
    };
  };

  ClmTrackrAdapter.prototype._reacquire = function() {
    try {
      this.reset();
    } catch (_error) {
      // ignore reset failures; we'll try to start again below
    }
    this._restarts = (this._restarts || 0) + 1;
    this._startOnce();
  };

  ClmTrackrAdapter.prototype.reset = function() {
    const videoEl = getVideoEl();
    if (this._startHandler && videoEl) {
      try { videoEl.removeEventListener('loadeddata', this._startHandler); } catch (_err) {}
      try { videoEl.removeEventListener('canplay', this._startHandler); } catch (_err) {}
    }
    this._startHandler = null;
    this._armed = false;

    try { this.clm?.stop && this.clm.stop(); } catch (_err) {}
    try { this.clm?.reset && this.clm.reset(); } catch (_err) {}

    this._started = false;
    this._starting = false;
    this._frames = 0;
    this._lastPositionsAt = 0;
    this.positionsArray = null;
    this._lastGoodAt = 0;
    this.createKalmanFilters();
  };

  ClmTrackrAdapter.prototype.name = 'clmtrackr';

  wg.tracker = wg.tracker || {};
  wg.tracker.ClmTrackr = ClmTrackrAdapter;
  try {
    wg.addTrackerModule('clmtrackr', ClmTrackrAdapter);
    clmTrackerModuleReady = true;
    debugLog('tracker-module-registered', { tracker: 'clmtrackr' });
  } catch (error) {
    debugLog('clmtracker-register-failed', { error: error?.message || String(error) });
  }
}


  function handleGazePrediction(data /*, timestamp */) {
    if (!data) {
      updateCustomGazeIndicator(null);
      return;
    }

    const poseMeasurement = extractHeadPose();
    updatePoseState(poseMeasurement);

    const rawPoint = { x: data.x, y: data.y };
    captureCalibrationSample(rawPoint);

    const calibrated = applyCalibrationTransform(rawPoint);
    const smoothedPoint = smoothCalibratedPoint(calibrated);
    updateCustomGazeIndicator(smoothedPoint);

    // Always accumulate samples so the stability window can become "ready"
    addPredictionSample(smoothedPoint);

    if (state.calibrationMode) {
      return;
    }
    if (!state.hoverActive) {
      return;
    }

    const stability = computeStability();
    const unstable = !stability.ready || !stability.stable;
    const inHardWarmup = performance.now() < (state.stability.hardGateUntil || 0);

    if (unstable) {
      hideTooltip();
      if (state.dwellAnchor) {
        clearHighlight(state.dwellAnchor);
        state.dwellAnchor = null;
      }
      state.dwellStart = 0;
    }
    // During the brief hard warmup we still skip dwell triggers,
    // BUT we do not starve the buffer anymore (we already added the sample).
    if (unstable && inHardWarmup) {
      return;
    }
    if (unstable) {
      return;
    }

    let threshold = state.customDwell || DWELL_THRESHOLD_MS;
    if (stability.ready && stability.thresholds) {
      const maxStdPx = Math.max(1, stability.thresholds.maxStdPx || 1);
      const jitterRatio = Math.min(1, (stability.stdX + stability.stdY) / (2 * maxStdPx));
      threshold = Math.round(threshold * (1 + 0.5 * jitterRatio));
    }
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
    if (!state.calibrationMode) {
      requestRefinementCapture(anchor);
    }

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
    const gaze = window.webgazer;
    if (!gaze) return;

    const x = event.clientX;
    const y = event.clientY;
    const rect = point.getBoundingClientRect();
      const targetX = rect.left + rect.width / 2;
      const targetY = rect.top + rect.height / 2;
      beginCalibrationCapture(targetX, targetY, 'calibration');

      try {
        if (typeof gaze.recordScreenPosition === 'function') {
          gaze.recordScreenPosition(targetX, targetY, 'click');
        }
      } catch (error) {
        debugLog('record-screen-position-error', { error: error?.message || String(error) });
      }

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
        finalizeCalibrationCapture();
        clearPoseBaselineMonitor();
        if (controls.refineBtn) controls.refineBtn.disabled = false;
        if (state.pose.baseline.ready) {
          updateStatus('Baseline calibration complete! When ready, click “Run Pose Calibration” to align head movement.', STATUS_OK);
          if (controls.poseBtn) {
            controls.poseBtn.disabled = false;
            controls.poseBtn.focus({ preventScroll: true });
          }
        } else {
          updateStatus('Baseline calibration complete! Hold centered while we stabilise your neutral pose…', STATUS_OK);
          const base = state.pose.baseline;
          const initialProgress = base ? Math.min(100, (base.count / POSE_BASELINE_TARGET) * 100) : 0;
          updatePoseBaselineProgressDisplay(initialProgress);
          state.poseBaselineMonitorStartedAt = performance.now();
          state.poseBaselineReadyMonitor = setInterval(() => {
            const base = state.pose.baseline;
            if (!base) return;
            if (base.ready) {
              clearPoseBaselineMonitor();
              updateStatus('Neutral pose locked in! When ready, click “Run Pose Calibration”.', STATUS_OK);
              if (controls.poseBtn) {
                controls.poseBtn.disabled = false;
                controls.poseBtn.focus({ preventScroll: true });
              }
              if (controls.refineBtn) controls.refineBtn.disabled = false;
              debugLog('pose-baseline-ready', { count: base.count });
              return;
            }
            const progress = Math.min(100, (base.count / POSE_BASELINE_TARGET) * 100);
            updatePoseBaselineProgressDisplay(progress);
            updateStatus(`Baseline calibration complete! Stabilising head pose… ${Math.round(progress)}%`, STATUS_OK);
            debugLog('pose-baseline-progress', { count: base.count, progress, tracker: window.webgazer?.getTracker?.()?.clm ? 'clmtrackr' : window.webgazer?.getTracker?.()?.name || 'unknown' });
            if (!state.poseBaselineFallbackTriggered && base.count === 0 && state.poseBaselineMonitorStartedAt && (performance.now() - state.poseBaselineMonitorStartedAt) > POSE_BASELINE_FALLBACK_MS) {
              base.ready = true;
              base.count = POSE_BASELINE_MIN_FRAMES;
              base.yaw = 0;
              base.pitch = 0;
              base.roll = 0;
              markPoseBaselineUnavailable();
              clearPoseBaselineMonitor();
              updateStatus('Head pose landmarks unavailable — proceeding with a neutral pose baseline.', STATUS_WARN);
              debugLog('pose-baseline-fallback', { tracker: window.webgazer?.getCurrentTracker?.() || window.webgazer?.getTracker?.()?.name });
              if (controls.poseBtn) {
                controls.poseBtn.disabled = false;
                controls.poseBtn.focus({ preventScroll: true });
              }
              if (controls.refineBtn) controls.refineBtn.disabled = false;
            }
          }, 180);
        }
        state.indicatorAlwaysOn = true;
        updateCustomGazeIndicator(state.smoothing.smoothed || null);
        return;
      } else {
        updateStatus('Fine-tune calibration complete! Begin gaze hover when ready.', STATUS_OK);
        if (controls.beginBtn) controls.beginBtn.disabled = false;
        if (controls.refineBtn) controls.refineBtn.disabled = true;
        finalizeCalibrationCapture();
        teardownCalibrationTargets();
      }
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
      cleanupWebGazer({ hard: true });
    });
  }

  function cleanupWebGazer(options = { hard: false }) {
    if (window.webgazer) {
      try {
        window.webgazer.pause();
        if (options.hard && typeof window.webgazer.end === 'function') {
          window.webgazer.end();
        }
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
    state.stability.hardGateUntil = 0;
    state.stability.stable = false;
    state.stability.stableSince = null;
    state.stability.unstableSince = null;
    if (state.trackerFallbackTimer) {
      clearInterval(state.trackerFallbackTimer);
      state.trackerFallbackTimer = null;
    }
    if (state.trackerFallbackDelay) {
      clearTimeout(state.trackerFallbackDelay);
      state.trackerFallbackDelay = null;
    }
    updateCustomGazeIndicator(null);
    finalizeCalibrationCapture(true);
    clearPoseBaselineMonitor();
    state.calibrationConfig.stage = 'primary';
    state.calibrationSamples = [];
    state.calibrationTransform = {
      matrix: [
        [1, 0, 0, 0, 0],
        [0, 1, 0, 0, 0]
      ],
      ready: false
    };
    state.smoothing = {
      history: [],
      smoothed: null,
      pendingJump: null
    };
    state.euro = null;
    state.stability.lastRecomputeAt = 0;
    state.pose.baseline = { yaw: 0, pitch: 0, roll: 0, count: 0, ready: false };
    state.pose.smoothed = null;
    state.poseTierIndex = 0;
    state.poseTierActive = false;
    if (state.poseTierTimer) {
      clearTimeout(state.poseTierTimer);
      state.poseTierTimer = null;
    }
    state.lastRefinementAt = 0;
    teardownCalibrationTargets();
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
    let container = document.getElementById('webgazerVideoContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'webgazerVideoContainer';
      document.body.appendChild(container);
    }
    Object.assign(container.style, {
      position: 'fixed',
      top: '16px',
      left: '16px',
      width: '320px',
      height: '240px',
      opacity: '1',
      pointerEvents: 'none',
      zIndex: '2147483630'
    });

    let videoCanvas = document.getElementById('webgazerVideoCanvas');
    if (!videoCanvas) {
      videoCanvas = document.createElement('canvas');
      videoCanvas.id = 'webgazerVideoCanvas';
      videoCanvas.width = 320;
      videoCanvas.height = 240;
      document.body.appendChild(videoCanvas);
    }
    Object.assign(videoCanvas.style, {
      position: 'fixed',
      top: '16px',
      left: '16px',
      opacity: '1',
      pointerEvents: 'none',
      zIndex: '2147483629'
    });
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

    let faceOverlay = document.getElementById('webgazerFaceOverlay');
    if (!faceOverlay) {
      faceOverlay = document.createElement('canvas');
      faceOverlay.id = 'webgazerFaceOverlay';
      faceOverlay.width = 320;
      faceOverlay.height = 240;
      document.body.appendChild(faceOverlay);
    }
    Object.assign(faceOverlay.style, {
      position: 'fixed',
      top: '16px',
      left: '16px',
      opacity: '1',
      pointerEvents: 'none',
      zIndex: '2147483631'
    });

    let faceFeedback = document.getElementById('webgazerFaceFeedbackBox');
    if (!faceFeedback) {
      faceFeedback = document.createElement('div');
      faceFeedback.id = 'webgazerFaceFeedbackBox';
      document.body.appendChild(faceFeedback);
    }
    Object.assign(faceFeedback.style, {
      position: 'fixed',
      top: '16px',
      left: '16px',
      width: '320px',
      height: '240px',
      opacity: '1',
      pointerEvents: 'none',
      zIndex: '2147483631'
    });

    const videoFeed = document.getElementById('webgazerVideoFeed');
    if (videoFeed) {
      Object.assign(videoFeed.style, {
        position: 'fixed',
        top: '16px',
        left: '16px',
        width: videoFeed.videoWidth ? `${videoFeed.videoWidth}px` : '320px',
        height: videoFeed.videoHeight ? `${videoFeed.videoHeight}px` : '240px',
        opacity: '1',
        pointerEvents: 'none',
        zIndex: '2147483632'
      });
    }

    // Mirror WebGazer defaults so internal cleanup succeeds.
    window.webgazer?.params && (window.webgazer.params.showVideoPreview = false);
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
    if (message !== state.lastStatusMessage) {
      debugLog('status', { message, tone: color || 'default' });
      state.lastStatusMessage = message;
    }
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
  const shouldShow =
    state.calibrationMode ||
    state.poseTierActive ||
    state.poseTierCapturing ||
    state.hoverActive ||
    state.indicatorAlwaysOn;

  let point = sample;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    point = state.smoothing.smoothed || null;
  }

  if (!shouldShow || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    dot.style.display = 'none';
    return;
  }

  if (state.calibrationMode || state.poseTierActive || state.poseTierCapturing) {
    dot.style.background = 'rgba(239, 68, 68, 0.95)';
    dot.style.border = '2px solid #b91c1c';
    dot.style.boxShadow = '0 0 8px rgba(239, 68, 68, 0.55)';
    dot.style.opacity = '1';
    dot.style.width = '18px';
    dot.style.height = '18px';
  } else {
    dot.style.background = 'rgba(37, 99, 235, 0.65)';
    dot.style.border = '1px solid rgba(30, 64, 175, 0.9)';
    dot.style.boxShadow = '0 0 6px rgba(37, 99, 235, 0.45)';
    dot.style.opacity = '0.85';
    dot.style.width = '14px';
    dot.style.height = '14px';
  }

  dot.style.left = `${point.x}px`;
  dot.style.top = `${point.y}px`;
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

  function computeStability() {
    const now = performance.now();
    const buffer = state.predictionBuffer.filter((sample) => now - sample.t <= STABILITY_WINDOW_MS);
    const n = buffer.length;
    if (n < STABILITY_MIN_SAMPLES) {
      return { ready: false, stable: false, stdX: Infinity, stdY: Infinity, speed: Infinity };
    }

    const xs = buffer.map((sample) => sample.x).sort((a, b) => a - b);
    const ys = buffer.map((sample) => sample.y).sort((a, b) => a - b);
    const med = (arr) => arr[Math.floor(arr.length / 2)] ?? 0;
    const medX = med(xs);
    const medY = med(ys);
    const mad = (arr, midpoint) => med(arr.map((value) => Math.abs(value - midpoint)));
    const stdX = 1.4826 * mad(xs, medX);
    const stdY = 1.4826 * mad(ys, medY);

    const speeds = [];
    for (let i = 1; i < n; i += 1) {
      const dx = buffer[i].x - buffer[i - 1].x;
      const dy = buffer[i].y - buffer[i - 1].y;
      const dt = Math.max(0.001, (buffer[i].t - buffer[i - 1].t) / 1000);
      speeds.push(Math.hypot(dx, dy) / dt);
    }
    speeds.sort((a, b) => a - b);
    const trim = Math.max(0, Math.floor(speeds.length * 0.1));
    const upperBound = Math.max(trim, speeds.length - trim);
    const trimmed = speeds.slice(trim, upperBound);
    const speed = trimmed.length ? trimmed.reduce((acc, value) => acc + value, 0) / trimmed.length : 0;

    const diag = Math.hypot(window.innerWidth || 0, window.innerHeight || 0) || 2000;
    const calibrationCount = state.calibrationSamples ? state.calibrationSamples.length : 0;
    const relStd = calibrationCount < 12 ? 0.08 : calibrationCount < 24 ? 0.06 : 0.05;
    const maxStdPx = Math.max(60, diag * relStd);
    const maxSpeed = Math.max(6000, diag * 8);

    const stableNow = stdX <= maxStdPx && stdY <= maxStdPx && speed <= maxSpeed;
    if (stableNow) {
      if (!state.stability.stableSince) {
        state.stability.stableSince = now;
      }
      state.stability.unstableSince = null;
      if (!state.stability.stable && (now - state.stability.stableSince) >= 250) {
        state.stability.stable = true;
      }
    } else {
      state.stability.stableSince = null;
      if (!state.stability.unstableSince) {
        state.stability.unstableSince = now;
      }
      if (state.stability.stable && (now - state.stability.unstableSince) >= 600) {
        state.stability.stable = false;
      }
    }

    return {
      ready: true,
      stable: state.stability.stable,
      stdX,
      stdY,
      speed,
      thresholds: { maxStdPx, maxSpeed }
    };
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

  function smoothCalibratedPoint(point) {
    const history = state.smoothing.history;
    history.push({ x: point.x, y: point.y });
    if (history.length > SMOOTHING_WINDOW) {
      history.shift();
    }

    const medianPoint = {
      x: median(history.map((sample) => sample.x)),
      y: median(history.map((sample) => sample.y))
    };

    const previous = state.smoothing.smoothed;
    const distanceFromPrevious = previous ? distanceBetween(previous, medianPoint) : 0;

    if (previous && distanceFromPrevious > MAX_JUMP_DISTANCE) {
      const pending = state.smoothing.pendingJump;
      if (pending && distanceBetween(pending.point, medianPoint) < MAX_JUMP_DISTANCE * 0.4) {
        pending.count += 1;
      } else {
        state.smoothing.pendingJump = { point: medianPoint, count: 1 };
      }
      if (!state.smoothing.pendingJump || state.smoothing.pendingJump.count < 2) {
        return previous;
      }
      state.smoothing.pendingJump = null;
    } else {
      state.smoothing.pendingJump = null;
    }

    const speed = distanceFromPrevious;
    const alpha = computeAdaptiveAlpha(speed);
    const blended = previous
      ? {
          x: previous.x + alpha * (medianPoint.x - previous.x),
          y: previous.y + alpha * (medianPoint.y - previous.y)
        }
      : medianPoint;

    const euroOut = state.euro ? state.euro.filter({ x: blended.x, y: blended.y }) : blended;
    const smoothed = {
      x: clamp(euroOut.x, 0, window.innerWidth),
      y: clamp(euroOut.y, 0, window.innerHeight)
    };

    state.smoothing.smoothed = smoothed;
    return smoothed;
  }

  function computeAdaptiveAlpha(speed) {
    const minAlpha = 0.18;
    const maxAlpha = 0.45;
    const lowSpeed = 8;
    const highSpeed = 80;
    if (speed <= lowSpeed) return minAlpha;
    if (speed >= highSpeed) return maxAlpha;
    const ratio = (speed - lowSpeed) / (highSpeed - lowSpeed);
    return minAlpha + ratio * (maxAlpha - minAlpha);
  }

  function distanceBetween(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }

  function extractHeadPose() {
    try {
      const tracker = window.webgazer?.getTracker?.();
      const clm = tracker?.clm;
      if (!clm || typeof clm.getCurrentPosition !== 'function') {
        return null;
      }
      const positions = clm.getCurrentPosition();
      if (!positions || positions.length <= 62) {
        return null;
      }

      const leftEye = positions[27];
      const rightEye = positions[32];
      const noseTip = positions[62] || positions[33];
      const chin = positions[7];
      if (!leftEye || !rightEye || !noseTip || !chin) {
        return null;
      }

      const eyeCenter = {
        x: (leftEye[0] + rightEye[0]) / 2,
        y: (leftEye[1] + rightEye[1]) / 2
      };
      const eyeVector = {
        x: rightEye[0] - leftEye[0],
        y: rightEye[1] - leftEye[1]
      };
      const eyeDistance = Math.hypot(eyeVector.x, eyeVector.y);
      if (!Number.isFinite(eyeDistance) || eyeDistance < 1) {
        return null;
      }

      let yaw = (noseTip[0] - eyeCenter.x) / eyeDistance;
      let pitch = (noseTip[1] - eyeCenter.y) / eyeDistance - ((chin[1] - eyeCenter.y) / (2 * eyeDistance));
      let roll = Math.atan2(eyeVector.y, eyeVector.x);

      const mirrored = _isFeedMirrored();
      if (mirrored) {
        yaw = -yaw;
        roll = -roll;
      }

      yaw = clamp(yaw, -0.7, 0.7);
      pitch = clamp(pitch, -0.7, 0.7);

      if (state?.poseDebug) {
        const now = performance.now();
        if (!state.poseDebug.lastMeasurementLog || (now - state.poseDebug.lastMeasurementLog) > 1200) {
          debugLog('pose-measurement', { yaw, pitch, roll, mirrored });
          state.poseDebug.lastMeasurementLog = now;
        }
      }

      const confidence = Math.min(1, positions.length / 70);
      return { yaw, pitch, roll, confidence };
    } catch (_error) {
      return null;
    }
  }

  function updatePoseState(measurement) {
    const now = performance.now();
    if (!measurement || measurement.confidence < POSE_CONFIDENCE_THRESHOLD) {
      const missingCooldownMs = 15000;
      const sinceLog = now - state.poseDebug.lastMissingLog;
      if (!state.poseDebug.missingActive || sinceLog > missingCooldownMs) {
        debugLog('pose-measurement-missing', {
          confidence: measurement?.confidence || 0,
          repeated: state.poseDebug.missingActive
        });
        state.poseDebug.lastMissingLog = now;
        state.poseDebug.missingActive = true;
      }
      return;
    }
    state.poseDebug.missingActive = false;
    state.poseDebug.lastMissingLog = 0;
    const poseState = state.pose;

    if (poseState.smoothed == null) {
      poseState.smoothed = { yaw: measurement.yaw, pitch: measurement.pitch, roll: measurement.roll };
    } else {
      poseState.smoothed.yaw += POSE_SMOOTH_ALPHA * (measurement.yaw - poseState.smoothed.yaw);
      poseState.smoothed.pitch += POSE_SMOOTH_ALPHA * (measurement.pitch - poseState.smoothed.pitch);
      poseState.smoothed.roll += POSE_SMOOTH_ALPHA * (measurement.roll - poseState.smoothed.roll);
    }
    maybeWarmPoseBaseline();
  }

  function maybeWarmPoseBaseline() {
    const poseState = state.pose;
    const baseline = poseState.baseline;
    const smoothed = poseState.smoothed;
    if (!baseline || baseline.ready || !smoothed) {
      return;
    }

    const stage = state.calibrationConfig.stage;
    const inPrimaryStage = state.calibrationMode && stage === 'primary';
    if (inPrimaryStage) {
      accumulatePoseBaseline(baseline, smoothed, false);
      return;
    }

    if (!state.calibrationConfig.primaryComplete) {
      return;
    }

    const neutral = isPoseNearNeutral(smoothed);
    const inCalibrationWindow = state.calibrationMode && (stage === 'primary' || stage === 'fine' || stage === 'pose');
    const poseActive = state.poseTierActive || state.poseTierCapturing;

    if (inCalibrationWindow && !poseActive && neutral) {
      accumulatePoseBaseline(baseline, smoothed, true);
      return;
    }

    if (!state.calibrationMode && !poseActive && neutral) {
      accumulatePoseBaseline(baseline, smoothed, true);
    }
  }

  function accumulatePoseBaseline(baseline, poseSample, allowEarlyReady) {
    const nextCount = (baseline.count || 0) + 1;
    baseline.count = nextCount;
    baseline.yaw += (poseSample.yaw - baseline.yaw) / nextCount;
    baseline.pitch += (poseSample.pitch - baseline.pitch) / nextCount;
    baseline.roll += (poseSample.roll - baseline.roll) / nextCount;
    if (nextCount >= POSE_BASELINE_TARGET) {
      baseline.ready = true;
    } else if (allowEarlyReady && nextCount >= POSE_BASELINE_MIN_FRAMES) {
      baseline.ready = true;
    }
  }

  function isPoseNearNeutral(poseSample) {
    if (!poseSample) return false;
    return Math.abs(poseSample.yaw) <= POSE_NEUTRAL_TOLERANCE && Math.abs(poseSample.pitch) <= POSE_NEUTRAL_TOLERANCE;
  }

  function getPoseDelta() {
    const base = state.pose.baseline;
    if (!base || !base.ready || !state.pose.smoothed) {
      return { yaw: 0, pitch: 0 };
    }
    return {
      yaw: clamp(state.pose.smoothed.yaw - base.yaw, -0.7, 0.7),
      pitch: clamp(state.pose.smoothed.pitch - base.pitch, -0.7, 0.7)
    };
  }

function beginCalibrationCapture(targetX, targetY, captureType = 'calibration', metadata = {}) {
    if (state.calibrationCapture) {
      const hasSamples = state.calibrationCapture.samples && state.calibrationCapture.samples.length >= 3;
      finalizeCalibrationCapture(!hasSamples);
    }
    const capture = {
      target: { x: targetX, y: targetY },
      samples: [],
      poseSamples: [],
      type: captureType,
      tierId: metadata.tierId || null,
      onComplete: typeof metadata.onComplete === 'function' ? metadata.onComplete : null,
      expires: performance.now() + (captureType === 'calibration' ? CALIBRATION_SAMPLE_WINDOW_MS : REFINEMENT_SAMPLE_WINDOW_MS),
      timeoutId: setTimeout(() => {
        finalizeCalibrationCapture();
      }, (captureType === 'calibration' ? CALIBRATION_SAMPLE_WINDOW_MS : REFINEMENT_SAMPLE_WINDOW_MS) + 40)
    };
    state.calibrationCapture = capture;
  }

function requestRefinementCapture(anchor) {
  if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return;
  if (state.calibrationMode) return;
  if (state.poseTierActive || state.poseTierCapturing) return;
  if (!state.pose.baseline.ready) return;
  const now = Date.now();
  if (now - state.lastRefinementAt < 1500) {
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const poseDelta = getPoseDelta();
  const poseMagnitude = Math.hypot(poseDelta.yaw, poseDelta.pitch);
  if (poseMagnitude > 0.45) {
    return;
  }
  const centerX = clamp(rect.left + rect.width / 2, 0, window.innerWidth);
  const centerY = clamp(rect.top + rect.height / 2, 0, window.innerHeight);
  beginCalibrationCapture(centerX, centerY, 'refinement');
}

function startPoseCalibrationSequence() {
  if (state.poseTierActive) {
    return;
  }
  if (controls.poseBtn) {
    controls.poseBtn.disabled = true;
  }
  clearPoseBaselineMonitor();
  if (!state.calibrationConfig.primaryComplete) {
    updateStatus('Complete the baseline calibration first, then run pose calibration.', STATUS_WARN);
    if (controls.poseBtn) controls.poseBtn.disabled = false;
    return;
  }
  if (!state.pose.baseline.ready) {
    updateStatus('Still stabilising your neutral pose. Keep centered for another moment, then try again.', STATUS_WARN);
    if (controls.poseBtn) controls.poseBtn.disabled = false;
    return;
  }
  if (state.poseBaselineFallbackTriggered) {
    updateStatus('Manual pose capture: follow the cues and hold steady when prompted.', STATUS_WARN);
    debugLog('pose-calibration-manual', {});
  } else {
    debugLog('pose-calibration-start', {});
  }
  state.calibrationConfig.stage = 'pose';
  state.calibrationConfig.completed = false;
  state.poseTierIndex = 0;
  state.poseTierActive = false;
  state.calibrationConfig.points = [];
  state.calibrationConfig.counts = new Map();
  state.calibrationMode = true;
  state.hoverActive = false;
  state.indicatorAlwaysOn = true;
  updateCustomGazeIndicator(state.smoothing.smoothed || null);
  state.poseTierCapturing = false;
  state.poseTierHoldStart = null;
  if (state.poseTierTimer) {
    clearTimeout(state.poseTierTimer);
    state.poseTierTimer = null;
  }
  if (state.poseTierMonitor) {
    clearInterval(state.poseTierMonitor);
    state.poseTierMonitor = null;
  }
  if (controls.beginBtn) controls.beginBtn.disabled = true;
  if (controls.refineBtn) controls.refineBtn.disabled = true;
  renderPoseIntro();
}

function renderPoseIntro() {
  teardownCalibrationTargets();
  const overlay = document.createElement('div');
  overlay.id = 'webgazer-calibration-overlay';
  overlay.dataset.kind = 'pose-intro';
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.background = 'rgba(37, 99, 235, 0.05)';
  overlay.style.zIndex = '2147483600';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.pointerEvents = 'auto';

  const panel = document.createElement('div');
  panel.className = 'pose-intro-panel';
  panel.style.background = '#fff';
  panel.style.color = '#0f172a';
  panel.style.padding = '24px 28px';
  panel.style.borderRadius = '16px';
  panel.style.boxShadow = '0 18px 45px rgba(15, 23, 42, 0.25)';
  panel.style.maxWidth = '440px';
  panel.style.lineHeight = '1.55';
  panel.style.textAlign = 'left';

  const title = document.createElement('h3');
  title.textContent = 'Pose Calibration';
  title.style.margin = '0 0 12px';
  title.style.textAlign = 'center';
  panel.appendChild(title);

  const description = document.createElement('p');
  description.textContent = 'Keep staring at the center dot. When you continue we will prompt you to rotate your head left, right, up, and down while maintaining gaze.';
  description.style.margin = '0 0 12px';
  panel.appendChild(description);

  const steps = document.createElement('ol');
  steps.style.margin = '0 0 16px 18px';
  poseTiers.forEach((tier) => {
    const li = document.createElement('li');
    li.textContent = tier.instruction;
    steps.appendChild(li);
  });
  panel.appendChild(steps);

  const readyBtn = document.createElement('button');
  readyBtn.type = 'button';
  readyBtn.id = 'webgazer-pose-start';
  readyBtn.textContent = 'I\'m ready — start pose calibration';
  readyBtn.style.width = '100%';
  readyBtn.style.padding = '10px 14px';
  readyBtn.style.fontSize = '0.95rem';
  readyBtn.style.fontWeight = '600';
  readyBtn.style.border = 'none';
  readyBtn.style.borderRadius = '10px';
  readyBtn.style.cursor = 'pointer';
  readyBtn.style.background = '#1e3a8a';
  readyBtn.style.color = '#fff';
  readyBtn.addEventListener('click', () => {
    if (state.calibrationOverlay && state.calibrationOverlay.dataset.kind === 'pose-intro') {
      state.calibrationOverlay.parentElement.removeChild(state.calibrationOverlay);
      state.calibrationOverlay = null;
    }
    runNextPoseTier();
  });
  panel.appendChild(readyBtn);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  state.calibrationOverlay = overlay;
  updateStatus('Pose calibration: click “I\'m ready” when you are set. Keep your eyes on the center dot throughout.', STATUS_OK);
}

function runNextPoseTier() {
  const tier = poseTiers[state.poseTierIndex];
  if (!tier) {
    finishPoseCalibrationSequence();
    return;
  }
  if (!state.pose.baseline.ready) {
    updateStatus('Pose baseline unavailable. Restart the baseline calibration first.', STATUS_WARN);
    finishPoseCalibrationSequence();
    return;
  }

  state.poseTierActive = true;
  renderPoseOverlay(tier);
  updateStatus(`Pose calibration ${state.poseTierIndex + 1}/${poseTiers.length}: ${tier.instruction}`, STATUS_OK);

  state.poseTierHoldStart = null;
  state.poseTierCapturing = false;

  if (state.poseTierTimer) {
    clearTimeout(state.poseTierTimer);
    state.poseTierTimer = null;
  }
  if (state.poseTierMonitor) {
    clearInterval(state.poseTierMonitor);
    state.poseTierMonitor = null;
  }

  state.poseTierTimer = setTimeout(() => {
    state.poseTierTimer = null;
    state.poseTierMonitor = setInterval(() => evaluatePoseTier(tier), 80);
    evaluatePoseTier(tier);
  }, POSE_TIER_PREP_MS);
}

function renderPoseOverlay(tier) {
  let overlay = state.calibrationOverlay;
  if (!overlay || (overlay.dataset.kind !== 'pose' && overlay.dataset.kind !== 'pose-intro')) {
    teardownCalibrationTargets();
    overlay = null;
  }

  if (!overlay || overlay.dataset.kind !== 'pose') {
    overlay = document.createElement('div');
    overlay.id = 'webgazer-calibration-overlay';
    overlay.dataset.kind = 'pose';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(37, 99, 235, 0.05)';
    overlay.style.zIndex = '2147483600';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.pointerEvents = 'none';

    const cue = document.createElement('div');
    cue.className = 'pose-cue';
    overlay.appendChild(cue);

    const dot = document.createElement('div');
    dot.id = 'webgazer-pose-dot';
    overlay.appendChild(dot);

    const message = document.createElement('div');
    message.className = 'pose-message';
    overlay.appendChild(message);

    const status = document.createElement('div');
    status.className = 'pose-status';
    overlay.appendChild(status);

    document.body.appendChild(overlay);
    state.calibrationOverlay = overlay;
  }

  updatePoseOverlayState(tier, 'search', { poseDelta: getPoseDelta(), holdProgress: 0 });
}

function updatePoseOverlayState(tier, mode, { poseDelta = { yaw: 0, pitch: 0 }, holdProgress = 0 } = {}) {
  const overlay = state.calibrationOverlay;
  if (!overlay || overlay.dataset.kind !== 'pose') {
    return;
  }
  const messageEl = overlay.querySelector('.pose-message');
  const statusEl = overlay.querySelector('.pose-status');
  const cueEl = overlay.querySelector('.pose-cue');
  const dotEl = overlay.querySelector('#webgazer-pose-dot');
  overlay.dataset.tier = tier.id;

  if (messageEl) {
    if (mode === 'manual' || mode === 'manual-holding') {
      messageEl.textContent = `${tier.instruction} (manual mode)`;
    } else {
      messageEl.textContent = tier.instruction;
    }
  }
  if (statusEl) {
    statusEl.textContent = formatPoseStatus(tier, poseDelta, mode, holdProgress);
  }
  applyPoseCueStyles(cueEl, tier, mode, holdProgress);

  if (dotEl) {
    if (mode === 'holding' || mode === 'capturing') {
      dotEl.style.background = 'rgba(34, 197, 94, 0.9)';
      dotEl.style.border = '4px solid rgba(22, 163, 74, 0.9)';
      dotEl.style.boxShadow = '0 0 22px rgba(34, 197, 94, 0.5)';
    } else {
      dotEl.style.background = '#2563eb';
      dotEl.style.border = '4px solid rgba(37, 99, 235, 0.85)';
      dotEl.style.boxShadow = '0 0 18px rgba(37, 99, 235, 0.4)';
    }
  }
}

function applyPoseCueStyles(cue, tier, mode, holdProgress) {
  if (!cue) return;

  const searchColor = 'rgba(37, 99, 235, 0.35)';
  const holdColor = `rgba(34, 197, 94, ${0.25 + Math.min(holdProgress, 1) * 0.35})`;
  const capturingColor = 'rgba(22, 163, 74, 0.48)';
  let activeColor = searchColor;
  if (mode === 'holding' || mode === 'manual-holding') {
    activeColor = holdColor;
  } else if (mode === 'capturing') {
    activeColor = capturingColor;
  }

  cue.style.opacity = mode === 'capturing' ? '1' : (mode === 'holding' || mode === 'manual-holding') ? '0.95' : '0.85';
  cue.style.left = '0';
  cue.style.right = '0';
  cue.style.top = '0';
  cue.style.bottom = '0';
  cue.style.borderRadius = '0';

  const effectiveTierId = tier.id;
  switch (effectiveTierId) {
    case 'left':
      cue.style.left = '0';
      cue.style.right = 'auto';
      cue.style.top = '0';
      cue.style.bottom = '0';
      cue.style.width = '34%';
      cue.style.height = '100%';
      cue.style.background = `linear-gradient(to right, ${activeColor}, transparent)`;
      break;
    case 'right':
      cue.style.right = '0';
      cue.style.left = 'auto';
      cue.style.top = '0';
      cue.style.bottom = '0';
      cue.style.width = '34%';
      cue.style.height = '100%';
      cue.style.background = `linear-gradient(to left, ${activeColor}, transparent)`;
      break;
    case 'up':
      cue.style.left = '0';
      cue.style.right = '0';
      cue.style.top = '0';
      cue.style.bottom = 'auto';
      cue.style.height = '34%';
      cue.style.width = '100%';
      cue.style.background = `linear-gradient(to bottom, ${activeColor}, transparent)`;
      break;
    case 'down':
      cue.style.left = '0';
      cue.style.right = '0';
      cue.style.top = 'auto';
      cue.style.bottom = '0';
      cue.style.height = '34%';
      cue.style.width = '100%';
      cue.style.background = `linear-gradient(to top, ${activeColor}, transparent)`;
      break;
    case 'return':
    case 'center':
    default:
      cue.style.left = '20%';
      cue.style.right = '20%';
      cue.style.top = '20%';
      cue.style.bottom = '20%';
      cue.style.width = 'auto';
      cue.style.height = 'auto';
      cue.style.borderRadius = '50%';
      cue.style.background = `radial-gradient(circle, ${activeColor}, transparent 65%)`;
      break;
  }
}

function formatPoseStatus(tier, poseDelta, mode, holdProgress) {
  const yawDeg = Math.round(poseDelta.yaw * 57.2958);
  const pitchDeg = Math.round(poseDelta.pitch * 57.2958);

  if (mode === 'capturing') {
    return 'Capturing… keep steady.';
  }
  if (mode === 'holding' || mode === 'manual-holding') {
    return `Hold steady… ${Math.round(Math.min(holdProgress, 1) * 100)}%`;
  }
  if (mode === 'manual') {
    return 'Hold that pose briefly — capturing automatically.';
  }

  if (mode === 'search') {
    if (tier.id === 'center' || tier.id === 'return') {
      return `Keep centered (Yaw ${yawDeg}°, Pitch ${pitchDeg}°, goal ±6°).`;
    }
    return `Move in the highlighted direction (Yaw ${yawDeg}°, Pitch ${pitchDeg}°).`;
  }

  if (tier.id === 'center' || tier.id === 'return') {
    return `Yaw ${yawDeg}°, Pitch ${pitchDeg}° (keep within ±6°).`;
  }
  if (Math.abs(tier.yaw) > Math.abs(tier.pitch)) {
    const targetYaw = Math.round(tier.yaw * 57.2958);
    return `Current yaw ${yawDeg}° / target ${targetYaw}°`;
  }
  const targetPitch = Math.round(tier.pitch * 57.2958);
  return `Current pitch ${pitchDeg}° / target ${targetPitch}°`;
}

function checkPoseReadiness(tier, poseDelta) {
  if (!poseDelta) {
    return { ready: false };
  }
  const targetYaw = tier.yaw;
  const targetPitch = tier.pitch;
  const yawMag = Math.abs(targetYaw);
  const pitchMag = Math.abs(targetPitch);

  const yawTol = yawMag > 0.25 ? 0.12 : 0.09;
  const pitchTol = pitchMag > 0.2 ? 0.1 : 0.08;

  let yawOk;
  if (yawMag > 0.05) {
    yawOk =
      Math.sign(poseDelta.yaw || 0) === Math.sign(targetYaw || 0) &&
      Math.abs(poseDelta.yaw) >= Math.max(0.18, yawMag * 0.65) &&
      Math.abs(poseDelta.yaw - targetYaw) <= yawTol * 1.2;
  } else {
    yawOk = Math.abs(poseDelta.yaw) <= 0.12;
  }

  let pitchOk;
  if (pitchMag > 0.05) {
    pitchOk =
      Math.sign(poseDelta.pitch || 0) === Math.sign(targetPitch || 0) &&
      Math.abs(poseDelta.pitch) >= Math.max(0.15, pitchMag * 0.65) &&
      Math.abs(poseDelta.pitch - targetPitch) <= pitchTol * 1.2;
  } else {
    pitchOk = Math.abs(poseDelta.pitch) <= 0.12;
  }

  return { ready: yawOk && pitchOk };
}

function evaluatePoseTier(tier) {
  const manualMode = state.poseBaselineFallbackTriggered;
  if (!state.pose.baseline.ready && !manualMode) {
    updatePoseOverlayState(tier, 'search', { poseDelta: { yaw: 0, pitch: 0 }, holdProgress: 0 });
    return;
  }
  const poseDelta = manualMode ? { yaw: 0, pitch: 0 } : getPoseDelta();
  const readiness = manualMode ? { ready: true } : checkPoseReadiness(tier, poseDelta);

  if (!readiness.ready || state.poseTierCapturing) {
    state.poseTierHoldStart = null;
    updatePoseOverlayState(tier, manualMode ? 'manual' : 'search', { poseDelta });
    return;
  }

  if (!state.poseTierHoldStart) {
    state.poseTierHoldStart = performance.now();
  }
  const elapsed = performance.now() - state.poseTierHoldStart;
  const holdProgress = Math.min(1, elapsed / POSE_HOLD_DURATION_MS);
  updatePoseOverlayState(tier, manualMode ? 'manual-holding' : 'holding', { poseDelta, holdProgress });

  if (holdProgress >= 1) {
    startPoseCapture(tier);
  }
}

function startPoseCapture(tier) {
  if (state.poseTierCapturing) {
    return;
  }
  debugLog('pose-tier-capture', { tier: tier.id, manual: Boolean(state.poseBaselineFallbackTriggered) });
  state.poseTierCapturing = true;
  if (state.poseTierMonitor) {
    clearInterval(state.poseTierMonitor);
    state.poseTierMonitor = null;
  }
  if (state.poseTierTimer) {
    clearTimeout(state.poseTierTimer);
    state.poseTierTimer = null;
  }
  updatePoseOverlayState(tier, 'capturing', { poseDelta: getPoseDelta(), holdProgress: 1 });

  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  beginCalibrationCapture(centerX, centerY, 'pose', {
    tierId: tier.id,
    onComplete: () => {
      state.poseTierCapturing = false;
      state.poseTierHoldStart = null;
      state.poseTierMonitor = null;
      state.poseTierTimer = null;
      state.poseTierActive = false;
      state.poseTierIndex += 1;
      runNextPoseTier();
    }
  });
}
function finishPoseCalibrationSequence() {
  state.poseTierActive = false;
  state.poseTierIndex = 0;
  if (state.poseTierTimer) {
    clearTimeout(state.poseTierTimer);
    state.poseTierTimer = null;
  }
  if (state.poseTierMonitor) {
    clearInterval(state.poseTierMonitor);
    state.poseTierMonitor = null;
  }
  state.poseTierHoldStart = null;
  state.poseTierCapturing = false;
  state.calibrationConfig.stage = 'pose-complete';
  state.calibrationConfig.completed = true;
  state.calibrationMode = false;
  teardownCalibrationTargets();
  updateCustomGazeIndicator(null);
  state.indicatorAlwaysOn = true;
  updateCustomGazeIndicator(state.smoothing.smoothed || null);
  updateStatus('Pose calibration complete! You may run fine-tune or begin hover mode.', STATUS_OK);
  if (controls.refineBtn) controls.refineBtn.disabled = false;
  if (controls.beginBtn) controls.beginBtn.disabled = false;
  if (controls.poseBtn) controls.poseBtn.disabled = false;
}

  function captureCalibrationSample(rawPoint) {
    const capture = state.calibrationCapture;
    if (!capture) return;
    capture.samples.push({ x: rawPoint.x, y: rawPoint.y });
    if (!capture.poseSamples) {
      capture.poseSamples = [];
    }
    const poseDelta = getPoseDelta();
    capture.poseSamples.push({ yaw: poseDelta.yaw, pitch: poseDelta.pitch });
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
  if (capture.type === 'pose') {
    state.poseTierCapturing = false;
  }
  if (discard || !capture.samples.length) {
    return;
  }

    const coordinateSum = capture.samples.reduce((acc, sample) => {
      acc.x += sample.x;
      acc.y += sample.y;
      return acc;
    }, { x: 0, y: 0 });
    const count = capture.samples.length;
    const averaged = {
      x: coordinateSum.x / count,
      y: coordinateSum.y / count
    };

    const poseSum = (capture.poseSamples || []).reduce((acc, sample) => {
      acc.yaw += sample.yaw;
      acc.pitch += sample.pitch;
      return acc;
    }, { yaw: 0, pitch: 0 });

    let poseAverage = {
      yaw: capture.poseSamples && capture.poseSamples.length ? poseSum.yaw / capture.poseSamples.length : 0,
      pitch: capture.poseSamples && capture.poseSamples.length ? poseSum.pitch / capture.poseSamples.length : 0
    };

    if (!state.pose.baseline.ready) {
      poseAverage = { yaw: 0, pitch: 0 };
    }

    poseAverage.yaw = clamp(poseAverage.yaw, -0.7, 0.7);
    poseAverage.pitch = clamp(poseAverage.pitch, -0.7, 0.7);

    const now = Date.now();
    let baseWeight = 0.7;
    if (capture.type === 'calibration') {
      baseWeight = 1.3;
    } else if (capture.type === 'pose') {
      baseWeight = 1.1;
    }
    const densityBoost = Math.min(count / 5, 1.2);
    const poseBoost = 1 - Math.min(Math.hypot(poseAverage.yaw, poseAverage.pitch), 0.7);
    const weight = (baseWeight + densityBoost) * Math.max(0.35, poseBoost);

    state.calibrationSamples.push({
      raw: averaged,
      target: { x: capture.target.x, y: capture.target.y },
      pose: poseAverage,
      weight,
      timestamp: now,
      type: capture.type,
      tier: capture.tierId || null
    });
    while (state.calibrationSamples.length > MAX_CALIBRATION_SAMPLES) {
      state.calibrationSamples.shift();
    }
    if (capture.type === 'refinement') {
      state.lastRefinementAt = now;
    }
    const nowPerf = performance.now();
    if (!state.stability.lastRecomputeAt || (nowPerf - state.stability.lastRecomputeAt) >= TRANSFORM_UPDATE_MIN_INTERVAL_MS) {
      recomputeCalibrationTransform();
      state.stability.lastRecomputeAt = nowPerf;
    }

    if (typeof capture.onComplete === 'function') {
      try {
        capture.onComplete(capture);
      } catch (error) {
        console.warn('[WebGazer Prototype] Pose capture callback failed:', error);
      }
    }
  }

  function applyCalibrationTransform(point) {
    const transform = state.calibrationTransform;
    if (!transform.ready) {
      return {
        x: clamp(point.x, 0, window.innerWidth),
        y: clamp(point.y, 0, window.innerHeight)
      };
    }
    const coeffX = transform.matrix[0];
    const coeffY = transform.matrix[1];
    if (!Array.isArray(coeffX) || !Array.isArray(coeffY)) {
      return {
        x: clamp(point.x, 0, window.innerWidth),
        y: clamp(point.y, 0, window.innerHeight)
      };
    }

    let features;
    if (coeffX.length === 5 && coeffY.length === 5) {
      const poseDelta = getPoseDelta();
      features = [point.x, point.y, poseDelta.yaw, poseDelta.pitch, 1];
    } else {
      features = [point.x, point.y, 1];
    }

    const calibratedX = coeffX.slice(0, features.length).reduce((sum, coeff, idx) => sum + coeff * features[idx], 0);
    const calibratedY = coeffY.slice(0, features.length).reduce((sum, coeff, idx) => sum + coeff * features[idx], 0);

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

    const coeffX = solveWeightedCoefficients(samples, 'x');
    const coeffY = solveWeightedCoefficients(samples, 'y');

    if (!coeffX || !coeffY) {
      return;
    }

    state.calibrationTransform = {
      matrix: [coeffX, coeffY],
      ready: true
    };
  }

  function solveWeightedCoefficients(samples, axis) {
    const referenceTime = Date.now();
    const accum = {
      xx: 0,
      xy: 0,
      yy: 0,
      xYaw: 0,
      xPitch: 0,
      yYaw: 0,
      yPitch: 0,
      yawYaw: 0,
      yawPitch: 0,
      pitchPitch: 0,
      x: 0,
      y: 0,
      yaw: 0,
      pitch: 0,
      weight: 0,
      xTarget: 0,
      yTarget: 0,
      yawTarget: 0,
      pitchTarget: 0,
      target: 0
    };

    for (const sample of samples) {
      const rawX = sample.raw.x;
      const rawY = sample.raw.y;
      const targetVal = axis === 'x' ? sample.target.x : sample.target.y;
      const pose = sample.pose || { yaw: 0, pitch: 0 };
      const yaw = clamp(pose.yaw || 0, -0.7, 0.7);
      const pitch = clamp(pose.pitch || 0, -0.7, 0.7);
      const recencyWeight = Math.pow(0.5, Math.max(0, referenceTime - sample.timestamp) / RECENCY_HALF_LIFE_MS);
      const w = Math.max(0.001, sample.weight * recencyWeight);

      accum.xx += w * rawX * rawX;
      accum.xy += w * rawX * rawY;
      accum.yy += w * rawY * rawY;
      accum.xYaw += w * rawX * yaw;
      accum.xPitch += w * rawX * pitch;
      accum.yYaw += w * rawY * yaw;
      accum.yPitch += w * rawY * pitch;
      accum.yawYaw += w * yaw * yaw;
      accum.yawPitch += w * yaw * pitch;
      accum.pitchPitch += w * pitch * pitch;
      accum.x += w * rawX;
      accum.y += w * rawY;
      accum.yaw += w * yaw;
      accum.pitch += w * pitch;
      accum.weight += w;
      accum.xTarget += w * rawX * targetVal;
      accum.yTarget += w * rawY * targetVal;
      accum.yawTarget += w * yaw * targetVal;
      accum.pitchTarget += w * pitch * targetVal;
      accum.target += w * targetVal;
    }

    if (accum.weight < 1e-6) {
      return null;
    }

    const epsilon = 1e-6;
    const sampleCount = samples.length;
    const lambda = sampleCount < 18 ? 0.12 : sampleCount < 36 ? 0.06 : 0.02;
    const matrix = [
      [accum.xx + epsilon, accum.xy, accum.xYaw, accum.xPitch, accum.x],
      [accum.xy, accum.yy + epsilon, accum.yYaw, accum.yPitch, accum.y],
      [accum.xYaw, accum.yYaw, accum.yawYaw + epsilon, accum.yawPitch, accum.yaw],
      [accum.xPitch, accum.yPitch, accum.yawPitch, accum.pitchPitch + epsilon, accum.pitch],
      [accum.x, accum.y, accum.yaw, accum.pitch, accum.weight + epsilon]
    ];
    for (let i = 0; i < matrix.length; i += 1) {
      matrix[i][i] += lambda;
    }

    const vector = [
      accum.xTarget,
      accum.yTarget,
      accum.yawTarget,
      accum.pitchTarget,
      accum.target
    ];

    return solveLinearSystem(matrix, vector);
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

  function solveLinearSystem(matrix, vector) {
    const n = vector.length;
    const A = matrix.map((row) => row.slice());
    const b = vector.slice();

    for (let i = 0; i < n; i += 1) {
      let pivotRow = i;
      let pivotValue = Math.abs(A[i][i]);
      for (let r = i + 1; r < n; r += 1) {
        const value = Math.abs(A[r][i]);
        if (value > pivotValue) {
          pivotValue = value;
          pivotRow = r;
        }
      }

      if (pivotValue < 1e-9) {
        return null;
      }

      if (pivotRow !== i) {
        [A[i], A[pivotRow]] = [A[pivotRow], A[i]];
        [b[i], b[pivotRow]] = [b[pivotRow], b[i]];
      }

      for (let r = i + 1; r < n; r += 1) {
        const factor = A[r][i] / A[i][i];
        if (!Number.isFinite(factor)) continue;
        for (let c = i; c < n; c += 1) {
          A[r][c] -= factor * A[i][c];
        }
        b[r] -= factor * b[i];
      }
    }

    const solution = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i -= 1) {
      let sum = b[i];
      for (let c = i + 1; c < n; c += 1) {
        sum -= A[i][c] * solution[c];
      }
      const pivot = A[i][i];
      if (Math.abs(pivot) < 1e-9) {
        return null;
      }
      solution[i] = sum / pivot;
    }

    return solution;
  }
})();
