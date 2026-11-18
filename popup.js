'use strict';

const DEFAULTS = { download: true, translate: true, copyImage: true, targetLang: 'ru' };

chrome.storage.sync.get(DEFAULTS, (settings) => {
  for (const key of ['download', 'translate', 'copyImage']) {
    const input = document.getElementById(key);
    if (!input) continue;
    input.checked = Boolean(settings[key]);
    input.addEventListener('change', () => {
      chrome.storage.sync.set({ [key]: input.checked });
    });
  }

  const langSelect = document.getElementById('targetLang');
  if (langSelect) {
    const saved = settings.targetLang || 'ru';
    langSelect.value = saved;
    if (!langSelect.value) langSelect.value = 'ru';
    langSelect.addEventListener('change', () => {
      chrome.storage.sync.set({ targetLang: langSelect.value });
    });
  }
});

const dotEl = document.getElementById('status-dot');
const vramNameEl = document.getElementById('vram-name');
const pillEl = document.getElementById('state-pill');
const unloadBtn = document.getElementById('unload-btn');
const barSysEl = document.getElementById('bar-sys');
const barModelEl = document.getElementById('bar-model');
const loadedMemEl = document.getElementById('loaded-mem');
const loadedSubEl = document.getElementById('loaded-sub');
const freeMemEl = document.getElementById('free-mem');
const freeSubEl = document.getElementById('free-sub');

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const rem = String(s % 60).padStart(2, '0');
  return `${m}:${rem}`;
}

function formatMem(mb) {
  const val = Math.max(0, Number(mb) || 0);
  if (val >= 1024) {
    return (val / 1024).toFixed(1) + ' ГБ';
  }
  return Math.round(val) + ' МБ';
}

function renderStatus(resp) {
  dotEl.className = 'status-dot';
  pillEl.className = 'state-pill';
  loadedMemEl.className = 'metric-value';
  barModelEl.className = 'mem-seg mem-seg-model';

  if (!resp || !resp.ok) {
    dotEl.classList.add('is-offline');
    pillEl.classList.add('is-offline');
    pillEl.textContent = 'Мост офлайн';
    unloadBtn.hidden = true;
    loadedMemEl.textContent = '—';
    loadedSubEl.textContent = '127.0.0.1:18791 недоступен';
    freeMemEl.textContent = '—';
    freeSubEl.textContent = 'запустите bridge/install.sh';
    barSysEl.style.width = '0%';
    barModelEl.style.width = '0%';
    return;
  }

  if (vramNameEl) {
    if (resp && typeof resp.model === 'string' && resp.model.includes('2B')) {
      vramNameEl.textContent = 'Bonsai 2 · 2B';
    } else {
      vramNameEl.textContent = 'Bonsai 2 · 4B';
    }
  }

  const fileMB = resp.model_file_mb || 1156;
  const modelMB = resp.model_vram_mb || 0;
  const totalMB = resp.mem_total_mb || 0;
  const freeMB = resp.mem_free_mb || 0;
  const gpuMB = resp.gpu_in_use_mb || 0;

  if (resp.state === 'loaded') {
    dotEl.classList.add('is-loaded');
    pillEl.classList.add('is-loaded');
    pillEl.textContent = '⏱ ' + formatDuration(resp.idle_remaining_sec);
    unloadBtn.hidden = false;
    unloadBtn.disabled = false;

    loadedMemEl.classList.add('is-loaded');
    loadedMemEl.textContent = '~' + formatMem(modelMB || fileMB);
    loadedSubEl.textContent = 'активна в VRAM';
  } else if (resp.state === 'loading') {
    dotEl.classList.add('is-loading');
    pillEl.classList.add('is-loading');
    pillEl.textContent = 'Загрузка…';
    unloadBtn.hidden = true;

    barModelEl.classList.add('is-loading');
    loadedMemEl.classList.add('is-loading');
    loadedMemEl.textContent = '~' + formatMem(modelMB || fileMB);
    loadedSubEl.textContent = 'загрузка в VRAM…';
  } else {
    pillEl.textContent = 'Выгружена';
    unloadBtn.hidden = true;

    loadedMemEl.textContent = '0 МБ';
    loadedSubEl.textContent = 'не в VRAM · вес ' + fileMB + ' МБ';
  }

  if (totalMB > 0) {
    const usedMB = Math.max(0, totalMB - freeMB);
    freeMemEl.textContent = formatMem(freeMB);
    freeSubEl.textContent = `занято ${formatMem(usedMB)} из ${formatMem(totalMB)}`;

    const activeModelMB = resp.state === 'unloaded' ? 0 : Math.min(usedMB, modelMB || fileMB);
    const sysOnlyMB = Math.max(0, usedMB - activeModelMB);

    barSysEl.style.width = ((sysOnlyMB / totalMB) * 100).toFixed(1) + '%';
    barModelEl.style.width = ((activeModelMB / totalMB) * 100).toFixed(1) + '%';
  } else {
    freeMemEl.textContent = '—';
    freeSubEl.textContent = 'нет данных о памяти';
    barSysEl.style.width = '0%';
    barModelEl.style.width = '0%';
  }
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'llm_status' }, (resp) => {
    if (chrome.runtime.lastError) {
      renderStatus(null);
      return;
    }
    renderStatus(resp);
  });
}

unloadBtn.addEventListener('click', () => {
  unloadBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'llm_unload' }, (resp) => {
    if (chrome.runtime.lastError) {
      refreshStatus();
      return;
    }
    renderStatus(resp);
  });
});

refreshStatus();
setInterval(refreshStatus, 1500);
