# Repository Guidelines

## Project Structure & Module Organization
- `background.js` is the Manifest V3 service worker that initializes the AI summarizer layer and relays messages.
- `content.js` owns hover detection inside an IIFE; YouTube-specific bridges sit in `youtube/` (`youtube-content-bridge.js`, `youtube-caption-handler.js`, etc.).
- UI assets live in `sidepanel.html`, `sidepanel.js`, and `sidepanel.css`; shared helpers in `utils/`, third-party code in `lib/`, and manual fixtures in `test/` (see `TESTING_GUIDE.md`). Leave `handlers/` available for future service worker routers.

## Build, Test, and Development Commands
- No build step is required. Load the extension via Chrome/Edge: enable Developer Mode in `chrome://extensions`, click **Load unpacked**, and select the repo root with `manifest.json`.
- Manual harness: `open test/youtube-test.html` (macOS) or `python3 -m http.server 8000` then browse to `/test/youtube-test.html`.
- Monitor activity through the target tab’s DevTools and the service worker console in `chrome://extensions` → “service worker”.

## Coding Style & Naming Conventions
- Use two-space indentation, semicolons, and `'use strict';` IIFEs to keep globals contained.
- Prefer `const`/`let`, camelCase identifiers, and UPPER_SNAKE_CASE for stable configuration (`HOVER_DELAY`, `DEBUG_ENABLED`).
- Keep modules focused: background for orchestration, content scripts for DOM, shared utilities in `utils/`. Name new YouTube files `youtube-<feature>.js` and route logging through `utils/debug-logger.js` when available.

## Testing Guidelines
- Follow `TESTING_GUIDE.md` to run Direct API and Method 4 scenarios. Confirm the three sample IDs succeed before merging caption or hover changes.
- After enabling the intercept, exercise hover previews on a live YouTube tab, note browser/version, and record whether the service worker was reloaded.
- Store observations in the `TEST_RESULTS_*.md` templates or a similarly named markdown log.

## Commit & Pull Request Guidelines
- Align with the repo’s imperative history: use type-prefixed subjects (`fix:`, `refactor:`) or short verb phrases under ~65 characters, with optional body detail for rationale.
- PR descriptions must outline scope, highlight manifest or permission adjustments, list test evidence (commands or manual steps), and include UI screenshots or clips whenever behavior changes.
