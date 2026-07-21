// X Downloader – Save Button — isolated world.
// Копит карту mediaId/tweetId -> mp4 (из interceptor) и вставляет кнопку
// скачивания в панель действий постов с видео/GIF. Больше ничего не трогает.
(() => {
  'use strict';

  const settings = { download: true };

  let DEBUG = true;
  try { DEBUG = localStorage.getItem('xvdDebug') !== '0'; } catch (e) { /* нет доступа */ }
  function dlog() {
    if (DEBUG) console.info.apply(console, ['[XDL]', ...arguments]);
  }
  function dwarn() {
    console.warn.apply(console, ['[XDL]', ...arguments]);
  }

  // ---------- перехваченные ссылки на mp4 ----------

  const byMedia = new Map();
  const byTweet = new Map();

  document.addEventListener('xvd:media', (e) => {
    let entries;
    try {
      entries = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    for (const { mediaId, tweetId, url } of entries) {
      if (mediaId) byMedia.set(mediaId, url);
      if (tweetId && !byTweet.has(tweetId)) byTweet.set(tweetId, url);
    }
  });

  // просим interceptor переслать всё, что он успел собрать до нас
  document.dispatchEvent(new CustomEvent('xvd:ready'));

  // ---------- кнопка скачивания ----------

  const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M14.4697 10.4697C14.7626 10.1768 15.2374 10.1768 15.5303 10.4697C15.8232 10.7626 15.8232 11.2374 15.5303 11.5303L12.5303 14.5303C12.2374 14.8232 11.7626 14.8232 11.4697 14.5303L8.46967 11.5303C8.17678 11.2374 8.17678 10.7626 8.46967 10.4697C8.76256 10.1768 9.23744 10.1768 9.53033 10.4697L11.25 12.1893V4C11.25 3.58579 11.5858 3.25 12 3.25C12.4142 3.25 12.75 3.58579 12.75 4V12.1893L14.4697 10.4697Z" fill="currentColor"></path><path d="M20.75 12C20.75 11.5858 20.4142 11.25 20 11.25C19.5858 11.25 19.25 11.5858 19.25 12C19.25 16.0041 16.0041 19.25 12 19.25C7.99593 19.25 4.75 16.0041 4.75 12C4.75 11.5858 4.41421 11.25 4 11.25C3.58579 11.25 3.25 11.5858 3.25 12C3.25 16.8325 7.16751 20.75 12 20.75C16.8325 20.75 20.75 16.8325 20.75 12Z" fill="currentColor"></path></svg>`;

  function resolveIds(player) {
    let mediaId = null;
    let tweetId = null;
    let user = null;

    const video = player.querySelector('video');
    const poster = (video && video.getAttribute('poster')) || '';
    const pm = poster.match(/(?:amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\/(\d+)/);
    if (pm) mediaId = pm[1];

    const article = player.closest('article');
    const link = article && article.querySelector('a[href*="/status/"]');
    if (link) {
      const lm = link.getAttribute('href').match(/^\/([^/]+)\/status\/(\d+)/);
      if (lm) {
        user = lm[1];
        tweetId = lm[2];
      }
    }
    if (!tweetId) {
      const um = location.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
      if (um) {
        user = um[1];
        tweetId = um[2];
      }
    }
    return { mediaId, tweetId, user };
  }

  function flash(btn, cls) {
    btn.classList.add(cls);
    setTimeout(() => btn.classList.remove(cls), 1600);
  }

  function directVideoUrl(player) {
    // GIF и лёгкие видео имеют прямой https-src (не blob через MSE)
    const video = player.querySelector('video');
    if (!video) return null;
    const srcEl = video.querySelector('source');
    const src = video.currentSrc || video.src || (srcEl && srcEl.src) || '';
    return src.startsWith('https://video.twimg.com/') ? src : null;
  }

  async function onClick(ev, btn) {
    ev.preventDefault();
    ev.stopPropagation();
    if (btn.classList.contains('xvd-loading')) return;

    const article = btn.closest('article');
    const player = article && article.querySelector('[data-testid="videoPlayer"]');
    if (!player) return;

    const { mediaId, tweetId, user } = resolveIds(player);
    let url =
      directVideoUrl(player) ||
      (mediaId && byMedia.get(mediaId)) ||
      (tweetId && byTweet.get(tweetId)) ||
      null;

    btn.classList.add('xvd-loading');
    try {
      if (!url && tweetId) {
        const resp = await chrome.runtime.sendMessage({ type: 'resolve', tweetId });
        if (resp && resp.url) url = resp.url;
      }
      if (!url) throw new Error('video url not found');

      const isGif = url.includes('/tweet_video/');
      const filename =
        'x_' + (user || 'video') + '_' + (tweetId || mediaId || 'clip') + (isGif ? '_gif' : '') + '.mp4';
      dlog('скачивание:', filename, '<-', url);
      const resp = await chrome.runtime.sendMessage({ type: 'download', url, filename });
      if (!resp || !resp.ok) throw new Error('download failed');
      flash(btn, 'xvd-ok');
    } catch (err) {
      dwarn('скачивание не удалось:', (err && err.message) || err, { tweetId, mediaId, url });
      flash(btn, 'xvd-err');
    } finally {
      btn.classList.remove('xvd-loading');
    }
  }

  function makeButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xvd-btn';
    btn.setAttribute('aria-label', 'Download video');
    btn.innerHTML = ICON;
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick']) {
      btn.addEventListener(type, (ev) => ev.stopPropagation());
    }
    return btn;
  }

  // делегированный клик по кнопке скачивания
  document.addEventListener('click', (ev) => {
    if (!(ev.target instanceof Element)) return;
    const btn = ev.target.closest('.xvd-btn');
    if (btn) onClick(ev, btn);
  });

  function injectButtons() {
    if (!settings.download) return;
    // кнопка — в панели действий поста, правее "Поделиться",
    // и только если в посте есть видео или GIF
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (!article.offsetParent) continue; // скрытые — не обрабатываем
      if (article.querySelector('.xvd-btn')) continue;
      if (!article.querySelector('[data-testid="videoPlayer"]')) continue;
      const group = article.querySelector('div[role="group"]');
      if (!group) continue;
      group.appendChild(makeButton());
    }
  }

  // ---------- настройки ----------

  function applySettings() {
    if (!settings.download) {
      for (const btn of document.querySelectorAll('.xvd-btn')) btn.remove();
    } else {
      injectButtons();
    }
  }

  chrome.storage.sync.get(settings, (stored) => {
    Object.assign(settings, stored);
    applySettings();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if ('download' in changes) {
      settings.download = changes.download.newValue;
      applySettings();
    }
  });

  // ---------- наблюдатель за DOM (троттлинг) ----------
  // X мутирует DOM почти на частоте кадров — прогоняем инъекцию кнопок не
  // чаще раза в SLOW_MS, чтобы не греть CPU.
  const SLOW_MS = 500;
  let scheduled = false;
  let lastRun = 0;

  function scheduleTick() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      const wait = SLOW_MS - (performance.now() - lastRun);
      const run = () => {
        scheduled = false;
        lastRun = performance.now();
        injectButtons();
      };
      if (wait > 0) setTimeout(run, wait);
      else run();
    });
  }

  const observer = new MutationObserver(scheduleTick);

  function start() {
    applySettings();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
