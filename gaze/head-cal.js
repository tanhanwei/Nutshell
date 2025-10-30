(function() {
  'use strict';

  if (window.__gazeHeadCalInitialized) {
    return;
  }
  window.__gazeHeadCalInitialized = true;

  const HEAD_CAL_STORAGE_KEY = 'headCalV2';
  const MIN_RANGE_HORIZONTAL = 0.24;
  const MIN_RANGE_VERTICAL = 0.22;
  const MIN_SAMPLES_PER_STEP = 8;
  const MAX_SAMPLES_PER_STEP = 120;
  const CAPTURE_TIMEOUT_MS = 1200;
  const BLINK_CONFIRM_DURATION = 900; // ms

  if (typeof window.__gazeHeadCalActive !== 'boolean') {
    window.__gazeHeadCalActive = false;
  }

  const STEPS = [
    { label: 'Look CENTER', hint: 'Keep head relaxed, press Space to capture' },
    { label: 'Look LEFT', hint: 'Rotate gently left then press Space' },
    { label: 'Look RIGHT', hint: 'Rotate gently right then press Space' },
    { label: 'Look UP', hint: 'Nod up slightly then press Space' },
    { label: 'Look DOWN', hint: 'Nod down slightly then press Space' },
    { label: 'Look CENTER AGAIN', hint: 'Return to neutral and press Space to finish' }
  ];

  let ui = null;
  let titleEl = null;
  let hintEl = null;
  let footerEl = null;
  let active = false;
  let capturing = false;
  let stepIndex = 0;
  let stepSamples = [];
  let poseAverages = [];
  let calibration = null;
  let captureListener = null;
  let captureTimer = null;
  let captureRaf = null;

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

  function stopCapture() {
    capturing = false;
    if (captureListener) {
      window.removeEventListener('head:frame', captureListener);
      captureListener = null;
    }
    if (captureTimer) {
      clearTimeout(captureTimer);
      captureTimer = null;
    }
    if (captureRaf) {
      cancelAnimationFrame(captureRaf);
      captureRaf = null;
    }
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
      cx: 0,
      cy: 0,
      left: 0,
      right: 0,
      up: 0,
      down: 0,
      version: 2,
      ts: Date.now()
    };
    resetSamples();
    poseAverages = new Array(STEPS.length);
    setUIVisible(true);
    updateUI(`Step 1 / ${STEPS.length}: ${STEPS[0].label}`, STEPS[0].hint);
    const centerX = Math.round((window.innerWidth || 1) / 2);
    const centerY = Math.round((window.innerHeight || 1) / 2);
    window.dispatchEvent(new CustomEvent('gaze:status', {
      detail: { phase: 'calibrating', note: 'center' }
    }));
    const now = performance.now();
    window.dispatchEvent(new CustomEvent('gaze:point', {
      detail: { x: centerX, y: centerY, conf: 0.95, ts: now }
    }));
    console.log('[HeadCal] Started');
  }

  function stopCalibration(message) {
    if (!active) return;
    active = false;
    window.__gazeHeadCalActive = false;
    stopCapture();
    setUIVisible(false);
    if (message) {
      console.log('[HeadCal]', message);
    }
  }

  function averageSamples(samples) {
    if (!samples.length) return { nx: NaN, ny: NaN };
    const sum = samples.reduce((acc, cur) => {
      acc.nx += cur.nx;
      acc.ny += cur.ny;
      return acc;
    }, { nx: 0, ny: 0 });
    return {
      nx: sum.nx / samples.length,
      ny: sum.ny / samples.length
    };
  }

  function collectSamplesForCurrentStep() {
    return new Promise((resolve) => {
      stopCapture();
      capturing = true;
      const samples = [];
      const step = STEPS[stepIndex];
      const start = performance.now();
      hintEl.textContent = `${step.label}: capturing…`;

      const appendSample = (frame) => {
        if (!frame) return;
        const { nx, ny } = frame;
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
        const last = samples[samples.length - 1];
        if (last && Math.abs(last.nx - nx) < 1e-4 && Math.abs(last.ny - ny) < 1e-4) {
          return;
        }
        samples.push({ nx, ny });
        if (samples.length >= MIN_SAMPLES_PER_STEP) {
          hintEl.textContent = `${step.label}: captured ${samples.length}`;
        }
      };

      if (window.__lastHeadFrame) {
        appendSample(window.__lastHeadFrame);
      }

      const tick = () => {
        if (!capturing) return;
        appendSample(window.__lastHeadFrame);
        if (samples.length >= MAX_SAMPLES_PER_STEP) {
          stopCapture();
          resolve(samples);
          return;
        }
        if (performance.now() - start >= CAPTURE_TIMEOUT_MS) {
          stopCapture();
          resolve(samples);
          return;
        }
        captureRaf = requestAnimationFrame(tick);
      };

      captureRaf = requestAnimationFrame(tick);
      captureTimer = setTimeout(() => {
        stopCapture();
        resolve(samples);
      }, CAPTURE_TIMEOUT_MS + 16);
    });
  }

  async function confirmStep() {
    if (!active || capturing) return;
    const step = STEPS[stepIndex];
    const samples = await collectSamplesForCurrentStep();
    if (!samples || samples.length < MIN_SAMPLES_PER_STEP) {
      updateUI(`Step ${stepIndex + 1} / ${STEPS.length}: ${step.label}`, `Only captured ${samples.length || 0} frames. Hold steady and press Space again.`);
      return;
    }

    stepSamples[stepIndex] = samples;
    const middleRange = Math.floor(samples.length * 0.35);
    const sorted = samples.slice().sort((a, b) => a.nx - b.nx || a.ny - b.ny);
    const trimmed = sorted.slice(middleRange, sorted.length - middleRange);
    const usable = trimmed.length >= MIN_SAMPLES_PER_STEP ? trimmed : samples;
    const avg = averageSamples(usable);
    poseAverages[stepIndex] = avg;

    switch (stepIndex) {
      case 0:
        calibration.cx = avg.nx;
        calibration.cy = avg.ny;
        break;
      case 1:
        calibration.left = Math.max(1e-3, (calibration.cx || 0) - avg.nx);
        calibration.poseLeft = avg;
        break;
      case 2:
        calibration.right = Math.max(1e-3, avg.nx - (calibration.cx || 0));
        calibration.poseRight = avg;
        break;
      case 3:
        calibration.up = Math.max(1e-3, (calibration.cy || 0) - avg.ny);
        calibration.poseUp = avg;
        break;
      case 4:
        calibration.down = Math.max(1e-3, avg.ny - (calibration.cy || 0));
        calibration.poseDown = avg;
        break;
      case 5:
        calibration.cx = avg.nx;
        calibration.cy = avg.ny;
        calibration.poseCenter = avg;
        break;
      default:
        break;
    }

    stepIndex += 1;
    if (stepIndex >= STEPS.length) {
      finalizeCalibration();
    } else {
      const nextStep = STEPS[stepIndex];
      updateUI(`Step ${stepIndex + 1} / ${STEPS.length}: ${nextStep.label}`, nextStep.hint);
    }
  }

  function finalizeCalibration() {
    const centerPrimary = poseAverages[0] || { nx: calibration.cx, ny: calibration.cy };
    const centerFinal = poseAverages[5] || centerPrimary;
    const leftAvg = poseAverages[1] || centerPrimary;
    const rightAvg = poseAverages[2] || centerPrimary;
    const upAvg = poseAverages[3] || centerPrimary;
    const downAvg = poseAverages[4] || centerPrimary;

    const finalCenter = {
      nx: Number.isFinite(centerFinal.nx) ? centerFinal.nx : centerPrimary.nx || 0,
      ny: Number.isFinite(centerFinal.ny) ? centerFinal.ny : centerPrimary.ny || 0
    };

    calibration.cx = finalCenter.nx;
    calibration.cy = finalCenter.ny;
    calibration.poseCenter = finalCenter;
    calibration.poseLeft = calibration.poseLeft || leftAvg;
    calibration.poseRight = calibration.poseRight || rightAvg;
    calibration.poseUp = calibration.poseUp || upAvg;
    calibration.poseDown = calibration.poseDown || downAvg;

    const leftRange = Number.isFinite(leftAvg.nx) ? Math.max(MIN_RANGE_HORIZONTAL, Math.abs(finalCenter.nx - leftAvg.nx)) : MIN_RANGE_HORIZONTAL;
    const rightRange = Number.isFinite(rightAvg.nx) ? Math.max(MIN_RANGE_HORIZONTAL, Math.abs(rightAvg.nx - finalCenter.nx)) : MIN_RANGE_HORIZONTAL;
    const upRange = Number.isFinite(upAvg.ny) ? Math.max(MIN_RANGE_VERTICAL, Math.abs(finalCenter.ny - upAvg.ny)) : MIN_RANGE_VERTICAL;
    const downRange = Number.isFinite(downAvg.ny) ? Math.max(MIN_RANGE_VERTICAL, Math.abs(downAvg.ny - finalCenter.ny)) : MIN_RANGE_VERTICAL;

    calibration.left = leftRange;
    calibration.right = rightRange;
    calibration.up = upRange;
    calibration.down = downRange;
    calibration.ts = Date.now();
    chrome.storage.local.set({ [HEAD_CAL_STORAGE_KEY]: calibration }, () => {
      console.log('[HeadCal] Saved calibration', calibration);
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
      confirmStep().catch((error) => console.warn('[HeadCal] capture failed:', error));
    }
  }

  function handleHeadFrame(event) {
    if (!event.detail) return;
    const { nx, ny } = event.detail;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    window.__lastHeadFrame = { nx, ny };
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
      confirmStep().catch((error) => console.warn('[HeadCal] capture failed:', error));
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      stopCalibration('Cancelled via Escape');
    }
  }, true);

  window.addEventListener('head:frame', handleHeadFrame);
  window.addEventListener('blink:released', handleBlinkRelease);
})();
