# Gaze Accuracy Improvement Plan

Our objective is to deliver a gaze tracker that is accurate, calm, and trustworthy enough for accessibility users. The roadmap below captures the iterative phases we will execute so we can measure gains and avoid regressions at every step.

---

## Phase 1 – Stabilise the Signal

**Goal:** eliminate jitter and outliers before they reach the hover logic.

- Implement a temporal smoothing pipeline:
  - 5-sample median filter to drop single-frame spikes.
  - Adaptive exponential moving average (alpha reacts to velocity).
  - Velocity gate that discards implausible jumps unless they persist.
- Clamp calibrated gaze coordinates to the viewport and detect idle/invalid states.
- Ensure the gaze indicator hides when the signal is unknown, restoring only when reliable.

**Success metric:** noticeable reduction in dwell misfires during hover tests; red dot motion becomes visually calm.

---

## Phase 2 – Stronger Calibration Model

**Goal:** improve the raw→screen mapping accuracy and keep it sharp over time.

- Collect denser dwell-based samples per calibration anchor (≥5) covering corners, edges, and interior points.
- Solve a weighted affine transform (or low-order polynomial if necessary); emphasise recent samples.
- Introduce continuous refinement: whenever a gaze dwell completes successfully, capture a micro-sample in the background.

**Success metric:** lower average error on calibration validation points; reduced need for manual recalibration.

---

## Phase 3 – Geometric Corrections

**Goal:** maintain accuracy when the user shifts position or tilts their head.

- Integrate eye/face landmarks (WebGazer or MediaPipe) to estimate roll/pitch/yaw.
- Normalise gaze points with head pose compensation before feeding the transform.
- Optionally estimate user-specific eye geometry (interpupillary distance, relative camera height) during calibration.

**Success metric:** accuracy stays stable even after intentional head movement; minimal drift reported in hover sessions.

---

## Phase 4 – Behavioural Safeguards

**Goal:** make the system forgiving and transparent to users.

- Add a hover-mode indicator (subtle styling) so gaze confidence is always visible.
- Compute per-frame confidence scores; delay dwell timers when confidence is low.
- Detect long-term drift vs. user confirmations and prompt a lightweight re-calibration when necessary.

**Success metric:** users retain trust in hover mode; no “silent” misalignment persists for long.

---

## Phase 5 – Polished Experience

**Goal:** deliver an accessibility-grade workflow that stays accurate between sessions.

- Persist calibration transforms per webcam/resolution and warm-start new sessions.
- Monitor camera health (frame rate, exposure) and provide actionable tips when conditions are poor.
- Collect optional user feedback (e.g., “hover felt off target”) to tune defaults and thresholds.

**Success metric:** zero-setup return visits retain accuracy; issue reports drop significantly.

---

### Execution Notes

- Each phase should ship behind a feature flag so we can run controlled tests.
- We will benchmark after every phase via `test/webgazer-demo.html` and a live YouTube hover session.
- Documentation updates and quick video captures accompany each milestone so the team can evaluate progress.
