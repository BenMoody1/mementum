/* MeMentum: notifications (Android app only).
 *  - Streak reminder at a chosen time, only on days you haven't secured yet (skips holidays).
 *  - Weekly report + medals on Monday at 8am.
 *  - "Run in progress" notification during a run, which keeps Bluetooth alive in the background.
 * Reminders are re-booked for the next 7 days whenever the app is opened or a run ends, and a
 * run that secures today cancels today's reminder, so it only appears when you haven't run.
 */
(function () {
  'use strict';
  var C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;

  var LN = 'LocalNotifications', RUN = 'MeMentumRun';
  var call = function (p, m, o) { return C.nativePromise(p, m, o || {}); };
  var STREAK_BASE = 1001, WEEKLY_ID = 1101, DAY = 86400000;
  var app = null, S = null;

  // Notification choices belong to this device (and profile), so they're kept out of synced settings.
  var PREFS = 'mm-notify-v1', N = null;
  function defaults() {
    N = app.store.get(PREFS, null);
    if (!N) {
      N = { nStreak: !!S.nStreak, nStreakAt: S.nStreakAt || '19:00', nWeekly: !!S.nWeekly, nRun: S.nRun !== false };
      if (['nStreak', 'nStreakAt', 'nWeekly', 'nRun'].some(function (k) { return k in S; })) {
        delete S.nStreak; delete S.nStreakAt; delete S.nWeekly; delete S.nRun; app.saveSettings();
      }
      savePrefs();
    }
  }
  function savePrefs() { app.store.set(PREFS, N); }
  var many = function () { return app.profiles.list.length > 1; };
  var who = function () { return many() ? app.profileName() + '’s ' : 'Your '; };
  var mi = function () { return S.units === 'mi'; };
  var distTxt = function (m) { return (mi() ? m / 1609.344 : m / 1000).toFixed(m >= 10000 ? 1 : 2) + (mi() ? ' mi' : ' km'); };
  function timeTxt(sec) {
    sec = Math.round(sec); var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }
  function at(dayOffset, hhmm) {
    var p = String(hhmm || '19:00').split(':'), d = new Date();
    d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + dayOffset); d.setHours(+p[0] || 0, +p[1] || 0, 0, 0);
    return d;
  }
  function note(id, title, body, when) {
    return { id: id, title: title, body: body, channelId: 'reminders', smallIcon: 'ic_stat_mementum', iconColor: '#B5372A',
             schedule: { at: when.toISOString(), allowWhileIdle: true } };
  }

  /* ---------- streak reminders ---------- */
  function streakNotes() {
    var st = app.computeStreak(app.allRuns()), now = Date.now(), out = [];
    if (!st.current && !st.todayActive) return out;      // no streak to protect
    for (var i = 0; i < 7; i++) {
      var when = at(i, N.nStreakAt);
      if (when.getTime() <= now + 60000) continue;
      if (st.holiday && st.holiday.has(app.dayKey(when.getTime()))) continue;
      if (i === 0) {
        if (st.todayActive) continue;
        var n = st.current, f = st.freezesLeft;
        out.push(f > 0
          ? note(STREAK_BASE, '🔥 ' + who() + n + '-day streak', 'No run yet today. 10 minutes keeps it going. If you can’t, a freeze will cover today (' + f + ' left this week).', when)
          : note(STREAK_BASE, '🔥 ' + who() + n + '-day streak is at risk', 'No freezes left this week. 10 minutes on the treadmill today keeps it alive.', when));
      } else {
        out.push(note(STREAK_BASE + i, '🔥 Keep ' + (many() ? app.profileName() + '’s' : 'your') + ' streak going', '10 minutes on the treadmill today keeps the streak alive.', when));
      }
    }
    return out;
  }

  /* ---------- weekly report + medals ---------- */
  function weeklyNote() {
    var now = Date.now(), target = new Date(app.weekStart(now).getTime());
    target.setHours(8, 0, 0, 0);
    if (target.getTime() <= now + 60000) { target = new Date(app.weekStart(now).getTime() + 7 * DAY + 3 * 3600000); target.setHours(8, 0, 0, 0); }
    var to = app.weekStart(target.getTime()).getTime(), from = app.weekStart(to - 3 * DAY).getTime();
    var inWeek = function (r) { return r.date >= from && r.date < to; };
    var mine = app.allRuns().filter(inWeek);
    var board = app.profiles.list.map(function (p) {
      return { name: p.name, dist: app.profileRuns(p.id).filter(inWeek).reduce(function (a, r) { return a + (r.dist || 0); }, 0) };
    }).filter(function (x) { return x.dist > 0; }).sort(function (a, b) { return b.dist - a.dist; });
    if (!mine.length && !board.length) return null;
    var body = mine.length
      ? mine.length + ' run' + (mine.length === 1 ? '' : 's') + ', ' + distTxt(mine.reduce(function (a, r) { return a + (r.dist || 0); }, 0)) +
        ', ' + timeTxt(mine.reduce(function (a, r) { return a + (r.moving || 0); }, 0)) + ' running.'
      : 'No runs for ' + app.profileName() + ' last week. This week’s a fresh start.';
    if (board.length > 1) body += ' Medals: ' + ['🥇', '🥈', '🥉'].slice(0, board.length).map(function (m, i) { return m + ' ' + board[i].name; }).join(' ');
    return note(WEEKLY_ID, many() ? 'Weekly report and medals are in' : 'Your weekly report is ready', body, target);
  }

  /* ---------- booking ---------- */
  var busy = false, again = false;
  function reschedule() {
    if (!app) return;
    if (busy) { again = true; return; }
    busy = true;
    var ids = [WEEKLY_ID]; for (var i = 0; i < 7; i++) ids.push(STREAK_BASE + i);
    call(LN, 'cancel', { notifications: ids.map(function (id) { return { id: id }; }) }).catch(function () {})
      .then(function () {
        var list = [];
        if (N.nStreak) list = list.concat(streakNotes());
        if (N.nWeekly) { var w = weeklyNote(); if (w) list.push(w); }
        if (list.length) return call(LN, 'schedule', { notifications: list });
      })
      .catch(function (e) { console.warn('Couldn’t book reminders', e); })
      .then(function () { busy = false; if (again) { again = false; reschedule(); } });
  }
  function allowed() {
    var ok = function (r) { return r && Object.keys(r).some(function (k) { return r[k] === 'granted'; }); };
    return call(LN, 'checkPermissions').then(function (r) {
      return ok(r) ? true : call(LN, 'requestPermissions').then(ok);
    }).catch(function () { return false; });
  }

  /* ---------- run in progress ---------- */
  var svc = false, wasRunning = false;
  function runText(r) {
    var l = app.live(), parts = [timeTxt(r.moving || 0), distTxt(r.dist || 0)];
    if (l && l.speed > 0) parts.push((mi() ? l.speed / 1.609344 : l.speed).toFixed(1) + (mi() ? ' mph' : ' km/h'));
    if (l && l.hr) parts.push('♥ ' + l.hr);
    return parts.join(' · ');
  }
  function loop() {
    var r = app.liveRun(), active = !!(r && !r.demo);
    if (active && N.nRun !== false) {
      var o = { title: 'Run in progress', text: runText(r) };
      if (!svc) { if (document.visibilityState === 'visible') { svc = true; call(RUN, 'start', o).catch(function () { svc = false; }); } }
      else call(RUN, 'update', o).catch(function () {});
    } else if (svc) { svc = false; call(RUN, 'stop').catch(function () {}); }
    if (wasRunning && !r) setTimeout(reschedule, 1500);   // a run just ended: re-book reminders
    wasRunning = !!r;
  }

  /* ---------- Settings section ---------- */
  function buildUi() {
    var anchor = Array.prototype.filter.call(document.querySelectorAll('h3'), function (h) { return h.textContent.trim() === 'Devices and data'; })[0];
    if (!anchor || document.getElementById('nStreak')) return;
    var t = document.createElement('template');
    t.innerHTML = '<div id="nBox"><h3>Notifications</h3>' +
      '<label class="check"><input type="checkbox" id="nStreak"><span>Remind me when my streak needs a run</span></label>' +
      '<div class="field"><span class="flabel">Reminder time</span><input type="time" id="nStreakAt"></div>' +
      '<label class="check"><input type="checkbox" id="nWeekly"><span>Weekly report and medals, Monday at 8am</span></label>' +
      '<label class="check"><input type="checkbox" id="nRun"><span>Show a notification during runs</span></label>' +
      '<p class="fhint">The run notification keeps the treadmill and heart rate connected if the screen turns off or you switch apps. Reminders follow whichever profile was last used on this phone.</p></div>';
    anchor.parentNode.insertBefore(t.content, anchor);
    var $ = function (id) { return document.getElementById(id); };
    $('nStreak').checked = !!N.nStreak; $('nStreakAt').value = N.nStreakAt;
    $('nWeekly').checked = !!N.nWeekly; $('nRun').checked = N.nRun !== false;
    ['nStreak', 'nWeekly'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        var box = $(id);
        if (!box.checked) { N[id] = false; savePrefs(); reschedule(); return; }
        allowed().then(function (ok) {
          if (!ok) { box.checked = false; app.toast('Notifications are blocked. Allow them in Android Settings > Apps > MeMentum.'); return; }
          N[id] = true; savePrefs(); reschedule(); app.toast('Reminders on');
        });
      });
    });
    $('nStreakAt').addEventListener('change', function () { if ($('nStreakAt').value) { N.nStreakAt = $('nStreakAt').value; savePrefs(); reschedule(); } });
    $('nRun').addEventListener('change', function () {
      N.nRun = $('nRun').checked; savePrefs();
      if (N.nRun) allowed();
    });
  }

  function start() {
    app = window.mmApp; S = app.settings; defaults();
    call(LN, 'createChannel', { id: 'reminders', name: 'Reminders', description: 'Streak reminders and weekly reports', importance: 3 }).catch(function () {});
    buildUi();
    setTimeout(reschedule, 2500);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') reschedule(); });
    setInterval(loop, 3000);
  }
  if (window.mmApp) start(); else window.addEventListener('mmapp-ready', start, { once: true });
})();
