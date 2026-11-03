/*
 * track.js — 이용 통계 기록(기획 v2.28 · 5.11, 인터뷰 Q148~Q173)
 *
 * 익명 번호(브라우저마다 무작위)로 화면 보기 · 보는 시간 · 기능 사용 · 산정 결과(모델·등급만) · 단계 흐름 · 오류를 모아
 * POST /api/ev 로 보낸다. 이름 · IP · 위치 · 입력한 연식·주행·상태·가격 · 붙여 넣은 묶음 내용은 보내지 않는다.
 *   방문 = 30분 동안 아무 행동이 없으면 끝(Q153) · 보는 시간 = 화면이 앞에 떠 있고 3분 안에 손을 댄 동안만(Q152)
 *   안 세는 것: 내 컴퓨터(localhost — ?trackdev=1 이면 셈) · '이 브라우저 제외'(?notrack=1 로 켜고 ?notrack=0 으로 끔, Q169) · 관리자 화면
 * 화면 코드(app.js 등)는 window.CT 로 알린다: screen · result · pick · depth · miss · ev · err. 단추 누름은 여기서 한꺼번에 센다.
 * 기록이 실패해도 사이트는 그대로 동작한다(모든 일을 try 로 감쌈).
 */
(function () {
  'use strict';
  var IDLE_SESSION = 30 * 60 * 1000, IDLE_VIEW = 3 * 60 * 1000, TICK = 5000, FLUSH = 60000, RESULT_WAIT = 2500, MISS_WAIT = 3000;
  var EXPORTS = { xlsx: 1, sheet: 1, share: 1, xlsxModel: 1 };   // 내보내기는 단계 흐름 끝으로만 센다(Q157)

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function put(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* 저장 못 해도 사이트는 그대로 */ } }
  function rand() { var s = ''; for (var i = 0; i < 16; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 36)); return s; }
  function cut(v, n) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n); }

  location.search.replace(/[?&](notrack|trackdev)=([01])/g, function (m, k, v) {   // 주소로 켜고 끄기(관리자 화면이 생기기 전에도)
    put(k === 'notrack' ? 'cr_notrack' : 'cr_trackdev', v === '1' ? '1' : null);
    return m;
  });
  var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var noop = function () {};
  var CT = { on: false, screen: noop, result: noop, pick: noop, depth: noop, miss: noop, ev: noop, err: noop };
  window.CT = CT;
  if ((local && get('cr_trackdev') !== '1') || get('cr_notrack') === '1' || !window.JSON || !window.fetch) return;
  CT.on = true;

  var uid = get('cr_uid');
  if (!uid || !/^[a-z0-9]{16}$/.test(uid)) { uid = rand(); put('cr_uid', uid); }
  var dev = Math.min(window.innerWidth || 1200, screen.width || 1200) < 768 ? 'm' : 'pc';
  var Q = [], sid = null, scr = '', lastInput = Date.now(), lastTick = Date.now(), lastSess = 0, vis = {}, picked = {};
  var res = { n: 0, key: '', pend: null, timer: 0, depth: 0, sent: 0 }, miss = { cur: '', sent: '', timer: 0 };

  function push(type, s, name, val) {
    if (scr === 'admin' && type !== 'err') return;
    Q.push([Date.now(), type, cut(s || hashScr(), 20), cut(name, 60), val == null ? '' : cut(val, 200)]);
    if (Q.length >= 150) flush(false);
  }
  function hashScr() {                                       // 주소로 본 지금 화면(앱이 알리기 전, 처음 들어온 화면)
    var h = location.hash, m = /^#\/(pulse|market|data|admin)/.exec(h), v = /[?&]view=(model|batch|rates)/.exec(h);
    return m ? m[1] : 'price.' + (v ? v[1] : 'one');
  }
  function session() {                                       // 30분 쉬었으면 새 방문 — 처음 화면과 함께 'start'(여러 탭은 같은 방문)
    var now = Date.now(), last = +get('cr_last') || 0, cur = get('cr_sid');
    if (!cur || now - last > IDLE_SESSION) {
      if (sid) { endResult(); tick(); }
      cur = rand();
      put('cr_sid', cur);
      sid = cur;
      picked = {};
      push('start', scr, location.hash.indexOf('model=') >= 0 ? 'car' : '', document.referrer && document.referrer.indexOf(location.host) < 0 ? 'ref' : '');
    } else sid = cur;
    lastSess = now;
    put('cr_last', String(now));
  }
  function tick() {                                           // 보는 시간: 앞에 떠 있고, 3분 안에 손을 댄 동안만 지금 화면에 더한다
    var now = Date.now(), d = Math.min(now - lastTick, TICK * 2);
    lastTick = now;
    if (document.visibilityState === 'visible' && now - lastInput < IDLE_VIEW && scr && scr !== 'admin') vis[scr] = (vis[scr] || 0) + d;
  }
  function touch() {
    var now = Date.now();
    if (now - lastSess > 10000) { lastInput = now; session(); }   // 방문 시각은 10초에 한 번만 적는다
    lastInput = now;
  }
  function flush(beacon) {
    try {
      tick();
      Object.keys(vis).forEach(function (s) { if (vis[s] >= 1000) Q.push([Date.now(), 'vis', s, '', String(Math.round(vis[s] / 1000))]); });   // 초 단위
      vis = {};
      if (res.depth > res.sent) { Q.push([Date.now(), 'depth', 'price.one', String(res.n), String(res.depth)]); res.sent = res.depth; }
      if (!Q.length || !sid) return;
      var body = JSON.stringify({ u: uid, s: sid, d: dev, e: Q.splice(0, 200) });
      if (beacon && navigator.sendBeacon && navigator.sendBeacon('/api/ev', new Blob([body], { type: 'application/json' }))) return;
      fetch('/api/ev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: body.length < 60000 }).catch(noop);
    } catch (e) { /* 기록 실패는 무시 */ }
  }
  function endResult() {                                      // 기다리던 결과를 바로 기록(화면을 떠날 때)
    if (res.pend) { clearTimeout(res.timer); var p = res.pend; res.pend = null; p(); }
  }

  CT.screen = function (s) {
    s = cut(s, 20);
    if (s === scr) return;
    tick();
    endResult();
    scr = s;
    if (!sid) session();
    if (s !== 'admin') push('view', s, '', '');
  };
  CT.result = function (key, model, grade, kind) {           // 조건을 바꾸는 동안 생긴 중간 결과는 빼고, 2.5초 머문 결과만 1건
    if (!sid) session();
    if (key === res.key && !res.pend) return;
    clearTimeout(res.timer);
    res.key = key;
    res.pend = function () {
      if (res.depth > res.sent) push('depth', 'price.one', String(res.n), String(res.depth));
      res.n++; res.depth = 0; res.sent = 0;
      push('result', kind === 'model' ? 'price.model' : 'price.one', model, grade || '');
    };
    res.timer = setTimeout(function () { var p = res.pend; res.pend = null; if (p) p(); }, RESULT_WAIT);
  };
  CT.pick = function (model) { if (!model || picked[model]) return; if (!sid) session(); picked[model] = 1; push('pick', scr, model, ''); };
  CT.depth = function (n) { if (n >= 2 && n > res.depth && res.n) res.depth = n; };   // 결과 안 가장 깊이 내려간 섹션(02~06, 01은 결과가 나오면 본 것)
  CT.miss = function (list) {                                 // 비어 있는 칸 — 3초 그대로면 기록(결과 없이 방문이 끝나면 '입력하다 포기')
    list = cut(list, 120);
    if (list === miss.cur) return;
    miss.cur = list;
    clearTimeout(miss.timer);
    miss.timer = setTimeout(function () { if (miss.cur !== miss.sent) { miss.sent = miss.cur; push('miss', scr, miss.cur, ''); } }, MISS_WAIT);
  };
  CT.ev = function (type, name, val) { if (!sid) session(); push(type, scr, name, val); };
  CT.err = function (kind, msg) { push('err', scr, kind, cut(msg, 200)); };

  function label(b) {                                         // 누른 것의 이름 — data-* 이름을 먼저, 없으면 짧은 글자(숫자는 뺌)
    var a = function (k) { return b.getAttribute(k); };
    if (a('data-act')) return a('data-act');
    if (a('data-seg')) return a('data-seg') + '=' + a('data-v');
    if (a('data-chip')) return a('data-chip') + '=' + a('data-v');
    if (a('data-b')) return 'batch:' + a('data-b');
    if (a('data-go')) return 'nav:' + a('data-go');
    if (a('data-fold')) return 'fold:' + a('data-fold');
    if (a('data-info')) return 'info:' + a('data-info');
    if (a('data-ib') != null) return 'info:batch';
    if (a('data-need')) return 'need:' + a('data-need');
    if (a('data-mb')) return 'mbar:' + a('data-mb');
    if (a('data-cell')) return 'ladder:cell';
    if (a('data-grade') != null) return 'ladder:grade';
    if (a('data-sheet-act')) return 'sheet:' + a('data-sheet-act');
    if (a('data-dmt')) return 'damage';
    if (b.tagName === 'A') {
      var h = a('href') || '';
      if (b.hasAttribute('download') || /\/downloads\//.test(h)) return 'download';
      if (/^https?:/.test(h) && h.indexOf(location.host) < 0) return 'outlink';
      if (h.indexOf('#/') === 0) return 'link:' + h.slice(2).split('?')[0];
    }
    var t = cut((b.textContent || '').replace(/[\d,.%]+/g, ' '), 24);
    return t ? 'text:' + t : '';
  }
  document.addEventListener('click', function (e) {
    try {
      var b = e.target.closest && e.target.closest('button, a, summary, [role="button"], [data-cell], [data-grade]');
      if (!b || b.disabled) return;
      touch();
      var l = label(b);
      if (!l) return;
      if (EXPORTS[b.getAttribute('data-act')] || l === 'batch:xlsx' || l === 'sheet:print') push('export', scr, l, '');
      else push('act', scr, l, '');
    } catch (err) { /* 기록 실패는 무시 */ }
  }, true);
  document.addEventListener('change', function (e) {         // 칸 바꿈 — 이름만(값은 남기지 않음)
    try {
      var k = e.target.getAttribute && e.target.getAttribute('data-k');
      if (k) push('act', scr, 'input:' + k, '');
    } catch (err) { /* 기록 실패는 무시 */ }
  }, true);
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(function (t) { window.addEventListener(t, touch, { passive: true, capture: true }); });
  var mm = 0;
  window.addEventListener('mousemove', function () { var n = Date.now(); if (n - mm > 5000) { mm = n; touch(); } }, { passive: true });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') { endResult(); flush(true); } else { lastTick = Date.now(); touch(); } });
  window.addEventListener('pagehide', function () { endResult(); flush(true); });
  window.addEventListener('error', function (e) { CT.err('js', (e.message || 'error') + (e.filename ? ' @' + String(e.filename).split('/').pop() + ':' + e.lineno : '')); });
  window.addEventListener('unhandledrejection', function (e) { CT.err('promise', e.reason && (e.reason.message || e.reason)); });
  window.addEventListener('load', function () {
    try { var n = performance.getEntriesByType && performance.getEntriesByType('navigation')[0]; if (n) push('perf', scr, 'load', String(Math.round(n.loadEventStart || n.duration))); } catch (e) { /* 없음 */ }
  });
  setInterval(tick, TICK);
  setInterval(function () { if (document.visibilityState === 'visible') flush(false); }, FLUSH);
  session();
})();
