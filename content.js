(function() {
  'use strict';
  
  // Configuration
  const HOVER_DELAY = 300;
  const IS_YOUTUBE = window.location.hostname.includes('youtube.com');
  const DEBUG_ENABLED = !IS_YOUTUBE; // Disable logs on YouTube to reduce clutter
  
  // Debug logging helper
  const debugLog = (...args) => {
    if (DEBUG_ENABLED) console.log(...args);
  };
  
  // State management
  let currentHoverTimeout = null;
  let hideTimeout = null;
  let lastProcessedUrl = null;
  let currentlyProcessingUrl = null;
  let currentlyDisplayedUrl = null; // Track what URL the tooltip is currently showing
  let processingElement = null; // Track element being processed for positioning
  let tooltip = null;
  let displayMode = 'both';
  let currentHoveredElement = null;
  let isMouseInTooltip = false;
  let displayTimes = new Map(); // Track when each URL was displayed (url -> timestamp)
  let hoverTimeouts = new Map(); // Track hover timeouts per URL (url -> timeout ID)
  
  // YouTube-specific state
  let currentYouTubeOverlay = null; // Track active YouTube overlay
  let currentYouTubeOverlayUrl = null; // Track which URL the YouTube overlay is for
  
  // Create tooltip
  function createTooltip() {
    if (tooltip) return tooltip;
    
    // Inject CSS for tooltip list styling
    if (!document.getElementById('hover-tooltip-styles')) {
      const style = document.createElement('style');
      style.id = 'hover-tooltip-styles';
      style.textContent = `
        #hover-summary-tooltip ul {
          margin: 12px 0;
          padding-left: 24px;
          list-style-type: disc;
          list-style-position: outside;
        }
        #hover-summary-tooltip li {
          margin-bottom: 8px;
          line-height: 1.6;
          display: list-item;
        }
        #hover-summary-tooltip strong {
          font-weight: 600;
        }
        #hover-summary-tooltip em {
          font-style: italic;
        }
      `;
      document.head.appendChild(style);
    }
    
    tooltip = document.createElement('div');
    tooltip.id = 'hover-summary-tooltip';
    tooltip.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      background: white;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2), 0 2px 8px rgba(0,0,0,0.1);
      padding: 16px;
      max-width: 400px;
      max-height: 500px;
      overflow-y: auto;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #1a1a1a;
      display: none;
      pointer-events: auto;
      opacity: 0;
      transition: opacity 0.2s ease;
      cursor: auto;
      user-select: text;
    `;
    
    // Make tooltip interactive - prevent hiding when mouse enters
    tooltip.addEventListener('mouseenter', () => {
      isMouseInTooltip = true;
      clearTimeout(hideTimeout);
      hideTimeout = null;
    });
    
    // Hide with delay when mouse leaves tooltip
    tooltip.addEventListener('mouseleave', () => {
      isMouseInTooltip = false;
      scheduleHide(200); // Short delay when leaving tooltip
    });
    
    document.body.appendChild(tooltip);
    return tooltip;
  }
  
  // Position tooltip
  function positionTooltip(element) {
    if (!tooltip) return;
    
    const rect = element.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const gap = 12;
    
    let top, left;
    
    if (rect.bottom + gap + tooltipRect.height < viewportHeight) {
      top = rect.bottom + gap;
    } else if (rect.top - gap - tooltipRect.height > 0) {
      top = rect.top - gap - tooltipRect.height;
    } else {
      top = Math.max(gap, (viewportHeight - tooltipRect.height) / 2);
    }
    
    left = rect.left;
    
    if (left + tooltipRect.width > viewportWidth - gap) {
      left = Math.max(gap, rect.right - tooltipRect.width);
    }
    
    if (left < gap) {
      left = gap;
    }
    
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }
  
  // Schedule hiding tooltip with delay
  function scheduleHide(delay = 500, forUrl = null) {
    const shortUrl = forUrl ? getShortUrl(forUrl) : 'none';
    debugLog(`⏲️ SCHEDULE HIDE: for "${shortUrl}" in ${delay}ms (currently showing: "${currentlyDisplayedUrl ? getShortUrl(currentlyDisplayedUrl) : 'none'}")`);
    
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      const currentShortUrl = currentlyDisplayedUrl ? getShortUrl(currentlyDisplayedUrl) : 'none';
      // Only hide if:
      // 1. Mouse is not in tooltip
      // 2. Either no URL specified, or the tooltip is still showing this URL's content
      if (!isMouseInTooltip && (!forUrl || currentlyDisplayedUrl === forUrl)) {
        debugLog(`🔽 EXECUTING HIDE: scheduled for "${shortUrl}", currently showing "${currentShortUrl}" - HIDING NOW`);
        hideTooltip();
      } else {
        debugLog(`🚫 SKIP HIDE: scheduled for "${shortUrl}", currently showing "${currentShortUrl}" (mouse in tooltip: ${isMouseInTooltip}, URL match: ${currentlyDisplayedUrl === forUrl})`);
      }
    }, delay);
  }
  
  // Show tooltip
  function showTooltip(element, content, url) {
    if (displayMode === 'panel') return;
    
    const shortUrl = url ? getShortUrl(url) : 'unknown';
    debugLog(`📤 SHOW TOOLTIP: "${shortUrl}" (was showing: "${currentlyDisplayedUrl ? getShortUrl(currentlyDisplayedUrl) : 'none'}")`);
    
    // Cancel any pending hide
    clearTimeout(hideTimeout);
    hideTimeout = null;
    
    const tooltipEl = createTooltip();
    tooltipEl.innerHTML = content;
    tooltipEl.style.display = 'block';
    
    // Track what URL is currently displayed
    currentlyDisplayedUrl = url;
    
    positionTooltip(element);
    
    // Record display time for this URL (for protection window)
    if (url) {
      displayTimes.set(url, Date.now());
    }
    
    requestAnimationFrame(() => {
      tooltipEl.style.opacity = '1';
    });
  }
  
  // Hide tooltip immediately
  function hideTooltip() {
    if (tooltip) {
      const wasShowing = currentlyDisplayedUrl ? getShortUrl(currentlyDisplayedUrl) : 'none';
      debugLog(`📥 HIDE TOOLTIP: was showing "${wasShowing}"`);
      
      tooltip.style.opacity = '0';
      currentlyDisplayedUrl = null; // Clear displayed URL when hiding
      setTimeout(() => {
        if (tooltip && !isMouseInTooltip) {
          tooltip.style.display = 'none';
          debugLog(`🔒 TOOLTIP CLOSED: display set to none`);
        }
      }, 200);
    }
  }
  
  // Update tooltip content
  function updateTooltipContent(content, url) {
    if (displayMode === 'panel') return;
    
    const shortUrl = url ? getShortUrl(url) : 'unknown';
    const wasShowing = currentlyDisplayedUrl ? getShortUrl(currentlyDisplayedUrl) : 'none';
    debugLog(`🔄 UPDATE TOOLTIP: "${shortUrl}" (was showing: "${wasShowing}", visible: ${tooltip && tooltip.style.display === 'block'})`);
    
    // Cancel any pending hide when new content arrives (keep tooltip visible during streaming)
    clearTimeout(hideTimeout);
    hideTimeout = null;
    
    if (tooltip) {
      // Show tooltip if it's not visible (streaming content arrived)
      if (tooltip.style.display !== 'block') {
        tooltip.style.display = 'block';
        debugLog(`  └─ 👁️ Making tooltip visible`);
        // Record display time when showing for first time
        if (url) {
          displayTimes.set(url, Date.now());
        }
      }
      
      // Track what URL is currently displayed
      currentlyDisplayedUrl = url;
      
      tooltip.innerHTML = content;
      tooltip.style.opacity = '1';
      
      // Reposition in case size changed (use processingElement if currentHoveredElement is gone)
      const elementForPositioning = currentHoveredElement || processingElement;
      if (elementForPositioning) {
        positionTooltip(elementForPositioning);
      }
    }
  }
  
  // Find link element
  function findLink(element) {
    let current = element;
    for (let i = 0; i < 10 && current; i++) {
      if (current.tagName === 'A' && current.href) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }
  
  // Get link type for debugging
  function getLinkType(link, target) {
    // Check if the immediate target or any child is an image
    const hasImage = link.querySelector('img') !== null;
    const targetIsImage = target.tagName === 'IMG';
    
    if (targetIsImage || hasImage) {
      return '🖼️ IMAGE-LINK';
    }
    return '📝 TEXT-LINK';
  }
  
  // Get short URL for logging
  function getShortUrl(url) {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname;
      // Get last 2 segments of path or domain
      const segments = path.split('/').filter(s => s);
      const lastSegments = segments.slice(-2).join('/');
      return lastSegments || urlObj.hostname;
    } catch {
      return url.substring(0, 50);
    }
  }
  
  // Handle mouseover
  function handleMouseOver(e) {
    const link = findLink(e.target);
    if (!link) {
      // Not a link, skip (don't log - too noisy on YouTube)
      return;
    }
    
    const url = link.href;
    const linkType = getLinkType(link, e.target);
    const shortUrl = getShortUrl(url);
    
    // Check if this is a YouTube thumbnail first
    if (IS_YOUTUBE && isYouTubeThumbnail(e.target)) {
      console.log(`🎬 YOUTUBE THUMBNAIL: "${shortUrl}" (will trigger in ${HOVER_DELAY}ms)`);
      console.log(`[YouTube] Current processing: ${currentlyProcessingUrl}`);
      console.log(`[YouTube] Current overlay: ${currentYouTubeOverlay ? 'exists for ' + currentYouTubeOverlayUrl : 'none'}`);
      
      // Find ONLY the thumbnail element (not the entire video card)
      // This ensures consistent sizing - overlay covers only thumbnail, not title/channel
      let thumbnailElement = e.target.closest('ytd-thumbnail');
      
      // If not found, try alternative thumbnail containers
      if (!thumbnailElement) {
        thumbnailElement = e.target.closest('ytd-video-preview') || 
                          e.target.closest('ytd-playlist-thumbnail');
      }
      
      if (!thumbnailElement) {
        console.warn('[YouTube] Could not find thumbnail element, skipping');
        return;
      }
      
      // CRITICAL: Cancel old processing BEFORE starting new one
      
      // 1. ALWAYS clear currentlyProcessingUrl when switching videos
      // This prevents streaming updates from old video bleeding into new overlay
      if (currentlyProcessingUrl && currentlyProcessingUrl !== url) {
        console.log(`[YouTube] CANCELING processing for: ${currentlyProcessingUrl}`);
        currentlyProcessingUrl = null;
      }
      
      // 2. Remove ANY existing overlay (could be from completed summary or in-progress)
      if (currentYouTubeOverlay) {
        if (currentYouTubeOverlayUrl !== url) {
          console.log(`[YouTube] Removing old overlay (was for: ${currentYouTubeOverlayUrl}, now hovering: ${url})`);
          removeYouTubeOverlay(true); // Immediate removal
        } else {
          console.log(`[YouTube] Already have overlay for this URL, refreshing...`);
          removeYouTubeOverlay(true); // Remove and recreate
        }
      }
      
      // 2. Clear old hover timeout
      if (currentHoverTimeout) {
        clearTimeout(currentHoverTimeout);
        currentHoverTimeout = null;
      }
      
      // 3. Clear this URL's previous timeout if any
      const oldTimeout = hoverTimeouts.get(url);
      if (oldTimeout) {
        clearTimeout(oldTimeout);
      }
      
      // 4. Clear hide timeout
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
      
      currentHoveredElement = link;
      
      // Schedule hover (DON'T set currentlyProcessingUrl yet - that happens when timeout fires!)
      const hoverTimeout = setTimeout(() => {
        hoverTimeouts.delete(url); // Clean up
        handleYouTubeThumbnailHover(thumbnailElement, link, url);
      }, HOVER_DELAY);
      
      // Store timeout for this URL
      hoverTimeouts.set(url, hoverTimeout);
      currentHoverTimeout = hoverTimeout; // Keep for compatibility
      
      return; // Don't process as regular link
    }
    
    // Don't re-trigger if we're already processing this exact URL
    if (currentlyProcessingUrl === url) {
      debugLog(`🚫 BLOCKED: ${linkType} "${shortUrl}" (already processing)`);
      return;
    }
    
    // Cancel any pending hide when hovering a new link (critical for preventing blinks!)
    if (hideTimeout) {
      debugLog(`🚫 CANCEL HIDE: starting hover on "${shortUrl}"`);
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
    
    debugLog(`✅ HOVER: ${linkType} "${shortUrl}" (will trigger in ${HOVER_DELAY}ms)`);
    
    currentHoveredElement = link;
    
    clearTimeout(currentHoverTimeout);
    currentHoverTimeout = setTimeout(() => {
      processLinkHover(link);
    }, HOVER_DELAY);
  }
  
  // Handle mouseout
  function handleMouseOut(e) {
    const link = findLink(e.target);
    if (!link) return;
    
    const url = link.href;
    const shortUrl = getShortUrl(url);
    
    // Handle YouTube thumbnail mouseout
    if (IS_YOUTUBE && isYouTubeThumbnail(e.target)) {
      console.log('[YouTube] Mouseout detected from thumbnail, url:', url);
      console.log('[YouTube] currentlyProcessingUrl:', currentlyProcessingUrl);
      
      const relatedTarget = e.relatedTarget;
      
      // Check if moving into the overlay itself
      if (currentYouTubeOverlay && relatedTarget) {
        const { overlay } = currentYouTubeOverlay;
        if (overlay.contains(relatedTarget) || overlay === relatedTarget) {
          console.log('[YouTube] Mouse moved into overlay, keeping it visible');
          return;
        }
      }
      
      // Cancel this URL's pending hover timeout (if any)
      const pendingTimeout = hoverTimeouts.get(url);
      if (pendingTimeout) {
        console.log('[YouTube] Canceling pending hover for:', url);
        clearTimeout(pendingTimeout);
        hoverTimeouts.delete(url);
      }
      
      // Remove overlay if this thumbnail currently has it displayed
      // Check BOTH currentlyProcessingUrl (for in-progress) AND currentYouTubeOverlayUrl (for completed)
      // because currentlyProcessingUrl is cleared when summary completes, but overlay remains visible
      const isCurrentThumbnail = (currentlyProcessingUrl === url) || (currentYouTubeOverlayUrl === url);
      
      if (isCurrentThumbnail && currentYouTubeOverlay) {
        console.log('[YouTube] Mouse left current thumbnail (has overlay), removing it');
        removeYouTubeOverlay();
        currentlyProcessingUrl = null;
      } else {
        console.log('[YouTube] Mouse left thumbnail (no overlay here), ignoring');
      }
      return;
    }
    
    // Check if we're actually leaving the link (not just moving to a child element or tooltip)
    const relatedTarget = e.relatedTarget;
    if (relatedTarget) {
      // Don't hide if moving to a child element
      if (link.contains(relatedTarget) || link === relatedTarget) {
        debugLog(`⏭️ MOUSEOUT: "${shortUrl}" (child element, ignored)`);
        return;
      }
      // Don't hide if moving into the tooltip
      if (tooltip && (tooltip.contains(relatedTarget) || tooltip === relatedTarget)) {
        debugLog(`⏭️ MOUSEOUT: "${shortUrl}" (into tooltip, ignored)`);
        return;
      }
    }
    
    // Don't schedule hide if we're actively processing/streaming this URL
    if (currentlyProcessingUrl === url) {
      debugLog(`👋 MOUSEOUT: "${shortUrl}" (streaming active, tooltip will stay visible)`);
      // Don't schedule hide - streaming updates will keep it visible
      // It will only hide when streaming completes or user switches to different URL
    } else {
      // Check if THIS URL's content was just displayed (protection window)
      const urlDisplayTime = displayTimes.get(url) || 0;
      const timeSinceDisplay = urlDisplayTime > 0 ? Date.now() - urlDisplayTime : Infinity;
      const MIN_DISPLAY_TIME = 500; // Minimum time to show content before allowing hide
      
      debugLog(`[DEBUG] URL: "${shortUrl}", displayTime: ${urlDisplayTime}, timeSinceDisplay: ${timeSinceDisplay}ms`);
      
      if (timeSinceDisplay < MIN_DISPLAY_TIME && urlDisplayTime > 0) {
        // Content was just displayed, use longer delay to give user time to see it
        const remainingTime = MIN_DISPLAY_TIME - timeSinceDisplay;
        debugLog(`👋 MOUSEOUT: "${shortUrl}" (content just shown, waiting ${Math.round(remainingTime)}ms before scheduling hide)`);
        
        // Schedule hide after the protection window expires
        setTimeout(() => {
          if (!isMouseInTooltip && !currentHoveredElement) {
            debugLog(`⏰ Protection window expired for "${shortUrl}", now scheduling hide`);
            scheduleHide(500, url); // 500ms > 300ms hover delay to prevent race condition
          }
        }, remainingTime);
      } else {
        debugLog(`👋 MOUSEOUT: "${shortUrl}" (scheduling hide in 500ms, reason: ${urlDisplayTime === 0 ? 'never displayed' : `too long ago (${timeSinceDisplay}ms)`})`);
        scheduleHide(500, url); // 500ms > 300ms hover delay to prevent race condition
      }
    }
    
    // Cancel pending hover
    clearTimeout(currentHoverTimeout);
    currentHoverTimeout = null;
    
    currentHoveredElement = null;
  }
  
  // Process link hover
  async function processLinkHover(link) {
    const url = link.href;
    const shortUrl = getShortUrl(url);
    
    // Clear previous processing URL when starting a new one
    if (currentlyProcessingUrl && currentlyProcessingUrl !== url) {
      debugLog(`🔄 SWITCHING: from "${getShortUrl(currentlyProcessingUrl)}" to "${shortUrl}"`);
    }
    
    // Mark this URL as currently being processed
    currentlyProcessingUrl = url;
    processingElement = link; // Track element for positioning during streaming
    
    debugLog(`🔄 PROCESSING: "${shortUrl}"`);
    
    // Show loading state in tooltip
    if (displayMode === 'tooltip' || displayMode === 'both') {
      showTooltip(link, '<div style="text-align:center;padding:20px;opacity:0.6;">Extracting content...</div>', url);
    }
    
    // Fetch HTML
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_CONTENT',
      url: url
    });
    
    if (response.error) {
      console.error('[Content] Fetch error:', response.error);
      if (displayMode === 'tooltip' || displayMode === 'both') {
        showTooltip(link, `<div style="padding:10px;background:#fee;border-radius:8px;">Error: ${response.error}</div>`, url);
      }
      currentlyProcessingUrl = null;
      processingElement = null;
      return;
    }
    
    // Extract content with Readability
    const parser = new DOMParser();
    const doc = parser.parseFromString(response.html, 'text/html');
    const documentClone = doc.cloneNode(true);
    
    // Readability is already loaded via manifest
    const reader = new Readability(documentClone);
    const article = reader.parse();
    
    let title, textContent;
    
    if (article && article.textContent && article.textContent.trim().length > 100) {
      title = article.title || 'Untitled';
      textContent = article.textContent;
    } else {
      const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content') || 
                       doc.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
                       'No content could be extracted from this page.';
      
      title = doc.title || 'Untitled';
      textContent = metaDesc;
    }
    
    // Show generating state
    if (displayMode === 'tooltip' || displayMode === 'both') {
      showTooltip(link, `<div style="opacity:0.6;font-style:italic;">Generating summary...</div>`, url);
    }
    
    // Request summarization from background
    const result = await chrome.runtime.sendMessage({
      type: 'SUMMARIZE_CONTENT',
      url: url,
      title: title,
      textContent: textContent
    });
    
    // Check if this result is still for the current URL we care about
    const isStillCurrent = (currentlyProcessingUrl === url);
    
    if (result.status === 'duplicate') {
      debugLog(`❌ DUPLICATE: "${shortUrl}" (ignoring)`);
      // Only clear if this was the current URL
      if (isStillCurrent) {
        currentlyProcessingUrl = null;
        processingElement = null;
      }
      return;
    }
    
    if (result.status === 'aborted') {
      debugLog(`❌ ABORTED: "${shortUrl}" (was canceled, ${isStillCurrent ? 'clearing' : 'already moved on'})`);
      // Don't clear - user has likely already moved to a different URL
      // The new URL's processing will have set currentlyProcessingUrl to the new value
      return;
    }
    
    if (result.status === 'error') {
      console.error(`❌ ERROR: "${shortUrl}" - ${result.error}`);
      if (displayMode === 'tooltip' || displayMode === 'both' && isStillCurrent) {
        showTooltip(link, `<div style="padding:10px;background:#fee;border-radius:8px;">Error: ${result.error}</div>`, url);
      }
      // Only clear if this was the current URL
      if (isStillCurrent) {
        currentlyProcessingUrl = null;
        processingElement = null;
      }
      return;
    }
    
    // If complete and cached, display immediately (no streaming updates will come)
    if (result.status === 'complete' && result.cached) {
      debugLog(`💾 CACHED: "${shortUrl}" (instant display, still current: ${isStillCurrent})`);
      
      // Only display if this is still the current URL
      if (isStillCurrent) {
        // Format the summary
        const formattedSummary = formatAISummary(result.summary);
        
        // Show in tooltip
        if (displayMode === 'tooltip' || displayMode === 'both') {
          showTooltip(link, formattedSummary, url);
        }
        
        // Send to sidepanel
        if (displayMode === 'panel' || displayMode === 'both') {
          chrome.runtime.sendMessage({
            type: 'DISPLAY_CACHED_SUMMARY',
            title: result.title,
            summary: formattedSummary
          }).catch(() => {});
        }
        
        // Done processing this URL
        currentlyProcessingUrl = null;
        processingElement = null;
        debugLog(`✅ COMPLETE: "${shortUrl}" (ready for next hover)`);
      } else {
        debugLog(`⚠️ STALE CACHED: "${shortUrl}" (user moved on, ignoring)`);
      }
    } else if (isStillCurrent) {
      // Streaming result - only log if still current
      debugLog(`📡 STREAMING: "${shortUrl}" (will receive updates)`);
    } else {
      // Streaming result arrived but user has moved on
      debugLog(`⚠️ STALE STREAMING: "${shortUrl}" (user moved on, ignoring)`);
    }
    
    // If not cached, summary will arrive via STREAMING_UPDATE messages
    // Note: For streaming, we keep currentlyProcessingUrl set until user hovers another link
  }
  
  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'STREAMING_UPDATE') {
      // Only update if this is for the URL we're currently processing
      if (message.url === currentlyProcessingUrl) {
        // Check if we're showing YouTube overlay or regular tooltip
        if (IS_YOUTUBE && currentYouTubeOverlay) {
          // ADDITIONAL SAFEGUARD: Verify overlay URL matches message URL
          // This prevents streaming from Video A appearing in Video B's overlay
          if (currentYouTubeOverlayUrl === message.url) {
            // Update YouTube overlay with streaming content
            // Note: content is already formatted as HTML by background.js
            updateYouTubeOverlay(message.content, message.url);
            // Streaming log is too noisy, skip it (updateYouTubeOverlay logs final result)
          } else {
            console.warn(`[YouTube] Rejecting stream update: overlay is for ${currentYouTubeOverlayUrl}, update is for ${message.url}`);
          }
        } else {
          // Update regular tooltip
          updateTooltipContent(message.content, message.url);
        }
      } else {
        const shortUrl = getShortUrl(message.url);
        debugLog(`⚠️ STALE STREAM UPDATE: "${shortUrl}" (ignoring, current: "${currentlyProcessingUrl ? getShortUrl(currentlyProcessingUrl) : 'none'}")`);
      }
    }
    
    if (message.type === 'PROCESSING_STATUS') {
      if (message.status === 'started' && currentHoveredElement) {
        if (displayMode === 'tooltip' || displayMode === 'both') {
          showTooltip(currentHoveredElement, `<div style="opacity:0.6;font-style:italic;">Generating summary...</div>`, message.url);
        }
      }
    }
    
    if (message.type === 'DISPLAY_MODE_CHANGED') {
      displayMode = message.displayMode;
      debugLog('[Content] Display mode updated:', displayMode);
      if (displayMode === 'panel') {
        hideTooltip();
      }
    }
  });
  
  // Get initial display mode
  chrome.storage.local.get(['displayMode'], (result) => {
    if (result.displayMode) {
      displayMode = result.displayMode;
      debugLog('[Content] Initial display mode:', displayMode);
    }
  });
  
  // Initialize hover detection
  document.body.addEventListener('mouseover', handleMouseOver, true);
  document.body.addEventListener('mouseout', handleMouseOut, true);
  
  debugLog('[Content] Hover link extension initialized');
  
  // Format AI summary (same as background.js)
  function formatAISummary(text) {
    if (!text) return '';
    
    let formatted = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    
    formatted = formatted
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^# (.+)$/gm, '<h2>$1</h2>');
    
    formatted = formatted
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>');
    
    formatted = formatted
      .replace(/\*([^\*\s][^\*]*?[^\*\s])\*/g, '<em>$1</em>')
      .replace(/_([^_\s][^_]*?[^_\s])_/g, '<em>$1</em>');
    
    formatted = formatted
      .replace(/^[\*\-•] (.+)$/gm, '<li>$1</li>');
    
    formatted = formatted
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    
    formatted = formatted
      .replace(/(<li>.*?<\/li>\n?)+/g, (match) => {
        // Remove newlines from inside the list before wrapping
        return '<ul>' + match.replace(/\n/g, '') + '</ul>';
      });
    
    formatted = formatted
      .replace(/\n\n+/g, '</p><p>');
    
    formatted = formatted
      .replace(/\n/g, '<br>');
    
    if (!formatted.startsWith('<h') && !formatted.startsWith('<ul') && !formatted.startsWith('<p>')) {
      formatted = '<p>' + formatted;
    }
    if (!formatted.endsWith('</p>') && !formatted.endsWith('</ul>') && !formatted.endsWith('</h2>') && !formatted.endsWith('</h3>') && !formatted.endsWith('</h4>')) {
      formatted = formatted + '</p>';
    }
    
    formatted = formatted
      .replace(/<p><\/p>/g, '')
      .replace(/<p>\s*<\/p>/g, '');
    
    formatted = formatted
      .replace(/<p>(<h\d>)/g, '$1')
      .replace(/(<\/h\d>)<\/p>/g, '$1')
      .replace(/<p>(<ul>)/g, '$1')
      .replace(/(<\/ul>)<\/p>/g, '$1');
    
    return formatted;
  }
  
  // ============ YouTube-Specific Functions ============
  
  /**
   * Create YouTube summary overlay inside thumbnail
   */
  function createYouTubeOverlay(thumbnailElement) {
    // thumbnailElement is already the container (ytd-thumbnail, ytd-rich-item-renderer, etc.)
    const container = thumbnailElement;
    
    if (!container) {
      console.warn('[YouTube] No container provided');
      return null;
    }
    
    // Create overlay container
    const overlay = document.createElement('div');
    overlay.className = 'yt-summary-overlay';
    overlay.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.85);
      z-index: 1000;
      display: flex;
      flex-direction: column;
      padding: 12px;
      box-sizing: border-box;
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: auto;
    `;
    
    // Create scrollable content area
    const contentArea = document.createElement('div');
    contentArea.className = 'yt-summary-content';
    contentArea.style.cssText = `
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      color: #fff;
      font-size: 13px;
      line-height: 1.5;
      padding-right: 8px;
    `;
    
    // Custom scrollbar styling
    const style = document.createElement('style');
    style.textContent = `
      .yt-summary-content::-webkit-scrollbar {
        width: 6px;
      }
      .yt-summary-content::-webkit-scrollbar-track {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
      }
      .yt-summary-content::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.3);
        border-radius: 3px;
      }
      .yt-summary-content::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.5);
      }
      .yt-summary-content ul {
        margin: 8px 0;
        padding-left: 20px;
        list-style-type: disc;
      }
      .yt-summary-content li {
        margin-bottom: 6px;
      }
      .yt-summary-content strong {
        font-weight: 600;
        color: #fff;
      }
      .yt-summary-content p {
        margin: 8px 0;
      }
    `;
    document.head.appendChild(style);
    
    overlay.appendChild(contentArea);
    
    // Make container position relative if not already
    const containerStyle = window.getComputedStyle(container);
    if (containerStyle.position === 'static') {
      container.style.position = 'relative';
    }
    
    container.appendChild(overlay);
    
    // Fade in
    setTimeout(() => {
      overlay.style.opacity = '1';
    }, 10);
    
    return { overlay, contentArea };
  }
  
  /**
   * Remove YouTube overlay
   * @param {boolean} immediate - If true, remove immediately without fade-out animation
   */
  function removeYouTubeOverlay(immediate = false) {
    if (currentYouTubeOverlay) {
      const { overlay } = currentYouTubeOverlay;
      
      if (immediate) {
        // Immediate removal (for switching between thumbnails)
        if (overlay.parentNode) {
          overlay.parentNode.removeChild(overlay);
        }
        console.log('[YouTube] Overlay removed immediately');
      } else {
        // Graceful fade-out (for mouse leaving)
        overlay.style.opacity = '0';
        setTimeout(() => {
          if (overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
          }
        }, 300);
        console.log('[YouTube] Overlay fade-out started');
      }
      
      currentYouTubeOverlay = null;
      currentYouTubeOverlayUrl = null;
    }
    
    // Also forcefully remove any stray overlays that might still be in the DOM
    if (immediate) {
      const strayOverlays = document.querySelectorAll('.yt-summary-overlay');
      strayOverlays.forEach(overlay => {
        if (overlay.parentNode) {
          overlay.parentNode.removeChild(overlay);
        }
      });
      if (strayOverlays.length > 0) {
        console.log(`[YouTube] Removed ${strayOverlays.length} stray overlay(s)`);
      }
    }
  }
  
  /**
   * Update YouTube overlay content (only if it's for the right URL)
   */
  function updateYouTubeOverlay(content, forUrl) {
    if (currentYouTubeOverlay) {
      // Only update if this is for the current overlay's URL (prevent stale updates)
      if (!forUrl || currentYouTubeOverlayUrl === forUrl) {
        currentYouTubeOverlay.contentArea.innerHTML = content;
        // Only log non-streaming updates (streaming creates too much noise)
        if (!content.startsWith('⏳') && !content.startsWith('🤖') && content.length > 100) {
          console.log('[YouTube] Overlay updated (length:', content.length, ')');
        }
      } else {
        console.log(`[YouTube] Ignoring update for ${forUrl}, current overlay is for ${currentYouTubeOverlayUrl}`);
      }
    } else {
      console.warn('[YouTube] Cannot update overlay - currentYouTubeOverlay is NULL');
    }
  }
  
  /**
   * Extract video ID from a YouTube URL
   */
  function extractVideoId(url) {
    if (!url) return null;
    
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
      /youtube\.com\/shorts\/([^&\n?#]+)/,
      /\/vi\/([^\/]+)/,
      /\/vi_webp\/([^\/]+)/,
      /[?&]v=([^&\n?#]+)/,
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    
    return null;
  }
  
  /**
   * Check if an element is a YouTube thumbnail
   */
  function isYouTubeThumbnail(element) {
    if (!IS_YOUTUBE) return false;
    
    // Only check for actual thumbnail elements, not entire video cards
    // This ensures consistent overlay sizing
    const thumbnailSelectors = [
      'ytd-thumbnail',
      'ytd-video-preview',
      'ytd-playlist-thumbnail',
      'a#thumbnail'
    ];
    
    for (const selector of thumbnailSelectors) {
      if (element.matches(selector) || element.closest(selector)) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Handle YouTube thumbnail hover - extract video ID and request caption summary
   */
  async function handleYouTubeThumbnailHover(thumbnailElement, linkElement, url) {
    console.log('[YouTube] Thumbnail hover detected:', url);
    
    // Extract video ID
    const videoId = extractVideoId(url);
    if (!videoId) {
      console.warn('[YouTube] Could not extract video ID from:', url);
      currentlyProcessingUrl = null; // Clear processing state
      return;
    }
    
    console.log('[YouTube] Video ID:', videoId);
    
    // CRITICAL: Set currentlyProcessingUrl BEFORE any async operations
    // This ensures streaming updates and response handling work correctly
    currentlyProcessingUrl = url;
    
    // Store element for positioning
    processingElement = linkElement;
    
    // Remove any existing overlay first (IMMEDIATE removal to prevent showing old content)
    removeYouTubeOverlay(true); // true = immediate removal, no fade-out
    
    // Create YouTube overlay (pass the thumbnail container)
    currentYouTubeOverlay = createYouTubeOverlay(thumbnailElement);
    currentYouTubeOverlayUrl = url; // Track which URL this overlay is for
    
    if (!currentYouTubeOverlay) {
      console.warn('[YouTube] Failed to create overlay, falling back to tooltip');
      if (displayMode === 'tooltip' || displayMode === 'both') {
        showTooltip(linkElement, 'Waiting for captions to load...', url);
      }
      return;
    }
    
    console.log('[YouTube] Overlay created for:', url);
    
    // Show initial loading message
    updateYouTubeOverlay('⏳ Waiting for captions to load...', url);
    
    // Wait for captions to be captured (with timeout)
    const waitForCaptions = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for captions'));
      }, 5000); // 5 second timeout
      
      // Check if captions already exist (async check)
      if (window.hasYouTubeCaptions) {
        window.hasYouTubeCaptions(videoId).then(hasCapt => {
          if (hasCapt) {
            console.log('[YouTube] Captions already available for:', videoId);
            clearTimeout(timeout);
            resolve();
          }
        }).catch(() => {
          // Ignore error, will wait for event
        });
      }
      
      // Listen for caption-ready event
      const captionListener = (event) => {
        if (event.detail && event.detail.videoId === videoId) {
          console.log('[YouTube] Captions ready event received for:', videoId);
          clearTimeout(timeout);
          window.removeEventListener('youtube-captions-ready', captionListener);
          resolve();
        }
      };
      
      window.addEventListener('youtube-captions-ready', captionListener);
    });
    
    try {
      // Wait for captions to be ready
      await waitForCaptions;
      console.log('[YouTube] Captions confirmed ready, requesting summary...');
      
      // Update overlay
      updateYouTubeOverlay('🤖 Generating summary...', url);
    } catch (error) {
      console.warn('[YouTube] Timeout or error waiting for captions:', error);
      updateYouTubeOverlay('⚠️ Captions not available (video preview may not have loaded)', url);
      setTimeout(removeYouTubeOverlay, 3000); // Auto-remove after 3 seconds
      currentlyProcessingUrl = null;
      return;
    }
    
    // Now request the summary (captions are ready)
    try {
      chrome.runtime.sendMessage({
        action: 'GET_YOUTUBE_SUMMARY',
        videoId: videoId,
        url: url
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[YouTube] Runtime error:', chrome.runtime.lastError);
          updateYouTubeOverlay('❌ Error: Extension context lost', url);
          setTimeout(removeYouTubeOverlay, 3000);
          currentlyProcessingUrl = null;
          return;
        }
        
        console.log('[YouTube] Response:', response.status, response.cached ? '(cached)' : '');
        
        if (response && response.status === 'complete') {
          // Display the summary
          const summary = response.summary || 'No summary generated';
          const formatted = formatAISummary(summary);
          
          console.log('[YouTube] Displaying summary (length:', summary.length, ')');
          
          // Update state
          currentlyDisplayedUrl = url;
          displayTimes.set(url, Date.now());
          
          // Show summary in overlay
          updateYouTubeOverlay(formatted, url);
          
          // Also send to side panel if enabled
          if (displayMode === 'sidepanel' || displayMode === 'both') {
            chrome.runtime.sendMessage({
              action: 'DISPLAY_CACHED_SUMMARY',
              summary: summary,
              url: url
            });
          }
          
          // Clear processing state after displaying summary
          currentlyProcessingUrl = null;
        } else if (response && response.status === 'streaming') {
          // Update overlay with streaming message
          updateYouTubeOverlay('🤖 Generating summary...', url);
          // Streaming updates will come through runtime.onMessage listener
          // Keep currentlyProcessingUrl set so streaming updates work
        } else if (response && response.error) {
          const errorMsg = response.error === 'NO_CAPTIONS' 
            ? '⚠️ No captions available for this video' 
            : `❌ Error: ${response.error}`;
          updateYouTubeOverlay(errorMsg, url);
          setTimeout(removeYouTubeOverlay, 3000);
          currentlyProcessingUrl = null;
        } else {
          console.warn('[YouTube] Unexpected response:', response);
          updateYouTubeOverlay('❌ Error: Unexpected response', url);
          setTimeout(removeYouTubeOverlay, 3000);
          currentlyProcessingUrl = null;
        }
      });
    } catch (error) {
      console.error('[YouTube] Error requesting summary:', error);
      updateYouTubeOverlay('❌ Error fetching captions', url);
      setTimeout(removeYouTubeOverlay, 3000);
      currentlyProcessingUrl = null;
    }
  }
  
})();