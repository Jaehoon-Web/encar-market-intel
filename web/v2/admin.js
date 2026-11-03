/*
 * admin.js — 관리자 대시보드(기획 v2.28 · 5.11.3, 인터뷰 Q148~Q173) · #/admin
 *
 * 관리자 비밀번호 → 이 브라우저에 30일 출입증 → /api/admin/stats?days=7|30|90 이 주는 하루 요약들을 합쳐 그린다.
 *   맨 위: 어제 요약 3줄(Q172) · 핵심 숫자 5칸 어제 vs 그제(Q160) · 기간 단추(Q161) · 엑셀(Q167) · 이 브라우저 제외(Q169)
 *   01 일자별(막대 + 표, Q162) 02 화면·기능 03 많이 조회한 모델 04 이탈(단계 흐름 · 결과 깊이 · 마지막 화면 · 입력하다 포기, Q154)
 *   05 경로·처음 화면·기기(Q163·Q158) 06 오류·속도(Q173)
 * 사람은 익명 번호뿐이다(Q151). 방문자 수는 날마다의 익명 번호를 합쳐 겹침을 뺀다.
 */
(function (root) {
  'use strict';
  var TOKEN = 'cr_admin', RANGE = 'cr_admin_days';
  var SCR = { 'price.one': '시세 산정 · 한 대', 'price.model': '모델 요약', 'price.batch': '묶음 산정', 'price.rates': '환산 비율', pulse: '마켓 펄스', market: '시장 시황', data: '데이터' };
  var SEC = { price: '시세', basis: '산정 근거', market: '동급 대비', speed: '판매·추세', ladder: '가격 사다리', comps: '비교 매물', model: '판매 현황', matrix: '시세표',
    grades: '등급별', trend: '시세 추세', top: '맨 위(조건)', batch: '묶음 산정' };
  var KEYS = { mk: '제조사', grp: '모델', model: '세부모델', grade: '등급', trim: '세부등급', y: '최초등록 연도', m: '월', km: '주행거리', cost: '예상 수리비', rate: '환산 비율',
    pos: '기록부 부위', rent: '렌트 번호판', sold: '최근 판매 포함' };
  var ACT = { example: '예시로 채워 보기', findName: '차명 찾기', pickCand: '차명 후보 고르기', carOpen: '차 다시 고르기', toCond: '조건 바꾸기(붙는 조건 바)',
    recUnfold: '기록부 펼치기', recFold: '기록부 접기', parse: '기록부 텍스트 읽기', reset: '초기화', recent: '최근 산정 열기', recentClear: '최근 산정 지우기',
    toBatch: '묶음에 추가', openBatch: '묶음 산정으로', more: '비교 매물 전체 보기', exClear: '뺀 매물 되돌리기', clearExtra: '목록 밖 부위 지우기', damage: '기록부 부위 그림',
    download: '데이터 탭 내려받기', outlink: '원문 매물 보기', 'ladder:cell': '시세표 칸(다시 산정)', 'ladder:grade': '등급 줄(다시 산정)', 'mbar:res': '아래 띠 → 결과', 'mbar:need': '아래 띠 → 남은 칸' };
  var EXP = { xlsx: '엑셀 · 한 대', sheet: '한 장 요약', share: '링크 복사', xlsxModel: '엑셀 · 모델 요약', 'batch:xlsx': '엑셀 · 묶음', 'sheet:print': '한 장 요약 인쇄' };
  var SEG = { mode: ['탭', { one: '한 대 산정', model: '모델 요약', batch: '묶음 산정', rates: '환산 비율' }], sort: ['비교 매물 정렬', { sim: '유사도', adj: '보정가', price: '호가' }],
    posx: ['내 차 위치 가로축', { km: '주행', age: '차령' }], mgrade: ['시세표 등급', { one: '고른 등급', all: '전체 등급' }], cond: ['성능 상태', { '입력': '기록부 입력' }],
    color: ['색상', { '': '상관없음' }], sr: ['단순수리', { auto: '자동', yes: '있음', no: '없음' }], mech: ['기계 결함', { 0: '없음', 1: '경미', 2: '결함' }], fix: ['수리 필요', {}] };
  var BATCH = { run: '산정하기', sample: '예시 목록 넣기', clear: '지우기', xlsx: '엑셀', sumSort: '요약 정렬', sumAll: '요약 전체 보기', only: '확인할 차만', header: '첫 줄 머리글',
    tokFix: '표기 고침', tokSkip: '표기 무시', forget: '고친 표기 잊기' };
  var LAST = { '@view': '화면만 열고', '@result': '결과를 보고', '@pick': '차를 고르다', '@miss': '칸을 채우다', '@batch': '묶음 산정 뒤' };
  var FUNNEL = ['들어옴', '차 고름', '결과 나옴', '산정 근거까지 봄', '내보내기'];
  var ERR = { js: '화면 오류', promise: '처리 오류', load: '데이터 못 불러옴' };

  function create(ctx) {
    var esc = ctx.esc, el = null, data = null, busy = false, msg = '';
    function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function put(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* 저장 못 해도 화면은 그대로 */ } }
    function range() { var d = +get(RANGE); return d === 30 || d === 90 ? d : 7; }
    function n0(v) { return Math.round(v || 0).toLocaleString('ko-KR'); }
    function pc(a, b) { return b ? Math.round(a / b * 100) + '%' : '—'; }
    function dur(sec) {                                        // 보는 시간: 1시간 2분 · 3분 12초 · 45초
      sec = Math.round(sec || 0);
      if (sec >= 3600) return Math.floor(sec / 3600) + '시간 ' + Math.round(sec % 3600 / 60) + '분';
      if (sec >= 60) return Math.floor(sec / 60) + '분 ' + (sec % 60) + '초';
      return sec + '초';
    }
    function md(d) { return +d.slice(5, 7) + '/' + +d.slice(8, 10); }
    function wd(d) { return '일월화수목금토'.charAt(new Date(Date.parse(d + 'T12:00:00Z')).getUTCDay()); }   // 그날 정오(UTC)로 요일
    function scrName(s) { return SCR[s] || s || '—'; }
    function actName(k) {                                     // 'price.one|nav:basis' → '목차 → 산정 근거'
      var n = k.split('|').slice(1).join('|'), m;
      if (ACT[n]) return ACT[n];
      if (EXP[n]) return EXP[n];
      if ((m = /^(nav|fold|info):(.+)$/.exec(n))) return { nav: '목차 → ', fold: '접기·펼치기: ', info: 'ⓘ 설명: ' }[m[1]] + (SEC[m[2]] || m[2]);
      if ((m = /^(input|need):(.+)$/.exec(n))) return (m[1] === 'input' ? '칸 바꿈: ' : '남은 칸 누름: ') + (KEYS[m[2]] || m[2]);
      if ((m = /^link:(.+)$/.exec(n))) return '링크 → ' + scrName(m[1].split('?')[0] === 'price' ? 'price.one' : m[1].split('?')[0]);
      if ((m = /^batch:(.+)$/.exec(n))) return '묶음: ' + (BATCH[m[1]] || m[1]);
      if ((m = /^sheet:(.+)$/.exec(n))) return '한 장 요약: ' + ({ close: '닫기', print: '인쇄' }[m[1]] || m[1]);
      if ((m = /^text:(.+)$/.exec(n))) return m[1];
      if ((m = /^([a-z]+)=(.*)$/.exec(n)) && SEG[m[1]]) return SEG[m[1]][0] + ': ' + (SEG[m[1]][1][m[2]] != null ? SEG[m[1]][1][m[2]] : m[2]);
      return n;
    }
    function lastName(k) { var p = k.split('|'), n = p.slice(1).join('|'), m = /^export:(.+)$/.exec(n); return m ? '내보내기(' + (EXP[m[1]] || m[1]) + ')' : LAST[n] || actName(k); }
    function top(obj, n) { return Object.keys(obj || {}).map(function (k) { return [k, obj[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, n || 20); }
    function median(a) { if (!a.length) return null; var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; }

    function merge(days) {                                    // 하루 요약 여러 개 → 기간 합계(방문자는 익명 번호 합집합)
      var M = { uids: {}, visitors: 0, sessions: 0, dev: { pc: 0, m: 0 }, sec: 0, scr: {}, act: {}, models: {}, mmodels: {}, results: 0, msum: 0, batch: 0, cars: 0,
        exports: {}, funnel: [0, 0, 0, 0, 0], depth: [0, 0, 0, 0, 0, 0], last: {}, lastAct: {}, abandon: 0, fields: {}, paths: {}, entry: {}, entryCar: 0,
        err: {}, errs: [], ready: [], load: [] };
      var add = function (a, b) { Object.keys(b || {}).forEach(function (k) { a[k] = (a[k] || 0) + b[k]; }); };
      days.forEach(function (d) {
        if (!d || !d.sessions) return;
        d.uids.forEach(function (u) { M.uids[u] = 1; });
        ['sessions', 'sec', 'results', 'msum', 'batch', 'cars', 'abandon', 'entryCar'].forEach(function (k) { M[k] += d[k] || 0; });
        ['dev', 'act', 'models', 'mmodels', 'exports', 'last', 'lastAct', 'fields', 'paths', 'entry', 'err'].forEach(function (k) { add(M[k], d[k]); });
        Object.keys(d.scr || {}).forEach(function (s) { var a = M.scr[s] || (M.scr[s] = { views: 0, sec: 0, sessions: 0 }); a.views += d.scr[s].views; a.sec += d.scr[s].sec; a.sessions += d.scr[s].sessions; });
        d.funnel.forEach(function (v, i) { M.funnel[i] += v; });
        d.depth.forEach(function (v, i) { M.depth[i] += v; });
        M.errs = M.errs.concat(d.errs || []);
        M.ready = M.ready.concat(d.ready || []);
        M.load = M.load.concat(d.load || []);
      });
      M.visitors = Object.keys(M.uids).length;
      M.errs.sort(function (a, b) { return b[0] - a[0]; });
      return M;
    }
    function day(d) { return merge([d]); }
    function exportsN(x) { return Object.keys(x.exports).reduce(function (s, k) { return s + x.exports[k]; }, 0); }
    function errN(x) { return Object.keys(x.err).reduce(function (s, k) { return s + x.err[k]; }, 0); }

    // ───── 그리기 ─────
    function loginHtml() {
      return '<div class="v2-phead"><div class="v2-ptl"><h1 class="v2-h1">관리자</h1><div class="v2-psub">이용 통계 · 익명</div></div></div>' +
        '<div class="card adm-login"><div class="card-title">관리자 비밀번호</div>' +
        (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? '<p class="adm-local">이 화면은 <b>내 컴퓨터 미리보기</b>입니다(시험 데이터 · 시험 비밀번호). 실제 사이트의 관리자 화면은 carisma-r.fullsoup.workers.dev/#/admin 입니다.</p>' : '') +
        '<form id="admLogin" autocomplete="on"><input type="text" name="username" value="admin" autocomplete="username" hidden>' +
        '<input class="v2-in" type="password" id="admPw" autocomplete="current-password" placeholder="비밀번호" aria-label="관리자 비밀번호">' +
        '<button type="submit" class="v2-btn primary">들어가기</button></form>' +
        (msg ? '<p class="adm-msg">' + esc(msg) + '</p>' : '') +
        '<p class="adm-note">맞으면 이 브라우저에 30일 동안 들어올 수 있는 출입증을 둡니다(비밀번호는 저장하지 않음).</p></div>';
    }
    function tile(label, v, prev, fmt, sub, bad) {             // bad: 늘면 나쁜 숫자(오류) — 색을 거꾸로
      var d = v - prev, cls = (bad ? -d : d) > 0 ? 'up' : (bad ? -d : d) < 0 ? 'dn' : '';
      return '<div class="adm-tile"><div class="l">' + label + '</div><div class="v">' + fmt(v) + '</div><div class="d ' + cls + '">' +
        (prev == null ? '' : d === 0 ? '전날과 같음' : (d > 0 ? '▲ ' : '▼ ') + fmt(Math.abs(d)) + ' · 전날 ' + fmt(prev)) + (sub ? ' · ' + sub : '') + '</div></div>';
    }
    function rank(rows, unit, name) {                          // 순위 표 + 막대
      if (!rows.length) return '<p class="adm-empty">아직 기록이 없습니다</p>';
      var max = rows[0][1] || 1;
      return '<table class="t v2-tbl adm-rank"><tbody>' + rows.map(function (r, i) {
        return '<tr><td class="adm-no">' + (i + 1) + '</td><td>' + esc(name ? name(r[0]) : r[0]) + '</td><td class="adm-barc"><span class="adm-bar" style="width:' +
          Math.max(2, r[1] / max * 100).toFixed(1) + '%"></span></td><td class="num">' + n0(r[1]) + (unit || '') + '</td></tr>';
      }).join('') + '</tbody></table>';
    }
    function section(no, title, body, sub) {
      return '<section class="v2-sec adm-sec"><div class="v2-sech"><span class="v2-secno" aria-hidden="true">0' + no + '</span><h2>' + esc(title) + '</h2>' +
        (sub ? '<span class="v2-peek">' + esc(sub) + '</span>' : '') + '</div>' + body + '</section>';
    }
    function card(title, body, hint) { return '<div class="card"><div class="card-title">' + esc(title) + (hint ? ' <span class="hint">' + esc(hint) + '</span>' : '') + '</div>' + body + '</div>'; }

    function summaryLines(x, label, prev) {                    // 어제 요약 3줄(Q172)
      if (!x.sessions) return ['<li>' + label + '은 방문 기록이 없습니다.</li>'];
      var deep = x.funnel[3], res = x.funnel[2], f = top(x.fields, 1)[0], la = top(x.lastAct, 1)[0], ac = top(x.act, 1)[0];
      return [
        '<li>' + label + ' 방문자 <b>' + n0(x.visitors) + '명</b>' + (prev ? '(전날 ' + n0(prev.visitors) + '명)' : '') + ' · 방문 ' + n0(x.sessions) + '회 · 방문당 보는 시간 <b>' + dur(x.sec / x.sessions) + '</b></li>',
        '<li>시세 산정 <b>' + n0(x.results) + '건</b> · 모델 요약 ' + n0(x.msum) + '건 · 묶음 ' + n0(x.batch) + '회(' + n0(x.cars) + '대)' +
          (res ? ' / 결과를 본 방문의 <b>' + pc(deep, res) + '</b>가 산정 근거까지 내려봄' : '') + '</li>',
        '<li>' + (x.abandon ? '입력하다 떠난 방문 <b>' + n0(x.abandon) + '회</b> — 가장 많이 비어 있던 칸: <b>' + esc(f ? f[0] : '—') + '</b>' :
          '입력하다 떠난 방문 없음') + (la ? ' · 가장 많이 끝난 곳: ' + esc(scrName(la[0].split('|')[0]) + ' · ' + lastName(la[0])) : '') +
          (ac ? ' · 가장 많이 쓴 기능: ' + esc(actName(ac[0])) : '') + '</li>'];
    }

    function bars(days, today) {                               // 일자별 방문자 막대(누르거나 올리면 그날 숫자)
      var max = Math.max.apply(null, days.map(function (d) { return d.uids ? d.uids.length : 0; }).concat([1])), every = days.length > 31 ? 7 : days.length > 10 ? 3 : 1;
      return '<div class="adm-bars" role="img" aria-label="일자별 방문자">' + days.map(function (d, i) {
        var v = d.uids ? d.uids.length : 0, x = day(d);
        var tip = md(d.day) + (d.day === today ? ' (오늘, 진행 중)' : '') + '\n방문자 ' + v + '명 · 방문 ' + x.sessions + '회 · 보는 시간 ' + dur(x.sec) + '\n산정 ' + x.results + '건 · 묶음 ' + x.batch + '회';
        return '<div class="adm-col' + (d.day === today ? ' today' : '') + '" data-tip="' + esc(tip) + '" tabindex="0"><span class="adm-v">' + (v || '') + '</span>' +
          '<span class="adm-b" style="height:' + (v / max * 100).toFixed(1) + '%"></span><span class="adm-x">' + (i % every === 0 || i === days.length - 1 ? md(d.day) : '') + '</span></div>';
      }).join('') + '</div>';
    }
    function dailyTable(days, today) {
      return '<div class="v2-tablewrap"><table class="t v2-tbl adm-daily"><thead><tr><th>날짜</th><th class="num">방문자</th><th class="num">방문</th><th class="num">방문당 보는 시간</th>' +
        '<th class="num">시세 산정</th><th class="num">모델 요약</th><th class="num">묶음(대)</th><th class="num">내보내기</th><th class="num">오류</th></tr></thead><tbody>' +
        days.slice().reverse().map(function (d) {
          var x = day(d);
          return '<tr' + (d.day === today ? ' class="adm-today"' : '') + '><td>' + md(d.day) + '(' + wd(d.day) + ')' + (d.day === today ? ' <small>진행 중</small>' : '') + '</td><td class="num">' + n0(x.visitors) +
            '</td><td class="num">' + n0(x.sessions) + '</td><td class="num">' + (x.sessions ? dur(x.sec / x.sessions) : '—') + '</td><td class="num">' + n0(x.results) + '</td><td class="num">' + n0(x.msum) +
            '</td><td class="num">' + n0(x.batch) + (x.cars ? '(' + n0(x.cars) + ')' : '') + '</td><td class="num">' + n0(exportsN(x)) + '</td><td class="num">' + n0(errN(x)) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    function funnelHtml(x) {
      var f = x.funnel, base = f[0] || 1;
      return '<div class="adm-funnel">' + FUNNEL.map(function (name, i) {
        return '<div class="adm-step"><span class="nm">' + (i + 1) + '. ' + name + '</span><span class="tr"><span class="adm-bar" style="width:' + Math.max(1, f[i] / base * 100).toFixed(1) + '%"></span></span>' +
          '<span class="num"><b>' + n0(f[i]) + '</b> · ' + pc(f[i], base) + (i ? ' <small>(앞 단계의 ' + pc(f[i], f[i - 1]) + ')</small>' : '') + '</span></div>';
      }).join('') + '</div>';
    }
    function depthHtml(x) {
      var tot = x.depth.reduce(function (a, b) { return a + b; }, 0), names = ['01 시세', '02 산정 근거', '03 동급 대비', '04 판매·추세', '05 가격 사다리', '06 비교 매물'];
      if (!tot) return '<p class="adm-empty">아직 한 대 산정 결과가 없습니다</p>';
      return '<div class="adm-funnel">' + names.map(function (nm, i) {
        var reach = x.depth.slice(i).reduce(function (a, b) { return a + b; }, 0);
        return '<div class="adm-step"><span class="nm">' + nm + '</span><span class="tr"><span class="adm-bar" style="width:' + Math.max(1, reach / tot * 100).toFixed(1) + '%"></span></span>' +
          '<span class="num"><b>' + pc(reach, tot) + '</b> · ' + n0(reach) + '건</span></div>';
      }).join('') + '</div>';
    }
    function errHtml(x) {
      var ready = median(x.ready), load = median(x.load);
      var h = '<div class="adm-kv"><div><span>처음 화면 · 데이터 준비(가운데 값)</span><b>' + (ready == null ? '—' : (ready / 1000).toFixed(1) + '초') + '</b></div>' +
        '<div><span>페이지 읽기(가운데 값)</span><b>' + (load == null ? '—' : (load / 1000).toFixed(1) + '초') + '</b></div>' +
        '<div><span>오류</span><b>' + n0(errN(x)) + '건</b>' + top(x.err, 3).map(function (e) { return ' <small>' + esc(ERR[e[0]] || e[0]) + ' ' + e[1] + '</small>'; }).join('') + '</div></div>';
      if (x.errs.length) h += '<table class="t v2-tbl adm-errs"><thead><tr><th>시각</th><th>화면</th><th>종류</th><th>내용</th></tr></thead><tbody>' + x.errs.slice(0, 10).map(function (e) {
        var t = new Date(e[0] + 9 * 3600e3).toISOString();
        return '<tr><td>' + md(t.slice(0, 10)) + ' ' + t.slice(11, 16) + '</td><td>' + esc(scrName(e[1])) + '</td><td>' + esc(ERR[e[2]] || e[2]) + '</td><td class="adm-msgc">' + esc(e[3]) + '</td></tr>';
      }).join('') + '</tbody></table>';
      return h;
    }

    function render() {
      if (!el) return;
      if (!get(TOKEN)) { el.innerHTML = loginHtml(); var pw = el.querySelector('#admPw'); if (pw) pw.focus(); return; }
      var head = '<div class="v2-phead"><div class="v2-ptl"><h1 class="v2-h1">관리자</h1><div class="v2-psub">이용 통계 · 익명 번호 기준(이름·IP 없음)' +
        (data ? '<small>' + esc(new Date(data.now + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')) + ' 기준 · 오늘은 진행 중</small>' : '') + '</div></div>' +
        '<div class="adm-tools"><div class="segmented" role="group" aria-label="기간">' + [7, 30, 90].map(function (d) {
          return '<button type="button" data-adm="range" data-v="' + d + '" class="' + (range() === d ? 'on' : '') + '">' + d + '일</button>';
        }).join('') + '</div><button type="button" class="v2-btn" data-adm="xlsx"' + (data && data.store ? '' : ' disabled') + '>엑셀 ↓</button>' +
        '<button type="button" class="v2-btn" data-adm="reload">새로 고침</button>' +
        '<label class="v2-toggle" title="켜 두면 이 브라우저의 방문은 통계에 넣지 않습니다"><input type="checkbox" data-adm="notrack"' + (get('cr_notrack') === '1' ? ' checked' : '') +
        '><span class="trk" aria-hidden="true"></span>이 브라우저 제외</label><button type="button" class="v2-link" data-adm="logout">로그아웃</button></div></div>';
      if (!data) { el.innerHTML = head + '<div class="card"><div class="card-title">' + (busy ? '불러오는 중…' : esc(msg || '불러오지 못했습니다')) + '</div></div>'; return; }
      if (!data.store) { el.innerHTML = head + '<div class="card"><div class="card-title">이용 통계 저장소가 아직 연결되지 않았습니다</div></div>'; return; }
      var days = data.days, today = data.today, T = merge(days), di = days.length - 1;
      var yd = days[di - 1], bd = days[di - 2], useToday = !(yd && yd.sessions), X = useToday ? day(days[di]) : day(yd), P = useToday ? (yd ? day(yd) : null) : (bd ? day(bd) : null);
      var label = useToday ? '오늘(진행 중)' : '어제';
      var h = head + '<div class="card adm-sum"><div class="card-title">' + label + ' 요약' + (useToday ? ' <span class="hint">어제 기록이 없어 오늘을 보여 줍니다</span>' : '') + '</div><ul>' +
        summaryLines(X, label, P).join('') + '</ul></div>';
      var Pz = P || { visitors: 0, sessions: 0, sec: 0, results: 0, err: {} };
      h += '<div class="adm-tiles">' +
        tile('방문자', X.visitors, P ? Pz.visitors : null, n0) +
        tile('방문', X.sessions, P ? Pz.sessions : null, n0) +
        tile('방문당 보는 시간', X.sessions ? X.sec / X.sessions : 0, P ? (Pz.sessions ? Pz.sec / Pz.sessions : 0) : null, dur) +
        tile('시세 산정', X.results, P ? Pz.results : null, n0, '모델 요약 ' + n0(X.msum)) +
        tile('오류', errN(X), P ? errN(Pz) : null, n0, '', true) + '</div>';
      h += section(1, '일자별', card('방문자', bars(days, today), '최근 ' + days.length + '일 · 막대에 올리면 그날 숫자') + dailyTable(days, today),
        '기간 방문자 ' + n0(T.visitors) + '명 · 방문 ' + n0(T.sessions) + '회');
      var scrRows = top(Object.keys(T.scr).reduce(function (o, k) { o[k] = T.scr[k].sec; return o; }, {}), 10);
      h += section(2, '화면 · 기능', '<div class="adm-grid2">' +
        card('화면별', '<table class="t v2-tbl"><thead><tr><th>화면</th><th class="num">방문</th><th class="num">보기</th><th class="num">보는 시간</th><th class="num">방문당</th></tr></thead><tbody>' +
          (scrRows.length ? scrRows.map(function (r) { var s = T.scr[r[0]]; return '<tr><td>' + esc(scrName(r[0])) + '</td><td class="num">' + n0(s.sessions) + '</td><td class="num">' + n0(s.views) +
            '</td><td class="num">' + dur(s.sec) + '</td><td class="num">' + (s.sessions ? dur(s.sec / s.sessions) : '—') + '</td></tr>'; }).join('') : '<tr><td colspan="5" class="adm-empty">아직 기록이 없습니다</td></tr>') +
          '</tbody></table>', '보는 시간 순') +
        card('많이 쓴 기능 Top 20', rank(top(T.act, 20), '회', function (k) { return actName(k) + ' · ' + scrName(k.split('|')[0]); }), '누른 횟수') + '</div>');
      h += section(3, '많이 조회한 모델', '<div class="adm-grid2">' +
        card('한 대 산정 · 모델 · 등급 Top 20', rank(top(T.models, 20), '건', function (k) { return k.replace('|', ' · '); })) +
        card('모델 요약 Top 10', rank(top(T.mmodels, 10), '건')) + '</div>', '산정 ' + n0(T.results) + '건');
      h += section(4, '이탈 — 어디서 멈추나', '<div class="adm-grid2">' +
        card('단계 흐름', funnelHtml(T), '방문 기준') + card('결과 어디까지 봤나', depthHtml(T), '한 대 산정 결과 기준 · 그 섹션까지 내려간 비율') +
        card('마지막 화면 · 행동 Top 10', rank(top(T.lastAct, 10), '회', function (k) { return scrName(k.split('|')[0]) + ' · ' + lastName(k); }), '방문이 끝날 때') +
        card('입력하다 떠남 — 비어 있던 칸', rank(top(T.fields, 10), '회'), '결과 없이 끝난 방문 ' + n0(T.abandon) + '회') + '</div>');
      var dev = T.dev.pc + T.dev.m;
      h += section(5, '경로 · 처음 화면 · 기기', '<div class="adm-grid2">' +
        card('이동 경로 Top 10', rank(top(T.paths, 10), '회', function (k) { return k.split('>').map(scrName).join(' → '); }), '방문마다 처음 네 화면') +
        card('처음 들어온 화면', rank(top(T.entry, 8), '회', scrName) + '<p class="adm-note">차가 든 주소(공유 링크 · 최근 산정)로 들어온 방문 ' + n0(T.entryCar) + '회</p>' +
          '<div class="adm-kv"><div><span>PC</span><b>' + pc(T.dev.pc, dev) + '</b> <small>' + n0(T.dev.pc) + '회</small></div><div><span>휴대폰</span><b>' + pc(T.dev.m, dev) +
          '</b> <small>' + n0(T.dev.m) + '회</small></div></div>', '방문 기준') + '</div>');
      h += section(6, '오류 · 속도', card('오류와 걸린 시간', errHtml(T)));
      el.innerHTML = h;
      if (ctx.bindTips) ctx.bindTips(el);
    }

    function load() {
      busy = true; msg = ''; render();
      return fetch('/api/admin/stats?days=' + range(), { headers: { authorization: 'Bearer ' + get(TOKEN) }, cache: 'no-store' })
        .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
        .then(function (x) {
          busy = false;
          if (x.status === 401) { put(TOKEN, null); data = null; msg = x.j.error || '다시 로그인해 주세요'; render(); return; }
          if (!x.j.ok) { data = null; msg = x.j.error || '불러오지 못했습니다'; render(); return; }
          data = x.j; render();
        }).catch(function (e) { busy = false; data = null; msg = '불러오지 못했습니다: ' + (e && e.message || e); render(); });
    }
    function login(pw) {
      msg = '확인 중…'; render();
      fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j.ok) { put(TOKEN, j.token); msg = ''; load(); } else { msg = j.error || '들어가지 못했습니다'; render(); } })
        .catch(function (e) { msg = '들어가지 못했습니다: ' + (e && e.message || e); render(); });
    }
    function xlsx() {                                          // 엑셀 한 파일(Q167): 일자별 · 화면 · 기능 · 모델 · 단계 흐름 · 결과 깊이 · 마지막 화면 · 입력하다 포기 · 경로 · 처음 화면 · 오류
      if (!data || !root.XlsxWriter) return;
      var days = data.days, T = merge(days);
      var daily = [['날짜', '방문자', '방문', '보는 시간(초)', '방문당 보는 시간(초)', '시세 산정', '모델 요약', '묶음 산정(회)', '묶음 대수', '내보내기', '오류', 'PC 방문', '휴대폰 방문']];
      days.forEach(function (d) { var x = day(d); daily.push([d.day + (d.day === data.today ? '(진행 중)' : ''), x.visitors, x.sessions, x.sec, x.sessions ? Math.round(x.sec / x.sessions) : null,
        x.results, x.msum, x.batch, x.cars, exportsN(x), errN(x), x.dev.pc, x.dev.m]); });
      var sheet = function (name, head, rows, widths) { return { name: name, rows: [head].concat(rows), header: true, widths: widths }; };
      var depthNames = ['01 시세', '02 산정 근거', '03 동급 대비', '04 판매·추세', '05 가격 사다리', '06 비교 매물'], tot = T.depth.reduce(function (a, b) { return a + b; }, 0);
      root.XlsxWriter.download(ctx.fileSafe('이용통계_' + days[0].day + '_' + days[days.length - 1].day) + '.xlsx', [
        { name: '일자별', rows: daily, header: true, widths: [16, 9, 9, 13, 18, 10, 10, 13, 10, 10, 8, 10, 11] },
        sheet('화면', ['화면', '방문', '보기', '보는 시간(초)'], Object.keys(T.scr).map(function (k) { return [scrName(k), T.scr[k].sessions, T.scr[k].views, T.scr[k].sec]; }), [22, 9, 9, 14]),
        sheet('기능', ['화면', '기능', '횟수'], top(T.act, 500).map(function (r) { return [scrName(r[0].split('|')[0]), actName(r[0]), r[1]]; }), [20, 36, 9]),
        sheet('모델', ['모델', '등급', '시세 산정'], top(T.models, 500).map(function (r) { return r[0].split('|').concat([r[1]]); }), [30, 30, 11]),
        sheet('모델 요약', ['모델', '모델 요약'], top(T.mmodels, 500), [30, 11]),
        sheet('단계 흐름', ['단계', '방문', '들어옴 대비'], FUNNEL.map(function (n, i) { return [n, T.funnel[i], T.funnel[0] ? Math.round(T.funnel[i] / T.funnel[0] * 1000) / 10 + '%' : null]; }), [20, 9, 12]),
        sheet('결과 깊이', ['섹션까지', '결과 수', '비율'], depthNames.map(function (n, i) { var r = T.depth.slice(i).reduce(function (a, b) { return a + b; }, 0); return [n, r, tot ? Math.round(r / tot * 1000) / 10 + '%' : null]; }), [18, 10, 10]),
        sheet('마지막 화면', ['화면', '마지막 행동', '방문'], top(T.lastAct, 500).map(function (r) { return [scrName(r[0].split('|')[0]), lastName(r[0]), r[1]]; }), [20, 30, 9]),
        sheet('입력하다 포기', ['비어 있던 칸', '방문'], top(T.fields, 100), [26, 9]),
        sheet('경로', ['이동 경로(처음 네 화면)', '방문'], top(T.paths, 500).map(function (r) { return [r[0].split('>').map(scrName).join(' → '), r[1]]; }), [70, 9]),
        sheet('처음 화면', ['처음 들어온 화면', '방문'], top(T.entry, 50).map(function (r) { return [scrName(r[0]), r[1]]; }), [22, 9]),
        sheet('오류', ['시각(한국)', '화면', '종류', '내용'], T.errs.map(function (e) { return [new Date(e[0] + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), scrName(e[1]), ERR[e[2]] || e[2], e[3]]; }), [18, 18, 10, 80])
      ]);
    }

    function onClick(e) {
      var b = e.target.closest('[data-adm]');
      if (!b || b.tagName === 'INPUT') return;
      var a = b.getAttribute('data-adm');
      if (a === 'range') { put(RANGE, b.getAttribute('data-v')); load(); }
      else if (a === 'reload') load();
      else if (a === 'xlsx') xlsx();
      else if (a === 'logout') { put(TOKEN, null); data = null; msg = ''; render(); }
    }
    function onChange(e) {
      if (e.target.getAttribute('data-adm') === 'notrack') put('cr_notrack', e.target.checked ? '1' : null);   // 다음에 열 때부터(지금 화면도 관리자라 세지 않음)
    }
    function onSubmit(e) {
      if (e.target.id !== 'admLogin') return;
      e.preventDefault();
      var pw = el.querySelector('#admPw');
      if (pw && pw.value) login(pw.value);
    }
    return {
      show: function (container) {
        if (el !== container) {
          el = container;
          el.addEventListener('click', onClick);
          el.addEventListener('change', onChange);
          el.addEventListener('submit', onSubmit);
        }
        if (get(TOKEN)) load(); else render();
      },
      _merge: merge, _actName: actName                          // 점검 도구용
    };
  }
  var api = { create: create };
  root.V2Admin = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
