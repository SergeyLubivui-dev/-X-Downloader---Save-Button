// X Downloader – Save Button — MAIN world.
// Единственная задача: перехватывать ответы API X и вытаскивать прямые
// mp4-ссылки из video_info (для видео через MSE, у которых <video src> — blob).
// Найденное шлём в content script событием xvd:media. Ничего в ленте/видео
// не меняем — это чистый загрузчик, без стилизации и блокировок.
(() => {
  'use strict';

  const EVT = 'xvd:media';
  const seen = new Set();
  const all = [];

  // Лог включён по умолчанию; заглушить: localStorage.setItem('xvdDebug','0')
  let DEBUG = true;
  try { DEBUG = localStorage.getItem('xvdDebug') !== '0'; } catch (e) { /* нет доступа */ }
  function dwarn() {
    console.warn.apply(console, ['[XDL]', ...arguments]);
  }

  function emit(entries) {
    if (!entries.length) return;
    all.push(...entries);
    document.dispatchEvent(new CustomEvent(EVT, { detail: JSON.stringify(entries) }));
  }

  // content script мог загрузиться позже — по его запросу отдаём всё накопленное
  document.addEventListener('xvd:ready', () => {
    if (all.length) {
      document.dispatchEvent(new CustomEvent(EVT, { detail: JSON.stringify(all) }));
    }
  });

  function bestVariant(videoInfo) {
    if (!videoInfo || !Array.isArray(videoInfo.variants)) return null;
    let best = null;
    for (const v of videoInfo.variants) {
      if (v && v.content_type === 'video/mp4' && v.url) {
        const bitrate = v.bitrate || 0;
        if (!best || bitrate > best.bitrate) best = { url: v.url, bitrate };
      }
    }
    return best ? best.url : null;
  }

  function collect(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) collect(item, out);
      return;
    }
    if (node.video_info) {
      const url = bestVariant(node.video_info);
      if (url) {
        const mediaId = typeof node.id_str === 'string' ? node.id_str : null;
        let tweetId = null;
        if (typeof node.expanded_url === 'string') {
          const m = node.expanded_url.match(/\/status\/(\d+)/);
          if (m) tweetId = m[1];
        }
        const key = mediaId + '|' + tweetId;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ mediaId, tweetId, url });
        }
      }
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') collect(v, out);
    }
  }

  function scanText(text) {
    if (typeof text !== 'string' || text.indexOf('video_info') === -1) return;
    try {
      scanObject(JSON.parse(text));
    } catch (e) { /* не JSON — игнорируем */ }
  }

  function scanObject(json) {
    try {
      const out = [];
      collect(json, out);
      emit(out);
    } catch (e) { /* игнорируем */ }
  }

  const API_RE = /\/i\/api\/|api\.(x|twitter)\.com/;

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    return origFetch.apply(this, args).then((resp) => {
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (API_RE.test(url)) {
          resp.clone().text().then(scanText).catch(() => {});
        }
      } catch (e) { /* игнорируем */ }
      return resp;
    });
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xdlUrl = typeof url === 'string' ? url : String(url);
    return origOpen.apply(this, arguments);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (this.__xdlUrl && API_RE.test(this.__xdlUrl)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            scanText(this.responseText);
          } else if (this.responseType === 'json' && this.response) {
            scanObject(this.response);
          }
        } catch (e) { /* игнорируем */ }
      });
    }
    return origSend.apply(this, arguments);
  };

  void DEBUG; void dwarn; // зарезервировано под диагностику
})();
