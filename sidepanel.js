// CRITICAL: Compatibility layer for different Chrome AI API versions
async function initializeSummarizerAPI() {
  // Check for Summarization API
  let summarizerAvailable = false;
  
  if ('Summarizer' in self) {
    console.log('Found global Summarizer API');
    summarizerAvailable = true;
  } else if ('ai' in self && 'summarizer' in self.ai) {
    console.log('Found ai.summarizer namespace');
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

// Cache for summaries
const summaryCache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// Debounce tracking
let isProcessingSummary = false;
let lastProcessedUrl = null;

// Abort controller for canceling streaming
let currentAbortController = null;

// === STATE MANAGEMENT ===
let settings = {
  apiChoice: 'summarization', // 'summarization' or 'prompt'
  customPrompt: 'Summarize this article in 2-3 sentences'
};

let currentContent = {
  title: '',
  fullContent: '',
  summary: ''
};

// === INITIALIZATION ===
document.addEventListener('DOMContentLoaded', async () => {
  console.log('Side panel ready');
  
  // CRITICAL: Initialize APIs first
  SummarizerAPI = await initializeSummarizerAPI();
  console.log('APIs initialized:', SummarizerAPI);
  
  // Check Summarizer availability once at startup
  if (SummarizerAPI.summarizer.available) {
    try {
      const summarizerAvailability = await SummarizerAPI.summarizer.availability();
      console.log('Summarizer availability:', summarizerAvailability);
      SummarizerAPI.summarizer.status = summarizerAvailability;
    } catch (error) {
      console.error('Summarizer availability check failed:', error);
      SummarizerAPI.summarizer.status = 'unavailable';
    }
  } else {
    SummarizerAPI.summarizer.status = 'unavailable';
  }
  
  // Check Prompt API availability once at startup
  if (SummarizerAPI.promptAPI.available) {
    try {
      // Pass output language to avoid warning
      const promptAvailability = await LanguageModel.availability({
        expectedOutputs: [{ type: 'text', languages: ['en'] }]
      });
      console.log('Prompt API availability:', promptAvailability);
      SummarizerAPI.promptAPI.status = promptAvailability;
      
      // If downloadable, inform user
      if (promptAvailability === 'downloadable') {
        console.warn('Prompt API model needs to be downloaded. User interaction required.');
      }
    } catch (error) {
      console.error('Prompt API availability check failed:', error);
      SummarizerAPI.promptAPI.status = 'unavailable';
    }
  } else {
    SummarizerAPI.promptAPI.status = 'unavailable';
  }
  
  // Load saved settings
  await loadSettings();
  
  // Set up event listeners
  setupEventListeners();
});

// === SETTINGS MANAGEMENT ===
async function loadSettings() {
  const stored = await chrome.storage.local.get(['apiChoice', 'customPrompt']);
  
  if (stored.apiChoice) {
    settings.apiChoice = stored.apiChoice;
  }
  if (stored.customPrompt) {
    settings.customPrompt = stored.customPrompt;
  }
  
  // Update UI
  document.getElementById('radio-' + settings.apiChoice).checked = true;
  document.getElementById('custom-prompt').value = settings.customPrompt;
  
  // Show/hide prompt textarea
  togglePromptContainer();
}

async function saveSettings() {
  await chrome.storage.local.set({
    apiChoice: settings.apiChoice,
    customPrompt: settings.customPrompt
  });
}

function togglePromptContainer() {
  const promptContainer = document.getElementById('prompt-container');
  if (settings.apiChoice === 'prompt') {
    promptContainer.classList.remove('hidden');
  } else {
    promptContainer.classList.add('hidden');
  }
}

function setupEventListeners() {
  // Radio button changes
  document.querySelectorAll('input[name="api-choice"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      settings.apiChoice = e.target.value;
      togglePromptContainer();
      saveSettings();
      
      // Clear cache when API choice changes
      summaryCache.clear();
    });
  });
  
  // Custom prompt changes
  document.getElementById('custom-prompt').addEventListener('input', (e) => {
    settings.customPrompt = e.target.value;
    saveSettings();
    
    // Clear cache when prompt changes
    summaryCache.clear();
  });
  
  // Toggle full content button
  document.getElementById('toggle-full-content').addEventListener('click', () => {
    const fullContentSection = document.getElementById('full-content-section');
    const btn = document.getElementById('toggle-full-content');
    
    if (fullContentSection.classList.contains('hidden')) {
      fullContentSection.classList.remove('hidden');
      btn.textContent = 'Hide Full Content';
    } else {
      fullContentSection.classList.add('hidden');
      btn.textContent = 'View Full Content';
    }
  });
  
  // Download Prompt API model button
  const downloadBtn = document.getElementById('download-model-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', downloadPromptAPIModel);
  }
}

// === MESSAGE HANDLING ===
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DISPLAY_CONTENT') {
    handleContent(message);
  }
});

async function handleContent(message) {
  // Check for fetch errors early
  if (message.data.error) {
    hideAllStates();
    showError(`Fetch error: ${message.data.error}`);
    return;
  }
  
  const url = message.data.url;
  
  // If we're already processing this SAME URL, ignore the duplicate hover
  if (isProcessingSummary && lastProcessedUrl === url) {
    console.log('Already processing this same URL, ignoring duplicate hover');
    return;
  }
  
  // If we're processing a DIFFERENT URL, cancel it
  if (currentAbortController && lastProcessedUrl !== url) {
    console.log('Canceling previous streaming for different URL...');
    currentAbortController.abort();
    currentAbortController = null;
    isProcessingSummary = false;
  }
  
  // Reset UI states
  hideAllStates();
  
  // Show extraction loading
  document.getElementById('loading-extract').classList.remove('hidden');
  
  try {
    // === STEP 1: Extract content ===
    const html = message.data.html;
    
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    const documentClone = doc.cloneNode(true);
    const reader = new Readability(documentClone);
    const article = reader.parse();
    
    let title, content, textContent;
    
    if (article && article.textContent && article.textContent.trim().length > 100) {
      title = article.title || 'Untitled';
      content = article.content || article.textContent;
      textContent = article.textContent;
    } else {
      // Fallback to meta description
      const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content') || 
                       doc.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
                       'No content could be extracted from this page.';
      
      title = doc.title || 'Untitled';
      content = `<p><em>No article content found.</em></p><p>${metaDesc}</p>`;
      textContent = metaDesc;
    }
    
    // Store for later use
    currentContent.title = title;
    currentContent.fullContent = content;
    
    // === STEP 2: Summarize content ===
    document.getElementById('loading-extract').classList.add('hidden');
    
    // Create cache key based on URL + settings
    const cacheKey = `${url}_${settings.apiChoice}_${settings.customPrompt}`;
    
    // Check cache FIRST
    const cached = summaryCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
      console.log('Using cached summary for:', url);
      currentContent.summary = cached.summary;
      displayContent(title, cached.summary, content);
      return;
    }
    
    // Create new abort controller for this request
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;
    
    isProcessingSummary = true;
    lastProcessedUrl = url;
    
    // Show loading state briefly
    document.getElementById('loading-summarize').classList.remove('hidden');
    
    // Give UI a moment to show loading, then start streaming
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Hide loading and show content area BEFORE streaming starts
    document.getElementById('loading-summarize').classList.add('hidden');
    document.getElementById('content-area').classList.remove('hidden');
    
    // Set title and full content immediately
    document.getElementById('title').textContent = title;
    document.getElementById('article-content').innerHTML = content;
    
    // Show "Generating..." in summary area
    document.getElementById('ai-summary').innerHTML = '<p style="opacity: 0.6;"><em>Generating summary...</em></p>';
    
    let summary;
    try {
      // This will update the UI in real-time via updateStreamingSummary()
      // Pass the abort signal to summarizeContent
      summary = await summarizeContent(textContent, signal);
      
      // Check if we were aborted
      if (signal.aborted) {
        console.log('Streaming was canceled, not caching partial result');
        return;
      }
      
      currentContent.summary = summary;
      
      // Only cache completed summaries
      summaryCache.set(cacheKey, {
        summary: summary,
        timestamp: Date.now()
      });
      
      console.log('Summary completed and cached');
      
    } catch (error) {
      // Check if error is due to abort
      if (error.name === 'AbortError') {
        console.log('Streaming aborted by user');
        return;
      }
      
      isProcessingSummary = false;
      currentAbortController = null;
      
      // Check if it's a model download error
      if (error.message === 'MODEL_DOWNLOAD_REQUIRED') {
        
        if (settings.apiChoice === 'prompt') {
          // Show download button for Prompt API
          hideAllStates();
          const modelDownload = document.getElementById('model-download');
          modelDownload.hidden = false;
          
          // Update message to show current article
          const messageEl = document.getElementById('model-download-message');
          if (messageEl) {
            messageEl.textContent = `Download the Prompt API model to summarize: "${title}"`;
          }
          
          return;
        } else {
          // Summarizer download instructions (manual)
          showErrorWithFallback(
            `Summarizer model needs to be downloaded. Go to chrome://components and click "Check for update" on "Optimization Guide On Device Model" (~2GB). Restart Chrome after download.`,
            title, 
            content
          );
          return;
        }
      }
      
      // Other AI errors, show error but continue with full content
      showErrorWithFallback(`AI Summarization failed: ${error.message}`, title, content);
      return;
    }
    
    // Streaming complete, final formatting already done
    isProcessingSummary = false;
    currentAbortController = null;
    
    // Log if HTML was cached
    if (message.cached) {
      console.log('Displayed content for:', url);
    }
    
  } catch (error) {
    showError(`Extraction error: ${error.message}`);
  }
}

// === AI SUMMARIZATION (Supports both APIs) ===
async function summarizeContent(text, signal) {
  if (settings.apiChoice === 'summarization') {
    return await useSummarizationAPI(text, signal);
  } else {
    return await usePromptAPI(text, signal);
  }
}

async function useSummarizationAPI(text, signal) {
  if (!SummarizerAPI.summarizer.available) {
    throw new Error('Summarizer API not available. Enable it in chrome://flags/#summarization-api-for-gemini-nano');
  }
  
  // Use cached availability status instead of checking again
  const availability = SummarizerAPI.summarizer.status;
  
  console.log('[Summarizer] Using cached status:', availability);
  
  // If model needs downloading, throw specific error
  if (availability === 'downloadable' || availability === 'downloading') {
    throw new Error('MODEL_DOWNLOAD_REQUIRED');
  }
  
  if (availability === 'unavailable') {
    throw new Error('Summarizer API is unavailable on this device');
  }
  
  // Both "available" and "readily" are valid ready states
  if (availability !== 'available' && availability !== 'readily') {
    throw new Error(`Summarizer API status is: ${availability}`);
  }
  
  try {
    // Create summarizer with options
    const options = {
      type: 'key-points', // Can be: 'key-points', 'tldr', 'teaser', 'headline'
      format: 'markdown',
      length: 'medium', // Can be: 'short', 'medium', 'long'
      sharedContext: 'This is an article from a webpage.',
      outputLanguage: 'en'
    };
    
    const summarizer = await SummarizerAPI.summarizer.create(options);
    
    // Prepare text (handle length limits)
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
    
    // Use STREAMING instead of batch
    console.log('[Summarizer] Starting streaming...');
    const stream = summarizer.summarizeStreaming(processedText);
    
    let fullSummary = '';
    let chunkCount = 0;
    for await (const chunk of stream) {
      // Check if aborted
      if (signal && signal.aborted) {
        console.log('[Summarizer] Streaming aborted');
        throw new DOMException('Aborted', 'AbortError');
      }
      
      chunkCount++;
      fullSummary += chunk;  // Accumulate chunks (each chunk is a token)
      updateStreamingSummary(fullSummary);
    }
    
    console.log('[Summarizer] Streaming complete, total chunks:', chunkCount);
    
    // Clean up
    if (summarizer.destroy) {
      summarizer.destroy();
    }
    
    return fullSummary;
    
  } catch (error) {
    console.error('Summarization failed:', error);
    throw error;
  }
}

async function usePromptAPI(text, signal) {
  // Check if Prompt API is available
  if (!SummarizerAPI.promptAPI.available) {
    throw new Error('Prompt API not available. Enable it in chrome://flags/#prompt-api-for-gemini-nano');
  }
  
  // Use cached availability status
  const availability = SummarizerAPI.promptAPI.status;
  
  console.log('[Prompt API] Using cached status:', availability);
  
  if (availability === 'unavailable') {
    throw new Error('Prompt API not available on this device');
  }
  
  if (availability === 'downloadable' || availability === 'downloading') {
    throw new Error('MODEL_DOWNLOAD_REQUIRED');
  }
  
  // Both "available" and "readily" are valid ready states
  if (availability !== 'available' && availability !== 'readily') {
    throw new Error(`Prompt API status is: ${availability}`);
  }
  
  try {
    // Get parameters
    const params = await SummarizerAPI.promptAPI.params();
    console.log('[Prompt API] Params:', params);
    
    // Create session with expectedOutputs
    const session = await SummarizerAPI.promptAPI.create({
      expectedOutputs: [
        { type: 'text', languages: ['en'] }
      ]
    });
    
    // Prepare text (handle length limits)
    const MAX_CHARS = 3000; // Leave room for prompt
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
    
    // Create full prompt
    const fullPrompt = `${settings.customPrompt}\n\nContent:\n${processedText}`;
    
    // Use STREAMING instead of batch
    console.log('[Prompt API] Starting streaming...');
    const stream = session.promptStreaming(fullPrompt);
    
    let fullSummary = '';
    let chunkCount = 0;
    for await (const chunk of stream) {
      // Check if aborted
      if (signal && signal.aborted) {
        console.log('[Prompt API] Streaming aborted');
        throw new DOMException('Aborted', 'AbortError');
      }
      
      chunkCount++;
      fullSummary += chunk;  // Accumulate chunks (each chunk is a token)
      updateStreamingSummary(fullSummary);
    }
    
    console.log('[Prompt API] Streaming complete, total chunks:', chunkCount);
    
    // Cleanup
    if (session.destroy) {
      session.destroy();
    }
    
    return fullSummary;
    
  } catch (error) {
    console.error('Prompt API failed:', error);
    throw error;
  }
}

// Download Prompt API model (requires user gesture)
let isDownloadingPromptModel = false;

async function downloadPromptAPIModel() {
  if (isDownloadingPromptModel) return;
  
  console.log('[Prompt API] Starting model download...');
  isDownloadingPromptModel = true;
  
  const downloadBtn = document.getElementById('download-model-btn');
  const downloadProgress = document.querySelector('#model-download .download-progress');
  
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'Downloading...';
  
  // Show progress bar
  if (downloadProgress) {
    downloadProgress.hidden = false;
  }
  
  // Initialize progress bar to 0%
  updatePromptDownloadProgress(0);
  
  try {
    // Get default params
    const params = await SummarizerAPI.promptAPI.params();
    console.log('[Prompt API] Params:', params);
    
    // Don't specify topK/temperature during download - use defaults
    const options = {
      expectedOutputs: [
        { type: 'text', languages: ['en'] }
      ],
      monitor: (m) => {
        console.log('[Prompt API] Monitor callback registered');
        m.addEventListener('downloadprogress', (e) => {
          const percent = Math.floor(e.loaded * 100);
          console.log(`[Prompt API] Download progress: ${percent}%`);
          updatePromptDownloadProgress(percent);
        });
      }
    };
    
    console.log('[Prompt API] Creating session to trigger download...');
    
    // Show warning if download takes too long
    const warningTimeout = setTimeout(() => {
      const progressText = downloadProgress?.querySelector('.progress-text');
      if (progressText && isDownloadingPromptModel) {
        progressText.textContent = 'Large download in progress... This may take 5-30 minutes depending on your connection';
      }
    }, 10000); // Show after 10 seconds
    
    // Create session (this triggers download)
    const session = await LanguageModel.create(options);
    
    clearTimeout(warningTimeout);
    
    // Wait for ready if needed
    if (session.ready) {
      await session.ready;
    }
    
    // Clean up test session
    if (session.destroy) {
      session.destroy();
    }
    
    console.log('[Prompt API] Model download complete!');
    isDownloadingPromptModel = false;
    
    // Update status
    SummarizerAPI.promptAPI.status = 'readily';
    
    // Hide download UI
    hideAllStates();
    document.getElementById('welcome').classList.remove('hidden');
    
    alert('Prompt API model downloaded successfully! You can now use custom prompts.');
    
  } catch (error) {
    console.error('[Prompt API] Model download failed:', error);
    isDownloadingPromptModel = false;
    downloadBtn.disabled = false;
    downloadBtn.textContent = 'Retry Download';
    
    const progressText = downloadProgress?.querySelector('.progress-text');
    if (progressText) {
      progressText.textContent = `Download failed: ${error.message}`;
    }
  }
}

function updatePromptDownloadProgress(percent) {
  console.log(`[updatePromptDownloadProgress] Called with ${percent}%`);
  
  const downloadProgress = document.querySelector('#model-download .download-progress');
  
  if (downloadProgress) {
    downloadProgress.hidden = false;
  }
  
  const progressFill = downloadProgress?.querySelector('.progress-fill');
  const progressText = downloadProgress?.querySelector('.progress-text');
  
  if (progressFill) {
    progressFill.style.width = `${percent}%`;
    console.log(`[updatePromptDownloadProgress] Progress bar width set to ${percent}%`);
  }
  
  if (progressText) {
    if (percent === 0) {
      progressText.textContent = 'Starting download...';
    } else if (percent < 100) {
      progressText.textContent = `Downloading Prompt API model... ${percent}% of ~2GB`;
    } else {
      progressText.textContent = 'Download complete! Initializing model...';
    }
  }
}

// === UI DISPLAY FUNCTIONS ===
function hideAllStates() {
  document.getElementById('loading-extract').classList.add('hidden');
  document.getElementById('loading-summarize').classList.add('hidden');
  document.getElementById('content-area').classList.add('hidden');
  document.getElementById('error').classList.add('hidden');
  document.getElementById('welcome').classList.add('hidden');
  
  // Also hide model download
  const modelDownload = document.getElementById('model-download');
  if (modelDownload) {
    modelDownload.hidden = true;
  }
  
  // Hide download progress if shown
  const downloadProgress = document.querySelector('#model-download .download-progress');
  if (downloadProgress) {
    downloadProgress.hidden = true;
  }
  
  // Reset full content toggle
  document.getElementById('full-content-section').classList.add('hidden');
  document.getElementById('toggle-full-content').textContent = 'View Full Content';
}

function displayContent(title, summary, fullContent) {
  document.getElementById('content-area').classList.remove('hidden');
  document.getElementById('title').textContent = title;
  
  // Format and display AI summary with proper HTML
  const formattedSummary = formatAISummary(summary);
  document.getElementById('ai-summary').innerHTML = formattedSummary;
  
  document.getElementById('article-content').innerHTML = fullContent;
}

function formatAISummary(text) {
  if (!text) return '';
  
  // First, escape any HTML to prevent XSS
  let formatted = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
  // Convert markdown-style formatting to HTML
  
  // Headers (must be done before other formatting)
  formatted = formatted
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>');
  
  // Bold text: **text** or __text__
  formatted = formatted
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>');
  
  // Italic text: *text* or _text_ (but not in middle of words)
  formatted = formatted
    .replace(/\*([^\*\s][^\*]*?[^\*\s])\*/g, '<em>$1</em>')
    .replace(/_([^_\s][^_]*?[^_\s])_/g, '<em>$1</em>');
  
  // Bullet points: lines starting with *, -, or •
  formatted = formatted
    .replace(/^[\*\-•] (.+)$/gm, '<li>$1</li>');
  
  // Numbered lists: lines starting with number and period
  formatted = formatted
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  
  // Wrap consecutive <li> items in <ul>
  formatted = formatted
    .replace(/(<li>.*?<\/li>\n?)+/g, (match) => {
      return '<ul>' + match + '</ul>';
    });
  
  // Convert double newlines to paragraphs
  formatted = formatted
    .replace(/\n\n+/g, '</p><p>');
  
  // Convert single newlines to <br>
  formatted = formatted
    .replace(/\n/g, '<br>');
  
  // Wrap in paragraph if not already wrapped
  if (!formatted.startsWith('<h') && !formatted.startsWith('<ul') && !formatted.startsWith('<p>')) {
    formatted = '<p>' + formatted;
  }
  if (!formatted.endsWith('</p>') && !formatted.endsWith('</ul>') && !formatted.endsWith('</h2>') && !formatted.endsWith('</h3>') && !formatted.endsWith('</h4>')) {
    formatted = formatted + '</p>';
  }
  
  // Clean up empty paragraphs
  formatted = formatted
    .replace(/<p><\/p>/g, '')
    .replace(/<p>\s*<\/p>/g, '');
  
  // Fix paragraphs around headers and lists
  formatted = formatted
    .replace(/<p>(<h\d>)/g, '$1')
    .replace(/(<\/h\d>)<\/p>/g, '$1')
    .replace(/<p>(<ul>)/g, '$1')
    .replace(/(<\/ul>)<\/p>/g, '$1');
  
  return formatted;
}

function updateStreamingSummary(partialText) {
  // Format the partial text
  const formatted = formatAISummary(partialText);
  
  // Update the summary display
  const summaryEl = document.getElementById('ai-summary');
  if (summaryEl) {
    summaryEl.innerHTML = formatted;
  }
}

function showError(errorMsg) {
  document.getElementById('loading-extract').classList.add('hidden');
  document.getElementById('loading-summarize').classList.add('hidden');
  document.getElementById('error').classList.remove('hidden');
  document.getElementById('error-message').textContent = errorMsg;
  document.getElementById('fallback-content').classList.add('hidden');
}

function showErrorWithFallback(errorMsg, title, content) {
  document.getElementById('loading-extract').classList.add('hidden');
  document.getElementById('loading-summarize').classList.add('hidden');
  document.getElementById('error').classList.remove('hidden');
  document.getElementById('error-message').textContent = errorMsg;
  
  // Show fallback content
  document.getElementById('fallback-content').classList.remove('hidden');
  document.getElementById('fallback-title').textContent = title;
  document.getElementById('fallback-article').innerHTML = content;
}
