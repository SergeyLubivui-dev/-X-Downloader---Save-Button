// Service worker: скачивание через chrome.downloads и фолбэк-резолв mp4
// через публичный syndication API, если перехват GraphQL ничего не дал.
'use strict';

function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

function pickBestMp4(variants) {
  let best = null;
  for (const v of variants || []) {
    const url = v.url || v.src;
    if (!url) continue;
    const isMp4 = v.content_type === 'video/mp4' || /\.mp4(\?|$)/.test(url);
    if (!isMp4) continue;
    const bitrate = v.bitrate || 0;
    if (!best || bitrate > best.bitrate) best = { url, bitrate };
  }
  return best ? best.url : null;
}

async function fetchSyndicationTweet(tweetId) {
  const url =
    'https://cdn.syndication.twimg.com/tweet-result?id=' +
    encodeURIComponent(tweetId) +
    '&token=' +
    syndicationToken(tweetId);
  const resp = await fetch(url);
  if (!resp.ok) return null;
  return resp.json();
}

async function resolveTweet(tweetId) {
  const data = await fetchSyndicationTweet(tweetId);
  if (!data) return null;

  const media = data.mediaDetails || [];
  for (const md of media) {
    if (md.video_info) {
      const best = pickBestMp4(md.video_info.variants);
      if (best) return best;
    }
  }
  if (data.video && Array.isArray(data.video.variants)) {
    return pickBestMp4(data.video.variants);
  }
  return null;
}

async function resolveTweetText(tweetId) {
  const data = await fetchSyndicationTweet(tweetId);
  if (!data || typeof data.text !== 'string') return null;

  let text = data.text;
  const entities = data.entities || {};
  for (const u of entities.urls || []) {
    if (u && u.url && u.expanded_url) {
      text = text.split(u.url).join(u.expanded_url);
    }
  }
  for (const m of entities.media || []) {
    if (m && m.url) {
      text = text.split(m.url).join('');
    }
  }
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .trim();
}

async function fetchImageDataUrl(url) {
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const mime = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  const bytes = new Uint8Array(await resp.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return 'data:' + mime + ';base64,' + btoa(binary);
}

const BRIDGE_URL = 'http://127.0.0.1:18791';

async function injectIntoOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id == null) return;
        await chrome.scripting
          .executeScript({ target: { tabId: tab.id }, files: ['interceptor.js'], world: 'MAIN' })
          .catch(() => {});
        await chrome.scripting
          .insertCSS({ target: { tabId: tab.id }, files: ['content.css'] })
          .catch(() => {});
        await chrome.scripting
          .executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
          .catch(() => {});
      })
    );
  } catch (err) {
    // вкладки недоступны
  }
}

chrome.runtime.onInstalled.addListener(() => {
  injectIntoOpenTabs();
});

async function bridgeRequest(path, options, offlinePayload) {
  try {
    const resp = await fetch(BRIDGE_URL + path, options);
    const data = await resp.json().catch(() => null);
    if (data && typeof data === 'object') return data;
    return { ok: resp.ok, error: resp.ok ? undefined : 'HTTP ' + resp.status };
  } catch (err) {
    return offlinePayload;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'download') {
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename, saveAs: false },
      (downloadId) => {
        sendResponse({ ok: !chrome.runtime.lastError && downloadId != null });
      }
    );
    return true;
  }
  if (msg && msg.type === 'resolve') {
    resolveTweet(msg.tweetId)
      .then((url) => sendResponse({ url }))
      .catch(() => sendResponse({ url: null }));
    return true;
  }
  if (msg && msg.type === 'resolve_text') {
    resolveTweetText(msg.tweetId)
      .then((text) => sendResponse({ text }))
      .catch(() => sendResponse({ text: null }));
    return true;
  }
  if (msg && msg.type === 'fetch_image_data_url') {
    fetchImageDataUrl(msg.url)
      .then((dataUrl) => sendResponse({ ok: Boolean(dataUrl), dataUrl }))
      .catch(() => sendResponse({ ok: false, dataUrl: null }));
    return true;
  }
  if (msg && msg.type === 'translate') {
    bridgeRequest(
      '/translate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          texts: Array.isArray(msg.texts) ? msg.texts : [],
          target_lang: typeof msg.targetLang === 'string' && msg.targetLang ? msg.targetLang : 'ru'
        })
      },
      { ok: false, error: 'Локальный мост перевода (127.0.0.1:18791) не запущен' }
    ).then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'llm_status') {
    bridgeRequest('/status', { method: 'GET' }, { ok: false, state: 'offline' }).then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'llm_unload') {
    bridgeRequest('/unload', { method: 'POST' }, { ok: false, state: 'offline' }).then(sendResponse);
    return true;
  }
});
