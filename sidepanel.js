// ========================================
// SIDEPANEL - DISPLAY ONLY (No AI Logic)
// ========================================

// State
let settings = {
  apiChoice: 'summarization',
  customPrompt: 'Summarize this article in 2-3 sentences',
  displayMode: 'panel',
  gazeEnabled: false,
  gazeDwellMs: 600
};

let currentContent = {
  title: '',
  fullContent: '',
  summary: ''
};

// DOM elements
const elements = {};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[Sidepanel] DOMContentLoaded fired');
  
  try {
    // Get DOM elements
    elements.welcome = document.getElementById('welcome');
    elements.loadingExtract = document.getElementById('loading-extract');
    elements.loadingSummarize = document.getElementById('loading-summarize');
    elements.contentArea = document.getElementById('content-area');
    elements.error = document.getElementById('error');
    elements.title = document.getElementById('title');
    elements.aiSummary = document.getElementById('ai-summary');
    elements.articleContent = document.getElementById('article-content');
    elements.toggleBtn = document.getElementById('toggle-full-content');
    elements.fullContentSection = document.getElementById('full-content-section');
    
    // Settings
    elements.radioSummarization = document.getElementById('radio-summarization');
    elements.radioPrompt = document.getElementById('radio-prompt');
    elements.customPrompt = document.getElementById('custom-prompt');
    elements.promptContainer = document.getElementById('prompt-container');
    elements.displayMode = document.getElementById('display-mode');

    // Gaze controls
    elements.gazeEnabled = document.getElementById('gaze-enabled');
    elements.gazeStatusDot = document.getElementById('gaze-status-dot');
    elements.gazeStatusText = document.getElementById('gaze-status-text');
    elements.calibrateBtn = document.getElementById('calibrate-btn');
    elements.dwellTime = document.getElementById('dwell-time');
    elements.dwellValue = document.getElementById('dwell-value');
    
    console.log('[Sidepanel] DOM elements retrieved:', {
      displayMode: elements.displayMode,
      radioSummarization: elements.radioSummarization,
      customPrompt: elements.customPrompt
    });
    
    // Load settings
    await loadSettings();
    console.log('[Sidepanel] Settings loaded');
    
    // Setup listeners
    setupEventListeners();
    console.log('[Sidepanel] Event listeners set up');
    
    // Show welcome
    showWelcome();
    console.log('[Sidepanel] Welcome shown');
    
    // Get API status from background
    try {
      const status = await chrome.runtime.sendMessage({ type: 'GET_API_STATUS' });
      console.log('[Sidepanel] API status:', status);
    } catch (e) {
      console.error('[Sidepanel] Failed to get API status:', e);
    }
    
    console.log('[Sidepanel] Initialization complete');
  } catch (error) {
    console.error('[Sidepanel] Initialization error:', error);
  }
});

// Load settings
async function loadSettings() {
  const stored = await chrome.storage.local.get(['apiChoice', 'customPrompt', 'displayMode', 'gazeEnabled', 'gazeDwellMs']);

  if (stored.apiChoice) settings.apiChoice = stored.apiChoice;
  if (stored.customPrompt) settings.customPrompt = stored.customPrompt;
  if (stored.displayMode) settings.displayMode = stored.displayMode;
  if (typeof stored.gazeEnabled === 'boolean') settings.gazeEnabled = stored.gazeEnabled;
  if (typeof stored.gazeDwellMs === 'number') settings.gazeDwellMs = stored.gazeDwellMs;

  // Update UI
  if (elements.radioSummarization && elements.radioPrompt) {
    if (settings.apiChoice === 'summarization') {
      elements.radioSummarization.checked = true;
    } else {
      elements.radioPrompt.checked = true;
    }
  }

  if (elements.customPrompt) {
    elements.customPrompt.value = settings.customPrompt;
  }

  if (elements.displayMode) {
    elements.displayMode.value = settings.displayMode;
  }

  if (elements.gazeEnabled) {
    elements.gazeEnabled.checked = settings.gazeEnabled;
  }

  if (elements.dwellTime) {
    elements.dwellTime.value = settings.gazeDwellMs;
  }

  if (elements.dwellValue) {
    elements.dwellValue.textContent = settings.gazeDwellMs;
  }

  // Update calibrate button disabled state
  if (elements.calibrateBtn) {
    elements.calibrateBtn.disabled = !settings.gazeEnabled;
  }

  // Update initial status based on gazeEnabled
  if (!settings.gazeEnabled) {
    updateGazeStatus('ready', 'Enable to start');
  }

  togglePromptContainer();
}

// Save settings
async function saveSettings() {
  await chrome.storage.local.set({
    apiChoice: settings.apiChoice,
    customPrompt: settings.customPrompt,
    displayMode: settings.displayMode,
    gazeEnabled: settings.gazeEnabled,
    gazeDwellMs: settings.gazeDwellMs
  });
}

// Setup event listeners
function setupEventListeners() {
  // API choice
  document.querySelectorAll('input[name="api-choice"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      settings.apiChoice = e.target.value;
      togglePromptContainer();
      saveSettings();
    });
  });
  
  // Custom prompt
  if (elements.customPrompt) {
    elements.customPrompt.addEventListener('input', (e) => {
      settings.customPrompt = e.target.value;
      saveSettings();
    });
  }
  
  // Display mode
  if (elements.displayMode) {
    elements.displayMode.addEventListener('change', (e) => {
      settings.displayMode = e.target.value;
      saveSettings();
      
      // Notify content script
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'DISPLAY_MODE_CHANGED',
            displayMode: settings.displayMode
          }).catch(() => {
            // Ignore errors if content script not ready
          });
        }
      });
    });
  }
  
  // Toggle full content
  if (elements.toggleBtn) {
    elements.toggleBtn.addEventListener('click', () => {
      if (elements.fullContentSection.classList.contains('hidden')) {
        elements.fullContentSection.classList.remove('hidden');
        elements.toggleBtn.textContent = 'Hide Full Content';
      } else {
        elements.fullContentSection.classList.add('hidden');
        elements.toggleBtn.textContent = 'View Full Content';
      }
    });
  }

  // Gaze enabled toggle
  if (elements.gazeEnabled) {
    elements.gazeEnabled.addEventListener('change', async (e) => {
      settings.gazeEnabled = e.target.checked;
      saveSettings();

      // Update calibrate button disabled state
      if (elements.calibrateBtn) {
        elements.calibrateBtn.disabled = !settings.gazeEnabled;
      }

      // Update status text immediately to prevent race conditions
      if (!settings.gazeEnabled) {
        updateGazeStatus('ready', 'Disabled');
      } else {
        updateGazeStatus('loading', 'Initializing...');

        // When enabling, check if content scripts are loaded
        // If not, refresh the page to inject them
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
          if (tabs[0]) {
            try {
              // Try to ping the content script
              await chrome.tabs.sendMessage(tabs[0].id, { type: 'PING' });
              console.log('[Sidepanel] Content script already loaded');
            } catch (error) {
              // Content script not loaded, refresh the page
              console.log('[Sidepanel] Content script not loaded, refreshing page...');
              updateGazeStatus('loading', 'Refreshing page...');
              setTimeout(() => {
                chrome.tabs.reload(tabs[0].id);
              }, 300);
            }
          }
        });
      }

      console.log('[Sidepanel] Gaze tracking toggled:', settings.gazeEnabled);
    });
  }

  // Calibrate button
  if (elements.calibrateBtn) {
    elements.calibrateBtn.addEventListener('click', () => {
      console.log('[Sidepanel] Calibrate button clicked');

      // Blur the button to prevent SPACE from re-clicking it
      elements.calibrateBtn.blur();

      // Send message to active tab to trigger calibration
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'TRIGGER_CALIBRATION'
          }).catch((error) => {
            console.error('[Sidepanel] Failed to trigger calibration:', error);
          });
        }
      });
    });
  }

  // Dwell time slider
  if (elements.dwellTime) {
    elements.dwellTime.addEventListener('input', (e) => {
      const value = parseInt(e.target.value, 10);
      settings.gazeDwellMs = value;
      if (elements.dwellValue) {
        elements.dwellValue.textContent = value;
      }
      saveSettings();
      console.log('[Sidepanel] Dwell time updated:', value);
    });
  }
}

// Toggle prompt container
function togglePromptContainer() {
  if (elements.promptContainer) {
    if (settings.apiChoice === 'prompt') {
      elements.promptContainer.classList.remove('hidden');
    } else {
      elements.promptContainer.classList.add('hidden');
    }
  }
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'STREAMING_UPDATE') {
    if (settings.displayMode === 'panel' || settings.displayMode === 'both') {
      updateSummaryDisplay(message.content);
    }
  }

  if (message.type === 'PROCESSING_STATUS') {
    if (message.status === 'started') {
      showProcessing(message.title);
    }
  }

  if (message.type === 'DISPLAY_CACHED_SUMMARY') {
    if (settings.displayMode === 'panel' || settings.displayMode === 'both') {
      displayCachedSummary(message.title, message.summary);
    }
  }

  if (message.type === 'GAZE_STATUS') {
    updateGazeStatus(message.phase, message.note);
  }
});

// Update gaze status indicator
function updateGazeStatus(phase, note) {
  if (!elements.gazeStatusDot || !elements.gazeStatusText) {
    return;
  }

  // Remove all status classes
  elements.gazeStatusDot.className = 'status-dot';

  // Check if disabled based on note
  if (note && note.toLowerCase().includes('disabled')) {
    elements.gazeStatusText.textContent = 'Disabled';
    return;
  }

  // Map phase to status
  const statusMap = {
    'loading': { class: 'loading', text: 'Loading models...' },
    'ready': { class: 'ready', text: note || 'Ready to calibrate' },
    'live': { class: 'live', text: note || 'Active & tracking' },
    'calibrating': { class: 'loading', text: 'Calibrating...' }
  };

  const status = statusMap[phase] || { class: '', text: note || 'Unknown' };

  if (status.class) {
    elements.gazeStatusDot.classList.add(status.class);
  }
  elements.gazeStatusText.textContent = status.text;
}

// Show states
function hideAll() {
  // Hide content states, but NOT settings elements
  const elementsToHide = [
    elements.welcome,
    elements.loadingExtract,
    elements.loadingSummarize,
    elements.contentArea,
    elements.error
  ];
  
  elementsToHide.forEach(el => {
    if (el && el.classList) {
      el.classList.add('hidden');
    }
  });
}

function showWelcome() {
  hideAll();
  if (elements.welcome) {
    elements.welcome.classList.remove('hidden');
  }
}

function showProcessing(title) {
  if (settings.displayMode === 'tooltip') return; // Don't show in panel if tooltip-only
  
  hideAll();
  if (elements.loadingExtract) {
    elements.loadingExtract.classList.remove('hidden');
  }
  
  // After brief moment, show summarizing state
  setTimeout(() => {
    if (elements.loadingExtract) {
      elements.loadingExtract.classList.add('hidden');
    }
    if (elements.loadingSummarize) {
      elements.loadingSummarize.classList.remove('hidden');
    }
  }, 500);
}

function updateSummaryDisplay(formattedContent) {
  if (settings.displayMode === 'tooltip') return;
  
  // Show content area if hidden
  if (elements.contentArea && elements.contentArea.classList.contains('hidden')) {
    hideAll();
    elements.contentArea.classList.remove('hidden');
  }
  
  // Update summary
  if (elements.aiSummary) {
    elements.aiSummary.innerHTML = formattedContent;
  }
}

function displayCachedSummary(title, formattedSummary) {
  hideAll();
  
  if (elements.contentArea) {
    elements.contentArea.classList.remove('hidden');
  }
  
  if (elements.title) {
    elements.title.textContent = title;
  }
  
  if (elements.aiSummary) {
    elements.aiSummary.innerHTML = formattedSummary;
  }
}

console.log('[Sidepanel] Script loaded');