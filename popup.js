'use strict';

const DEFAULTS = { download: true };

chrome.storage.sync.get(DEFAULTS, (settings) => {
  const input = document.getElementById('download');
  input.checked = Boolean(settings.download);
  input.addEventListener('change', () => {
    chrome.storage.sync.set({ download: input.checked });
  });
});
