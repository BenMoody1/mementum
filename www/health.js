/* MeMentum: Health Connect sync (Android app only).
 * Adds a "Health Connect" section to Settings, sends each finished run to Health Connect,
 * and removes it again if the run is deleted. It can also bring in weigh-ins from a smart
 * scale app (e.g. Renpho Health) whenever the app opens or comes back to the front. Sync is switched on per profile, because
 * Health Connect belongs to the phone's owner, not the whole family.
 */
(function () {
  'use strict';
  var C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;

  var P = 'MeMentumHealth';
  var call = function (m, o) { return C.nativePromise(P, m, o || {}); };
  var SYNCED = 'mm-hc-synced-v1';   // run IDs already sent, per profile
  var PREFS = 'mm-hc-v1';           // on/off, start date, steps, weight import: per profile and per device (never synced)
  var app = null, H = null;
  function loadPrefs() {
    H = app.store.get(PREFS, null);
    if (H) return;
    var s = app.settings;   // earlier versions kept these in the shared settings
    H = { on: !!s.hcSync, since: s.hcSince || 0, steps: !!s.hcSteps };
    if ('hcSync' in s || 'hcSince' in s || 'hcSteps' in s) { delete s.hcSync; delete s.hcSince; delete s.hcSteps; app.saveSettings(); }
    savePrefs();
  }
  function savePrefs() { app.store.set(PREFS, H); }

  function synced() { return new Set(app.store.get(SYNCED, [])); }
  function markSynced(ids, add) {
    var s = synced();
    ids.forEach(function (id) { if (add) s.add(id); else s.delete(id); });
    app.store.set(SYNCED, Array.from(s));
  }

  function payload(r) {
    var s = r.samples || [], last = s.length ? s[s.length - 1][0] : 0;
    var dur = Math.max(Math.round(r.moving || 0), last, 1), hr = [], speed = [];
    s.forEach(function (x) {
      if (x[0] >= dur) return;
      if (x[3] > 0) hr.push([x[0], x[3]]);
      speed.push([x[0], x[1]]);
    });
    return {
      id: r.id, start: r.date, duration: dur, distance: r.dist || 0, kcal: r.kcal || 0,
      climb: r.climb || 0, steps: r.steps || 0,
      title: r.workout ? 'Treadmill: ' + r.workout : 'Treadmill run', notes: r.note || '',
      hr: hr, speed: speed, version: Math.floor(Date.now() / 1000)
    };
  }

  // Send runs in small batches. Resolves to { written, failed[] }.
  function send(runs) {
    var total = { written: 0, failed: [] }, i = 0;
    function next() {
      if (i >= runs.length) return Promise.resolve(total);
      var batch = runs.slice(i, i + 15); i += 15;
      return call('writeRuns', { runs: batch.map(payload), includeSteps: !!H.steps }).then(function (r) {
        var failed = (r && r.failed) || [];
        total.written += (r && r.written) || 0;
        total.failed = total.failed.concat(failed);
        markSynced(batch.map(function (x) { return x.id; }).filter(function (id) { return failed.indexOf(id) < 0; }), true);
        return next();
      });
    }
    return next();
  }

  function onSaved(rec) {
    if (!app || !H.on) return;
    send([rec]).then(function (r) {
      if (r.written) setTimeout(function () { app.toast('Sent to Health Connect'); }, 2200);
    }).catch(function (e) {
      if (/NO_PERMISSION/.test((e && e.message) || '')) setTimeout(function () { app.toast('Health Connect needs permission again. See Settings.'); }, 2200);
    });
  }

  function onDeleted(id) {
    if (!app || !synced().has(id)) return;
    call('deleteRuns', { ids: [id] }).then(function () { markSynced([id], false); }).catch(function () {});
  }

  // Quietly catch up on runs saved while sync was on but the write failed (no permission, phone busy).
  // Also removes runs that were deleted on another device (household sync).
  function catchUp() {
    if (!H.on) return;
    var done = synced(), since = H.since || 0, runs = app.runs();
    var todo = runs.filter(function (r) { return r.date >= since && !done.has(r.id); });
    if (todo.length) send(todo).catch(function () {});
    var ids = new Set(runs.map(function (r) { return r.id; }));
    var gone = Array.from(done).filter(function (id) { return !ids.has(id); });
    if (gone.length) call('deleteRuns', { ids: gone }).then(function () { markSynced(gone, false); }).catch(function () {});
  }

  /* ---------- Weigh-ins from Health Connect ----------
   * H.wt: import is on. H.wtSince: time (ms) of the newest weigh-in already imported, so each one
   * comes in once. Several readings on one day (stepping on twice) count as that day's last one. */
  var wtBusy = false, wtLastCheck = 0;
  function importWeights(manual) {
    if (!H.wt || wtBusy) return Promise.resolve(0);
    if (!manual && Date.now() - wtLastCheck < 60000) return Promise.resolve(0);
    wtBusy = true; wtLastCheck = Date.now();
    return call('readWeights', { since: (H.wtSince || 0) + 1 }).then(function (r) {
      var list = (r && r.weights) || [], byDay = {}, newest = H.wtSince || 0;
      list.forEach(function (w) {
        if (!(w.kg >= 30 && w.kg <= 250) || !/^\d{4}-\d\d-\d\d$/.test(w.day)) return;
        if (!byDay[w.day] || w.time >= byDay[w.day].time) byDay[w.day] = w;
        if (w.time > newest) newest = w.time;
      });
      var days = Object.keys(byDay).sort();
      var n = app.addWeighIns(days.map(function (d) { return { d: d, kg: byDay[d].kg }; }));
      H.wtSince = newest; savePrefs();
      if (n === 1) app.toast('Weigh-in added from Health Connect: ' + app.wtFmt(byDay[days[0]].kg));
      else if (n > 1) app.toast(n + ' weigh-ins added from Health Connect');
      else if (manual) app.toast('No new weigh-ins in Health Connect');
      return n;
    }).catch(function (e) {
      if (manual || /NO_PERMISSION/.test((e && e.message) || ''))
        app.toast(/NO_PERMISSION/.test((e && e.message) || '') ? 'Weight import needs Health Connect permission again. See Settings.' : 'Couldn’t read weigh-ins from Health Connect');
      return 0;
    }).then(function (n) { wtBusy = false; render(); return n; });
  }
  // the usual pattern is: weigh in, Renpho syncs, switch back to MeMentum, so check on return too
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && app) setTimeout(function () { importWeights(false); }, 1500);
  });

  /* ---------- Settings section ---------- */
  var ui = {};
  function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; }

  function buildUi() {
    var anchor = Array.prototype.filter.call(document.querySelectorAll('h3'), function (h) { return h.textContent.trim() === 'Devices and data'; })[0];
    if (!anchor || document.getElementById('hcOn')) return;
    anchor.parentNode.insertBefore(el(
      '<div id="hcBox">' +
      '<h3>Health Connect</h3>' +
      '<p class="fhint" id="hcStatus">Checking…</p>' +
      '<label class="check"><input type="checkbox" id="hcOn"><span>Send this profile’s runs to Health Connect</span></label>' +
      '<label class="check"><input type="checkbox" id="hcSteps"><span>Include steps</span></label>' +
      '<p class="fhint">Each run appears in Google Health and other connected apps as a treadmill run, with distance, calories, heart rate, speed and climb. Only turn this on for the phone owner’s profile. Leave steps off if your watch already counts your steps, so they aren’t counted twice.</p>' +
      '<div class="row"><button class="sm" id="hcSyncAll">Sync past runs</button><button class="sm" id="hcOpen">Open Health Connect</button></div>' +
      '<label class="check" style="margin-top:1rem"><input type="checkbox" id="hcWt"><span>Bring in weigh-ins from Health Connect</span></label>' +
      '<p class="fhint" id="hcWtStatus"></p>' +
      '<p class="fhint">Adds weigh-ins from your smart scale’s app, such as Renpho Health, to this profile’s weight, whenever you open MeMentum. In Renpho Health, turn on Health Connect and allow weight first. Only turn this on for the phone owner’s profile.</p>' +
      '<div class="row"><button class="sm" id="hcWtNow">Check for weigh-ins now</button></div>' +
      '</div>'), anchor);
    ui.status = document.getElementById('hcStatus');
    ui.on = document.getElementById('hcOn');
    ui.steps = document.getElementById('hcSteps');
    ui.all = document.getElementById('hcSyncAll');
    ui.open = document.getElementById('hcOpen');
    ui.wt = document.getElementById('hcWt');
    ui.wtStatus = document.getElementById('hcWtStatus');
    ui.wtNow = document.getElementById('hcWtNow');

    ui.wt.addEventListener('change', function () {
      if (!ui.wt.checked) { H.wt = false; savePrefs(); render(); return; }
      ui.wt.checked = false;
      call('requestAccess', { weight: true }).then(function (st) {
        if (st.granted.indexOf('weight') < 0) { app.toast('Health Connect access to weight wasn’t allowed'); render(st); return; }
        H.wt = true; savePrefs(); render(st);
        importWeights(true);
      }).catch(function (e) { app.toast((e && e.message) || 'Couldn’t open Health Connect'); });
    });
    ui.wtNow.addEventListener('click', function () { importWeights(true); });

    ui.on.addEventListener('change', function () {
      if (!ui.on.checked) { H.on = false; savePrefs(); render(); return; }
      ui.on.checked = false;
      call('requestAccess').then(function (st) {
        if (st.granted.indexOf('session') < 0) { app.toast('Health Connect access wasn’t allowed'); render(st); return; }
        H.on = true;
        if (!H.since) H.since = Date.now();
        savePrefs(); render(st);
        app.toast('Health Connect is on. New runs will be sent automatically.');
      }).catch(function (e) { app.toast((e && e.message) || 'Couldn’t open Health Connect'); });
    });
    ui.steps.addEventListener('change', function () {
      if (ui.steps.checked && H.on) {
        // steps may need a permission that was skipped the first time
        call('status').then(function (st) { if (st.granted.indexOf('steps') < 0) return call('requestAccess'); }).then(function () { render(); }).catch(function () {});
      }
      H.steps = ui.steps.checked; savePrefs();
    });
    ui.all.addEventListener('click', function () {
      var runs = app.runs();
      if (!runs.length) { app.toast('No runs to send yet'); return; }
      if (!confirm('Send all ' + runs.length + ' of ' + app.profileName() + '’s runs to Health Connect? Runs already there are updated, not duplicated.')) return;
      ui.all.disabled = true; ui.status.textContent = 'Sending ' + runs.length + ' runs…';
      send(runs).then(function (r) {
        app.toast(r.failed.length ? 'Sent ' + r.written + ' runs. ' + r.failed.length + ' couldn’t be sent.' : 'Sent ' + r.written + ' runs to Health Connect');
      }).catch(function (e) {
        app.toast(/NO_PERMISSION/.test((e && e.message) || '') ? 'Turn on Health Connect above first' : 'Couldn’t send runs: ' + ((e && e.message) || 'unknown error'));
      }).then(function () { ui.all.disabled = false; render(); });
    });
    ui.open.addEventListener('click', function () { call('openSettings').catch(function () { app.toast('Couldn’t open Health Connect'); }); });
    render();
  }

  function render(st) {
    if (!ui.status) return;
    var p = st ? Promise.resolve(st) : call('status');
    p.then(function (s) {
      var on = !!H.on && s.granted.indexOf('session') >= 0;
      ui.on.checked = on; ui.steps.checked = !!H.steps;
      ui.on.disabled = s.available !== 'available';
      ui.steps.disabled = ui.all.disabled = !on;
      var wtOn = !!H.wt && s.granted.indexOf('weight') >= 0;
      ui.wt.checked = wtOn;
      ui.wt.disabled = s.available !== 'available';
      ui.wtNow.disabled = !wtOn || wtBusy;
      ui.wtStatus.textContent = H.wt && !wtOn && s.available === 'available'
        ? 'Weight import is on, but Health Connect permission was removed. Turn it off and on again to fix it.'
        : wtOn ? (H.wtSince ? 'On. Last weigh-in brought in: ' + app.fmtDate(H.wtSince) + '.' : 'On. No weigh-ins found yet.') : '';
      if (s.available === 'unavailable') ui.status.textContent = 'Health Connect isn’t available on this phone.';
      else if (s.available === 'update_required') { ui.status.textContent = 'Health Connect needs installing or updating. Tap Open Health Connect.'; }
      else if (H.on && !on) ui.status.textContent = 'Sync is on, but Health Connect permission was removed. Turn it off and on again to fix it.';
      else if (on) ui.status.textContent = 'On for ' + app.profileName() + '. ' + synced().size + ' runs sent so far.';
      else ui.status.textContent = 'Off. Turn on to send ' + app.profileName() + '’s runs to Google Health.';
    }).catch(function () { ui.status.textContent = 'Couldn’t check Health Connect.'; });
  }

  function start() {
    app = window.mmApp;
    loadPrefs();
    buildUi();
    setTimeout(catchUp, 3000);
    setTimeout(function () { importWeights(false); }, 3500);
  }
  window.mmHealth = { onSaved: onSaved, onDeleted: onDeleted };
  if (window.mmApp) start(); else window.addEventListener('mmapp-ready', start, { once: true });
})();
