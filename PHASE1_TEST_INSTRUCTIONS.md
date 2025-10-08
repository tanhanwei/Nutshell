# Phase 1 Testing Instructions

## 🎯 Goal
Test YouTube caption summarization on YouTube.com

## 📋 Prerequisites
- Chrome with AI APIs enabled (Summarizer or Prompt API)
- Extension loaded in Chrome

## 🔄 Reload Extension
1. Go to `chrome://extensions/`
2. Find "Hover Link Summary" extension
3. Click the **Reload** button (🔄)
4. Confirm no errors in the console

## 🧪 Test Steps

### Step 1: Verify Extension is Loaded
1. Open Chrome DevTools (F12)
2. Go to YouTube.com: `https://www.youtube.com`
3. Check Console for initialization messages:
   ```
   [YouTube Bridge] Initializing...
   [YouTube Handler] Initializing caption handler...
   [YouTube Handler] ✅ XHR interception active
   [YouTube Handler] Ready! Monitoring for caption requests...
   [YouTube Bridge] Caption handler injected
   [YouTube Bridge] Ready!
   ```

### Step 2: Test Thumbnail Hover
1. Stay on YouTube.com homepage
2. Hover over a **video thumbnail** (with captions enabled)
3. Wait 300ms for hover to trigger
4. **Expected in Console**:
   ```
   🎬 YOUTUBE THUMBNAIL: "https://www.youtube.com/watch?v=..." (will trigger in 300ms)
   [YouTube] Thumbnail hover detected: https://...
   [YouTube] Video ID: dQw4w9WgXcQ
   ```

### Step 3: Check Caption Interception
1. While hovering, YouTube will fetch captions
2. **Expected in Console**:
   ```
   [YouTube Handler] Intercepting captions for: dQw4w9WgXcQ
   [YouTube Handler] ✅ Captured 150 captions for dQw4w9WgXcQ
   ```

### Step 4: Verify Summary Request
1. After captions are captured, summary should be requested
2. **Expected in Console**:
   ```
   [Background] YouTube summary requested for: dQw4w9WgXcQ
   [YouTube Bridge] Caption request for: dQw4w9WgXcQ
   [YouTube Bridge] Captions found!
   [YouTube] Caption count: 150
   [YouTube] Caption text length: 5432
   ```

### Step 5: Check Tooltip/Side Panel
1. **Tooltip should show**: 
   - "Fetching captions..." (initially)
   - Then: AI-generated summary of the video
2. **Side panel** (if enabled): Should display the same summary

### Step 6: Test Caching
1. Move mouse away from thumbnail
2. Hover over the **same thumbnail** again
3. **Expected**: Summary appears instantly (from cache)
4. **Console should show**: `[YouTube] Returning cached summary`

## ❌ Common Issues

### Issue 1: No captions captured
**Symptoms**: Console shows "No captions found"  
**Cause**: Video doesn't have captions, or captions haven't loaded yet  
**Solution**: Try a different video with captions enabled

### Issue 2: Extension context lost
**Symptoms**: Console error about "Extension context invalidated"  
**Cause**: Extension was reloaded while tab was open  
**Solution**: Refresh the YouTube tab

### Issue 3: Functions not defined
**Symptoms**: `ytTestStart is not defined` or `__ytGetCaptions is not defined`  
**Cause**: youtube-caption-handler.js not injected  
**Solution**: Check manifest.json and web_accessible_resources

### Issue 4: CORS errors
**Symptoms**: "Access to fetch has been blocked by CORS policy"  
**Cause**: Trying to fetch captions from content script  
**Solution**: This should not happen in production (we use page context)

## 🔍 Debug Checklist

If something doesn't work:

1. ✅ Extension reloaded?
2. ✅ YouTube tab refreshed after reload?
3. ✅ Console shows initialization messages?
4. ✅ Video has captions? (look for CC icon)
5. ✅ Hovering for at least 300ms?
6. ✅ AI API available? (check side panel settings)

## 📊 Expected Console Flow

```
1. [YouTube Bridge] Initializing...
2. [YouTube Handler] Initializing caption handler...
3. [YouTube Handler] ✅ XHR interception active
4. [YouTube Handler] Ready!
5. [YouTube Bridge] Ready!
--- User hovers over thumbnail ---
6. 🎬 YOUTUBE THUMBNAIL: "..." (will trigger in 300ms)
7. [YouTube] Thumbnail hover detected: ...
8. [YouTube] Video ID: dQw4w9WgXcQ
--- YouTube loads captions (happens automatically) ---
9. [YouTube Handler] Intercepting captions for: dQw4w9WgXcQ
10. [YouTube Handler] ✅ Captured 150 captions
--- Extension requests summary ---
11. [Background] YouTube summary requested for: dQw4w9WgXcQ
12. [YouTube Bridge] Caption request for: dQw4w9WgXcQ
13. [YouTube Bridge] Captions found!
14. [YouTube] Caption count: 150
15. [YouTube] Caption text length: 5432
--- AI generates summary ---
16. [Background] Generating summary...
17. [Background] Summary complete!
18. [Background] YouTube summary result: complete
--- Summary displayed in tooltip/sidepanel ---
```

## 🎉 Success Criteria

- ✅ Captions are captured automatically on hover
- ✅ Summary is generated using AI
- ✅ Tooltip shows the summary
- ✅ Caching works (instant display on re-hover)
- ✅ No errors in console
- ✅ Works for multiple videos

## 📝 Report Issues

If you encounter issues, please provide:
1. Full console log
2. Video URL you tested
3. Screenshot of tooltip/error
4. Extension version and Chrome version

