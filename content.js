(function() {
  'use strict';
  
  // Configuration
  const HOVER_DELAY = 300;
  
  // State management
  let currentHoverTimeout = null;
  let hideTimeout = null;
  let lastProcessedUrl = null;
  let currentlyProcessingUrl = null;
  let processingElement = null; // Track element being processed for positioning
  let tooltip = null;
  let displayMode = 'both';
  let currentHoveredElement = null;
  let isMouseInTooltip = false;
  let lastDisplayTime = 0; // Track when content was last displayed
  
  // Create tooltip
  function createTooltip() {
    if (tooltip) return tooltip;
    
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
  function scheduleHide(delay = 300) {
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      if (!isMouseInTooltip) {
        hideTooltip();
      }
    }, delay);
  }
  
  // Show tooltip
  function showTooltip(element, content) {
    if (displayMode === 'panel') return;
    
    // Cancel any pending hide
    clearTimeout(hideTimeout);
    hideTimeout = null;
    
    const tooltipEl = createTooltip();
    tooltipEl.innerHTML = content;
    tooltipEl.style.display = 'block';
    
    positionTooltip(element);
    
    // Record display time for protection window
    lastDisplayTime = Date.now();
    
    requestAnimationFrame(() => {
      tooltipEl.style.opacity = '1';
    });
  }
  
  // Hide tooltip immediately
  function hideTooltip() {
    if (tooltip) {
      tooltip.style.opacity = '0';
      setTimeout(() => {
        if (tooltip && !isMouseInTooltip) {
          tooltip.style.display = 'none';
        }
      }, 200);
    }
  }
  
  // Update tooltip content
  function updateTooltipContent(content) {
    if (displayMode === 'panel') return;
    
    // Cancel any pending hide when new content arrives (keep tooltip visible during streaming)
    clearTimeout(hideTimeout);
    hideTimeout = null;
    
    if (tooltip) {
      // Show tooltip if it's not visible (streaming content arrived)
      if (tooltip.style.display !== 'block') {
        tooltip.style.display = 'block';
        // Record display time when showing for first time
        lastDisplayTime = Date.now();
      }
      
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
    if (!link) return;
    
    const url = link.href;
    const linkType = getLinkType(link, e.target);
    const shortUrl = getShortUrl(url);
    
    // Don't re-trigger if we're already processing this exact URL
    if (currentlyProcessingUrl === url) {
      console.log(`🚫 BLOCKED: ${linkType} "${shortUrl}" (already processing)`);
      return;
    }
    
    console.log(`✅ HOVER: ${linkType} "${shortUrl}" (will trigger in ${HOVER_DELAY}ms)`);
    
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
    
    // Check if we're actually leaving the link (not just moving to a child element or tooltip)
    const relatedTarget = e.relatedTarget;
    if (relatedTarget) {
      // Don't hide if moving to a child element
      if (link.contains(relatedTarget) || link === relatedTarget) {
        console.log(`⏭️ MOUSEOUT: "${shortUrl}" (child element, ignored)`);
        return;
      }
      // Don't hide if moving into the tooltip
      if (tooltip && (tooltip.contains(relatedTarget) || tooltip === relatedTarget)) {
        console.log(`⏭️ MOUSEOUT: "${shortUrl}" (into tooltip, ignored)`);
        return;
      }
    }
    
    // Check if content was just displayed (protection window)
    const timeSinceDisplay = Date.now() - lastDisplayTime;
    const MIN_DISPLAY_TIME = 500; // Minimum time to show content before allowing hide
    
    if (timeSinceDisplay < MIN_DISPLAY_TIME && lastDisplayTime > 0) {
      // Content was just displayed, use longer delay to give user time to see it
      const remainingTime = MIN_DISPLAY_TIME - timeSinceDisplay;
      console.log(`👋 MOUSEOUT: "${shortUrl}" (content just shown, waiting ${Math.round(remainingTime)}ms before scheduling hide)`);
      
      // Schedule hide after the protection window expires
      setTimeout(() => {
        if (!isMouseInTooltip && !currentHoveredElement) {
          console.log(`⏰ Protection window expired for "${shortUrl}", now scheduling hide`);
          scheduleHide(300);
        }
      }, remainingTime);
    } else {
      console.log(`👋 MOUSEOUT: "${shortUrl}" (scheduling hide in 300ms)`);
      scheduleHide(300);
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
      console.log(`🔄 SWITCHING: from "${getShortUrl(currentlyProcessingUrl)}" to "${shortUrl}"`);
    }
    
    // Mark this URL as currently being processed
    currentlyProcessingUrl = url;
    processingElement = link; // Track element for positioning during streaming
    
    console.log(`🔄 PROCESSING: "${shortUrl}"`);
    
    // Show loading state in tooltip
    if (displayMode === 'tooltip' || displayMode === 'both') {
      showTooltip(link, '<div style="text-align:center;padding:20px;opacity:0.6;">Extracting content...</div>');
    }
    
    // Fetch HTML
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_CONTENT',
      url: url
    });
    
    if (response.error) {
      console.error('[Content] Fetch error:', response.error);
      if (displayMode === 'tooltip' || displayMode === 'both') {
        showTooltip(link, `<div style="padding:10px;background:#fee;border-radius:8px;">Error: ${response.error}</div>`);
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
      showTooltip(link, `<div style="opacity:0.6;font-style:italic;">Generating summary...</div>`);
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
      console.log(`❌ DUPLICATE: "${shortUrl}" (ignoring)`);
      // Only clear if this was the current URL
      if (isStillCurrent) {
        currentlyProcessingUrl = null;
        processingElement = null;
      }
      return;
    }
    
    if (result.status === 'aborted') {
      console.log(`❌ ABORTED: "${shortUrl}" (was canceled, ${isStillCurrent ? 'clearing' : 'already moved on'})`);
      // Don't clear - user has likely already moved to a different URL
      // The new URL's processing will have set currentlyProcessingUrl to the new value
      return;
    }
    
    if (result.status === 'error') {
      console.error(`❌ ERROR: "${shortUrl}" - ${result.error}`);
      if (displayMode === 'tooltip' || displayMode === 'both' && isStillCurrent) {
        showTooltip(link, `<div style="padding:10px;background:#fee;border-radius:8px;">Error: ${result.error}</div>`);
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
      console.log(`💾 CACHED: "${shortUrl}" (instant display, still current: ${isStillCurrent})`);
      
      // Only display if this is still the current URL
      if (isStillCurrent) {
        // Format the summary
        const formattedSummary = formatAISummary(result.summary);
        
        // Show in tooltip
        if (displayMode === 'tooltip' || displayMode === 'both') {
          showTooltip(link, formattedSummary);
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
        console.log(`✅ COMPLETE: "${shortUrl}" (ready for next hover)`);
      } else {
        console.log(`⚠️ STALE CACHED: "${shortUrl}" (user moved on, ignoring)`);
      }
    } else if (isStillCurrent) {
      // Streaming result - only log if still current
      console.log(`📡 STREAMING: "${shortUrl}" (will receive updates)`);
    } else {
      // Streaming result arrived but user has moved on
      console.log(`⚠️ STALE STREAMING: "${shortUrl}" (user moved on, ignoring)`);
    }
    
    // If not cached, summary will arrive via STREAMING_UPDATE messages
    // Note: For streaming, we keep currentlyProcessingUrl set until user hovers another link
  }
  
  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'STREAMING_UPDATE') {
      // Only update if this is for the URL we're currently processing
      if (message.url === currentlyProcessingUrl) {
        updateTooltipContent(message.content);
      } else {
        const shortUrl = getShortUrl(message.url);
        console.log(`⚠️ STALE STREAM UPDATE: "${shortUrl}" (ignoring, current: "${currentlyProcessingUrl ? getShortUrl(currentlyProcessingUrl) : 'none'}")`);
      }
    }
    
    if (message.type === 'PROCESSING_STATUS') {
      if (message.status === 'started' && currentHoveredElement) {
        if (displayMode === 'tooltip' || displayMode === 'both') {
          showTooltip(currentHoveredElement, `<div style="opacity:0.6;font-style:italic;">Generating summary...</div>`);
        }
      }
    }
    
    if (message.type === 'DISPLAY_MODE_CHANGED') {
      displayMode = message.displayMode;
      console.log('[Content] Display mode updated:', displayMode);
      if (displayMode === 'panel') {
        hideTooltip();
      }
    }
  });
  
  // Get initial display mode
  chrome.storage.local.get(['displayMode'], (result) => {
    if (result.displayMode) {
      displayMode = result.displayMode;
      console.log('[Content] Initial display mode:', displayMode);
    }
  });
  
  // Initialize hover detection
  document.body.addEventListener('mouseover', handleMouseOver, true);
  document.body.addEventListener('mouseout', handleMouseOut, true);
  
  console.log('[Content] Hover link extension initialized');
  
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
        return '<ul>' + match + '</ul>';
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
})();