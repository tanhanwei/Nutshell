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

// Helper to create a default API state so status checks are safe before init completes
function createInitialApiState() {
  return {
    summarizer: {
      available: false,
      status: 'initializing',
      availability: null,
      create: null
    },
    promptAPI: {
      available: false,
      status: 'initializing',
      availability: null,
      create: null,
      params: null
    }
  };
}

// Global API reference
let SummarizerAPI = createInitialApiState();

// Initialize APIs on service worker startup
async function initAPIs() {
  try {
    const api = await initializeSummarizerAPI();

    Object.assign(SummarizerAPI.summarizer, api.summarizer);
    SummarizerAPI.summarizer.status = SummarizerAPI.summarizer.available ? 'initializing' : 'unavailable';

    Object.assign(SummarizerAPI.promptAPI, api.promptAPI);
    SummarizerAPI.promptAPI.status = SummarizerAPI.promptAPI.available ? 'initializing' : 'unavailable';

    console.log('[Background] APIs initialized:', {
      summarizerAvailable: SummarizerAPI.summarizer.available,
      promptAvailable: SummarizerAPI.promptAPI.available
    });

    // Check Summarizer availability
    if (SummarizerAPI.summarizer.available && SummarizerAPI.summarizer.availability) {
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
    if (SummarizerAPI.promptAPI.available && SummarizerAPI.promptAPI.availability) {
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
  } catch (error) {
    console.error('[Background] API initialization failed:', error);
    SummarizerAPI.summarizer.status = 'error';
    SummarizerAPI.promptAPI.status = 'error';
  }
}

const apiInitializationPromise = initAPIs();

// ========================================
// SETTINGS MANAGEMENT
// ========================================

let settings = {
  apiChoice: 'summarization',
  customPrompt: 'Summarize this article in 2-3 sentences',
  displayMode: 'panel'
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
const youtubeDescriptionCache = new Map(); // Cache for YouTube video descriptions
const twitterThreadCache = new Map(); // Cache for Twitter conversation scrapes
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes
const TWITTER_THREAD_TTL = 5 * 60 * 1000; // 5 minutes
const YOUTUBE_DEBUG_LOG_FULL_INPUT = true; // Toggle to emit full summarization input for debugging

const summarizationJobs = new Map();
const youtubeJobsByVideoId = new Map();
let summarizationJobCounter = 0;
let activePageJobId = null;
let activeYouTubeJobId = null;

function createSummarizationJob({ url, tabId, feature, metadata }) {
  const controller = new AbortController();
  const jobId = `job-${Date.now()}-${++summarizationJobCounter}`;
  const job = {
    id: jobId,
    url,
    tabId: typeof tabId === 'number' ? tabId : null,
    feature,
    metadata: metadata || {},
    controller,
    signal: controller.signal,
    session: null,
    sessionType: null,
    createdAt: Date.now()
  };
  summarizationJobs.set(jobId, job);
  return job;
}

function registerJobSession(job, session, type) {
  if (!job) return;
  job.session = session || null;
  job.sessionType = type || null;
}

function destroyJobSession(job) {
  if (!job || !job.session) {
    job.session = null;
    job.sessionType = null;
    return;
  }
  if (typeof job.session.destroy === 'function') {
    try {
      job.session.destroy();
    } catch (error) {
      console.warn('[Background] Failed to destroy session:', error);
    }
  }
  job.session = null;
  job.sessionType = null;
}

function finalizeJob(jobId) {
  const job = summarizationJobs.get(jobId);
  if (!job) return;
  destroyJobSession(job);
  summarizationJobs.delete(jobId);

  if (job.feature === 'page' && activePageJobId === jobId) {
    activePageJobId = null;
  }

  if (job.feature === 'youtube') {
    if (activeYouTubeJobId === jobId) {
      activeYouTubeJobId = null;
    }
    const videoId = job.metadata && job.metadata.videoId;
    if (videoId && youtubeJobsByVideoId.get(videoId) === jobId) {
      youtubeJobsByVideoId.delete(videoId);
    }
  }
}

function abortJob(jobId, reason) {
  const job = summarizationJobs.get(jobId);
  if (!job) return;
  if (!job.signal.aborted) {
    job.controller.abort();
  }
  console.log('[Background] Aborting job', {
    feature: job.feature,
    url: job.url,
    reason: reason || 'unspecified'
  });
  finalizeJob(jobId);
}

function getJob(jobId) {
  return summarizationJobs.get(jobId) || null;
}

// Clean cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of summaryCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      summaryCache.delete(key);
    }
  }
  for (const [key, value] of twitterThreadCache.entries()) {
    if (now - value.timestamp > TWITTER_THREAD_TTL) {
      twitterThreadCache.delete(key);
    }
  }
  for (const [key, value] of youtubeDescriptionCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      youtubeDescriptionCache.delete(key);
    }
  }
  console.log(`[Background] Cache cleaned. Summaries: ${summaryCache.size}, Twitter threads: ${twitterThreadCache.size}, YouTube descriptions: ${youtubeDescriptionCache.size}.`);
}, 5 * 60 * 1000);

// ========================================
// AI SUMMARIZATION FUNCTIONS
// ========================================

async function summarizeContent({ job, text, url }) {
  if (!job) {
    throw new Error('Summarization job context missing');
  }
  const signal = job.signal;
  await apiInitializationPromise;
  if (settings.apiChoice === 'summarization') {
    return await useSummarizationAPI({ job, text, signal, url });
  } else {
    return await usePromptAPI({ job, text, signal, url });
  }
}

async function useSummarizationAPI({ job, text, signal, url }) {
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
    
    const summarizer = await SummarizerAPI.summarizer.create(options);
    registerJobSession(job, summarizer, 'summarizer');
    
    // Add abort listener to destroy session
    if (signal) {
      signal.addEventListener('abort', () => {
        console.log('[Background] Abort signal received - destroying summarizer');
        destroyJobSession(job);
      }, { once: true });
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
    
    // Store the summarizer instance globally BEFORE streaming
    registerJobSession(job, summarizer, 'summarizer');
    
    // Check if already aborted before starting
    if (signal && signal.aborted) {
      console.log('[Background] Already aborted before streaming started');
      destroyJobSession(job);
      throw new DOMException('Aborted', 'AbortError');
    }
    
    try {
      const stream = summarizer.summarizeStreaming(processedText);
      
      let fullSummary = '';
      let lastBroadcast = 0;
      const BROADCAST_INTERVAL = 150;
      
      // Store the videoId for this specific stream at the start
      const videoIdForThisStream = job?.metadata?.videoId ||
        (url.includes('watch?v=') ? new URL(url).searchParams.get('v') : null);
      if (videoIdForThisStream) {
        console.log('[Streaming] Starting stream for videoId:', videoIdForThisStream);
      }
      
      for await (const chunk of stream) {
        // Add debug line - log every ~100 chars
        if (fullSummary.length % 100 < 10) {
          console.log(`[Streaming] Progress: ${fullSummary.length} chars, videoId: ${videoIdForThisStream || 'n/a'}`);
        }
        
        if (!summarizationJobs.has(job.id)) {
          console.log('[Background] 🔴 JOB REMOVED - stopping stream');
          destroyJobSession(job);
          throw new DOMException('Aborted', 'AbortError');
        }
        
        // ✅ ENHANCED: Check abort BEFORE processing chunk
        if (signal && signal.aborted) {
          console.log('[Background] 🔴 ABORT SIGNAL DETECTED - stopping immediately');
          
          // Destroy session immediately
          destroyJobSession(job);
          
          // Throw to exit the async generator
          throw new DOMException('Aborted', 'AbortError');
        }
        
        // ✅ ENHANCED: Also check if session was destroyed externally
        if (!job.session) {
          console.log('[Background] 🔴 SESSION DESTROYED - stopping stream');
          throw new DOMException('Session destroyed', 'AbortError');
        }
        
        fullSummary += chunk;
        
        const now = Date.now();
        if (now - lastBroadcast >= BROADCAST_INTERVAL) {
          broadcastStreamingUpdate(job, fullSummary);
          lastBroadcast = now;
        }
      }
      
      // Final broadcast
      broadcastStreamingUpdate(job, fullSummary);
      
      return fullSummary;
      
    } catch (error) {
      // Clean up on any error
      destroyJobSession(job);
      throw error;
    }
    
  } catch (error) {
    if (error.name === 'AbortError' || error.message === 'Session is destroyed') {
      console.log('[Background] Summarizer aborted/destroyed');
      throw error;
    }
    console.error('[Background] Summarization failed:', error);
    throw error;
  } finally {
    destroyJobSession(job);
  }
}

async function usePromptAPI({ job, text, signal, url }) {
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
    const session = await SummarizerAPI.promptAPI.create({
      expectedOutputs: [
        { type: 'text', languages: ['en'] }
      ],
      signal: signal  // Pass signal directly to create
    });
    registerJobSession(job, session, 'prompt');
    
    // Add abort listener to destroy session
    if (signal) {
      signal.addEventListener('abort', () => {
        console.log('[Background] Abort signal received - destroying prompt session');
        destroyJobSession(job);
      }, { once: true });
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
    
    // Store the session instance globally BEFORE streaming
    registerJobSession(job, session, 'prompt');
    
    // Check if already aborted before starting
    if (signal && signal.aborted) {
      console.log('[Background] Already aborted before streaming started');
      destroyJobSession(job);
      throw new DOMException('Aborted', 'AbortError');
    }
    
    try {
      const stream = session.promptStreaming(fullPrompt);
      
      let fullSummary = '';
      let lastBroadcast = 0;
      const BROADCAST_INTERVAL = 150;
      
      // Store the videoId for this specific stream at the start
      const videoIdForThisStream = job?.metadata?.videoId ||
        (url.includes('watch?v=') ? new URL(url).searchParams.get('v') : null);
      if (videoIdForThisStream) {
        console.log('[Streaming] Starting stream for videoId:', videoIdForThisStream);
      }
      
      for await (const chunk of stream) {
        // Add debug line - log every ~100 chars
        if (fullSummary.length % 100 < 10) {
          console.log(`[Streaming] Progress: ${fullSummary.length} chars, videoId: ${videoIdForThisStream || 'n/a'}`);
        }
        
        if (!summarizationJobs.has(job.id)) {
          console.log('[Background] 🔴 JOB REMOVED - stopping stream');
          destroyJobSession(job);
          throw new DOMException('Aborted', 'AbortError');
        }
        
        // ✅ ENHANCED: Check abort BEFORE processing chunk
        if (signal && signal.aborted) {
          console.log('[Background] 🔴 ABORT SIGNAL DETECTED - stopping immediately');
          
          // Destroy session immediately
          destroyJobSession(job);
          
          // Throw to exit the async generator
          throw new DOMException('Aborted', 'AbortError');
        }
        
        // ✅ ENHANCED: Also check if session was destroyed externally
        if (!job.session) {
          console.log('[Background] 🔴 SESSION DESTROYED - stopping stream');
          throw new DOMException('Session destroyed', 'AbortError');
        }
        
        fullSummary += chunk;
        
        const now = Date.now();
        if (now - lastBroadcast >= BROADCAST_INTERVAL) {
          broadcastStreamingUpdate(job, fullSummary);
          lastBroadcast = now;
        }
      }
      
      // Final broadcast
      broadcastStreamingUpdate(job, fullSummary);
      
      return fullSummary;
      
    } catch (error) {
      // Clean up on any error
      destroyJobSession(job);
      throw error;
    }
    
  } catch (error) {
    if (error.name === 'AbortError' || error.message === 'Session is destroyed') {
      console.log('[Background] Prompt API aborted/destroyed');
      throw error;
    }
    console.error('[Background] Prompt API failed:', error);
    throw error;
  } finally {
    destroyJobSession(job);
  }
}

// Broadcast streaming updates to all display surfaces
function broadcastStreamingUpdate(job, partialSummary) {
  if (!job) return;
  if (!summarizationJobs.has(job.id)) {
    return;
  }
  const formatted = formatAISummary(partialSummary);
  const payload = {
    type: 'STREAMING_UPDATE',
    content: formatted,
    url: job.url
  };
  
  // Send to side panel if open
  chrome.runtime.sendMessage(payload).catch(() => {
    // Side panel not open, ignore
  });
  
  // Send to content script for tooltip
  if (typeof job.tabId === 'number') {
    chrome.tabs.sendMessage(job.tabId, payload).catch(() => {
      // Content script not ready, ignore
    });
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, payload).catch(() => {
          // Content script not ready, ignore
        });
      }
    });
  }
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

// ========================================
// TWITTER BACKGROUND SCRAPE HELPERS
// ========================================

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabComplete(tabId, timeout = 15000) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('TAB_NOT_FOUND');
  if (tab.status === 'complete') {
    return;
  }
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('TAB_LOAD_TIMEOUT'));
    }, timeout);
    
    function handleUpdate(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        cleanup();
        resolve();
      }
    }
    
    function handleRemoved(removedTabId) {
      if (removedTabId === tabId) {
        cleanup();
        reject(new Error('TAB_CLOSED'));
      }
    }
    
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(handleUpdate);
      chrome.tabs.onRemoved.removeListener(handleRemoved);
    }
    
    chrome.tabs.onUpdated.addListener(handleUpdate);
    chrome.tabs.onRemoved.addListener(handleRemoved);
  });
}

async function captureTwitterThreadInTab(tabId, tweetId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: 'CAPTURE_TWITTER_THREAD',
        tweetId
      });
      
      if (response && response.status === 'ok' && response.payload && Array.isArray(response.payload.nodes)) {
        const payload = response.payload;
        payload.source = payload.source || 'background';
        return payload;
      }
      
      if (response && response.error) {
        console.warn('[Twitter] Capture response error:', response.error);
      }
    } catch (error) {
      console.warn('[Twitter] Capture attempt failed:', error);
    }
    
    await delay(300 * (attempt + 1));
  }
  
  try {
    const executed = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (targetTweetId) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const start = Date.now();
        let bestNodes = null;
        while (Date.now() - start < 12000) {
          const BUTTON_SELECTOR = 'div[role="button"], button, a[role="link"]';
          const EXPAND_MATCH = /(show|view|reveal).*(repl|thread|tweet)/i;
          document.querySelectorAll(BUTTON_SELECTOR).forEach((el) => {
            const text = (el.textContent || '').trim();
            if (text && EXPAND_MATCH.test(text)) {
              el.click();
            }
          });
          window.scrollBy(0, Math.max(window.innerHeight * 0.9, 600));
          await sleep(420);
          document.querySelectorAll(BUTTON_SELECTOR).forEach((el) => {
            const text = (el.textContent || '').trim();
            if (text && EXPAND_MATCH.test(text)) {
              el.click();
            }
          });
          await sleep(220);
          const nodesMap = new Map();
          document.querySelectorAll('article[role="article"]').forEach((article) => {
            const link = article.querySelector('a[href*="/status/"]');
            const href = link ? link.getAttribute('href') : null;
            let id = null;
            if (href) {
              const match = href.match(/status\/(\d+)/);
              if (match) id = match[1];
            }
            if (!id && targetTweetId) id = targetTweetId;
            if (!id) return;
            const handleSpan = article.querySelector('div[dir="ltr"] span');
            const handle = handleSpan ? handleSpan.textContent : null;
            const textEl = article.querySelector('[data-testid="tweetText"]');
            const text = textEl ? textEl.innerText.trim() : '';
            const timeEl = article.querySelector('time');
            const timestamp = timeEl ? timeEl.getAttribute('datetime') : null;
            const media = [];
            article.querySelectorAll('img').forEach((img) => {
              if (!img || !img.src) return;
              const pixels = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
              if (pixels > 40000) {
                media.push({ kind: 'photo', urls: [img.src] });
              }
            });
            const existing = nodesMap.get(id);
            if (!existing || (text && text.length > (existing.text || '').length)) {
              nodesMap.set(id, {
                id: String(id),
                conversationId: null,
                authorName: null,
                handle: handle || null,
                avatarUrl: null,
                timestamp,
                permalink: link ? (link.href || null) : null,
                text,
                media,
                inReplyToId: null,
                order: 0
              });
            }
          });
          const nodes = Array.from(nodesMap.values());
          nodes.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
          nodes.forEach((node, idx) => { node.order = idx; });
          if (nodes.length > 1) {
            return {
              status: 'ok',
              payload: {
                rootId: nodes[0].id,
                conversationId: null,
                nodes,
                source: 'background-script'
              }
            };
          }
          if (nodes.length && !bestNodes) {
            bestNodes = nodes;
          }
          await sleep(400);
        }
        if (bestNodes && bestNodes.length) {
          bestNodes.forEach((node, idx) => { node.order = idx; });
          return {
            status: 'ok',
            payload: {
              rootId: bestNodes[0].id,
              conversationId: null,
              nodes: bestNodes,
              source: 'background-script'
            }
          };
        }
        return { status: 'error', error: 'NO_TWEETS_FOUND' };
      },
      args: [tweetId]
    });
    if (executed && executed.length && executed[0].result && executed[0].result.status === 'ok') {
      return executed[0].result.payload;
    }
  } catch (error) {
    console.warn('[Twitter] executeScript capture failed:', error);
  }
  
  return null;
}

async function handleTwitterBackgroundScrape(message) {
  const { url, tweetId, requestUrl } = message;
  if (!url) {
    return { status: 'error', error: 'MISSING_URL' };
  }
  
  const cacheKey = tweetId || url;
  const cached = twitterThreadCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < TWITTER_THREAD_TTL) {
    return { status: 'ok', payload: cached.payload };
  }
  
  let tab = null;
  try {
    const tabUrl = requestUrl || url;
    tab = await chrome.tabs.create({ url: tabUrl, active: false });
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('TAB_CREATION_FAILED');
    }
    
    const tabId = tab.id;
    
    await waitForTabComplete(tabId, 18000);
    await delay(800);
    
    const payload = await captureTwitterThreadInTab(tabId, tweetId);
    
    if (payload && payload.nodes && payload.nodes.length) {
      console.log('[Twitter] Background capture nodes:', payload.nodes.length, 'source:', payload.source);
      twitterThreadCache.set(cacheKey, {
        payload,
        timestamp: Date.now()
      });
      return { status: 'ok', payload };
    }
    
    return { status: 'error', error: 'BACKGROUND_CAPTURE_FAILED' };
  } catch (error) {
    console.error('[Twitter] Background scrape failed:', error);
    return { status: 'error', error: error && error.message ? error.message : 'BACKGROUND_SCRAPE_FAILED' };
  } finally {
    if (tab && typeof tab.id === 'number') {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (e) {
        // ignore
      }
    }
  }
}

// Handle content summarization
async function handleSummarizeContent(message, sender) {
  const { url, title, textContent, html } = message;
  const tabId = sender?.tab?.id ?? null;
  
  console.log('[Background] Summarize request for:', url);
  
  const existingPageJob = getJob(activePageJobId);
  
  if (existingPageJob && existingPageJob.url === url) {
    console.log('[Background] Already processing this URL, ignoring duplicate');
    return { status: 'duplicate' };
  }
  
  if (existingPageJob && existingPageJob.url !== url) {
    console.log('[Background] Canceling previous processing for different URL');
    abortJob(existingPageJob.id, 'replaced_by_new_page_request');
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
  
  const job = createSummarizationJob({
    url,
    tabId,
    feature: 'page'
  });
  activePageJobId = job.id;
  
  // Notify displays that processing started
  broadcastProcessingStatus('started', title, job);
  
  try {
    const summary = await summarizeContent({ job, text: textContent, url });
    
    // Check if aborted
    if (job.signal.aborted) {
      console.log('[Background] Processing was aborted');
      return { status: 'aborted' };
    }
    
    // Cache the result
    summaryCache.set(cacheKey, {
      summary: summary,
      timestamp: Date.now()
    });
    
    console.log('[Background] Summarization complete and cached');
    
    return {
      status: 'complete',
      title: title,
      summary: summary,
      cached: false
    };
    
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('[Background] Summarization aborted for URL:', url);
      return { status: 'aborted' };
    }
    
    console.error('[Background] Summarization error:', error);
    return { status: 'error', error: error.message };
  } finally {
    finalizeJob(job.id);
  }
}

// Broadcast processing status
function broadcastProcessingStatus(status, title, job) {
  const message = {
    type: 'PROCESSING_STATUS',
    status: status,
    title: title,
    url: job ? job.url : null
  };
  
  // To side panel
  chrome.runtime.sendMessage(message).catch(() => {});
  
  // To content script
  if (job && typeof job.tabId === 'number') {
    chrome.tabs.sendMessage(job.tabId, message).catch(() => {});
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {});
      }
    });
  }
}

// ========================================
// REDDIT THREAD HELPERS
// ========================================

const REDDIT_COMMENT_LIMIT = 5;
const REDDIT_POST_CHAR_LIMIT = 1500;
const REDDIT_COMMENT_CHAR_LIMIT = 600;

function buildRedditApiUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    
    if (hostname === 'redd.it' || hostname.endsWith('.redd.it')) {
      const slug = parsed.pathname.replace(/\//g, '').trim();
      if (!slug) return null;
      const apiUrl = new URL(`/comments/${slug}.json`, 'https://www.reddit.com');
      apiUrl.searchParams.set('limit', '40');
      apiUrl.searchParams.set('depth', '2');
      apiUrl.searchParams.set('raw_json', '1');
      return { apiUrl: apiUrl.toString(), threadId: slug };
    }
    
    if (!hostname.endsWith('reddit.com')) {
      return null;
    }
    
    if (!/\/comments\/[a-z0-9]+/i.test(parsed.pathname)) {
      return null;
    }
    
    let normalizedPath = parsed.pathname;
    if (normalizedPath.endsWith('/')) {
      normalizedPath = normalizedPath.slice(0, -1);
    }
    if (normalizedPath.endsWith('.json')) {
      normalizedPath = normalizedPath.slice(0, -5);
    }
    
    const apiUrl = new URL(`${normalizedPath}.json`, 'https://www.reddit.com');
    apiUrl.searchParams.set('limit', '40');
    apiUrl.searchParams.set('depth', '2');
    apiUrl.searchParams.set('raw_json', '1');
    
    const idMatch = normalizedPath.match(/\/comments\/([a-z0-9]+)/i);
    const threadId = idMatch ? idMatch[1] : null;
    
    return { apiUrl: apiUrl.toString(), threadId };
  } catch (error) {
    console.warn('[Reddit] Failed to build API url:', error);
    return null;
  }
}

function normalizeRedditText(text) {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .trim();
}

function truncateText(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1).trimEnd() + '…';
}

function extractRedditThread(json) {
  if (!Array.isArray(json) || json.length === 0) {
    return null;
  }
  
  const postListing = json[0]?.data?.children?.find(child => child.kind === 't3');
  if (!postListing || !postListing.data) {
    return null;
  }
  
  const postData = postListing.data;
  const selftext = truncateText(normalizeRedditText(postData.selftext || ''), REDDIT_POST_CHAR_LIMIT);
  const commentListing = Array.isArray(json[1]?.data?.children) ? json[1].data.children : [];
  const comments = selectTopComments(commentListing, REDDIT_COMMENT_LIMIT);
  
  return {
    title: postData.title || 'Untitled Reddit Post',
    subreddit: postData.subreddit || '',
    author: postData.author || '',
    score: postData.score || 0,
    selftext,
    isSelf: !!postData.is_self,
    postUrl: postData.url_overridden_by_dest || postData.url || '',
    commentCount: postData.num_comments || commentListing.length,
    comments
  };
}

function selectTopComments(children, limit) {
  const comments = [];
  
  for (const child of children) {
    if (!child || child.kind !== 't1' || !child.data) {
      continue;
    }
    const data = child.data;
    if (!data.body || data.body === '[deleted]' || data.body === '[removed]') {
      continue;
    }
    
    const body = truncateText(normalizeRedditText(data.body), REDDIT_COMMENT_CHAR_LIMIT);
    if (!body) {
      continue;
    }
    
    comments.push({
      author: data.author || 'unknown',
      score: typeof data.score === 'number' ? data.score : 0,
      body
    });
  }
  
  comments.sort((a, b) => (b.score || 0) - (a.score || 0));
  return comments.slice(0, limit);
}

function buildRedditSummaryInput(thread) {
  const sections = [];
  sections.push('Summarize the following Reddit thread, focusing on the main viewpoints, consensus, and disagreements voiced in the top community comments.');
  sections.push(`Thread title: ${thread.title}`);
  
  const metaParts = [];
  if (thread.subreddit) metaParts.push(`Subreddit: r/${thread.subreddit}`);
  if (thread.author) metaParts.push(`Author: u/${thread.author}`);
  metaParts.push(`Upvotes: ${thread.score}`);
  metaParts.push(`Comments analyzed: ${thread.comments.length}/${thread.commentCount}`);
  sections.push(metaParts.join(' | '));
  
  if (thread.selftext) {
    sections.push('Original post:');
    sections.push(thread.selftext);
  } else if (!thread.isSelf && thread.postUrl) {
    sections.push(`Original post links to: ${thread.postUrl}`);
  }
  
  if (thread.comments.length) {
    sections.push('Top community comments:');
    thread.comments.forEach((comment, index) => {
      sections.push(`${index + 1}. u/${comment.author} (${comment.score} upvotes)\n${comment.body}`);
    });
  } else {
    sections.push('Top community comments: None available.');
  }
  
  return sections.join('\n\n');
}

async function handleSummarizeRedditPost(message, sender) {
  const { url } = message;
  
  console.log('[Reddit] Summarize request for:', url);
  
  const apiInfo = buildRedditApiUrl(url);
  if (!apiInfo) {
    return {
      status: 'error',
      error: 'INVALID_REDDIT_URL',
      message: 'Not a Reddit post link.'
    };
  }
  
  let redditJson;
  try {
    const response = await fetch(apiInfo.apiUrl, {
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    redditJson = await response.json();
  } catch (error) {
    console.error('[Reddit] Failed to fetch thread:', error);
    return {
      status: 'error',
      error: 'REDDIT_FETCH_FAILED',
      message: 'Could not retrieve Reddit thread data.'
    };
  }
  
  const thread = extractRedditThread(redditJson);
  if (!thread) {
    console.warn('[Reddit] No thread data extracted.');
    return {
      status: 'error',
      error: 'REDDIT_PARSE_FAILED',
      message: 'Unable to parse Reddit discussion.'
    };
  }
  
  console.log('[Reddit] Extracted', thread.comments.length, 'top comments for summarization');
  
  const summaryInput = buildRedditSummaryInput(thread);
  
  return await handleSummarizeContent({
    url: url,
    title: `Reddit: ${thread.title}`,
    textContent: summaryInput
  }, sender);
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

async function fetchYouTubeDescription(videoId, url) {
  const fallbackUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let targetUrl = fallbackUrl;
  
  if (url) {
    try {
      const parsed = new URL(url, 'https://www.youtube.com');
      if (parsed.hostname.includes('youtube.com')) {
        targetUrl = parsed.href;
      }
    } catch (error) {
      // Ignore malformed URL, fallback to default
    }
  }
  
  console.log('[YouTube] Fetching description from:', targetUrl);
  const response = await fetch(targetUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching description`);
  }
  const html = await response.text();
  const description = extractYouTubeDescriptionFromHtml(html);
  if (description) {
    console.log('[YouTube] Description fetched successfully. Length:', description.length);
  } else {
    console.warn('[YouTube] Description not found in fetched HTML.');
  }
  return description ? description.trim() : null;
}

function extractYouTubeDescriptionFromHtml(html) {
  if (!html) return null;
  
  const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\})\s*;/s);
  if (playerMatch) {
    try {
      const data = JSON.parse(playerMatch[1]);
      const desc = data?.videoDetails?.shortDescription;
      if (desc && desc.trim()) {
        return desc.trim();
      }
    } catch (error) {
      console.warn('[YouTube] Failed to parse ytInitialPlayerResponse:', error);
    }
  }
  
  const metaMatch = html.match(/<meta\s+(?:itemprop|name|property)=["']description["']\s+content=["']([^"']*)["']/i);
  if (metaMatch && metaMatch[1]) {
    return decodeHtmlEntities(metaMatch[1]);
  }
  
  const ogMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']*)["']/i);
  if (ogMatch && ogMatch[1]) {
    return decodeHtmlEntities(ogMatch[1]);
  }
  
  return null;
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '\r')
    .replace(/\u00a0/g, ' ');
}

function buildYouTubeSummarizationInput({ captionText, descriptionText, videoId }) {
  const MAX_TOTAL = 4000;
  const DESCRIPTION_LIMIT = 1000;
  const HEADER_OVERHEAD = 160;
  const MIN_CAPTION_LIMIT = 600;
  
  const metadata = {
    captionIncluded: !!captionText,
    descriptionIncluded: !!descriptionText,
    captionTruncated: false,
    descriptionTruncated: false,
    hardTruncated: false
  };
  
  const sections = [];
  sections.push(`Video ID: ${videoId}`);
  
  let descriptionSection = '';
  if (descriptionText && descriptionText.trim().length) {
    const normalizedDescription = normalizeWhitespace(descriptionText);
    if (normalizedDescription.length > DESCRIPTION_LIMIT) {
      descriptionSection = normalizedDescription.slice(0, DESCRIPTION_LIMIT - 1).trimEnd() + '…';
      metadata.descriptionTruncated = true;
    } else {
      descriptionSection = normalizedDescription;
    }
    sections.push('Description:\n' + descriptionSection);
  }
  
  let captionSection = '';
  if (captionText && captionText.trim().length) {
    const normalizedCaption = normalizeWhitespace(captionText);
    let captionLimit = MAX_TOTAL - HEADER_OVERHEAD - descriptionSection.length;
    captionLimit = Math.max(captionLimit, MIN_CAPTION_LIMIT);
    captionSection = clipTranscript(normalizedCaption, Math.min(captionLimit, MAX_TOTAL - HEADER_OVERHEAD));
    metadata.captionTruncated = normalizedCaption.length > captionSection.length;
    sections.push('Transcript:\n' + captionSection);
  }
  
  let combined = sections.join('\n\n').trim();
  if (combined.length > MAX_TOTAL) {
    if (captionSection) {
      const normalizedCaption = normalizeWhitespace(captionText);
      const available = MAX_TOTAL - (combined.length - captionSection.length) - HEADER_OVERHEAD;
      const nextLimit = Math.max(Math.min(available, captionSection.length), MIN_CAPTION_LIMIT);
      captionSection = clipTranscript(normalizedCaption, nextLimit);
      metadata.captionTruncated = true;
    }
    const newSections = [`Video ID: ${videoId}`];
    if (descriptionSection) {
      newSections.push('Description:\n' + descriptionSection);
    }
    if (captionSection) {
      newSections.push('Transcript:\n' + captionSection);
    }
    combined = newSections.join('\n\n').trim();
  }
  
  if (combined.length > MAX_TOTAL) {
    combined = combined.slice(0, MAX_TOTAL - 1).trimEnd() + '…';
    metadata.hardTruncated = true;
  }
  
  return {
    inputText: combined,
    metadata
  };
}

function normalizeWhitespace(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/[ \f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clipTranscript(text, limit) {
  if (!text) return '';
  if (text.length <= limit) {
    return text;
  }
  
  const partSize = Math.max(Math.floor(limit / 3), 200);
  const start = text.slice(0, partSize).trimEnd();
  const midStart = Math.max(Math.floor(text.length / 2 - partSize / 2), 0);
  const middle = text.slice(midStart, midStart + partSize).trim();
  const end = text.slice(-partSize).trimStart();
  
  let clipped = `${start}\n\n[...]\n\n${middle}\n\n[...]\n\n${end}`;
  if (clipped.length > limit) {
    clipped = clipped.slice(0, limit - 1).trimEnd() + '…';
  }
  return clipped;
}

/**
 * Handle YouTube caption summarization
 */
async function handleYouTubeSummary(videoId, url, tabId) {
  console.log('[YouTube] Handling summary request for:', videoId);
  
  const existingJobId = youtubeJobsByVideoId.get(videoId);
  const existingJob = existingJobId ? getJob(existingJobId) : null;
  if (existingJob) {
    console.log('[YouTube] Summary already in progress for:', videoId);
    return { status: 'streaming', videoId };
  }
  if (existingJobId && !existingJob) {
    youtubeJobsByVideoId.delete(videoId);
  }
  
  const activeJob = getJob(activeYouTubeJobId);
  if (activeJob && activeJob.metadata && activeJob.metadata.videoId && activeJob.metadata.videoId !== videoId) {
    console.log('[YouTube] Aborting previous video:', activeJob.metadata.videoId);
    abortJob(activeJob.id, 'youtube_video_switch');
  }
  
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
  
  const job = createSummarizationJob({
    url,
    tabId,
    feature: 'youtube',
    metadata: { videoId }
  });
  activeYouTubeJobId = job.id;
  youtubeJobsByVideoId.set(videoId, job.id);
  const signal = job.signal;
  
  try {
    // Check if captions are cached
    let captionData = youtubeCaptionCache.get(videoId);
    let descriptionData = youtubeDescriptionCache.get(videoId);
    
    if (!descriptionData) {
      descriptionData = await fetchYouTubeDescription(videoId, url).catch((error) => {
        console.warn('[YouTube] Description fetch failed:', error?.message || error);
        return null;
      });
      if (descriptionData) {
        youtubeDescriptionCache.set(videoId, {
          description: descriptionData,
          timestamp: Date.now()
        });
      }
    } else {
      descriptionData = descriptionData.description;
    }
    
    if (!captionData) {
      console.log('[YouTube] Captions not in cache, requesting from bridge...');
      
      let targetTabId = tabId;
      if (!targetTabId) {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tabs[0]) {
          throw new Error('No active tab found');
        }
        targetTabId = tabs[0].id;
      }
      
      const MAX_ATTEMPTS = 6;
      const RETRY_DELAY_MS = 500;
      
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !captionData; attempt++) {
        if (signal.aborted || !summarizationJobs.has(job.id)) {
          throw new DOMException('Aborted', 'AbortError');
        }
        
        try {
          const response = await chrome.tabs.sendMessage(targetTabId, {
            action: 'GET_YOUTUBE_CAPTIONS',
            videoId: videoId
          });
          
          if (response && response.success && response.data) {
            captionData = response.data;
            youtubeCaptionCache.set(videoId, {
              data: captionData,
              timestamp: captionData.timestamp || Date.now()
            });
            console.log('[YouTube] Captions received on attempt', attempt);
            break;
          }
          
          const error = response?.error || 'UNKNOWN_ERROR';
          console.log('[YouTube] Caption attempt', attempt, 'failed:', error);
          
          if (error !== 'NO_CAPTIONS' && error !== 'TIMEOUT') {
            throw new Error(error);
          }
        } catch (error) {
          if (error && error.message === 'NO_CAPTIONS') {
            console.log('[YouTube] Caption attempt', attempt, 'reported no captions yet.');
          } else if (error && error.message === 'No tab with id') {
            throw new Error('YouTube tab no longer available');
          } else {
            console.error('[YouTube] Error getting captions:', error);
            if (attempt === MAX_ATTEMPTS && !descriptionData) {
              return {
                status: 'error',
                error: 'NO_CAPTIONS',
                message: 'Could not retrieve captions for this video'
              };
            }
          }
        }
        
        if (!captionData && attempt < MAX_ATTEMPTS) {
          await delay(RETRY_DELAY_MS);
        }
      }
      
      if (!captionData) {
        console.warn('[YouTube] Failed to retrieve captions after retries');
        if (!descriptionData) {
          return {
            status: 'error',
            error: 'NO_CAPTIONS',
            message: 'Could not retrieve captions for this video'
          };
        }
      }
    } else {
      console.log('[YouTube] Using cached caption data');
      captionData = captionData.data;
    }
    
    const captionArray = captionData?.captions || [];
    const captionText = captionData?.text || captionsToText(captionArray);
    const descriptionText = descriptionData || '';
    
    if ((!captionText || captionText.length < 10) && (!descriptionText || descriptionText.length < 20)) {
      return {
        status: 'error',
        error: 'NO_CAPTIONS',
        message: 'No captions or description available for this video'
      };
    }
    
    console.log('[YouTube] Caption count:', captionArray.length);
    console.log('[YouTube] Caption text length:', captionText ? captionText.length : 0);
    console.log('[YouTube] Description length:', descriptionText ? descriptionText.length : 0);
    
    const { inputText: summarizationInput, metadata: summarizationMetadata } = buildYouTubeSummarizationInput({
      captionText,
      descriptionText,
      videoId
    });
    if (!summarizationInput || summarizationInput.length < 20) {
      return {
        status: 'error',
        error: 'NO_CAPTIONS',
        message: 'Not enough content to summarize'
      };
    }
    const previewSource = captionText && captionText.length ? captionText : descriptionText || '';
    console.log('[YouTube] Summarization input preview source:', previewSource.slice(0, 120));
    if (YOUTUBE_DEBUG_LOG_FULL_INPUT) {
      console.log('[YouTube] Summarization full input:', summarizationInput);
    } else {
      console.log('[YouTube] Summarization input sample (first 500 chars):', summarizationInput.slice(0, 500));
    }
    console.log('[YouTube] Summarization compression metadata:', summarizationMetadata);
    
    try {
      const summary = await summarizeContent({ job, text: summarizationInput, url });
      
      youtubeSummaryCache.set(videoId, {
        summary: summary,
        timestamp: Date.now()
      });
      
      console.log('[YouTube] Summary generated successfully. Length:', summary ? summary.length : 0);
      
      return {
        status: 'complete',
        cached: false,
        summary: summary,
        videoId: videoId,
        captionCount: captionArray.length,
        compression: summarizationMetadata,
        debugInputSnippet: summarizationInput.slice(0, 500),
        ...(YOUTUBE_DEBUG_LOG_FULL_INPUT ? { debugFullInput: summarizationInput } : {})
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        return {
          status: 'aborted',
          message: 'Summary cancelled (switched to different video)'
        };
      }
      throw error;
    }
  } catch (error) {
    console.error('[YouTube] Error generating summary:', error);
    return {
      status: 'error',
      error: 'SUMMARY_FAILED',
      message: error.message
    };
  } finally {
    finalizeJob(job.id);
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
  if (message.type === 'SCRAPE_TWITTER_THREAD') {
    handleTwitterBackgroundScrape(message)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('[Twitter] Background scrape handler error:', error);
        sendResponse({ status: 'error', error: error && error.message ? error.message : 'BACKGROUND_SCRAPE_FAILED' });
      });
    return true;
  }
  
  
  // Handle content summarization request
  if (message.type === 'SUMMARIZE_CONTENT') {
    handleSummarizeContent(message, sender)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (message.type === 'SUMMARIZE_REDDIT_POST') {
    handleSummarizeRedditPost(message, sender)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('[Reddit] Handler failure:', error);
        sendResponse({
          status: 'error',
          error: error?.message || 'Reddit summarization failed.'
        });
      });
    return true;
  }
  
  // Handle get API status
  if (message.type === 'GET_API_STATUS') {
    apiInitializationPromise.finally(() => {
      sendResponse({
        summarizer: SummarizerAPI.summarizer.status,
        promptAPI: SummarizerAPI.promptAPI.status
      });
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
    console.log('[Background] 🔴 ABORT MESSAGE RECEIVED!');
    console.log('[Background] Abort details:', {
      oldVideoId: message.videoId,
      newVideoId: message.newVideoId
    });
    
    const videoId = message.videoId;
    let targetJobId = null;
    
    if (videoId && youtubeJobsByVideoId.has(videoId)) {
      targetJobId = youtubeJobsByVideoId.get(videoId);
    } else if (activeYouTubeJobId) {
      targetJobId = activeYouTubeJobId;
    }
    
    const job = targetJobId ? getJob(targetJobId) : null;
    
    if (job) {
      abortJob(job.id, 'content_abort_request');
      sendResponse({ status: 'aborted', message: 'YouTube summary aborted' });
    } else {
      sendResponse({ status: 'idle', message: 'No active YouTube summary' });
    }
    
    return true; // Keep channel open
  }
  
  // Handle YouTube summary request
  if (message.action === 'GET_YOUTUBE_SUMMARY') {
    const videoId = message.videoId;
    const url = message.url;
    const tabId = sender?.tab?.id || message.tabId || null;
    
    console.log('[Background] YouTube summary requested for:', videoId);
    
    handleYouTubeSummary(videoId, url, tabId)
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

  // Relay gaze status to sidepanel
  if (message.type === 'GAZE_STATUS') {
    // Forward to all extension views (including sidepanel)
    chrome.runtime.sendMessage({
      type: 'GAZE_STATUS',
      phase: message.phase,
      note: message.note
    }).catch(() => {
      // Ignore errors if no receivers
    });
  }
});
