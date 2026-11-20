/* Apply window.OSR_CONFIG (from /config.js) before the app modules run. */
(function () {
  var c = window.OSR_CONFIG || {};
  if (c.firebase && c.firebase.apiKey) window.FIREBASE_CONFIG = c.firebase;
  if (!c.siteTitle) return;
  var title = document.title;
  if (/^Page not found/.test(title)) document.title = 'Page not found — ' + c.siteTitle;
  else if (/^You are offline/.test(title)) document.title = 'You are offline — ' + c.siteTitle;
  else {
    var suffix = title.indexOf(' — ') >= 0 ? title.slice(title.indexOf(' — ')) : '';
    document.title = c.siteTitle + suffix;
  }
  var apple = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (apple) apple.setAttribute('content', c.siteTitle);
  document.querySelectorAll('[data-site-title]').forEach(function (el) {
    el.textContent = c.siteTitle;
  });
})();
