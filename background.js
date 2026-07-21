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

async function resolveTweet(tweetId) {
  const url =
    'https://cdn.syndication.twimg.com/tweet-result?id=' +
    encodeURIComponent(tweetId) +
    '&token=' +
    syndicationToken(tweetId);
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const data = await resp.json();

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
});
