(function () {
  console.log('[MangaUpscaler] content script loaded, url:', location.href);

  const BASE_CSS = [
    'section { max-width: none !important; }',
    '.content-wrapper { max-width: none !important; padding-left: 0 !important; padding-right: 0 !important; }',
    '.content-wrapper .row { margin-left: 0 !important; margin-right: 0 !important; }',
    '.content-wrapper [class*="col-"] { padding-left: 0 !important; padding-right: 0 !important; }',
  ].join(' ');

  function imgCSS(fullWidth) {
    return fullWidth
      ? 'img.ImageContainer { display: block !important; margin: 0 auto !important; width: 100% !important; }'
      : 'img.ImageContainer { display: block !important; margin: 0 auto !important; max-width: 100% !important; }';
  }

  const style = document.createElement('style');
  document.head.appendChild(style);

  function applyLayoutSetting(fullWidth) {
    style.textContent = BASE_CSS + ' ' + imgCSS(fullWidth);
  }

  chrome.storage.sync.get({ fullWidth: false }, ({ fullWidth }) => applyLayoutSetting(fullWidth));

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.fullWidth) applyLayoutSetting(changes.fullWidth.newValue);
  });

  // Width of 100% inmanga zoom in px. Increasing makes images bigger at default zoom.
  const ZOOM_REF_PX = 1200;
  const styleWatched = new WeakSet();

  function fixImageWidth(img) {
    const w = img.style.width;
    if (!w || !w.endsWith('%')) return;
    const px = Math.round(parseFloat(w) / 100 * ZOOM_REF_PX);
    img.style.width = px + 'px';
  }

  function watchImageStyle(img) {
    if (styleWatched.has(img)) return;
    styleWatched.add(img);
    fixImageWidth(img);
    new MutationObserver(() => fixImageWidth(img))
      .observe(img, { attributes: true, attributeFilter: ['style'] });
  }

  const processed = new WeakSet();
  const cache = new Map();
  let cacheBytes = 0;
  const queue = [];
  let activeCount = 0;
  const MAX_CONCURRENT = 1;

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

  async function processImage(img) {
    if (!img.isConnected) return;
    const originalSrc = img.src;
    if (cache.has(originalSrc)) {
      applyResult(img, cache.get(originalSrc));
      return;
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

  function runQueue() {
    while (queue.length > 0 && activeCount < MAX_CONCURRENT) {
      activeCount++;
      const img = queue.shift();
      processImage(img).finally(() => {
        activeCount--;
        runQueue();
      });
    }
  }

  function isMangaImage(img) {
    if (!img.src || img.src.startsWith('data:')) return false;
    if (/\.(gif|svg|webp)$/i.test(img.src)) return false;
    if (img.src.includes(location.hostname)) return false;
    return true;
  }

  let inmangaBaseUrl = null;
  function getInmangaBaseUrl() {
    if (inmangaBaseUrl) return inmangaBaseUrl;
    for (const script of document.scripts) {
      const match = script.textContent.match(/var pu = '([^']+)'/);
      if (match) { inmangaBaseUrl = match[1]; return inmangaBaseUrl; }
    }
    return null;
  }

  function getInmangaRealUrl(img) {
    if (!img.id || !img.classList.contains('noPageImage')) return null;
    const base = getInmangaBaseUrl();
    if (!base) return null;
    return base.replace('identification.jpg', img.id + '.jpg');
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

      // Pre-load inmanga placeholder images without waiting for scroll
      const realUrl = getInmangaRealUrl(img);
      if (realUrl) {
        processed.add(img);
        watchImageStyle(img);
        img.src = realUrl;
        await waitForLoad(img);
        if (img.naturalHeight === 0) continue;
        showLoading(img);
        queue.push(img);
        runQueue();
        continue;
      }

      if (!isMangaImage(img)) continue;
      processed.add(img);
      watchImageStyle(img);
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