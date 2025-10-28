# WebGazer Hover Prototype Plan

## Goal
Provide an eye-tracking driven “hover” proof-of-concept without touching the stable hover pipeline. We will stand up an isolated demo page that loads [WebGazer](https://webgazer.cs.brown.edu/) and converts sustained gaze points on links into the same summary workflow the extension already uses.

## Assets & Layout
- `experiments/eye-tracking/webgazer-prototype.js`  
  Vanilla script that bootstraps WebGazer, handles calibration UI hints, and maps gaze coordinates to links via `document.elementFromPoint()`. Maintains dwell timers per element, highlights the current gaze target, and fires synthetic “focus” events when the threshold is met.
- `experiments/eye-tracking/webgazer-demo.css`  
  Minimal styling for calibration tips, gaze reticle, and hover-highlights used by the prototype page.
- `test/webgazer-demo.html`  
  Standalone HTML entry point (served via the repo’s `test/` harness). Loads `webgazer-prototype.js`, demo styles, and a curated set of sample links from popular sites so we can observe summaries arriving.
- `lib/webgazer.js` *(manual drop-in)*  
  The official WebGazer build. Because we do not vendor third-party code in this change, the README will instruct contributors to download the latest `webgazer.js` and place it here. The prototype script loads `chrome.runtime.getURL('lib/webgazer.js')` and falls back to the project CDN when absent.

## Getting Started
1. Fetch the latest WebGazer build and place it at `lib/webgazer.js`  
   ```bash
   curl -L https://webgazer.cs.brown.edu/webgazer.js -o lib/webgazer.js
   ```
   The prototype automatically falls back to the CDN if this file is missing, but shipping it locally avoids mixed-content or CSP issues once we wire it into the extension.
2. Open the demo page via the manual harness (`python3 -m http.server 8000` → `http://localhost:8000/test/webgazer-demo.html`).  
   Alternatively, add the file to `manifest.json`’s `web_accessible_resources` to load it directly inside the extension, which is required for `chrome.runtime` APIs and the live summarizer. Use the control panel’s camera selector to choose the desired webcam (click **Refresh camera list** after granting permission if it does not appear).
3. Click **Start Webcam Calibration**, allow camera access, and click around the screen so WebGazer can fit its regression model.  
4. (Optional) Press **Run Fine-Tune Calibration** for additional samples along the screen edges — this tightens accuracy on multi-monitor setups.  
5. Toggle **Begin Gaze Hover Mode**. Staring at a sample link for the dwell duration (default 750 ms) will highlight it and, when running as an extension page, request a summary from the existing background service worker.

## Message Flow
1. WebGazer emits (x, y) gaze predictions at ~60 Hz.  
2. The prototype script smooths predictions and identifies the dominant anchor tag under the gaze point.  
3. When the gaze dwells on the same link for `DWELL_THRESHOLD_MS` (default 750 ms), the script:
   - Dispatches a custom `webgazer-hover` event for debugging.
   - Calls `chrome.runtime.sendMessage` with the same `SUMMARIZE_CONTENT` payload produced by `content.js`.  
   - Shows a tooltip panel (dedicated to the prototype) while streaming updates arrive.
4. Streaming updates reuse the new per-tab targeting we added earlier; the prototype tooltip listens for `STREAMING_UPDATE` to render incremental text.

## Calibration UX
- Prompt the user to run WebGazer’s built-in calibration by clicking a grid of on-screen points; the baseline pass gathers nine samples, and the optional fine-tune pass adds twelve mid-edge targets for better interpolation.  
- Display the camera/video preview and WebGazer’s prediction dot using `webgazer.showVideoPreview()` and `webgazer.showPredictionPoints()` while in calibration mode.  
- Offer a “Start Gaze Hover Mode” button once calibration looks stable; the script hides the prediction dots (unless the preview toggle stays on) and enters dwell-tracking mode.  
- When a different webcam is selected, automatically pause, restart calibration, and re-open the primary grid so users can reseat their gaze.

## Safeguards
- Dwell debounce to avoid rapid re-triggering on the same link unless the gaze leaves for at least 400 ms.  
- Graceful handling when `chrome.runtime` is unavailable (so the HTML page can run outside the extension during early testing).  
- Cleanup function to call `webgazer.pause()`/`webgazer.end()` when the demo page unloads.

## Next Steps After Prototype
1. Evaluate accuracy and user fatigue; adjust dwell thresholds or introduce “stare to click” confirmation.  
2. Package the gaze-to-hover adapter as a feature flag in `content.js` (e.g., enable  via `chrome.storage`).  
3. Integrate accessibility affordances (status annunciators, alternative keyboard fallback).  
4. Consider persisting WebGazer’s regression model between sessions for faster startup.

## Integration Notes
- The prototype requests summaries through the same `SUMMARIZE_CONTENT` service added to the background worker. When the page loads outside the extension, the script falls back to displaying placeholder hover notes.  
- Because the production content script now relies on a per-request job registry, we can bridge the prototype by emitting a dedicated message (e.g., `ENABLE_GAZE_HOVER`) that toggles the same dwell logic inside `content.js` once it is production-ready.  
- The tooltip implementation in `webgazer-prototype.js` intentionally mirrors the streaming update format so we can swap it out for the shared tooltip renderer later.
