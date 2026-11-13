/* MeMentum: Settings as a home list of categories, each opening its own page.
 * The pages are plain sections of index.html (#sp-you, #sp-run, ...). This only switches between
 * them, writes the one-line summary under each row, and handles the back button and back gesture.
 * Summaries read the controls themselves, so they stay right whatever changed the setting.
 */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var cur = null, lastRow = null;

  /* ---------- switching ---------- */
  function pages() { return document.querySelectorAll('#tab-settings .sp-page'); }
  function open(id, focusEl) {
    var p = document.getElementById('sp-' + id), home = $('#spHome');
    if (!p || !home) return;
    home.hidden = true;
    Array.prototype.forEach.call(pages(), function (x) { x.hidden = x !== p; });
    p.classList.remove('sp-in'); void p.offsetWidth; p.classList.add('sp-in');
    cur = id;
    tidy(p);
    window.scrollTo(0, 0);
    (focusEl || p.querySelector('.sp-back')).focus({ preventScroll: !!focusEl });
    if (focusEl) setTimeout(function () { focusEl.scrollIntoView({ block: 'center' }); }, 30);
  }
  function home() {
    var h = $('#spHome'); if (!h) return;
    Array.prototype.forEach.call(pages(), function (x) { x.hidden = true; });
    h.hidden = false;
    cur = null;
    summarise();
    window.scrollTo(0, 0);
    if (lastRow) { lastRow.focus({ preventScroll: true }); lastRow = null; }
  }
  // the page holding this control (used when another part of the app jumps to a setting)
  function showFor(el) {
    var p = el && el.closest && el.closest('.sp-page');
    if (p) open(p.id.slice(3), el);
  }
  // hide "only in the Android app" notes once a native section has filled the page's slot
  function tidy(p) {
    Array.prototype.forEach.call(p.querySelectorAll('.sp-slot'), function (slot) {
      var filled = !!slot.previousElementSibling && !slot.previousElementSibling.classList.contains('sp-head');
      Array.prototype.forEach.call(p.querySelectorAll('.sp-none'), function (n) { n.hidden = filled; });
    });
  }

  /* ---------- summaries ---------- */
  var on = function (id) { var e = document.getElementById(id); return !!(e && e.checked); };
  var val = function (id) { var e = document.getElementById(id); return e ? String(e.value || '').trim() : ''; };
  var txt = function (id) { var e = document.getElementById(id); return e ? e.textContent.trim() : ''; };
  var pressed = function (sel) { var b = document.querySelector(sel + ' [aria-pressed="true"]'); return b ? b.textContent.trim() : ''; };
  var list = function (pairs) { return pairs.filter(function (p) { return on(p[0]); }).map(function (p) { return p[1]; }); };
  var cap = function (s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
  var join = function (a) { return a.filter(Boolean).join(' · '); };

  function summarise() {
    var app = window.mmApp, S = {};

    var goal = parseFloat(val('setGoal')), unit = pressed('#unitSeg') === 'Miles' ? 'mi' : 'km';
    S.you = join([app && app.profileName ? app.profileName() : '',
      goal > 0 ? goal + ' ' + unit + ' weekly goal' : 'No weekly goal']);

    var af = pressed('#autoFinSeg');
    var run = list([['setCues', 'spoken cues'], ['setAnnounce', 'splits'], ['setControl', 'treadmill control'], ['setGhost', 'ghost'], ['setCountdown', 'countdowns']]);
    if (af && af !== 'Never') run.push('auto-finish ' + af);
    S.run = run.length ? cap(run.join(', ')) : 'All off';

    var ticked = document.querySelectorAll('#celList input[type="checkbox"]:checked').length;
    S.cel = join([on('setConfetti') ? 'Confetti on' : 'Confetti off', ticked ? ticked + ' celebration' + (ticked === 1 ? '' : 's') + ' ticked' : '']);

    if ($('#nBox')) {
      var n = list([['nStreak', 'streak reminder'], ['nWeekly', 'weekly summary'], ['nRun', 'run notification']]);
      S.notify = n.length ? cap(n.join(', ')) : 'All off';
    } else S.notify = 'Android app only';

    if ($('#hcBox')) {
      var h = list([['hcOn', 'run sync'], ['hcWt', 'weight import'], ['actOn', 'Garmin and Google walks']]);
      var m = /(\d+) to review/.exec(txt('actStatus'));
      S.health = join([h.length ? cap(h.join(', ')) : 'Health Connect off', m ? m[1] + ' to review' : '']);
    } else S.health = join([pressed('#exportSeg') && pressed('#exportSeg') !== 'Off' ? 'Garmin export: ' + pressed('#exportSeg') : 'Garmin export off']);

    var tm = txt('tmText'), hr = txt('hrText');
    S.devices = /not connected/i.test(tm) && /not connected/i.test(hr) ? 'Nothing connected' : join([/not connected/i.test(tm) ? '' : tm, /not connected/i.test(hr) ? '' : hr]);

    var bk = txt('bkStatus').split('.')[0], ab = pressed('#autoBkSeg'), abShown = $('#autoBkField') && !$('#autoBkField').hidden;
    S.data = join([abShown ? (ab && ab !== 'Off' ? ab + ' auto backup' : 'Auto backup off') : '', on('syncOn') ? 'Household sync on' : '', bk]);

    S.app = join(['Theme: ' + (pressed('#themeSeg') || 'Auto'), window.mmUpdates ? mmUpdates.summary() : '']);

    Object.keys(S).forEach(function (k) { var e = document.getElementById('spSum-' + k); if (e) e.textContent = S[k] || ''; });
  }

  /* ---------- back button and gesture ---------- */
  // Called by the Android app (MainActivity) on back; returns true when it handled it.
  window.mmBack = function () {
    if (window.mmPodium && mmPodium.isOpen()) { mmPodium.close(); return true; }
    var dlgs = document.querySelectorAll('dialog[open]');
    if (dlgs.length) {
      var d = dlgs[dlgs.length - 1], ev = new Event('cancel', { cancelable: true });
      if (d.dispatchEvent(ev)) d.close();
      return true;
    }
    var tab = $('#tab-settings');
    if (tab && !tab.hidden) {
      if (cur) { home(); return true; }
      var cog = $('#cogBtn'); if (cog) { cog.click(); return true; }   // back to the tab you came from
    }
    return false;
  };

  /* ---------- wiring ---------- */
  function wire() {
    var tab = $('#tab-settings'); if (!tab || tab.dataset.spWired) return;
    tab.dataset.spWired = '1';
    tab.addEventListener('click', function (e) {
      var row = e.target.closest('.sp-row');
      if (row) { lastRow = row; open(row.dataset.sp); return; }
      if (e.target.closest('.sp-back')) home();
    });
    var conn = $('#spConn');
    if (conn) conn.addEventListener('click', function () { var d = $('#connDlg'); if (d) d.showModal(); });
    summarise();
  }
  window.mmSettingsNav = { home: home, open: open, showFor: showFor, refresh: summarise };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  window.addEventListener('mmapp-ready', function () { setTimeout(summarise, 1500); });
})();
