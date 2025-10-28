'use strict';

(function () {
  // Helper to convert parsed captions into a single string.
  function captionsToText(captions) {
    if (!captions || !Array.isArray(captions)) return '';
    return captions.map(c => c.text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

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
      }
      throw new Error(`API returned OK, but transcript was empty. Raw Response: ${JSON.stringify(json)}`);
    } catch (error) {
      console.error('[CS] Injected transcript fetch failed:', error);
      return { success: false, error: error.message };
    }
  };
})();
