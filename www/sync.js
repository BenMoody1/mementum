/* MeMentum household sync (Supabase).
 *
 * Keeps runs, profiles and per-profile settings the same on every device in a household.
 *  - Every write the app makes is noticed at the storage layer (localStorage + the run store),
 *    so no feature needs to know about sync.
 *  - Each run is its own row ("run|<storage key>|<run id>"); everything else is one row per
 *    storage key ("kv|<key>"), plus one row for the profile list ("profiles").
 *  - Newest edit wins: every row carries the editing device's timestamp (data.t).
 *  - Device-only things never sync: Bluetooth devices, run drafts, notification and
 *    Health Connect preferences, UI state, anything starting with "mm-".
 * Loaded before the app's main script so it can watch localStorage from the start.
 */
(function () {
  'use strict';
  var CFG = 'mm-sync-v1', DIRTY = 'mm-sync-dirty-v1';
  var PROF = 'tm-profiles-v1', RUNS = 'tm-runs-v1';
  var SYNC_BASES = ['tm-settings-v1', 'tm-workouts-v1', 'tm-plan-v1', 'tm-plans-done-v1', 'tm-preset-edits-v1',
    'tm-holidays-v1', 'tm-badges-seen-v1', 'tm-medals-seen-v1', 'tm-day-secured-v1', 'tm-summary-week-v1',
    'tm-month-shown-v1', 'tm-risk-told-v1'];
  var PAGE = 500, BATCH_BYTES = 400000;

  var ls = window.localStorage;
  var origSet = Storage.prototype.setItem, origRemove = Storage.prototype.removeItem;
  var lsSet = function (k, v) { origSet.call(ls, k, v); };
  var lsRemove = function (k) { origRemove.call(ls, k); };
  var readJSON = function (k, d) { try { var v = ls.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  var baseOf = function (k) { var i = k.indexOf('@'); return i < 0 ? k : k.slice(0, i); };
  var isKv = function (k) { return SYNC_BASES.indexOf(baseOf(k)) >= 0; };
  var isRunsKey = function (k) { return baseOf(k) === RUNS; };
  var sigRun = function (r) { return JSON.stringify(r, function (k, v) { return k === 'samples' ? (v ? v.length : 0) : v; }); };
  var rid = function (n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); };

  var cfg = readJSON(CFG, null);       // { url, key, household, device, cursor: {at,key}, last, err }
  var dirty = readJSON(DIRTY, {});     // row key -> local edit time
  var saveCfg = function () { if (cfg) lsSet(CFG, JSON.stringify(cfg)); else lsRemove(CFG); };
  var saveDirty = function () { lsSet(DIRTY, JSON.stringify(dirty)); };
  var on = function () { return !!(cfg && cfg.household && cfg.url && cfg.key); };

  var A = null, booted = false, applying = false, lateApply = false;
  var known = {}, runSnap = {};
  var listeners = [];
  var status = { busy: false };
  function emit() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }

  /* ---------- noticing local changes ---------- */
  function mark(rk) { dirty[rk] = Date.now(); saveDirty(); schedulePush(); }
  function lsChanged(k) {
    if (!booted || applying || !on()) return;
    if (k === PROF) {
      var p = readJSON(PROF, null), s = JSON.stringify((p && p.list) || []);
      if (known.profiles !== s) { known.profiles = s; mark('profiles'); }
    } else if (isKv(k)) {
      var raw = ls.getItem(k);
      if (known['kv|' + k] !== raw) { known['kv|' + k] = raw; mark('kv|' + k); }
    }
  }
  Storage.prototype.setItem = function (k, v) { origSet.call(this, k, v); if (this === ls) lsChanged(k); };
  Storage.prototype.removeItem = function (k) { origRemove.call(this, k); if (this === ls) lsChanged(k); };

  function bigChanged(sk) {
    if (!booted || applying || !on() || !isRunsKey(sk)) return;
    var arr = A.bigGet(sk, null) || [], prev = runSnap[sk] || {}, next = {};
    arr.forEach(function (r) {
      if (!r || r.id == null) return;
      var id = String(r.id), s = sigRun(r); next[id] = s;
      if (prev[id] !== s) mark('run|' + sk + '|' + id);
    });
    Object.keys(prev).forEach(function (id) { if (!(id in next)) mark('run|' + sk + '|' + id); });
    runSnap[sk] = next;
  }

  function snapshot() {
    known = {}; runSnap = {};
    var p = readJSON(PROF, null);
    known.profiles = JSON.stringify((p && p.list) || []);
    for (var i = 0; i < ls.length; i++) { var k = ls.key(i); if (isKv(k)) known['kv|' + k] = ls.getItem(k); }
    A.profiles.list.forEach(function (pr) {
      var sk = A.keyFor(RUNS, pr.id), m = {};
      (A.bigGet(sk, []) || []).forEach(function (r) { if (r && r.id != null) m[String(r.id)] = sigRun(r); });
      runSnap[sk] = m;
    });
  }
  function markAll() {
    var t = Date.now();
    dirty.profiles = t;
    Object.keys(known).forEach(function (rk) { if (rk.indexOf('kv|') === 0 && known[rk] !== null) dirty[rk] = t; });
    Object.keys(runSnap).forEach(function (sk) { Object.keys(runSnap[sk]).forEach(function (id) { dirty['run|' + sk + '|' + id] = t; }); });
    saveDirty();
  }

  /* ---------- talking to Supabase ---------- */
  function api(path, opt) {
    opt = opt || {};
    var h = { apikey: cfg.key, 'x-household': cfg.household, 'Content-Type': 'application/json' };
    if (/^eyJ/.test(cfg.key)) h.Authorization = 'Bearer ' + cfg.key;   // older "anon" keys are JWTs
    if (opt.headers) Object.keys(opt.headers).forEach(function (k) { h[k] = opt.headers[k]; });
    return fetch(cfg.url + '/rest/v1/' + path, { method: opt.method || 'GET', headers: h, body: opt.body })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { var e = new Error('HTTP ' + r.status + ' ' + t.slice(0, 160)); e.status = r.status; throw e; });
        return r.text().then(function (t) { return t ? JSON.parse(t) : null; });
      });
  }
  function friendly(e) {
    var m = (e && e.message) || String(e);
    if (e && (e.status === 401 || e.status === 403)) return 'Supabase refused the request. Check the API key.';
    if (e && e.status === 404) return 'The MeMentum table wasn’t found. Run the setup script in Supabase’s SQL Editor.';
    if (/Failed to fetch|NetworkError|Load failed|TypeError/i.test(m) || (e && e.status >= 500))
      return 'Couldn’t reach Supabase. If nobody has used MeMentum for a week, open supabase.com and restore the project; otherwise check your internet.';
    return m;
  }

  var chain = Promise.resolve();
  function serial(fn) { var p = chain.then(fn, fn); chain = p.catch(function () {}); return p; }

  function localItem(rk) {
    if (rk === 'profiles') { var p = readJSON(PROF, null); return p ? { v: { list: p.list } } : { deleted: true }; }
    var i = rk.indexOf('|'), kind = rk.slice(0, i), rest = rk.slice(i + 1);
    if (kind === 'kv') { var raw = ls.getItem(rest); return raw === null ? { deleted: true } : { v: JSON.parse(raw) }; }
    var j = rest.lastIndexOf('|'), sk = rest.slice(0, j), id = rest.slice(j + 1);
    var r = (A.bigGet(sk, []) || []).filter(function (x) { return x && String(x.id) === id; })[0];
    return r ? { v: r } : { deleted: true };
  }

  function doPush() {
    var keys = Object.keys(dirty);
    if (!keys.length || !on() || !A) return Promise.resolve(0);
    var batches = [[]], size = 0;
    keys.forEach(function (rk) {
      var t = dirty[rk], it = localItem(rk);
      var row = { household: cfg.household, key: rk, device: cfg.device, deleted: !!it.deleted, data: it.deleted ? { t: t } : { t: t, v: it.v } };
      var n = JSON.stringify(row).length;
      if (size + n > BATCH_BYTES && batches[batches.length - 1].length) { batches.push([]); size = 0; }
      batches[batches.length - 1].push({ row: row, rk: rk, t: t }); size += n;
    });
    var sent = 0;
    return batches.reduce(function (p, b) {
      return p.then(function () {
        return api('mm_items?on_conflict=household,key', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(b.map(function (x) { return x.row; }))
        }).then(function () {
          b.forEach(function (x) { if (dirty[x.rk] === x.t) delete dirty[x.rk]; });
          saveDirty(); sent += b.length;
        });
      });
    }, Promise.resolve()).then(function () { return sent; });
  }

  function applyItem(rk, deleted, v) {
    if (rk === 'profiles') {
      if (deleted || !v || !Array.isArray(v.list) || !v.list.length) return false;
      var s = JSON.stringify(v.list);
      if (known.profiles === s) return false;
      A.profiles.list = v.list;
      if (!v.list.some(function (x) { return x.id === A.profiles.current; })) A.profiles.current = v.list[0].id;
      A.saveProfiles(); known.profiles = s;
      return true;
    }
    var i = rk.indexOf('|'), kind = rk.slice(0, i), rest = rk.slice(i + 1);
    if (kind === 'kv') {
      if (!isKv(rest)) return false;
      var cur = ls.getItem(rest);
      if (deleted) { if (cur === null) return false; lsRemove(rest); known[rk] = null; return true; }
      var sv = JSON.stringify(v);
      if (cur === sv) return false;
      lsSet(rest, sv); known[rk] = sv;
      return true;
    }
    if (kind === 'run') {
      var j = rest.lastIndexOf('|'), sk = rest.slice(0, j), id = rest.slice(j + 1);
      if (!isRunsKey(sk)) return false;
      var arr = (A.bigGet(sk, []) || []).slice(), at = -1;
      arr.forEach(function (x, n) { if (x && String(x.id) === id) at = n; });
      var snap = runSnap[sk] || (runSnap[sk] = {});
      if (deleted) {
        if (at < 0) return false;
        arr.splice(at, 1); delete snap[id];
      } else {
        if (!v || v.id == null) return false;
        var sg = sigRun(v);
        if (at >= 0 && sigRun(arr[at]) === sg) return false;
        if (at >= 0) arr[at] = v; else arr.push(v);
        arr.sort(function (a, b) { return b.date - a.date; });
        snap[id] = sg;
      }
      A.bigSet(sk, arr);
      return true;
    }
    return false;
  }

  function doPull() {
    if (!on() || !A) return Promise.resolve(0);
    var applied = 0;
    function page() {
      var c = cfg.cursor, q = 'mm_items?select=key,data,deleted,device,updated_at&household=eq.' + encodeURIComponent(cfg.household) +
        '&order=updated_at.asc,key.asc&limit=' + PAGE;
      if (c) q += '&or=' + encodeURIComponent('(updated_at.gt."' + c.at + '",and(updated_at.eq."' + c.at + '",key.gt."' + c.key.replace(/"/g, '\\"') + '"))');
      return api(q).then(function (rows) {
        applying = true;
        try {
          (rows || []).forEach(function (r) {
            var d = r.data || {}, t = d.t || 0;
            cfg.cursor = { at: r.updated_at, key: r.key };
            if (r.device === cfg.device) return;              // our own write coming back
            if (dirty[r.key] && dirty[r.key] > t) return;      // we have a newer local edit; it'll be pushed
            delete dirty[r.key];
            if (applyItem(r.key, r.deleted, d.v)) applied++;
          });
        } finally { applying = false; }
        saveCfg(); saveDirty();
        if (rows && rows.length === PAGE) return page();
      });
    }
    return page().then(function () { return applied; });
  }

  /* ---------- when to sync ---------- */
  var pushTimer = null, reloadWanted = false, lastTouch = 0;
  function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(function () { sync(false); }, 3000); }
  document.addEventListener('pointerdown', function () { lastTouch = Date.now(); }, true);

  function sync(pullToo) {
    if (!on() || !A) return Promise.resolve();
    status.busy = true; emit();
    return serial(function () {
      return (pullToo ? doPull() : Promise.resolve(0)).then(function (n) {
        return doPush().then(function () { return n; });
      });
    }).then(function (n) {
      cfg.last = Date.now(); cfg.err = null; saveCfg();
      if (n && lateApply) { reloadWanted = true; tryReload(); }
    }, function (e) {
      cfg.err = friendly(e); saveCfg();
    }).then(function () { status.busy = false; emit(); });
  }
  // Newly arrived data is shown by reloading, but never mid-run or while you're using the screen.
  function tryReload() {
    if (!reloadWanted) return;
    var app = window.mmApp;
    var busy = (app && app.liveRun && app.liveRun()) || document.querySelector('dialog[open]') ||
      (document.visibilityState === 'visible' && Date.now() - lastTouch < 15000);
    if (busy) { setTimeout(tryReload, 5000); return; }
    reloadWanted = false;
    Promise.resolve(A.flush()).then(function () { location.reload(); });
  }

  var auto = false;
  function startAuto() {   // sync when you come back to the app, when back online, and every 90 s while open
    lateApply = true;
    if (auto) return; auto = true;
    document.addEventListener('visibilitychange', function () { sync(document.visibilityState === 'visible'); });
    window.addEventListener('online', function () { sync(true); });
    setInterval(function () { if (document.visibilityState === 'visible') sync(true); }, 90000);
  }
  function boot(a) {
    A = a; snapshot(); booted = true;
    if (!on()) return Promise.resolve();
    // Give the first pull a few seconds so new data is there before the app reads it; if the
    // network is slow, carry on and show the data with a reload once it arrives.
    var first = sync(true);
    return Promise.race([first, new Promise(function (r) { setTimeout(r, 4000); })]).then(startAuto);
  }

  /* ---------- setting up ---------- */
  var normUrl = function (u) { u = String(u || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, ''); if (u && !/^https?:\/\//.test(u)) u = 'https://' + u; return u; };
  function setupCode() { return 'MM1.' + btoa(JSON.stringify({ u: cfg.url, k: cfg.key, h: cfg.household })); }
  function readCode(s) {
    s = String(s || '').trim();
    if (s.indexOf('MM1.') !== 0) throw new Error('That isn’t a MeMentum setup code. It should start with MM1.');
    var o = JSON.parse(atob(s.slice(4)));
    if (!o.u || !o.k || !o.h) throw new Error('That setup code is incomplete.');
    return o;
  }
  function create(url, key) {
    var prev = cfg;
    cfg = { url: normUrl(url), key: String(key || '').trim(), household: rid(18), device: rid(8), cursor: null };
    if (!cfg.url || !cfg.key) { cfg = prev; return Promise.reject(new Error('Enter your Supabase project URL and API key first.')); }
    return api('mm_items?select=key&limit=1').then(function () {
      saveCfg(); snapshot(); markAll(); startAuto();
      return sync(true);
    }, function (e) { cfg = prev; throw new Error(friendly(e)); });
  }
  function join(code) {
    var o, prev = cfg;
    try { o = readCode(code); } catch (e) { return Promise.reject(e); }
    cfg = { url: normUrl(o.u), key: o.k, household: o.h, device: rid(8), cursor: null };
    return api('mm_items?select=key&household=eq.' + encodeURIComponent(o.h) + '&limit=1').then(function (rows) {
      if (!rows || !rows.length) throw new Error('No household found for that setup code. Start syncing on your main device first.');
      // this device takes the household's data: clear what's here, then download everything
      applying = true;
      try {
        for (var i = ls.length - 1; i >= 0; i--) { var k = ls.key(i); if (isKv(k)) lsRemove(k); }
        A.profiles.list.forEach(function (p) { A.bigDel(A.keyFor(RUNS, p.id)); });
      } finally { applying = false; }
      known = { profiles: '' }; runSnap = {}; dirty = {}; saveDirty(); saveCfg();
      return serial(doPull);
    }).then(function () {
      cfg.last = Date.now(); saveCfg();
      return Promise.resolve(A.flush()).then(function () { location.reload(); });
    }, function (e) { cfg = prev; saveCfg(); throw new Error(e.status || e instanceof TypeError ? friendly(e) : e.message); });
  }
  function leave() { cfg = null; saveCfg(); dirty = {}; saveDirty(); emit(); }

  /* ---------- Settings section ---------- */
  function ago(t) {
    var s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago';
  }
  function buildUi() {
    var app = window.mmApp;
    var anchor = Array.prototype.filter.call(document.querySelectorAll('h3'), function (h) { return h.textContent.trim() === 'Devices and data'; })[0];
    if (!anchor || document.getElementById('syncBox')) return;
    var t = document.createElement('template');
    t.innerHTML = '<div id="syncBox"><h3>Sync across devices</h3>' +
      '<p class="fhint" id="syncStatus"></p>' +
      '<div id="syncSetup">' +
        '<p class="fhint">Keep runs, profiles, streaks and badges the same on every phone and tablet in your household. Start on the device that has your runs, then join from the others with the setup code.</p>' +
        '<div class="field"><span class="flabel">Supabase project URL</span><input type="url" id="syncUrl" placeholder="https://xxxx.supabase.co" autocomplete="off"></div>' +
        '<div class="field"><span class="flabel">Supabase API key</span><input type="text" id="syncKey" placeholder="Publishable (or anon) key" autocomplete="off"></div>' +
        '<div class="row"><button class="sm primary" id="syncCreate">Start syncing from this device</button></div>' +
        '<div class="field"><span class="flabel">Or join with a setup code</span><input type="text" id="syncCode" placeholder="MM1.…" autocomplete="off"></div>' +
        '<div class="row"><button class="sm" id="syncJoin">Join household</button></div>' +
      '</div>' +
      '<div id="syncOn">' +
        '<div class="row"><button class="sm" id="syncNow">Sync now</button><button class="sm" id="syncShare">Share setup code</button><button class="sm" id="syncLeave">Stop syncing</button></div>' +
        '<p class="fhint">The setup code lets another device join. Keep it private: anyone with it can see and change your household’s runs.</p>' +
      '</div></div>';
    anchor.parentNode.insertBefore(t.content, anchor);
    var $ = function (id) { return document.getElementById(id); };
    var toast = function (m) { if (app && app.toast) app.toast(m); };
    function render() {
      $('syncSetup').hidden = on(); $('syncOn').hidden = !on();
      var st = $('syncStatus');
      if (!on()) st.textContent = 'Off. Runs stay on this device only.';
      else if (status.busy) st.textContent = 'Syncing…';
      else if (cfg.err) st.textContent = cfg.err;
      else st.textContent = 'On. Last synced ' + (cfg.last ? ago(cfg.last) : 'never') + (Object.keys(dirty).length ? ', ' + Object.keys(dirty).length + ' change(s) waiting to upload.' : '.');
    }
    listeners.push(render); setInterval(render, 30000); render();
    var busyBtn = function (b, p) { b.disabled = true; return p.then(function (x) { b.disabled = false; render(); return x; }, function (e) { b.disabled = false; render(); throw e; }); };

    $('syncCreate').onclick = function () {
      busyBtn($('syncCreate'), create($('syncUrl').value, $('syncKey').value))
        .then(function () { toast('Syncing is on. Use Share setup code to add your other devices.'); }, function (e) { toast(e.message); });
    };
    $('syncJoin').onclick = function () {
      if (!confirm('Join this household? This device’s runs and profiles will be replaced with the household’s. If this device has runs you want to keep, back them up first.')) return;
      busyBtn($('syncJoin'), join($('syncCode').value)).catch(function (e) { toast(e.message); });
    };
    $('syncNow').onclick = function () { busyBtn($('syncNow'), sync(true)).then(function () { toast(cfg && cfg.err ? cfg.err : 'Synced'); }); };
    $('syncShare').onclick = function () {
      var code = setupCode();
      var copy = function () { return navigator.clipboard.writeText(code).then(function () { toast('Setup code copied'); }); };
      (navigator.share ? navigator.share({ title: 'MeMentum setup code', text: code }) : Promise.reject()).catch(function (e) {
        if (!e || e.name !== 'AbortError') return copy().catch(function () { prompt('Copy this setup code', code); });
      });
    };
    $('syncLeave').onclick = function () {
      if (!confirm('Stop syncing on this device? Its runs stay here, but it won’t send or receive changes any more.')) return;
      leave(); toast('Syncing stopped on this device');
    };
  }
  window.addEventListener('mmapp-ready', buildUi, { once: true });

  window.mmSync = { boot: boot, bigChanged: bigChanged, syncNow: function () { return sync(true); }, create: create, join: join, setupCode: function () { return on() ? setupCode() : null; }, _debug: function () { return { cfg: cfg, dirty: dirty, known: known, runSnap: runSnap }; } };
})();
