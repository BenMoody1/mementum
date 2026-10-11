/* MeMentum native adapter.
 *
 * In the Android app (Capacitor) this recreates the handful of browser APIs that
 * Android's WebView lacks, using native plugins, so index.html runs unchanged:
 *   - navigator.bluetooth  (Web Bluetooth subset)  -> @capacitor-community/bluetooth-le
 *   - speechSynthesis      (spoken cues)           -> @capacitor-community/text-to-speech
 *   - navigator.wakeLock   (screen stays on)       -> @capacitor-community/keep-awake
 *   - <a download> files   (backups, TCX)          -> @capacitor/filesystem, Share fallback
 *   - navigator.share      (share a run)           -> @capacitor/share
 * In Chrome / GitHub Pages it does nothing.
 */
(function () {
  'use strict';
  var C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;

  var call = function (plugin, method, opts) { return C.nativePromise(plugin, method, opts || {}); };
  var listen = function (plugin, event, cb) { return C.addListener(plugin, event, cb); };
  var domErr = function (name, msg) { var e = new Error(msg); e.name = name; return e; };
  var define = function (obj, prop, value) {
    try { Object.defineProperty(obj, prop, { value: value, configurable: true, writable: true }); }
    catch (e) { try { obj[prop] = value; } catch (_) {} }
  };

  /* ================= Bluetooth ================= */
  var BLE = 'BluetoothLe';
  var BASE = '-0000-1000-8000-00805f9b34fb';
  var NAMES = { heart_rate: 0x180d, heart_rate_measurement: 0x2a37, fitness_machine: 0x1826,
                battery_service: 0x180f, battery_level: 0x2a19, device_information: 0x180a };
  function uuid(u) {
    if (typeof u === 'string' && NAMES[u] != null) u = NAMES[u];
    if (typeof u === 'number') return ('00000000' + u.toString(16)).slice(-8) + BASE;
    u = String(u).toLowerCase();
    if (/^[0-9a-f]{4}$/.test(u)) return '0000' + u + BASE;
    if (/^[0-9a-f]{8}$/.test(u)) return u + BASE;
    return u;
  }
  function toHex(data) {
    var b = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    var s = ''; for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
  }
  function toView(hex) {
    hex = String(hex || '').replace(/[^0-9a-f]/gi, '');
    var a = new Uint8Array(hex.length >> 1);
    for (var i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
    return new DataView(a.buffer);
  }
  // Android handles one Bluetooth operation per device at a time, so each device gets its own
  // queue (the treadmill can't hold up the heart-rate monitor), and every operation has a time
  // limit so one unanswered request can never jam the queue.
  var queues = {};
  function withLimit(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error('timed out')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function queued(key, fn, ms) {
    var q = queues[key] || Promise.resolve();
    var run = function () { return withLimit(Promise.resolve().then(fn), ms || 8000); };
    var r = q.then(run, run);
    queues[key] = r.catch(function () {});
    return r;
  }

  function friendly(e) {
    var m = (e && e.message) || String(e);
    if (/permission/i.test(m)) return domErr('NotAllowedError', 'MeMentum doesn’t have permission to use Bluetooth. In Android Settings > Apps > MeMentum > Permissions, allow “Nearby devices”, then try again.');
    return e instanceof Error ? e : new Error(m);
  }
  var ready = null;
  function init() {
    if (!ready) ready = call(BLE, 'initialize', { androidNeverForLocation: true }).catch(function (e) { ready = null; throw friendly(e); });
    return ready;
  }
  function ensureOn() {
    return call(BLE, 'isEnabled').then(function (r) {
      if (r && r.value) return;
      return call(BLE, 'requestEnable').catch(function () {}).then(function () { return call(BLE, 'isEnabled'); })
        .then(function (r2) { if (!r2 || !r2.value) throw new Error('Bluetooth is switched off. Turn it on, then try again.'); });
    });
  }

  var KNOWN = 'mm-ble-known';
  function known() { try { return JSON.parse(localStorage.getItem(KNOWN)) || []; } catch (e) { return []; } }
  function remember(id) { var k = known(); if (k.indexOf(id) < 0) { k.push(id); localStorage.setItem(KNOWN, JSON.stringify(k)); } }

  var devices = new Map();
  function getDev(id, name) {
    var d = devices.get(id);
    if (!d) { d = new BleDevice(id, name); devices.set(id, d); }
    else if (name) d.name = name;
    return d;
  }

  function BleDevice(id, name) {
    var t = new EventTarget();
    t.id = id; t.name = name || '';
    t._chars = new Map();           // one object per characteristic, kept across reconnects
    t.gatt = new Gatt(t);
    return t;
  }

  function Gatt(device) {
    this.device = device; this.connected = false;
    this._live = false; this._svcs = null; this._discSub = null;
  }
  Gatt.prototype._fireDisconnect = function () {
    if (!this._live) return;
    this._live = false; this.connected = false; this._svcs = null;
    this.device._chars.forEach(function (c) { if (c._sub) { c._sub.remove(); c._sub = null; } });
    this.device.dispatchEvent(new Event('gattserverdisconnected'));
  };
  Gatt.prototype.connect = function () {
    var self = this, id = this.device.id;
    return init().then(function () {
      if (self.connected) return self;
      if (!self._discSub) self._discSub = listen(BLE, 'disconnected|' + id, function () { self._fireDisconnect(); });
      return queued(id, function () { return call(BLE, 'connect', { deviceId: id, timeout: 12000 }); }, 15000)
        .then(function () { self.connected = true; self._live = true; self._svcs = null; return self; }, function (e) {
          call(BLE, 'disconnect', { deviceId: id }).catch(function () {});   // cancel a half-made connection
          throw e;
        });
    });
  };
  Gatt.prototype.disconnect = function () {
    var id = this.device.id, was = this._live;
    queued(id, function () { return call(BLE, 'disconnect', { deviceId: id }); }).catch(function () {});
    if (was) this._fireDisconnect();   // Chrome fires the event on a manual disconnect too
  };
  Gatt.prototype._services = function () {
    var self = this;
    if (self._svcs) return Promise.resolve(self._svcs);
    return queued(self.device.id, function () { return call(BLE, 'getServices', { deviceId: self.device.id }); })
      .then(function (r) { self._svcs = (r && r.services) || []; return self._svcs; });
  };
  Gatt.prototype.getPrimaryService = function (s) {
    var self = this, want = uuid(s);
    if (!this.connected) return Promise.reject(domErr('NetworkError', 'GATT Server is disconnected.'));
    return this._services().then(function (list) {
      var raw = list.filter(function (x) { return String(x.uuid).toLowerCase() === want; })[0];
      if (!raw) throw domErr('NotFoundError', 'No Services matching UUID ' + want + ' found in Device.');
      return new BleService(self.device, raw);
    });
  };
  Gatt.prototype.getPrimaryServices = function () {
    var self = this;
    return this._services().then(function (list) { return list.map(function (raw) { return new BleService(self.device, raw); }); });
  };

  function BleService(device, raw) { this.device = device; this.uuid = String(raw.uuid).toLowerCase(); this.isPrimary = true; this._raw = raw; }
  BleService.prototype.getCharacteristic = function (c) {
    var want = uuid(c);
    var raw = (this._raw.characteristics || []).filter(function (x) { return String(x.uuid).toLowerCase() === want; })[0];
    if (!raw) return Promise.reject(domErr('NotFoundError', 'No Characteristics matching UUID ' + want + ' found in Service.'));
    var key = this.uuid + '|' + want, ch = this.device._chars.get(key);
    if (!ch) { ch = makeChar(this, want); this.device._chars.set(key, ch); }
    ch.service = this; ch.properties = raw.properties || {};
    return Promise.resolve(ch);
  };

  function makeChar(service, id) {
    var ch = new EventTarget();
    ch.service = service; ch.uuid = id; ch.value = null; ch._sub = null;
    var ids = function () { return { deviceId: ch.service.device.id, service: ch.service.uuid, characteristic: ch.uuid }; };
    ch.readValue = function () {
      return queued(ch.service.device.id, function () { return call(BLE, 'read', ids()); }).then(function (r) { ch.value = toView(r && r.value); return ch.value; });
    };
    ch.writeValueWithResponse = function (data) {
      return queued(ch.service.device.id, function () { var o = ids(); o.value = toHex(data); return call(BLE, 'write', o); }).then(function () {});
    };
    ch.writeValue = ch.writeValueWithResponse;
    ch.writeValueWithoutResponse = function (data) {
      return queued(ch.service.device.id, function () { var o = ids(); o.value = toHex(data); return call(BLE, 'writeWithoutResponse', o); }).then(function () {});
    };
    ch.startNotifications = function () {
      var i = ids();
      if (ch._sub) { ch._sub.remove(); ch._sub = null; }
      ch._sub = listen(BLE, 'notification|' + i.deviceId + '|' + i.service + '|' + i.characteristic, function (ev) {
        ch.value = toView(ev && ev.value);
        ch.dispatchEvent(new Event('characteristicvaluechanged'));
      });
      return queued(i.deviceId, function () { return call(BLE, 'startNotifications', i); }).then(function () { return ch; });
    };
    ch.stopNotifications = function () {
      if (ch._sub) { ch._sub.remove(); ch._sub = null; }
      return queued(ch.service.device.id, function () { return call(BLE, 'stopNotifications', ids()); }).then(function () { return ch; });
    };
    return ch;
  }

  var bluetooth = {
    getAvailability: function () {
      return init().then(function () { return call(BLE, 'isEnabled'); })
        .then(function (r) { return !!(r && r.value); }, function () { return false; });
    },
    requestDevice: function (opts) {
      opts = opts || {};
      var o = {};
      if (!opts.acceptAllDevices && opts.filters) {
        var svcs = [];
        opts.filters.forEach(function (f) {
          (f.services || []).forEach(function (s) { svcs.push(uuid(s)); });
          if (f.namePrefix) o.namePrefix = f.namePrefix;
          if (f.name) o.name = f.name;
        });
        if (svcs.length) o.services = svcs;
      }
      if (opts.optionalServices) o.optionalServices = opts.optionalServices.map(uuid);
      return init().then(ensureOn)
        .then(function () { return queued('picker', function () { return call(BLE, 'requestDevice', o); }, 120000); })
        .then(function (r) { remember(r.deviceId); return getDev(r.deviceId, r.name); }, function (e) {
          var m = (e && e.message) || '';
          if (/cancel|no device|not found|dismiss/i.test(m)) throw domErr('NotFoundError', 'User cancelled the requestDevice() chooser.');
          throw friendly(e);
        });
    },
    getDevices: function () {
      var ids = known();
      if (!ids.length) return Promise.resolve([]);
      return init().then(function () { return call(BLE, 'getDevices', { deviceIds: ids }); })
        .then(function (r) { return ((r && r.devices) || []).map(function (d) { return getDev(d.deviceId, d.name); }); });
    }
  };
  define(navigator, 'bluetooth', bluetooth);

  /* ================= Spoken cues ================= */
  var TTS = 'TextToSpeech';
  var voices = [];
  var synth = new EventTarget();
  synth.speaking = false; synth.pending = false; synth.paused = false; synth.onvoiceschanged = null;
  synth.getVoices = function () { return voices; };
  synth.speak = function (u) {
    var idx = u.voice ? voices.indexOf(u.voice) : -1;
    var o = { text: String(u.text || ''), lang: u.lang || 'en-GB', rate: u.rate == null ? 1 : u.rate,
              pitch: u.pitch == null ? 1 : u.pitch, volume: u.volume == null ? 1 : u.volume, queueStrategy: 1 };
    if (idx >= 0) o.voice = idx;
    synth.speaking = true;
    var done = function (type) { synth.speaking = false; u.dispatchEvent(new Event(type)); var h = u['on' + type]; if (typeof h === 'function') h.call(u); };
    call(TTS, 'speak', o).then(function () { done('end'); }, function () { done('error'); });
  };
  synth.cancel = function () { synth.speaking = false; call(TTS, 'stop').catch(function () {}); };
  synth.pause = function () {}; synth.resume = function () {};
  function Utterance(text) {
    var u = new EventTarget();
    u.text = text || ''; u.lang = 'en-GB'; u.voice = null; u.pitch = 1; u.rate = 1; u.volume = 1;
    u.onend = null; u.onerror = null; u.onstart = null;
    return u;
  }
  define(window, 'speechSynthesis', synth);
  define(window, 'SpeechSynthesisUtterance', Utterance);
  call(TTS, 'getSupportedVoices').then(function (r) {
    voices = (r && r.voices) || [];
    synth.dispatchEvent(new Event('voiceschanged'));
    if (typeof synth.onvoiceschanged === 'function') synth.onvoiceschanged();
  }).catch(function () {});

  /* ================= Keep the screen on ================= */
  define(navigator, 'wakeLock', {
    request: function () {
      return call('KeepAwake', 'keepAwake').then(function () {
        var s = new EventTarget();
        s.type = 'screen'; s.released = false;
        s.release = function () {
          if (s.released) return Promise.resolve();
          s.released = true;
          return call('KeepAwake', 'allowSleep').catch(function () {}).then(function () { s.dispatchEvent(new Event('release')); });
        };
        return s;
      });
    }
  });

  /* ================= Saving and sharing files ================= */
  function blobToBase64(blob) {
    return blob.arrayBuffer().then(function (buf) {
      var b = new Uint8Array(buf), s = '';
      for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return btoa(s);
    });
  }
  var safeName = function (n) { return String(n || 'file').replace(/[\\/:*?"<>|]+/g, '_'); };
  function shareBlobs(items, title) {
    return Promise.all(items.map(function (it) {
      return blobToBase64(it.blob).then(function (data) {
        return call('Filesystem', 'writeFile', { path: 'share/' + safeName(it.name), data: data, directory: 'CACHE', recursive: true });
      });
    })).then(function (written) {
      return call('Share', 'share', { title: title || items[0].name, dialogTitle: title || 'Share', files: written.map(function (w) { return w.uri; }) });
    }).catch(function (e) {
      if (/cancel/i.test((e && e.message) || '')) throw domErr('AbortError', 'Share canceled');
      throw e;
    });
  }
  // "Download": save into the phone's Download folder; if Android refuses, open the share sheet instead.
  function saveToDownloads(blob, name) {
    return blobToBase64(blob).then(function (data) {
      return call('Filesystem', 'writeFile', { path: 'Download/' + safeName(name), data: data, directory: 'EXTERNAL_STORAGE', recursive: true });
    }).catch(function () { return shareBlobs([{ blob: blob, name: name }], name); });
  }
  var origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var href = this.href || '';
    if (this.hasAttribute('download') && /^(blob|data):/.test(href)) {
      var name = this.download || 'file';
      fetch(href).then(function (r) { return r.blob(); })
        .then(function (b) { return saveToDownloads(b, name); })
        .catch(function (e) { if (!e || e.name !== 'AbortError') console.error('Save failed', e); });
      return;
    }
    return origClick.call(this);
  };
  define(navigator, 'canShare', function (d) { return !!(d && ((d.files && d.files.length) || d.text || d.url || d.title)); });
  define(navigator, 'share', function (d) {
    d = d || {};
    if (d.files && d.files.length) return shareBlobs(Array.prototype.map.call(d.files, function (f) { return { blob: f, name: f.name }; }), d.title);
    return call('Share', 'share', { title: d.title, text: d.text, url: d.url }).then(function () {}, function (e) {
      if (/cancel/i.test((e && e.message) || '')) throw domErr('AbortError', 'Share canceled');
      throw e;
    });
  });
})();
