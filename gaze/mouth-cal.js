(function() {
  'use strict';

  const MOUTH_CAL_STORAGE_KEY = 'mouthCalV1';
  const MIN_SAMPLES = 20;

  let calUI = null;
  let currentStep = 'idle'; // 'idle', 'open', 'closed'
  let samples = [];

  function createCalibrationUI() {
    const overlay = document.createElement('div');
    overlay.id = 'mouth-cal-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.9);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      background: #2a2a2a;
      border-radius: 16px;
      padding: 48px;
      max-width: 600px;
      text-align: center;
      color: white;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    `;

    panel.innerHTML = `
      <div style="font-size: 48px; margin-bottom: 16px;">👄</div>
      <h2 style="margin: 0 0 16px 0; font-size: 28px; font-weight: 600;">Mouth Click Calibration</h2>
      <p id="mouth-cal-instructions" style="font-size: 18px; line-height: 1.6; margin: 0 0 32px 0; color: #ccc;">
        Click "Start" to begin calibrating mouth-open detection.<br>
        You'll capture your mouth in two positions: open and closed.
      </p>
      <div id="mouth-cal-progress" style="display: none; margin-bottom: 24px;">
        <div style="font-size: 64px; font-weight: bold; color: #8b5a3c;" id="mouth-cal-count">0</div>
        <div style="font-size: 14px; color: #999;">samples collected</div>
      </div>
      <button id="mouth-cal-action" style="
        background: #8b5a3c;
        color: white;
        border: none;
        padding: 16px 48px;
        font-size: 18px;
        font-weight: 600;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.2s;
      ">Start Calibration</button>
      <div style="margin-top: 24px; font-size: 14px; color: #999;">Press ESC to cancel</div>
    `;

    overlay.appendChild(panel);
    return overlay;
  }

  function updateUI(step, count = 0) {
    const instructions = document.getElementById('mouth-cal-instructions');
    const progress = document.getElementById('mouth-cal-progress');
    const countEl = document.getElementById('mouth-cal-count');
    const button = document.getElementById('mouth-cal-action');

    if (!instructions || !button) return;

    countEl.textContent = count;

    if (step === 'start') {
      instructions.innerHTML = `
        <strong style="font-size: 24px; color: #8b5a3c;">Step 1: Open Mouth</strong><br><br>
        OPEN your mouth wide (like saying "AAAH")<br>
        and press SPACE or click the button below.
      `;
      progress.style.display = 'block';
      button.textContent = 'Capture Open Mouth';
      button.style.background = '#8b5a3c';
    } else if (step === 'open-collecting') {
      instructions.innerHTML = `
        <strong style="font-size: 24px; color: #4CAF50;">Keep mouth OPEN!</strong><br><br>
        Collecting samples... ${count}/${MIN_SAMPLES}
      `;
      button.textContent = 'Collecting...';
      button.disabled = true;
      button.style.background = '#666';
      button.style.cursor = 'not-allowed';
    } else if (step === 'open-done') {
      instructions.innerHTML = `
        <strong style="font-size: 24px; color: #4CAF50;">✓ Open mouth captured!</strong><br><br>
        <strong style="font-size: 24px; color: #8b5a3c;">Step 2: Close Mouth</strong><br><br>
        CLOSE your mouth normally (relaxed)<br>
        and press SPACE or click the button below.
      `;
      button.textContent = 'Capture Closed Mouth';
      button.disabled = false;
      button.style.background = '#8b5a3c';
      button.style.cursor = 'pointer';
    } else if (step === 'closed-collecting') {
      instructions.innerHTML = `
        <strong style="font-size: 24px; color: #4CAF50;">Keep mouth CLOSED!</strong><br><br>
        Collecting samples... ${count}/${MIN_SAMPLES}
      `;
      button.textContent = 'Collecting...';
      button.disabled = true;
      button.style.background = '#666';
      button.style.cursor = 'not-allowed';
    } else if (step === 'done') {
      instructions.innerHTML = `
        <strong style="font-size: 32px; color: #4CAF50;">🎉 Calibration Complete!</strong><br><br>
        Mouth-open clicking is now ready to use.<br>
        Open your mouth wide to trigger clicks!
      `;
      progress.style.display = 'none';
      button.textContent = 'Done';
      button.style.background = '#4CAF50';
    }
  }

  function collectSamples(type) {
    samples = [];
    currentStep = `${type}-collecting`;
    updateUI(currentStep, 0);

    const interval = setInterval(() => {
      const ratio = window.__lastMouthRatio || 0;
      if (ratio > 0) {
        samples.push(ratio);
        updateUI(currentStep, samples.length);

        if (samples.length >= MIN_SAMPLES) {
          clearInterval(interval);
          const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
          console.log(`[MouthCal] ${type} average: ${avg.toFixed(3)}`);

          if (type === 'open') {
            window.__mouthCalOpen = avg;
            currentStep = 'open-done';
            updateUI(currentStep);
          } else {
            window.__mouthCalClosed = avg;
            finishCalibration();
          }
        }
      }
    }, 100);

    // Store interval so we can cancel if needed
    window.__mouthCalInterval = interval;
  }

  function finishCalibration() {
    const openRatio = window.__mouthCalOpen;
    const closedRatio = window.__mouthCalClosed;

    // Calculate threshold at 70% between closed and open
    const threshold = closedRatio + (openRatio - closedRatio) * 0.7;

    const calibration = {
      version: 1,
      closedRatio,
      openRatio,
      threshold,
      timestamp: Date.now()
    };

    console.log('[MouthCal] Calibration complete:', calibration);

    // Save to storage
    chrome.storage.local.set({ [MOUTH_CAL_STORAGE_KEY]: calibration }, () => {
      console.log('[MouthCal] Saved to storage');
    });

    // Dispatch event to notify gaze-core
    window.dispatchEvent(new CustomEvent('mouth-cal:complete', {
      detail: calibration
    }));

    currentStep = 'done';
    updateUI(currentStep);

    setTimeout(() => {
      closeCalibration();
    }, 2000);
  }

  function startCalibration() {
    console.log('[MouthCal] Starting mouth calibration');
    window.__gazeMouthCalActive = true;

    calUI = createCalibrationUI();
    document.body.appendChild(calUI);

    const button = document.getElementById('mouth-cal-action');

    button.addEventListener('click', () => {
      if (currentStep === 'idle' || currentStep === 'start') {
        currentStep = 'open';
        collectSamples('open');
      } else if (currentStep === 'open-done') {
        currentStep = 'closed';
        collectSamples('closed');
      } else if (currentStep === 'done') {
        closeCalibration();
      }
    });

    // Handle spacebar
    const handleKeydown = (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        button.click();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        closeCalibration();
      }
    };

    document.addEventListener('keydown', handleKeydown);
    calUI.__keydownHandler = handleKeydown;

    currentStep = 'start';
    updateUI(currentStep);
  }

  function closeCalibration() {
    console.log('[MouthCal] Closing calibration');
    window.__gazeMouthCalActive = false;

    if (window.__mouthCalInterval) {
      clearInterval(window.__mouthCalInterval);
      window.__mouthCalInterval = null;
    }

    if (calUI) {
      if (calUI.__keydownHandler) {
        document.removeEventListener('keydown', calUI.__keydownHandler);
      }
      calUI.remove();
      calUI = null;
    }

    currentStep = 'idle';
    samples = [];
  }

  // Expose function globally
  window.startMouthCalibration = startCalibration;

  // Listen for calibration requests
  window.addEventListener('mouth-cal:start', startCalibration);

  // Keyboard shortcut: Alt+M
  document.addEventListener('keydown', (event) => {
    const code = event.code || '';
    if (event.altKey && !event.ctrlKey && !event.metaKey && code === 'KeyM') {
      event.preventDefault();
      event.stopPropagation();
      startCalibration();
    }
  }, true);

  console.log('[MouthCal] Mouth calibration module loaded. Press Alt+M to calibrate.');
})();
