// X Downloader – MAIN world interceptor.
// 1. Перехватывает ответы API X и вытаскивает прямые mp4-ссылки (video_info -> xvd:media).
// 2. Вытаскивает полные несокращённые тексты постов (включая скрытый текст под "Show more"
//    из note_tweet / legacy.full_text) и поддерживает поиск по React Fiber (xvd:lookup-text).
(() => {
  'use strict';

  document.dispatchEvent(new CustomEvent('xvd:main:teardown'));

  const EVT_MEDIA = 'xvd:media';
  const EVT_TEXTS = 'xvd:texts';

  const store = (window.__xdlStore = window.__xdlStore || {
    seenMedia: new Set(),
    allMedia: [],
    allTexts: new Map()
  });

  let DEBUG = true;
  try { DEBUG = localStorage.getItem('xvdDebug') !== '0'; } catch (e) { /* нет доступа */ }
  function dwarn() {
    console.warn.apply(console, ['[XDL]', ...arguments]);
  }

  function decodeEntities(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&#x27;/gi, "'");
  }

  function extractCleanTweetText(node) {
    if (!node || typeof node !== 'object') return null;
    const legacy = node.legacy && typeof node.legacy === 'object' ? node.legacy : null;
    // Для ретвитов берём внутренний retweeted_status_result.result при рекурсии
    if (legacy && legacy.retweeted_status_result) return null;

    const restId =
      (typeof node.rest_id === 'string' && /^\d+$/.test(node.rest_id) && node.rest_id) ||
      (legacy && typeof legacy.id_str === 'string' && /^\d+$/.test(legacy.id_str) && legacy.id_str) ||
      null;
    if (!restId) return null;

    const noteRes =
      node.note_tweet &&
      node.note_tweet.note_tweet_results &&
      node.note_tweet.note_tweet_results.result;

    let raw =
      (noteRes && typeof noteRes.text === 'string' && noteRes.text) ||
      (legacy && typeof legacy.full_text === 'string' && legacy.full_text) ||
      null;
    if (!raw) return null;

    const urlEntities = [];
    if (noteRes && noteRes.entity_set && Array.isArray(noteRes.entity_set.urls)) {
      urlEntities.push(...noteRes.entity_set.urls);
    }
    if (legacy && legacy.entities && Array.isArray(legacy.entities.urls)) {
      urlEntities.push(...legacy.entities.urls);
    }
    for (const u of urlEntities) {
      if (u && typeof u.url === 'string' && u.url && typeof u.expanded_url === 'string' && u.expanded_url) {
        raw = raw.split(u.url).join(u.expanded_url);
      }
    }

    if (legacy && legacy.entities && Array.isArray(legacy.entities.media)) {
      for (const m of legacy.entities.media) {
        if (m && typeof m.url === 'string' && m.url) {
          raw = raw.split(m.url).join('');
        }
      }
    }

    const cleaned = decodeEntities(raw).trim();
    if (!cleaned) return null;
    return { tweetId: restId, text: cleaned };
  }

  function emit(mediaEntries, textEntries) {
    if (mediaEntries.length) {
      store.allMedia.push(...mediaEntries);
      document.dispatchEvent(new CustomEvent(EVT_MEDIA, { detail: JSON.stringify(mediaEntries) }));
    }
    if (textEntries.length) {
      document.dispatchEvent(new CustomEvent(EVT_TEXTS, { detail: JSON.stringify(textEntries) }));
    }
  }

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

  function collect(node, mediaOut, textOut) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) collect(item, mediaOut, textOut);
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
        if (!store.seenMedia.has(key)) {
          store.seenMedia.add(key);
          mediaOut.push({ mediaId, tweetId, url });
        }
      }
    }

    const txtInfo = extractCleanTweetText(node);
    if (txtInfo) {
      const prev = store.allTexts.get(txtInfo.tweetId);
      if (!prev || txtInfo.text.length > prev.length) {
        store.allTexts.set(txtInfo.tweetId, txtInfo.text);
        textOut.push(txtInfo);
      }
    }

    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') collect(v, mediaOut, textOut);
    }
  }

  function scanText(text) {
    if (typeof text !== 'string') return;
    if (
      text.indexOf('video_info') === -1 &&
      text.indexOf('full_text') === -1 &&
      text.indexOf('note_tweet') === -1
    ) {
      return;
    }
    try {
      scanObject(JSON.parse(text));
    } catch (e) { /* не JSON — игнорируем */ }
  }

  function scanObject(json) {
    try {
      const mediaOut = [];
      const textOut = [];
      collect(json, mediaOut, textOut);
      emit(mediaOut, textOut);
    } catch (e) { /* игнорируем */ }
  }

  function findTweetInProps(root, targetTweetId) {
    const visited = new WeakSet();
    let best = null;
    let visits = 0;

    function walk(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 5 || visits > 400) return;
      if (visited.has(obj)) return;
      visited.add(obj);
      visits++;

      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length && i < 20; i++) walk(obj[i], depth + 1);
        return;
      }

      const res = extractCleanTweetText(obj);
      if (res && (!targetTweetId || res.tweetId === targetTweetId)) {
        if (!best || res.text.length > best.text.length) {
          best = res;
        }
      }

      const keys = Object.keys(obj);
      for (let i = 0; i < keys.length && i < 35; i++) {
        const k = keys[i];
        if (k.startsWith('_') || k === 'children' || k === 'ownerDocument') continue;
        const v = obj[k];
        if (v && typeof v === 'object' && !(v instanceof Node)) {
          walk(v, depth + 1);
        }
      }
    }

    walk(root, 0);
    return best;
  }

  function lookupFromFiber(elemId, tweetId) {
    let el = elemId ? document.getElementById(elemId) : null;
    if (!el && tweetId) {
      const link = document.querySelector(`article[data-testid="tweet"] a[href*="/status/${tweetId}"]`);
      el = link ? link.closest('article') : null;
    }
    if (!el) return null;

    const fiberKey = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$')
    );
    if (!fiberKey) return null;

    let node = el[fiberKey];
    let best = null;
    for (let hops = 0; node && hops < 35; hops++) {
      for (const props of [node.memoizedProps, node.pendingProps, node]) {
        if (!props || typeof props !== 'object') continue;
        const found = findTweetInProps(props, tweetId);
        if (found && (!best || found.text.length > best.text.length)) {
          best = found;
          if (!tweetId) return best; // для цитат без ссылки берём ближайший узел твита
        }
      }
      node = node.return;
    }
    return best;
  }

  function onReady() {
    if (store.allMedia.length) {
      document.dispatchEvent(new CustomEvent(EVT_MEDIA, { detail: JSON.stringify(store.allMedia) }));
    }
    if (store.allTexts.size) {
      const entries = [];
      for (const [tweetId, text] of store.allTexts.entries()) {
        entries.push({ tweetId, text });
      }
      document.dispatchEvent(new CustomEvent(EVT_TEXTS, { detail: JSON.stringify(entries) }));
    }
  }

  function onLookupText(e) {
    let req;
    try {
      req = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    const { reqId, tweetId, elemId } = req || {};
    let text = tweetId ? store.allTexts.get(tweetId) || null : null;

    const fiberFound = lookupFromFiber(elemId, tweetId);
    if (fiberFound && (!text || fiberFound.text.length > text.length)) {
      text = fiberFound.text;
      store.allTexts.set(fiberFound.tweetId, text);
    }

    document.dispatchEvent(
      new CustomEvent('xvd:lookup-text:res', {
        detail: JSON.stringify({ reqId, text })
      })
    );
  }

  document.addEventListener('xvd:ready', onReady);
  document.addEventListener('xvd:lookup-text', onLookupText);

  document.addEventListener(
    'xvd:main:teardown',
    () => {
      document.removeEventListener('xvd:ready', onReady);
      document.removeEventListener('xvd:lookup-text', onLookupText);
    },
    { once: true }
  );

  if (!window.__xdlHooked) {
    window.__xdlHooked = true;
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
  }

  void DEBUG; void dwarn; // зарезервировано под диагностику
})();
