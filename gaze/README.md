# Human Gaze Module

An offline eye-gaze prototype layered beside the existing hover summarizer. This module injects its own content scripts that:

- Load the [Human.js](https://github.com/vladmandic/human) face + iris pipeline directly in the page (`gaze-core.js`).
- Provide a 9-point in-page calibration overlay that you can toggle with **Alt+G** (`gaze-overlay.js`).
- Convert gaze points into dwell selections on links and forward summaries through the existing background actions (`gaze-dwell.js`).

## Vendoring Human.js

Copy the Human bundle and models into the `gaze/human/` folder so we stay fully offline:

1. Install or download `@vladmandic/human` once.
2. Copy `dist/human.esm.js` → `gaze/human/human.esm.js` (replace the placeholder stub).
3. Copy the contents of `models/` → `gaze/human/models/`.

`gaze-core.js` points Human to the models with:

```js
modelBasePath: chrome.runtime.getURL('gaze/human/models/')
```

If the bundle/models are missing you will see a status warning (“Install gaze/human assets…”).

## Usage

- Press **Alt+G** to start or cancel gaze calibration. The overlay walks through 9 dots and persists the learned linear weights in `chrome.storage.local`.
- Run the head calibration flow with **Alt+H** (center → left → right → up → down). Confirm each step with **Space** or a long blink (≥1 s); the result is stored as `headCalV1`.
- After calibration, gaze points stream as `gaze:point` events. Dwell (~600 ms by default) on any link to trigger summaries. YouTube links reuse `GET_YOUTUBE_SUMMARY` while other pages reuse `FETCH_CONTENT` + `SUMMARIZE_CONTENT`.
- Toggle the floating debug HUD (status/fps/confidence) with **Shift+H** and the red gaze cursor with **Alt+P**.
- Toggle the mirrored camera preview with iris overlays using **Alt+V**; enable head-pointer mode with **Alt+N** once calibration is complete.
- Long blinks drive activation: hold both eyes closed ≥1 s for a left click, ≥2 s for a right click; during head calibration a ≥1 s blink confirms the current pose.
- During calibration the HUD shows the running sample count; once a solve completes it reports the median and 90th percentile fit error in pixels.
- The console logs a variance table for the captured feature vectors and warns if iris data falls back to mesh corners; expect non-zero variance for the eye terms.
- Press **Esc** while a summary is running to cancel (aborts active YouTube capture when possible).

## Storage Keys

- `gazeEnabled` — set to `true` after calibration so gaze stays active on reload.
- `gazeCalibrationV2` — metadata about the saved calibration (screen size & DPR guard).
- `gazeLin` — serialized `{ W, b, screen }` weights used by the linear gaze mapper.
- `headCalV1` — stored yaw/pitch ranges for head-pointer mode (Alt+H).
- `earCalV1` — eyelid calibration used for blink detection (left/right clicks).
- `gazeDwellMs` — optional dwell override (defaults to 600 ms if unset).

## Testing Notes

1. Load the unpacked extension and open `chrome://extensions` → enable service-worker inspection for logs.
2. Visit any news article, press **Alt+G**, follow the dots.
3. Dwell on a link title for ~0.6 s: a gaze tooltip should show “Generating…” then stream summary tokens.
4. Open YouTube and dwell on a thumbnail; you should see captions captured and streamed via the same tooltip.
5. Hit **Esc** mid-run to ensure cancellation hides the tooltip and aborts active YouTube jobs.
6. Watch the page console for `[GazeDwell] target:` logs (set `DEBUG_DWELL` in `gaze/gaze-dwell.js` to silence).
7. Enable the preview (**Alt+V**) to verify Human’s face/iris landmarks and confirm the HUD shows calibration sample counts and fit errors.
8. Check the console for the feature variance table and calibration fit metrics; if iris data is missing, switch to head-pointer mode (**Alt+N**) to keep dwell summaries functional while you recalibrate.

Run the steps in `TESTING_GUIDE.md` if you update dwell or calibration logic, and record findings in a `TEST_RESULTS_*.md` file per repo guidelines.
