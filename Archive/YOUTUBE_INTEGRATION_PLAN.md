# YouTube Integration Implementation Plan

## 🎯 Project Goal
Integrate YouTube caption extraction and summarization into the hover-preview extension, allowing users to get AI summaries of YouTube videos by hovering over:
1. Video thumbnails on youtube.com
2. YouTube links on any website (Reddit, forums, Google Search, etc.)

---

## 💡 Key Decisions

### API Cost & Approach
- **YouTube Timedtext API**: FREE, no authentication required
- **Endpoint**: `https://www.youtube.com/api/timedtext?v=VIDEO_ID&lang=en`
- **Hybrid Approach**:
  - **Method A**: Passive interception on youtube.com (intercept YouTube's own API calls)
  - **Method B**: Active API fetching on other sites (direct API calls)

### Architecture Philosophy
**Testing-First Approach**: Build testing infrastructure before production integration
- Validate which methods actually work
- Compare reliability, speed, and success rates
- Make data-driven decisions on implementation

---

## 🧪 Phase 0: Testing Infrastructure (CURRENT PHASE)

### Goals
1. Create isolated testing environment
2. Test each caption extraction method independently
3. Build debug logging system
4. Validate API feasibility

### Files to Create

#### 1. `youtube-test.html`
Interactive test page with:
- Buttons to test each method
- Real-time console output viewer
- Success/failure indicators
- Test different scenarios (thumbnails vs links)
- Export test results

#### 2. `youtube-methods.js`
Isolated implementations of:
- **Method 1**: `webRequest` API interception (requires manifest permissions)
- **Method 4**: Network intercept (fetch/XHR override)
- **Direct API**: Fetch timedtext endpoint directly
- Helper functions: `extractVideoId()`, `parseCaptionData()`

#### 3. `debug-logger.js`
Clean, filterable logging system:
```javascript
Categories:
- [YT-M1] Method 1: webRequest
- [YT-M4] Method 4: Network Intercept
- [YT-API] Direct API Fetch
- [YT-CACHE] Caching operations
- [YT-SUM] Summary generation
- [YT-ERROR] Errors
```

Features:
- Color-coded logs
- Toggle categories on/off
- Export logs for debugging
- Display in sidepanel debug panel

#### 4. Update `sidepanel.html`
Add YouTube debug panel:
- Toggle debug categories
- View captured captions
- Test method buttons
- Success rate statistics

### Test Scenarios

#### Scenario A: YouTube.com Thumbnails
- Hover over video thumbnail
- Test Method 1 (webRequest)
- Test Method 4 (Network Intercept)
- Test Direct API (as fallback)
- **Expected**: At least one method captures full transcript

#### Scenario B: External YouTube Links (e.g., Reddit)
- Hover over YouTube link on reddit.com
- Test Direct API fetch
- **Expected**: Successfully fetch captions via direct API call

#### Scenario C: YouTube Links in Search Results
- Hover over YouTube link in Google Search
- Test Direct API fetch
- **Expected**: Successfully fetch captions via direct API call

#### Scenario D: Videos Without Captions
- Test video without captions/auto-captions disabled
- **Expected**: Graceful error handling, fallback to webpage extraction

### Testing Matrix

| Method | YouTube.com | External Links | Permissions Needed | Reliability | Speed |
|--------|-------------|----------------|-------------------|-------------|-------|
| Method 1 (webRequest) | ? | ❌ No | webRequestBlocking | ? | ? |
| Method 4 (Network Intercept) | ? | ❌ No | None | ? | ? |
| Direct API | ? | ? | None | ? | ? |

**Goal**: Fill in the `?` with ✅/❌ and data

---

## 📊 Phase 1: Method Testing & Validation

### Step 1.1: Test Direct API (Simplest)
**Why first**: No complex interception, easiest to validate

```javascript
async function testDirectAPI(videoId) {
  const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`;
  // Test via background script to avoid CORS
  const response = await chrome.runtime.sendMessage({
    action: 'FETCH_YOUTUBE_CAPTIONS',
    url: url
  });
  return parseCaptionData(response.data);
}
```

**Test Cases**:
- Popular video with captions (e.g., `dQw4w9WgXcQ`)
- Video without captions
- Private/deleted video
- Different languages

**Success Criteria**:
- ✅ Fetches full transcript (100+ caption entries)
- ✅ Handles errors gracefully
- ✅ Works from any website

### Step 1.2: Test Method 4 (Network Intercept)
**Why second**: No manifest changes, works on youtube.com

Port from YT extension:
- Inject script to override `fetch` and `XMLHttpRequest`
- Listen for timedtext API calls
- Parse captured data

**Test Cases**:
- Hover on thumbnail → preview loads → API called
- Multiple rapid hovers
- Thumbnail hover then navigate away

**Success Criteria**:
- ✅ Captures full transcript on thumbnail hover
- ✅ No duplicate captures
- ✅ Reliable (success rate > 90%)

### Step 1.3: Test Method 1 (webRequest)
**Why last**: Requires manifest changes (permissions)

Add to manifest:
```json
"permissions": ["webRequest", "webRequestBlocking"]
```

**Test Cases**:
- Same as Method 4

**Success Criteria**:
- ✅ More reliable than Method 4?
- ✅ Faster than Method 4?

### Step 1.4: Compare & Decide

Create comparison table:
```
| Metric | Method 1 | Method 4 | Direct API |
|--------|----------|----------|------------|
| Success Rate (YT.com) | X% | Y% | Z% |
| Avg Response Time | Xms | Yms | Zms |
| External Links | No | No | Yes |
| Permissions | Heavy | None | None |
| Complexity | Medium | Medium | Low |
```

**Decision Rules**:
1. If Direct API works reliably → Use for everything (simplest)
2. If Method 4 > 90% success → Use for youtube.com, Direct API for external
3. If only Method 1 works → Use it (hackathon, permissions OK)

---

## 🏗️ Phase 2: Production Integration

### Architecture: Handler Pattern

```
content.js (main)
    ↓
SiteDetector
    ↓
    ├─ isYouTubeSite() → YouTubeHandler
    ├─ hasYouTubeLink() → YouTubeLinkHandler  
    └─ default → DefaultHandler
```

### File Structure

```
hover-preview-extension/
├── handlers/
│   ├── handler-registry.js      # Router
│   ├── youtube-handler.js        # YouTube.com handling
│   ├── youtube-link-handler.js   # External YT links
│   └── default-handler.js        # Current webpage logic
├── youtube/
│   ├── caption-extractor.js      # Method implementations
│   ├── caption-parser.js         # Parse different formats
│   └── video-id-extractor.js     # Extract video IDs
├── utils/
│   └── debug-logger.js           # Logging system
├── test/
│   ├── youtube-test.html         # Test page
│   └── test-methods.js           # Test runners
├── content.js                    # Main content script
├── background.js                 # Background worker
├── sidepanel.js                  # UI
└── manifest.json                 # Config
```

### Handler Interface

```javascript
class BaseHandler {
  // Check if this handler should process the element
  canHandle(element, url) { return false; }
  
  // Extract content (captions, article, etc.)
  async extractContent(element, url) { return null; }
  
  // Get content type for UI display
  getContentType() { return 'unknown'; }
  
  // Get cache key
  getCacheKey(element, url) { return ''; }
}

class YouTubeHandler extends BaseHandler {
  canHandle(element, url) {
    return url.includes('youtube.com') || url.includes('youtu.be');
  }
  
  async extractContent(element, url) {
    const videoId = this.extractVideoId(url);
    // Try Method 4 first, fallback to Direct API
    return await this.getCaptions(videoId);
  }
  
  getContentType() { return 'youtube_video'; }
  
  getCacheKey(element, url) {
    const videoId = this.extractVideoId(url);
    return `yt_captions:${videoId}`;
  }
}
```

### Integration Points in `content.js`

#### Current Flow:
```javascript
handleMouseOver(link)
  → processLinkHover(link)
    → fetch HTML
    → extract with Readability
    → send to background for summary
```

#### New Flow:
```javascript
handleMouseOver(element)
  → determineHandler(element)
    → handler.canHandle() ?
      → YouTubeHandler.extractContent() [captions]
      → DefaultHandler.extractContent() [HTML]
  → sendToBackgroundForSummary(content, contentType)
```

### Background Script Changes

```javascript
// background.js - new message handlers

case 'FETCH_YOUTUBE_CAPTIONS':
  // Fetch captions via background to avoid CORS
  const response = await fetch(request.url);
  const text = await response.text();
  return { success: true, data: text };

case 'SUMMARIZE_YOUTUBE_CONTENT':
  // Handle YouTube captions differently
  const captions = request.captions; // Array of {start, duration, text}
  const fullText = captions.map(c => c.text).join(' ');
  
  // Use same summarization logic but with caption text
  const summary = await summarizeContent(fullText, 'youtube');
  
  // Cache with video ID
  summaryCache.set(`yt_summary:${request.videoId}`, summary);
  return summary;
```

### Cache Structure

```javascript
// Separate caption cache from summary cache
captionCache = new Map(); // videoId → captions
summaryCache = new Map(); // videoId + method → summary

// Example:
captionCache.set('dQw4w9WgXcQ', {
  videoId: 'dQw4w9WgXcQ',
  title: 'Video Title',
  captions: [{start: 0, duration: 2, text: '...'}, ...],
  timestamp: Date.now()
});

summaryCache.set('yt_summary:dQw4w9WgXcQ:summarizer', {
  summary: '...',
  method: 'summarizer',
  timestamp: Date.now()
});

summaryCache.set('yt_summary:dQw4w9WgXcQ:prompt', {
  summary: '...',
  method: 'prompt',
  timestamp: Date.now()
});
```

**Benefits**:
- Reuse captions when switching summary methods
- Clear separation: captions (content) vs summaries (AI output)
- Video ID as key works everywhere (YouTube, Reddit, etc.)

---

## 🎨 Phase 3: UI/UX Enhancements

### Tooltip/Sidepanel Indicators

Show content type:
```
📹 YouTube Video: "Video Title"
Generating summary from captions...

📄 Article: "Article Title"  
Generating summary...
```

### Settings Panel

Add to sidepanel:
```
┌─────────────────────────────────┐
│ YouTube Integration             │
├─────────────────────────────────┤
│ ☑ Enable YouTube caption        │
│   extraction                    │
│                                 │
│ ☑ Extract from external links   │
│   (Reddit, forums, etc.)        │
│                                 │
│ Debug Mode:                     │
│ ☑ Method 1 (webRequest)         │
│ ☑ Method 4 (Network Intercept)  │
│ ☑ Direct API                    │
│ ☑ Caching                       │
│ ☑ Summary Generation            │
└─────────────────────────────────┘
```

### Error States

Handle gracefully:
- Video without captions → Fall back to webpage extraction
- Private/deleted video → Show error, don't crash
- API rate limit → Cache and retry
- Network error → Show user-friendly message

---

## 🐛 Debug System Design

### Console Logging

```javascript
// Color-coded, categorized logs
debugLog('YT_API', 'Fetching captions for video', {videoId: 'abc123'});
// Output: 🔗 [YT_API] Fetching captions for video {videoId: 'abc123'}

debugLog('YT_METHOD_4', 'Intercepted timedtext call', {url: '...'});
// Output: 4️⃣ [YT_METHOD_4] Intercepted timedtext call {url: '...'}
```

### Debug Panel in Sidepanel

Real-time stats:
```
YouTube Debug Stats:
─────────────────────
Method 1 Success: 5/5 (100%)
Method 4 Success: 4/5 (80%)
Direct API Success: 5/5 (100%)

Last 5 Captures:
1. dQw4w9WgXcQ - Method 4 - 245 captions ✅
2. abc123xyz - Direct API - 180 captions ✅
3. test123 - Method 1 - Failed ❌
4. xyz789 - Direct API - 320 captions ✅
5. video123 - Method 4 - 156 captions ✅
```

### Export Debug Data

Button to export:
```json
{
  "session": "2025-10-07T10:30:00Z",
  "captures": [
    {
      "videoId": "dQw4w9WgXcQ",
      "method": "method4",
      "success": true,
      "captionCount": 245,
      "timestamp": 1696680000000,
      "url": "https://youtube.com/watch?v=..."
    }
  ],
  "stats": {
    "method1": {"attempts": 5, "success": 5},
    "method4": {"attempts": 5, "success": 4},
    "directAPI": {"attempts": 5, "success": 5}
  }
}
```

---

## 🔄 Fallback Strategy

```
User hovers on element
    ↓
Is YouTube content?
    ↓
  YES → Try Method 4 (if on youtube.com)
    ↓ FAIL
    ↓
    Try Direct API
    ↓ FAIL
    ↓
    Fall back to webpage extraction (Readability)
    ↓ FAIL
    ↓
    Show error
```

This ensures we ALWAYS try to give the user something useful.

---

## 📝 Implementation Checklist

### Phase 0: Testing Infrastructure ⬜
- [ ] Create `debug-logger.js`
- [ ] Create `youtube-methods.js` with isolated functions
- [ ] Create `youtube-test.html` test page
- [ ] Add debug panel to `sidepanel.html`
- [ ] Test Direct API with known video IDs
- [ ] Test Method 4 on youtube.com
- [ ] Test Method 1 on youtube.com (if needed)
- [ ] Document results in testing matrix
- [ ] Decide on method(s) to use

### Phase 1: Basic Integration ⬜
- [ ] Create handler architecture
- [ ] Implement `YouTubeHandler`
- [ ] Update `content.js` to use handlers
- [ ] Update `background.js` for YouTube captions
- [ ] Implement caching (captions + summaries)
- [ ] Test on youtube.com thumbnails
- [ ] Test on external YouTube links
- [ ] Handle errors gracefully

### Phase 2: UI/UX Polish ⬜
- [ ] Add content type indicators (📹 vs 📄)
- [ ] Add YouTube settings to sidepanel
- [ ] Implement debug panel
- [ ] Add export debug data feature
- [ ] Test all display modes (tooltip, sidepanel, both)

### Phase 3: Future Enhancements ⬜
- [ ] Add Reddit handler (future)
- [ ] Add Google Search handler (future)
- [ ] Inline summaries on YouTube search page (experimental)
- [ ] Per-content-type custom prompts
- [ ] Video thumbnail display in tooltip

---

## 🎯 Success Criteria

### Must Have (MVP)
- ✅ Extract captions on youtube.com thumbnail hover
- ✅ Generate summaries from captions
- ✅ Display in tooltip/sidepanel (user choice)
- ✅ Cache captions and summaries
- ✅ Fall back to webpage extraction if captions fail

### Nice to Have
- ✅ Extract captions from external YouTube links (Reddit, etc.)
- ✅ Debug panel for testing
- ✅ Success rate statistics

### Future Exploration
- ⏳ Inline summaries on YouTube search page
- ⏳ Reddit handler
- ⏳ Google Search handler
- ⏳ Per-content-type custom prompts

---

## 🚧 Known Risks & Mitigations

### Risk 1: YouTube API Changes
- **Risk**: Undocumented API might change
- **Mitigation**: Build with fallbacks, monitor for errors, easy to update endpoint

### Risk 2: CORS Issues
- **Risk**: Direct API might hit CORS restrictions
- **Mitigation**: Use background script to fetch (already planned)

### Risk 3: Rate Limiting
- **Risk**: YouTube might rate limit requests
- **Mitigation**: Aggressive caching, respect cache, don't spam

### Risk 4: Method Reliability
- **Risk**: Methods might not work as expected
- **Mitigation**: Testing phase will validate, multiple fallbacks

### Risk 5: External Links Complex
- **Risk**: YouTube links on other sites might have unexpected formats
- **Mitigation**: Robust video ID extraction, test many patterns

---

## 📚 Reference Links

### YouTube Caption API
- Endpoint: `https://www.youtube.com/api/timedtext?v=VIDEO_ID&lang=en`
- Formats: XML, JSON3 (newer format with `events`)
- Languages: `en`, `es`, `fr`, etc.
- Additional params: `&fmt=json3` (newer format), `&fmt=srv3` (XML)

### Video ID Patterns
```javascript
// Standard URLs
youtube.com/watch?v=VIDEO_ID
youtu.be/VIDEO_ID
youtube.com/embed/VIDEO_ID
youtube.com/shorts/VIDEO_ID

// Thumbnail URLs
ytimg.com/vi/VIDEO_ID/...
ytimg.com/vi_webp/VIDEO_ID/...

// API URLs
/api/timedtext?v=VIDEO_ID&...
```

---

## 🎤 Decision Log

### Decision 1: Testing-First Approach
- **Date**: 2025-10-07
- **Reason**: Multiple methods to test, unknown reliability, need validation
- **Alternative**: Direct integration (rejected - too risky)

### Decision 2: Hybrid Method A + B
- **Date**: 2025-10-07
- **Reason**: Best of both worlds - reliable on YouTube, works everywhere
- **Alternative**: Only Method A (rejected - limits to youtube.com)

### Decision 3: Separate Caption Cache
- **Date**: 2025-10-07
- **Reason**: Reuse captions when switching summary methods, clean separation
- **Alternative**: Combined cache (rejected - less flexible)

---

## 📞 Questions for Future

1. Should we display video thumbnails in tooltip?
2. Should we support video timestamp links (e.g., "Jump to 1:23")?
3. Should we extract video metadata (title, duration, views)?
4. Should we support playlists?
5. Should we add "Watch Video" button in tooltip?

---

**Last Updated**: 2025-10-07
**Status**: Phase 0 - Testing Infrastructure (IN PROGRESS)
**Next Step**: Create debug logger and test Direct API

