(function () {
  console.log('[MangaUpscaler] content script loaded, url:', location.href);

  const processed = new WeakSet();
  const cache = new Map();
  let cacheBytes = 0;
  const queue = [];
  let running = false;

  function getSegment() {
    const parts = window.location.pathname.split('/');
    return parts[parts.length - 1] || parts[parts.length - 2];
  }

  function waitForLoad(img) {
    return new Promise((resolve) => {
      if (img.complete && img.naturalHeight > 0) return resolve();
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    });
  }

  function showLoading(img) {
    img.style.filter = 'blur(6px) brightness(0.4)';
    img.style.transition = 'filter 0.4s';
  }

  function applyResult(img, result) {
    img.src = result;
    img.style.filter = '';
    img.style.imageRendering = 'auto';
  }

  async function runQueue() {
    if (running || queue.length === 0) return;
    running = true;
    while (queue.length > 0) {
      const img = queue.shift();
      if (!img.isConnected) continue;
      const originalSrc = img.src;
      if (cache.has(originalSrc)) {
        applyResult(img, cache.get(originalSrc));
        continue;
      }
      console.log('[MangaUpscaler] processing:', originalSrc.slice(0, 80));
      try {
        const requestId = crypto.randomUUID();
        const result = await new Promise((resolve, reject) => {
          function handler(msg) {
            if (msg.type === 'upscaleResult' && msg.requestId === requestId) {
              chrome.runtime.onMessage.removeListener(handler);
              if (msg.error) reject(new Error(msg.error));
              else resolve(msg.result);
            }
          }
          chrome.runtime.onMessage.addListener(handler);
          chrome.runtime.sendMessage({ type: 'upscale', requestId, url: originalSrc, segment: getSegment() }, () => {
            if (chrome.runtime.lastError) {}
          });
        });
        const blob = await fetch(result).then(r => r.blob());
        const blobUrl = URL.createObjectURL(blob);
        cacheBytes += blob.size;
        cache.set(originalSrc, blobUrl);
        console.log('[MangaUpscaler] done, replacing image');
        applyResult(img, blobUrl);
      } catch (e) {
        console.error('[MangaUpscaler] error processing image:', e);
      }
    }
    running = false;
  }

  function isMangaImage(img) {
    if (!img.src || img.src.startsWith('data:')) return false;
    if (/\.(gif|svg|webp)$/i.test(img.src)) return false;
    if (img.src.includes(location.hostname)) return false;
    return true;
  }

  async function scanImages() {
    const images = document.querySelectorAll('img.ImageContainer');
    console.log('[MangaUpscaler] scan found', images.length, 'ImageContainer images');
    for (const img of images) {
      if (cache.has(img.src)) {
        applyResult(img, cache.get(img.src));
        continue;
      }
      if (processed.has(img)) continue;
      if (!isMangaImage(img)) continue;
      processed.add(img);
      await waitForLoad(img);
      if (img.naturalHeight === 0) continue;
      showLoading(img);
      queue.push(img);
      runQueue();
    }
  }

  scanImages();

  const obs = new MutationObserver((mutations) => {
    let needsScan = false;
    for (const m of mutations) {
      if (m.type === 'childList') needsScan = true;
      if (m.type === 'attributes' && m.attributeName === 'src') {
        const img = m.target;
        if (cache.has(img.src)) {
          applyResult(img, cache.get(img.src));
        } else if (isMangaImage(img) && !processed.has(img)) {
          needsScan = true;
        }
      }
    }
    if (needsScan) scanImages();
  });
  obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'getCacheStats') {
      sendResponse({ count: cache.size, bytes: cacheBytes, queued: queue.length });
    }
  });
})();