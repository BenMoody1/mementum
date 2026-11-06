/* MeMentum: checks GitHub Releases for a newer APK (Android app only).
 * Every push to main builds and publishes a release (see .github/workflows/android.yml), and the
 * build stamps its own version and repository into build-info.js. When a newer release exists, this
 * says so once and offers the download in Settings > Appearance and app. Android then installs it
 * from the browser's download, as usual for an app that isn't from the Play Store.
 */
(function () {
  'use strict';
  var C = window.Capacitor, B = window.MM_BUILD || {};
  var native = !!(C && C.isNativePlatform && C.isNativePlatform());
  var KEY = 'mm-upd-v1';      // per device: { auto, lastCheck, latest: { code, version, url, page, notes }, told }
  var EVERY = 12 * 3600e3;
  var busy = false, msg = '';

  function load() { try { return Object.assign({ auto: true, lastCheck: 0, latest: null, told: 0 }, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { return { auto: true, lastCheck: 0, latest: null, told: 0 }; } }
  function save(u) { try { localStorage.setItem(KEY, JSON.stringify(u)); } catch (e) {} }
  var $ = function (s) { return document.querySelector(s); };
  var usable = function () { return native && B.code > 0 && !!B.repo; };
  var codeOf = function (tag) { var m = /(\d+)\s*$/.exec(String(tag || '')); return m ? +m[1] : 0; };
  var available = function (u) { return !!(u.latest && u.latest.code > (B.code || 0)); };
  function toast(t) { if (window.mmApp && mmApp.toast) mmApp.toast(t); }

  function check(manual) {
    if (!usable() || busy) return Promise.resolve();
    busy = true; msg = manual ? 'Checking…' : ''; render();
    return fetch('https://api.github.com/repos/' + B.repo + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) throw new Error('404');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (rel) {
        var u = load(), apk = (rel.assets || []).filter(function (a) { return /\.apk$/i.test(a.name); })[0];
        u.lastCheck = Date.now();
        u.latest = { code: codeOf(rel.tag_name), version: String(rel.tag_name || '').replace(/^v/, ''),
          url: apk ? apk.browser_download_url : rel.html_url, page: rel.html_url,
          notes: String(rel.body || '').split('\n')[0].slice(0, 140) };
        msg = '';
        if (available(u) && u.told !== u.latest.code) {
          u.told = u.latest.code;
          toast('MeMentum ' + u.latest.version + ' is available. Get it from Settings, Appearance and app.');
        } else if (manual && !available(u)) msg = 'You have the newest version.';
        save(u);
      })
      .catch(function (e) {
        msg = /404/.test(e && e.message) ? 'Couldn’t find any releases for ' + B.repo + '. If the repository is private, the app can’t see new versions.'
          : 'Couldn’t check for updates. Check the internet connection and try again.';
      })
      .then(function () { busy = false; render(); if (window.mmSettingsNav) mmSettingsNav.refresh(); });
  }

  function render() {
    var st = $('#updStatus'); if (!st) return;
    if (!native) return;
    var u = load(), avail = available(u);
    $('#updAutoRow').hidden = !usable(); $('#updRow').hidden = !usable();
    $('#updAuto').checked = !!u.auto;
    $('#updCheck').disabled = busy;
    $('#updGet').hidden = !avail;
    if (!usable()) { st.textContent = 'Version ' + (B.version || 'dev') + '. Update checks work in builds made by GitHub Actions.'; return; }
    st.textContent = 'Version ' + B.version + '. ' + (avail
      ? 'MeMentum ' + u.latest.version + ' is available' + (u.latest.notes ? ': ' + u.latest.notes : '') + '. Tap Download update, then open the downloaded file to install it. Your runs and settings stay as they are.'
      : msg || (u.lastCheck ? 'Up to date when last checked.' : ''));
  }

  function wire() {
    if (!$('#updStatus')) return;
    $('#updCheck').addEventListener('click', function () { check(true); });
    $('#updAuto').addEventListener('change', function () { var u = load(); u.auto = this.checked; save(u); });
    $('#updGet').addEventListener('click', function () {
      var u = load(); if (!u.latest) return;
      window.open(u.latest.url, '_blank', 'noopener');
      toast('Downloading. When it finishes, open the file to install. Android may ask you to allow installs from your browser the first time.');
    });
    render();
    var u = load();
    if (usable() && u.auto && Date.now() - u.lastCheck > EVERY) setTimeout(function () { check(false); }, 6000);
  }

  window.mmUpdates = {
    summary: function () {
      var u = load();
      if (native && available(u)) return 'Update available: ' + u.latest.version;
      return 'Version ' + (B.version || 'dev');
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
