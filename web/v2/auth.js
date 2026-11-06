/*
 * auth.js — 로그인 · 가입 신청 · 내 정보 · 잠금 안내 · 머리 메뉴 (로그인 기획 PLAN_로그인_회원관리_기획안.md 3장)
 *
 *   V2Auth.init() → Promise(상태)   /api/auth/me 를 읽어 둔다(실패하면 로그인 안 한 것으로 — 정적 미리보기 등)
 *   V2Auth.member() · admin() · canEdit() · ready() · locked(page) · anon()   지금 상태
 *   V2Auth.show(page, el, q)   #/login · #/signup · #/account 화면
 *   V2Auth.lockHtml(page) 잠긴 화면 안내 · header(el) 머리 메뉴 · notice(msg) 위 안내 띠 · onChange(fn) 로그인 상태가 바뀔 때
 * 비밀번호는 이 화면에서 PBKDF2-SHA256(60만 번)으로 다져 보낸다 — 원문은 서버로 가지 않는다(기획 5.2, worker/auth.js).
 */
(function (root) {
  'use strict';
  var ITER = 600000;
  var ST = blank(), subs = [], bound = false, cur = { page: null, q: null };
  var NAMES = { model: '모델 요약', batch: '묶음 산정', rates: '⚙ 환산 비율 · 감가 표', pulse: '마켓 펄스', market: '시장 시황', data: '데이터' };
  var MEMBER_ONLY = { model: 1, batch: 1, rates: 1, pulse: 1, market: 1 };   // 잠금을 켜면(AUTH_ENFORCE=1) 회원만 — 데이터(내려받기)는 늘 회원만
  var COMMON = ['password1', 'password12', 'password123', 'passw0rd1', 'p@ssw0rd', 'qwerty123', 'qwerty12', 'qwer1234', 'asdf1234', 'zxcv1234', 'abcd1234', 'abc12345',
    'a1234567', 'a12345678', '1q2w3e4r', '1q2w3e4r5t', 'q1w2e3r4', '1qaz2wsx', 'test1234', 'admin123', 'admin1234', 'welcome1', 'iloveyou1', 'letmein1', '12345678a',
    '1234qwer', 'pass1234'];
  var CONSENT = ['수집 항목: 메일 주소, 이름, 비밀번호(복원할 수 없는 형태로 저장)', '자동 기록: 최근 접속일, 설정을 고친 기록(누가 · 언제 · 무엇을)',
    '목적: 회원 확인과 가입 승인, 계정 관리, 팀 설정 변경 이력 관리',
    '보관 기간: 탈퇴하면 즉시 삭제합니다(설정 변경 기록의 작성자는 \'탈퇴한 회원\'으로 남습니다). 90일 동안 접속하지 않으면 계정을 정지하고, 정지 후 1년이 지나면 삭제합니다.',
    '동의를 거부할 수 있습니다. 거부하면 회원 전용 기능은 쓸 수 없고, 한 대 산정은 로그인 없이 쓸 수 있습니다.'];

  function blank() { return { ready: false, enforce: false, user: null, pending: 0, resets: 0 }; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function enc(s) { return new TextEncoder().encode(s); }
  function b64u(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function newSalt() { return b64u(crypto.getRandomValues(new Uint8Array(16))); }
  function kdf(pw, salt, iter) {                              // 비밀번호 → PBKDF2-SHA256(소금 · 되풀이 횟수) 32바이트
    return crypto.subtle.importKey('raw', enc(String(pw).normalize('NFC')), 'PBKDF2', false, ['deriveBits'])
      .then(function (key) { return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc(salt), iterations: iter }, key, 256); })
      .then(b64u);
  }
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function put(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* 저장 못 해도 그대로 */ } }
  function anon() {                                          // 이 브라우저의 무작위 번호 — 로그인하지 않은 비교 매물 한도를 브라우저마다 센다(worker anonQuota)
    var a = get('cr_anon');
    if (a && /^[a-z0-9]{12}$/.test(a)) return a;
    var r = crypto.getRandomValues(new Uint8Array(12)), s = '';
    for (var i = 0; i < 12; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(r[i] % 36);
    put('cr_anon', s);
    return s;
  }
  function api(method, path, body) {
    return fetch(path, { method: method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) {
        var ct = r.headers.get('content-type') || '';
        return (ct.indexOf('application/json') >= 0 ? r.json() : Promise.resolve(null)).then(function (j) { return { status: r.status, j: j || {} }; });
      });
  }
  function fire() { subs.forEach(function (fn) { try { fn(ST); } catch (e) { if (root.console) console.error(e); } }); }
  function load() {
    return api('GET', '/api/auth/me').then(function (x) {
      ST = x.status === 200 && x.j.ok ? { ready: !!x.j.ready, enforce: !!x.j.enforce, user: x.j.user || null, pending: x.j.pending || 0, resets: x.j.resets || 0 } : blank();
    }).catch(function () { ST = blank(); }).then(function () { fire(); return ST; });
  }
  function locked(page) {
    if (page === 'data') return !ST.user;
    return !!MEMBER_ONLY[page] && ST.enforce && !ST.user;
  }
  function policy(pw, email) {                                // 비밀번호 규칙(Q280) — 서버는 원문을 모르므로 여기서 본다
    pw = String(pw || '');
    if (pw.length < 8) return '8자 이상으로 해 주세요';
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return '영문과 숫자를 섞어 주세요';
    if (COMMON.indexOf(pw.toLowerCase()) >= 0) return '너무 흔한 비밀번호입니다 — 다른 것으로 해 주세요';
    var id = String(email || '').split('@')[0].toLowerCase();
    if (id.length >= 4 && pw.toLowerCase().indexOf(id) >= 0) return '메일 아이디가 들어간 비밀번호는 쓸 수 없습니다';
    return '';
  }
  function tempPassword() {                                   // 관리자가 발급하는 임시 비밀번호 10자(헷갈리는 글자 l·o·0·1 없이, 영문 · 숫자 섞음)
    var A = 'abcdefghjkmnpqrstuvwxyz', D = '23456789', all = A + D, r = crypto.getRandomValues(new Uint8Array(10)), s = '';
    for (var i = 0; i < 10; i++) s += all.charAt(r[i] % all.length);
    if (!/[a-z]/.test(s)) s = A.charAt(r[0] % A.length) + s.slice(1);
    if (!/[0-9]/.test(s)) s = s.slice(0, 9) + D.charAt(r[9] % D.length);
    return s;
  }
  var EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
  function josa(w) {                                          // '모델 요약은' · '마켓 펄스는'
    var c = String(w).charCodeAt(String(w).length - 1);
    return c >= 0xAC00 && c <= 0xD7A3 ? ((c - 0xAC00) % 28 ? '은' : '는') : '은(는)';
  }
  function nextOf(q) {                                        // 로그인 뒤 돌아갈 곳(Q289) — 이 사이트의 화면 주소만
    var n = q && q.get && q.get('next');
    return n && /^#\/(price|pulse|market|data|admin|account)\b/.test(n) ? n : '#/price';
  }
  function go(hash) { if (location.hash === hash) fire(); else location.hash = hash; }

  // ───── 화면 ─────
  function field(label, input, hint) { return '<label class="v2-f"><span class="v2-l">' + label + (hint ? '<em>' + hint + '</em>' : '') + '</span>' + input + '</label>'; }
  function msg() { return '<div class="auth-msg" role="status" aria-live="polite"></div>'; }
  function wrap(inner, wide) { return '<div class="auth-wrap' + (wide ? ' wide' : '') + '">' + inner + '</div>'; }
  function notReady(title) {
    return wrap('<div class="card auth-card"><h1 class="auth-h">' + title + '</h1><div class="notebox">회원 기능을 준비하고 있습니다 — 관리자 설정이 끝나면 쓸 수 있습니다. 한 대 산정은 지금처럼 쓸 수 있습니다.</div>' +
      '<div class="auth-links"><a href="#/price">한 대 산정으로</a></div></div>');
  }
  function nextQ(q) { var n = q && q.get && q.get('next'); return n ? '?next=' + encodeURIComponent(n) : ''; }
  function loginHtml(q) {
    if (!ST.ready) return notReady('로그인');
    return wrap('<div class="card auth-card"><h1 class="auth-h">로그인</h1>' +
      '<p class="auth-sub">모델 요약 · 묶음 산정 · 마켓 펄스 · 시장 시황 · 데이터는 회원 전용입니다. 한 대 산정은 로그인 없이 쓸 수 있습니다.</p>' +
      '<form class="auth-form" data-authform="login" novalidate>' +
      field('메일', '<input class="v2-in" name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off" spellcheck="false">') +
      field('비밀번호', '<input class="v2-in" name="pw" type="password" autocomplete="current-password">') +
      '<label class="auth-check"><input type="checkbox" name="remember"> 이 기기 기억(30일) <em>공용 PC에서는 끄세요</em></label>' +
      '<button type="submit" class="v2-btn primary auth-go">로그인</button>' + msg() + '</form>' +
      '<div class="auth-links"><a href="#/signup' + nextQ(q) + '">가입 신청</a><span aria-hidden="true">·</span>' +
      '<button type="button" class="v2-link" data-auth="forgot">비밀번호를 잊었어요</button></div>' +
      '<form class="auth-form auth-forgot" data-authform="forgot" hidden novalidate><p class="v2-help">메일을 넣으면 관리자에게 요청이 남습니다. 관리자가 임시 비밀번호를 메신저로 보내 줍니다.</p>' +
      field('메일', '<input class="v2-in" name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off" spellcheck="false">') +
      '<button type="submit" class="v2-btn">요청 남기기</button>' + msg() + '</form></div>');
  }
  function signupHtml(q) {
    if (!ST.ready) return notReady('가입 신청');
    return wrap('<div class="card auth-card"><h1 class="auth-h">가입 신청</h1>' +
      '<p class="auth-sub">관리자가 확인하고 승인하면 로그인할 수 있습니다. 회사 메일이 아니어도 신청할 수 있습니다.</p>' +
      '<form class="auth-form" data-authform="signup" novalidate>' +
      field('메일', '<input class="v2-in" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false">', '로그인 아이디') +
      field('이름', '<input class="v2-in" name="name" autocomplete="name" maxlength="30">', '관리자가 누구인지 알아볼 수 있게') +
      field('비밀번호', '<input class="v2-in" name="pw" type="password" autocomplete="new-password">', '8자 이상 · 영문과 숫자') +
      field('비밀번호 확인', '<input class="v2-in" name="pw2" type="password" autocomplete="new-password">') +
      '<div class="auth-rule" aria-live="polite">8자 이상, 영문과 숫자를 섞어 주세요</div>' +
      '<details class="auth-consent"><summary>개인정보 수집 · 이용 동의 (필수) — 내용 보기</summary><ul>' + CONSENT.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></details>' +
      '<label class="auth-check"><input type="checkbox" name="consent"> 위 개인정보 수집 · 이용에 동의합니다</label>' +
      '<button type="submit" class="v2-btn primary auth-go">가입 신청</button>' + msg() + '</form>' +
      '<div class="auth-links"><span>이미 회원이면</span><a href="#/login' + nextQ(q) + '">로그인</a></div></div>');
  }
  function accountHtml(q) {
    var u = ST.user, must = !!u.mustChange;
    var pwCard = '<div class="card auth-card"><div class="card-title">' + (must ? '새 비밀번호 정하기' : '비밀번호 바꾸기') + '</div>' +
      (must ? '<div class="notebox">임시 비밀번호로 들어왔습니다 — 새 비밀번호를 정해야 계속 쓸 수 있습니다.</div>' : '') +
      '<form class="auth-form" data-authform="password" novalidate>' +
      field(must ? '임시 비밀번호' : '지금 비밀번호', '<input class="v2-in" name="cur" type="password" autocomplete="current-password">') +
      field('새 비밀번호', '<input class="v2-in" name="pw" type="password" autocomplete="new-password">', '8자 이상 · 영문과 숫자') +
      field('새 비밀번호 확인', '<input class="v2-in" name="pw2" type="password" autocomplete="new-password">') +
      '<div class="auth-rule" aria-live="polite">8자 이상, 영문과 숫자를 섞어 주세요</div>' +
      '<button type="submit" class="v2-btn primary auth-go">' + (must ? '새 비밀번호로 시작' : '바꾸기') + '</button>' + msg() + '</form>' +
      (must ? '' : '<p class="v2-help">바꾸면 다른 기기의 로그인은 끊깁니다.</p>') + '</div>';
    if (must) return wrap(pwCard, true);
    return wrap('<div class="card auth-card"><h1 class="auth-h">내 정보</h1><dl class="auth-dl">' +
      '<dt>메일</dt><dd>' + esc(u.email) + '</dd><dt>등급</dt><dd>' + (u.role === 'admin' ? '관리자' : '회원') + '</dd>' +
      '<dt>설정 수정</dt><dd>' + (u.canEdit ? '할 수 있음' : '없음 <small>— ⚙ 환산 비율 · 감가 표를 고치려면 관리자에게 요청</small>') + '</dd></dl>' +
      '<form class="auth-form auth-row" data-authform="name" novalidate>' + field('이름', '<input class="v2-in" name="name" autocomplete="name" maxlength="30" value="' + esc(u.name) + '">') +
      '<button type="submit" class="v2-btn">이름 저장</button>' + msg() + '</form>' +
      '<div class="auth-links"><button type="button" class="v2-btn" data-auth="logout">로그아웃</button>' + (u.role === 'admin' ? '<a href="#/admin">관리자 화면</a>' : '') + '</div></div>' +
      pwCard +
      '<details class="card auth-card auth-danger"><summary>탈퇴</summary>' +
      '<form class="auth-form" data-authform="withdraw" novalidate><p class="v2-help">탈퇴하면 이름 · 메일이 바로 지워지고 다시 되돌릴 수 없습니다. 한 대 산정은 로그인 없이 계속 쓸 수 있습니다.</p>' +
      field('비밀번호', '<input class="v2-in" name="cur" type="password" autocomplete="current-password">') +
      '<label class="auth-check"><input type="checkbox" name="sure"> 탈퇴하면 되돌릴 수 없다는 것을 확인했습니다</label>' +
      '<button type="submit" class="v2-btn">탈퇴하기</button>' + msg() + '</form></details>', true);
  }
  function show(page, el, q) {
    cur = { page: page, q: q };
    if (page === 'account' && !ST.user) { location.replace('#/login?next=' + encodeURIComponent('#/account')); return; }
    if ((page === 'login' || page === 'signup') && ST.user && !ST.user.mustChange) { location.replace(nextOf(q)); return; }
    el.innerHTML = page === 'signup' ? signupHtml(q) : page === 'account' ? accountHtml(q) : loginHtml(q);
    var f = el.querySelector('form:not([hidden]) input');
    if (f && window.matchMedia && window.matchMedia('(min-width: 768px)').matches) f.focus();   // 휴대폰에서는 자판이 바로 뜨지 않게
  }
  function lockHtml(page) {                                   // 잠긴 화면(Q277) — 로그인 · 가입 신청 · 한 대 산정으로
    var name = NAMES[page] || '이 화면', next = encodeURIComponent(location.hash || '#/price');
    if (!ST.ready) {
      return '<div class="card auth-lock"><div class="auth-lock-ic" aria-hidden="true">🔒</div><div class="card-title">' + esc(name) + josa(name) + ' 회원 전용입니다</div>' +
        '<p class="v2-help">회원 기능을 준비하고 있습니다 — 관리자 설정이 끝나면 로그인해서 쓸 수 있습니다.</p><div class="auth-lock-btns"><a class="v2-btn" href="#/price">한 대 산정으로</a></div></div>';
    }
    return '<div class="card auth-lock"><div class="auth-lock-ic" aria-hidden="true">🔒</div><div class="card-title">' + esc(name) + josa(name) + ' 회원 전용입니다</div>' +
      '<p class="v2-help">로그인하면 볼 수 있습니다. 모델 요약 · 묶음 산정 · 마켓 펄스 · 시장 시황 · 데이터는 회원 전용이고, 한 대 산정은 누구나 쓸 수 있습니다.</p>' +
      '<div class="auth-lock-btns"><a class="v2-btn primary" href="#/login?next=' + next + '">로그인</a><a class="v2-btn" href="#/signup?next=' + next + '">가입 신청</a>' +
      '<a class="v2-btn" href="#/price">한 대 산정으로</a></div></div>';
  }
  function mustHtml() {                                       // 임시 비밀번호로 들어온 회원 — 새 비밀번호부터(로그인 기획 3.2)
    return '<div class="card auth-lock"><div class="auth-lock-ic" aria-hidden="true">🔑</div><div class="card-title">새 비밀번호를 먼저 정해 주세요</div>' +
      '<p class="v2-help">임시 비밀번호로 들어왔습니다 — 새 비밀번호를 정하면 회원 전용 화면을 쓸 수 있습니다.</p>' +
      '<div class="auth-lock-btns"><a class="v2-btn primary" href="#/account?next=' + encodeURIComponent(location.hash || '#/price') + '">새 비밀번호 정하기</a></div></div>';
  }
  function header(el) {                                       // 머리 오른쪽: 로그인 단추 또는 이름 메뉴(관리자는 승인 대기 수)
    if (!el) return;
    if (!ST.user) {
      var h = location.hash || '#/price', mm = /^#\/(login|signup)(\?.*)?$/.exec(h);   // 로그인 · 가입 화면에서는 원래 가려던 곳(next)을 그대로
      el.innerHTML = ST.ready ? '<a class="auth-login" href="' + (mm ? '#/login' + (mm[2] || '') : '#/login?next=' + encodeURIComponent(h)) + '">로그인</a>' : '';
      return;
    }
    var u = ST.user, n = u.role === 'admin' ? ST.pending + ST.resets : 0;
    el.innerHTML = '<details class="auth-menu"><summary aria-label="내 메뉴"><span class="auth-who">' + esc(u.name) + '</span>' +
      (n ? '<span class="auth-badge" title="승인 대기 ' + ST.pending + ' · 비밀번호 재설정 요청 ' + ST.resets + '">' + n + '</span>' : '') + '<span aria-hidden="true">▾</span></summary>' +
      '<div class="auth-pop"><div class="auth-pop-h">' + esc(u.email) + '<small>' + (u.role === 'admin' ? '관리자' : '회원') + (u.canEdit && u.role !== 'admin' ? ' · 설정 수정' : '') + '</small></div>' +
      (u.role === 'admin' ? '<a href="#/admin">관리자 · 회원 관리' + (n ? ' (' + n + ')' : '') + '</a>' : '') +
      '<a href="#/account">내 정보 · 비밀번호</a><button type="button" data-auth="logout">로그아웃</button></div></details>';
  }
  function notice(text) {                                     // 위 안내 띠(로그인하지 않은 한도 등) — 로그인 · 가입 신청 · 닫기
    var n = document.getElementById('authNote');
    if (!n) { n = document.createElement('div'); n.id = 'authNote'; n.className = 'auth-note'; n.setAttribute('role', 'alert'); document.body.appendChild(n); }
    var next = encodeURIComponent(location.hash || '#/price');
    n.innerHTML = '<button type="button" class="x" data-auth="noteClose" aria-label="닫기">×</button><div>' + esc(text) + '</div>' +
      (ST.user ? '' : '<div class="auth-lock-btns"><a class="v2-btn primary" href="#/login?next=' + next + '" data-auth="noteClose">로그인</a><a class="v2-btn" href="#/signup?next=' + next + '" data-auth="noteClose">가입 신청</a></div>');
    n.hidden = false;
  }

  // ───── 보내기 ─────
  function say(f, text, bad) { var m = f.querySelector('.auth-msg'); if (m) { m.textContent = text || ''; m.classList.toggle('bad', !!bad); } }
  function busy(f, on, text) {
    var b = f.querySelector('button[type="submit"]');
    if (b) b.disabled = !!on;
    f.setAttribute('aria-busy', on ? 'true' : 'false');
    if (text != null) say(f, text);
  }
  function saltOf(email) {
    return api('GET', '/api/auth/salt?email=' + encodeURIComponent(email)).then(function (x) {
      if (x.status !== 200 || !x.j.ok) throw new Error(x.j.error || '메일 주소를 확인해 주세요');
      return x.j;
    });
  }
  function fail(f) { return function (e) { busy(f, false); say(f, e && e.message || String(e), true); }; }
  function doLogin(f) {
    var email = f.elements.email.value.trim(), pw = f.elements.pw.value, remember = f.elements.remember.checked;
    if (!email || !pw) { say(f, '메일과 비밀번호를 넣어 주세요', true); return; }
    busy(f, true, '확인하는 중… 비밀번호를 안전하게 다지느라 1초쯤 걸립니다');
    saltOf(email).then(function (s) { return kdf(pw, s.salt, s.iter); })
      .then(function (dk) { return api('POST', '/api/auth/login', { email: email, dk: dk, remember: remember }); })
      .then(function (x) {
        if (x.status === 200 && x.j.ok) {
          f.elements.pw.value = '';
          return load().then(function () { go(ST.user && ST.user.mustChange ? '#/account?next=' + encodeURIComponent(nextOf(cur.q)) : nextOf(cur.q)); });
        }
        busy(f, false); say(f, x.j.error || '로그인하지 못했습니다(' + x.status + ')', true);
      }).catch(fail(f));
  }
  function doForgot(f) {
    var email = f.elements.email.value.trim();
    if (!EMAIL_RE.test(email)) { say(f, '메일 주소를 확인해 주세요', true); return; }
    busy(f, true, '보내는 중…');
    api('POST', '/api/auth/forgot', { email: email }).then(function (x) {
      busy(f, false);
      if (x.status === 200) say(f, '요청을 남겼습니다 — 관리자가 임시 비밀번호를 메신저로 보내 줍니다. 받으면 그 비밀번호로 로그인해 새 비밀번호를 정하세요.');
      else say(f, x.j.error || '보내지 못했습니다(' + x.status + ')', true);
    }).catch(fail(f));
  }
  function doSignup(f) {
    var email = f.elements.email.value.trim(), name = f.elements.name.value.trim(), pw = f.elements.pw.value, pw2 = f.elements.pw2.value;
    if (!EMAIL_RE.test(email)) { say(f, '메일 주소를 확인해 주세요', true); return; }
    if (!name) { say(f, '이름을 넣어 주세요', true); return; }
    var bad = policy(pw, email);
    if (bad) { say(f, bad, true); return; }
    if (pw !== pw2) { say(f, '비밀번호 확인이 다릅니다', true); return; }
    if (!f.elements.consent.checked) { say(f, '개인정보 수집 · 이용에 동의해야 신청할 수 있습니다', true); return; }
    busy(f, true, '신청하는 중…');
    var salt = newSalt();
    kdf(pw, salt, ITER).then(function (dk) { return api('POST', '/api/auth/signup', { email: email, name: name, salt: salt, iter: ITER, dk: dk, consent: true }); })
      .then(function (x) {
        if (x.status === 200 && x.j.ok) {
          f.closest('.auth-card').innerHTML = '<h1 class="auth-h">신청을 받았습니다</h1><p class="auth-sub">관리자가 승인하면 <b>' + esc(email) + '</b>로 로그인할 수 있습니다. ' +
            '승인 알림은 따로 가지 않으니, 관리자에게 신청했다고 알려 주시면 빨리 처리됩니다.</p><div class="auth-links"><a href="#/price">한 대 산정으로</a><a href="#/login">로그인</a></div>';
          return;
        }
        busy(f, false); say(f, x.j.error || '신청하지 못했습니다(' + x.status + ')', true);
      }).catch(fail(f));
  }
  function doName(f) {
    var name = f.elements.name.value.trim();
    if (!name) { say(f, '이름을 넣어 주세요', true); return; }
    busy(f, true, '저장하는 중…');
    api('PATCH', '/api/auth/me', { name: name }).then(function (x) {
      busy(f, false);
      if (x.status === 200 && x.j.ok) { say(f, '저장했습니다'); load(); }
      else say(f, x.j.error || '저장하지 못했습니다(' + x.status + ')', true);
    }).catch(fail(f));
  }
  function doPassword(f) {
    var u = ST.user, pw0 = f.elements.cur.value, pw = f.elements.pw.value, pw2 = f.elements.pw2.value, must = u && u.mustChange;
    if (!u) return;
    if (!pw0) { say(f, (must ? '임시' : '지금') + ' 비밀번호를 넣어 주세요', true); return; }
    var bad = policy(pw, u.email);
    if (bad) { say(f, bad, true); return; }
    if (pw !== pw2) { say(f, '새 비밀번호 확인이 다릅니다', true); return; }
    if (pw === pw0) { say(f, '지금과 다른 비밀번호로 해 주세요', true); return; }
    busy(f, true, '바꾸는 중…');
    var salt = newSalt();
    saltOf(u.email).then(function (s) { return Promise.all([kdf(pw0, s.salt, s.iter), kdf(pw, salt, ITER)]); })
      .then(function (d) { return api('POST', '/api/auth/password', { dk: d[0], salt: salt, iter: ITER, newDk: d[1] }); })
      .then(function (x) {
        if (x.status === 200 && x.j.ok) {
          f.reset();
          return load().then(function () {
            if (must) { go(nextOf(cur.q)); return; }
            busy(f, false); say(f, '바꿨습니다 — 다른 기기의 로그인은 끊겼습니다');
          });
        }
        busy(f, false); say(f, x.j.error || '바꾸지 못했습니다(' + x.status + ')', true);
      }).catch(fail(f));
  }
  function doWithdraw(f) {
    var u = ST.user, pw0 = f.elements.cur.value;
    if (!u) return;
    if (!pw0) { say(f, '비밀번호를 넣어 주세요', true); return; }
    if (!f.elements.sure.checked) { say(f, '되돌릴 수 없다는 것을 확인해 주세요', true); return; }
    busy(f, true, '탈퇴하는 중…');
    saltOf(u.email).then(function (s) { return kdf(pw0, s.salt, s.iter); })
      .then(function (dk) { return api('DELETE', '/api/auth/me', { dk: dk }); })
      .then(function (x) {
        if (x.status === 200 && x.j.ok) return load().then(function () { go('#/price'); notice('탈퇴했습니다 — 이름 · 메일을 지웠습니다. 한 대 산정은 계속 쓸 수 있습니다.'); });
        busy(f, false); say(f, x.j.error || '탈퇴하지 못했습니다(' + x.status + ')', true);
      }).catch(fail(f));
  }
  function doLogout() {
    api('POST', '/api/auth/logout').catch(function () {}).then(load).then(function () {
      var h = location.hash;
      if (/^#\/(account|admin)\b/.test(h) || locked((/^#\/(\w+)/.exec(h) || [])[1]) || /[?&]view=(model|batch|rates)\b/.test(h) && ST.enforce) go('#/price');
    });
  }
  function bind() {
    if (bound) return;
    bound = true;
    document.addEventListener('submit', function (e) {
      var f = e.target.closest && e.target.closest('form[data-authform]');
      if (!f) return;
      e.preventDefault();
      var k = f.getAttribute('data-authform');
      ({ login: doLogin, forgot: doForgot, signup: doSignup, name: doName, password: doPassword, withdraw: doWithdraw })[k](f);
    });
    document.addEventListener('click', function (e) {
      document.querySelectorAll('details.auth-menu[open]').forEach(function (d) { if (!d.contains(e.target) || e.target.closest('a, button')) d.removeAttribute('open'); });
      var b = e.target.closest && e.target.closest('[data-auth]');
      if (!b) return;
      var a = b.getAttribute('data-auth');
      if (a === 'logout') doLogout();
      else if (a === 'noteClose') { var n = document.getElementById('authNote'); if (n) n.hidden = true; }
      else if (a === 'forgot') {
        var f = document.querySelector('form[data-authform="forgot"]');
        if (f) { f.hidden = !f.hidden; var lf = document.querySelector('form[data-authform="login"]'); if (!f.hidden && lf && lf.elements.email.value) f.elements.email.value = lf.elements.email.value; }
      }
    });
    document.addEventListener('input', function (e) {             // 비밀번호 규칙을 쓰는 동안 바로 보인다
      var f = e.target.closest && e.target.closest('form[data-authform="signup"], form[data-authform="password"]');
      if (!f || (e.target.name !== 'pw' && e.target.name !== 'pw2')) return;
      var rule = f.querySelector('.auth-rule'), pw = f.elements.pw.value, mail = f.elements.email ? f.elements.email.value : ST.user && ST.user.email;
      if (!rule) return;
      var bad = pw ? policy(pw, mail) : '8자 이상, 영문과 숫자를 섞어 주세요';
      rule.textContent = bad || (f.elements.pw2.value && f.elements.pw2.value !== pw ? '비밀번호 확인이 다릅니다' : '쓸 수 있는 비밀번호입니다');
      rule.classList.toggle('ok', !bad && !(f.elements.pw2.value && f.elements.pw2.value !== pw));
    });
  }

  var A = {
    init: function () { bind(); return load(); },
    reload: load,
    state: function () { return ST; },
    ready: function () { return ST.ready; },
    member: function () { return !!ST.user; },
    admin: function () { return !!(ST.user && ST.user.role === 'admin'); },
    canEdit: function () { return !!(ST.user && ST.user.canEdit); },
    user: function () { return ST.user; },
    mustChange: function () { return !!(ST.user && ST.user.mustChange); },
    locked: locked, lockHtml: lockHtml, mustHtml: mustHtml, header: header, show: show, notice: notice, anon: anon,
    onChange: function (fn) { subs.push(fn); },
    kdf: kdf, newSalt: newSalt, policy: policy, tempPassword: tempPassword, ITER: ITER   // 관리자 화면(임시 비밀번호)과 점검 도구가 쓴다
  };
  root.V2Auth = A;
  if (typeof module === 'object' && module.exports) module.exports = A;
})(typeof window !== 'undefined' ? window : globalThis);
