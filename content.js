if (window.__mangaUpscalerInjected) {
  // Already running (e.g. manifest injection on chapter reload). Skip.
} else {
window.__mangaUpscalerInjected = true;
(function () {
  console.log('[MangaUpscaler] loaded on', location.hostname, '— site:', SITE_ADAPTER.name);

  // Layout CSS (site-specific)
  var layoutStyle = null;
  var layoutCSS = SITE_ADAPTER.getLayoutCSS;
  if (layoutCSS) {
    layoutStyle = document.createElement('style');
    document.head.appendChild(layoutStyle);
    function applyLayout(fullWidth) {
      var css = SITE_ADAPTER.getLayoutCSS(fullWidth);
      if (css) layoutStyle.textContent = css;
    }
    chrome.storage.sync.get({ fullWidth: false }, function (r) { applyLayout(r.fullWidth); });
    chrome.storage.onChanged.addListener(function (changes) {
      if (changes.fullWidth) applyLayout(changes.fullWidth.newValue);
    });
  }

  var processed = new WeakSet();
  var cache = new Map();   // CDN url → blob url
  var cacheBytes = 0;
  var queue = [];          // [{img, url}]
  var activeCount = 0;
  var MAX_CONCURRENT = 1;
  var generation = 0;      // incremented on chapter change to cancel in-flight requests

  function waitForLoad(img) {
    return new Promise(function (resolve) {
      if (img.complete && img.naturalHeight > 0) return resolve();
      var timer = setTimeout(resolve, 15000);
      img.addEventListener('load', function () { clearTimeout(timer); resolve(); }, { once: true });
      img.addEventListener('error', function () { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  function showLoading(img) {
    img.style.filter = 'blur(6px) brightness(0.4)';
    img.style.transition = 'filter 0.4s';
  }

  function applyResult(img, blobUrl) {
    console.log('[MangaUpscaler] applyResult gen=' + generation + ' src=' + blobUrl.slice(0, 40));
    img.src = blobUrl;
    img.style.filter = '';
    img.style.imageRendering = 'auto';
  }

  async function processImage(img, url) {
    var gen = generation;
    if (!img.isConnected) return;
    if (cache.has(url)) { applyResult(img, cache.get(url)); return; }
    console.log('[MangaUpscaler] processing:', url.slice(0, 80));
    try {
      var requestId = crypto.randomUUID();
      var result = await new Promise(function (resolve, reject) {
        function handler(msg) {
          if (msg.type === 'upscaleResult' && msg.requestId === requestId) {
            chrome.runtime.onMessage.removeListener(handler);
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg.result);
          }
        }
        chrome.runtime.onMessage.addListener(handler);
        chrome.runtime.sendMessage({ type: 'upscale', requestId: requestId, url: url }, function () {
          if (chrome.runtime.lastError) {}
        });
      });
      if (gen !== generation) return; // chapter changed while processing
      var blob = await fetch(result).then(function (r) { return r.blob(); });
      var blobUrl = URL.createObjectURL(blob);
      if (gen !== generation) return; // chapter changed while fetching blob
      cacheBytes += blob.size;
      cache.set(url, blobUrl);
      console.log('[MangaUpscaler] done, replacing image');
      applyResult(img, blobUrl);
    } catch (e) {
      console.error('[MangaUpscaler] error processing image:', e);
    }
  }

  function runQueue() {
    while (queue.length > 0 && activeCount < MAX_CONCURRENT) {
      activeCount++;
      var item = queue.shift();
      processImage(item.img, item.url).finally(function () {
        activeCount--;
        runQueue();
      });
    }
  }

  async function scanImages() {
    var images = document.querySelectorAll(SITE_ADAPTER.imageSelector);
    console.log('[MangaUpscaler] scan found', images.length, 'images');
    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      if (processed.has(img)) continue;

      var url = SITE_ADAPTER.resolveImage(img);
      if (!url) continue;

      if (cache.has(url)) { console.log('[MangaUpscaler] cache hit gen=' + generation + ' url=' + url.slice(0, 60)); applyResult(img, cache.get(url)); continue; }

      processed.add(img);
      SITE_ADAPTER.setupImage(img);
      await waitForLoad(img);
      if (img.naturalHeight === 0) continue;
      showLoading(img);
      queue.push({ img: img, url: url });
      runQueue();
    }
  }

  var scanPending = false;
  var scanScheduled = null;

  function scheduleScan() {
    if (scanScheduled) clearTimeout(scanScheduled);
    scanScheduled = setTimeout(function () {
      scanScheduled = null;
      if (scanPending) return;
      scanPending = true;
      scanImages().finally(function () { scanPending = false; });
    }, 200);
  }

  async function init() {
    if (SITE_ADAPTER.init) await SITE_ADAPTER.init();
    scanImages();
  }
  init();

  // SPA navigation detection: reset state and re-init when chapter changes
  function getChapterId() {
    return SITE_ADAPTER.getChapterId ? SITE_ADAPTER.getChapterId() : location.href;
  }
  var lastChapterId = getChapterId();
  var initTimer = null;

  function onNavigate() {
    var current = getChapterId();
    if (current === lastChapterId) return;
    console.log('[MangaUpscaler] onNavigate: ' + lastChapterId.slice(0, 8) + ' → ' + current.slice(0, 8) + ' gen=' + generation + ' cacheSize=' + cache.size);
    lastChapterId = current;
    // Cancel any pending scan and init so stale state can't be applied
    if (scanScheduled) { clearTimeout(scanScheduled); scanScheduled = null; }
    if (initTimer) { clearTimeout(initTimer); initTimer = null; }
    generation++;
    if (SITE_ADAPTER.reset) SITE_ADAPTER.reset();
    cache.clear();
    cacheBytes = 0;
    queue.length = 0;
    processed = new WeakSet();
    scanPending = false;
    document.querySelectorAll(SITE_ADAPTER.imageSelector).forEach(function (img) {
      img.style.transition = '';
      img.style.filter = 'blur(6px) brightness(0.4)';
    });
    initTimer = setTimeout(function () { initTimer = null; init(); }, 500);
  }

  // Intercept pushState so we reset before React even renders the new chapter
  var _origPushState = history.pushState.bind(history);
  history.pushState = function () { _origPushState.apply(history, arguments); onNavigate(); };
  window.addEventListener('popstate', onNavigate);
  setInterval(onNavigate, 100); // fallback for navigations we might miss (must be < MutationObserver debounce of 200ms)

  var obs = new MutationObserver(function (mutations) {
    var needsScan = false;
    var hadChildListChange = false;
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === 'childList') { needsScan = true; hadChildListChange = true; }
      if (m.type === 'attributes' && m.attributeName === 'src') {
        var img = m.target;
        if (!processed.has(img) && SITE_ADAPTER.shouldRescanOnSrcChange(img)) {
          needsScan = true;
        }
      }
    }
    // If all chapter images were removed from DOM, React is unmounting the chapter.
    // Clear cache immediately so the next scan (when new chapter images appear) won't get stale hits.
    if (hadChildListChange && cache.size > 0 && document.querySelectorAll(SITE_ADAPTER.imageSelector).length === 0) {
      console.log('[MangaUpscaler] all images removed, chapter transitioning — clearing cache gen=' + generation);
      generation++;
      if (SITE_ADAPTER.reset) SITE_ADAPTER.reset(); // clear cdnUrls so next scan won't resolve stale CDN URLs
      if (initTimer) { clearTimeout(initTimer); initTimer = null; }
      cache.clear();
      cacheBytes = 0;
      queue.length = 0;
      processed = new WeakSet();
      scanPending = false;
      if (scanScheduled) { clearTimeout(scanScheduled); scanScheduled = null; }
    }
    if (needsScan) scheduleScan();
  });
  obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg.type === 'getCacheStats') {
      sendResponse({ count: cache.size, bytes: cacheBytes, queued: queue.length });
    }
  });
})();
} // end else __mangaUpscalerInjected
