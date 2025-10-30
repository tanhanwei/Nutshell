(function() {
  'use strict';

  const STATUS_EVENT = 'gaze:status';
  const POINT_EVENT = 'gaze:point';
  const GAZE_ENABLED_KEY = 'gazeEnabled';
  const HEAD_CAL_STORAGE_KEY = 'headCalV2';
  const EAR_CAL_STORAGE_KEY = 'earCalV2';
  const DEFAULT_DWELL_MS = 600;
  const HUMAN_MODULE_PATH = 'gaze/human/human.esm.js';
  const HUMAN_MODELS_DIR = 'gaze/human/models/';
  const POINT_THROTTLE_MS = 33;
  const HEAD_FILTER_MIN_CUTOFF = 0.8;
  const HEAD_FILTER_BETA = 0.0025;
  const HEAD_FILTER_D_CUTOFF = 1.0;
  const HEAD_POINTER_LERP = 0.2;
  const HEAD_TRANSLATION_GAIN = 1;
  const HEAD_ROTATION_INFLUENCE = 0.35;
  const HEAD_YAW_SCALE = 25;
  const HEAD_PITCH_SCALE = 20;
  const BLINK_LEFT_THRESHOLD_MS = 1000;
  const BLINK_RIGHT_THRESHOLD_MS = 2000;
  const BLINK_RELEASE_EVENT = 'blink:released';
  const EAR_OPEN_SAMPLES_REQUIRED = 60;
  const EAR_CLOSED_COLLECTION_MS = 700;
  const EAR_STAGE_RESET_MS = 220;
  const DEFAULT_HEAD_CAL = {
    cx: 0,
    cy: 0,
    left: 0.4,
    right: 0.4,
    up: 0.3,
    down: 0.35,
    version: 2,
    ts: 0
  };
  const HEAD_MIRROR_X = -1;
  const HEAD_MIRROR_Y = 1;
  const AUTO_CENTER_ALPHA = 0.05;

  let human = null;
  let video = null;
  let stream = null;
  let rafHandle = null;
  let videoFrameHandle = null;
  let initializationPromise = null;
  let phase = 'loading';
  let lastPointTs = 0;
  let lastFaceScore = 0;
  let previewOn = true;
  let probePrinted = false;
  let headCal = null;
  let headFilterX = null;
  let headFilterY = null;
  let lastHeadPoint = null;
let headModeWarned = false;
let headFrameErrorLogged = false;
let headAutoCenter = { nx: 0, ny: 0, ready: false };
  let earCal = null;
  let earCalStage = 'idle';
  let earOpenSamples = [];
  let earClosedSamples = [];
  let earClosedStart = null;
  let blinkClosedAt = null;
  let blinkHoldEmitted = false;
  let previewSkipToggle = false;

  let gazeEnabled = false;
  if (typeof window.__gazeHeadMode !== 'boolean') {
    window.__gazeHeadMode = true;
  }
  if (typeof window.__gazeHeadCalActive !== 'boolean') {
    window.__gazeHeadCalActive = false;
  }
  if (!window.__lastHeadFrame) {
    window.__lastHeadFrame = { nx: 0, ny: 0 };
  }

  window.addEventListener('gaze:preview-toggle', (event) => {
    previewOn = Boolean(event && event.detail && event.detail.on);
  });

  function computeAlpha(fc, dtSeconds) {
    const tau = 1 / (2 * Math.PI * Math.max(1e-3, fc));
    return 1 / (1 + tau / Math.max(1e-4, dtSeconds));
  }

  function createOneEuroFilter(minCut = HEAD_FILTER_MIN_CUTOFF, beta = HEAD_FILTER_BETA, dCut = HEAD_FILTER_D_CUTOFF) {
    let prevValue = null;
    let prevTimestamp = null;
    let dxEstimate = null;
    let smoothed = null;
    return (value, timestampMs) => {
      if (!Number.isFinite(value) || !Number.isFinite(timestampMs)) {
        return value;
      }
      if (prevTimestamp === null) {
        prevTimestamp = timestampMs;
        prevValue = value;
        smoothed = value;
        dxEstimate = 0;
        return value;
      }
      const dt = Math.max(1e-3, (timestampMs - prevTimestamp) / 1000);
      prevTimestamp = timestampMs;
      const rawDerivative = (value - prevValue) / dt;
      prevValue = value;
      const alphaDerivative = computeAlpha(dCut, dt);
      dxEstimate = dxEstimate == null ? rawDerivative : (alphaDerivative * rawDerivative) + ((1 - alphaDerivative) * dxEstimate);
      const cutoff = minCut + beta * Math.abs(dxEstimate);
      const alpha = computeAlpha(cutoff, dt);
      smoothed = smoothed == null ? value : (alpha * value) + ((1 - alpha) * smoothed);
      return smoothed;
    };
  }

  function mapHeadLocalToXY(nx, ny, cal) {
    if (!cal) return null;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;

    const centerX = Number.isFinite(cal.cx) ? cal.cx : 0;
    const centerY = Number.isFinite(cal.cy) ? cal.cy : 0;

    const dx = nx - centerX;
    const dy = ny - centerY;

    const leftRange = Math.max(1e-3, cal.left || 0.01);
    const rightRange = Math.max(1e-3, cal.right || 0.01);
    const upRange = Math.max(1e-3, cal.up || 0.01);
    const downRange = Math.max(1e-3, cal.down || 0.01);

    let tx;
    if (dx < 0) {
      const ratio = Math.max(-1, Math.min(0, dx / leftRange));
      tx = 0.5 + 0.5 * ratio;
    } else {
      const ratio = Math.max(0, Math.min(1, dx / rightRange));
      tx = 0.5 + 0.5 * ratio;
    }

    let ty;
    if (dy < 0) {
      const ratio = Math.max(-1, Math.min(0, dy / upRange));
      ty = 0.5 + 0.5 * ratio;
    } else {
      const ratio = Math.max(0, Math.min(1, dy / downRange));
      ty = 0.5 + 0.5 * ratio;
    }

    tx = Math.max(0, Math.min(1, tx));
    ty = Math.max(0, Math.min(1, ty));

    const viewportWidth = Math.max(1, window.innerWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || 1);

    const px = Math.max(0, Math.min(viewportWidth - 1, tx * viewportWidth));
    const py = Math.max(0, Math.min(viewportHeight - 1, ty * viewportHeight));
    return [px, py];
  }

  const LEFT_EYE_CANDIDATES = [33, 246, 161, 160, 159, 130];
  const RIGHT_EYE_CANDIDATES = [362, 466, 388, 387, 386, 359];
  const NOSE_CANDIDATES = [1, 4, 5, 6, 197, 168, 2, 94];

  function centroid(points) {
    if (!Array.isArray(points) || !points.length) {
      return null;
    }
    let x = 0;
    let y = 0;
    let count = 0;
    for (let i = 0; i < points.length; i += 1) {
      const p = normalizePoint(points[i]);
      if (!p) continue;
      x += p[0];
      y += p[1];
      count += 1;
    }
    if (!count) {
      return null;
    }
    return [x / count, y / count];
  }

  function pointFromAnnotations(annotations, keys) {
    if (!annotations || !Array.isArray(keys)) {
      return null;
    }
    for (let i = 0; i < keys.length; i += 1) {
      const arr = annotations[keys[i]];
      const c = centroid(arr);
      if (c) return c;
    }
    return null;
  }

  function resolvePoint(mesh, annotations, candidates, annotationKeys) {
    for (let i = 0; i < candidates.length; i += 1) {
      const p = pick(mesh, candidates[i]);
      if (p) {
        return p;
      }
    }
    if (annotations) {
      const annPoint = pointFromAnnotations(annotations, annotationKeys);
      if (annPoint) {
        return annPoint;
      }
    }
    return null;
  }

  function computeHeadFrame(face) {
    if (!face) {
      return null;
    }
    const mesh = face.mesh;
    if (!mesh) {
      return null;
    }
    const annotations = face.annotations || {};
    let leftEye = resolvePoint(mesh, annotations, LEFT_EYE_CANDIDATES, ['leftEyeUpper0', 'leftEyeLower0', 'leftEyeUpper1']);
    let rightEye = resolvePoint(mesh, annotations, RIGHT_EYE_CANDIDATES, ['rightEyeUpper0', 'rightEyeLower0', 'rightEyeUpper1']);
    let noseTip = resolvePoint(mesh, annotations, NOSE_CANDIDATES, ['noseTip', 'midwayBetweenEyes']);

    if ((!leftEye || !rightEye) && annotations.midwayBetweenEyes) {
      const fallback = centroid(annotations.midwayBetweenEyes);
      if (fallback) {
        if (!leftEye) {
          leftEye = [fallback[0] - 5, fallback[1]];
        }
        if (!rightEye) {
          rightEye = [fallback[0] + 5, fallback[1]];
        }
      }
    }

    if (!leftEye || !rightEye) {
      return null;
    }

    if (!noseTip) {
      const centerGuess = [(leftEye[0] + rightEye[0]) / 2, (leftEye[1] + rightEye[1]) / 2];
      noseTip = centerGuess;
    }
    if (!noseTip) {
      return null;
    }

    const eyeVec = [rightEye[0] - leftEye[0], rightEye[1] - leftEye[1]];
    const iod = Math.hypot(eyeVec[0], eyeVec[1]);
    if (!iod || !Number.isFinite(iod)) {
      return null;
    }
    eyeVec[0] /= iod;
    eyeVec[1] /= iod;
    const vertical = [-eyeVec[1], eyeVec[0]];
    const center = [(leftEye[0] + rightEye[0]) / 2, (leftEye[1] + rightEye[1]) / 2];
    const noseVec = [noseTip[0] - center[0], noseTip[1] - center[1]];
    const u = (noseVec[0] * eyeVec[0]) + (noseVec[1] * eyeVec[1]);
    const v = (noseVec[0] * vertical[0]) + (noseVec[1] * vertical[1]);
    const normalization = Math.max(0.01, iod);
    const nx = Math.max(-1.5, Math.min(1.5, u / normalization));
    const ny = Math.max(-1.5, Math.min(1.5, v / normalization));
    return {
      nx: nx * HEAD_MIRROR_X,
      ny: ny * HEAD_MIRROR_Y,
      iod,
      center,
      leftEye,
      rightEye,
      nose: noseTip,
      ex: eyeVec,
      ey: vertical
    };
  }

  function distancePoint(a, b) {
    if (!a || !b) return NaN;
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  function leftEAR(mesh) {
    const top = pick(mesh, 159);
    const bottom = pick(mesh, 145);
    const leftCorner = pick(mesh, 33);
    const rightCorner = pick(mesh, 133);
    if (!top || !bottom || !leftCorner || !rightCorner) return NaN;
    const vertical = distancePoint(top, bottom);
    const horizontal = Math.max(1, distancePoint(leftCorner, rightCorner));
    return vertical / horizontal;
  }

  function rightEAR(mesh) {
    const top = pick(mesh, 386);
    const bottom = pick(mesh, 374);
    const leftCorner = pick(mesh, 362);
    const rightCorner = pick(mesh, 263);
    if (!top || !bottom || !leftCorner || !rightCorner) return NaN;
    const vertical = distancePoint(top, bottom);
    const horizontal = Math.max(1, distancePoint(leftCorner, rightCorner));
    return vertical / horizontal;
  }

  function averageEarSamples(samples) {
    if (!samples || !samples.length) {
      return [NaN, NaN];
    }
    let sumL = 0;
    let sumR = 0;
    samples.forEach(([l, r]) => {
      sumL += l;
      sumR += r;
    });
    return [sumL / samples.length, sumR / samples.length];
  }

  function finalizeEarCalibration(openAvg, closedAvg) {
    const [openL, openR] = openAvg;
    const [closedL, closedR] = closedAvg;
    if (!Number.isFinite(openL) || !Number.isFinite(openR) || !Number.isFinite(closedL) || !Number.isFinite(closedR)) {
      console.debug('[Blink] Unable to finalize EAR calibration; invalid averages', { openAvg, closedAvg });
      return;
    }
    const cal = {
      version: 2,
      Lopen: openL,
      Ropen: openR,
      Lclosed: closedL,
      Rclosed: closedR,
      Lclose: (openL * 0.65 + closedL * 1.35) / 2,
      Rclose: (openR * 0.65 + closedR * 1.35) / 2,
      LopenTh: (openL * 0.90 + closedL * 1.10) / 2,
      RopenTh: (openR * 0.90 + closedR * 1.10) / 2,
      ts: Date.now()
    };
    earCal = cal;
    earCalStage = 'done';
    earOpenSamples = [];
    earClosedSamples = [];
    earClosedStart = null;
    storageSet({ [EAR_CAL_STORAGE_KEY]: cal });
    dispatchStatus('live', 'Blink calibration saved');
    console.debug('[Blink] EAR calibration saved', cal);
  }

  function ensureEarCalibration(mesh, ts) {
    const left = leftEAR(mesh);
    const right = rightEAR(mesh);
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return;
    }
    if (earCal && earCal.version === 2) {
      earCalStage = 'done';
      return;
    }
    if (earCalStage === 'idle') {
      earCalStage = 'collect_open';
      earOpenSamples = [];
      earClosedSamples = [];
      earClosedStart = null;
      dispatchStatus('calibrating', 'Blink: keep eyes open');
      console.debug('[Blink] Starting EAR open baseline capture');
    }
    if (earCalStage === 'collect_open') {
      earOpenSamples.push([left, right]);
      if (earOpenSamples.length >= EAR_OPEN_SAMPLES_REQUIRED) {
        earCalStage = 'await_closed';
        dispatchStatus('ready', 'Blink: gently close eyes for ~1s');
        console.debug('[Blink] Open baseline captured; waiting for closed baseline');
      }
      return;
    }
    if (earCalStage === 'await_closed') {
      const openAvg = averageEarSamples(earOpenSamples);
      const shouldCaptureClosed = left < openAvg[0] * 0.7 && right < openAvg[1] * 0.7;
      if (shouldCaptureClosed) {
        earClosedSamples.push([left, right]);
        if (!earClosedStart) {
          earClosedStart = ts;
          console.debug('[Blink] Closed-eye capture started');
        }
        if (ts - earClosedStart >= EAR_CLOSED_COLLECTION_MS) {
          finalizeEarCalibration(openAvg, averageEarSamples(earClosedSamples));
        }
      } else if (earClosedStart && (ts - earClosedStart) > EAR_STAGE_RESET_MS) {
        earClosedSamples = [];
        earClosedStart = null;
      }
    }
  }

  function triggerBlinkClick(button) {
    window.dispatchEvent(new CustomEvent('blink:click', {
      detail: { button }
    }));
  }

  function updateBlinkState(mesh, ts) {
    if (!earCal || earCal.version !== 2) {
      ensureEarCalibration(mesh, ts);
      return;
    }
    const left = leftEAR(mesh);
    const right = rightEAR(mesh);
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return;
    }
    const leftClosed = left < earCal.Lclose;
    const rightClosed = right < earCal.Rclose;
    const leftOpen = left > earCal.LopenTh;
    const rightOpen = right > earCal.RopenTh;
    const bothClosed = leftClosed && rightClosed;
    if (bothClosed) {
      if (blinkClosedAt === null) {
        blinkClosedAt = ts;
        blinkHoldEmitted = false;
        window.dispatchEvent(new CustomEvent('blink:start', {
          detail: { timestamp: ts }
        }));
      }
      const duration = ts - blinkClosedAt;
      if (!blinkHoldEmitted && duration >= BLINK_LEFT_THRESHOLD_MS) {
        window.dispatchEvent(new CustomEvent('blink:hold', {
          detail: { duration }
        }));
        blinkHoldEmitted = true;
      }
    } else if (leftOpen && rightOpen && blinkClosedAt !== null) {
      const duration = ts - blinkClosedAt;
      window.dispatchEvent(new CustomEvent(BLINK_RELEASE_EVENT, {
        detail: {
          duration,
          timestamp: ts
        }
      }));
      blinkClosedAt = null;
      blinkHoldEmitted = false;
      if (!window.__gazeHeadCalActive) {
        if (duration >= BLINK_RIGHT_THRESHOLD_MS) {
          triggerBlinkClick('right');
        } else if (duration >= BLINK_LEFT_THRESHOLD_MS) {
          triggerBlinkClick('left');
        }
      }
    }
  }

  function dispatchStatus(nextPhase, note) {
    phase = nextPhase;
    window.dispatchEvent(new CustomEvent(STATUS_EVENT, {
      detail: { phase: nextPhase, note: note || null }
    }));
  }

  function dispatchPoint(x, y, confidence, ts) {
    window.dispatchEvent(new CustomEvent(POINT_EVENT, {
      detail: { x, y, conf: confidence, ts }
    }));
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (result) => {
          resolve(result || {});
        });
      } catch (error) {
        console.warn('[GazeCore] storage.get failed:', error);
        resolve({});
      }
    });
  }

  function storageSet(payload) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(payload, () => resolve());
      } catch (error) {
        console.warn('[GazeCore] storage.set failed:', error);
        resolve();
      }
    });
  }

  async function ensureInitialized() {
    if (initializationPromise) {
      return initializationPromise;
    }
    initializationPromise = (async () => {
      dispatchStatus('loading', 'Loading Human.js models');
      const humanUrl = chrome.runtime.getURL(HUMAN_MODULE_PATH);
      let HumanCtor = null;
      try {
        const imported = await import(humanUrl);
        HumanCtor = imported && imported.default ? imported.default : imported.Human || imported;
        if (typeof HumanCtor !== 'function') {
          throw new Error('Invalid Human.js export');
        }
      } catch (error) {
        console.error('[GazeCore] Failed to import Human.js bundle:', error);
        dispatchStatus('ready', 'Install gaze/human assets to enable gaze tracking');
        throw new Error('Human.js bundle not vendored. Copy dist/human.esm.js into gaze/human/human.esm.js');
      }

      human = new HumanCtor({
        backend: 'webgl',
        modelBasePath: chrome.runtime.getURL(HUMAN_MODELS_DIR),
        cacheSensitivity: 0,
        face: {
          enabled: true,
          detector: { enabled: true, rotation: true, return: true, maxDetected: 1 },
          mesh: { enabled: true },
          iris: { enabled: false },
          attention: false,
          description: false,
          emotion: false,
          antispoof: false,
          liveness: false
        },
        filter: {
          enabled: true,
          equalization: true,
          temporalSmoothing: 0.9
        }
      });

      try {
        await human.load();
      } catch (error) {
        console.error('[GazeCore] Failed to load Human.js models:', error);
        dispatchStatus('ready', 'Model load failed');
        throw error;
      }
      if (typeof human.warmup === 'function') {
        try {
          await human.warmup();
        } catch (error) {
          console.debug('[GazeCore] warmup skipped:', error && error.message ? error.message : error);
        }
      }

      await ensureVideoStream();

      if (headCal && headCal.version === 2) {
        dispatchStatus('live', 'Head pointer ready');
      } else {
        dispatchStatus('ready', 'Press Alt+H to calibrate head pointer');
      }
      startDetectionLoop();
      return true;
    })();
    return initializationPromise;
  }

  async function ensureVideoStream() {
    if (video && stream) {
      return;
    }
    video = document.createElement('video');
    video.style.position = 'fixed';
    video.style.top = '-10000px';
    video.style.left = '-10000px';
    video.style.width = '1px';
    video.style.height = '1px';
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    document.body.appendChild(video);

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30, max: 30 }
        },
        audio: false
      });
      video.srcObject = stream;
      await video.play();
    } catch (error) {
      console.error('[GazeCore] Camera access denied:', error);
      dispatchStatus('ready', 'Camera access rejected');
      throw error;
    }
  }

  function startDetectionLoop() {
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (videoFrameHandle && video && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(videoFrameHandle);
      videoFrameHandle = null;
    }
    if (!human || !video) {
      return;
    }
    if (typeof video.requestVideoFrameCallback === 'function') {
      const onFrame = async () => {
        const currentVideo = video;
        if (!human || !currentVideo) {
          videoFrameHandle = null;
          return;
        }
        try {
          const startTs = performance.now();
          const result = await human.detect(currentVideo);
          processDetection(result, startTs);
        } catch (error) {
          console.warn('[GazeCore] detect failed:', error);
        } finally {
          const nextVideo = video;
          if (nextVideo && typeof nextVideo.requestVideoFrameCallback === 'function') {
            videoFrameHandle = nextVideo.requestVideoFrameCallback(onFrame);
          } else {
            videoFrameHandle = null;
          }
        }
      };
      videoFrameHandle = video.requestVideoFrameCallback(onFrame);
    } else {
      const step = async () => {
        const currentVideo = video;
        if (!human || !currentVideo) {
          rafHandle = null;
          return;
        }
        try {
          if (currentVideo.readyState >= 2) {
            const startTs = performance.now();
            const result = await human.detect(currentVideo);
            processDetection(result, startTs);
          }
        } catch (error) {
          console.warn('[GazeCore] detect failed:', error);
        }
        if (video && human) {
          rafHandle = requestAnimationFrame(step);
        } else {
          rafHandle = null;
        }
      };
      rafHandle = requestAnimationFrame(step);
    }
  }

  function processDetection(result, ts) {
    const face = result && result.face && result.face[0] ? result.face[0] : null;

    drawPreview(face);

    if (!face) {
      headFilterX = null;
      headFilterY = null;
      lastHeadPoint = null;
      headAutoCenter = { nx: headCal && headCal.cx || 0, ny: headCal && headCal.cy || 0, ready: Boolean(headCal) };
      window.__lastFace = null;
      window.__lastHeadFrame = null;
      return;
    }

    window.__lastFace = face;

    let headFrame = null;
    try {
      headFrame = computeHeadFrame(face);
    } catch (error) {
      if (!headFrameErrorLogged) {
        console.debug('[GazeCore] head-frame compute failed:', error);
        headFrameErrorLogged = true;
      }
      headFrame = null;
    }
    if (headFrame) {
      headFrameErrorLogged = false;
      window.__lastHeadFrame = { nx: headFrame.nx, ny: headFrame.ny };
      window.dispatchEvent(new CustomEvent('head:frame', {
        detail: { nx: headFrame.nx, ny: headFrame.ny, ts }
      }));
    } else {
      window.__lastHeadFrame = null;
    }

    const yawDeg = Number(face.rotation && face.rotation.angle ? face.rotation.angle.yaw : 0);
    const pitchDeg = Number(face.rotation && face.rotation.angle ? face.rotation.angle.pitch : 0);

    if (Array.isArray(face.mesh)) {
      if (!earCal) {
        ensureEarCalibration(face.mesh, ts);
      } else {
        updateBlinkState(face.mesh, ts);
      }
    }

    if (!probePrinted) {
      probeFace(face);
      probePrinted = true;
    }

    lastFaceScore = typeof face.score === 'number' ? face.score : 0.8;
    const now = ts;
    let confidence = Math.min(1, Math.max(0, lastFaceScore));
    let point = null;
    let fromHead = false;

    if (window.__gazeHeadMode) {
      if (headFrame) {
        if (!headFilterX || !headFilterY) {
          headFilterX = createOneEuroFilter();
          headFilterY = createOneEuroFilter();
          lastHeadPoint = null;
        }
        let activeCal;
        if (headCal && headCal.version === 2) {
          if (headAutoCenter.ready) {
            headAutoCenter.ready = false;
          }
          activeCal = headCal;
        } else {
          if (!headAutoCenter.ready) {
            headAutoCenter = { nx: headFrame.nx, ny: headFrame.ny, ready: true };
          } else {
            headAutoCenter.nx += (headFrame.nx - headAutoCenter.nx) * AUTO_CENTER_ALPHA;
            headAutoCenter.ny += (headFrame.ny - headAutoCenter.ny) * AUTO_CENTER_ALPHA;
          }
          activeCal = {
            ...DEFAULT_HEAD_CAL,
            cx: headAutoCenter.nx,
            cy: headAutoCenter.ny
          };
        }
        const yawNorm = Math.max(-1, Math.min(1, yawDeg / HEAD_YAW_SCALE));
        const pitchNorm = Math.max(-1, Math.min(1, pitchDeg / HEAD_PITCH_SCALE));
        const centerNx = activeCal.cx || 0;
        const centerNy = activeCal.cy || 0;
        const leftRange = Math.max(1e-3, activeCal.left || 0.01);
        const rightRange = Math.max(1e-3, activeCal.right || 0.01);
        const upRange = Math.max(1e-3, activeCal.up || 0.01);
        const downRange = Math.max(1e-3, activeCal.down || 0.01);

        const offsetNx = headFrame.nx - centerNx;
        const offsetNy = headFrame.ny - centerNy;

        let normX = 0;
        if (offsetNx < 0) {
          normX = offsetNx / leftRange;
        } else {
          normX = offsetNx / rightRange;
        }

        let normY = 0;
        if (offsetNy < 0) {
          normY = offsetNy / upRange;
        } else {
          normY = offsetNy / downRange;
        }

        if (Math.abs(normX) < 1) {
          normX += yawNorm * HEAD_ROTATION_INFLUENCE * (1 - Math.abs(normX));
        }
        if (Math.abs(normY) < 1) {
          normY += (-pitchNorm) * HEAD_ROTATION_INFLUENCE * (1 - Math.abs(normY));
        }

        normX = Math.max(-1.2, Math.min(1.2, normX));
        normY = Math.max(-1.2, Math.min(1.2, normY));

        const targetNx = normX < 0 ? centerNx + normX * leftRange : centerNx + normX * rightRange;
        const targetNy = normY < 0 ? centerNy + normY * upRange : centerNy + normY * downRange;
        const mapped = mapHeadLocalToXY(targetNx, targetNy, activeCal);
        if (mapped) {
          const filteredX = headFilterX(mapped[0], ts);
          const filteredY = headFilterY(mapped[1], ts);
          let finalX = Number.isFinite(filteredX) ? filteredX : mapped[0];
          let finalY = Number.isFinite(filteredY) ? filteredY : mapped[1];
          if (lastHeadPoint) {
            finalX = lastHeadPoint[0] + HEAD_POINTER_LERP * (finalX - lastHeadPoint[0]);
            finalY = lastHeadPoint[1] + HEAD_POINTER_LERP * (finalY - lastHeadPoint[1]);
            lastHeadPoint[0] = finalX;
            lastHeadPoint[1] = finalY;
          } else {
            lastHeadPoint = [finalX, finalY];
          }
          point = [finalX, finalY];
          confidence = Math.max(confidence, 0.9);
          fromHead = true;
          if (!headCal && !headModeWarned) {
            dispatchStatus('live', 'Head pointer (Alt+H to refine)');
            headModeWarned = true;
          } else if (headCal) {
            headModeWarned = false;
          }
        }
      } else if (!headModeWarned) {
        dispatchStatus('ready', 'Need face landmarks for head pointer');
        headModeWarned = true;
      }
    } else {
      headFilterX = null;
      headFilterY = null;
      lastHeadPoint = null;
      headModeWarned = false;
      headFrameErrorLogged = false;
    }
    if (!point) {
      return;
    }

    if (window.__gazeHeadCalActive) {
      lastPointTs = now;
      return;
    }

    if (window.__gazeHeadCalActive) {
      lastPointTs = now;
      return;
    }

    if (now - lastPointTs >= POINT_THROTTLE_MS) {
      lastPointTs = now;
      dispatchPoint(point[0], point[1], confidence, now);
    }
  }

  function normalizePoint(point) {
    if (!point) return null;
    if (Array.isArray(point) || ArrayBuffer.isView(point)) {
      const x = point[0];
      const y = point[1];
      if (Number.isFinite(x) && Number.isFinite(y)) {
        return [x, y];
      }
      return null;
    }
    if (typeof point === 'object' && point) {
      const x = Number(point.x ?? point[0]);
      const y = Number(point.y ?? point[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        return [x, y];
      }
    }
    return null;
  }

  function pick(mesh, idx) {
    if (!mesh || idx < 0) {
      return null;
    }
    if (Array.isArray(mesh)) {
      if (idx < mesh.length) {
        const direct = normalizePoint(mesh[idx]);
        if (direct) {
          return direct;
        }
      }
      if (typeof mesh[0] === 'number') {
        const base = idx * 3;
        if (base + 1 < mesh.length) {
          const x = mesh[base];
          const y = mesh[base + 1];
          if (Number.isFinite(x) && Number.isFinite(y)) {
            return [x, y];
          }
        }
      }
      return null;
    }
    if (ArrayBuffer.isView(mesh) && typeof mesh[0] === 'number') {
      const base = idx * 3;
      if (base + 1 < mesh.length) {
        const x = mesh[base];
        const y = mesh[base + 1];
        if (Number.isFinite(x) && Number.isFinite(y)) {
          return [x, y];
        }
      }
      return null;
    }
    const raw = mesh[idx];
    return normalizePoint(raw);
  }

  function drawPreview(face) {
    if (!previewOn) {
      return;
    }
    const canvas = document.getElementById('gaze-cam');
    if (!canvas || canvas.style.display !== 'block') {
      return;
    }
    previewSkipToggle = !previewSkipToggle;
    if (previewSkipToggle) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx || !video) {
      return;
    }
    const vw = video.videoWidth || canvas.width || 320;
    const vh = video.videoHeight || canvas.height || 240;
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw;
      canvas.height = vh;
    }

    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -vw, 0, vw, vh);
    ctx.restore();

    if (!face) {
      return;
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,255,255,0.8)';
    ctx.fillStyle = 'rgba(255,255,0,0.9)';

    if (face.box) {
      const box = face.box;
      const x = Math.max(0, Math.min(vw, box[0]));
      const y = Math.max(0, Math.min(vh, box[1]));
      const w = Math.max(1, box[2]);
      const h = Math.max(1, box[3]);
      ctx.strokeStyle = 'rgba(0,255,180,0.6)';
      ctx.lineWidth = 2;
      ctx.strokeRect(vw - x - w, y, w, h);
      ctx.beginPath();
      ctx.moveTo(vw - (x + w / 2), y);
      ctx.lineTo(vw - (x + w / 2), y + h);
      ctx.moveTo(vw - x, y + h / 2);
      ctx.lineTo(vw - (x + w), y + h / 2);
      ctx.stroke();
    }

    if (Array.isArray(face.mesh) && face.mesh.length) {
      ctx.strokeStyle = 'rgba(0,140,255,0.35)';
      ctx.lineWidth = 1;
      const indices = [33, 133, 362, 263, 1, 4, 5, 197];
      const pathPts = [];
      indices.forEach((idx) => {
        const pt = pick(face.mesh, idx);
        if (pt) {
          let px = pt[0];
          let py = pt[1];
          if (Math.abs(px) <= 1 && Math.abs(py) <= 1) {
            px = (px + 0.5) * vw;
            py = (py + 0.5) * vh;
          }
          pathPts.push([px, py]);
        }
      });
      if (pathPts.length >= 3) {
        ctx.beginPath();
        pathPts.forEach((p, idx) => {
          const mirroredX = vw - p[0];
          if (idx === 0) {
            ctx.moveTo(mirroredX, p[1]);
          } else {
            ctx.lineTo(mirroredX, p[1]);
          }
        });
        ctx.closePath();
        ctx.stroke();
      }
    }

    const points = [];
    const annotations = face.annotations || {};
    const pushAnnotationPoints = (arr) => {
      if (!Array.isArray(arr)) return;
      for (let i = 0; i < arr.length; i += 1) {
        const norm = normalizePoint(arr[i]);
        if (norm) {
          points.push(norm);
        }
      }
    };
    pushAnnotationPoints(annotations.leftEyeIris);
    pushAnnotationPoints(annotations.rightEyeIris);

    if (!points.length && face.iris) {
      const leftIris = Array.isArray(face.iris.left) ? face.iris.left : face.iris[0];
      const rightIris = Array.isArray(face.iris.right) ? face.iris.right : face.iris[1];
      pushAnnotationPoints(leftIris);
      pushAnnotationPoints(rightIris);
    }

    if (!points.length && Array.isArray(face.mesh) && face.mesh.length) {
      const irisIndices = [468, 469, 470, 471, 472, 473, 474, 475, 476, 477];
      for (let i = 0; i < irisIndices.length; i += 1) {
        const pt = pick(face.mesh, irisIndices[i]);
        if (pt) {
          points.push(pt);
        }
      }
    }

    points.forEach((point) => {
      const norm = normalizePoint(point);
      if (!norm) {
        return;
      }
      let px = norm[0];
      let py = norm[1];
      if (Math.abs(px) <= 1 && Math.abs(py) <= 1) {
        px = (px + 0.5) * vw;
        py = (py + 0.5) * vh;
      }
      if (!Number.isFinite(px) || !Number.isFinite(py)) {
        return;
      }
      ctx.beginPath();
      ctx.arc(vw - px, py, 2.2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function probeFace(face) {
    try {
      const annotationKeys = Object.keys(face.annotations || {}).slice(0, 20);
      console.debug('[GazeCore] face keys:', Object.keys(face));
      console.debug('[GazeCore] annotations keys:', annotationKeys);
      console.debug('[GazeCore] mesh length:', Array.isArray(face.mesh) ? face.mesh.length : 'n/a');
      console.debug('[GazeCore] rotation angle:', face.rotation && face.rotation.angle);
    } catch (error) {
      console.debug('[GazeCore] probeFace failed:', error);
    }
  }

  function teardown() {
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (videoFrameHandle && video && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(videoFrameHandle);
      videoFrameHandle = null;
    }
    if (stream) {
      const tracks = stream.getTracks();
      tracks.forEach((track) => track.stop());
      stream = null;
    }
    if (video && video.parentElement) {
      video.srcObject = null;
      video.parentElement.removeChild(video);
      video = null;
    }
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== 'local') return;
    if (changes[GAZE_ENABLED_KEY]) {
      gazeEnabled = Boolean(changes[GAZE_ENABLED_KEY].newValue);
      if (gazeEnabled) {
        ensureInitialized().catch(() => {});
      }
    }
    if (changes[HEAD_CAL_STORAGE_KEY]) {
      headCal = changes[HEAD_CAL_STORAGE_KEY].newValue || null;
      headFilterX = null;
      headFilterY = null;
      lastHeadPoint = null;
      headModeWarned = false;
      headAutoCenter = { nx: headCal && headCal.cx || 0, ny: headCal && headCal.cy || 0, ready: Boolean(headCal) };
      if (headCal) {
        const centerX = Math.round((window.innerWidth || 1) / 2);
        const centerY = Math.round((window.innerHeight || 1) / 2);
        lastHeadPoint = [centerX, centerY];
        lastPointTs = performance.now();
        dispatchPoint(centerX, centerY, 0.9, lastPointTs);
      }
    } else if (changes.headCalV1) {
      console.debug('[GazeCore] Ignoring legacy head calibration; please recalibrate.');
    }
    if (changes[EAR_CAL_STORAGE_KEY] && changes[EAR_CAL_STORAGE_KEY].newValue) {
      earCal = changes[EAR_CAL_STORAGE_KEY].newValue;
      earCalStage = earCal && earCal.version === 2 ? 'done' : 'idle';
    } else if (changes.earCalV1 && changes.earCalV1.newValue) {
      console.debug('[GazeCore] Ignoring legacy blink calibration; will rebuild.');
    }
  }

  function handleVisibilityChange() {
    // no-op; head filters automatically reset when face is lost
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);
  chrome.storage.onChanged.addListener(handleStorageChange);
  window.addEventListener('beforeunload', teardown);

  window.addEventListener('head:calibrated', (event) => {
    if (!event.detail) return;
    headCal = event.detail;
    headFilterX = null;
    headFilterY = null;
    lastHeadPoint = null;
    headModeWarned = false;
    headAutoCenter = { nx: headCal && headCal.cx || 0, ny: headCal && headCal.cy || 0, ready: true };
    const centerX = Math.round((window.innerWidth || 1) / 2);
    const centerY = Math.round((window.innerHeight || 1) / 2);
    lastHeadPoint = [centerX, centerY];
    lastPointTs = performance.now();
    dispatchPoint(centerX, centerY, 0.95, lastPointTs);
  });

  (() => {
    const canvas = document.getElementById('gaze-cam');
    if (canvas && canvas.style.display === 'block') {
      previewOn = true;
    }
  })();

  storageGet([GAZE_ENABLED_KEY, HEAD_CAL_STORAGE_KEY, EAR_CAL_STORAGE_KEY, 'headCalV1', 'earCalV1']).then((store) => {
    if (store[HEAD_CAL_STORAGE_KEY]) {
      headCal = store[HEAD_CAL_STORAGE_KEY];
      headModeWarned = false;
      headFrameErrorLogged = false;
      headFilterX = null;
      headFilterY = null;
      lastHeadPoint = null;
      headAutoCenter = { nx: headCal && headCal.cx || 0, ny: headCal && headCal.cy || 0, ready: Boolean(headCal) };
      const centerX = Math.round((window.innerWidth || 1) / 2);
      const centerY = Math.round((window.innerHeight || 1) / 2);
      lastHeadPoint = [centerX, centerY];
      lastPointTs = performance.now();
      dispatchPoint(centerX, centerY, 0.9, lastPointTs);
    } else if (store.headCalV1) {
      console.debug('[GazeCore] Legacy head calibration detected; run Alt+H to refresh.');
    }

    if (store[EAR_CAL_STORAGE_KEY]) {
      earCal = store[EAR_CAL_STORAGE_KEY];
      earCalStage = earCal && earCal.version === 2 ? 'done' : 'idle';
    }

    if (typeof store[GAZE_ENABLED_KEY] === 'boolean') {
      gazeEnabled = store[GAZE_ENABLED_KEY];
    } else {
      gazeEnabled = true;
      storageSet({ [GAZE_ENABLED_KEY]: true });
    }

    if (gazeEnabled) {
      ensureInitialized().catch(() => {});
    } else {
      dispatchStatus('ready', 'Enable gaze tracking to start head pointer');
    }
  });
})();
