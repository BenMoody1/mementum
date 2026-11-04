/* MeMentum: walks and runs from Health Connect, reviewed by hand (Android app only).
 * Garmin Connect (or another fitness app) shares watch activities with Health Connect. This lists
 * the last 30 days of them so each one can be added to this profile's history, merged into a
 * treadmill run it overlaps, or dismissed. Nothing is ever added without being approved.
 * Health Connect is only read to show the list and the "to review" count on the Overview page.
 * The on/off switch and every decision are kept per profile and per device (never synced),
 * because Health Connect belongs to the phone's owner.
 */
(function () {
  'use strict';
  var C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;

  var P = 'MeMentumHealth';
  var call = function (m, o) { return C.nativePromise(P, m, o || {}); };
  var PREFS = 'mm-act-v1';   // { on, seen: { <Health Connect id>: 'added' | 'merged' | 'dismissed' } }
  var LOOKBACK = 30 * 864e5;
  var SOURCES = {
    'com.garmin.android.apps.connectmobile': 'Garmin',
    'com.sec.android.app.shealth': 'Samsung Health',
    'com.fitbit.FitbitMobile': 'Fitbit',
    'com.google.android.apps.fitness': 'Google Fit',
    'com.strava': 'Strava'
  };
  var TYPES = { walk: 'Walk', run: 'Run', treadmill: 'Treadmill run', hike: 'Hike' };

  var app = null, A = null, list = [], loaded = false, busy = false, lastCheck = 0;
  var showDismissed = false, changed = false, errMsg = '';
  var ui = {};

  function loadPrefs() { A = app.store.get(PREFS, null) || { on: false, seen: {} }; if (!A.seen) A.seen = {}; }
  function savePrefs() { app.store.set(PREFS, A); }

  /* ---------- reading ---------- */
  function norm(a) {
    var dur = Math.max(1, Math.round((a.end - a.start) / 1000));
    return {
      id: a.id, source: a.source, srcApp: SOURCES[a.source] || 'another app', type: a.type || 'walk',
      start: a.start, end: a.end, dur: dur, dist: Math.round(a.distance || 0),
      steps: a.steps ? Math.round(a.steps) : null, avgHr: a.avgHr ? Math.round(a.avgHr) : null,
      maxHr: a.maxHr ? Math.round(a.maxHr) : null, kcal: a.kcal ? Math.round(a.kcal) : null
    };
  }
  function fetchList() {
    if (busy) return Promise.resolve(list);
    busy = true; errMsg = '';
    return call('readActivities', { since: Date.now() - LOOKBACK }).then(function (r) {
      list = ((r && r.activities) || []).map(norm);
      loaded = true; lastCheck = Date.now();
      return list;
    }).catch(function (e) {
      var m = (e && e.message) || '';
      errMsg = /NO_PERMISSION/.test(m)
        ? 'MeMentum doesn’t have permission to read activities. Turn “Look for walks and runs” off and on again in Settings.'
        : 'Couldn’t read from Health Connect. ' + (m || 'Try again in a moment.');
      return list;
    }).then(function (l) { busy = false; return l; });
  }

  var inHistory = function (a) { return app.runs().some(function (r) { return r.hcId === a.id || r.hcMerged === a.id; }); };
  var decided = function (a) { return !!A.seen[a.id] || inHistory(a); };
  var pending = function () { return list.filter(function (a) { return !decided(a); }); };
  var dismissed = function () { return list.filter(function (a) { return A.seen[a.id] === 'dismissed'; }); };

  // a MeMentum treadmill run covering at least half of this activity (or the other way round)
  function overlapOf(a) {
    return app.runs().filter(function (r) { return !r.src; }).filter(function (r) {
      var s = r.samples || [], len = Math.max(r.moving || 0, s.length ? s[s.length - 1][0] : 0) * 1000;
      var o = Math.min(a.end, r.date + len) - Math.max(a.start, r.date);
      return o > 0 && o / Math.min(a.end - a.start, len || 1) >= 0.5;
    })[0] || null;
  }

  /* ---------- decisions ---------- */
  function record(a) {
    return {
      id: 'hc-' + a.id, date: a.start, moving: a.dur, dist: a.dist, climb: 0, maxSpeed: 0, avgIncline: 0,
      kcal: a.kcal, kcalSource: a.kcal != null ? 'watch' : null, avgHr: a.avgHr, maxHr: a.maxHr, zones: null,
      splitsKm: [], splitsMi: [], steps: a.steps,
      cadence: a.steps && a.dur > 30 ? Math.round(a.steps / (a.dur / 60)) : null,
      samples: [], best: {}, workout: null, workoutId: null, workoutDone: false, freeTarget: null, freeDone: false,
      tags: [], note: '', src: 'hc', srcApp: a.srcApp, actType: a.type, hcId: a.id
    };
  }
  function add(a) {
    if (!app.addImportedRun(record(a))) { app.toast('Couldn’t save this activity. Phone storage may be full.'); return; }
    A.seen[a.id] = 'added'; savePrefs(); changed = true;
    app.toast(TYPES[a.type] + ' added to ' + app.profileName() + '’s history');
  }
  function merge(a, run) {
    var added = [];
    app.updateRun(run.id, function (x) {
      if (!x.avgHr && a.avgHr) { x.avgHr = a.avgHr; x.maxHr = a.maxHr; added.push('heart rate'); }
      if (x.kcal == null && a.kcal != null) { x.kcal = a.kcal; x.kcalSource = 'watch'; added.push('calories'); }
      if (x.steps == null && a.steps) {
        x.steps = a.steps; x.cadence = x.moving > 30 ? Math.round(a.steps / (x.moving / 60)) : null; added.push('steps');
      }
      x.hcMerged = a.id;
    });
    A.seen[a.id] = 'merged'; savePrefs(); changed = true;
    app.renderHistory();
    app.toast(added.length ? 'Added ' + added.join(' and ') + ' to your treadmill run' : 'Your treadmill run already had everything, so nothing changed');
  }
  function dismiss(a) {
    var what = TYPES[a.type].toLowerCase();
    if (!confirm('Dismiss this ' + what + ' from ' + app.fmtDate(a.start) + ', ' + app.fD(a.dist) + ' ' + app.dU() +
      '? It won’t be added to your history and won’t show here again. You can bring it back from “Show dismissed”.')) return;
    A.seen[a.id] = 'dismissed'; savePrefs();
    app.toast(TYPES[a.type] + ' dismissed');
  }
  function restore(a) { delete A.seen[a.id]; savePrefs(); }

  /* ---------- review dialog ---------- */
  var esc = function (s) { return app.esc(s); };
  function stat(v, l) { return '<div><div class="v">' + v + '</div><div class="l">' + l + '</div></div>'; }

  function card(a, opts) {
    var dup = opts.dismissed ? null : overlapOf(a);
    var pace = a.dist > 20 ? app.fmtTime(a.dur / (a.dist / app.unitM())) : '–';
    var h = '<div class="lbnote actcard" data-id="' + esc(a.id) + '">' +
      '<strong>' + TYPES[a.type] + ', ' + app.fmtDate(a.start) + ', ' + app.fmtClock(a.start) + '</strong>' +
      '<span class="muted actsrc">From ' + esc(a.srcApp) + '</span>' +
      '<div class="stats">' +
        stat(app.fD(a.dist) + ' ' + app.dU(), 'Distance') + stat(app.fmtTime(a.dur), 'Time') +
        stat(pace, 'Pace /' + app.dU()) + stat(a.avgHr || '–', 'Avg bpm') +
        stat(a.steps ? a.steps.toLocaleString('en-GB') : '–', 'Steps') + stat(a.kcal != null ? a.kcal : '–', 'kcal') +
      '</div>';
    if (dup) h += '<p class="actdup">This overlaps your treadmill run at ' + app.fmtClock(dup.date) + ' (' + app.fD(dup.dist) + ' ' + app.dU() + ').</p>';

    if (opts.dismissed) {
      h += '<div class="row"><button class="sm" data-a="restore">Restore</button></div>';
    } else if (a._edit) {
      h += '<div class="actedit">' +
        '<label class="f"><span>Type</span><select data-f="type">' + Object.keys(TYPES).map(function (k) {
          return '<option value="' + k + '"' + (k === a.type ? ' selected' : '') + '>' + TYPES[k] + '</option>';
        }).join('') + '</select></label>' +
        '<label class="f"><span>Distance (' + app.dU() + ')</span><input type="number" inputmode="decimal" step="0.01" min="0" data-f="dist" value="' + app.fD(a.dist) + '"></label>' +
        '</div><div class="row"><button class="sm" data-a="editcancel">Cancel</button><button class="sm primary" data-a="editsave">Save changes</button></div>';
    } else if (a._ask && dup) {
      h += '<p class="fhint">Add the watch’s heart rate, calories and steps to that run (only what it’s missing), or keep this as a separate activity?</p>' +
        '<div class="row"><button class="sm primary" data-a="merge">Add to treadmill run</button><button class="sm" data-a="separate">Keep separate</button><button class="sm" data-a="askcancel">Cancel</button></div>';
    } else {
      h += '<div class="row actbtns"><button class="sm" data-a="edit">Edit</button><button class="sm danger" data-a="dismiss">Dismiss</button><button class="sm primary" data-a="add">Add to history</button></div>';
    }
    return h + '</div>';
  }

  function renderDlg() {
    var d = ui.dlg; if (!d) return;
    var p = pending(), dis = dismissed(), body;
    if (busy && !loaded) body = '<p class="muted">Reading the last 30 days from Health Connect…</p>';
    else if (errMsg) body = '<p class="actdup">' + esc(errMsg) + '</p>';
    else if (!p.length) body = '<p class="muted">Nothing to review. Walks and runs from your watch appear here once Garmin Connect has synced them to Health Connect.</p>';
    else body = p.map(function (a) { return card(a, {}); }).join('');
    if (dis.length) {
      body += '<button class="link" data-a="toggledis">' + (showDismissed ? 'Hide dismissed' : 'Show dismissed (' + dis.length + ')') + '</button>';
      if (showDismissed) body += dis.map(function (a) { return card(a, { dismissed: true }); }).join('');
    }
    d.innerHTML = '<h3>Walks and runs to review</h3>' +
      '<p class="fhint">From Health Connect, last 30 days. Only the ones you add go into ' + esc(app.profileName()) + '’s history.</p>' +
      body +
      '<div class="drow"><button class="sm" data-a="refresh"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Checking…' : 'Check again') + '</button>' +
      '<button class="sm primary" data-a="close">Done</button></div>';
  }

  function onDlgClick(e) {
    var b = e.target.closest('[data-a]'); if (!b) return;
    var act = b.dataset.a, c = b.closest('.actcard'), id = c && c.dataset.id;
    var a = id ? list.filter(function (x) { return x.id === id; })[0] : null;
    if (act === 'close') { ui.dlg.close(); return; }
    if (act === 'refresh') { renderDlgAfter(fetchList()); renderDlg(); return; }
    if (act === 'toggledis') { showDismissed = !showDismissed; renderDlg(); return; }
    if (!a) return;
    if (act === 'add') { var dup = overlapOf(a); if (dup) a._ask = true; else add(a); }
    else if (act === 'separate') { a._ask = false; add(a); }
    else if (act === 'merge') { var r = overlapOf(a); a._ask = false; if (r) merge(a, r); }
    else if (act === 'askcancel') a._ask = false;
    else if (act === 'dismiss') dismiss(a);
    else if (act === 'restore') restore(a);
    else if (act === 'edit') a._edit = true;
    else if (act === 'editcancel') a._edit = false;
    else if (act === 'editsave') {
      var t = c.querySelector('[data-f="type"]').value, v = parseFloat(c.querySelector('[data-f="dist"]').value);
      if (TYPES[t]) a.type = t;
      if (isFinite(v) && v >= 0) a.dist = Math.round(v * app.unitM());
      a._edit = false;
    }
    renderDlg(); renderNag();
  }
  function renderDlgAfter(p) { p.then(function () { renderDlg(); renderNag(); renderSettings(); }); }

  function openReview() {
    if (!ui.dlg) {
      ui.dlg = document.createElement('dialog');
      ui.dlg.id = 'actDlg';
      ui.dlg.setAttribute('aria-labelledby', 'actDlgH');
      document.body.appendChild(ui.dlg);
      ui.dlg.addEventListener('click', function (e) {
        if (e.target === ui.dlg) { var r = ui.dlg.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) { ui.dlg.close(); return; } }
        onDlgClick(e);
      });
      ui.dlg.addEventListener('close', function () {
        list.forEach(function (a) { a._edit = false; a._ask = false; });
        if (changed) { changed = false; app.afterImport(); }
        renderNag();
      });
    }
    renderDlg();
    ui.dlg.showModal();
    ui.dlg.scrollTop = 0;
    renderDlgAfter(fetchList());
  }

  /* ---------- "to review" note on the Overview page ---------- */
  function renderNag() {
    if (!ui.nag) {
      var bk = document.getElementById('bkNagH'); if (!bk) return;
      ui.nag = document.createElement('div'); ui.nag.id = 'actNag';
      bk.parentNode.insertBefore(ui.nag, bk);
      ui.nag.addEventListener('click', function (e) { if (e.target.closest('[data-act="review"]')) openReview(); });
    }
    var n = A.on && loaded ? pending().length : 0;
    ui.nag.innerHTML = n ? '<div class="lbnote actnag"><strong>' + n + ' ' + (n === 1 ? 'activity' : 'activities') + ' from your watch to review</strong>' +
      '<p>Add the walks and runs you want counted towards your goal, streak and journeys.</p>' +
      '<div class="row"><button class="sm primary" data-act="review">Review</button></div></div>' : '';
  }
  function quietCheck() {
    if (!A.on || busy || Date.now() - lastCheck < 60000) return;
    fetchList().then(function () { renderNag(); renderSettings(); });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && app) setTimeout(quietCheck, 2000);
  });

  /* ---------- Settings ---------- */
  function buildSettings() {
    var box = document.getElementById('hcBox');
    if (!box || document.getElementById('actOn')) return !!box;
    var t = document.createElement('template');
    t.innerHTML = '<div id="actBox">' +
      '<label class="check" style="margin-top:1rem"><input type="checkbox" id="actOn"><span>Look for walks and runs from your watch</span></label>' +
      '<p class="fhint" id="actStatus"></p>' +
      '<p class="fhint">Lists walks, runs and hikes that Garmin Connect (or another fitness app) shares with Health Connect, so you can choose which to add to this profile. Nothing is added unless you approve it. In Garmin Connect, turn on Health Connect and allow exercise first. Only turn this on for the phone owner’s profile.</p>' +
      '<div class="row"><button class="sm" id="actReview">Review walks and runs</button></div></div>';
    box.appendChild(t.content);
    ui.on = document.getElementById('actOn');
    ui.status = document.getElementById('actStatus');
    ui.review = document.getElementById('actReview');
    ui.on.addEventListener('change', function () {
      if (!ui.on.checked) { A.on = false; savePrefs(); renderSettings(); renderNag(); return; }
      ui.on.checked = false;
      call('requestAccess', { activities: true }).then(function (st) {
        if (st.granted.indexOf('activities') < 0) { app.toast('Health Connect access to exercise wasn’t allowed'); renderSettings(st); return; }
        A.on = true; savePrefs(); renderSettings(st);
        openReview();
      }).catch(function (e) { app.toast((e && e.message) || 'Couldn’t open Health Connect'); });
    });
    ui.review.addEventListener('click', openReview);
    renderSettings();
    return true;
  }
  function renderSettings(st) {
    if (!ui.status) return;
    (st ? Promise.resolve(st) : call('status')).then(function (s) {
      var ok = s.available === 'available', on = !!A.on && s.granted.indexOf('activities') >= 0;
      ui.on.checked = on; ui.on.disabled = !ok; ui.review.disabled = !on;
      var n = loaded ? pending().length : 0;
      ui.status.textContent = A.on && !on && ok
        ? 'This is on, but Health Connect permission was removed. Turn it off and on again to fix it.'
        : on ? 'On for ' + app.profileName() + '. ' + (loaded ? (n ? n + ' to review.' : 'Nothing waiting to review.') : '') : '';
    }).catch(function () { ui.status.textContent = ''; });
  }

  function start() {
    if (!window.mmApp.addImportedRun) return;   // older index.html without the import hooks
    app = window.mmApp;
    loadPrefs();
    var tries = 0;
    (function waitBox() { if (!buildSettings() && ++tries < 20) setTimeout(waitBox, 250); })();
    renderNag();
    if (A.on) setTimeout(quietCheck, 4000);
  }
  window.mmActivities = { open: openReview };
  if (window.mmApp) start(); else window.addEventListener('mmapp-ready', start, { once: true });
})();
