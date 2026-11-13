/* MeMentum: the podium celebration. Players take their steps, two champagne bottles shake and pop
 * (a small physics simulation for the spray, froth and bubbles), confetti cannons fire, and a patch
 * or medal lands at the end. Used for finished journeys, finished challenges and weekly medals.
 *
 * mmPodium.show({ title, sub, players: [{ name, photo, label, place, still }], finale: { html, title, sub },
 *                 sfx: { roll, pop(pan), fizz, fanfare } })  ->  Promise, resolved when closed.
 * Celebrations queue, so two at once play one after the other.
 */
(function () {
  'use strict';
  var queue = Promise.resolve(), T0 = 3.9;
  var STEP = { 1: ['#E9B949', '#5A3F00', 108], 2: ['#C9CED6', '#3A4048', 78], 3: ['#D49A6A', '#4F2A10', 54] };
  var CONF = ['#E63946', '#F4A261', '#E9C46A', '#2A9D8F', '#457B9D', '#9C6ADE'];
  var reduced = function () { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  var CSS = '' +
    'dialog.pdm{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;border-radius:0;background:var(--paper,#EEF1EC);color:var(--ink,#18211D);overflow:hidden;font-family:var(--body,system-ui)}' +
    'dialog.pdm::backdrop{background:var(--paper,#EEF1EC)}' +
    '.pdm .a{position:absolute}' +
    '.pdm-skip{position:absolute;top:calc(env(safe-area-inset-top,0px) + 10px);right:12px;z-index:3;font:inherit;font-weight:600;min-height:40px;padding:0 14px;border-radius:999px;border:1px solid var(--rule,#CDD4CC);background:var(--surface,#fff);color:inherit}' +
    '.pdm-stage{position:absolute;left:50%;top:calc(env(safe-area-inset-top,0px) + 8px);bottom:0;width:min(100%,440px);transform:translateX(-50%)}' +
    '.pdm-ttl{top:34px;left:0;right:0;text-align:center;padding:0 60px}' +
    '.pdm-ttl b{display:block;font-family:var(--num,inherit);font-size:30px;line-height:1.1}' +
    '.pdm-ttl span{display:block;color:var(--muted,#56625B);font-size:15px;margin-top:2px}' +
    '.pdm-pod{left:0;right:0;top:118px;height:250px;display:flex;align-items:flex-end;justify-content:center;gap:8px}' +
    '.pdm-col{display:flex;flex-direction:column;align-items:center;width:100px}' +
    '.pdm-pl{display:flex;flex-direction:column;align-items:center;text-align:center}' +
    '.pdm-av{width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;overflow:hidden;border:2px solid currentColor}' +
    '.pdm-av img{width:100%;height:100%;object-fit:cover}' +
    '.pdm-col.p1 .pdm-av{width:58px;height:58px}' +
    '.pdm-nm{font-weight:600;font-size:15px;margin-top:4px;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.pdm-lb{font-size:13px;color:var(--muted,#56625B)}' +
    '.pdm-crown{font-size:22px;line-height:1}' +
    '.pdm-blk{width:100%;border-radius:10px 10px 0 0;transform-origin:bottom;display:flex;justify-content:center;padding-top:8px;font-family:var(--num,inherit);font-weight:700;font-size:26px;margin-top:8px}' +
    '.pdm-rays{left:50%;top:170px;width:0;height:0}' +
    '.pdm-ray{position:absolute;left:-2px;top:-130px;width:4px;height:130px;background:#E9B949;transform-origin:50% 100%;border-radius:2px}' +
    '.pdm-bot{top:236px;width:40px;height:120px;transform-origin:bottom center}' +
    '.pdm-bot.l{left:8px;transform:rotate(25deg)}.pdm-bot.r{right:8px;transform:rotate(-25deg)}' +
    '.pdm-mouth{position:absolute;left:20px;top:14px;width:1px;height:1px}' +
    '.pdm-fin{left:0;right:0;top:400px;display:flex;flex-direction:column;align-items:center;text-align:center;padding:0 16px}' +
    '.pdm-fin .pdm-art{position:relative;width:112px;height:112px;display:flex;align-items:center;justify-content:center}' +
    '.pdm-fin .pdm-art>svg,.pdm-fin .pdm-art>.pdm-medal{width:112px;height:112px}' +
    '.pdm-medal{border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:56px;border:4px solid}' +
    '.pdm-ring{inset:0;border-radius:50%;border:3px solid #E9B949}' +
    '.pdm-fin b{font-size:19px;margin-top:10px}.pdm-fin span{font-size:14px;color:var(--muted,#56625B)}' +
    '.pdm-done{position:absolute;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 22px);transform:translateX(-50%);z-index:3;font:inherit;font-weight:700;min-height:48px;padding:0 34px;border-radius:999px;border:0;background:var(--track,#B5372A);color:var(--track-ink,#fff)}' +
    '.pdm canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2}' +
    '.pdm .o0{opacity:0}' +
    '.pdm.go .pdm-ttl{animation:pdTtl .6s both cubic-bezier(.2,1.5,.4,1)}' +
    '.pdm.go .pdm-blk{animation:pdRise .5s both cubic-bezier(.2,1.3,.3,1)}' +
    '.pdm.go .pdm-pl{animation:pdDrop .55s both cubic-bezier(.3,1.5,.5,1)}' +
    '.pdm.go .pdm-rays{animation:pdRays 7s 2.6s both linear}' +
    '.pdm.go .pdm-win{animation:pdHop .5s 3.9s 3}' +
    '.pdm.go .pdm-shk{animation:pdQuake .5s 3.9s}' +
    '.pdm.go .pdm-bot.l{animation:pdShakeL 1.1s 2.8s both}.pdm.go .pdm-bot.r{animation:pdShakeR 1.1s 2.8s both}' +
    '.pdm.go .pdm-cork{animation:pdPop 1s 3.9s both cubic-bezier(.1,.7,.4,1)}' +
    '.pdm.go .pdm-cn{animation:pdCannon 2s both cubic-bezier(.15,.7,.3,1)}' +
    '.pdm.go .pdm-cf{animation:pdFall 3s linear both}' +
    '.pdm.go .pdm-in{animation:pdBadge .8s 6.2s both cubic-bezier(.2,1.5,.4,1)}' +
    '.pdm.go .pdm-ring{animation:pdRing .8s 6.5s both}' +
    '.pdm.go .pdm-fade{animation:pdFade .5s both}' +
    '.pdm.go .pdm-done{animation:pdFade .4s 6.9s both}' +
    '@keyframes pdTtl{from{opacity:0;transform:scale(.4)}}@keyframes pdRise{from{transform:scaleY(0)}}@keyframes pdDrop{from{opacity:0;transform:translateY(-70px)}}@keyframes pdFade{from{opacity:0}}' +
    '@keyframes pdRays{0%{opacity:0;transform:rotate(0) scale(.2)}8%{opacity:.45;transform:rotate(12deg) scale(1)}100%{opacity:.45;transform:rotate(160deg) scale(1)}}' +
    '@keyframes pdHop{50%{transform:translateY(-16px)}}' +
    '@keyframes pdQuake{20%{transform:translate(-6px,3px)}40%{transform:translate(6px,-3px)}60%{transform:translate(-4px,-2px)}80%{transform:translate(3px,2px)}}' +
    '@keyframes pdShakeL{0%{opacity:0;transform:translateY(30px) rotate(25deg)}20%{opacity:1;transform:rotate(25deg)}35%{transform:rotate(40deg)}50%{transform:rotate(12deg)}65%{transform:rotate(40deg)}80%{transform:rotate(12deg)}100%{transform:rotate(25deg)}}' +
    '@keyframes pdShakeR{0%{opacity:0;transform:translateY(30px) rotate(-25deg)}20%{opacity:1;transform:rotate(-25deg)}35%{transform:rotate(-40deg)}50%{transform:rotate(-12deg)}65%{transform:rotate(-40deg)}80%{transform:rotate(-12deg)}100%{transform:rotate(-25deg)}}' +
    '@keyframes pdPop{from{opacity:1;transform:none}to{opacity:0;transform:translate(var(--cx),-360px) rotate(540deg)}}' +
    '@keyframes pdCannon{0%{opacity:1;transform:none}45%{opacity:1;transform:translate(var(--bx),var(--by)) rotate(300deg)}100%{opacity:0;transform:translate(calc(var(--bx)*1.25),calc(var(--by) + 300px)) rotate(700deg)}}' +
    '@keyframes pdFall{from{opacity:1;transform:translateY(-20px) rotate(0)}85%{opacity:1}to{opacity:0;transform:translateY(110vh) rotate(620deg)}}' +
    '@keyframes pdBadge{from{opacity:0;transform:scale(.1) rotate(-200deg)}}' +
    '@keyframes pdRing{from{opacity:.9;transform:scale(.6)}to{opacity:0;transform:scale(2.4)}}' +
    '@media (prefers-reduced-motion:reduce){.pdm.go *{animation:none!important}}';

  var BOTTLE = '<svg width="40" height="120" viewBox="0 0 40 120" aria-hidden="true">' +
    '<path d="M16 14h8v24c0 12 12 16 12 32v42a6 6 0 0 1-6 6h-20a6 6 0 0 1-6-6v-42c0-16 12-20 12-32z" fill="#0F6E56"/>' +
    '<path d="M24 38c0 12 12 16 12 32v42a6 6 0 0 1-6 6h-4v-80z" fill="#085041"/>' +
    '<rect x="8" y="56" width="3" height="16" rx="1.5" fill="#5DCAA5"/><rect x="17.5" y="20" width="2" height="16" rx="1" fill="#5DCAA5"/>' +
    '<path d="M15 14h10v22l-2.5-3-2.5 3-2.5-3-2.5 3z" fill="#EF9F27"/><rect x="14" y="14" width="12" height="4" rx="1" fill="#BA7517"/>' +
    '<rect x="8" y="76" width="24" height="28" rx="2" fill="#FAEEDA"/><rect x="8" y="84" width="24" height="6" fill="#BA7517"/><circle cx="20" cy="97" r="3" fill="#BA7517"/></svg>';
  var CORK = function (cx) { return '<svg class="pdm-cork a" style="--cx:' + cx + 'px;left:12px;top:0" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6a6 5 0 0 1 12 0v3h-2.5v7h-7v-7h-2.5z" fill="#FAC775"/><rect x="4.5" y="10" width="7" height="1.6" fill="#BA7517"/></svg>'; };

  function addCss() { if (document.getElementById('pdmCss')) return; var s = document.createElement('style'); s.id = 'pdmCss'; s.textContent = CSS; document.head.appendChild(s); }

  function player(p, delay) {
    var c = STEP[p.place];
    return '<div class="pdm-col p' + p.place + '">' +
      '<div class="pdm-pl" style="animation-delay:' + delay + 's"><div class="' + (p.place === 1 ? 'pdm-win' : '') + '" style="display:flex;flex-direction:column;align-items:center">' +
      (p.place === 1 ? '<span class="pdm-crown" aria-hidden="true">👑</span>' : '') +
      '<span class="pdm-av" style="background:' + c[0] + ';color:' + c[1] + '">' + (p.photo ? '<img src="' + esc(p.photo) + '" alt="">' : esc((String(p.name).trim()[0] || '?').toUpperCase())) + '</span>' +
      '<span class="pdm-nm">' + esc(p.name) + '</span><span class="pdm-lb">' + esc(p.label || '') + '</span></div></div>' +
      '<div class="pdm-blk" style="height:' + c[2] + 'px;background:' + c[0] + ';color:' + c[1] + ';animation-delay:' + (0.2 + (3 - p.place) * 0.2) + 's">' + p.place + '</div></div>';
  }

  function build(o) {
    var byPlace = {}; (o.players || []).slice(0, 3).forEach(function (p) { byPlace[p.place] = p; });
    var cols = [2, 1, 3].filter(function (k) { return byPlace[k]; }).map(function (k) { return player(byPlace[k], { 1: 2.4, 2: 1.9, 3: 1.4 }[k]); }).join('');
    // a modal <dialog>, so it opens above anything already open (such as a walk/run's summary)
    var el = document.createElement('dialog');
    el.className = 'pdm'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', o.title || 'Celebration');
    el.innerHTML = '<button class="pdm-skip" type="button">Skip</button>' +
      '<div class="pdm-stage"><div class="pdm-shk a" style="inset:0">' +
      '<div class="a pdm-ttl"><b>' + esc(o.title) + '</b><span>' + esc(o.sub || '') + '</span></div>' +
      '<div class="a pdm-rays" aria-hidden="true"></div>' +
      '<div class="a pdm-pod">' + cols + '</div>' +
      '<div class="a pdm-bot l">' + BOTTLE + CORK(40) + '<i class="pdm-mouth"></i></div>' +
      '<div class="a pdm-bot r">' + BOTTLE + CORK(-40) + '<i class="pdm-mouth"></i></div>' +
      '<div class="a pdm-fin"><div class="pdm-art"><div class="pdm-ring a"></div><div class="pdm-in">' + (o.finale && o.finale.html || '') + '</div></div>' +
      '<b class="pdm-in" style="animation-delay:6.6s">' + esc(o.finale && o.finale.title || '') + '</b>' +
      '<span class="pdm-in" style="animation-delay:6.7s">' + esc(o.finale && o.finale.sub || '') + '</span></div>' +
      '</div></div><div class="pdm-conf a" style="inset:0;pointer-events:none;z-index:1" aria-hidden="true"></div>' +
      '<canvas aria-hidden="true"></canvas><button class="pdm-done" type="button">Done</button>';
    var rays = el.querySelector('.pdm-rays');
    for (var r = 0; r < 14; r++) { var ray = document.createElement('div'); ray.className = 'pdm-ray'; ray.style.transform = 'rotate(' + Math.round(r * 360 / 14) + 'deg)'; rays.appendChild(ray); }
    var conf = el.querySelector('.pdm-conf'), R = Math.random;
    function bit(cls, css, vars) { var e = document.createElement('div'); e.className = cls; e.style.cssText = css; for (var k in vars) e.style.setProperty(k, vars[k]); conf.appendChild(e); }
    for (var w = 0; w < 2; w++) for (var c = 0; c < 70; c++) {
      var left = c % 2 === 0, thin = c % 3 === 0;
      bit('pdm-cn', 'position:absolute;opacity:0;bottom:6px;' + (left ? 'left:6px' : 'right:6px') + ';width:' + (thin ? 4 : 8) + 'px;height:' + (thin ? 14 : 11) + 'px;border-radius:1px;background:' + CONF[c % 6] + ';animation-delay:' + (T0 + w * 0.7 + R() * 0.25).toFixed(2) + 's',
        { '--bx': Math.round((left ? 1 : -1) * (30 + R() * 320)) + 'px', '--by': Math.round(-180 - R() * 380) + 'px' });
    }
    for (var f = 0; f < 70; f++) bit('pdm-cf', 'position:absolute;opacity:0;top:0;left:' + Math.round(R() * 96 + 2) + '%;width:' + (f % 3 ? 7 : 4) + 'px;height:' + (f % 3 ? 11 : 14) + 'px;border-radius:1px;background:' + CONF[f % 6] + ';animation-delay:' + (4.3 + R() * 2.4).toFixed(2) + 's', {});
    return el;
  }

  /* champagne: liquid leaves each mouth along the bottle's angle, slows with drag and falls under gravity;
   * froth is lighter and drifts; what lands gathers as froth along the bottom, foam oozes from the
   * mouths as the pressure drops, and small bubbles rise and pop at the end. */
  function fizz(el, cv) {
    var ctx = cv.getContext('2d'), G = 900, W = 0, H = 0, parts = [], pile = [], ooze = [], bub = [], raf = 0, start = 0, last = 0, mouths = null;
    var acc = [{ l: 0, f: 0, m: 0, o: 0, b: 0 }, { l: 0, f: 0, m: 0, o: 0, b: 0 }], R = Math.random;
    var LIQ = ['#EF9F27', '#FAC775', '#FAC775', '#BA7517'], FOAM = '#FAEEDA', EDGE = 'rgba(186,117,23,.6)';
    function size() { var d = window.devicePixelRatio || 1; W = el.clientWidth; H = el.clientHeight; cv.width = Math.round(W * d); cv.height = Math.round(H * d); ctx.setTransform(d, 0, 0, d, 0, 0); }
    function findMouths() {
      var box = el.getBoundingClientRect();
      return Array.prototype.map.call(el.querySelectorAll('.pdm-mouth'), function (m, i) {
        var b = m.getBoundingClientRect(); return { x: b.left - box.left, y: b.top - box.top, a: (i ? -25 : 25) * Math.PI / 180 };
      });
    }
    function shoot(m, k, v, spread) {
      var a = m.a + (R() + R() + R() - 1.5) * spread, s = v * (0.72 + R() * 0.4);
      parts.push({ k: k, x: m.x, y: m.y, vx: Math.sin(a) * s, vy: -Math.cos(a) * s, r: k === 'l' ? 2.2 + R() * 2.8 : k === 'f' ? 2.5 + R() * 4.5 : 0.9 + R() * 0.8, c: LIQ[(R() * 4) | 0] });
    }
    function step(ts, dt) {
      mouths.forEach(function (m, i) {
        var A = acc[i];
        if (ts >= 0 && ts < 2.1) {
          var p = Math.max(0, 1 - ts / 1.9), surge = 0.68 + 0.32 * Math.max(0, Math.cos(ts * 7)), v = 170 + 520 * p * surge;
          A.l += (260 * p + 30) * dt; A.f += (55 + 95 * (1 - p)) * dt; A.m += 80 * p * dt;
          while (A.l >= 1) { A.l--; shoot(m, 'l', v, 0.15); } while (A.f >= 1) { A.f--; shoot(m, 'f', v * 0.8, 0.28); } while (A.m >= 1) { A.m--; shoot(m, 'm', v * 1.05, 0.5); }
        }
        if (ts > 1.1 && ts < 3.6) { A.o += 16 * dt; while (A.o >= 1) { A.o--; var sp = 10 + R() * 18, side = (R() - 0.5) * 9;
          ooze.push({ x: m.x + Math.cos(m.a) * side, y: m.y + Math.sin(m.a) * side, vx: -Math.sin(m.a) * sp, vy: Math.cos(m.a) * sp, R: 2.6 + R() * 4, t: 0, life: 1.4 + R() * 1.8 }); } }
        if (ts > 1.5 && ts < 5) { A.b += 9 * dt; while (A.b >= 1) { A.b--; bub.push({ x: m.x + (R() - 0.5) * 16, y: m.y - 4, vy: -(24 + R() * 34), ph: R() * 6.3, R: 1.4 + R() * 2.4, t: 0, life: 1.1 + R() * 1.3 }); } }
      });
      for (var i = parts.length - 1; i >= 0; i--) {
        var q = parts[i], drag = q.k === 'l' ? 0.55 : q.k === 'f' ? 2.3 : 3.2, g = q.k === 'l' ? 1 : q.k === 'f' ? 0.55 : 0.5, e = Math.exp(-drag * dt);
        q.vx *= e; q.vy = q.vy * e + G * g * dt; q.x += q.vx * dt; q.y += q.vy * dt;
        if (q.y >= H - 3) {
          if (q.k !== 'm' && pile.length < 220) pile.push({ x: q.x, R: q.k === 'f' ? 3 + R() * 5 : 2 + R() * 3.5, t: 0, life: 1.6 + R() * 2.6 });
          if (q.k === 'l' && R() < 0.3) for (var s = 0; s < 2; s++) parts.push({ k: 'm', x: q.x, y: H - 5, vx: (R() - 0.5) * 190, vy: -(90 + R() * 150), r: 1 + R() * 0.7, c: q.c });
          parts.splice(i, 1);
        } else if (q.x < -40 || q.x > W + 40) parts.splice(i, 1);
      }
      [pile, ooze, bub].forEach(function (arr) { for (var j = arr.length - 1; j >= 0; j--) { var o = arr[j]; o.t += dt; if (o.vx !== undefined) o.x += o.vx * dt; if (o.vy !== undefined) o.y += o.vy * dt; if (o.t >= o.life) arr.splice(j, 1); } });
    }
    function grow(o) { var a = Math.min(1, o.t / 0.18), z = o.life - o.t; return o.R * a * (z < 0.14 ? z / 0.14 : 1); }
    function bubble(x, y, rad, fill) { if (rad < 0.4) return; ctx.beginPath(); ctx.arc(x, y, rad, 0, 6.283); if (fill) { ctx.fillStyle = FOAM; ctx.fill(); } ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.stroke(); }
    function draw() {
      ctx.clearRect(0, 0, W, H); ctx.lineCap = 'round';
      parts.forEach(function (q) {
        if (q.k === 'f') { bubble(q.x, q.y, q.r, true); return; }
        ctx.strokeStyle = q.c; ctx.lineWidth = q.r * 2; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - q.vx * 0.02, q.y - q.vy * 0.02); ctx.stroke();
      });
      pile.forEach(function (o) { var rad = grow(o); bubble(o.x, H - rad * 0.8, rad, true); });
      ooze.forEach(function (o) { bubble(o.x, o.y, grow(o), true); });
      bub.forEach(function (o) { bubble(o.x + Math.sin(o.ph + o.t * 5) * 4, o.y, grow(o), false); });
    }
    function frame(now) {
      var t = (now - start) / 1000, dt = Math.min(0.033, (now - last) / 1000); last = now;
      var ts = t - T0;
      if (ts > -0.1) { if (!mouths) mouths = findMouths(); step(ts, dt); draw(); }
      if (ts < 9 || parts.length || pile.length || ooze.length || bub.length) raf = requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H);
    }
    size(); start = last = performance.now(); raf = requestAnimationFrame(frame);
    return function stop() { cancelAnimationFrame(raf); };
  }

  function play(o) {
    return new Promise(function (resolve) {
      addCss();
      var el = build(o), cv = el.querySelector('canvas'), stop = function () {}, timers = [], done = false;
      document.body.appendChild(el);
      try { el.showModal(); } catch (e) { el.setAttribute('open', ''); }
      var sfx = o.sfx || {};
      function at(s, fn) { timers.push(setTimeout(function () { try { fn(); } catch (e) {} }, s * 1000)); }
      function close() {
        if (done) return; done = true;
        stop(); timers.forEach(clearTimeout); try { el.close(); } catch (e) {} el.remove(); document.removeEventListener('keydown', onKey); resolve();
      }
      function onKey(e) { if (e.key === 'Escape') close(); }
      el.querySelector('.pdm-skip').onclick = close;
      el.querySelector('.pdm-done').onclick = close;
      document.addEventListener('keydown', onKey);
      el.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
      window.mmPodium.close = close;   // the Android back button closes it too
      if (reduced()) { el.querySelector('.pdm-done').focus(); return; }
      void el.offsetWidth; el.classList.add('go');
      if (sfx.roll) at(1.3, sfx.roll);
      if (sfx.pop) { at(T0, function () { sfx.pop(-0.7); }); at(T0 + 0.06, function () { sfx.pop(0.7); }); }
      if (sfx.fizz) at(T0 + 0.1, sfx.fizz);
      if (sfx.fanfare) at(6.2, sfx.fanfare);
      if (navigator.vibrate) at(T0, function () { navigator.vibrate([60, 40, 90]); });
      stop = fizz(el, cv);
      at(6.9, function () { el.querySelector('.pdm-done').focus({ preventScroll: true }); });
    });
  }

  window.mmPodium = {
    show: function (o) { queue = queue.then(function () { return play(o); }); return queue; },
    isOpen: function () { return !!document.querySelector('.pdm'); },
    close: function () {}
  };
})();
