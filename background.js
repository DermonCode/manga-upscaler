let offscreenPromise = null;

function ensureOffscreen() {
  if (!offscreenPromise) {
    offscreenPromise = chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['DOM_SCRAPING'],
      justification: 'GPU inference for image upscaling',
    }).catch((e) => {
      if (!e.message?.includes('single')) {
        offscreenPromise = null;
        throw e;
      }
    });
  }
  return offscreenPromise;
}

chrome.webNavigation.onHistoryStateUpdated.addListener(function (details) {
  if (details.frameId !== 0) return;
  if (/^https?:\/\/mangadex\.org\/chapter\//.test(details.url)) {
    chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ['sites/mangadex.js', 'content.js'],
    }).catch(function () {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'upscale') {
    const tabId = sender.tab.id;
    console.log('[MangaUpscaler BG] upscale request from tab', tabId, msg.url.slice(0, 60));
    chrome.storage.sync.get({ scale: '2' }, ({ scale }) => {
      ensureOffscreen()
        .then(() => {
          chrome.runtime.sendMessage({
            type: 'process',
            tabId,
            requestId: msg.requestId,
            url: msg.url,
            scale,
          });
        })
        .catch((e) => {
          console.error('[MangaUpscaler BG] ensureOffscreen failed:', e.message);
          chrome.tabs.sendMessage(tabId, {
            type: 'upscaleResult',
            requestId: msg.requestId,
            error: e.message,
          });
        });
    });
  }

  if (msg.type === 'processed') {
    console.log('[MangaUpscaler BG] processed, sending result to tab', msg.tabId, msg.error || 'ok');
    chrome.tabs.sendMessage(msg.tabId, {
      type: 'upscaleResult',
      requestId: msg.requestId,
      result: msg.result,
      error: msg.error,
    });
  }
});