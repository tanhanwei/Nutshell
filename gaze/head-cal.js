(function() {
  'use strict';

  if (window.__gazeHeadCalInitialized) {
    return;
  }
  window.__gazeHeadCalInitialized = true;

  if (typeof window.__gazeHeadCalActive !== 'boolean') {
    window.__gazeHeadCalActive = false;
  }

  const STEPS = [
    { label: 'Look CENTER', hint: 'Keep head relaxed, press Space or long blink (1s)' },
    { label: 'Look LEFT', hint: 'Rotate gently left' },
    { label: 'Look RIGHT', hint: 'Rotate gently right' },
    { label: 'Look UP', hint: 'Nod up slightly' },
    { label: 'Look DOWN', hint: 'Nod down slightly' }
  ];

  const SAMPLE_INTERVAL_MS = 33;
  const MIN_SAMPLES_PER_STEP = 10;
  const BLINK_CONFIRM_DURATION = 900; // ms

  let ui = null;
  let titleEl = null;
  let hintEl = null;
  let footerEl = null;
  let active = false;
  let stepIndex = 0;
  let stepSamples = STEPS.map(() => []);
  let sampleTimer = null;
  let calibration = null;

  function ensureUI() {
    if (ui) return ui;
    ui = document.createElement('div');
    ui.id = 'gaze-head-cal';
    ui.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      display: none;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      min-width: 280px;
      max-width: 360px;
      padding: 20px 24px;
      border-radius: 16px;
      background: rgba(8, 12, 28, 0.92);
      color: #f2f6ff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      text-align: center;
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.4);
      pointer-events: auto;
    `;

    titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-size: 18px; font-weight: 600; margin-bottom: 12px;';
    hintEl = document.createElement('div');
    hintEl.style.cssText = 'font-size: 14px; opacity: 0.85; margin-bottom: 16px;';
    footerEl = document.createElement('div');
    footerEl.style.cssText = 'font-size: 12px; opacity: 0.6;';

    panel.appendChild(titleEl);
    panel.appendChild(hintEl);
    panel.appendChild(footerEl);
    ui.appendChild(panel);
    document.documentElement.appendChild(ui);
    return ui;
  }

  function setUIVisible(visible) {
    ensureUI();
    ui.style.display = visible ? 'flex' : 'none';
  }

  function updateUI(message, hint, footer) {
    ensureUI();
    titleEl.textContent = message;
    hintEl.textContent = hint || '';
    footerEl.textContent = footer || 'Space or long blink (≥1s) to confirm · Esc to cancel';
  }

  function resetSamples() {
    stepSamples = STEPS.map(() => []);
  }

  function startCalibration() {
    if (active) return;
    active = true;
    window.__gazeHeadCalActive = true;
    stepIndex = 0;
    calibration = {
      y0: 0,
      p0: 0,
      left: 0,
      right: 0,
      up: 0,
      down: 0,
      ts: Date.now()
    };
    resetSamples();
    setUIVisible(true);
    updateUI(`Step 1 / ${STEPS.length}: ${STEPS[0].label}`, STEPS[0].hint);
    scheduleSampling();
    console.debug('[HeadCal] Started');
  }

  function stopCalibration(message) {
    if (!active) return;
    active = false;
    window.__gazeHeadCalActive = false;
    clearInterval(sampleTimer);
    sampleTimer = null;
    setUIVisible(false);
    if (message) {
      console.debug('[HeadCal]', message);
    }
  }

  function scheduleSampling() {
    clearInterval(sampleTimer);
    sampleTimer = setInterval(() => {
      if (!active) return;
      if (!window.__lastHeadAngles) return;
      const { yaw, pitch } = window.__lastHeadAngles;
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
      if (!stepSamples[stepIndex]) return;
      stepSamples[stepIndex].push({ yaw, pitch });
      hintEl.textContent = `${STEPS[stepIndex].hint} · captured ${stepSamples[stepIndex].length}`;
    }, SAMPLE_INTERVAL_MS);
  }

  function averageSamples(samples) {
    if (!samples.length) return { yaw: NaN, pitch: NaN };
    const sum = samples.reduce((acc, cur) => {
      acc.yaw += cur.yaw;
      acc.pitch += cur.pitch;
      return acc;
    }, { yaw: 0, pitch: 0 });
    return {
      yaw: sum.yaw / samples.length,
      pitch: sum.pitch / samples.length
    };
  }

  function confirmStep() {
    if (!active) return;
    const samples = stepSamples[stepIndex];
    if (!samples || samples.length < MIN_SAMPLES_PER_STEP) {
      updateUI(`Step ${stepIndex + 1} / ${STEPS.length}: ${STEPS[stepIndex].label}`, 'Need a little more data. Hold steady and try again.');
      return;
    }
    const avg = averageSamples(samples);
    switch (stepIndex) {
      case 0:
        calibration.y0 = avg.yaw;
        calibration.p0 = avg.pitch;
        break;
      case 1:
        calibration.left = Math.max(1e-3, calibration.y0 - avg.yaw);
        break;
      case 2:
        calibration.right = Math.max(1e-3, avg.yaw - calibration.y0);
        break;
      case 3:
        calibration.up = Math.max(1e-3, calibration.p0 - avg.pitch);
        break;
      case 4:
        calibration.down = Math.max(1e-3, avg.pitch - calibration.p0);
        break;
      default:
        break;
    }
    stepSamples[stepIndex] = [];
    stepIndex += 1;
    if (stepIndex >= STEPS.length) {
      finalizeCalibration();
    } else {
      updateUI(`Step ${stepIndex + 1} / ${STEPS.length}: ${STEPS[stepIndex].label}`, STEPS[stepIndex].hint);
    }
  }

  function finalizeCalibration() {
    calibration.left = calibration.left || 5;
    calibration.right = calibration.right || 5;
    calibration.up = calibration.up || 5;
    calibration.down = calibration.down || 5;
    calibration.ts = Date.now();
    chrome.storage.local.set({ headCalV1: calibration }, () => {
      console.debug('[HeadCal] Saved calibration', calibration);
      updateUI('✅ Head calibration saved', 'Alt+N toggles head-pointer mode');
      window.dispatchEvent(new CustomEvent('head:calibrated', { detail: calibration }));
      window.dispatchEvent(new CustomEvent('gaze:status', {
        detail: { phase: 'live', note: 'head-cal saved' }
      }));
      setTimeout(() => stopCalibration('Completed'), 900);
    });
  }

  function handleBlinkRelease(event) {
    if (!active) return;
    if (!event.detail || typeof event.detail.duration !== 'number') return;
    if (event.detail.duration >= BLINK_CONFIRM_DURATION) {
      confirmStep();
    }
  }

  function handleHeadAngles(event) {
    if (!event.detail) return;
    window.__lastHeadAngles = { yaw: event.detail.yaw, pitch: event.detail.pitch };
  }

  document.addEventListener('keydown', (event) => {
    const code = event.code || event.key;
    if (event.altKey && !event.ctrlKey && !event.metaKey && code === 'KeyH') {
      event.preventDefault();
      if (active) {
        stopCalibration('Cancelled');
      } else {
        startCalibration();
      }
      return;
    }
    if (!active) return;
    if (event.key === ' ') {
      event.preventDefault();
      confirmStep();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      stopCalibration('Cancelled via Escape');
    }
  }, true);

  window.addEventListener('head:angles', handleHeadAngles);
  window.addEventListener('blink:released', handleBlinkRelease);
})();
