var SITE_ADAPTER = (function () {
  var baseUrl = null;
  var styleWatched = new WeakSet();
  var ZOOM_REF_PX = 1200;

  function getBaseUrl() {
    if (baseUrl) return baseUrl;
    for (var i = 0; i < document.scripts.length; i++) {
      var m = document.scripts[i].textContent.match(/var pu = '([^']+)'/);
      if (m) { baseUrl = m[1]; return baseUrl; }
    }
    return null;
  }

  function fixImageWidth(img) {
    var w = img.style.width;
    if (!w || !w.endsWith('%')) return;
    img.style.width = Math.round(parseFloat(w) / 100 * ZOOM_REF_PX) + 'px';
  }

  function isCdnSrc(src) {
    if (!src || src.startsWith('data:')) return false;
    if (/\.(gif|svg|webp)$/i.test(src)) return false;
    if (src.includes(location.hostname)) return false;
    return true;
  }

  return {
    name: 'inmanga',
    imageSelector: 'img.ImageContainer',

    // Resolves the CDN URL to upscale. May set img.src as side effect for placeholders.
    resolveImage: function (img) {
      if (img.classList.contains('noPageImage') && img.id) {
        var base = getBaseUrl();
        if (base) {
          var url = base.replace('identification.jpg', img.id + '.jpg');
          img.src = url;
          return url;
        }
      }
      return isCdnSrc(img.src) ? img.src : null;
    },

    setupImage: function (img) {
      if (styleWatched.has(img)) return;
      styleWatched.add(img);
      fixImageWidth(img);
      new MutationObserver(function () { fixImageWidth(img); })
        .observe(img, { attributes: true, attributeFilter: ['style'] });
    },

    getLayoutCSS: function (fullWidth) {
      var base = [
        'section { max-width: none !important; }',
        '.content-wrapper { max-width: none !important; padding-left: 0 !important; padding-right: 0 !important; }',
        '.content-wrapper .row { margin-left: 0 !important; margin-right: 0 !important; }',
        '.content-wrapper [class*="col-"] { padding-left: 0 !important; padding-right: 0 !important; }',
      ].join(' ');
      var imgCss = fullWidth
        ? 'img.ImageContainer { display: block !important; margin: 0 auto !important; width: 100% !important; }'
        : 'img.ImageContainer { display: block !important; margin: 0 auto !important; max-width: 100% !important; }';
      return base + ' ' + imgCss;
    },

    // Should a src change on this img trigger a rescan?
    shouldRescanOnSrcChange: function (img) {
      return isCdnSrc(img.src);
    },
  };
})();
