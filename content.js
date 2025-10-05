(function() {
  'use strict';
  
  // Configuration
  const HOVER_DELAY = 300;
  
  // State management
  let currentHoverTimeout = null;
  let hideTimeout = null;
  let lastProcessedUrl = null;
  let tooltip = null;
  let displayMode = 'both';
  let currentHoveredElement = null;
  let isMouseInTooltip = false;
  
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
    if (tooltip && tooltip.style.display === 'block') {
      tooltip.innerHTML = content;
      // Reposition in case size changed
      if (currentHoveredElement) {
        positionTooltip(currentHoveredElement);
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
  
  // Handle mouseover
  function handleMouseOver(e) {
    const link = findLink(e.target);
    if (!link) return;
    
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
    
    // Cancel pending hover
    clearTimeout(currentHoverTimeout);
    currentHoverTimeout = null;
    
    // Schedule hide with delay (unless mouse moves into tooltip)
    scheduleHide(300);
    
    currentHoveredElement = null;
  }
  
  // Process link hover
  async function processLinkHover(link) {
    const url = link.href;
    
    console.log('[Content] Processing hover for:', url);
    
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
    
    if (result.status === 'duplicate') {
      console.log('[Content] Duplicate request, ignoring');
      return;
    }
    
    if (result.status === 'aborted') {
      console.log('[Content] Request was aborted');
      return;
    }
    
    if (result.status === 'error') {
      console.error('[Content] Summarization error:', result.error);
      if (displayMode === 'tooltip' || displayMode === 'both') {
        showTooltip(link, `<div style="padding:10px;background:#fee;border-radius:8px;">Error: ${result.error}</div>`);
      }
      return;
    }
    
    // If complete and cached, display immediately (no streaming updates will come)
    if (result.status === 'complete' && result.cached) {
      console.log('[Content] Displaying cached summary immediately');
      
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
    }
    
    // If not cached, summary will arrive via STREAMING_UPDATE messages
  }
  
  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'STREAMING_UPDATE') {
      updateTooltipContent(message.content);
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