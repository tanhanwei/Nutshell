// ========================================
// AI APIS INITIALIZATION
// ========================================

// Compatibility layer for different Chrome AI API versions
async function initializeSummarizerAPI() {
  // Check for Summarization API
  let summarizerAvailable = false;
  
  if ('Summarizer' in self) {
    console.log('[Background] Found global Summarizer API');
    summarizerAvailable = true;
  } else if ('ai' in self && 'summarizer' in self.ai) {
    console.log('[Background] Found ai.summarizer namespace');
    summarizerAvailable = true;
  }
  
  return {
    summarizer: {
      available: summarizerAvailable,
      availability: summarizerAvailable 
        ? () => ('Summarizer' in self ? Summarizer.availability({ outputLanguage: 'en' }) : ai.summarizer.availability({ outputLanguage: 'en' }))
        : null,
      create: summarizerAvailable
        ? (options) => ('Summarizer' in self ? Summarizer.create(options) : ai.summarizer.create(options))
        : null
    },
    promptAPI: {
      available: 'LanguageModel' in self,
      availability: 'LanguageModel' in self 
        ? (options) => LanguageModel.availability(options || { expectedOutputs: [{ type: 'text', languages: ['en'] }] })
        : null,
      create: 'LanguageModel' in self ? (options) => LanguageModel.create(options) : null,
      params: 'LanguageModel' in self ? () => LanguageModel.params() : null
    }
  };
}

// Global API reference
let SummarizerAPI = null;

// Initialize APIs on service worker startup
(async function initAPIs() {
  SummarizerAPI = await initializeSummarizerAPI();
  console.log('[Background] APIs initialized:', SummarizerAPI);
  
  // Check Summarizer availability
  if (SummarizerAPI.summarizer.available) {
    try {
      const summarizerAvailability = await SummarizerAPI.summarizer.availability();
      console.log('[Background] Summarizer availability:', summarizerAvailability);
      SummarizerAPI.summarizer.status = summarizerAvailability;
    } catch (error) {
      console.error('[Background] Summarizer availability check failed:', error);
      SummarizerAPI.summarizer.status = 'unavailable';
    }
  } else {
    SummarizerAPI.summarizer.status = 'unavailable';
  }
  
  // Check Prompt API availability
  if (SummarizerAPI.promptAPI.available) {
    try {
      const promptAvailability = await SummarizerAPI.promptAPI.availability({
        expectedOutputs: [{ type: 'text', languages: ['en'] }]
      });
      console.log('[Background] Prompt API availability:', promptAvailability);
      SummarizerAPI.promptAPI.status = promptAvailability;
    } catch (error) {
      console.error('[Background] Prompt API availability check failed:', error);
      SummarizerAPI.promptAPI.status = 'unavailable';
    }
  } else {
    SummarizerAPI.promptAPI.status = 'unavailable';
  }
})();

// ========================================
// SETTINGS MANAGEMENT
// ========================================

let settings = {
  apiChoice: 'summarization',
  customPrompt: 'Summarize this article in 2-3 sentences',
  displayMode: 'both'
};

// Load settings from storage
async function loadSettings() {
  const stored = await chrome.storage.local.get(['apiChoice', 'customPrompt', 'displayMode']);
  if (stored.apiChoice) settings.apiChoice = stored.apiChoice;
  if (stored.customPrompt) settings.customPrompt = stored.customPrompt;
  if (stored.displayMode) settings.displayMode = stored.displayMode;
  console.log('[Background] Settings loaded:', settings);
}

// Initialize settings
loadSettings();

// Listen for settings changes
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    if (changes.apiChoice) settings.apiChoice = changes.apiChoice.newValue;
    if (changes.customPrompt) settings.customPrompt = changes.customPrompt.newValue;
    if (changes.displayMode) settings.displayMode = changes.displayMode.newValue;
    console.log('[Background] Settings updated:', settings);
  }
});

// ========================================
// CACHING & STATE MANAGEMENT
// ========================================

const htmlCache = {};
const summaryCache = new Map();
const youtubeCaptionCache = new Map(); // Cache for YouTube caption data
const youtubeSummaryCache = new Map(); // Cache for YouTube summaries
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

let currentAbortController = null;
let isProcessingSummary = false;
let lastProcessedUrl = null;

// YouTube-specific abort controller
let currentYouTubeAbortController = null;
let currentYouTubeVideoId = null;

// Session tracking for proper cleanup
let currentSummarizerSession = null;
let currentPromptSession = null;

// Clean cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of summaryCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      summaryCache.delete(key);
    }
  }
  console.log(`[Background] Cache cleaned. ${summaryCache.size} entries remaining.`);
}, 5 * 60 * 1000);

// ========================================
// AI SUMMARIZATION FUNCTIONS
// ========================================

async function summarizeContent(text, signal, url) {
  if (settings.apiChoice === 'summarization') {
    return await useSummarizationAPI(text, signal, url);
  } else {
    return await usePromptAPI(text, signal, url);
  }
}

async function useSummarizationAPI(text, signal, url) {
  if (!SummarizerAPI.summarizer.available) {
    throw new Error('Summarizer API not available');
  }
  
  const availability = SummarizerAPI.summarizer.status;
  
  if (availability === 'downloadable' || availability === 'downloading') {
    throw new Error('MODEL_DOWNLOAD_REQUIRED');
  }
  
  if (availability === 'unavailable') {
    throw new Error('Summarizer API is unavailable on this device');
  }
  
  if (availability !== 'available' && availability !== 'readily') {
    throw new Error(`Summarizer API status is: ${availability}`);
  }
  
  try {
    const options = {
      type: 'key-points',
      format: 'markdown',
      length: 'medium',
      sharedContext: 'This is an article from a webpage.',
      outputLanguage: 'en'
    };
    
    // Destroy any existing summarizer session
    if (currentSummarizerSession) {
      try {
        if (currentSummarizerSession.destroy) {
          console.log('[Background] Destroying old summarizer session');
          currentSummarizerSession.destroy();
        }
      } catch (e) {
        console.log('[Background] Error destroying old summarizer:', e);
      }
      currentSummarizerSession = null;
    }
    
    const summarizer = await SummarizerAPI.summarizer.create(options);
    currentSummarizerSession = summarizer;
    
    // Add abort listener to destroy session
    if (signal) {
      signal.addEventListener('abort', () => {
        console.log('[Background] Abort signal received - destroying summarizer');
        if (summarizer && summarizer.destroy) {
          summarizer.destroy();
        }
        currentSummarizerSession = null;
      });
    }
    
    // Prepare text
    const MAX_CHARS = 4000;
    let processedText = text;
    
    if (text.length > MAX_CHARS) {
      const partSize = Math.floor(MAX_CHARS / 3);
      const start = text.slice(0, partSize);
      const middle = text.slice(
        Math.floor(text.length / 2 - partSize / 2),
        Math.floor(text.length / 2 + partSize / 2)
      );
      const end = text.slice(-partSize);
      
      processedText = `${start}\n\n[...]\n\n${middle}\n\n[...]\n\n${end}`;
    }
    
    console.log('[Background] Starting Summarizer streaming...');
    const stream = summarizer.summarizeStreaming(processedText);
    
    let fullSummary = '';
    let lastBroadcast = 0;
    const BROADCAST_INTERVAL = 150; // Only broadcast every 150ms
    
    for await (const chunk of stream) {
      if (signal && signal.aborted) {
        console.log('[Background] Summarizer streaming aborted');
        throw new DOMException('Aborted', 'AbortError');
      }
      
      fullSummary += chunk;
      
      // Throttle broadcasts to prevent flooding
      const now = Date.now();
      if (now - lastBroadcast >= BROADCAST_INTERVAL) {
        broadcastStreamingUpdate(fullSummary, url);
        lastBroadcast = now;
      }
    }
    
    // Send final update
    broadcastStreamingUpdate(fullSummary, url);
    
    console.log('[Background] Summarizer streaming complete');
    
    if (summarizer.destroy) {
      summarizer.destroy();
    }
    
    return fullSummary;
    
  } catch (error) {
    if (error.name === 'AbortError' || error.message === 'Session is destroyed') {
      console.log('[Background] Summarizer aborted/destroyed');
      currentSummarizerSession = null;
      throw error;
    }
    console.error('[Background] Summarization failed:', error);
    currentSummarizerSession = null;
    throw error;
  }
}

async function usePromptAPI(text, signal, url) {
  if (!SummarizerAPI.promptAPI.available) {
    throw new Error('Prompt API not available');
  }
  
  const availability = SummarizerAPI.promptAPI.status;
  
  if (availability === 'unavailable') {
    throw new Error('Prompt API not available on this device');
  }
  
  if (availability === 'downloadable' || availability === 'downloading') {
    throw new Error('MODEL_DOWNLOAD_REQUIRED');
  }
  
  if (availability !== 'available' && availability !== 'readily') {
    throw new Error(`Prompt API status is: ${availability}`);
  }
  
  try {
    // Destroy any existing prompt session
    if (currentPromptSession) {
      try {
        console.log('[Background] Destroying old prompt session');
        currentPromptSession.destroy();
      } catch (e) {
        console.log('[Background] Error destroying old prompt session:', e);
      }
      currentPromptSession = null;
    }
    
    const session = await SummarizerAPI.promptAPI.create({
      expectedOutputs: [
        { type: 'text', languages: ['en'] }
      ],
      signal: signal  // Pass signal directly to create
    });
    currentPromptSession = session;
    
    // Add abort listener to destroy session
    if (signal) {
      signal.addEventListener('abort', () => {
        console.log('[Background] Abort signal received - destroying prompt session');
        if (session) {
          session.destroy();
        }
        currentPromptSession = null;
      });
    }
    
    // Prepare text
    const MAX_CHARS = 3000;
    let processedText = text;
    
    if (text.length > MAX_CHARS) {
      const partSize = Math.floor(MAX_CHARS / 3);
      const start = text.slice(0, partSize);
      const middle = text.slice(
        Math.floor(text.length / 2 - partSize / 2),
        Math.floor(text.length / 2 + partSize / 2)
      );
      const end = text.slice(-partSize);
      
      processedText = `${start}\n\n[...]\n\n${middle}\n\n[...]\n\n${end}`;
    }
    
    const fullPrompt = `${settings.customPrompt}\n\nContent:\n${processedText}`;
    
    console.log('[Background] Starting Prompt API streaming...');
    const stream = session.promptStreaming(fullPrompt);
    
    let fullSummary = '';
    let lastBroadcast = 0;
    const BROADCAST_INTERVAL = 150; // Only broadcast every 150ms
    
    for await (const chunk of stream) {
      if (signal && signal.aborted) {
        console.log('[Background] Prompt API streaming aborted');
        throw new DOMException('Aborted', 'AbortError');
      }
      
      fullSummary += chunk;
      
      // Throttle broadcasts to prevent flooding
      const now = Date.now();
      if (now - lastBroadcast >= BROADCAST_INTERVAL) {
        broadcastStreamingUpdate(fullSummary, url);
        lastBroadcast = now;
      }
    }
    
    // Send final update
    broadcastStreamingUpdate(fullSummary, url);
    
    console.log('[Background] Prompt API streaming complete');
    
    if (session.destroy) {
      session.destroy();
    }
    
    return fullSummary;
    
  } catch (error) {
    if (error.name === 'AbortError' || error.message === 'Session is destroyed') {
      console.log('[Background] Prompt API aborted/destroyed');
      currentPromptSession = null;
      throw error;
    }
    console.error('[Background] Prompt API failed:', error);
    currentPromptSession = null;
    throw error;
  }
}

// Broadcast streaming updates to all display surfaces
function broadcastStreamingUpdate(partialSummary, url) {
  const formatted = formatAISummary(partialSummary);
  
  // Send to side panel if open
  chrome.runtime.sendMessage({
    type: 'STREAMING_UPDATE',
    content: formatted,
    url: url
  }).catch(() => {
    // Side panel not open, ignore
  });
  
  // Send to content script for tooltip
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'STREAMING_UPDATE',
        content: formatted,
        url: url
      }).catch(() => {
        // Content script not ready, ignore
      });
    }
  });
}

// Format AI summary to HTML
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

// Handle content summarization
async function handleSummarizeContent(message, sender) {
  const { url, title, textContent, html } = message;
  
  console.log('[Background] Summarize request for:', url);
  
  // Check if same URL is already being processed
  if (isProcessingSummary && lastProcessedUrl === url) {
    console.log('[Background] Already processing this URL, ignoring duplicate');
    return { status: 'duplicate' };
  }
  
  // Cancel previous processing if different URL
  if (currentAbortController && lastProcessedUrl !== url) {
    console.log('[Background] Canceling previous processing for different URL');
    currentAbortController.abort();
    currentAbortController = null;
    isProcessingSummary = false;
  }
  
  // Check cache
  const cacheKey = `${url}_${settings.apiChoice}_${settings.customPrompt}`;
  const cached = summaryCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
    console.log('[Background] Returning cached summary');
    return {
      status: 'complete',
      title: title,
      summary: cached.summary,
      cached: true
    };
  }
  
  // Start processing
  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;
  isProcessingSummary = true;
  lastProcessedUrl = url;
  
  // Notify displays that processing started
  broadcastProcessingStatus('started', title);
  
  try {
    const summary = await summarizeContent(textContent, signal, url);
    
    // Check if aborted
    if (signal.aborted) {
      console.log('[Background] Processing was aborted');
      return { status: 'aborted' };
    }
    
    // Cache the result
    summaryCache.set(cacheKey, {
      summary: summary,
      timestamp: Date.now()
    });
    
    console.log('[Background] Summarization complete and cached');
    
    isProcessingSummary = false;
    currentAbortController = null;
    
    return {
      status: 'complete',
      title: title,
      summary: summary,
      cached: false
    };
    
  } catch (error) {
    isProcessingSummary = false;
    currentAbortController = null;
    
    if (error.name === 'AbortError') {
      return { status: 'aborted' };
    }
    
    console.error('[Background] Summarization error:', error);
    return { status: 'error', error: error.message };
  }
}

// Broadcast processing status
function broadcastProcessingStatus(status, title) {
  const message = {
    type: 'PROCESSING_STATUS',
    status: status,
    title: title
  };
  
  // To side panel
  chrome.runtime.sendMessage(message).catch(() => {});
  
  // To content script
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {});
    }
  });
}

// ========================================
// YOUTUBE CAPTION HELPERS
// ========================================

/**
 * Parse caption data from various YouTube formats
 */
function parseCaptionData(data) {
  try {
    if (typeof data === 'string') {
      // Try JSON3 format first
      if (data.includes('"events"') || data.includes('"wireMagic"')) {
        const jsonData = JSON.parse(data);
        if (jsonData.events) {
          return jsonData.events
            .map(event => {
              if (event.segs) {
                const text = event.segs.map(seg => seg.utf8 || '').join('');
                return {
                  start: (event.tStartMs || 0) / 1000,
                  duration: (event.dDurationMs || 0) / 1000,
                  text: text
                };
              }
              return null;
            })
            .filter(Boolean);
        }
      }
      
      // Try XML format
      if (data.includes('<?xml') || data.includes('<transcript>')) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(data, 'text/xml');
        const texts = xmlDoc.getElementsByTagName('text');
        return Array.from(texts).map(node => ({
          start: parseFloat(node.getAttribute('start') || 0),
          duration: parseFloat(node.getAttribute('dur') || 0),
          text: node.textContent
        }));
      }
      
      // Try standard JSON
      if (data.trim().startsWith('[') || data.trim().startsWith('{')) {
        return JSON.parse(data);
      }
    }
    
    return data;
  } catch (error) {
    console.error('[YouTube] Error parsing caption data:', error);
    return null;
  }
}

/**
 * Convert caption array to plain text
 */
function captionsToText(captions) {
  if (!Array.isArray(captions)) return '';
  return captions
    .map(caption => caption.text || '')
    .filter(text => text.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Handle YouTube caption summarization
 */
async function handleYouTubeSummary(videoId, url) {
  console.log('[YouTube] Handling summary request for:', videoId);
  
  // CRITICAL: Cancel previous YouTube summary if different video
  if (currentYouTubeAbortController && currentYouTubeVideoId !== videoId) {
    console.log('[YouTube] CANCELING previous summary for:', currentYouTubeVideoId);
    currentYouTubeAbortController.abort();
    currentYouTubeAbortController = null;
    currentYouTubeVideoId = null;
  }
  
  // Check summary cache first
  const cachedSummary = youtubeSummaryCache.get(videoId);
  if (cachedSummary && (Date.now() - cachedSummary.timestamp) < CACHE_DURATION) {
    console.log('[YouTube] Returning cached summary');
    return {
      status: 'complete',
      cached: true,
      summary: cachedSummary.summary,
      videoId: videoId
    };
  }
  
  // Check if captions are cached
  let captionData = youtubeCaptionCache.get(videoId);
  
  if (!captionData) {
    console.log('[YouTube] Captions not in cache, requesting from bridge...');
    
    // Request captions from the YouTube bridge
    // The bridge will check with the page-injected handler
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) {
        throw new Error('No active tab found');
      }
      
      const response = await chrome.tabs.sendMessage(tabs[0].id, {
        action: 'GET_YOUTUBE_CAPTIONS',
        videoId: videoId
      });
      
      if (!response || !response.success) {
        throw new Error(response?.error || 'Failed to get captions');
      }
      
      captionData = response.data;
      
      // The data from the handler is an object: {videoId, captions, text, timestamp}
      // Cache the caption data
      youtubeCaptionCache.set(videoId, {
        data: captionData,
        timestamp: captionData.timestamp || Date.now()
      });
      
    } catch (error) {
      console.error('[YouTube] Error getting captions:', error);
      return {
        status: 'error',
        error: 'NO_CAPTIONS',
        message: 'Could not retrieve captions for this video'
      };
    }
  } else {
    console.log('[YouTube] Using cached caption data');
    captionData = captionData.data;
  }
  
  // The captionData is now an object: {videoId, captions, text, timestamp}
  // Check if we have the captions array
  const captionArray = captionData.captions || [];
  const captionText = captionData.text || captionsToText(captionArray);
  
  if (!captionArray || captionArray.length === 0 || !captionText || captionText.length < 10) {
    return {
      status: 'error',
      error: 'NO_CAPTIONS',
      message: 'No captions available for this video'
    };
  }
  
  console.log('[YouTube] Caption count:', captionArray.length);
  console.log('[YouTube] Caption text length:', captionText.length);
  
  // Generate summary using the same logic as webpage summarization
  try {
    // Create and track abort controller for this request
    currentYouTubeAbortController = new AbortController();
    currentYouTubeVideoId = videoId;
    const signal = currentYouTubeAbortController.signal;
    
    // Use existing summarizeContent function
    const summary = await summarizeContent(captionText, signal, url);
    
    // Cache the summary
    youtubeSummaryCache.set(videoId, {
      summary: summary,
      timestamp: Date.now()
    });
    
    console.log('[YouTube] Summary generated successfully');
    
    // Clear abort controller after success
    currentYouTubeAbortController = null;
    currentYouTubeVideoId = null;
    
    return {
      status: 'complete',
      cached: false,
      summary: summary,
      videoId: videoId,
      captionCount: captionArray.length
    };
  } catch (error) {
    console.error('[YouTube] Error generating summary:', error);
    
    // Clear abort controller after error
    currentYouTubeAbortController = null;
    currentYouTubeVideoId = null;
    
    // Check if it was aborted (user switched videos)
    if (error.name === 'AbortError') {
      return {
        status: 'aborted',
        message: 'Summary cancelled (switched to different video)'
      };
    }
    
    return {
      status: 'error',
      error: 'SUMMARY_FAILED',
      message: error.message
    };
  }
}

// ========================================
// MESSAGE HANDLERS
// ========================================

// Handle extension icon click to open side panel
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  
  // Handle content summarization request
  if (message.type === 'SUMMARIZE_CONTENT') {
    handleSummarizeContent(message, sender)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  // Handle get API status
  if (message.type === 'GET_API_STATUS') {
    sendResponse({
      summarizer: SummarizerAPI.summarizer.status,
      promptAPI: SummarizerAPI.promptAPI.status
    });
    return true;
  }
  
  // Handle get settings
  if (message.type === 'GET_SETTINGS') {
    sendResponse(settings);
    return true;
  }
  
  // Handle HTML fetch
  if (message.type === 'FETCH_CONTENT') {
    const url = message.url;
    
    // Check cache first
    if (htmlCache[url]) {
      sendResponse({ cached: true, html: htmlCache[url], url: url });
      return true;
    }
    
    // Fetch HTML
    fetch(url)
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response.text();
      })
      .then(html => {
        htmlCache[url] = html;
        sendResponse({ cached: false, html: html, url: url });
      })
      .catch(error => {
        sendResponse({ error: error.message, url: url });
      });
    
    return true; // Keep channel open for async response
  }
  
  // Handle YouTube caption fetch (for testing and production)
  if (message.action === 'FETCH_YOUTUBE_CAPTIONS') {
    const url = message.url;
    
    console.log('[Background] Fetching YouTube captions:', url);
    
    fetch(url)
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response.text();
      })
      .then(data => {
        console.log('[Background] Successfully fetched captions, length:', data.length);
        sendResponse({ success: true, data: data });
      })
      .catch(error => {
        console.error('[Background] Failed to fetch captions:', error);
        sendResponse({ success: false, error: error.message });
      });
    
    return true; // Keep channel open for async response
  }
  
  // Handle YouTube summary abort request
  if (message.action === 'ABORT_YOUTUBE_SUMMARY') {
    console.log('[Background] Received abort request for:', message.videoId);
    
    // Abort the controller if it exists and matches
    if (currentYouTubeAbortController && currentYouTubeVideoId === message.videoId) {
      console.log('[Background] Aborting YouTube summary for:', message.videoId);
      currentYouTubeAbortController.abort();
      currentYouTubeAbortController = null;
      currentYouTubeVideoId = null;
    }
    
    // Destroy any active AI sessions
    if (currentSummarizerSession) {
      try {
        console.log('[Background] Destroying summarizer session due to abort');
        currentSummarizerSession.destroy();
      } catch (e) {
        console.log('[Background] Error destroying summarizer:', e);
      }
      currentSummarizerSession = null;
    }
    if (currentPromptSession) {
      try {
        console.log('[Background] Destroying prompt session due to abort');
        currentPromptSession.destroy();
      } catch (e) {
        console.log('[Background] Error destroying prompt session:', e);
      }
      currentPromptSession = null;
    }
    
    sendResponse({ status: 'aborted' });
    return true;
  }
  
  // Handle YouTube summary request
  if (message.action === 'GET_YOUTUBE_SUMMARY') {
    const videoId = message.videoId;
    const url = message.url;
    
    console.log('[Background] YouTube summary requested for:', videoId);
    
    handleYouTubeSummary(videoId, url)
      .then(result => {
        console.log('[Background] YouTube summary result:', result.status);
        sendResponse(result);
      })
      .catch(error => {
        console.error('[Background] YouTube summary error:', error);
        sendResponse({
          status: 'error',
          error: 'PROCESSING_ERROR',
          message: error.message
        });
      });
    
    return true; // Keep channel open for async response
  }
});