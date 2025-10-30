# Human Gaze Module

An offline gaze-and-head interaction layer that sits beside the existing hover summarizer. The content scripts:

- Load the [Human.js](https://github.com/vladmandic/human) face pipeline fully offline (`gaze-core.js`).
- Drive a head-pointer cursor with nose-vs-eye features plus One-Euro filtering; optional calibration lives behind **Alt+H** (`gaze/head-cal.js`).
- Surface a lightweight debug HUD, camera preview, and dwell-to-summary tooltip (`gaze-overlay.js`, `gaze-dwell.js`).

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

- Head pointer is enabled by default. Press **Alt+H** to open the five-step head calibration (center → left → right → up → down). Hold still and press **Space** (or long blink ≥1 s) to capture each pose; the cursor snaps back to center when the flow completes and the ranges persist as `headCalV2`.
- Dwell for ~600 ms on any link to trigger a summary. YouTube links reuse `GET_YOUTUBE_SUMMARY`; everything else runs through `FETCH_CONTENT` + `SUMMARIZE_CONTENT`.
- Toggle the debug HUD with **Shift+H**, the red pointer with **Alt+P**, and the mirrored camera preview with **Alt+V**. **Alt+N** toggles head-pointer mode on/off.
- Blink calibration runs inline: keep your eyes open for a second, then close them gently for ~0.7 s. The module stores thresholds as `earCalV2`, enabling long-blink clicks (≥1 s for left click, ≥2 s for right click).
- Press **Esc** while a summary is running to cancel it (aborts active YouTube capture when possible).

## Storage Keys

- `gazeEnabled` — when `false`, head tracking stays idle until re-enabled.
- `headCalV2` — nose-vs-eye calibration ranges for head-pointer mode (Alt+H).
- `earCalV2` — eyelid calibration tracked for blink detection (left/right clicks).
- `gazeDwellMs` — optional dwell override (defaults to 600 ms if unset).

## Testing Notes

1. Load the unpacked extension and open `chrome://extensions` → enable service-worker inspection for logs.
2. Visit any long article, dwell on a link for ~0.6 s, and verify the tooltip streams a summary.
3. Open YouTube and dwell on a thumbnail; you should see captions captured and streamed via the same tooltip.
4. Run head calibration (**Alt+H**) and confirm pointer reach feels natural across the viewport.
5. Test long-blink clicks (≥1 s / ≥2 s) and ensure synthetic clicks land on sticky targets.
6. Toggle preview (**Alt+V**) and HUD (**Shift+H**) to confirm the camera feed and status overlays render correctly.
7. Hit **Esc** mid-run to ensure cancellation hides the tooltip and aborts active YouTube jobs.

Run the steps in `TESTING_GUIDE.md` if you update dwell or calibration logic, and record findings in a `TEST_RESULTS_*.md` file per repo guidelines.
