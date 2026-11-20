/* Apply the saved or system color theme before first paint, and wire the header toggle. */
(function (global) {
  var KEY = 'osr_theme_v1';
  var ORDER = ['system', 'light', 'dark'];
  var LABELS = {
    system: 'Theme: System (follows device)',
    light: 'Theme: Light',
    dark: 'Theme: Dark'
  };

  function safeGet() {
    try {
      var value = global.localStorage.getItem(KEY);
      if (value === 'light' || value === 'dark' || value === 'system') return value;
    } catch (e) {}
    return 'system';
  }

  function safeSet(mode) {
    try { global.localStorage.setItem(KEY, mode); } catch (e) {}
  }

  function prefersDark() {
    try { return global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches; }
    catch (e) { return false; }
  }

  function resolve(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    return prefersDark() ? 'dark' : 'light';
  }

  function apply(mode, opts) {
    var nextMode = (mode === 'light' || mode === 'dark' || mode === 'system') ? mode : 'system';
    if (!opts || opts.persist !== false) safeSet(nextMode);
    var theme = resolve(nextMode);
    var html = document.documentElement;
    html.setAttribute('data-theme', theme);
    html.setAttribute('data-theme-mode', nextMode);
    html.style.colorScheme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#16151c' : '#2E3A59');
    return { mode: nextMode, theme: theme };
  }

  function syncButtons() {
    var mode = safeGet();
    var label = LABELS[mode] || LABELS.system;
    document.querySelectorAll('#btn-theme-toggle').forEach(function (btn) {
      btn.setAttribute('title', label);
      btn.setAttribute('aria-label', label + '. Click to cycle System, Light, Dark.');
      btn.setAttribute('data-theme-mode', mode);
      btn.querySelectorAll('[data-theme-icon]').forEach(function (icon) {
        var on = icon.getAttribute('data-theme-icon') === mode;
        icon.classList.toggle('hidden', !on);
        icon.setAttribute('aria-hidden', on ? 'false' : 'true');
      });
    });
  }

  function cycle() {
    var current = safeGet();
    var index = ORDER.indexOf(current);
    var next = ORDER[(index + 1) % ORDER.length];
    apply(next);
    syncButtons();
    return next;
  }

  var api = {
    key: KEY,
    getMode: safeGet,
    resolved: function () { return resolve(safeGet()); },
    apply: apply,
    cycle: cycle,
    syncButtons: syncButtons,
    labels: LABELS
  };
  global.OSRTheme = api;
  apply(safeGet(), { persist: false });

  function onReady() {
    syncButtons();
    document.querySelectorAll('#btn-theme-toggle').forEach(function (btn) {
      if (btn.getAttribute('data-theme-bound') === '1') return;
      btn.setAttribute('data-theme-bound', '1');
      btn.addEventListener('click', function () { cycle(); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();

  try {
    var media = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)');
    if (media) {
      var onChange = function () { if (safeGet() === 'system') { apply('system', { persist: false }); syncButtons(); } };
      if (media.addEventListener) media.addEventListener('change', onChange);
      else if (media.addListener) media.addListener(onChange);
    }
  } catch (e) {}
})(window);
