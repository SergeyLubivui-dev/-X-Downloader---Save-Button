// X Downloader – Save & Local Bonsai 2 Translate — isolated world.
// 1. Копит карту mediaId/tweetId -> mp4 и полные тексты постов (включая скрытый
//    текст под "Show more" из GraphQL/React Fiber).
// 2. Вставляет кнопки Download и Translate в обёртках .xvd-action-slot (корректно
//    выровненные как в ленте/комментариях, так и в фокальном статусе .r-h3s6tt).
// 3. Плавно подменяет символы текста по миллисекундам и размещает бейдж
//    Bonsai 2 справа от родного блока "Translated from ..." (или над текстом).
(() => {
  'use strict';

  document.dispatchEvent(new CustomEvent('xvd:teardown'));

  let tornDown = false;
  let idSeq = 0;
  let lookupSeq = 0;
  const settings = { download: true, translate: true, copyImage: true, targetLang: 'ru' };

  const LANG_LABELS = {
    ru: 'RU',
    en: 'EN',
    de: 'DE',
    es: 'ES',
    fr: 'FR',
    zh: 'ZH',
    ja: 'JA',
    ko: 'KO',
    tr: 'TR'
  };

  function langLabel() {
    return LANG_LABELS[settings.targetLang] || 'RU';
  }

  function translateButtonTitle() {
    return 'Перевести (' + langLabel() + ', Bonsai 2)';
  }

  let DEBUG = true;
  try { DEBUG = localStorage.getItem('xvdDebug') !== '0'; } catch (e) { /* нет доступа */ }
  function dlog() {
    if (DEBUG) console.info.apply(console, ['[XDL]', ...arguments]);
  }
  function dwarn() {
    console.warn.apply(console, ['[XDL]', ...arguments]);
  }

  // ---------- перехваченные ссылки на mp4 и полные тексты постов ----------

  const byMedia = new Map();
  const byTweet = new Map();
  const textByTweet = new Map();

  function onMediaEvent(e) {
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
  }

  function onTextsEvent(e) {
    let entries;
    try {
      entries = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    for (const { tweetId, text } of entries) {
      if (!tweetId || typeof text !== 'string' || !text) continue;
      const prev = textByTweet.get(tweetId);
      if (!prev || text.length > prev.length) {
        textByTweet.set(tweetId, text);
      }
    }
  }

  document.addEventListener('xvd:media', onMediaEvent);
  document.addEventListener('xvd:texts', onTextsEvent);
  document.dispatchEvent(new CustomEvent('xvd:ready'));

  function lookupFullText(tweetId, elemId) {
    const reqId = ++lookupSeq;
    let found = null;
    const onRes = (ev) => {
      try {
        const data = JSON.parse(ev.detail);
        if (data && data.reqId === reqId && typeof data.text === 'string' && data.text) {
          found = data.text;
        }
      } catch (err) { /* игнорируем */ }
    };
    document.addEventListener('xvd:lookup-text:res', onRes);
    try {
      document.dispatchEvent(
        new CustomEvent('xvd:lookup-text', {
          detail: JSON.stringify({ reqId, tweetId: tweetId || null, elemId: elemId || null })
        })
      );
    } finally {
      document.removeEventListener('xvd:lookup-text:res', onRes);
    }
    return found;
  }

  // ---------- иконки и создание кнопок ----------

  const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M14.4697 10.4697C14.7626 10.1768 15.2374 10.1768 15.5303 10.4697C15.8232 10.7626 15.8232 11.2374 15.5303 11.5303L12.5303 14.5303C12.2374 14.8232 11.7626 14.8232 11.4697 14.5303L8.46967 11.5303C8.17678 11.2374 8.17678 10.7626 8.46967 10.4697C8.76256 10.1768 9.23744 10.1768 9.53033 10.4697L11.25 12.1893V4C11.25 3.58579 11.5858 3.25 12 3.25C12.4142 3.25 12.75 3.58579 12.75 4V12.1893L14.4697 10.4697Z" fill="currentColor"></path><path d="M20.75 12C20.75 11.5858 20.4142 11.25 20 11.25C19.5858 11.25 19.25 11.5858 19.25 12C19.25 16.0041 16.0041 19.25 12 19.25C7.99593 19.25 4.75 16.0041 4.75 12C4.75 11.5858 4.41421 11.25 4 11.25C3.58579 11.25 3.25 11.5858 3.25 12C3.25 16.8325 7.16751 20.75 12 20.75C16.8325 20.75 20.75 16.8325 20.75 12Z" fill="currentColor"></path></svg>`;

  const TRANSLATE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M4 5.75H12.5M8.25 3.5V5.75M10.75 5.75C10.15 9.15 8.15 11.95 5.25 13.75M6.3 9.15C7.4 10.95 8.95 12.45 10.8 13.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.5 19.5L16.25 10.25L20 19.5M13.75 16.6H18.75" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const COPY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><rect x="9" y="9" width="11" height="11" rx="2.2" stroke="currentColor" stroke-width="1.8"/><path d="M5 15V6.5C5 5.12 6.12 4 7.5 4H16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

  const CHECK_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M5 12.5L9.5 17L19 7.5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  function stopBubble(el) {
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick']) {
      el.addEventListener(type, (ev) => ev.stopPropagation());
    }
  }

  function createActionButton(cls, label, title, iconHtml) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.setAttribute('aria-label', label);
    btn.title = title;
    btn.innerHTML = iconHtml;
    stopBubble(btn);
    return btn;
  }

  function createActionSlot(slotCls, btn) {
    const slot = document.createElement('div');
    slot.className = 'xvd-action-slot ' + slotCls;
    slot.appendChild(btn);
    return slot;
  }

  function flash(btn, cls) {
    btn.classList.add(cls);
    setTimeout(() => btn.classList.remove(cls), 1600);
  }

  // ---------- скачивание видео / GIF ----------

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

  function directVideoUrl(player) {
    const video = player.querySelector('video');
    if (!video) return null;
    const srcEl = video.querySelector('source');
    const src = video.currentSrc || video.src || (srcEl && srcEl.src) || '';
    return src.startsWith('https://video.twimg.com/') ? src : null;
  }

  async function onDownloadClick(ev, btn) {
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

  // ---------- перевод текста постов (Bonsai 2 4B) ----------

  const translationState = new WeakMap();

  function getTweetTextElements(article) {
    return Array.from(article.querySelectorAll('[data-testid="tweetText"]')).filter(
      (el) => !el.classList.contains('xvd-translated-block')
    );
  }

  function extractTweetText(el) {
    let out = '';
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue || '';
        return;
      }
      if (!(node instanceof Element)) return;
      if (
        node.classList.contains('xvd-translated-block') ||
        node.classList.contains('xvd-tr-bar') ||
        node.classList.contains('xvd-tr-inline-chip') ||
        node.classList.contains('xvd-tr-toggle')
      ) {
        return;
      }
      const tag = node.tagName;
      if (tag === 'IMG') {
        out += node.getAttribute('alt') || '';
        return;
      }
      if (tag === 'BR') {
        out += '\n';
        return;
      }
      for (const child of node.childNodes) {
        walk(child);
      }
    };
    walk(el);
    return out;
  }

  function getNativeTranslateBar(origEl) {
    const prev = origEl.previousElementSibling;
    if (!prev || prev.tagName !== 'DIV') return null;
    if (
      prev.hasAttribute('data-testid') ||
      prev.classList.contains('xvd-tr-bar') ||
      prev.classList.contains('xvd-translated-block')
    ) {
      return null;
    }
    if (!prev.querySelector('button') && !prev.querySelector('svg')) {
      return null;
    }
    return prev;
  }

  function resolveTweetIdForElement(origEl, article) {
    const quoteCard = origEl.closest('div[role="link"]');
    if (quoteCard) {
      const qLink = quoteCard.querySelector('a[href*="/status/"]');
      const qm = qLink && (qLink.getAttribute('href') || '').match(/\/status\/(\d+)/);
      return qm ? qm[1] : null;
    }

    const timeLink = article.querySelector('a[href*="/status/"] time')?.closest('a');
    if (timeLink) {
      const tm = (timeLink.getAttribute('href') || '').match(/\/status\/(\d+)/);
      if (tm) return tm[1];
    }

    for (const a of article.querySelectorAll('a[href*="/status/"]')) {
      if (a.closest('div[role="link"]')) continue;
      const m = (a.getAttribute('href') || '').match(/\/status\/(\d+)/);
      if (m) return m[1];
    }

    const um = location.pathname.match(/^\/[^/]+\/status\/(\d+)/);
    return um ? um[1] : null;
  }

  async function getFullSourceText(origEl, article) {
    const domText = extractTweetText(origEl);
    const parent = origEl.parentElement;
    const showMoreEls = parent
      ? Array.from(parent.querySelectorAll('[data-testid="tweet-text-show-more-link"]'))
      : [];
    const hasShowMore = showMoreEls.length > 0;
    const nativeBar = getNativeTranslateBar(origEl);

    if (!origEl.id) {
      origEl.id = 'xvd-tt-' + (++idSeq);
    }

    const tweetId = resolveTweetIdForElement(origEl, article);
    let apiText = tweetId ? textByTweet.get(tweetId) || null : null;

    if (!apiText || (hasShowMore && apiText.length <= domText.length)) {
      const fiberText = lookupFullText(tweetId, origEl.id);
      if (fiberText && (!apiText || fiberText.length > apiText.length)) {
        apiText = fiberText;
      }
    }

    if ((!apiText || (hasShowMore && apiText.length <= domText.length)) && hasShowMore && tweetId) {
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'resolve_text', tweetId });
        if (resp && typeof resp.text === 'string' && resp.text && (!apiText || resp.text.length > apiText.length)) {
          apiText = resp.text;
        }
      } catch (err) { /* фолбэк на domText */ }
    }

    const useApi =
      Boolean(apiText) && (hasShowMore || apiText.length > domText.length + 8 || Boolean(nativeBar));

    return {
      sourceText: useApi ? apiText : domText,
      domText,
      showMoreEls
    };
  }

  function collectLinks(el) {
    const map = new Map();
    for (const a of el.querySelectorAll('a[href]')) {
      const label = (a.textContent || '').trim();
      const href = a.getAttribute('href') || a.href;
      if (!label || !href || map.has(label)) continue;
      map.set(label, href);
    }
    return map;
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function renderTranslatedContent(container, text, linkMap) {
    container.textContent = '';

    const keys = Array.from(linkMap.keys())
      .filter((k) => k.length >= 2)
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex);

    const patterns = [];
    if (keys.length) patterns.push(keys.join('|'));
    patterns.push('https?:\\/\\/[^\\s<>"\')\\]}]+');
    patterns.push('@[A-Za-z0-9_]{1,15}');
    patterns.push('#[\\p{L}\\p{N}_]+');

    const tokenRe = new RegExp('(' + patterns.join('|') + ')', 'gu');
    let lastIndex = 0;

    for (const match of text.matchAll(tokenRe)) {
      const idx = match.index ?? 0;
      if (idx > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, idx)));
      }
      const tok = match[0];
      let href = linkMap.get(tok) || null;
      if (!href) {
        if (tok.startsWith('http://') || tok.startsWith('https://')) {
          href = tok;
        } else if (tok.startsWith('@')) {
          href = 'https://x.com/' + encodeURIComponent(tok.slice(1));
        } else if (tok.startsWith('#')) {
          href = 'https://x.com/hashtag/' + encodeURIComponent(tok.slice(1));
        }
      }

      if (href) {
        const a = document.createElement('a');
        a.className = 'xvd-tr-link';
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = tok;
        stopBubble(a);
        a.addEventListener('click', (ev) => ev.stopPropagation());
        container.appendChild(a);
      } else {
        container.appendChild(document.createTextNode(tok));
      }
      lastIndex = idx + tok.length;
    }

    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function cancelItemAnimation(item) {
    if (!item) return;
    if (item.animFrameId) {
      cancelAnimationFrame(item.animFrameId);
      item.animFrameId = 0;
    }
    if (item.animTimerId) {
      clearTimeout(item.animTimerId);
      item.animTimerId = 0;
    }
  }

  function animateCharacterMorph(item, fromText, toText, durationMs, onDone) {
    cancelItemAnimation(item);
    const fromChars = Array.from(fromText || '');
    const toChars = Array.from(toText || '');
    if (toChars.length === 0 || durationMs <= 0) {
      onDone();
      return;
    }

    const el = item.trEl;
    el.textContent = '';
    const inSpan = document.createElement('span');
    inSpan.className = 'xvd-anim-in';
    const tailSpan = document.createElement('span');
    tailSpan.className = 'xvd-anim-tail';
    tailSpan.textContent = fromChars.join('');
    el.appendChild(inSpan);
    el.appendChild(tailSpan);

    const finish = () => {
      cancelItemAnimation(item);
      if (!tornDown && el.isConnected) onDone();
    };

    const startTs = performance.now();
    const step = (now) => {
      if (tornDown || !el.isConnected) {
        cancelItemAnimation(item);
        return;
      }
      const elapsed = Math.max(0, now - startTs);
      const rawT = Math.min(1, elapsed / durationMs);
      const eased = 1 - Math.pow(1 - rawT, 2.2);
      const toCount = Math.floor(eased * toChars.length);
      const fromIdx = Math.floor(eased * fromChars.length);

      inSpan.textContent = toChars.slice(0, toCount).join('');
      tailSpan.textContent = fromChars.slice(fromIdx).join('');

      if (rawT < 1) {
        item.animFrameId = requestAnimationFrame(step);
      } else {
        finish();
      }
    };

    item.animTimerId = setTimeout(finish, durationMs + 120);
    item.animFrameId = requestAnimationFrame(step);
  }

  function createHeaderToggle(firstItem, targetLang, onToggle) {
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'xvd-tr-toggle';
    stopBubble(toggleBtn);
    toggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onToggle();
    });

    const metaEl = document.createElement('span');
    metaEl.className = 'xvd-tr-meta';

    const nativeBar = getNativeTranslateBar(firstItem.origEl);
    let headerEl;
    if (nativeBar) {
      headerEl = document.createElement('span');
      headerEl.className = 'xvd-tr-inline-chip';
      const sep = document.createElement('span');
      sep.className = 'xvd-tr-sep';
      sep.textContent = '·';
      headerEl.appendChild(sep);
      headerEl.appendChild(metaEl);
      headerEl.appendChild(toggleBtn);
      nativeBar.appendChild(headerEl);
    } else {
      headerEl = document.createElement('div');
      headerEl.className = 'xvd-tr-bar';
      headerEl.dir = 'ltr';
      headerEl.innerHTML = TRANSLATE_ICON;
      headerEl.appendChild(metaEl);
      headerEl.appendChild(toggleBtn);
      firstItem.origEl.insertAdjacentElement('beforebegin', headerEl);
    }

    return { headerEl, metaEl, toggleBtn, targetLang };
  }

  function cleanupArticleTranslation(article, btn) {
    const state = translationState.get(article);
    if (state) {
      for (const item of state.items) {
        cancelItemAnimation(item);
        item.origEl.classList.remove('xvd-orig-hidden');
        for (const sm of item.showMoreEls || []) {
          sm.classList.remove('xvd-orig-hidden');
        }
        if (item.trEl && item.trEl.parentNode) item.trEl.remove();
      }
      if (state.headerEl && state.headerEl.parentNode) {
        state.headerEl.remove();
      }
      translationState.delete(article);
    }
    if (btn) {
      btn.classList.remove('xvd-tr-active');
      btn.title = translateButtonTitle();
    }
  }

  function setShowingTranslation(btn, state, showing, morphMs) {
    state.showingTranslation = showing;
    for (const item of state.items) {
      cancelItemAnimation(item);
      item.origEl.classList.toggle('xvd-orig-hidden', showing);
      for (const sm of item.showMoreEls || []) {
        sm.classList.toggle('xvd-orig-hidden', showing);
      }
      item.trEl.hidden = !showing;

      if (showing) {
        const dur =
          morphMs > 0
            ? morphMs
            : Math.min(680, Math.max(240, Array.from(item.translatedText).length * 3.2));
        animateCharacterMorph(item, item.domText, item.translatedText, dur, () => {
          renderTranslatedContent(item.trEl, item.translatedText, item.linkMap);
        });
      }
    }

    const lbl = LANG_LABELS[state.targetLang] || 'RU';
    if (state.metaEl) {
      state.metaEl.textContent = showing ? 'Bonsai 2 (' + lbl + ')' : 'Оригинал';
    }
    if (state.toggleBtn) {
      state.toggleBtn.textContent = showing
        ? 'Показать оригинал'
        : 'Перевести (' + langLabel() + ')';
    }
    if (btn) {
      btn.classList.toggle('xvd-tr-active', showing);
      btn.title = showing ? 'Показать оригинал' : translateButtonTitle();
    }
  }

  async function translateOrToggleArticle(article, btn) {
    if (!article || !btn || btn.classList.contains('xvd-loading')) return;

    const origEls = getTweetTextElements(article);
    if (!origEls.length) return;

    const targetLang = settings.targetLang || 'ru';
    const existing = translationState.get(article);

    // Если уже показан перевод и кликнули переключить обратно — делаем это мгновенно
    if (
      existing &&
      existing.showingTranslation &&
      existing.items.every((it) => it.origEl.isConnected && it.trEl.isConnected)
    ) {
      setShowingTranslation(btn, existing, false, 0);
      return;
    }

    btn.classList.add('xvd-loading');
    const prevTitle = btn.title;
    btn.title = 'Загрузка Bonsai 2 в VRAM и перевод…';
    try {
      const extracted = await Promise.all(origEls.map((el) => getFullSourceText(el, article)));
      const texts = extracted.map((x) => x.sourceText);
      const sourceKey = targetLang + '\u0000' + texts.join('\u0000');

      if (
        existing &&
        existing.sourceKey === sourceKey &&
        existing.items.every((it) => it.origEl.isConnected && it.trEl.isConnected)
      ) {
        btn.classList.remove('xvd-loading');
        setShowingTranslation(btn, existing, true, 180);
        return;
      }

      cleanupArticleTranslation(article, btn);

      const resp = await chrome.runtime.sendMessage({
        type: 'translate',
        texts,
        targetLang
      });
      if (!resp || !resp.ok || !Array.isArray(resp.translations)) {
        throw new Error((resp && resp.error) || 'translate failed');
      }

      dlog('перевод готов:', { fresh: resp.loaded_fresh, ms: resp.elapsed_ms, targetLang });

      const items = [];
      for (let i = 0; i < origEls.length; i++) {
        const origEl = origEls[i];
        const trEl = document.createElement('div');
        trEl.className = (origEl.className ? origEl.className + ' ' : '') + 'xvd-translated-block';
        const inlineStyle = origEl.getAttribute('style');
        if (inlineStyle) trEl.setAttribute('style', inlineStyle);
        trEl.dir = 'auto';
        trEl.lang = targetLang;

        const translated = typeof resp.translations[i] === 'string' ? resp.translations[i] : texts[i];
        origEl.insertAdjacentElement('afterend', trEl);

        items.push({
          origEl,
          trEl,
          domText: extracted[i].domText,
          translatedText: translated,
          linkMap: collectLinks(origEl),
          showMoreEls: extracted[i].showMoreEls,
          animFrameId: 0,
          animTimerId: 0
        });
      }

      const header = createHeaderToggle(items[0], targetLang, () => {
        translateOrToggleArticle(article, btn);
      });

      const state = {
        sourceKey,
        targetLang,
        items,
        headerEl: header.headerEl,
        metaEl: header.metaEl,
        toggleBtn: header.toggleBtn,
        showingTranslation: true
      };

      translationState.set(article, state);
      setShowingTranslation(btn, state, true, 0);
      flash(btn, 'xvd-ok');
    } catch (err) {
      const msg = (err && err.message) || String(err);
      dwarn('перевод не удался:', msg);
      btn.title = 'Ошибка перевода: ' + msg || prevTitle;
      flash(btn, 'xvd-err');
    } finally {
      btn.classList.remove('xvd-loading');
    }
  }

  function onTranslateClick(ev, btn) {
    ev.preventDefault();
    ev.stopPropagation();
    const article = btn.closest('article');
    translateOrToggleArticle(article, btn);
  }

  // ---------- копирование картинок в буфер обмена ----------

  function upgradeTwimgUrl(src) {
    if (!src || !src.includes('pbs.twimg.com/media/')) return src;
    try {
      const u = new URL(src);
      u.searchParams.set('name', 'large');
      return u.toString();
    } catch (err) {
      return src;
    }
  }

  async function fetchImageBlob(url) {
    try {
      const resp = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (resp.ok) return await resp.blob();
    } catch (err) {
      // фолбэк через background service worker
    }
    const resp = await chrome.runtime.sendMessage({ type: 'fetch_image_data_url', url });
    if (!resp || !resp.ok || !resp.dataUrl) {
      throw new Error('image fetch failed');
    }
    return (await fetch(resp.dataUrl)).blob();
  }

  async function blobToPngBlob(blob) {
    if (blob.type === 'image/png') return blob;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');

    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(blob);
      try {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        ctx.drawImage(bmp, 0, 0);
      } finally {
        bmp.close();
      }
    } else {
      const objUrl = URL.createObjectURL(blob);
      try {
        const img = await new Promise((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = objUrl;
        });
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        ctx.drawImage(img, 0, 0);
      } finally {
        URL.revokeObjectURL(objUrl);
      }
    }

    return new Promise((resolve, reject) => {
      canvas.toBlob((png) => {
        if (png) resolve(png);
        else reject(new Error('png encode failed'));
      }, 'image/png');
    });
  }

  async function imageUrlToPngBlob(rawSrc) {
    const hiResUrl = upgradeTwimgUrl(rawSrc);
    let blob;
    try {
      blob = await fetchImageBlob(hiResUrl);
    } catch (err) {
      if (hiResUrl === rawSrc) throw err;
      blob = await fetchImageBlob(rawSrc);
    }
    return blobToPngBlob(blob);
  }

  function findPhotoImageSrc(photoEl) {
    const imgs = Array.from(photoEl.querySelectorAll('img[src]'));
    const mediaImg = imgs.find((im) => im.src.includes('pbs.twimg.com/media/'));
    return mediaImg ? mediaImg.src : '';
  }

  async function onCopyImageClick(ev, btn) {
    ev.preventDefault();
    ev.stopPropagation();
    if (btn.classList.contains('xvd-loading')) return;

    const photoEl = btn.closest('[data-testid="tweetPhoto"]');
    if (!photoEl) return;
    const src = findPhotoImageSrc(photoEl);
    if (!src) return;

    btn.classList.add('xvd-loading');
    btn.title = 'Копирование…';
    try {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) {
        throw new Error('clipboard API unavailable');
      }
      // Передаём Promise<Blob> синхронно в ClipboardItem, чтобы сохранить user activation
      const pngPromise = imageUrlToPngBlob(src);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })]);

      btn.classList.remove('xvd-loading');
      btn.classList.add('xvd-ok');
      btn.innerHTML = CHECK_ICON;
      btn.title = 'Скопировано в буфер!';
      setTimeout(() => {
        if (!btn.isConnected) return;
        btn.classList.remove('xvd-ok');
        btn.innerHTML = COPY_ICON;
        btn.title = 'Скопировать картинку';
      }, 1400);
    } catch (err) {
      dwarn('копирование картинки не удалось:', (err && err.message) || err);
      btn.title = 'Не удалось скопировать';
      flash(btn, 'xvd-err');
    } finally {
      btn.classList.remove('xvd-loading');
    }
  }

  function makeCopyImageButton() {
    const btn = createActionButton(
      'xvd-copy-img-btn',
      'Скопировать картинку',
      'Скопировать картинку',
      COPY_ICON
    );
    // Останавливаем клик прямо на кнопке, чтобы родительский <a href=".../photo/1"> не открывал лайтбокс
    btn.addEventListener('click', (ev) => onCopyImageClick(ev, btn));
    return btn;
  }

  function injectCopyImageButtons() {
    if (tornDown || !settings.copyImage) return;
    for (const photoEl of document.querySelectorAll('[data-testid="tweetPhoto"]')) {
      if (!photoEl.offsetParent) continue;
      if (photoEl.querySelector('.xvd-copy-img-btn')) continue;
      if (photoEl.querySelector('[data-testid="videoPlayer"], video')) continue;
      if (!findPhotoImageSrc(photoEl)) continue;
      photoEl.appendChild(makeCopyImageButton());
    }
  }

  // делегированный клик по кнопкам
  function onDocClick(ev) {
    if (!(ev.target instanceof Element)) return;
    const trBtn = ev.target.closest('.xvd-tr-btn');
    if (trBtn) {
      onTranslateClick(ev, trBtn);
      return;
    }
    const dlBtn = ev.target.closest('.xvd-btn');
    if (dlBtn) onDownloadClick(ev, dlBtn);
  }
  document.addEventListener('click', onDocClick);

  function findActionGroup(article) {
    return (
      article.querySelector('div[role="group"]:has([data-testid="reply"], [data-testid="like"])') ||
      article.querySelector('div[role="group"]')
    );
  }

  function ensureButtonInSlot(group, btn, slotCls) {
    if (!btn) return null;
    if (btn.parentElement && btn.parentElement.classList.contains('xvd-action-slot')) {
      btn.parentElement.classList.add(slotCls);
      return btn.parentElement;
    }
    const slot = createActionSlot(slotCls, btn);
    group.appendChild(slot);
    return slot;
  }

  function injectButtons() {
    if (tornDown || (!settings.download && !settings.translate && !settings.copyImage)) return;

    if (settings.download || settings.translate) {
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        if (!article.offsetParent) continue;
        const group = findActionGroup(article);
        if (!group) continue;

        let dlBtn = group.querySelector('.xvd-btn');
        let trBtn = group.querySelector('.xvd-tr-btn');

        if (dlBtn && !dlBtn.title) {
          dlBtn.title = 'Скачать видео / GIF';
        }

        let dlSlot = dlBtn ? ensureButtonInSlot(group, dlBtn, 'xvd-dl-slot') : null;
        let trSlot = trBtn ? ensureButtonInSlot(group, trBtn, 'xvd-tr-slot') : null;

        if (settings.download && !dlBtn && article.querySelector('[data-testid="videoPlayer"]')) {
          dlBtn = createActionButton('xvd-btn', 'Download video', 'Скачать видео / GIF', DOWNLOAD_ICON);
          dlSlot = createActionSlot('xvd-dl-slot', dlBtn);
          group.appendChild(dlSlot);
        }

        if (settings.translate && !trBtn && getTweetTextElements(article).length > 0) {
          trBtn = createActionButton(
            'xvd-tr-btn',
            'Translate post',
            translateButtonTitle(),
            TRANSLATE_ICON
          );
          trSlot = createActionSlot('xvd-tr-slot', trBtn);
          if (dlSlot) {
            group.insertBefore(trSlot, dlSlot);
          } else {
            group.appendChild(trSlot);
          }
        }

        // Гарантируем, что слот перевода всегда стоит строго слева от слота скачивания
        if (trSlot && dlSlot && trSlot.nextElementSibling !== dlSlot) {
          group.insertBefore(trSlot, dlSlot);
        }
      }
    }

    injectCopyImageButtons();
  }

  // ---------- настройки ----------

  function refreshTranslateLabels() {
    for (const btn of document.querySelectorAll('.xvd-tr-btn')) {
      if (!btn.classList.contains('xvd-tr-active') && !btn.classList.contains('xvd-loading')) {
        btn.title = translateButtonTitle();
      }
    }
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const state = translationState.get(article);
      if (state && !state.showingTranslation && state.toggleBtn) {
        state.toggleBtn.textContent = 'Перевести (' + langLabel() + ')';
      }
    }
  }

  function applySettings() {
    if (tornDown) return;
    if (!settings.download) {
      for (const el of document.querySelectorAll('.xvd-dl-slot, .xvd-btn')) el.remove();
    }
    if (!settings.copyImage) {
      for (const el of document.querySelectorAll('.xvd-copy-img-btn')) el.remove();
    }
    if (!settings.translate) {
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        cleanupArticleTranslation(article, null);
      }
      for (const el of document.querySelectorAll('.xvd-orig-hidden')) {
        el.classList.remove('xvd-orig-hidden');
      }
      for (const el of document.querySelectorAll(
        '.xvd-translated-block, .xvd-tr-bar, .xvd-tr-inline-chip, .xvd-tr-toggle, .xvd-tr-slot, .xvd-tr-btn'
      )) {
        el.remove();
      }
    }
    if (settings.download || settings.translate || settings.copyImage) {
      injectButtons();
      refreshTranslateLabels();
    }
  }

  chrome.storage.sync.get(settings, (stored) => {
    if (tornDown) return;
    Object.assign(settings, stored);
    if (!LANG_LABELS[settings.targetLang]) settings.targetLang = 'ru';
    applySettings();
  });

  function onStorageChange(changes, area) {
    if (tornDown || area !== 'sync') return;
    let changed = false;
    if ('download' in changes) {
      settings.download = changes.download.newValue;
      changed = true;
    }
    if ('translate' in changes) {
      settings.translate = changes.translate.newValue;
      changed = true;
    }
    if ('copyImage' in changes) {
      settings.copyImage = changes.copyImage.newValue;
      changed = true;
    }
    if ('targetLang' in changes) {
      const nextLang = changes.targetLang.newValue;
      settings.targetLang = LANG_LABELS[nextLang] ? nextLang : 'ru';
      changed = true;
    }
    if (changed) applySettings();
  }
  chrome.storage.onChanged.addListener(onStorageChange);

  // ---------- наблюдатель за DOM (троттлинг) ----------
  const SLOW_MS = 500;
  let scheduled = false;
  let lastRun = 0;

  function scheduleTick() {
    if (tornDown || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      if (tornDown) return;
      const wait = SLOW_MS - (performance.now() - lastRun);
      const run = () => {
        scheduled = false;
        if (tornDown) return;
        lastRun = performance.now();
        injectButtons();
      };
      if (wait > 0) setTimeout(run, wait);
      else run();
    });
  }

  const observer = new MutationObserver(scheduleTick);

  document.addEventListener(
    'xvd:teardown',
    () => {
      tornDown = true;
      observer.disconnect();
      document.removeEventListener('xvd:media', onMediaEvent);
      document.removeEventListener('xvd:texts', onTextsEvent);
      document.removeEventListener('click', onDocClick);
      chrome.storage.onChanged.removeListener(onStorageChange);
    },
    { once: true }
  );

  function start() {
    if (tornDown) return;
    applySettings();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
