# Phase 1 Integration - Progress Tracker

**Last Updated**: October 8, 2025  
**Branch**: `feature/youtube`  
**Current Commit**: `9bcaf10`  
**Status**: Phase 1 - Part 1 COMPLETE (40% done)

---

## 🎯 Goal

Integrate Method 4 (XHR Intercept) into production so users can:
- Hover over YouTube thumbnails on youtube.com
- See AI-generated summaries of video content from captions
- Display in tooltip/sidepanel (same as current articles)

---

## ✅ Completed (Phase 1 - Part 1)

### Files Created:
1. **`youtube/youtube-caption-handler.js`** ✅
   - Runs in page context (injected via web_accessible_resource)
   - Intercepts XHR requests to `/api/timedtext`
   - Parses captions (JSON3 and XML formats)
   - Caches captions: `Map<videoId, {captions, text, timestamp}>`
   - Exposes API:
     - `window.__ytGetCaptions(videoId)` - Returns caption data
     - `window.__ytHasCaptions(videoId)` - Checks if cached
     - `window.__ytClearCache()` - Clears cache
   - Fires event: `youtube-captions-ready` when captions captured

2. **`youtube/youtube-content-bridge.js`** ✅
   - Content script (runs on youtube.com)
   - Loads caption handler into page context
   - Bridges between page and extension
   - Listens for caption-ready events
   - Exposes to content.js:
     - `window.getYouTubeCaptions(videoId)`
     - `window.hasYouTubeCaptions(videoId)`

3. **`manifest.json` updated** ✅
   - Changed YouTube content script from test-injector to production bridge
   - Added `youtube-caption-handler.js` to `web_accessible_resources`
   - Content script runs at `document_start` for early interception

### What Works Now:
- ✅ Caption handler intercepts YouTube's XHR requests
- ✅ Captions are parsed and cached in memory
- ✅ Bridge exposes captions to extension context
- ✅ No CSP violations
- ✅ Tested and validated in Phase 0

---

## ⏳ In Progress / TODO

### Remaining Tasks (60%):

#### 1. Update `content.js` (NEXT - CRITICAL) 🔴
**Location**: `/Users/hanweitan/Documents/GithubProject/hover-preview-extension/content.js`

**What needs to be added**:
```javascript
// Add at top
const IS_YOUTUBE = window.location.hostname.includes('youtube.com');

// New function: Detect YouTube thumbnail
function isYouTubeThumbnail(element) {
  // Check if element is or contains:
  // - ytd-thumbnail
  // - a[href*="/watch"]
  // - a[href*="/shorts"]
  return element.closest('ytd-thumbnail, ytd-rich-item-renderer, ytd-video-renderer');
}

// New function: Extract video ID from thumbnail
function getVideoIdFromThumbnail(element) {
  const link = element.querySelector('a[href*="/watch"], a[href*="/shorts"]') || 
               element.closest('a[href*="/watch"], a[href*="/shorts"]');
  if (link) {
    const match = link.href.match(/[?&]v=([^&]+)/);
    return match ? match[1] : null;
  }
  return null;
}

// Modify handleMouseOver() to detect YouTube
function handleMouseOver(e) {
  // ... existing code ...
  
  if (IS_YOUTUBE && isYouTubeThumbnail(e.target)) {
    const videoId = getVideoIdFromThumbnail(e.target);
    if (videoId) {
      // Handle YouTube hover
      handleYouTubeThumbnailHover(e.target, videoId);
      return;
    }
  }
  
  // ... existing regular link handling ...
}

// New function: Handle YouTube thumbnail hover
function handleYouTubeThumbnailHover(element, videoId) {
  // Wait for HOVER_DELAY
  currentHoverTimeout = setTimeout(async () => {
    // Check if captions are cached
    if (window.hasYouTubeCaptions && window.hasYouTubeCaptions(videoId)) {
      // Get captions immediately
      const captionData = window.getYouTubeCaptions(videoId);
      processCaptionsSummary(element, videoId, captionData);
    } else {
      // Show "Waiting for captions..." message
      showWaitingMessage(element, videoId);
      
      // Wait for captions event
      const captionsListener = (event) => {
        if (event.detail.videoId === videoId) {
          window.removeEventListener('yt-captions-available', captionsListener);
          const captionData = window.getYouTubeCaptions(videoId);
          if (captionData) {
            processCaptionsSummary(element, videoId, captionData);
          }
        }
      };
      window.addEventListener('yt-captions-available', captionsListener);
      
      // Timeout after 10 seconds
      setTimeout(() => {
        window.removeEventListener('yt-captions-available', captionsListener);
        showError(element, 'No captions available');
      }, 10000);
    }
  }, HOVER_DELAY);
}

// New function: Process captions and send for summary
async function processCaptionsSummary(element, videoId, captionData) {
  const { text, captions } = captionData;
  
  // Send to background for summarization
  const response = await chrome.runtime.sendMessage({
    type: 'SUMMARIZE_YOUTUBE_CONTENT',
    videoId: videoId,
    captionText: text,
    captionCount: captions.length
  });
  
  // Display summary
  if (response.summary) {
    showYouTubeSummary(element, videoId, response.summary, captions.length);
  }
}
```

**Files to modify**:
- `content.js` lines ~1-600 (integrate YouTube detection)

---

#### 2. Update `background.js` (NEXT AFTER content.js) 🟠
**Location**: `/Users/hanweitan/Documents/GithubProject/hover-preview-extension/background.js`

**What needs to be added**:
```javascript
// Add to onMessage listener (around line 514)
if (message.type === 'SUMMARIZE_YOUTUBE_CONTENT') {
  handleYouTubeSummarize(message, sender)
    .then(result => sendResponse(result))
    .catch(error => sendResponse({ error: error.message }));
  return true;
}

// New function: Handle YouTube summarization
async function handleYouTubeSummarize(message, sender) {
  const { videoId, captionText, captionCount } = message;
  
  // Check cache first
  const cacheKey = `youtube:${videoId}`;
  if (summaryCache.has(cacheKey)) {
    return {
      cached: true,
      summary: summaryCache.get(cacheKey),
      videoId,
      captionCount
    };
  }
  
  // Cancel any ongoing processing
  if (currentAbortController) {
    currentAbortController.abort();
  }
  currentAbortController = new AbortController();
  
  try {
    // Summarize using current method (Summarizer API or Prompt API)
    const summary = await summarizeContent(captionText, currentAbortController.signal, videoId);
    
    // Cache the summary
    summaryCache.set(cacheKey, summary);
    
    return {
      cached: false,
      summary,
      videoId,
      captionCount
    };
  } catch (error) {
    throw error;
  } finally {
    currentAbortController = null;
  }
}
```

**Files to modify**:
- `background.js` around line 514 (add message handler)
- Add new `handleYouTubeSummarize()` function

---

#### 3. Add YouTube Caption Caching 🟢
**Already partially implemented in caption-handler.js**

Additional work needed:
- Persist cache to chrome.storage (optional)
- Add cache expiry (e.g., 1 hour)
- Sync cache between tabs

---

#### 4. Update Tooltip/Sidepanel Display 🟢
**Files**: `content.js` (tooltip), `sidepanel.js` (panel)

**What to add**:
- Show video icon 📹 instead of article icon
- Display: "YouTube Video - X captions"
- Show video title (need to extract from page)
- Maybe show thumbnail image

---

#### 5. Error Handling 🟡
**Scenarios to handle**:
- Video has no captions → Show "No captions available"
- Captions fail to load → Timeout after 10 seconds
- API summarization fails → Show error message
- User moves away before captions load → Cancel operation

---

#### 6. End-to-End Testing 🔴
**Test checklist**:
- [ ] Hover thumbnail → See "Loading..." → See summary
- [ ] Hover same thumbnail again → Instant summary (cached)
- [ ] Switch between thumbnails quickly → Cancel/switch works
- [ ] Hover non-video element → Falls back to normal
- [ ] Both tooltip and sidepanel modes work
- [ ] Streaming updates work for long summaries

---

#### 7. Clean Up Test Code 🟢
**Decision needed**:
- Option A: Remove test injector entirely
- Option B: Keep test injector, add toggle in settings
- Option C: Keep test files but don't load in manifest

**Recommended**: Option B (keep with toggle for debugging)

---

## 🔧 Technical Architecture

### Flow Diagram:
```
1. User hovers YouTube thumbnail
   ↓
2. content.js detects (isYouTubeThumbnail)
   ↓
3. Extract videoId (getVideoIdFromThumbnail)
   ↓
4. Check if captions cached (window.hasYouTubeCaptions)
   ↓
5a. YES → Get captions (window.getYouTubeCaptions)
   ↓
5b. NO → Wait for 'yt-captions-available' event
   ↓
6. Send to background.js (SUMMARIZE_YOUTUBE_CONTENT)
   ↓
7. background.js summarizes with AI
   ↓
8. Return summary to content.js
   ↓
9. Display in tooltip/sidepanel
```

### Data Flow:
```
Page Context (youtube.com)
  └─ youtube-caption-handler.js
      ├─ Intercepts XHR → /api/timedtext
      ├─ Parses & caches captions
      └─ Fires: youtube-captions-ready

Extension Context (content script)
  └─ youtube-content-bridge.js
      ├─ Loads handler
      ├─ Listens for events
      └─ Exposes: getYouTubeCaptions()

Content Script
  └─ content.js
      ├─ Detects thumbnail hover
      ├─ Gets captions via bridge
      └─ Sends to background

Background Script
  └─ background.js
      ├─ Receives caption text
      ├─ Summarizes with AI
      └─ Returns summary

Display
  ├─ Tooltip (content.js)
  └─ Sidepanel (sidepanel.js)
```

---

## 📝 Key Implementation Notes

### YouTube Thumbnail Selectors (for content.js):
```javascript
const YOUTUBE_SELECTORS = [
  'ytd-thumbnail',
  'ytd-rich-item-renderer',
  'ytd-video-renderer',
  'ytd-compact-video-renderer',
  'ytd-grid-video-renderer'
];
```

### Video ID Extraction:
```javascript
// From link href
/[?&]v=([^&]+)/  // /watch?v=VIDEO_ID
/\/shorts\/([^/]+)/  // /shorts/VIDEO_ID
```

### Caption Cache Key Format:
```javascript
// In background.js
const cacheKey = `youtube:${videoId}`;  // e.g., "youtube:dQw4w9WgXcQ"

// Separate from webpage cache
const webpageKey = `web:${urlHash}`;  // e.g., "web:abc123"
```

---

## 🚨 Critical Points to Remember

1. **Caption Handler runs in PAGE context** (not content script)
   - Use `window.__ytGetCaptions()` to access from content script
   - Events must use `window.dispatchEvent()` and `window.addEventListener()`

2. **Timing is critical**
   - Captions might not be available immediately
   - Must wait for `yt-captions-available` event
   - Implement timeout (10 seconds)

3. **Cache separation**
   - YouTube: `youtube:${videoId}`
   - Webpages: `web:${urlHash}`
   - Don't mix them!

4. **Display modes**
   - Respect user's choice (tooltip, sidepanel, both)
   - Show video-specific UI (📹 icon, caption count)

5. **Error states**
   - No captions available
   - Captions timeout
   - Summarization failed
   - User moved away (cancel)

---

## 🎯 Next Session TODO

**When resuming, start here:**

1. ✅ Review this document
2. ✅ Pull latest from `feature/youtube` branch
3. 🔴 **START HERE**: Modify `content.js` to detect YouTube thumbnails
4. 🔴 Add `handleYouTubeThumbnailHover()` function
5. 🟠 Update `background.js` to handle YouTube summarization
6. 🟢 Test end-to-end on YouTube.com
7. 🟢 Fix any bugs
8. ✅ Commit and push

**Estimated time**: 1-2 hours

---

## 📊 Progress Tracker

- [x] Phase 0: Testing & Validation (100%)
- [x] Phase 1 Part 1: Handler & Bridge (40%)
- [ ] Phase 1 Part 2: content.js Integration (0%)
- [ ] Phase 1 Part 3: background.js Integration (0%)
- [ ] Phase 1 Part 4: Display Updates (0%)
- [ ] Phase 1 Part 5: Testing & Polish (0%)

**Overall Progress**: 40% complete

---

## 🔗 Important Files Reference

**Current state**:
- ✅ `youtube/youtube-caption-handler.js` - Complete
- ✅ `youtube/youtube-content-bridge.js` - Complete
- ✅ `manifest.json` - Updated
- ⏳ `content.js` - Needs YouTube integration
- ⏳ `background.js` - Needs YouTube message handler
- ⏳ `sidepanel.js` - Needs display updates (optional)

**Commit**: `9bcaf10` - feat: Add production YouTube caption handler (Phase 1 - Part 1)

---

**Status**: Ready to continue Phase 1 Part 2 (content.js integration)

