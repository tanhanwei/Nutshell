/**
 * Debug Logger System for YouTube Integration Testing
 * Provides color-coded, filterable logging with export capabilities
 */

// Debug categories with colors and icons
const DEBUG_CATEGORIES = {
  YT_METHOD_1: { 
    enabled: true, 
    color: '#FF6B6B', 
    icon: '1️⃣',
    label: 'Method 1 (webRequest)' 
  },
  YT_METHOD_4: { 
    enabled: true, 
    color: '#4ECDC4', 
    icon: '4️⃣',
    label: 'Method 4 (Network Intercept)' 
  },
  YT_API: { 
    enabled: true, 
    color: '#45B7D1', 
    icon: '🔗',
    label: 'Direct API' 
  },
  YT_CACHE: { 
    enabled: true, 
    color: '#96CEB4', 
    icon: '💾',
    label: 'Caching' 
  },
  YT_SUMMARY: { 
    enabled: true, 
    color: '#FFEAA7', 
    icon: '📝',
    label: 'Summary Generation' 
  },
  YT_ERROR: { 
    enabled: true, 
    color: '#FF7675', 
    icon: '❌',
    label: 'Errors' 
  },
  YT_TEST: {
    enabled: true,
    color: '#A29BFE',
    icon: '🧪',
    label: 'Testing'
  },
  YT_HANDLER: {
    enabled: true,
    color: '#FD79A8',
    icon: '🔧',
    label: 'Handler System'
  }
};

// Log storage for export
const logHistory = [];
const MAX_LOG_HISTORY = 1000; // Keep last 1000 logs

// Statistics tracking
const stats = {
  method1: { attempts: 0, successes: 0, failures: 0 },
  method4: { attempts: 0, successes: 0, failures: 0 },
  directAPI: { attempts: 0, successes: 0, failures: 0 },
  cacheHits: 0,
  cacheMisses: 0,
  summaries: 0
};

/**
 * Main debug logging function
 * @param {string} category - Category from DEBUG_CATEGORIES
 * @param {string} message - Log message
 * @param {any} data - Optional data to log
 * @param {string} level - Log level: 'log', 'warn', 'error'
 */
function debugLog(category, message, data = null, level = 'log') {
  // Check if category exists and is enabled
  if (!DEBUG_CATEGORIES[category]) {
    console.warn(`[Debug Logger] Unknown category: ${category}`);
    return;
  }
  
  if (!DEBUG_CATEGORIES[category].enabled) {
    return; // Category is disabled
  }
  
  const { color, icon, label } = DEBUG_CATEGORIES[category];
  const timestamp = new Date().toISOString();
  
  // Format message
  const formattedMessage = `%c${icon} [${category}] ${message}`;
  const style = `color: ${color}; font-weight: bold;`;
  
  // Log to console
  if (data !== null) {
    console[level](formattedMessage, style, data);
  } else {
    console[level](formattedMessage, style);
  }
  
  // Store in history
  const logEntry = {
    timestamp,
    category,
    label,
    message,
    data: data ? JSON.parse(JSON.stringify(data, null, 2)) : null,
    level
  };
  
  logHistory.push(logEntry);
  
  // Trim history if too long
  if (logHistory.length > MAX_LOG_HISTORY) {
    logHistory.shift();
  }
  
  // Broadcast to debug panel if available
  broadcastToDebugPanel(logEntry);
}

/**
 * Enable/disable a debug category
 */
function toggleCategory(category, enabled) {
  if (DEBUG_CATEGORIES[category]) {
    DEBUG_CATEGORIES[category].enabled = enabled;
    debugLog('YT_TEST', `Category ${category} ${enabled ? 'enabled' : 'disabled'}`);
  }
}

/**
 * Enable/disable all categories
 */
function toggleAll(enabled) {
  Object.keys(DEBUG_CATEGORIES).forEach(category => {
    DEBUG_CATEGORIES[category].enabled = enabled;
  });
  console.log(`[Debug Logger] All categories ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Get current category states
 */
function getCategoryStates() {
  const states = {};
  Object.keys(DEBUG_CATEGORIES).forEach(category => {
    states[category] = {
      enabled: DEBUG_CATEGORIES[category].enabled,
      label: DEBUG_CATEGORIES[category].label
    };
  });
  return states;
}

/**
 * Record method attempt
 */
function recordMethodAttempt(method, success) {
  const methodKey = method.toLowerCase().replace(/\s+/g, '');
  
  if (stats[methodKey]) {
    stats[methodKey].attempts++;
    if (success) {
      stats[methodKey].successes++;
    } else {
      stats[methodKey].failures++;
    }
  }
  
  debugLog('YT_TEST', `Method ${method} attempt ${success ? 'succeeded' : 'failed'}`, {
    method,
    success,
    stats: stats[methodKey]
  });
}

/**
 * Record cache operation
 */
function recordCacheOperation(hit) {
  if (hit) {
    stats.cacheHits++;
  } else {
    stats.cacheMisses++;
  }
}

/**
 * Record summary generation
 */
function recordSummary() {
  stats.summaries++;
}

/**
 * Get statistics
 */
function getStats() {
  return {
    ...stats,
    method1SuccessRate: stats.method1.attempts > 0 
      ? (stats.method1.successes / stats.method1.attempts * 100).toFixed(1) + '%'
      : 'N/A',
    method4SuccessRate: stats.method4.attempts > 0
      ? (stats.method4.successes / stats.method4.attempts * 100).toFixed(1) + '%'
      : 'N/A',
    directAPISuccessRate: stats.directAPI.attempts > 0
      ? (stats.directAPI.successes / stats.directAPI.attempts * 100).toFixed(1) + '%'
      : 'N/A',
    cacheHitRate: (stats.cacheHits + stats.cacheMisses) > 0
      ? (stats.cacheHits / (stats.cacheHits + stats.cacheMisses) * 100).toFixed(1) + '%'
      : 'N/A'
  };
}

/**
 * Reset statistics
 */
function resetStats() {
  stats.method1 = { attempts: 0, successes: 0, failures: 0 };
  stats.method4 = { attempts: 0, successes: 0, failures: 0 };
  stats.directAPI = { attempts: 0, successes: 0, failures: 0 };
  stats.cacheHits = 0;
  stats.cacheMisses = 0;
  stats.summaries = 0;
  debugLog('YT_TEST', 'Statistics reset');
}

/**
 * Export logs as JSON
 */
function exportLogs(format = 'json') {
  const exportData = {
    exportTime: new Date().toISOString(),
    stats: getStats(),
    categoryStates: getCategoryStates(),
    logs: logHistory
  };
  
  if (format === 'json') {
    return JSON.stringify(exportData, null, 2);
  } else if (format === 'csv') {
    // Convert to CSV
    let csv = 'Timestamp,Category,Message,Level\n';
    logHistory.forEach(log => {
      const message = log.message.replace(/"/g, '""'); // Escape quotes
      csv += `"${log.timestamp}","${log.category}","${message}","${log.level}"\n`;
    });
    return csv;
  }
  
  return exportData;
}

/**
 * Download logs as file
 */
function downloadLogs(format = 'json') {
  const data = exportLogs(format);
  const blob = new Blob([data], { 
    type: format === 'json' ? 'application/json' : 'text/csv' 
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `youtube-debug-logs-${Date.now()}.${format}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  debugLog('YT_TEST', `Logs downloaded as ${format}`, { 
    logCount: logHistory.length 
  });
}

/**
 * Get recent logs
 */
function getRecentLogs(count = 50, category = null) {
  let logs = logHistory;
  
  if (category) {
    logs = logs.filter(log => log.category === category);
  }
  
  return logs.slice(-count);
}

/**
 * Clear log history
 */
function clearLogs() {
  logHistory.length = 0;
  debugLog('YT_TEST', 'Log history cleared');
}

/**
 * Broadcast log to debug panel (if open)
 */
function broadcastToDebugPanel(logEntry) {
  // Send message to extension parts that might have debug panel open
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.sendMessage({
      action: 'DEBUG_LOG',
      log: logEntry
    }).catch(() => {
      // Ignore errors if no listener
    });
  }
}

/**
 * Pretty print object for logging
 */
function prettyPrint(obj, maxDepth = 3) {
  try {
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'function') {
        return '[Function]';
      }
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack
        };
      }
      return value;
    }, 2);
  } catch (e) {
    return '[Object could not be serialized]';
  }
}

/**
 * Helper: Log method 1 events
 */
const logMethod1 = {
  attempt: (videoId) => debugLog('YT_METHOD_1', `Attempting to capture for video: ${videoId}`),
  success: (videoId, captionCount) => {
    recordMethodAttempt('method1', true);
    debugLog('YT_METHOD_1', `✅ Captured ${captionCount} captions for ${videoId}`);
  },
  failure: (videoId, error) => {
    recordMethodAttempt('method1', false);
    debugLog('YT_METHOD_1', `❌ Failed for ${videoId}: ${error}`, null, 'error');
  }
};

/**
 * Helper: Log method 4 events
 */
const logMethod4 = {
  attempt: (videoId) => debugLog('YT_METHOD_4', `Attempting to capture for video: ${videoId}`),
  success: (videoId, captionCount) => {
    recordMethodAttempt('method4', true);
    debugLog('YT_METHOD_4', `✅ Captured ${captionCount} captions for ${videoId}`);
  },
  failure: (videoId, error) => {
    recordMethodAttempt('method4', false);
    debugLog('YT_METHOD_4', `❌ Failed for ${videoId}: ${error}`, null, 'error');
  },
  intercept: (url) => debugLog('YT_METHOD_4', `Intercepted request: ${url.substring(0, 80)}...`)
};

/**
 * Helper: Log direct API events
 */
const logAPI = {
  attempt: (videoId) => debugLog('YT_API', `Fetching captions for video: ${videoId}`),
  success: (videoId, captionCount) => {
    recordMethodAttempt('directAPI', true);
    debugLog('YT_API', `✅ Fetched ${captionCount} captions for ${videoId}`);
  },
  failure: (videoId, error) => {
    recordMethodAttempt('directAPI', false);
    debugLog('YT_API', `❌ Failed for ${videoId}: ${error}`, null, 'error');
  }
};

/**
 * Helper: Log cache events
 */
const logCache = {
  hit: (key) => {
    recordCacheOperation(true);
    debugLog('YT_CACHE', `✅ Cache HIT for ${key}`);
  },
  miss: (key) => {
    recordCacheOperation(false);
    debugLog('YT_CACHE', `❌ Cache MISS for ${key}`);
  },
  set: (key, size) => debugLog('YT_CACHE', `💾 Cached: ${key} (${size} bytes)`),
  clear: () => debugLog('YT_CACHE', '🗑️ Cache cleared')
};

/**
 * Helper: Log summary events
 */
const logSummary = {
  start: (contentType) => debugLog('YT_SUMMARY', `Starting summary generation for ${contentType}`),
  streaming: (contentType, length) => debugLog('YT_SUMMARY', `Streaming update: ${length} chars`),
  complete: (contentType, length) => {
    recordSummary();
    debugLog('YT_SUMMARY', `✅ Summary complete: ${length} chars for ${contentType}`);
  },
  error: (error) => debugLog('YT_SUMMARY', `❌ Summary failed: ${error}`, null, 'error')
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    debugLog,
    toggleCategory,
    toggleAll,
    getCategoryStates,
    recordMethodAttempt,
    recordCacheOperation,
    recordSummary,
    getStats,
    resetStats,
    exportLogs,
    downloadLogs,
    getRecentLogs,
    clearLogs,
    prettyPrint,
    // Helpers
    logMethod1,
    logMethod4,
    logAPI,
    logCache,
    logSummary,
    // Constants
    DEBUG_CATEGORIES
  };
}

// Make available globally for browser console testing
if (typeof window !== 'undefined') {
  window.YouTubeDebugLogger = {
    debugLog,
    toggleCategory,
    toggleAll,
    getCategoryStates,
    getStats,
    resetStats,
    exportLogs,
    downloadLogs,
    getRecentLogs,
    clearLogs,
    // Helpers
    logMethod1,
    logMethod4,
    logAPI,
    logCache,
    logSummary
  };
  
  console.log('%c🧪 YouTube Debug Logger Loaded', 'color: #A29BFE; font-weight: bold; font-size: 14px;');
  console.log('%cAvailable in window.YouTubeDebugLogger', 'color: #A29BFE;');
  console.log('%cTry: YouTubeDebugLogger.getStats()', 'color: #A29BFE;');
}

