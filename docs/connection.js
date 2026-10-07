// Bounded reads and a separate write lane. A timeout is not proof that a write failed.
(function () {
  const writes = new Set(['registerNickname', 'updateNickname', 'submitManualScore', 'submitImageScore',
    'adminUpdateScore', 'adminInvalidateScore', 'adminRestoreScore', 'adminUpdateUser', 'adminUpdateSong', 'adminMergeSong']);
  const lanes = {read: {active: 0, limit: 2, waiting: []}, write: {active: 0, limit: 1, waiting: []}};
  const pendingReads = new Map();
  let writeRevision = 0;
  const metricsKey = 'karaoke-performance-v2';
  function record(record) {
    try {
      let rows = JSON.parse(sessionStorage.getItem(metricsKey) || '[]');
      if (!Array.isArray(rows)) rows = [];
      rows.push(Object.assign({at: new Date().toISOString()}, record));
      sessionStorage.setItem(metricsKey, JSON.stringify(rows.slice(-200)));
    } catch (_) {}
  }
  function acquire(writing) {
    const lane = lanes[writing ? 'write' : 'read'];
    return new Promise(resolve => {
      const enter = () => {
        lane.active++;
        resolve(() => { lane.active--; const next = lane.waiting.shift(); if (next) next(); });
      };
      if (lane.active < lane.limit) enter(); else lane.waiting.push(enter);
    });
  }
  window.karaokeMeasurePhase = (stage, elapsedMs) => {
    if (['liff_init', 'photo_roundtrip'].includes(stage) && Number.isFinite(elapsedMs)) record({stage, elapsedMs: Math.round(elapsedMs)});
  };
  // Local-only diagnostics; no tokens, payloads, URLs or extra network requests.
  window.karaokePerformanceReport = () => {
    let records = [];
    try { records = JSON.parse(sessionStorage.getItem(metricsKey) || '[]'); } catch (_) {}
    return {version: 'performance-2', records: Array.isArray(records) ? records : []};
  };
  window.addEventListener?.('load', () => {
    const nav = performance.getEntriesByType?.('navigation')[0];
    if (nav) record({stage: 'page_loaded', ttfbMs: Math.round(nav.responseStart - nav.requestStart),
      downloadMs: Math.round(nav.responseEnd - nav.responseStart), domReadyMs: Math.round(nav.domContentLoadedEventEnd),
      totalMs: Math.round(performance.now())});
  });

  function attempt(api, payload, options, queuedAt) {
    return new Promise((resolve, reject) => {
      if (!options.url || options.url === 'YOUR_GAS_WEB_APP_EXEC_URL') {
        reject(new Error('接続先が設定されていません。お店のスタッフにお知らせください。'));
        return;
      }
      const id = 'req_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
      const callback = '__karaoke_' + id;
      const started = performance.now();
      const script = document.createElement('script');
      let settled = false;
      const trace = (stage, extra) => {
        const row = Object.assign({requestId: id, api, stage, queueMs: Math.round(started - queuedAt), elapsedMs: Math.round(performance.now() - started)}, extra);
        record(row);
        try { options.trace(row); } catch (_) {}
      };
      const timer = window.setTimeout(() => finish(null, 'timeout'), writes.has(api) ? 90000 : 60000);
      const slowTimer = window.setTimeout(() => {
        if (options.slow) options.slow();
      }, 15000);
      function finish(result, failure) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.clearTimeout(slowTimer);
        const serverMs = result && result.timing && Number(result.timing.serverMs);
        const details = Number.isFinite(serverMs) && serverMs >= 0 ? {
          serverMs, outsideServerMs: Math.max(0, Math.round(performance.now() - started - serverMs))
        } : {};
        trace(failure || (result && result.ok ? 'received_ok' : 'received_error'), details);
        script.onload = null;
        script.onerror = null;
        // Discard delayed replies instead of calling a removed callback or updating an old screen.
        window[callback] = () => {};
        window.setTimeout(() => { delete window[callback]; }, 300000);
        if (script.parentNode) script.parentNode.removeChild(script);
        if (failure) {
          const error = new Error('接続を確認できませんでした。少し時間をおいて、もう一度接続してください。');
          error.connection = true;
          error.uncertain = writes.has(api);
          reject(error);
        } else resolve(result);
      }
      window[callback] = result => {
        if (!result || typeof result.ok !== 'boolean') finish(null, 'invalid_response');
        else finish(result);
      };
      script.onerror = () => finish(null, 'script_load_error');
      script.onload = () => { if (!settled) finish(null, 'missing_response'); };
      const params = new URLSearchParams({api, callback, requestId: id, _: String(Date.now())});
      if (options.token) params.set('idToken', options.token);
      if (payload) params.set('payload', JSON.stringify(payload));
      try {
        const recent = window.karaokePerformanceReport().records.filter(row => row.stage !== 'sent').slice(-4);
        if (recent.length) params.set('clientMetrics', JSON.stringify(recent));
      } catch (_) {}
      script.src = options.url + '?' + params.toString();
      trace('sent');
      document.body.appendChild(script);
    });
  }

  window.karaokeConnectionRequest = function (api, payload, options) {
    const key = JSON.stringify([api, payload || null, options.token]);
    if (!writes.has(api) && pendingReads.has(key)) return pendingReads.get(key);
    const task = (async () => {
      for (;;) {
        const queuedAt = performance.now();
        const release = await acquire(writes.has(api));
        const writing = writes.has(api);
        if (writing) writeRevision++;
        const revision = writeRevision;
        let failure;
        try {
          const result = await attempt(api, payload, options, queuedAt);
          // Do not let an older read overwrite data refreshed after a mutation.
          if (!writing && revision !== writeRevision) continue;
          return result;
        }
        catch (error) { failure = error; }
        finally { if (writing) writeRevision++; release(); }
        if (!failure.connection || failure.uncertain || api === 'getUploadResult') throw failure;
        await options.recover(false);
      }
    })();
    if (!writes.has(api)) {
      pendingReads.set(key, task);
      task.then(() => pendingReads.delete(key), () => pendingReads.delete(key));
    }
    return task;
  };
})();
