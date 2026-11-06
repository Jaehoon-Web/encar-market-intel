/*
 * members.js — 관리자 › 회원 관리 (로그인 기획 PLAN_로그인_회원관리_기획안.md 3.5 · 인터뷰 Q267~Q285)
 *
 *   승인 대기(승인 · 거절) · 회원 목록(찾기 · 상태 거르기 · 정지/해제 · 관리자 지정/해제 · 설정 수정 권한 · 잠금 풀기 · 임시 비밀번호 · 삭제) · 관리 기록
 *   var M = V2Members.create({ esc, headers: function () { return { authorization: … } } });   M.show(el)
 * 요청은 관리자 회원의 쿠키, 또는 전환 기간 동안 관리자 비밀번호 출입증(Authorization) — worker/auth.js /api/users/*
 * 임시 비밀번호는 이 화면이 만들고 다진 값만 보낸다(원문은 서버로 가지 않음, 한 번만 보여 줌).
 */
(function (root) {
  'use strict';
  var STN = { pending: '승인 대기', active: '활성', suspended: '정지', rejected: '거절' };
  var ACTN = { approve: '승인', reject: '거절', suspend: '정지', resume: '정지 풀기', role: '등급', edit: '설정 수정 권한', unlock: '잠금 풀기', temp: '임시 비밀번호 발급',
    delete: '삭제', withdraw: '탈퇴', password: '비밀번호 바꿈', settings: '설정 수정' };
  var FILTERS = [['all', '전체'], ['active', '활성'], ['suspended', '정지'], ['rejected', '거절']];

  function create(ctx) {
    var esc = ctx.esc, el = null, data = null, audit = null, msg = '', bad = false, busy = false, filter = 'all', q = '', temp = null, sure = null, openAudit = false;
    function api(method, path, body) {
      return fetch(path, { method: method, headers: Object.assign(body ? { 'content-type': 'application/json' } : {}, ctx.headers ? ctx.headers() : {}),
        body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'same-origin' })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; }); });
    }
    function when(ms) { if (!ms) return '—'; var t = new Date(ms + 9 * 3600e3).toISOString(); return t.slice(0, 10) + ' ' + t.slice(11, 16); }
    function ago(ms) { if (!ms) return '—'; var d = Math.floor((Date.now() - ms) / 86400e3); return d <= 0 ? '오늘' : d + '일 전'; }
    function say(t, isBad) { msg = t || ''; bad = !!isBad; }
    function load() {
      busy = true; render();
      return Promise.all([api('GET', '/api/users'), api('GET', '/api/users/audit')]).then(function (a) {
        busy = false;
        if (a[0].status !== 200) { data = null; say(a[0].j.error || '불러오지 못했습니다(' + a[0].status + ')', true); render(); return; }
        data = a[0].j; audit = a[1].status === 200 ? a[1].j.audit : null;
        render();
        if (root.V2Auth && root.V2Auth.member()) root.V2Auth.reload();   // 머리의 승인 대기 수도 새로
      }).catch(function (e) { busy = false; say('불러오지 못했습니다: ' + (e && e.message || e), true); render(); });
    }
    function act(u, action, body, done) {
      say(''); busy = true; render();
      return api('POST', '/api/users/' + u.id + '/' + action, body || null).then(function (x) {
        busy = false;
        if (x.status === 200 && x.j.ok) { say(done || (ACTN[action] + ' — ' + (u.name || u.email))); return load(); }
        say(x.j.error || '하지 못했습니다(' + x.status + ')', true); render();
      }).catch(function (e) { busy = false; say(e && e.message || String(e), true); render(); });
    }
    function remove(u) {
      sure = null; say(''); busy = true; render();
      api('DELETE', '/api/users/' + u.id).then(function (x) {
        busy = false;
        if (x.status === 200 && x.j.ok) { say('삭제했습니다 — ' + (u.name || u.email) + '(이름 · 메일을 지움)'); return load(); }
        say(x.j.error || '삭제하지 못했습니다(' + x.status + ')', true); render();
      }).catch(function (e) { busy = false; say(e && e.message || String(e), true); render(); });
    }
    function issueTemp(u) {                                   // 임시 비밀번호(Q270): 여기서 만들어 다진 값만 보낸다
      var A = root.V2Auth;
      if (!A) return;
      var pw = A.tempPassword(), salt = A.newSalt();
      temp = null; say('임시 비밀번호를 만드는 중… (1초쯤)'); busy = true; render();
      A.kdf(pw, salt, A.ITER).then(function (dk) { return api('POST', '/api/users/' + u.id + '/temp', { salt: salt, iter: A.ITER, dk: dk }); }).then(function (x) {
        busy = false;
        if (x.status === 200 && x.j.ok) { temp = { name: u.name, email: u.email, pw: pw }; say(''); return load(); }
        say(x.j.error || '발급하지 못했습니다(' + x.status + ')', true); render();
      }).catch(function (e) { busy = false; say(e && e.message || String(e), true); render(); });
    }
    function byId(id) { return data && data.users.filter(function (u) { return u.id === id; })[0]; }
    function btn(a, id, label, cls) { return '<button type="button" class="v2-btn mem-b' + (cls ? ' ' + cls : '') + '" data-mem="' + a + '" data-id="' + id + '"' + (busy ? ' disabled' : '') + '>' + label + '</button>'; }
    function flags(u, now) {
      var f = [];
      if (u.lockUntil > now) f.push('<span class="mem-f warn">잠김 ' + when(u.lockUntil).slice(11) + '까지</span>');
      if (u.resetAt) f.push('<span class="mem-f warn">비밀번호 재설정 요청 ' + ago(u.resetAt) + '</span>');
      if (u.mustChange) f.push('<span class="mem-f">임시 비밀번호 — 바꾸기 전</span>');
      if (u.dupAt) f.push('<span class="mem-f">같은 메일로 다시 신청 ' + ago(u.dupAt) + '</span>');
      return f.join('');
    }
    function tempBox() {
      if (!temp) return '';
      return '<div class="notebox mem-temp"><b>' + esc(temp.name || temp.email) + '</b>(' + esc(temp.email) + ')의 임시 비밀번호: <code class="auth-temp" id="memTemp">' + esc(temp.pw) + '</code> ' +
        '<button type="button" class="v2-btn mem-b" data-mem="copy">복사</button><button type="button" class="v2-link" data-mem="tempClose">닫기</button>' +
        '<p class="v2-help">메신저로 전달하세요. 받은 사람은 첫 로그인 때 새 비밀번호로 바꿉니다. 이 상자를 닫으면 다시 볼 수 없습니다(새로 발급은 가능).</p></div>';
    }
    function pendingCard(list) {
      var h = '<div class="card"><div class="card-title">승인 대기 <span class="hint">' + list.length + '건 · 누구인지 확인하고 승인하세요 — 메일 주인 확인은 관리자 승인으로 대신합니다</span></div>';
      if (!list.length) return h + '<p class="adm-empty">대기 중인 신청이 없습니다</p></div>';
      return h + '<div class="v2-tablewrap"><table class="t v2-tbl mem-tbl"><thead><tr><th>이름</th><th>메일</th><th>신청</th><th></th><th></th></tr></thead><tbody>' + list.map(function (u) {
        return '<tr><td><b>' + esc(u.name) + '</b></td><td class="mem-mail">' + esc(u.email) + '</td><td>' + when(u.createdAt) + '</td><td>' + flags(u, data.now) + '</td>' +
          '<td class="mem-acts">' + btn('approve', u.id, '승인', 'primary') + btn('reject', u.id, '거절') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    }
    function memberCard(list) {
      var now = data.now, needle = q.trim().toLowerCase();
      var rows = list.filter(function (u) { return (filter === 'all' || u.status === filter) && (!needle || (u.name + ' ' + u.email).toLowerCase().indexOf(needle) >= 0); });
      var h = '<div class="card"><div class="card-title">회원 <span class="hint">' + rows.length + '명' + (rows.length !== list.length ? ' / ' + list.length + '명' : '') + '</span></div>' +
        '<div class="mem-tools"><div class="segmented" role="group" aria-label="상태">' + FILTERS.map(function (f) {
          return '<button type="button" data-mem="filter" data-v="' + f[0] + '" class="' + (filter === f[0] ? 'on' : '') + '">' + f[1] + '</button>';
        }).join('') + '</div><input class="v2-in mem-q" id="memQ" type="search" placeholder="이름 · 메일 찾기" aria-label="이름 · 메일 찾기" value="' + esc(q) + '"></div>';
      if (!rows.length) return h + '<p class="adm-empty">맞는 회원이 없습니다</p></div>';
      return h + '<div class="v2-tablewrap"><table class="t v2-tbl mem-tbl"><thead><tr><th>이름</th><th>메일</th><th>등급</th><th>설정 수정</th><th>상태</th><th>최근 접속</th><th>가입</th><th>할 일</th></tr></thead><tbody>' +
        rows.map(function (u) {
          var acts = '';
          if (sure === u.id) acts = '<span class="mem-sure">이름 · 메일을 지우고 되돌릴 수 없습니다</span>' + btn('delGo', u.id, '정말 삭제', 'danger') + btn('delNo', u.id, '취소');
          else if (u.status === 'active') {
            acts = btn('suspend', u.id, '정지') + btn('role', u.id, u.role === 'admin' ? '관리자 해제' : '관리자로') +
              (u.role === 'admin' ? '' : btn('edit', u.id, u.canEdit ? '설정 권한 끄기' : '설정 권한 켜기')) +
              (u.lockUntil > now ? btn('unlock', u.id, '잠금 풀기') : '') + btn('temp', u.id, '임시 비밀번호') + btn('del', u.id, '삭제');
          } else if (u.status === 'suspended') acts = btn('resume', u.id, '정지 풀기') + btn('del', u.id, '삭제');
          else if (u.status === 'rejected') acts = btn('approve', u.id, '승인') + btn('del', u.id, '삭제');
          return '<tr class="mem-' + u.status + '"><td><b>' + esc(u.name) + '</b>' + flags(u, now) + '</td><td class="mem-mail">' + esc(u.email) + '</td>' +
            '<td>' + (u.role === 'admin' ? '<span class="mem-f admin">관리자</span>' : '회원') + '</td><td>' + (u.role === 'admin' || u.canEdit ? '있음' : '—') + '</td>' +
            '<td><span class="mem-st ' + u.status + '">' + (STN[u.status] || u.status) + '</span></td><td>' + ago(u.lastSeen) + '</td><td>' + when(u.approvedAt || u.createdAt).slice(0, 10) + '</td>' +
            '<td class="mem-acts">' + acts + '</td></tr>';
        }).join('') + '</tbody></table></div><p class="v2-help">90일 동안 접속하지 않은 회원은 밤마다 자동으로 정지합니다(마지막 관리자는 빼고).' +
        '정지 · 임시 비밀번호 · 등급을 바꾸면 그 회원은 다시 로그인해야 합니다. 마지막 관리자는 정지 · 해제 · 삭제할 수 없습니다.</p></div>';
    }
    function auditCard() {
      if (!audit) return '';
      return '<details class="card mem-audit"' + (openAudit ? ' open' : '') + '><summary class="card-title">관리 기록 <span class="hint">최근 ' + audit.length + '건 · 승인 · 권한 · 정지 · 설정 수정(누가)</span></summary>' +
        (audit.length ? '<div class="v2-tablewrap"><table class="t v2-tbl mem-tbl"><thead><tr><th>시각</th><th>누가</th><th>무엇</th><th>대상</th><th>내용</th></tr></thead><tbody>' + audit.map(function (a) {
          return '<tr><td>' + when(a.at) + '</td><td>' + esc(a.actor) + '</td><td>' + esc(ACTN[a.action] || a.action) + '</td><td class="mem-mail">' + esc(a.target) + '</td><td>' + esc(a.detail) + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="adm-empty">아직 기록이 없습니다</p>') + '</details>';
    }
    function render() {
      if (!el) return;
      var foc = document.activeElement && document.activeElement.id === 'memQ' ? document.activeElement.selectionStart : null;
      if (!data) { el.innerHTML = '<div class="card"><div class="card-title">' + (busy ? '불러오는 중…' : esc(msg || '불러오지 못했습니다')) + '</div></div>'; return; }
      var us = data.users, pending = us.filter(function (u) { return u.status === 'pending'; }), rest = us.filter(function (u) { return u.status !== 'pending'; });
      var n = function (s) { return us.filter(function (u) { return u.status === s; }).length; }, resets = us.filter(function (u) { return u.resetAt; }).length;
      el.innerHTML = '<div class="adm-tiles mem-tiles">' + [['승인 대기', pending.length], ['활성 회원', n('active')], ['정지', n('suspended')], ['비밀번호 재설정 요청', resets]].map(function (t) {
        return '<div class="adm-tile"><div class="l">' + t[0] + '</div><div class="v">' + t[1] + '</div></div>';
      }).join('') + '</div>' +
        (msg ? '<div class="notebox' + (bad ? ' v2-bad' : '') + '" role="status">' + esc(msg) + '</div>' : '') + tempBox() + pendingCard(pending) + memberCard(rest) + auditCard();
      if (foc != null) { var i = el.querySelector('#memQ'); if (i) { i.focus(); i.setSelectionRange(foc, foc); } }
    }
    function onClick(e) {
      var b = e.target.closest('[data-mem]');
      if (!b || b.disabled) return;
      var a = b.getAttribute('data-mem'), u = byId(+b.getAttribute('data-id'));
      if (a === 'filter') { filter = b.getAttribute('data-v'); render(); return; }
      if (a === 'copy') {
        var t = temp && temp.pw;
        if (t && navigator.clipboard) navigator.clipboard.writeText(t).then(function () { b.textContent = '복사됨'; }, function () { b.textContent = '직접 고르세요'; });
        return;
      }
      if (a === 'tempClose') { temp = null; render(); return; }
      if (!u) return;
      if (a === 'approve') act(u, 'approve', null, '승인했습니다 — ' + u.name + '(' + u.email + ') 이제 로그인할 수 있습니다');
      else if (a === 'reject') act(u, 'reject', null, '거절했습니다 — ' + u.email + '(30일 뒤 지움)');
      else if (a === 'suspend') act(u, 'suspend');
      else if (a === 'resume') act(u, 'resume');
      else if (a === 'role') act(u, 'role', { role: u.role === 'admin' ? 'member' : 'admin' }, (u.role === 'admin' ? '관리자에서 해제했습니다 — ' : '관리자로 지정했습니다 — ') + u.name);
      else if (a === 'edit') act(u, 'edit', { canEdit: !u.canEdit }, '설정 수정 권한을 ' + (u.canEdit ? '껐습니다' : '켰습니다') + ' — ' + u.name);
      else if (a === 'unlock') act(u, 'unlock');
      else if (a === 'temp') issueTemp(u);
      else if (a === 'del') { sure = u.id; render(); }
      else if (a === 'delNo') { sure = null; render(); }
      else if (a === 'delGo') remove(u);
    }
    function onInput(e) { if (e.target.id === 'memQ') { q = e.target.value; render(); } }
    function onToggle(e) { if (e.target.classList && e.target.classList.contains('mem-audit')) openAudit = e.target.open; }
    return {
      show: function (container) {
        if (el !== container) {
          el = container;
          el.addEventListener('click', onClick);
          el.addEventListener('input', onInput);
          el.addEventListener('toggle', onToggle, true);
        }
        load();
      }
    };
  }
  var api = { create: create };
  root.V2Members = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
