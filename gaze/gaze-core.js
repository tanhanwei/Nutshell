(function() {
  'use strict';

  const STATUS_EVENT = 'gaze:status';
  const FEATURES_EVENT = 'gaze:features';
  const POINT_EVENT = 'gaze:point';
  const PARAMS_STORAGE_KEY = 'gazeLin';
  const CALIBRATION_META_KEY = 'gazeCalibrationV2';
  const GAZE_ENABLED_KEY = 'gazeEnabled';
  const DWELL_MS_KEY = 'gazeDwellMs';
  const DEFAULT_DWELL_MS = 600;
  const HUMAN_MODULE_PATH = 'gaze/human/human.esm.js';
  const HUMAN_MODELS_DIR = 'gaze/human/models/';
  const POINT_THROTTLE_MS = 33;
  const SMOOTHING_ALPHA = 0.35;
  const MAX_CALIBRATION_SAMPLES = 4000;

  let human = null;
  let video = null;
  let stream = null;
  let rafHandle = null;
  let initializationPromise = null;
  let phase = 'loading';
  let canEmitPoints = false;

  let isCalibrating = false;
  let captureTarget = null;
  let calibrationSamples = [];
  let weights = null;
  let bias = null;
  let smoothedPoint = null;
  let lastPointTs = 0;
  let lastFaceScore = 0;
  let previewOn = true;
  let probePrinted = false;
  let missingFeatureWarned = false;

  let gazeEnabled = false;
  if (!Array.isArray(window.__gazeW)) {
    window.__gazeW = null;
  }
  if (!Array.isArray(window.__gazeB)) {
    window.__gazeB = null;
  }
  if (typeof window.__gazeCalibrating !== 'boolean') {
    window.__gazeCalibrating = false;
  }
  if (typeof window.__gazeNoseFallback !== 'boolean') {
    window.__gazeNoseFallback = false;
  }
  if (typeof window.__gazePredict !== 'function') {
    window.__gazePredict = (feat) => gazePredictFromWB(feat, window.__gazeW, window.__gazeB, window.__gazeNorm);
  }

  window.addEventListener('gaze:preview-toggle', (event) => {
    previewOn = Boolean(event && event.detail && event.detail.on);
  });

  const calibrationFeatureLog = [];
  if (!window.__gazeNorm) {
    window.__gazeNorm = null;
  }

  function augmentFeatures(baseFeat) {
    const [lx, ly, rx, ry, yaw, pitch] = baseFeat;
    const ex = rx - lx;
    const ey = ry - ly;
    return [
      lx, ly, rx, ry, yaw, pitch,
      ex, ey,
      ex * ex,
      ey * ey,
      ex * ey,
      lx * lx,
      ly * ly,
      rx * rx,
      ry * ry
    ];
  }

  function standardizeMatrix(matrix) {
    const rowCount = matrix.length;
    const colCount = matrix[0].length;
    const mean = new Array(colCount).fill(0);
    const std = new Array(colCount).fill(0);
    matrix.forEach((row) => {
      for (let d = 0; d < colCount; d += 1) {
        mean[d] += row[d];
      }
    });
    for (let d = 0; d < colCount; d += 1) {
      mean[d] /= rowCount;
    }
    matrix.forEach((row) => {
      for (let d = 0; d < colCount; d += 1) {
        const delta = row[d] - mean[d];
        std[d] += delta * delta;
      }
    });
    for (let d = 0; d < colCount; d += 1) {
      std[d] = Math.sqrt(std[d] / rowCount) || 1;
    }
    const normalized = matrix.map((row) => row.map((value, d) => (value - mean[d]) / std[d]));
    return { normalized, mean, std };
  }

  function logTargetRanges(samples) {
    if (!samples || !samples.length) {
      console.debug('[GazeCore] No calibration targets to log');
      return;
    }
    let minx = Infinity;
    let maxx = -Infinity;
    let miny = Infinity;
    let maxy = -Infinity;
    samples.forEach((sample) => {
      const [tx, ty] = sample.target;
      if (typeof tx === 'number') {
        minx = Math.min(minx, tx);
        maxx = Math.max(maxx, tx);
      }
      if (typeof ty === 'number') {
        miny = Math.min(miny, ty);
        maxy = Math.max(maxy, ty);
      }
    });
    console.debug('[GazeCore] target ranges px:', {
      minx,
      maxx,
      miny,
      maxy,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    });
  }

  function logFeatureVariance() {
    if (!calibrationFeatureLog.length) {
      console.debug('[GazeCore] No feature samples collected during calibration');
      return;
    }
    const D = calibrationFeatureLog[0].length;
    const N = calibrationFeatureLog.length;
    const mean = new Array(D).fill(0);
    const variance = new Array(D).fill(0);
    calibrationFeatureLog.forEach((row) => {
      for (let d = 0; d < D; d += 1) {
        mean[d] += row[d];
      }
    });
    for (let d = 0; d < D; d += 1) {
      mean[d] /= N;
    }
    calibrationFeatureLog.forEach((row) => {
      for (let d = 0; d < D; d += 1) {
        const delta = row[d] - mean[d];
        variance[d] += delta * delta;
      }
    });
    for (let d = 0; d < D; d += 1) {
      variance[d] /= N;
    }
    const labels = ['Lx', 'Ly', 'Rx', 'Ry', 'yaw', 'pitch'];
    const table = variance.map((v, idx) => ({
      dim: labels[idx] || `f${idx}`,
      variance: v
    }));
    console.table(table);
    calibrationFeatureLog.length = 0;
  }

  function gazePredictFromWB(features, weightArray, biasArray, norm) {
    if (!Array.isArray(weightArray) || !Array.isArray(biasArray)) {
      return null;
    }
    const augmented = augmentFeatures(features);
    let xn = Number(biasArray[0]) || 0;
    let yn = Number(biasArray[1]) || 0;
    const count = Math.min(weightArray.length, augmented.length);
    if (norm && Array.isArray(norm.mu) && Array.isArray(norm.sd)) {
      for (let d = 0; d < count; d += 1) {
        const sd = norm.sd[d] || 1;
        augmented[d] = (augmented[d] - (norm.mu[d] || 0)) / sd;
      }
    }
    for (let i = 0; i < count; i += 1) {
      const row = weightArray[i];
      if (!row) continue;
      xn += (row[0] || 0) * augmented[i];
      yn += (row[1] || 0) * augmented[i];
    }
    const viewportWidth = Math.max(1, window.innerWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || 1);
    const px = xn * viewportWidth;
    const py = yn * viewportHeight;
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      return null;
    }
    return [
      Math.max(0, Math.min(viewportWidth - 1, px)),
      Math.max(0, Math.min(viewportHeight - 1, py))
    ];
  }

  function dispatchStatus(nextPhase, note) {
    phase = nextPhase;
    window.dispatchEvent(new CustomEvent(STATUS_EVENT, {
      detail: { phase: nextPhase, note: note || null }
    }));
  }

  function dispatchFeatures(features, ts) {
    window.dispatchEvent(new CustomEvent(FEATURES_EVENT, {
      detail: { feat: features.slice(), ts }
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
          detector: { enabled: true, rotation: true, return: true },
          mesh: { enabled: true },
          iris: { enabled: true }
        },
        filter: {
          enabled: true,
          equalization: true,
          temporalSmoothing: 0.7
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
      await tryRestoreCalibration();

      if (weights && weights.length && Array.isArray(bias)) {
        dispatchStatus('live', 'Calibration loaded');
      } else {
        dispatchStatus('ready', 'Press Alt+G to calibrate');
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
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
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
    }
    const step = async () => {
      if (!human || !video) {
        return;
      }
      try {
        if (video.readyState >= 2) {
          const startTs = performance.now();
          const result = await human.detect(video);
          processDetection(result, startTs);
        }
      } catch (error) {
        console.warn('[GazeCore] detect failed:', error);
      }
      rafHandle = requestAnimationFrame(step);
    };
    rafHandle = requestAnimationFrame(step);
  }

  function processDetection(result, ts) {
    const face = result && result.face && result.face[0] ? result.face[0] : null;

    drawPreview(face);

    if (!face) {
      smoothedPoint = null;
      return;
    }

    if (!probePrinted) {
      probeFace(face);
      probePrinted = true;
    }

    lastFaceScore = typeof face.score === 'number' ? face.score : 0.8;

    const features = featuresFromFace(face);
    if (!features) {
      if (!missingFeatureWarned && !window.__gazeNoseFallback) {
        console.warn('[GazeCore] Unable to derive iris features; toggle Alt+V for preview or Alt+N for nose fallback.');
        missingFeatureWarned = true;
      }
    } else {
      missingFeatureWarned = false;
    }

    if (isCalibrating && captureTarget) {
      if (features) {
        calibrationSamples.push({ feat: features.slice(), target: captureTarget.slice(), ts });
        if (calibrationSamples.length > MAX_CALIBRATION_SAMPLES) {
          calibrationSamples.shift();
        }
        dispatchFeatures(features, ts);
        calibrationFeatureLog.push(features.slice());
      }
    }

    let point = null;
    let confidence = Math.min(1, Math.max(0, lastFaceScore));

    if (window.__gazeNoseFallback) {
      const nosePoint = nosePointerPx(face);
      if (nosePoint) {
        point = nosePoint;
        confidence = 0.35;
      }
    }

    const predictor = typeof window.__gazePredict === 'function'
      ? window.__gazePredict
      : (feat) => gazePredictFromWB(feat, weights || window.__gazeW, bias || window.__gazeB, window.__gazeNorm);
    if (!point && features && predictor && canEmitPoints) {
      point = predictor(features);
    }

    if (!point) {
      return;
    }

    const smoothed = smoothPoint(point[0], point[1]);
    const now = ts;
    if (now - lastPointTs >= POINT_THROTTLE_MS) {
      lastPointTs = now;
      dispatchPoint(smoothed[0], smoothed[1], confidence, now);
    }
  }

  function centroid(points) {
    if (!Array.isArray(points) || !points.length) {
      return null;
    }
    let x = 0;
    let y = 0;
    let count = 0;
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      if (!Array.isArray(p)) continue;
      x += p[0];
      y += p[1];
      count += 1;
    }
    if (!count) {
      return null;
    }
    return [x / count, y / count];
  }

  function pick(mesh, idx) {
    if (!Array.isArray(mesh) || idx < 0 || idx >= mesh.length) {
      return null;
    }
    const point = mesh[idx];
    return Array.isArray(point) ? point : null;
  }

  function irisCenters(face) {
    const annotations = face.annotations || {};
    let left = Array.isArray(annotations.leftEyeIris) ? centroid(annotations.leftEyeIris) : null;
    let right = Array.isArray(annotations.rightEyeIris) ? centroid(annotations.rightEyeIris) : null;
    let source = '';

    if (left) source += 'annL ';
    if (right) source += 'annR ';

    if ((!left || !right) && Array.isArray(face.iris)) {
      const leftIris = Array.isArray(face.iris.left) ? face.iris.left : face.iris[0];
      const rightIris = Array.isArray(face.iris.right) ? face.iris.right : face.iris[1];
      if (!left && Array.isArray(leftIris)) {
        left = centroid(leftIris);
        if (left) source += 'irisL ';
      }
      if (!right && Array.isArray(rightIris)) {
        right = centroid(rightIris);
        if (right) source += 'irisR ';
      }
    }

    if ((!left || !right) && Array.isArray(face.mesh) && face.mesh.length >= 478) {
      const mesh = face.mesh;
      const leftIndices = [468, 469, 470, 471, 472];
      const rightIndices = [473, 474, 475, 476, 477];
      if (!left) {
        const lp = leftIndices.map((idx) => pick(mesh, idx));
        if (lp.every(Boolean)) {
          left = centroid(lp);
          if (left) source += 'meshL ';
        }
      }
      if (!right) {
        const rp = rightIndices.map((idx) => pick(mesh, idx));
        if (rp.every(Boolean)) {
          right = centroid(rp);
          if (right) source += 'meshR ';
        }
      }
    }

    if ((!left || !right) && Array.isArray(face.mesh) && face.mesh.length >= 400) {
      const mesh = face.mesh;
      const leftCorners = [33, 133].map((idx) => pick(mesh, idx));
      const rightCorners = [362, 263].map((idx) => pick(mesh, idx));
      if (!left && leftCorners.every(Boolean)) {
        left = centroid(leftCorners);
        if (left) source += 'cornerL ';
      }
      if (!right && rightCorners.every(Boolean)) {
        right = centroid(rightCorners);
        if (right) source += 'cornerR ';
      }
    }

    if ((!left || !right) && !missingFeatureWarned) {
      console.warn('[GazeCore] Iris centers missing; sources attempted:', source.trim());
    }
    if (left && right && left[0] === right[0] && left[1] === right[1] && !missingFeatureWarned) {
      console.warn('[GazeCore] Iris centers identical; source:', source.trim());
    }

    return { left, right };
  }

  function featuresFromFace(face) {
    const { left, right } = irisCenters(face);
    if (!left || !right) {
      return null;
    }
    const iod = Math.hypot(right[0] - left[0], right[1] - left[1]) || 1;
    const mid = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
    const yaw = face.rotation && face.rotation.angle ? face.rotation.angle.yaw || 0 : 0;
    const pitch = face.rotation && face.rotation.angle ? face.rotation.angle.pitch || 0 : 0;

    return [
      (left[0] - mid[0]) / iod,
      (left[1] - mid[1]) / iod,
      (right[0] - mid[0]) / iod,
      (right[1] - mid[1]) / iod,
      yaw / 30,
      pitch / 30
    ];
  }

  function nosePointerPx(face) {
    const mesh = face.mesh;
    if (!Array.isArray(mesh) || mesh.length < 10) {
      return null;
    }
    const candidates = [1, 4, 5, 6, 45, 275];
    let point = null;
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = pick(mesh, candidates[i]);
      if (candidate) {
        point = candidate;
        break;
      }
    }
    if (!point) {
      return null;
    }
    const videoWidth = (video && video.videoWidth) || 640;
    const videoHeight = (video && video.videoHeight) || 480;
    let x = point[0];
    let y = point[1];
    if (Math.abs(x) <= 1 && Math.abs(y) <= 1) {
      x = (x + 0.5) * videoWidth;
      y = (y + 0.5) * videoHeight;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    const xNorm = x / videoWidth;
    const yNorm = y / videoHeight;
    const viewportWidth = Math.max(1, window.innerWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || 1);
    const px = (1 - xNorm) * viewportWidth;
    const py = yNorm * viewportHeight;
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      return null;
    }
    return [
      Math.max(0, Math.min(viewportWidth - 1, px)),
      Math.max(0, Math.min(viewportHeight - 1, py))
    ];
  }

  function drawPreview(face) {
    if (!previewOn) {
      return;
    }
    const canvas = document.getElementById('gaze-cam');
    if (!canvas || canvas.style.display !== 'block') {
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

    const points = [];
    const annotations = face.annotations || {};
    if (Array.isArray(annotations.leftEyeIris)) {
      points.push(...annotations.leftEyeIris);
    }
    if (Array.isArray(annotations.rightEyeIris)) {
      points.push(...annotations.rightEyeIris);
    }
    if (!points.length && Array.isArray(face.mesh) && face.mesh.length >= 478) {
      [468, 469, 470, 471, 472, 473, 474, 475, 476, 477].forEach((idx) => {
        const p = pick(face.mesh, idx);
        if (p) points.push(p);
      });
    }
    points.forEach((p) => {
      let px = p[0];
      let py = p[1];
      if (Math.abs(px) <= 1 && Math.abs(py) <= 1) {
        px = (px + 0.5) * vw;
        py = (py + 0.5) * vh;
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

  function smoothPoint(x, y) {
    if (!smoothedPoint) {
      smoothedPoint = [x, y];
      return smoothedPoint;
    }
    smoothedPoint[0] = smoothedPoint[0] + SMOOTHING_ALPHA * (x - smoothedPoint[0]);
    smoothedPoint[1] = smoothedPoint[1] + SMOOTHING_ALPHA * (y - smoothedPoint[1]);
    return smoothedPoint;
  }

  function predictPoint(features) {
    const predictor = typeof window.__gazePredict === 'function'
      ? window.__gazePredict
      : (feat) => gazePredictFromWB(feat, weights || window.__gazeW, bias || window.__gazeB, window.__gazeNorm);
    return predictor ? predictor(features) : null;
  }

  async function tryRestoreCalibration() {
    const store = await storageGet([CALIBRATION_META_KEY, DWELL_MS_KEY, GAZE_ENABLED_KEY, PARAMS_STORAGE_KEY]);
    if (typeof store[DWELL_MS_KEY] !== 'number') {
      await storageSet({ [DWELL_MS_KEY]: DEFAULT_DWELL_MS });
    }
    if (typeof store[GAZE_ENABLED_KEY] === 'boolean') {
      gazeEnabled = store[GAZE_ENABLED_KEY];
    }
    const meta = store[CALIBRATION_META_KEY];
    const params = store[PARAMS_STORAGE_KEY];
    const storedWeights = params && Array.isArray(params.W) ? params.W : null;
    const storedBias = params && Array.isArray(params.b) ? params.b : null;
    const screenInfo = params && params.screen ? params.screen : meta && meta.screen ? meta.screen : null;
    if (!storedWeights || !storedWeights.length || !storedBias || storedBias.length !== 2) {
      return;
    }
    if (screenInfo && !screenMatches(screenInfo)) {
      console.info('[GazeCore] Stored calibration screen mismatch, skipping restore');
      return;
    }
    weights = storedWeights;
    bias = storedBias;
    window.__gazeW = storedWeights;
    window.__gazeB = storedBias;
    window.__gazeNorm = {
      mu: Array.isArray(params.mu) ? params.mu : null,
      sd: Array.isArray(params.sd) ? params.sd : null
    };
    window.__gazePredict = (feat) => gazePredictFromWB(feat, window.__gazeW, window.__gazeB, window.__gazeNorm);
    canEmitPoints = true;
    dispatchStatus('live', 'Loaded saved calibration');
  }

  function screenMatches(screenInfo) {
    if (!screenInfo) return false;
    const wMatch = Math.abs(screenInfo.w - window.innerWidth) < 2;
    const hMatch = Math.abs(screenInfo.h - window.innerHeight) < 2;
    const dprMatch = Math.abs(screenInfo.dpr - window.devicePixelRatio) < 0.01;
    return wMatch && hMatch && dprMatch;
  }

  async function trainModelWithSamples(samples) {
    if (!samples || !samples.length || !human || !human.tf) {
      console.warn('[GazeCore] No calibration samples available');
      return false;
    }
    console.debug('[GazeCore] Training with samples:', samples.length);
    logTargetRanges(samples);
    const tf = human.tf;
    const sampleCount = samples.length;
    const viewportWidth = Math.max(1, window.innerWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || 1);

    const baseFeatures = samples.map((s) => augmentFeatures(s.feat));
    const { normalized: standardizedFeatures, mean: featureMean, std: featureStd } = standardizeMatrix(baseFeatures);
    const normalizedTargets = samples.map((s) => [
      s.target[0] / viewportWidth,
      s.target[1] / viewportHeight
    ]);

    const featureCols = standardizedFeatures[0].length;

    const X = tf.tensor2d(standardizedFeatures, [sampleCount, featureCols], 'float32');
    const Y = tf.tensor2d(normalizedTargets, [sampleCount, 2], 'float32');

    let W = tf.variable(tf.zeros([featureCols, 2], 'float32'));
    let B = tf.variable(tf.zeros([1, 2], 'float32'));

    const learningRate = 0.05;
    const epochs = Math.min(1200, 200 + sampleCount * 150);
    let lastLoss = Number.POSITIVE_INFINITY;
    let patience = 0;

    try {
      for (let epoch = 0; epoch < epochs; epoch += 1) {
        const lossTensor = tf.tidy(() => {
          const prediction = tf.add(tf.matMul(X, W), B); // N x 2
          const error = tf.sub(prediction, Y); // N x 2
          const gradW = tf.mul(tf.matMul(X, error, true, false), 2 / sampleCount); // D x 2
          const gradB = tf.mul(tf.sum(error, 0, true), 2 / sampleCount); // 1 x 2

          W.assign(tf.sub(W, tf.mul(gradW, learningRate)));
          B.assign(tf.sub(B, tf.mul(gradB, learningRate)));

          return tf.mean(tf.square(error));
        });

        const currentLoss = (await lossTensor.data())[0];
        lossTensor.dispose();

        if (currentLoss > lastLoss - 1e-7) {
          patience += 1;
          if (patience > 30) {
            break;
          }
        } else {
          patience = 0;
          lastLoss = currentLoss;
        }
      }

      const weightArray = await W.array();
      const biasArray = (await B.array())[0];

      weights = weightArray;
      bias = biasArray;
      window.__gazeW = weightArray;
      window.__gazeB = biasArray;
      window.__gazeNorm = { mu: featureMean, sd: featureStd };
      window.__gazePredict = (feat) => gazePredictFromWB(feat, window.__gazeW, window.__gazeB, window.__gazeNorm);
      canEmitPoints = true;
      gazeEnabled = true;

      const screenInfo = {
        w: viewportWidth,
        h: viewportHeight,
        dpr: window.devicePixelRatio
      };

      await storageSet({
        [PARAMS_STORAGE_KEY]: {
          W: weightArray,
          b: biasArray,
          mu: featureMean,
          sd: featureStd,
          screen: screenInfo,
          ts: Date.now(),
          v: 3
        },
        [CALIBRATION_META_KEY]: {
          screen: screenInfo,
          ts: Date.now()
        },
        [GAZE_ENABLED_KEY]: true
      });

      const errors = [];
      samples.forEach((sample) => {
        const predicted = gazePredictFromWB(sample.feat, weightArray, biasArray);
        if (!predicted) {
          return;
        }
        const dx = predicted[0] - sample.target[0];
        const dy = predicted[1] - sample.target[1];
        errors.push(Math.hypot(dx, dy));
      });
      if (errors.length) {
        errors.sort((a, b) => a - b);
        const median = errors[Math.min(errors.length - 1, Math.floor(errors.length * 0.5))];
        const p90 = errors[Math.min(errors.length - 1, Math.floor(errors.length * 0.9))];
        console.debug('[GazeCore] calibration fit px:', {
          samples: samples.length,
          median,
          p90
        });
        dispatchStatus('live', `fit med=${Math.round(median)}px p90=${Math.round(p90)}px`);
      } else {
        console.warn('[GazeCore] Calibration produced no error samples');
        dispatchStatus('live', 'Calibration complete');
      }
      logFeatureVariance();
      return true;
    } catch (error) {
      console.error('[GazeCore] Calibration solve failed:', error);
      weights = null;
      bias = null;
      canEmitPoints = false;
      calibrationFeatureLog.length = 0;
      window.__gazeNorm = null;
      return false;
    } finally {
      X.dispose();
      Y.dispose();
      W.dispose();
      B.dispose();
    }
  }

  function teardown() {
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
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

  function handleCalibrateStart() {
    calibrationSamples = [];
    isCalibrating = true;
    canEmitPoints = false;
    window.__gazeCalibrating = true;
    calibrationFeatureLog.length = 0;
    dispatchStatus('calibrating', 'Look at each dot until it disappears');
    ensureInitialized().catch((error) => {
      console.warn('[GazeCore] Initialization failed during calibration:', error);
      isCalibrating = false;
      window.__gazeCalibrating = false;
      const hasParams = Boolean(weights && weights.length && Array.isArray(bias));
      canEmitPoints = hasParams;
      dispatchStatus(hasParams ? 'live' : 'ready', 'Calibration unavailable');
    });
  }

  function handleCalibrateSample(event) {
    const detail = event.detail || {};
    if (!isCalibrating) {
      return;
    }
    if (detail.capture) {
      captureTarget = Array.isArray(detail.target) ? detail.target.slice() : null;
    } else {
      captureTarget = null;
    }
  }

  function handleCalibrateEnd() {
    const samples = calibrationSamples.slice();
    isCalibrating = false;
    window.__gazeCalibrating = false;
    captureTarget = null;
    calibrationSamples = [];
    if (!samples.length) {
      dispatchStatus('ready', 'No gaze samples collected');
      return;
    }
    trainModelWithSamples(samples).then((success) => {
      if (!success) {
        dispatchStatus('ready', 'Calibration failed');
      }
    }).catch((error) => {
      console.error('[GazeCore] Training failed:', error);
      dispatchStatus('ready', 'Calibration failed');
    });
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== 'local') return;
    if (changes[GAZE_ENABLED_KEY]) {
      gazeEnabled = Boolean(changes[GAZE_ENABLED_KEY].newValue);
      if (gazeEnabled) {
        ensureInitialized().catch(() => {});
      }
    }
    if (changes[PARAMS_STORAGE_KEY]) {
      const nextParams = changes[PARAMS_STORAGE_KEY].newValue;
      if (nextParams && Array.isArray(nextParams.W) && nextParams.W.length && Array.isArray(nextParams.b)) {
        if (nextParams.screen && !screenMatches(nextParams.screen)) {
          return;
        }
        weights = nextParams.W;
        bias = nextParams.b;
        window.__gazeW = nextParams.W;
        window.__gazeB = nextParams.b;
        window.__gazeNorm = {
          mu: Array.isArray(nextParams.mu) ? nextParams.mu : null,
          sd: Array.isArray(nextParams.sd) ? nextParams.sd : null
        };
        window.__gazePredict = (feat) => gazePredictFromWB(feat, window.__gazeW, window.__gazeB, window.__gazeNorm);
        canEmitPoints = true;
        dispatchStatus('live', 'Calibration loaded');
      }
    }
    if (changes[CALIBRATION_META_KEY] && (!weights || !weights.length || !Array.isArray(bias))) {
      ensureInitialized().then(() => tryRestoreCalibration()).catch(() => {});
    }
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      smoothedPoint = null;
    }
  }

  window.addEventListener('gaze:calibrate-start', handleCalibrateStart);
  window.addEventListener('gaze:calibrate-sample', handleCalibrateSample);
  window.addEventListener('gaze:calibrate-end', handleCalibrateEnd);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  chrome.storage.onChanged.addListener(handleStorageChange);
  window.addEventListener('beforeunload', teardown);

  (() => {
    const canvas = document.getElementById('gaze-cam');
    if (canvas && canvas.style.display === 'block') {
      previewOn = true;
    }
  })();

  storageGet([PARAMS_STORAGE_KEY, CALIBRATION_META_KEY]).then((store) => {
    const params = store[PARAMS_STORAGE_KEY];
    const meta = store[CALIBRATION_META_KEY];
    if (params && Array.isArray(params.W) && params.W.length && Array.isArray(params.b)) {
      const screenInfo = params.screen || (meta && meta.screen);
      if (!screenInfo || screenMatches(screenInfo)) {
        weights = params.W;
        bias = params.b;
        window.__gazeW = params.W;
        window.__gazeB = params.b;
        window.__gazeNorm = {
          mu: Array.isArray(params.mu) ? params.mu : null,
          sd: Array.isArray(params.sd) ? params.sd : null
        };
        window.__gazePredict = (feat) => gazePredictFromWB(feat, window.__gazeW, window.__gazeB, window.__gazeNorm);
        dispatchStatus('live', 'Loaded cached calibration');
      }
    }
  });

  storageGet([GAZE_ENABLED_KEY]).then((store) => {
    gazeEnabled = Boolean(store[GAZE_ENABLED_KEY]);
    if (gazeEnabled) {
      ensureInitialized().catch(() => {});
    } else {
      dispatchStatus('ready', 'Press Alt+G to calibrate');
    }
  });
})();
