(function() {
  'use strict';

  if (window.__gazeHeadCalInitialized) {
    return;
  }
  window.__gazeHeadCalInitialized = true;

  const HEAD_CAL_STORAGE_KEY = 'headCalV2';
  const MIN_RANGE_HORIZONTAL = 0.24;
  const MIN_RANGE_VERTICAL = 0.22;
  const MIN_SAMPLES_PER_STEP = 4;         // Reduced from 8 for easier calibration
  const MAX_SAMPLES_PER_STEP = 120;
  const CAPTURE_TIMEOUT_MS = 1500;        // Increased from 1200ms for more capture time
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
  let beginBtn = null;
  let active = false;
  let waitingToStart = false;
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
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      pointer-events: auto;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      min-width: 320px;
      max-width: 420px;
      padding: 32px 32px;
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.95);
      color: #1a1a1a;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      text-align: center;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
      pointer-events: auto;
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.3);
    `;

    titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-size: 22px; font-weight: 700; margin-bottom: 16px; color: #1a1a1a; letter-spacing: -0.02em;';
    hintEl = document.createElement('div');
    hintEl.style.cssText = 'font-size: 16px; opacity: 0.75; margin-bottom: 20px; color: #333; line-height: 1.5;';

    beginBtn = document.createElement('button');
    beginBtn.textContent = 'Click Here to Begin';
    beginBtn.style.cssText = `
      padding: 14px 32px;
      font-size: 16px;
      font-weight: 600;
      color: white;
      background: #3498db;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      margin-bottom: 20px;
      display: none;
      transition: all 0.2s;
      box-shadow: 0 4px 12px rgba(52, 152, 219, 0.3);
    `;
    beginBtn.onmouseover = () => {
      beginBtn.style.background = '#2980b9';
      beginBtn.style.transform = 'translateY(-2px)';
      beginBtn.style.boxShadow = '0 6px 16px rgba(52, 152, 219, 0.4)';
    };
    beginBtn.onmouseout = () => {
      beginBtn.style.background = '#3498db';
      beginBtn.style.transform = 'translateY(0)';
      beginBtn.style.boxShadow = '0 4px 12px rgba(52, 152, 219, 0.3)';
    };
    beginBtn.onclick = handleBeginClick;

    footerEl = document.createElement('div');
    footerEl.style.cssText = 'font-size: 13px; opacity: 0.5; color: #666;';

    panel.appendChild(titleEl);
    panel.appendChild(hintEl);
    panel.appendChild(beginBtn);
    panel.appendChild(footerEl);
    ui.appendChild(panel);
    document.documentElement.appendChild(ui);
    return ui;
  }

  function setUIVisible(visible) {
    ensureUI();
    ui.style.display = visible ? 'flex' : 'none';
  }

  function updateUI(message, hint, footer, showButton = false) {
    ensureUI();
    titleEl.textContent = message;
    hintEl.textContent = hint || '';
    footerEl.textContent = footer || 'Space or long blink (≥1s) to confirm · Esc to cancel';

    if (showButton) {
      beginBtn.style.display = 'inline-block';
      footerEl.textContent = 'Press Esc to cancel';
    } else {
      beginBtn.style.display = 'none';
    }
  }

  function handleBeginClick() {
    waitingToStart = false;
    beginActualCalibration();
  }

  function beginActualCalibration() {
    stepIndex = 0;
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
    console.log('[HeadCal] Calibration steps started');
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
    waitingToStart = true;
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
    updateUI(
      'Head Tracking Calibration',
      'You\'ll be asked to look in 5 different directions. Click the button below to begin.',
      'Press Esc to cancel',
      true  // Show button
    );

    // Dispatch event to hide tooltip and pointer during calibration
    window.dispatchEvent(new CustomEvent('gaze:calibration-started'));

    console.log('[HeadCal] Waiting for user to click begin');
  }

  function stopCalibration(message) {
    if (!active) return;
    active = false;
    waitingToStart = false;
    window.__gazeHeadCalActive = false;
    stopCapture();
    setUIVisible(false);

    // Dispatch event to restore tooltip and pointer after calibration
    window.dispatchEvent(new CustomEvent('gaze:calibration-stopped'));

    if (message) {
      console.log('[HeadCal]', message);
    }
  }

  function averageSamples(samples) {
    if (!samples.length) return { nx: NaN, ny: NaN, yaw: NaN, pitch: NaN };
    const sum = samples.reduce((acc, cur) => {
      acc.nx += cur.nx;
      acc.ny += cur.ny;
      return acc;
    }, { nx: 0, ny: 0 });
    const count = samples.length || 1;
    return {
      nx: sum.nx / count,
      ny: sum.ny / count
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
    try {
      chrome.storage.local.set({ [HEAD_CAL_STORAGE_KEY]: calibration }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[HeadCal] storage set failed:', chrome.runtime.lastError.message);
          stopCalibration('Storage unavailable');
          return;
        }
        console.log('[HeadCal] Saved calibration', calibration);
        updateUI('✅ Head calibration saved', 'Alt+N toggles head-pointer mode');
        window.dispatchEvent(new CustomEvent('head:calibrated', { detail: calibration }));
        window.dispatchEvent(new CustomEvent('gaze:status', {
          detail: { phase: 'live', note: 'head-cal saved' }
        }));
        setTimeout(() => stopCalibration('Completed'), 900);
      });
    } catch (error) {
      console.warn('[HeadCal] calibration persistence failed:', error);
      stopCalibration('Storage unavailable');
    }
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
    const { nx, ny, yaw, pitch } = event.detail;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    window.__lastHeadFrame = {
      nx,
      ny,
      yaw: Number.isFinite(yaw) ? yaw : (window.__lastHeadFrame && Number.isFinite(window.__lastHeadFrame.yaw) ? window.__lastHeadFrame.yaw : 0),
      pitch: Number.isFinite(pitch) ? pitch : (window.__lastHeadFrame && Number.isFinite(window.__lastHeadFrame.pitch) ? window.__lastHeadFrame.pitch : 0)
    };
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
      // Ignore SPACE when waiting for user to click begin button
      if (waitingToStart) return;
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
