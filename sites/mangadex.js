var SITE_ADAPTER = (function () {
  var cdnUrls = null;

  return {
    name: 'mangadex',
    imageSelector: 'div.md--page img',

    // Fetches image URLs from MangaDex API before scanning starts.
    init: async function () {
      var m = location.pathname.match(/\/chapter\/([^/]+)/);
      if (!m) return;
      try {
        var resp = await fetch('https://api.mangadex.org/at-home/server/' + m[1]);
        var data = await resp.json();
        var base = data.baseUrl;
        var hash = data.chapter.hash;
        cdnUrls = data.chapter.data.map(function (f) { return base + '/data/' + hash + '/' + f; });
        console.log('[MangaUpscaler] MangaDex loaded', cdnUrls.length, 'page URLs');
      } catch (e) {
        console.error('[MangaUpscaler] MangaDex API error:', e);
      }
    },

    // Returns the CDN URL for this img based on its position in the page list.
    resolveImage: function (img) {
      if (!cdnUrls || img.naturalHeight === 0) return null;
      var imgs = Array.from(document.querySelectorAll('div.md--page img'));
      var idx = imgs.indexOf(img);
      if (idx < 0 || idx >= cdnUrls.length) return null;
      return cdnUrls[idx];
    },

    setupImage: function (img) {},

    getLayoutCSS: function (fullWidth) { return null; },

    shouldRescanOnSrcChange: function (img) {
      return !!(img.src && img.src.startsWith('blob:') && img.naturalHeight > 0);
    },

    // Returns a stable ID for the current chapter (ignoring page number in URL)
    getChapterId: function () {
      var m = location.pathname.match(/\/chapter\/([^/]+)/);
      return m ? m[1] : location.pathname;
    },

    reset: function () {
      cdnUrls = null;
    },
  };
})();
