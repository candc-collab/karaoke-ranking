// Serialize JSONP requests. A timeout is not proof that a write failed.
(function () {
  const writes = new Set(['registerNickname', 'updateNickname', 'submitManualScore', 'submitImageScore',
    'adminUpdateScore', 'adminInvalidateScore', 'adminRestoreScore', 'adminUpdateUser', 'adminUpdateSong', 'adminMergeSong']);
  let queue = Promise.resolve();
  const pendingReads = new Map();

  function attempt(api, payload, options) {
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
      const trace = stage => options.trace({requestId: id, api, stage, elapsedMs: Math.round(performance.now() - started)});
      const timer = window.setTimeout(() => finish(null, 'timeout'), writes.has(api) ? 90000 : 60000);
      const slowTimer = window.setTimeout(() => {
        if (options.slow) options.slow();
      }, 15000);
      function finish(result, failure) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.clearTimeout(slowTimer);
        trace(failure || (result && result.ok ? 'received_ok' : 'received_error'));
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
      script.src = options.url + '?' + params.toString();
      trace('sent');
      document.body.appendChild(script);
    });
  }

  window.karaokeConnectionRequest = function (api, payload, options) {
    const key = JSON.stringify([api, payload || null, options.token]);
    if (!writes.has(api) && pendingReads.has(key)) return pendingReads.get(key);
    const task = queue.then(async () => {
      for (;;) {
        try { return await attempt(api, payload, options); }
        catch (error) {
          if (!error.connection || error.uncertain || api === 'getUploadResult') throw error;
          await options.recover(false);
        }
      }
    });
    queue = task.catch(() => {});
    if (!writes.has(api)) {
      pendingReads.set(key, task);
      task.then(() => pendingReads.delete(key), () => pendingReads.delete(key));
    }
    return task;
  };
})();
