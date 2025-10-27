/**
 * YouTube Caption Handler (Production)
 * Injects into YouTube.com to capture captions via XHR interception
 */

(function() {
  'use strict';
  function _cs_buildClientInfo(innertubeConfig) {
    const context = innertubeConfig.context || {};
    const client = context.client || {};
    return {
      client: {
        ...client,
        clientName: client.clientName || innertubeConfig.clientName || 'WEB',
        clientVersion: client.clientVersion || innertubeConfig.clientVersion || '2.20250101.01.00',
        visitorData: client.visitorData || innertubeConfig.visitorData || null,
      },
    };
  }

  function _cs_buildTranscriptContext(innertubeConfig, clientInfo) {
    const contextClone = JSON.parse(JSON.stringify(innertubeConfig.context || {}));
    contextClone.client = clientInfo.client;
    contextClone.user = contextClone.user || { lockedSafetyMode: false };
    contextClone.request = contextClone.request || { useSsl: true };
    return contextClone;
  }

  function _cs_buildTranscriptHeaders(innertubeConfig, clientInfo, authHeader) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'Origin': 'https://www.youtube.com',
    };
    const clientNameMap = { WEB: 1, MWEB: 2, ANDROID: 3, IOS: 5 };
    const clientName = (clientInfo.client.clientName || 'WEB').toUpperCase();
    headers['X-Youtube-Client-Name'] = String(clientNameMap[clientName] || 1);
    headers['X-Youtube-Client-Version'] = clientInfo.client.clientVersion;
    if (clientInfo.client.visitorData) {
      headers['X-Goog-Visitor-Id'] = clientInfo.client.visitorData;
    }
    return headers;
  }

  function _cs_parseTranscriptResponse(json) {
    if (!json || !json.actions) {
      console.error('[CS Parser] Invalid JSON or no actions found.');
      return null;
    }

    const cues = [];
    const action = json.actions.find(a => a.updateEngagementPanelAction);

    if (!action) {
      console.error('[CS Parser] Could not find updateEngagementPanelAction.');
      return null;
    }

    try {
      const segments = action.updateEngagementPanelAction.content.transcriptRenderer
        .content.transcriptSearchPanelRenderer.body
        .transcriptSegmentListRenderer.initialSegments;

      for (const seg of segments) {
        const segmentRenderer = seg.transcriptSegmentRenderer;
        if (segmentRenderer && segmentRenderer.snippet && segmentRenderer.snippet.runs) {
          const text = segmentRenderer.snippet.runs.map(r => r.text).join(' ');
          const start = parseInt(segmentRenderer.startMs, 10) / 1000;
          if (text) {
            cues.push({ text, start });
          }
        }
      }
    } catch (e) {
      console.error('[CS Parser] Failed to navigate new JSON structure:', e);
      return null;
    }

    return cues.length > 0 ? cues : null;
  }
  
  // Only run on YouTube
  if (!window.location.hostname.includes('youtube.com')) {
    return;
  }
  
  console.log('[YouTube Handler] Initializing caption handler...');
  
  // Store captured captions
  const captionCache = new Map(); // videoId -> {captions, timestamp}
  const videoChannelIdCache = new Map(); // videoId -> channelId
  const videoTranscriptParamsCache = new Map(); // videoId -> transcript params
  const transcriptMetadataCache = new Map(); // videoId -> { params, source, clickTrackingParams, path, timestamp }
  const transcriptFailureSet = new Set();
  const transcriptPrefetchPromises = new Map();
  const knownVideoIds = new Set();
  const MIN_TRANSCRIPT_PARAM_LENGTH = 100;
  const ENABLE_TIMEDTEXT_FALLBACK = true;

  try {
    const initialVideoId = window.ytInitialPlayerResponse?.videoDetails?.videoId || null;
    const initialChannelId = window.ytInitialPlayerResponse?.videoDetails?.channelId || null;
    if (initialVideoId) {
      recordVideoId(initialVideoId);
      if (initialChannelId) {
        recordChannelId(initialVideoId, initialChannelId);
      }
      const initialTracks = window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      for (const track of initialTracks) {
        if (track && typeof track.params === 'string') {
          storeTranscriptParams(initialVideoId, track.params);
        }
      }
    }
    if (window.ytInitialData) {
      scanNodeForMetadata(window.ytInitialData, initialVideoId, 0);
    }
  } catch (initError) {
    console.warn('[YouTube Handler] Metadata initialization failed:', initError);
  }
  
  // Helper: Extract video ID from URL
  function extractVideoId(url) {
    if (!url) return null;
    
    const patterns = [
      /[?&]v=([^&\n?#]+)/,
      /\/vi\/([^\/]+)/,
      /\/vi_webp\/([^\/]+)/,
      /youtu\.be\/([^&\n?#]+)/,
      /\/embed\/([^&\n?#]+)/,
      /\/shorts\/([^&\n?#]+)/
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  }
  
  function sanitizeCaptionResponse(data) {
    if (typeof data !== 'string') {
      return data;
    }
    let trimmed = data;
    if (typeof trimmed.trimStart === 'function') {
      trimmed = trimmed.trimStart();
    }
    if (trimmed.startsWith(")]}'")) {
      const newlineIndex = trimmed.indexOf('\n');
      trimmed = newlineIndex === -1 ? '' : trimmed.slice(newlineIndex + 1);
    }
    return trimmed.trim();
  }
  
  // Helper: Parse captions from API response
  function parseCaptions(data) {
    try {
      if (typeof data === 'string') {
        const sanitized = sanitizeCaptionResponse(data);
        
        // Try JSON3 format (newer YouTube format)
        if (sanitized.includes('"events"')) {
          try {
            const json = JSON.parse(sanitized);
            if (Array.isArray(json.events)) {
              const captions = [];
              for (const event of json.events) {
                if (!event) continue;
                const segments = Array.isArray(event.segs) ? event.segs : [];
                if (segments.length) {
                  const text = segments.map(seg => (seg && typeof seg.utf8 === 'string') ? seg.utf8 : '').join('');
                  captions.push({
                    start: (event.tStartMs || 0) / 1000,
                    duration: (event.dDurationMs || 0) / 1000,
                    text
                  });
                }
              }
              if (captions.length) {
                return captions;
              }
            }
          } catch (jsonError) {
            console.warn('[YouTube Handler] JSON caption parse failed, trying XML fallback:', jsonError?.message || jsonError);
          }
        }
        
        // Try XML format (older YouTube format)
        if (sanitized.includes('<text ')) {
          const parser = new DOMParser();
          const xml = parser.parseFromString(sanitized, 'text/xml');
          const texts = xml.getElementsByTagName('text');
          if (texts && texts.length) {
            return Array.from(texts).map(node => ({
              start: parseFloat(node.getAttribute('start')) || 0,
              duration: parseFloat(node.getAttribute('dur')) || 0,
              text: node.textContent || ''
            }));
          }
        }
      } else if (data && typeof data === 'object') {
        const events = data.events || data;
        if (Array.isArray(events)) {
          return events
            .map(event => {
              if (!event) return null;
              const segments = Array.isArray(event.segs) ? event.segs : [];
              if (!segments.length) return null;
              const text = segments.map(seg => (seg && typeof seg.utf8 === 'string') ? seg.utf8 : '').join('');
              return {
                start: (event.tStartMs || 0) / 1000,
                duration: (event.dDurationMs || 0) / 1000,
                text
              };
            })
            .filter(Boolean);
        }
      }
    } catch (e) {
      console.error('[YouTube Handler] Parse error:', e);
    }
    return [];
  }
  
  // Helper: Convert captions to plain text
  function captionsToText(captions) {
    if (!Array.isArray(captions) || captions.length === 0) {
      return '';
    }
    return captions.map(c => c.text).join(' ').trim();
  }

  const textEncoder = new TextEncoder();

  function encodeVarint(value) {
    const bytes = [];
    let v = value >>> 0;
    while (v > 0x7f) {
      bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(v);
    return Uint8Array.from(bytes);
  }

  function encodeFieldKey(fieldNumber, wireType) {
    return Uint8Array.from([(fieldNumber << 3) | wireType]);
  }

  function encodeLengthDelimited(fieldNumber, data) {
    const key = encodeFieldKey(fieldNumber, 2);
    const length = encodeVarint(data.length);
    return concatUint8Arrays([key, length, data]);
  }

  function base64UrlEncode(bytes, stripPadding) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    let base64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
    if (stripPadding) {
      base64 = base64.replace(/=+$/, '');
    }
    return base64;
  }

  function concatUint8Arrays(arrays) {
    let totalLength = 0;
    for (const arr of arrays) {
      totalLength += arr.length;
    }
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
      merged.set(arr, offset);
      offset += arr.length;
    }
    return merged;
  }

  function publishMetadataUpdate(videoId) {
    if (!videoId) return;
    const metadata = transcriptMetadataCache.get(videoId) || null;
    const storedParam = metadata?.params || videoTranscriptParamsCache.get(videoId) || null;
    const payload = {
      type: 'YT_METADATA_UPDATE',
      videoId,
      channelId: videoChannelIdCache.get(videoId) || null,
      transcriptParams: storedParam,
      transcriptLength: storedParam ? storedParam.length : 0,
      transcriptSource: metadata?.source || null
    };
    try {
      window.postMessage(payload, '*');
    } catch (error) {
      console.warn('[YouTube Handler] Failed to post metadata update:', error);
    }
  }

  function recordVideoId(videoId) {
    if (!videoId) return;
    knownVideoIds.add(videoId);
  }

  function recordChannelId(videoId, channelId) {
    if (!videoId || !channelId) return;
    recordVideoId(videoId);
    const current = videoChannelIdCache.get(videoId);
    if (current === channelId) return;
    videoChannelIdCache.set(videoId, channelId);
    publishMetadataUpdate(videoId);
  }

  function extractChannelIdFromRenderer(renderer, videoId) {
    if (!renderer || !videoId || typeof renderer !== 'object') return;
    const directId = renderer.channelId || renderer.ownerChannelId;
    if (typeof directId === 'string' && directId.startsWith('UC')) {
      recordChannelId(videoId, directId);
      return;
    }
    const runSources = [
      renderer.shortBylineText?.runs,
      renderer.longBylineText?.runs,
      renderer.ownerText?.runs,
      renderer.bylineText?.runs
    ];
    for (const runs of runSources) {
      if (!Array.isArray(runs)) continue;
      for (const run of runs) {
        const browseId = run?.navigationEndpoint?.browseEndpoint?.browseId;
        if (browseId && browseId.startsWith && browseId.startsWith('UC')) {
          recordChannelId(videoId, browseId);
          return;
        }
      }
    }
  }

  function getChannelIdForVideo(videoId) {
    if (!videoId) return null;
    recordVideoId(videoId);
    if (videoChannelIdCache.has(videoId)) {
      return videoChannelIdCache.get(videoId);
    }
    const playerVideoId = window.ytInitialPlayerResponse?.videoDetails?.videoId;
    const playerChannelId = window.ytInitialPlayerResponse?.videoDetails?.channelId;
    if (playerVideoId && playerChannelId) {
      recordChannelId(playerVideoId, playerChannelId);
    }
    try {
      if (window.ytInitialData && videoChannelIdCache.size < 400) {
        scanNodeForMetadata(window.ytInitialData, null, 0);
      }
    } catch (error) {
      console.warn('[YouTube Handler] Failed to scan initial data for channel IDs:', error);
    }
    return videoChannelIdCache.get(videoId) || null;
  }

  function buildTranscriptParams(videoId, channelId, isAutoGenerated) {
    if (!videoId || !channelId) return null;
    const trackKind = isAutoGenerated ? 1 : 0;
    const innerParts = [];
    innerParts.push(encodeLengthDelimited(1, textEncoder.encode(videoId)));
    innerParts.push(encodeLengthDelimited(2, textEncoder.encode(channelId)));
    innerParts.push(concatUint8Arrays([encodeFieldKey(3, 0), encodeVarint(trackKind)]));
    const innerMessage = concatUint8Arrays(innerParts);
    const outerMessage = encodeLengthDelimited(1, innerMessage);
    const single = base64UrlEncode(outerMessage, false);
    const singleBytes = textEncoder.encode(single);
    const double = base64UrlEncode(singleBytes, false);
    return double;
  }

  function getInnertubeConfig() {
    try {
      const cfg = window.ytcfg;
      if (!cfg || typeof cfg.get !== 'function') {
        return null;
      }
      const apiKey = cfg.get('INNERTUBE_API_KEY');
      const context = cfg.get('INNERTUBE_CONTEXT');
      const clientName = cfg.get('INNERTUBE_CONTEXT_CLIENT_NAME') || cfg.get('INNERTUBE_CLIENT_NAME');
      const clientVersion = cfg.get('INNERTUBE_CONTEXT_CLIENT_VERSION') || cfg.get('INNERTUBE_CLIENT_VERSION');
      const visitorData = cfg.get('VISITOR_DATA');
      const signatureTimestamp = cfg.get('STS');
      if (!apiKey || !context || !clientName || !clientVersion) {
        return null;
      }
      return {
        apiKey,
        context,
        clientName,
        clientVersion,
        visitorData,
        signatureTimestamp
      };
    } catch (error) {
      console.warn('[YouTube Handler] Failed to extract Innertube config:', error);
      return null;
    }
  }

  function sortCaptionTracks(tracks) {
    if (!Array.isArray(tracks)) return [];
    const preferredLangs = ['en-US', 'en-GB', 'en-CA', 'en'];
    const getScore = (track) => {
      const code = (track.languageCode || '').toLowerCase();
      const preferredIndex = preferredLangs.findIndex((lang) => code.startsWith(lang.toLowerCase()));
      const autoPenalty = track.kind === 'asr' ? 1 : 0;
      const indexScore = preferredIndex >= 0 ? preferredIndex : preferredLangs.length + 1;
      return indexScore * 10 + autoPenalty;
    };
    return tracks.slice().sort((a, b) => getScore(a) - getScore(b));
  }

  function extractTranscriptParams(track) {
    if (!track) return null;
    if (track.params) return track.params;
    try {
      if (track.baseUrl) {
        const url = new URL(track.baseUrl, window.location.origin);
        const paramsValue = url.searchParams.get('params');
        if (paramsValue) return paramsValue;
      }
    } catch (error) {
      console.warn('[YouTube Handler] Failed to extract transcript params:', error?.message || error);
    }
    return null;
  }

  function parseTranscriptResponse(json) {
    if (!json) return null;
    const actions = json.actions || json.responseContext?.actions;
    const pools = Array.isArray(actions) ? actions : json?.actions;
    if (!Array.isArray(pools)) {
      return null;
    }
    const cues = [];
    for (const action of pools) {
      const transcript = action?.updateTranscriptAction?.transcript;
      const cueGroups = transcript?.body?.transcriptBodyRenderer?.cueGroups;
      if (!Array.isArray(cueGroups)) continue;
      for (const group of cueGroups) {
        const cueGroup = group?.transcriptCueGroupRenderer;
        if (!cueGroup || !Array.isArray(cueGroup.cues)) continue;
        for (const cueEntry of cueGroup.cues) {
          const cueRenderer = cueEntry?.transcriptCueRenderer;
          if (!cueRenderer) continue;
          const startMs = parseInt(cueRenderer.startOffsetMs, 10) || 0;
          const durationMs = parseInt(cueRenderer.durationMs, 10) || 0;
          let text = '';
          const cue = cueRenderer.cue;
          if (!cue) continue;
          if (typeof cue.simpleText === 'string') {
            text = cue.simpleText;
          } else if (Array.isArray(cue.runs)) {
            text = cue.runs.map(run => run?.text || '').join('');
          }
          text = (text || '').trim();
          if (text) {
            cues.push({
              start: startMs / 1000,
              duration: durationMs / 1000,
              text
            });
          }
        }
      }
    }
    return cues.length ? cues : null;
  }

  async function fetchCaptionsViaTranscriptApi(videoId, track, channelId) {
    const config = getInnertubeConfig();
    if (!config) {
      throw new Error('NO_CONFIG');
    }

    let paramsSource = 'cache';
    if (track && typeof track.params === 'string' && track.params.length >= MIN_TRANSCRIPT_PARAM_LENGTH) {
      storeTranscriptMetadata(videoId, {
        params: track.params,
        source: 'track'
      });
      paramsSource = 'track';
    }

    let metadata = transcriptMetadataCache.get(videoId);
    let paramsValue = metadata?.params || null;

    if (!paramsValue || paramsValue.length < MIN_TRANSCRIPT_PARAM_LENGTH) {
      const cacheValue = videoTranscriptParamsCache.get(videoId);
      if (cacheValue && cacheValue.length >= MIN_TRANSCRIPT_PARAM_LENGTH) {
        paramsValue = cacheValue;
        paramsSource = metadata?.source || 'cache';
      }
    }

    if (!paramsValue || paramsValue.length < MIN_TRANSCRIPT_PARAM_LENGTH) {
      const prefetchResult = await ensureTranscriptToken(videoId);
      if (prefetchResult.success) {
        metadata = transcriptMetadataCache.get(videoId);
        paramsValue = metadata?.params || videoTranscriptParamsCache.get(videoId) || null;
        paramsSource = metadata?.source || prefetchResult.source || 'cache';
      }
    }

    if (!paramsValue || paramsValue.length < MIN_TRANSCRIPT_PARAM_LENGTH) {
      throw new Error('NO_PARAMS');
    }

    metadata = transcriptMetadataCache.get(videoId) || storeTranscriptMetadata(videoId, {
      params: paramsValue,
      source: paramsSource
    });

    const clientBundle = buildClientInfo(config, metadata || {});
    const paramsLength = paramsValue.length;
    console.log('[YouTube Handler] Transcript API params', {
      videoId,
      source: paramsSource,
      length: paramsLength
    });
    const endpoint = `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`;
    const contextPayload = buildTranscriptContext(config, clientBundle);
    const body = {
      context: contextPayload,
      params: paramsValue
    };
    const headers = buildTranscriptHeaders(clientBundle);
    console.log('[YouTube Handler] Transcript request context', {
      videoId,
      clientName: clientBundle.client.clientName,
      clientVersion: clientBundle.client.clientVersion,
      hl: clientBundle.client.hl,
      gl: clientBundle.client.gl,
      clickTracking: clientBundle.clickTrackingParams ? 'present' : 'missing',
      visitorData: clientBundle.visitorData ? 'present' : 'missing'
    });
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        console.warn('[YouTube Handler] Transcript API failed', {
          videoId,
          status: response.status,
          statusText: response.statusText
        });
        throw new Error(`TRANSCRIPT_HTTP_${response.status}`);
      }
      const json = await response.json();
      const topLevelKeys = json && typeof json === 'object' ? Object.keys(json) : [];
      console.log('[YouTube Handler] Transcript API response summary', {
        videoId,
        status: response.status,
        keys: topLevelKeys,
        actionCount: Array.isArray(json?.actions) ? json.actions.length : 0
      });
      const parsed = parseTranscriptResponse(json);
      if (parsed && parsed.length) {
        const effectiveChannelId = channelId || getChannelIdForVideo(videoId) || null;
        console.log('[YouTube Handler] Transcript API returned', parsed.length, 'cues for', videoId);
        return {
          videoId,
          captions: parsed,
          text: captionsToText(parsed),
          raw: json,
          track: {
            languageCode: track.languageCode || null,
            name: track.name?.simpleText || null,
            isAutoGenerated: track.kind === 'asr'
          },
          source: 'transcriptApi',
          params: paramsValue,
          channelId: effectiveChannelId
        };
      }
      throw new Error('TRANSCRIPT_EMPTY');
    } catch (error) {
      console.warn('[YouTube Handler] Transcript API failed:', error?.message || error);
      throw error;
    }
  }

  function buildClientInfo(config, overrides = {}) {
    config = config || getInnertubeConfig();
    const getYtCfg = (key) => {
      try {
        return typeof window !== 'undefined' && window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg.get(key) : null;
      } catch (error) {
        return null;
      }
    };

    const contextSource = config?.context || getYtCfg('INNERTUBE_CONTEXT') || {};
    const baseContext = JSON.parse(JSON.stringify(contextSource));
    const contextClient = baseContext.client = baseContext.client || {};

    if (overrides.clickTrackingParams) {
      baseContext.clickTracking = Object.assign({}, baseContext.clickTracking || {}, {
        clickTrackingParams: overrides.clickTrackingParams
      });
    }

    const resolvedClientName = contextClient.clientName || overrides.clientName || config?.clientName || 'WEB';
    if (!contextClient.clientName && resolvedClientName) {
      contextClient.clientName = resolvedClientName;
    }

    const resolvedClientVersion = contextClient.clientVersion || overrides.clientVersion || config?.clientVersion || null;
    if (!contextClient.clientVersion && resolvedClientVersion) {
      contextClient.clientVersion = resolvedClientVersion;
    }

    const visitorData = contextClient.visitorData || config?.visitorData || getYtCfg('VISITOR_DATA') || null;
    if (!contextClient.visitorData && visitorData) {
      contextClient.visitorData = visitorData;
    }

    const clientNameValue = contextClient.clientName || resolvedClientName;
    let clientNameNumeric = null;
    if (typeof config?.clientName === 'number') {
      clientNameNumeric = config.clientName;
    } else if (typeof config?.clientName === 'string' && config.clientName.trim() !== '' && !Number.isNaN(Number(config.clientName))) {
      clientNameNumeric = Number(config.clientName);
    } else {
      const map = { WEB: 1, ANDROID: 3, IOS: 5 };
      clientNameNumeric = map[(clientNameValue || '').toUpperCase()] || 1;
    }

    const timeZone = contextClient.timeZone || ((typeof Intl !== 'undefined' && Intl.DateTimeFormat) ? (Intl.DateTimeFormat().resolvedOptions().timeZone || null) : null);
    if (!contextClient.timeZone && timeZone) {
      contextClient.timeZone = timeZone;
    }

    const utcOffsetMinutes = -new Date().getTimezoneOffset();
    const clickTrackingParams = baseContext.clickTracking?.clickTrackingParams || null;

    return {
      client: contextClient,
      rawContext: baseContext,
      clientVersion: contextClient.clientVersion || resolvedClientVersion || null,
      clientNameNumeric,
      visitorData,
      clickTrackingParams,
      pageCl: getYtCfg('PAGE_CL') || null,
      pageLabel: getYtCfg('PAGE_BUILD_LABEL') || getYtCfg('PAGE_BUILD_VERSION') || null,
      timeZone,
      utcOffsetMinutes
    };
  }

  function buildTranscriptContext(config, clientBundle) {
    const contextClone = JSON.parse(JSON.stringify(
      clientBundle?.rawContext ||
      config?.context ||
      (typeof window !== 'undefined' && window.ytcfg && typeof window.ytcfg.get === 'function' ? window.ytcfg.get('INNERTUBE_CONTEXT') : {}) ||
      {}
    ));
    if (clientBundle?.clickTrackingParams) {
      contextClone.clickTracking = Object.assign({}, contextClone.clickTracking || {}, {
        clickTrackingParams: clientBundle.clickTrackingParams
      });
    }
    contextClone.user = contextClone.user || { lockedSafetyMode: false };
    contextClone.request = contextClone.request || { useSsl: true };
    return contextClone;
  }

  function buildTranscriptHeaders(clientBundle) {
    const clientVersionHeader = clientBundle.clientVersion || clientBundle.client?.clientVersion || '2.20251020.01.00';
    const headers = {
      'content-type': 'application/json',
      'x-youtube-client-name': String(clientBundle.clientNameNumeric || 1),
      'x-youtube-client-version': clientVersionHeader
    };
    if (clientBundle.visitorData) {
      headers['x-goog-visitor-id'] = clientBundle.visitorData;
    }
    headers['x-origin'] = 'https://www.youtube.com';
    if (typeof clientBundle.utcOffsetMinutes === 'number' && !Number.isNaN(clientBundle.utcOffsetMinutes)) {
      headers['x-youtube-utc-offset'] = String(clientBundle.utcOffsetMinutes);
    }
    if (clientBundle.timeZone) {
      headers['x-youtube-time-zone'] = clientBundle.timeZone;
    }
    if (clientBundle.pageCl) {
      headers['x-youtube-page-cl'] = String(clientBundle.pageCl);
    }
    if (clientBundle.pageLabel) {
      headers['x-youtube-page-label'] = String(clientBundle.pageLabel);
    }
    return headers;
  }

  function extractJsonFromHtml(html, marker) {
    if (!html || !marker) return null;
    const patterns = [
      `${marker} =`,
      `${marker}=`,
      `\"${marker}\"\\s*=`,
      `${marker}\"\\s*=`
    ];
    for (const pattern of patterns) {
      const idx = html.indexOf(pattern);
      if (idx === -1) continue;
      const start = html.indexOf('{', idx);
      if (start === -1) continue;
      let depth = 0;
      for (let i = start; i < html.length; i++) {
        const char = html[i];
        if (char === '{') {
          depth += 1;
        } else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            const jsonString = html.slice(start, i + 1);
            try {
              return JSON.parse(jsonString);
            } catch (error) {
              console.warn('[YouTube Handler] Failed to parse JSON from HTML for marker', marker, error);
              return null;
            }
          }
        }
      }
    }
    return null;
  }

  async function fetchTranscriptParamsViaNext(videoId, config, clientBundle) {
    const apiKey = config?.apiKey || window.ytcfg?.get?.('INNERTUBE_API_KEY');
    if (!apiKey) {
      console.warn('[YouTube Handler] Prefetch via next skipped - no API key');
      return null;
    }
    const url = `https://www.youtube.com/youtubei/v1/next?key=${encodeURIComponent(apiKey)}&prettyPrint=false`;
    const body = {
      context: buildTranscriptContext(config, clientBundle),
      videoId
    };
    const headers = buildTranscriptHeaders(clientBundle);
    try {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        console.warn('[YouTube Handler] Prefetch via next failed', response.status, response.statusText);
        return null;
      }
      const json = await response.json();
      const meta = extractTranscriptMetadataFromObject(json, 'next');
      if (meta && meta.params) {
        meta.source = 'next';
        return meta;
      }
    } catch (error) {
      console.warn('[YouTube Handler] Prefetch via next error:', error?.message || error);
    }
    return null;
  }

  async function fetchTranscriptParamsViaPlayer(videoId, config, clientBundle) {
    const apiKey = config?.apiKey || window.ytcfg?.get?.('INNERTUBE_API_KEY');
    if (!apiKey) {
      console.warn('[YouTube Handler] Prefetch via player skipped - no API key');
      return null;
    }
    const url = `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`;
    const body = {
      context: buildTranscriptContext(config, clientBundle),
      videoId,
      playbackContext: {
        contentPlaybackContext: {
          vis: 0,
          splay: false,
          html5Preference: 'HTML5_PREF_WANTS'
        }
      },
      racyCheckOk: true,
      contentCheckOk: true
    };
    const headers = buildTranscriptHeaders(clientBundle);
    try {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        console.warn('[YouTube Handler] Prefetch via player failed', response.status, response.statusText);
        return null;
      }
      const json = await response.json();
      const meta = extractTranscriptMetadataFromObject(json, 'player');
      if (meta && meta.params) {
        meta.source = 'player';
        return meta;
      }
    } catch (error) {
      console.warn('[YouTube Handler] Prefetch via player error:', error?.message || error);
    }
    return null;
  }

  async function fetchTranscriptParamsViaWatchHtml(videoId, clientBundle) {
    const hl = clientBundle.client.hl || 'en';
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=${encodeURIComponent(hl)}`;
    const headers = {
      'x-youtube-client-name': String(clientBundle.clientNameNumeric || 1),
      'x-youtube-client-version': clientBundle.clientVersion,
      ...(clientBundle.visitorData ? { 'x-goog-visitor-id': clientBundle.visitorData } : {})
    };
    try {
      const response = await fetch(url, {
        headers,
        credentials: 'include'
      });
      if (!response.ok) {
        console.warn('[YouTube Handler] Prefetch via watch-html failed', response.status, response.statusText);
        return null;
      }
      const html = await response.text();
      const data = extractJsonFromHtml(html, 'ytInitialData');
      if (data) {
        const meta = extractTranscriptMetadataFromObject(data, 'watch_html.ytInitialData');
        if (meta && meta.params) {
          meta.source = 'watch-html';
          return meta;
        }
      }
      const playerData = extractJsonFromHtml(html, 'ytInitialPlayerResponse');
      if (playerData) {
        const meta = extractTranscriptMetadataFromObject(playerData, 'watch_html.ytInitialPlayerResponse');
        if (meta && meta.params) {
          meta.source = 'watch-html-player';
          return meta;
        }
      }
    } catch (error) {
      console.warn('[YouTube Handler] Prefetch via watch-html error:', error?.message || error);
    }
    return null;
  }

  async function ensureTranscriptToken(videoId, options = {}) {
    if (!videoId) {
      return { success: false, error: 'NO_VIDEO_ID' };
    }

    const cached = transcriptMetadataCache.get(videoId);
    if (cached?.params && cached.params.length >= MIN_TRANSCRIPT_PARAM_LENGTH) {
      storeTranscriptMetadata(videoId, cached);
      console.log('[YouTube] Transcript token ready', {
        videoId,
        source: cached.source || 'cache',
        length: cached.params.length
      });
      return { success: true, source: cached.source || 'cache', length: cached.params.length };
    }

    transcriptFailureSet.delete(videoId);

    if (transcriptPrefetchPromises.has(videoId)) {
      return transcriptPrefetchPromises.get(videoId);
    }

    const promise = (async () => {
      const config = getInnertubeConfig();
      const strategies = [
        { name: 'next', fn: fetchTranscriptParamsViaNext },
        { name: 'player', fn: fetchTranscriptParamsViaPlayer },
        { name: 'watch-html', fn: fetchTranscriptParamsViaWatchHtml }
      ];

      for (const strategy of strategies) {
        console.log(`[YouTube] Prefetching transcript params via: ${strategy.name}`, { videoId });
        const bundle = buildClientInfo(config, transcriptMetadataCache.get(videoId) || {});
        let result = null;
        try {
          if (strategy.fn.length === 3) {
            result = await strategy.fn(videoId, config, bundle);
          } else {
            result = await strategy.fn(videoId, bundle);
          }
        } catch (error) {
          console.warn(`[YouTube Handler] Prefetch via ${strategy.name} threw`, error?.message || error);
        }

          if (result && result.params && result.params.length >= MIN_TRANSCRIPT_PARAM_LENGTH) {
            const stored = storeTranscriptMetadata(videoId, Object.assign({}, result, { source: strategy.name }));
            if (stored?.params) {
              console.log('[YouTube] Transcript token ready', {
                videoId,
                source: strategy.name,
                length: stored.params.length,
                path: result.path || null
              });
            return { success: true, source: strategy.name, length: stored.params.length };
          }
        }
      }

      console.warn('[YouTube] No transcript token found after next/player/watch-html for', videoId);
      markTranscriptFailure(videoId);
      return { success: false, error: 'NO_PARAMS' };
    })()
      .finally(() => {
        transcriptPrefetchPromises.delete(videoId);
      });

    transcriptPrefetchPromises.set(videoId, promise);
    return promise;
  }

  function buildTrackCandidateUrls(track) {
    if (!track || !track.baseUrl) return [];
    
    const baseUrl = track.baseUrl;
    let url;
    try {
      url = new URL(baseUrl, window.location.origin);
    } catch (error) {
      console.warn('[YouTube Handler] Invalid track URL:', baseUrl, error?.message || error);
      return [];
    }
    
    const baseFmt = url.searchParams.get('fmt');
    const baseKind = url.searchParams.get('kind');
    const candidates = [];
    const seen = new Set();
    
    function addCandidate(fmt, kind) {
      try {
        const candidateUrl = new URL(baseUrl, window.location.origin);
        if (fmt === undefined) {
          // leave original
        } else if (fmt === null) {
          candidateUrl.searchParams.delete('fmt');
        } else {
          candidateUrl.searchParams.set('fmt', fmt);
        }
        if (kind === undefined) {
          // leave original
        } else if (kind === null) {
          candidateUrl.searchParams.delete('kind');
        } else {
          candidateUrl.searchParams.set('kind', kind);
        }
        const finalUrl = candidateUrl.toString();
        if (!seen.has(finalUrl)) {
          seen.add(finalUrl);
          candidates.push({
            url: finalUrl,
            fmt: fmt === undefined ? baseFmt : fmt,
            kind: kind === undefined ? baseKind : kind
          });
        }
      } catch (error) {
        console.warn('[YouTube Handler] Failed to build caption URL variant:', error?.message || error);
      }
    }
    
    addCandidate(undefined, undefined); // original
    if (baseFmt !== 'json3') addCandidate('json3', undefined);
    if (baseFmt !== 'srv3') addCandidate('srv3', undefined);
    if (track.kind === 'asr' && baseKind !== 'asr') {
      addCandidate(undefined, 'asr');
      if (baseFmt !== 'json3') addCandidate('json3', 'asr');
      if (baseFmt !== 'srv3') addCandidate('srv3', 'asr');
    }
    
    return candidates;
  }
  
  async function fetchCaptionTrack(track, videoId, channelId) {
    if (!track || !track.baseUrl) {
      throw new Error('NO_TRACK_URL');
    }
    if (videoId && channelId) {
      recordChannelId(videoId, channelId);
    }
    if (hasTranscriptFailure(videoId)) {
      throw new Error('NO_PARAMS');
    }

    const transcriptAttemptErrors = [];
    let transcriptResult = null;
    try {
      transcriptResult = await fetchCaptionsViaTranscriptApi(videoId, track, channelId);
    } catch (transcriptError) {
      const errorMessage = transcriptError?.message || String(transcriptError);
      if (errorMessage === 'NO_PARAMS') {
        console.warn('[YouTube Handler] Transcript params missing for track', {
          videoId,
          hasParamsProperty: !!track.params,
          baseUrlSample: typeof track.baseUrl === 'string' ? track.baseUrl.slice(0, 160) : null,
          vssId: track.vssId || null,
          languageCode: track.languageCode || null,
          kind: track.kind || null
        });
        markTranscriptFailure(videoId);
      }
      console.warn('[YouTube Handler] Transcript fetch failed', {
        videoId,
        trackLanguage: track?.languageCode || null,
        trackKind: track?.kind || null,
        error: errorMessage,
        stack: transcriptError?.stack || null
      });
      transcriptAttemptErrors.push(errorMessage || 'TRANSCRIPT_FAILED');
    }

    if (transcriptResult && transcriptResult.captions && transcriptResult.captions.length) {
      return transcriptResult;
    }

    const attemptErrors = [];

    if (!ENABLE_TIMEDTEXT_FALLBACK) {
      const errMessage = transcriptAttemptErrors[0] || 'NO_CAPTIONS';
      throw new Error(errMessage);
    }

    const candidates = buildTrackCandidateUrls(track);
    if (!candidates.length) {
      attemptErrors.push('NO_TRACK_URL');
    } else {
      for (const candidate of candidates) {
        try {
          const response = await fetch(candidate.url, { credentials: 'same-origin' });
          const status = response.status;
          if (!response.ok) {
            throw new Error(`HTTP_${status}`);
          }
          const raw = await response.text();
          const captions = parseCaptions(raw);
          if (Array.isArray(captions) && captions.length) {
            const effectiveChannelId = channelId || getChannelIdForVideo(videoId) || null;
            return {
              videoId: videoId || track.videoId || null,
              captions,
              text: captionsToText(captions),
              raw: raw,
              track: {
                languageCode: track.languageCode || null,
                name: track.name && track.name.simpleText ? track.name.simpleText : null,
                isAutoGenerated: track.kind === 'asr'
              },
              candidate,
              channelId: effectiveChannelId,
              params: videoTranscriptParamsCache.get(videoId) || extractTranscriptParams(track) || null
            };
          }
          const snippet = raw && raw.length ? raw.slice(0, 160) : '(empty)';
          console.warn('[YouTube Handler] Caption candidate produced no captions', {
            videoId,
            url: candidate.url,
            fmt: candidate.fmt || null,
            kind: candidate.kind || null,
            status,
            length: raw ? raw.length : 0
          });
          console.warn('[YouTube Handler] Caption candidate snippet:', snippet);
          attemptErrors.push(snippet.includes('Sign in') ? 'AUTH_REQUIRED' : 'NO_CAPTIONS');
        } catch (error) {
          console.warn('[YouTube Handler] Caption candidate failed', {
            videoId,
            url: candidate.url,
            fmt: candidate.fmt || null,
            kind: candidate.kind || null,
            error: error?.message || error
          });
          attemptErrors.push(error?.message || 'FETCH_FAILED');
        }
      }
    }
    
    const errMessage = attemptErrors.find(msg => msg !== 'NO_CAPTIONS') || transcriptAttemptErrors[0] || 'NO_CAPTIONS';
    throw new Error(errMessage);
  }

  async function fetchCaptionsFromPlayer(videoId) {
    const config = getInnertubeConfig();
    if (!config) {
      throw new Error('NO_CONFIG');
    }

    const endpoint = `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`;
    const clientBundle = buildClientInfo(config);
    const payload = {
      videoId,
      context: buildTranscriptContext(config, clientBundle),
      playbackContext: {
        contentPlaybackContext: {
          vis: 0,
          splay: false,
          autoCaptionsDefaultOn: false,
          autoCaptionsDefaultOff: false,
          html5Preference: 'HTML5_PREF_WANTS'
        }
      },
      racyCheckOk: true,
      contentCheckOk: true
    };

    try {
      payload.context = payload.context || {};
      payload.context.client = payload.context.client || {};
      if (!payload.context.client.hl) {
        payload.context.client.hl = 'en';
      }
      if (!payload.context.client.gl) {
        payload.context.client.gl = 'US';
      }
      if (!payload.context.client.clientName) {
        payload.context.client.clientName = String(config.clientName || 'WEB');
      }
      if (!payload.context.client.clientVersion) {
        payload.context.client.clientVersion = config.clientVersion || '2.20250101.01.00';
      }
      if (config.visitorData && !payload.context.client.visitorData) {
        payload.context.client.visitorData = config.visitorData;
      }
      if (!payload.context.client.userAgent && navigator?.userAgent) {
        payload.context.client.userAgent = navigator.userAgent;
      }

    if (typeof config.signatureTimestamp === 'number') {
      payload.playbackContext.contentPlaybackContext.signatureTimestamp = config.signatureTimestamp;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-youtube-client-name': String(clientBundle.clientNameNumeric),
          'x-youtube-client-version': clientBundle.clientVersion,
          ...(clientBundle.visitorData ? { 'x-goog-visitor-id': clientBundle.visitorData } : {})
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`PLAYER_HTTP_${response.status}`);
      }

      const json = await response.json();
      const channelId = json?.videoDetails?.channelId ||
        json?.microformat?.playerMicroformatRenderer?.channelId ||
        null;
      const tracks = json?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!Array.isArray(tracks) || !tracks.length) {
        throw new Error('NO_TRACKS');
      }

      const sortedTracks = sortCaptionTracks(tracks);
      for (const track of sortedTracks) {
        try {
          if (channelId) {
            recordChannelId(videoId, channelId);
          }
          const data = await fetchCaptionTrack(track, videoId, channelId || null);
          return {
            ...data,
            source: 'playerApi',
            videoId,
            channelId: channelId || data.channelId || null
          };
        } catch (trackError) {
          if (trackError && trackError.message && trackError.message !== 'NO_CAPTIONS') {
            console.warn('[YouTube Handler] Track fetch error:', trackError.message);
          }
          // Continue to next track
        }
      }
      
      throw new Error('NO_CAPTIONS');
    } catch (error) {
      console.warn('[YouTube Handler] Player caption fetch failed:', error?.message || error);
      throw error;
    }
  }
  
  // Setup XHR interception
  function setupInterception() {
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    
    // Override XMLHttpRequest
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this._ytCaptionUrl = url;
      return originalXHROpen.apply(this, [method, url, ...rest]);
    };
    
    XMLHttpRequest.prototype.send = function(...args) {
      const xhr = this;
      
      // Check if this is a caption request
      if (xhr._ytCaptionUrl && 
         (xhr._ytCaptionUrl.includes('timedtext') || 
          xhr._ytCaptionUrl.includes('caption'))) {
        
        const videoId = extractVideoId(xhr._ytCaptionUrl);
        
        if (videoId) {
          console.log(`[YouTube Handler] Intercepting captions for: ${videoId}`);
          
          xhr.addEventListener('load', function() {
            try {
              const responseText = xhr.responseText;
              const captions = parseCaptions(responseText);
              
              if (captions.length > 0) {
                // Cache the captions
                const channelId = getChannelIdForVideo(videoId);
                const transcriptParams = videoTranscriptParamsCache.get(videoId) || null;
                captionCache.set(videoId, {
                  videoId,
                  captions,
                  text: captionsToText(captions),
                  timestamp: Date.now(),
                  channelId: channelId || null,
                  transcriptParams: transcriptParams || null
                });
                
                publishMetadataUpdate(videoId);
                console.log(`[YouTube Handler] ✅ Captured ${captions.length} captions for ${videoId}`);
                
                // Notify content script that captions are ready
                window.dispatchEvent(new CustomEvent('youtube-captions-ready', {
                  detail: {
                    videoId,
                    captionCount: captions.length
                  }
                }));
              }
            } catch (err) {
              console.error('[YouTube Handler] Error processing captions:', err);
            }
          });
        }
      }
      
      return originalXHRSend.apply(this, args);
    };
    
    console.log('[YouTube Handler] ✅ XHR interception active');
  }
  
  // Expose API for content script to access captions
  window.__ytGetCaptions = function(videoId) {
    return captionCache.get(videoId) || null;
  };
  
  window.__ytHasCaptions = function(videoId) {
    return captionCache.has(videoId);
  };
  
  window.__ytClearCache = function() {
    captionCache.clear();
    console.log('[YouTube Handler] Cache cleared');
  };
  
  window.__ytFetchCaptionsFromPlayer = async function(videoId) {
    const existing = captionCache.get(videoId);
    if (existing && existing.captions && existing.captions.length) {
      return existing;
    }
    const result = await fetchCaptionsFromPlayer(videoId);
    if (result && Array.isArray(result.captions) && result.captions.length) {
      const channelId = result.channelId || getChannelIdForVideo(videoId) || null;
      const params = result.params || videoTranscriptParamsCache.get(videoId) || null;
      captionCache.set(videoId, {
        videoId,
        captions: result.captions,
        text: captionsToText(result.captions),
        timestamp: Date.now(),
        source: result.source || 'playerApi',
        channelId,
        transcriptParams: params
      });
      publishMetadataUpdate(videoId);
      window.dispatchEvent(new CustomEvent('youtube-captions-ready', {
        detail: {
          videoId,
          captionCount: result.captions.length
        }
      }));
      return captionCache.get(videoId);
    }
    return null;
  };
  
  window.prefetchYouTubeTranscript = function(videoId) {
    return ensureTranscriptToken(videoId);
  };

  window.__debugTranscript = async function(videoId, options = {}) {
    const opts = options || {};
    console.log('[YouTube Debug] Starting transcript debug for', videoId, opts.dump ? '(dump enabled)' : '');
    const result = await ensureTranscriptToken(videoId);
    if (!result.success) {
      console.warn('[YouTube Debug] Prefetch failed for', videoId, result.error);
      return result;
    }
    const config = getInnertubeConfig();
    const metadata = transcriptMetadataCache.get(videoId) || {};
    const clientBundle = buildClientInfo(config, metadata || {});
    const contextPayload = buildTranscriptContext(config, clientBundle);
    const headers = buildTranscriptHeaders(clientBundle);
    if (opts.dump) {
      const headerPreview = {};
      Object.keys(headers || {}).forEach((key) => {
        headerPreview[key] = headers[key] && String(headers[key]).length ? 'set' : 'missing';
      });
      console.log('[YouTube Debug] Transcript metadata snapshot', {
        source: metadata?.source || null,
        paramLength: metadata?.params ? metadata.params.length : 0,
        hasClickTracking: !!metadata?.clickTrackingParams
      });
      console.log('[YouTube Debug] Transcript request headers', headerPreview);
      console.log('[YouTube Debug] Transcript context summary', {
        hasScreenNonce: !!contextPayload?.client?.screenNonce,
        clickTracking: contextPayload?.clickTracking?.clickTrackingParams ? 'present' : 'missing',
        clientName: contextPayload?.client?.clientName || null,
        clientVersion: contextPayload?.client?.clientVersion || null,
        hl: contextPayload?.client?.hl || null,
        gl: contextPayload?.client?.gl || null
      });
    }
    try {
      const captions = await fetchCaptionsViaTranscriptApi(videoId, { kind: 'asr', languageCode: 'en' }, getChannelIdForVideo(videoId));
      console.log('[YouTube Debug] Transcript API returned', captions?.captions?.length || 0, 'cues for', videoId);
      if (opts.dump && captions?.raw && typeof captions.raw === 'object') {
        console.log('[YouTube Debug] Transcript response keys', Object.keys(captions.raw));
      }
      return captions;
    } catch (error) {
      console.warn('[YouTube Debug] Transcript API request failed', error?.message || error);
      throw error;
    }
  };

  // Listen for caption requests from content script (via postMessage)
  window.addEventListener('message', (event) => {
    // Only accept messages from same origin
    if (event.source !== window) return;
    
    if (event.data.type === 'YT_GET_CAPTIONS') {
      const { requestId, videoId } = event.data;
      const captionData = captionCache.get(videoId);
      
      // Send response back
      window.postMessage({
        type: 'YT_CAPTIONS_RESPONSE',
        requestId: requestId,
        videoId: videoId,
        success: !!captionData,
        data: captionData || null
      }, '*');
    } else if (event.data.type === 'YT_PREFETCH_TRANSCRIPT') {
      const { requestId, videoId } = event.data;
      ensureTranscriptToken(videoId)
        .then((result) => {
          window.postMessage({
            type: 'YT_PREFETCH_RESPONSE',
            requestId,
            videoId,
            success: !!result?.success,
            source: result?.source || null,
            length: result?.length || 0,
            error: result?.error || null
          }, '*');
        })
        .catch((error) => {
          window.postMessage({
            type: 'YT_PREFETCH_RESPONSE',
            requestId,
            videoId,
            success: false,
            error: error?.message || 'PREFETCH_FAILED'
          }, '*');
        });
    } else if (event.data.type === 'YT_FETCH_PLAYER_CAPTIONS') {
      const { requestId, videoId } = event.data;
      fetchCaptionsFromPlayer(videoId)
        .then((result) => {
          if (result && result.captions && result.captions.length) {
            const channelId = result.channelId || getChannelIdForVideo(videoId) || null;
            const params = result.params || videoTranscriptParamsCache.get(videoId) || null;
            captionCache.set(videoId, {
              videoId,
              captions: result.captions,
              text: captionsToText(result.captions),
              timestamp: Date.now(),
              source: result.source || 'playerApi',
              channelId,
              transcriptParams: params
            });
            publishMetadataUpdate(videoId);
            window.dispatchEvent(new CustomEvent('youtube-captions-ready', {
              detail: {
                videoId,
                captionCount: result.captions.length
              }
            }));
            window.postMessage({
              type: 'YT_CAPTIONS_RESPONSE',
              requestId,
              videoId,
              success: true,
              data: captionCache.get(videoId)
            }, '*');
          } else {
            window.postMessage({
              type: 'YT_CAPTIONS_RESPONSE',
              requestId,
              videoId,
              success: false,
              error: 'NO_CAPTIONS'
            }, '*');
          }
        })
        .catch((error) => {
          window.postMessage({
            type: 'YT_CAPTIONS_RESPONSE',
            requestId,
            videoId,
            success: false,
            error: error && error.message ? error.message : 'PLAYER_FETCH_FAILED'
          }, '*');
        });
    }
  });
  
  // Initialize interception
  setupInterception();
  
  console.log('[YouTube Handler] Ready! Monitoring for caption requests...');

  function normalizeTranscriptParams(paramStr) {
    if (!paramStr || typeof paramStr !== 'string') return null;
    let normalized = paramStr;
    try {
      normalized = decodeURIComponent(normalized);
    } catch (error) {
      // Ignore decode errors, use raw string
    }
    return normalized;
  }

  function storeTranscriptParams(videoId, paramStr, metadata = {}) {
    if (!videoId || !paramStr) return null;
    return storeTranscriptMetadata(videoId, Object.assign({}, metadata, { params: paramStr }));
  }

  function storeTranscriptMetadata(videoId, metadata = {}) {
    if (!videoId || !metadata) return null;
    const normalized = metadata.params ? normalizeTranscriptParams(metadata.params) : null;
    const clickTrackingParams = metadata.clickTrackingParams || null;
    const source = metadata.source || null;
    const path = metadata.path || null;

    let updatedEntry = transcriptMetadataCache.get(videoId) || null;

    if (normalized && normalized.length >= MIN_TRANSCRIPT_PARAM_LENGTH) {
      const current = updatedEntry?.params || videoTranscriptParamsCache.get(videoId);
      if (!current || normalized.length >= current.length) {
        videoTranscriptParamsCache.set(videoId, normalized);
        updatedEntry = Object.assign({}, updatedEntry, {
          params: normalized,
          source: source || updatedEntry?.source || null,
          clickTrackingParams: clickTrackingParams || updatedEntry?.clickTrackingParams || null,
          path: path || updatedEntry?.path || null,
          timestamp: Date.now()
        });
        transcriptMetadataCache.set(videoId, updatedEntry);
        transcriptFailureSet.delete(videoId);
        publishMetadataUpdate(videoId);
        return updatedEntry;
      }
      if (!updatedEntry) {
        updatedEntry = {
          params: current,
          source: source || null,
          clickTrackingParams: clickTrackingParams || null,
          path: path || null,
          timestamp: Date.now()
        };
        transcriptMetadataCache.set(videoId, updatedEntry);
      } else if (clickTrackingParams && !updatedEntry.clickTrackingParams) {
        updatedEntry.clickTrackingParams = clickTrackingParams;
      }
      return updatedEntry;
    }

    if (clickTrackingParams && updatedEntry && !updatedEntry.clickTrackingParams) {
      updatedEntry.clickTrackingParams = clickTrackingParams;
      transcriptMetadataCache.set(videoId, updatedEntry);
      publishMetadataUpdate(videoId);
    }

    return updatedEntry;
  }

  function markTranscriptFailure(videoId) {
    if (!videoId) return;
    videoTranscriptParamsCache.delete(videoId);
    transcriptMetadataCache.set(videoId, Object.assign({}, transcriptMetadataCache.get(videoId) || {}, {
      params: null,
      source: 'unavailable',
      timestamp: Date.now()
    }));
    transcriptFailureSet.add(videoId);
    publishMetadataUpdate(videoId);
  }

  function hasTranscriptFailure(videoId) {
    return transcriptFailureSet.has(videoId);
  }
  function extractTranscriptMetadataFromObject(node, path = 'root', depth = 0, state = {}) {
    if (!node || typeof node !== 'object' || depth > 60) return null;

    let currentClick = state.clickTrackingParams || null;
    if (typeof node.clickTrackingParams === 'string' && node.clickTrackingParams.length) {
      currentClick = node.clickTrackingParams;
    }

    const endpoint = node.getTranscriptEndpoint || node.transcriptEndpoint || null;
    if (endpoint && typeof endpoint.params === 'string') {
      const candidate = endpoint.params;
      if (candidate && candidate.length >= MIN_TRANSCRIPT_PARAM_LENGTH) {
        const click = endpoint.clickTrackingParams || currentClick || null;
        return {
          params: candidate,
          clickTrackingParams: click,
          path: `${path}.${node.getTranscriptEndpoint ? 'getTranscriptEndpoint' : 'transcriptEndpoint'}.params`
        };
      }
    }

    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) {
        const result = extractTranscriptMetadataFromObject(node[index], `${path}[${index}]`, depth + 1, { clickTrackingParams: currentClick });
        if (result) {
          return result;
        }
      }
      return null;
    }

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === 'object' && value !== null) {
        const result = extractTranscriptMetadataFromObject(value, `${path}.${key}`, depth + 1, { clickTrackingParams: currentClick });
        if (result) {
          return result;
        }
      }
    }

    return null;
  }
  function scanNodeForMetadata(node, contextVideoId = null, depth = 0, visited) {
    if (!visited) {
      visited = new WeakSet();
    }
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (visited.has(node)) return;
    visited.add(node);
    let currentVideoId = contextVideoId;
    if (Array.isArray(node)) {
      for (const item of node) {
        scanNodeForMetadata(item, currentVideoId, depth + 1, visited);
      }
      return;
    }

    if (typeof node.videoId === 'string') {
      currentVideoId = node.videoId;
      recordVideoId(currentVideoId);
      extractChannelIdFromRenderer(node, currentVideoId);
    }

    const watchVideoId = node.watchEndpoint?.videoId || node.navigationEndpoint?.watchEndpoint?.videoId;
    if (watchVideoId) {
      recordVideoId(watchVideoId);
      if (!currentVideoId) {
        currentVideoId = watchVideoId;
      }
    }

    const serviceEndpointParams = node.serviceEndpoint?.getTranscriptEndpoint?.params
      || node.getTranscriptEndpoint?.params
      || node.onTap?.commandMetadata?.webCommandMetadata?.getTranscriptEndpoint?.params;
    if (serviceEndpointParams && currentVideoId) {
      storeTranscriptParams(currentVideoId, serviceEndpointParams);
    }

    if (node.commandMetadata?.webCommandMetadata?.url && node.commandMetadata.webCommandMetadata.url.includes('/watch')) {
      const url = node.commandMetadata.webCommandMetadata.url;
      const match = url.match(/v=([A-Za-z0-9_-]{11})/);
      if (match && match[1]) {
        const urlVideoId = match[1];
        recordVideoId(urlVideoId);
        if (!currentVideoId) {
          currentVideoId = urlVideoId;
        }
      }
    }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      scanNodeForMetadata(value, currentVideoId, depth + 1, visited);
    }
  }
}

  window.__ytGetPageHTML = () => document.documentElement.innerHTML;
  window.__ytGetInnertubeConfig = getInnertubeConfig;
  window.__ytFetchTranscriptWithProvidedConfig = async (videoId, innertubeConfig, transcriptParams, sapiSidHash) => {
    console.log('[CS] Injected transcript fetch has started.');
    try {
      if (!innertubeConfig || !transcriptParams || !sapiSidHash) {
        throw new Error('Missing required arguments.');
      }

      const clientInfo = _cs_buildClientInfo(innertubeConfig);
      const context = _cs_buildTranscriptContext(innertubeConfig, clientInfo);
      const headers = _cs_buildTranscriptHeaders(innertubeConfig, clientInfo, sapiSidHash);

      const endpoint = `https://www.youtube.com/youtubei/v1/get_transcript?key=${innertubeConfig.apiKey}`;
      const body = JSON.stringify({ context, params: transcriptParams });

      const response = await fetch(endpoint, { method: 'POST', body, headers });

      if (!response.ok) {
        throw new Error(`API call failed from content script with HTTP ${response.status}`);
      }

      const json = await response.json();
      console.log('[CS] ----- RAW API RESPONSE JSON -----');
      console.log(JSON.stringify(json, null, 2));

      const cues = _cs_parseTranscriptResponse(json);

      if (cues && cues.length > 0) {
        console.log(`[CS] ✅ Success! Fetched ${cues.length} cues.`);
        return { success: true, captions: cues, text: captionsToText(cues) };
      } else {
        throw new Error(`API returned OK, but transcript was empty. Raw Response: ${JSON.stringify(json)}`);
      }
    } catch (error) {
      console.error('[CS] Injected transcript fetch failed:', error);
      return { success: false, error: error.message };
    }
  };

})();
