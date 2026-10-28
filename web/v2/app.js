/*
 * app.js — 새 사이트(v2) 시세 산정 · 한 대 산정 · 모델 요약 화면 (기획안 5.1.1 · 5.1.1-1 · 5.1.3 · 5.1.5). 묶음 산정(5.1.4)은 batch.js
 *
 * 데이터(../data): comps/index.json(선택 목록·엔진 설정) · comps/g????????.json(모델그룹별 비교 매물) · adj_coef.json(보정 계수)
 *                 · conversion_rates.json(환산 비율) · inspection_model.json(성능 계산) · market_index.json(시황 지수)
 * 계산: ../lib/price_engine.js(파이썬 price_engine.py 와 같은 계산) · ../lib/inspection_score.js(파이프라인과 같은 성능 계산)
 * 입력은 주소(#/price?…)에 남는다 — 같은 차를 팀원과 공유하거나 다시 열 수 있다.
 */
(function () {
  'use strict';

  // 사이트 뿌리 = 이 파일(v2/app.js)의 한 단계 위 — 기본 주소(/)와 /v2/ 어디서 열어도 data/·downloads/ 가 같은 곳
  var ROOT = new URL('../', document.currentScript.src).href, DATA = ROOT + 'data/';
  var COLORS = ['흰색·진주', '검정', '회색·은색', '청색', '기타'];
  var FIXES = ['외장', '내장', '광택', '룸클리닝', '휠', '타이어', '유리'];
  var STATUS_LABEL = { X: 'X 교환', W: 'W 판금', '절단': '용접·절단', U: 'U 요철', T: 'T 손상', C: 'C 부식', A: 'A 흠집' };
  var COEF_LEVEL = { '모델': '이 세부모델 자체 값', '차급': '같은 차급 평균 값(이 모델 표본이 없어서)', '시장': '시장 평균 값' };
  var SHOW = 30;                                            // 비교 매물 표 기본 행 수
  var KM_BANDS = [[0, 3e4, '3만 미만'], [3e4, 6e4, '3~6만'], [6e4, 1e5, '6~10만'], [1e5, 1.5e5, '10~15만'], [1.5e5, Infinity, '15만 이상']];
  var X = {}, ENG = null, ISC = null, GROUPS = {}, R = null, R0 = null, LAST = null, timer = 0, B = null, RV = null, MK = null, DV = null, MB = '';
  var VIEW = { sort: 'sim', all: false, mode: 'one', condWarn: [], condOut: [], exKeep: {}, allGrades: false };      // mode: one(한 대 산정) · model(모델 요약) · batch(묶음 산정) · rates(⚙ 환산 비율)
  var TIP = {                                                // 용어 설명(결과 카드·비교 매물 표의 ? — 마우스를 올리거나 누르면)
    est: '비슷한 엔카 매물(판매중 + 최근 3개월 판매)의 호가를 이 차 조건으로 맞춘 값(보정 후) 가운데 값입니다. 비슷한 매물일수록 크게 반영합니다. ' +
      '엔카 소매 호가 기준이라 실제 거래가와는 다릅니다. 범위는 보정 후 값의 가운데 50%입니다.',
    conv: '경매에서 받을 만한 값(낙찰가 수준)의 추정입니다. 추정 시세 × (1 − 환산 비율) − 수리비. 환산 비율은 같은 조건의 경매 낙찰가가 ' +
      '엔카 호가보다 얼마나 낮았는지로 정한 팀 기준입니다(⚙ 환산 비율). 기준표는 칸 가운데 값 사이를 이어서 읽어, 호가대·차령 경계에서 비율이 뛰지 않습니다.',
    grade: 'A = 비교 매물 10대 이상, 조건을 거의 넓히지 않았고 범위가 ±8% 안. B = 조건을 조금 넓힘. C = 같은 세부모델 전체로 넓힌 참고값.',
    step: '비교 매물을 같은 등급·가까운 차령·주행부터 찾고, 5대가 안 되면 범위를 한 단계씩 넓힙니다. 1단계가 가장 좁은(정확한) 조건입니다.',
    cond: '같은 차가 무사고였다면의 값입니다. 성능 상태를 넣으면 비교 매물이 비슷한 상태의 차로 바뀌어, 감가율보다 크게 빠질 수 있습니다.',
    sim: '이 차와 얼마나 비슷한지(100 = 가장 비슷). 차령·주행·등급·성능이 가까울수록 높고, 높을수록 추정 시세에 크게 반영됩니다.',
    price: '엔카에 올라온 판매 희망 가격. 판매된 매물은 목록에서 사라지기 전 마지막 호가입니다.',
    adj: '이 매물이 이 차와 조건(차령·주행·색상·렌트·등급·성능·시점)이 같았다면 매겨졌을 호가. 추정 시세는 이 값들의 가운데 값입니다.',
    dwell: '엔카에 올라온 뒤 지난 날수(판매된 매물은 판매까지)',
    cut: '첫 호가보다 내린 금액'
  };
  var MODES = ['model', 'batch', 'rates'];                  // 주소 view= 로 남는 화면
  var S = blank();

  function blank() {
    return { mk: '', grp: '', model: '', grade: '', trim: '', y: '', m: '', km: '', color: '', rent: false,
      cond: '미상', items: [], sr: 'auto', mech: '0', fixes: [], cost: '', sold: true, rate: '', ex: [] };
  }

  // ───── 도우미 ─────
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function man(v) { return Math.round(v).toLocaleString('ko-KR'); }
  function signed(v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v)).toLocaleString('ko-KR'); }
  function pct(v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%'; }
  function pad(m) { return ('0' + m).slice(-2); }
  function ym(v) { v = String(v); return v.slice(2, 4) + '-' + v.slice(4, 6); }
  function mmdd(s) { return s ? s.slice(5, 7) + '/' + s.slice(8, 10) : ''; }
  function q(t) { return ' <span class="v2-q" tabindex="0" role="note" aria-label="' + esc(t) + '" data-tip="' + esc(t) + '">?</span>'; }
  function dataDate(full) {                                  // 데이터 기준일 = 목록을 받은 날(시황·지수와 같은 날) · 수집을 마친 날이 다르면 함께
    var cs = X.mi.crawls || [], c = cs[cs.length - 1];
    if (!c) return '';
    return (full ? c.date : mmdd(c.date)) + ' 목록' + (c.crawl && c.crawl !== c.date ? '(' + mmdd(c.crawl) + ' 수집 마침)' : '');
  }
  function yrOf(mk, grp, model) { var y = X.yr && X.yr[mk + '|' + grp + '|' + model]; return y ? ' (' + y + ')' : ''; }
  function byN(a, b) { return b.n - a.n; }
  function total(mk) { return mk.groups.reduce(function (s, g) { return s + g.n; }, 0); }
  function toggle(list, v) { var i = list.indexOf(v); if (i >= 0) list.splice(i, 1); else list.push(v); }
  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; }), h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }
  function middle(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[s.length >> 1]; }
  function days(from, to) {                                 // 시작일(yyyymmdd 숫자) → 끝(yyyy-mm-dd)까지 일수
    var a = Date.UTC(Math.floor(from / 10000), Math.floor(from / 100) % 100 - 1, from % 100);
    return Math.round((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - a) / 86400000);
  }
  function fileSafe(s) { return String(s).replace(/[\\\/:*?"<>|]+/g, ' ').replace(/\s+/g, '_'); }
  function today() { var d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
  function mean(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; }
  function getJSON(p) {
    return fetch(DATA + p).then(function (r) { if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); });
  }
  function kmNum(s) { return V2Batch.kmOf(s); }            // "4.2만" · "42,000" · "6만키로" → 42000 (묶음 산정과 같은 읽기)
  function manNum(s) {                                      // 만원 단위: "30" · "30만" · "30만원"
    s = String(s || '').replace(/[,\s]|만|원/g, '');
    var v = s === '' ? null : Number(s);
    return v != null && isFinite(v) && v >= 0 ? v : null;
  }

  // ───── 데이터 찾기 ─────
  function makerOf() { return X.idx.makers.find(function (m) { return m.name === S.mk; }) || null; }
  function groupOf() { var m = makerOf(); return m ? m.groups.find(function (g) { return g.name === S.grp; }) || null : null; }
  function grp() { var g = groupOf(); return g ? GROUPS[g.file] || null : null; }
  function loadGroup() {
    var g = groupOf();
    if (!g || GROUPS[g.file]) return Promise.resolve();
    return getJSON('comps/' + g.file).then(function (F) { GROUPS[g.file] = ENG.group(F); });
  }
  function modelRows(G, model) {
    var M = G.models[model], fi = G.fi;
    return M ? G.F.rows.filter(function (r) { return r[fi.m] === M.idx; }) : [];
  }
  function countBy(rows, f, names) {
    var c = {};
    rows.forEach(function (r) { c[r[f]] = (c[r[f]] || 0) + 1; });
    return Object.keys(c).map(function (k) { return [names[k], c[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
  }
  function fuelOf(G) {                                      // 환산 비율 모델 예외용: 이 세부모델·등급에서 가장 흔한 연료
    var rows = modelRows(G, S.model), fi = G.fi, same = rows.filter(function (r) { return G.F.grades[r[fi.g]] === S.grade; });
    var c = countBy(same.length ? same : rows, fi.fu, G.F.fuels);
    return c.length ? c[0][0] : null;
  }

  // ───── 성능 상태(기록부) ─────
  function key(it) { return it.part + '|' + (it.side || '') + '|' + (it.pillar || ''); }
  function posIndex(it) {
    var k = key(it);
    for (var i = 0; i < ISC.positions.length; i++) if (key(ISC.positions[i]) === k) return i + 1;
    return 0;
  }
  function statusAt(p) { var k = key(p), it = S.items.find(function (x) { return key(x) === k; }); return it ? it.status : ''; }
  function setPos(i, status) {
    var p = ISC.positions[i], k = key(p);
    S.items = S.items.filter(function (x) { return key(x) !== k; });
    if (status) S.items.push({ part: p.part, side: p.side, pillar: p.pillar, status: status });
  }
  function condResult() {
    if (S.cond === '미상' || (S.cond === '입력' && !S.items.length)) return ISC.evaluate({ state: '미상' });   // 기록부 입력인데 부위가 없으면 미상(무사고로 치지 않음)
    var input = { state: S.cond === '무사고' ? '무사고' : '입력', items: S.cond === '입력' ? S.items : [], mechLevel: +S.mech };
    if (S.sr === 'yes') input.simpleRepair = true;
    if (S.sr === 'no') input.simpleRepair = false;
    return ISC.evaluate(input);
  }

  // ───── 주소 ↔ 입력 ─────
  var KEYS = ['mk', 'grp', 'model', 'grade', 'trim', 'y', 'm', 'km', 'color', 'cost', 'rate'];
  function itemsCode(items) {
    var code = {};
    ISC.statuses.forEach(function (s) { code[s.name] = s.code; });
    return items.map(function (it) { return [it.part, it.side || '', it.pillar || '', code[it.status] || it.status].join('|'); }).join(';');
  }
  function itemsDecode(str) {
    var name = {};
    ISC.statuses.forEach(function (s) { name[s.code] = s.name; name[s.name] = s.name; });
    return String(str || '').split(';').filter(Boolean).map(function (x) {
      var p = x.split('|');
      return { part: p[0], side: p[1] || null, pillar: p[2] || null, status: name[p[3]] || p[3] };
    });
  }
  function query(s, mode) {
    var q = new URLSearchParams();
    KEYS.forEach(function (k) { if (s[k] !== '' && s[k] != null) q.set(k, s[k]); });
    if (s.rent) q.set('rent', '1');
    if (s.cond !== '미상') q.set('cond', s.cond);
    if (s.cond === '입력' && s.items.length) q.set('it', itemsCode(s.items));
    if (s.sr !== 'auto') q.set('sr', s.sr);
    if (s.mech !== '0') q.set('mech', s.mech);
    if (s.fixes.length) q.set('fx', s.fixes.join(','));
    if (!s.sold) q.set('sold', '0');
    if (s.ex.length) q.set('ex', s.ex.join(','));
    if (mode !== 'one') q.set('view', mode);
    var str = q.toString();
    return '#/price' + (str ? '?' + str : '');
  }
  function toHash() {
    history.replaceState(null, '', query(S, VIEW.mode));
    var nav = $('navPrice');                                 // 시장 시황에서 돌아올 때 하던 산정으로
    if (nav) nav.setAttribute('href', query(S, VIEW.mode));
  }
  function fromHash() {
    var h = location.hash, i = h.indexOf('?'), q = new URLSearchParams(i >= 0 ? h.slice(i + 1) : ''), s = blank();
    KEYS.forEach(function (k) { if (q.has(k)) s[k] = q.get(k); });
    s.rent = q.get('rent') === '1';
    s.cond = ['무사고', '입력'].indexOf(q.get('cond')) >= 0 ? q.get('cond') : '미상';
    s.items = itemsDecode(q.get('it'));
    s.sr = ['yes', 'no'].indexOf(q.get('sr')) >= 0 ? q.get('sr') : 'auto';
    s.mech = ['1', '2'].indexOf(q.get('mech')) >= 0 ? q.get('mech') : '0';
    s.fixes = (q.get('fx') || '').split(',').filter(Boolean);
    s.sold = q.get('sold') !== '0';
    s.ex = (q.get('ex') || '').split(',').filter(Boolean);
    VIEW.mode = MODES.indexOf(q.get('view')) >= 0 ? q.get('view') : 'one';
    return s;
  }

  // ───── 입력 패널 ─────
  function opt(v, label, cur) { return '<option value="' + esc(v) + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + esc(label) + '</option>'; }
  function sel(k, opts, cur, off) {
    return '<select class="filter-select" data-k="' + k + '"' + (off ? ' disabled' : '') + '>' +
      opts.map(function (o) { return opt(o[0], o[1], cur); }).join('') + '</select>';
  }
  function field(label, html) { return '<div class="v2-f"><span class="v2-l">' + label + '</span>' + html + '</div>'; }
  function seg(k, opts, cur, aria) {
    return '<div class="segmented" role="group" aria-label="' + aria + '">' + opts.map(function (o) {
      return '<button type="button" data-seg="' + k + '" data-v="' + esc(o[0]) + '" class="' + (String(cur) === String(o[0]) ? 'on' : '') + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  function chip(k, v, label, on) {
    return '<button type="button" class="seg-chip' + (on ? ' on' : '') + '" data-chip="' + k + '" data-v="' + esc(v) + '">' + esc(label) + '</button>';
  }

  function renderInputs() {
    var mk = makerOf(), g = groupOf(), G = grp(), rows = G && S.model ? modelRows(G, S.model) : [], fi = G && G.fi;
    var h = '<p class="v2-auto">조건을 넣는 즉시 결과가 다시 계산됩니다 — 따로 누를 조회 버튼은 없습니다.</p><div class="v2-sect">대상 차</div>';
    h += field('제조사', sel('mk', [['', '제조사 선택']].concat(X.idx.makers.map(function (m) {
      return [m.name, m.name + ' · ' + total(m).toLocaleString() + '대'];
    })), S.mk));
    h += field('모델', sel('grp', [['', mk ? '모델 선택' : '—']].concat((mk ? mk.groups.slice().sort(byN) : []).map(function (x) {
      return [x.name, x.name + ' · ' + x.n.toLocaleString() + '대'];
    })), S.grp, !mk));
    h += field('세부모델', sel('model', [['', G ? '세부모델 선택' : (g ? '불러오는 중…' : '—')]].concat((G ? G.F.models.slice().sort(byN) : []).map(function (x) {
      return [x.name, x.name + yrOf(S.mk, S.grp, x.name) + ' · ' + x.n.toLocaleString() + '대'];
    })), S.model, !G));
    var grades = rows.length ? countBy(rows, fi.g, G.F.grades) : [];
    h += field('등급', sel('grade', [['', S.model ? '등급 선택' : '—']].concat(grades.map(function (x) {
      return [x[0], x[0] + ' · ' + x[1].toLocaleString() + '대'];
    })), S.grade, !S.model));
    var trims = S.grade && rows.length ? countBy(rows.filter(function (r) { return G.F.grades[r[fi.g]] === S.grade; }), fi.t, G.F.trims)
      .filter(function (x) { return x[0]; }) : [];                // 주소로 열 때는 모델그룹 파일을 받기 전에도 그린다
    h += field('세부등급<em>선택</em>', sel('trim', [['', trims.length ? '상관없음' : '—']].concat(trims.map(function (x) {
      return [x[0], x[0] + ' · ' + x[1].toLocaleString() + '대'];
    })), S.trim, !trims.length));
    var years = [];
    rows.forEach(function (r) { var y = Math.floor(r[fi.reg] / 100); if (years.indexOf(y) < 0) years.push(y); });
    if (S.y && years.indexOf(+S.y) < 0) years.push(+S.y);
    years.sort(function (a, b) { return b - a; });
    h += field('최초등록', '<div class="v2-two">' +
      sel('y', [['', '연도']].concat(years.map(function (y) { return [y, y + '년']; })), S.y, !S.model) +
      sel('m', [['', '월']].concat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(function (m) { return [m, m + '월']; })), S.m, !S.model) + '</div>');
    h += field('주행거리', '<div class="v2-unit"><input class="v2-in" data-k="km" inputmode="numeric" autocomplete="off" placeholder="예: 42000 또는 4.2만" value="' + esc(S.km) + '"><span>km</span></div>');
    h += field('색상', '<div class="v2-chips">' + [['', '상관없음']].concat(COLORS.map(function (c) { return [c, c]; })).map(function (c) {
      return chip('color', c[0], c[1], S.color === c[0]);
    }).join('') + '</div>');
    h += '<label class="v2-chk"><input type="checkbox" data-k="rent"' + (S.rent ? ' checked' : '') + '> 렌트 번호판(하·허·호)</label>';

    h += '<div class="v2-sect">성능 상태</div>';
    h += seg('cond', [['미상', '미상'], ['무사고', '무사고'], ['입력', '기록부 입력']], S.cond, '성능 상태');
    h += '<p class="v2-help">' + (S.cond === '입력' ? '성능·상태점검기록부의 부위 37곳을 그대로 옮겨 적습니다. 한 부위에 여러 상태면 가장 심한 것을 고릅니다.'
      : S.cond === '무사고' ? '이상 없음을 직접 고른 상태입니다.' : '입력하지 않은 상태입니다. 무사고로 치지 않습니다.') + '</p>';
    if (S.cond === '입력') h += condPanel();
    h += '<div class="notebox v2-condout" id="condOut"></div>';

    h += '<div class="v2-sect">수리 상태</div>';
    h += field('단순수리', seg('sr', [['auto', '자동'], ['yes', '있음'], ['no', '없음']], S.sr, '단순수리'));
    h += field('기계 결함<em>표시만 — 호가 영향이 거의 없음</em>', seg('mech', [['0', '없음'], ['1', '경미'], ['2', '결함']], S.mech, '기계 결함'));
    h += field('수리 필요', '<div class="v2-chips">' + FIXES.map(function (f) { return chip('fix', f, f, S.fixes.indexOf(f) >= 0); }).join('') + '</div>');
    h += field('예상 수리비<em>시세·환산가에서 그대로 뺍니다</em>', '<div class="v2-unit"><input class="v2-in" data-k="cost" inputmode="numeric" autocomplete="off" placeholder="0" value="' + esc(S.cost) + '"><span>만원</span></div>');

    h += '<div class="v2-sect">비교 범위 · 환산</div>';
    h += '<label class="v2-chk"><input type="checkbox" data-k="sold"' + (S.sold ? ' checked' : '') + '> 최근 3개월 판매 매물 포함</label>';
    h += field('환산 비율<em>비우면 자동</em>', '<div class="v2-unit"><input class="v2-in" data-k="rate" inputmode="decimal" autocomplete="off" placeholder="자동" value="' + esc(S.rate) + '"><span>%</span></div><p class="v2-help" id="rateNote"></p>');
    h += '<div class="v2-actions"><button type="button" class="v2-btn" data-act="share">링크 복사</button>' +
      '<button type="button" class="v2-btn" data-act="reset">조건 초기화</button>' +
      (S.model ? '' : '<button type="button" class="v2-btn primary" data-act="example">예시로 채워 보기</button>') + '</div>';
    $('inp').innerHTML = h;
    updateCond();
    markNeed(missing());
  }

  function condPanel() {
    var stat = '<option value="">—</option>' + ISC.statuses.map(function (s) {
      return '<option value="' + esc(s.name) + '">' + esc(STATUS_LABEL[s.code] || s.name) + '</option>';
    }).join('');
    var boards = [];
    ISC.positions.forEach(function (p, i) {
      var b = boards[boards.length - 1];
      if (!b || b.name !== p.board) boards.push(b = { name: p.board, list: [] });
      b.list.push(i);
    });
    var h = '<div class="v2-cond"><div class="v2-text"><input class="v2-in" id="condText" autocomplete="off" placeholder="텍스트로: 좌프론트휀더 X, 우쿼터 W">' +
      '<button type="button" class="v2-btn" data-act="parse">읽기</button></div><div class="v2-msg" id="condMsg">' + condMsgHtml() + '</div>';
    boards.forEach(function (b) {
      h += '<div class="v2-board"><div class="v2-board-t">' + esc(b.name) + '</div><div class="v2-pos">';
      b.list.forEach(function (i) {
        var p = ISC.positions[i], cur = statusAt(p);
        h += '<label class="v2-p' + (cur ? ' set' : '') + '"><span title="' + esc(p.label) + '">' + esc(p.label) + '</span>' +
          '<select data-k="pos" data-i="' + i + '" aria-label="' + esc(p.label) + '">' +
          stat.replace('value="' + esc(cur) + '"', 'value="' + esc(cur) + '" selected') + '</select></label>';
      });
      h += '</div></div>';
    });
    var extra = S.items.filter(function (it) { return !posIndex(it); });
    if (extra.length) {
      h += '<p class="v2-help">목록 밖 부위(텍스트로 읽음): ' + esc(ISC.summary(extra)) +
        ' <button type="button" class="v2-btn" data-act="clearExtra">지우기</button></p>';
    }
    return h + '</div>';
  }

  function condMsgHtml() {                                   // 텍스트 읽기 결과 — 못 읽은 표기(반영 안 됨) · 계산에서 뺀 부위
    var h = '';
    if (VIEW.condWarn.length) h += '<span class="v2-bad">못 읽은 표기: ' + esc(VIEW.condWarn.join(', ')) + ' — 반영하지 않았습니다. 고쳐서 다시 읽어 주세요</span>';
    if (VIEW.condOut.length) h += (h ? '<br>' : '') + '계산에서 뺀 부위: ' + esc(VIEW.condOut.join(', ')) + ' — 성능점검 대상이 아님(경매 평가에서는 감점될 수 있음)';
    return h;
  }

  function updateCond() {
    var el = $('condOut');
    if (!el) return;
    var c = condResult();
    if (c['상태'] === '미상') {
      el.innerHTML = S.cond === '입력' ? '기록부 입력 — 아직 부위가 없어 <b>상태 미상</b>으로 계산합니다(무사고로 치지 않음). 부위를 고르거나 텍스트를 읽어 넣으세요.'
        : '상태 미상 — 성능 보정 없이 비교 매물의 평균 상태로 계산하고, <b>무사고라면</b> 값을 함께 보여 줍니다.';
      return;
    }
    var h = '<b>' + esc(c['사고라벨']) + '</b> · 성능 <b>' + c['성능등급'] + '등급</b> · 감가율 <b>' + c['성능감가율'] + '%</b> · 점수 <b>' + c['성능점검점수'] + '</b>' +
      '<br>글로비스 감점 <b>' + c['글로비스_감점합'] + '</b> → 종합 <b>' + c['글로비스_종합평가점'] + '점</b> · 사고평가 <b>' + esc(c['글로비스_사고평가점']) + '</b>';
    if (S.cond === '입력') h += '<br>입력 확인: ' + esc(ISC.summary(S.items));
    h += '<br>단순수리 ' + (c['단순수리'] ? '있음' : '없음') + (c['단순수리_자동'] ? ' (자동 판정)' : '');
    el.innerHTML = h;
  }

  function parseCond() {
    var r = ISC.parseText($('condText').value);
    if (r.state === '미상') { $('condMsg').textContent = '읽을 내용이 없습니다'; return; }
    S.cond = r.state === '무사고' ? '무사고' : '입력';
    S.items = r.state === '무사고' ? [] : r.items;             // 못 읽은 표기가 있어도 읽은 부위는 반영하고, 못 읽은 것은 결과 맨 위에 경고
    VIEW.condWarn = r.unknown; VIEW.condOut = r.outside || [];
    renderInputs();
    changed();
  }

  function example() {                                      // 매물이 가장 많은 모델의 흔한 조건으로 채운다
    var mk = X.idx.makers[0], g = mk.groups.slice().sort(byN)[0];
    S = blank();
    S.mk = mk.name;
    S.grp = g.name;
    loadGroup().then(function () {
      var G = grp(), fi = G.fi, M = G.F.models.slice().sort(byN)[0], rows = modelRows(G, M.name);
      S.model = M.name;
      S.grade = countBy(rows, fi.g, G.F.grades)[0][0];
      var on = rows.filter(function (r) { return G.F.grades[r[fi.g]] === S.grade && r[fi.sold] === 0; });
      var reg = middle(on.map(function (r) { return r[fi.reg]; }));
      S.y = String(Math.floor(reg / 100));
      S.m = String(reg % 100);
      S.km = String(Math.round(median(on.map(function (r) { return r[fi.km]; })) / 1000) * 1000);
      S.color = '흰색·진주';
      S.cond = '무사고';
      renderInputs();
      changed();
    }).catch(fail);
  }

  // ───── 산정 ─────
  function changed() {
    toHash();
    clearTimeout(timer);
    timer = setTimeout(compute, 120);
  }

  // 꼭 필요한데 빈 칸 — 오른쪽 '남은 칸' 안내와 왼쪽 테두리에 같이 쓴다. 모델 요약은 세부모델까지만 있으면 된다
  function missing() {
    var out = [], open = !!S.model, km = String(S.km || '').trim();   // 등급·최초등록은 세부모델을 골라야 열린다
    function add(name, keys, on) { out.push({ name: name, keys: keys.trim().split(' '), on: on }); }
    if (!S.model) add(!S.mk ? '제조사 · 모델 · 세부모델' : !S.grp ? '모델 · 세부모델' : '세부모델', !S.mk ? 'mk' : !S.grp ? 'grp' : 'model', true);
    if (VIEW.mode === 'model') return out;
    if (!S.grade) add('등급', 'grade', open);
    if (!S.y || !S.m) add(!S.y && !S.m ? '최초등록 연·월' : !S.y ? '최초등록 연도' : '최초등록 월', (S.y ? '' : 'y ') + (S.m ? '' : 'm'), open);
    if (kmNum(km) == null) add(km ? '주행거리 — "' + km + '"를 못 읽음(예: 42000, 4.2만)' : '주행거리', 'km', true);
    return out;
  }
  function markNeed(miss) {                                  // 지금 채울 수 있는 빈 칸에 테두리
    var on = {};
    miss.forEach(function (x) { if (x.on) x.keys.forEach(function (k) { on[k] = 1; }); });
    $('inp').querySelectorAll('[data-k]').forEach(function (el) { el.classList.toggle('v2-need', !!on[el.getAttribute('data-k')]); });
    $('inp').querySelectorAll('.v2-f').forEach(function (f) { f.classList.toggle('v2-needf', !!f.querySelector('.v2-need')); });   // 칸 이름 옆 '입력 필요'
  }
  function focusNeed(k) {                                    // 남은 칸 안내를 누르면 그 입력 칸으로(아직 못 여는 칸이면 지금 채울 칸으로)
    var el = $('inp').querySelector('[data-k="' + k + '"]');
    if (!el || el.disabled) el = $('inp').querySelector('.v2-need');
    if (!el) return;
    el.scrollIntoView({ block: 'center' });                 // 바로 이동(부드러운 스크롤은 포커스와 겹치면 멈출 수 있다)
    el.focus({ preventScroll: true });
  }

  function compute() { calc(); mbar(); }

  function calc() {
    var G = grp(), miss = missing(), km = kmNum(S.km), M = G && S.model && G.models[S.model];
    markMode(VIEW.mode);                                     // 탭은 고른 그대로 — 빈 칸이 있다고 모델 요약 탭으로 넘기지 않는다
    markNeed(miss);
    R0 = null;
    if (M && (VIEW.mode === 'model' || miss.length)) { R = null; summary(G, miss); MB = miss.length ? needBar(miss) : bar('모델 요약 보기 ↓'); return; }   // 빈 칸이 남았으면 안내 + 모델 요약(참고)
    if (miss.length || !G) { R = null; guide(miss); MB = miss.length ? needBar(miss) : ''; return; }
    var c = condResult(), rate = S.rate === '' ? null : Number(S.rate);
    var car = {
      '모델': S.model, '등급': S.grade, '세부등급': S.trim, '등록연월': +S.y * 100 + +S.m, '주행km': km,
      '색상계열': S.color || null, '렌트': S.rent, '성능': c['상태'] === '미상' ? null : { '감가율': c['성능감가율'], '등급': c['성능등급'] },
      '수리비': manNum(S.cost) || 0, '연료': fuelOf(G), '팀환산': rate != null && isFinite(rate) ? rate : undefined,
      excludeIds: S.ex.map(Number)
    };
    R = ENG.estimateCar(G, car, { sold: S.sold });
    if (!R) { noComps(G); MB = bar('비교 매물 5대 미만 — 결과 보기 ↓'); return; }
    if (c['상태'] !== '미상' && S.cond === '입력' && S.items.length) {   // 같은 차가 무사고였다면 — 성능 상태가 값에 준 영향
      var c0 = ISC.evaluate({ state: '무사고', mechLevel: +S.mech });
      R0 = ENG.estimateCar(G, Object.assign({}, car, { '성능': { '감가율': c0['성능감가율'], '등급': c0['성능등급'] } }), { sold: S.sold });
    }
    var yrs = Math.floor(G.F.now_ym / 100) - Math.floor(car['등록연월'] / 100);
    var auto = ENG.conversionRate(R.est, yrs, G.F.maker, S.model, car['연료']);
    var note = $('rateNote');
    if (note) note.textContent = '자동: ' + auto.rate + '% (' + auto.source + (car['연료'] ? ' · ' + car['연료'] : '') + ')';
    LAST = { G: G, car: car, c: c };
    renderResult(G, car, c);
    MB = bar('추정 <b>' + man(R.price) + '</b>만 · 환산 <b>' + man(R.converted) + '</b>만 · 신뢰도 ' + R.grade, '결과 보기 ↓');
  }

  // 휴대폰(한 줄 배치)에서는 결과가 입력 칸 아래 멀리 있다 — 화면 아래 띠로 남은 칸이나 결과를 알리고, 누르면 그곳으로
  function bar(text, go) { return '<button type="button" data-mb="res"><span>' + text + '</span>' + (go ? '<span>' + go + '</span>' : '') + '</button>'; }
  function needBar(miss) {
    return '<button type="button" data-mb="need" data-need="' + miss[0].keys[0] + '"><span>남은 칸 · <b>' +
      esc(miss.map(function (x) { return x.name.split(' — ')[0]; }).join(' · ')) + '</b></span><span>채우기 ↑</span></button>';
  }
  function mbar() {
    var el = $('mbar');
    if (!el) return;
    var on = window.innerWidth < 1024 && !$('priceView').hidden && !$('grid').hidden && (VIEW.mode === 'one' || VIEW.mode === 'model');
    var seen = $('res').getBoundingClientRect().top < window.innerHeight - 90;
    if (!on || seen || !MB) { el.hidden = true; return; }
    if (el.innerHTML !== MB) el.innerHTML = MB;
    el.hidden = false;
  }

  function guide(miss) {
    $('res').innerHTML = miss.length ? needCard(miss) : '<div class="card"><div class="card-title">비교 매물을 불러오는 중…</div></div>';
  }
  function needCard(miss) {                                  // 남은 칸만 이름으로(누르면 그 칸으로 간다)
    return '<div class="card v2-needcard"><div class="card-title">' + (VIEW.mode === 'model' ? '모델 요약' : '한 대 산정') + '까지 남은 칸 ' +
      '<span class="hint">채우는 즉시 계산됩니다</span></div><div class="v2-needs">' + miss.map(function (x) {
        return '<button type="button" class="v2-needchip" data-need="' + x.keys[0] + '">' + esc(x.name) + '</button>';
      }).join('') + '</div>' +
      (VIEW.mode === 'model' ? '' : '<p class="v2-help">성능 상태·색상·수리비는 넣지 않아도 계산됩니다. 성능 상태를 넣지 않으면 "상태 미상"으로, 무사고 기준 값을 함께 보여 줍니다.</p>') +
      (S.model ? '' : '<div class="v2-actions"><button type="button" class="v2-btn primary" data-act="example">예시로 채워 보기</button></div>') + '</div>';
  }

  function noComps(G) {
    var M = G.models[S.model];
    $('res').innerHTML = '<div class="card"><div class="card-title">비교 매물이 5대 미만이라 산정할 수 없습니다</div>' +
      '<p class="v2-kv">' + esc(S.model) + ' 비교 매물 ' + (M ? M.n + '대(판매중 ' + M.onsale + '대)' : '없음') +
      (S.sold ? '' : ' · 최근 판매 매물을 포함하면 늘어날 수 있습니다') + (S.ex.length ? ' · 직접 뺀 매물 ' + S.ex.length + '대' : '') + '</p></div>';
  }

  // ───── 결과 ─────
  function renderResult(G, car, c) {
    var r = R, F = G.F;
    var stepNo = r.stepName.split(' ')[0], stepName = r.stepName.slice(stepNo.length + 1);
    var h = '<div class="card v2-headcard"><div class="v2-head">' + esc(F.maker + ' ' + S.model) + ' · ' + esc(S.grade + (S.trim ? ' ' + S.trim : '')) +
      '<br><span class="sub">' + S.y + '-' + pad(S.m) + ' 등록 · ' + car['주행km'].toLocaleString('ko-KR') + 'km · ' + esc(S.color || '색상 상관없음') +
      (S.rent ? ' · 렌트' : '') + ' · ' + (c['상태'] === '미상' ? '상태 미상' : esc(c['사고라벨']) + ' · 성능 ' + c['성능등급'] + '등급 · 글로비스 ' +
        c['글로비스_종합평가점'] + '점·' + esc(c['글로비스_사고평가점'])) + '</span></div>' +
      '<div class="v2-actions" style="margin:0"><button type="button" class="v2-btn" data-act="toBatch" title="이 차를 묶음 산정 목록에 한 줄로 더합니다. 단순수리·기계 결함·직접 뺀 매물·직접 넣은 환산 비율은 넘어가지 않습니다">묶음에 추가</button>' +
      '<button type="button" class="v2-btn" data-act="xlsx">엑셀 내려받기</button></div></div>';
    if (VIEW.condWarn.length) h += '<div class="notebox v2-warnbox"><b>성능 상태 중 못 읽은 표기는 계산에 넣지 않았습니다:</b> ' + esc(VIEW.condWarn.join(', ')) +
      ' — 왼쪽 성능 상태에서 고쳐 다시 읽어 주세요.' + (S.items.length ? '' : ' 읽은 부위가 없어 상태 미상으로 계산했습니다.') + '</div>';

    h += '<div class="v2-cards">';
    h += '<div class="card"><div class="eyebrow">추정 시세 · 엔카 호가 기준' + q(TIP.est) + '</div><div class="v2-big" style="margin-top:12px">' + man(r.price) + '<small>만원</small></div>' +
      '<div class="v2-kv">범위 <b>' + man(r.range[0]) + ' ~ ' + man(r.range[1]) + '</b>만 (25~75%)' +
      (r.repair ? '<br>수리비 −' + man(r.repair) + '만 반영' : '') +
      (r.est0 != null ? '<br>상태 미상 · 무사고라면 <b>' + man(r.est0 - r.repair) + '</b>만' : '') +
      (R0 ? '<br>무사고였다면 <b>' + man(R0.price) + '</b>만 · 성능 상태로 <b>' + (r.price < R0.price ? '−' : '+') + man(Math.abs(r.price - R0.price)) + '만</b>(' +
        (r.price < R0.price ? '−' : '+') + Math.abs((r.price - R0.price) / R0.price * 100).toFixed(1) + '%)' + q(TIP.cond) : '') + '</div></div>';
    h += '<div class="card"><div class="eyebrow">환산가 · 경매 예상가' + q(TIP.conv) + '</div><div class="v2-big" style="margin-top:12px">' + man(r.converted) + '<small>만원</small></div>' +
      '<div class="v2-kv">환산 비율 <b>' + r.rate + '%</b> · ' + esc(r.rateSource) + (r.repair ? '<br>수리비 −' + man(r.repair) + '만 반영' : '') + '</div></div>';
    h += '<div class="card"><div class="eyebrow">신뢰도' + q(TIP.grade) + '</div><div style="display:flex;gap:14px;align-items:center;margin-top:12px">' +
      '<span class="v2-grade ' + r.grade + '">' + r.grade + '</span><div class="v2-kv" style="margin:0">비교 매물 <b>' + r.n + '대</b> · ' +
      stepNo + '단계(' + esc(stepName) + ')' + q(TIP.step) + '<br>이상치 제외 ' + r.out + '대' +
      (S.ex.length ? ' · 직접 제외 ' + S.ex.length + '대 <button type="button" class="v2-link" data-act="exClear">모두 되돌리기</button>' : '') + '</div></div>' +
      (r.grade === 'C' ? '<div class="v2-kv">참고용 — 같은 세부모델 전체로 넓혀 찾은 값입니다</div>' : '') + '</div>';
    h += '</div>';

    h += compsTable(G);
    h += '<div class="v2-two-col">' + basisCard(G, car, c) + distCard(G) + '</div>';
    h += '<div class="v2-two-col">' + signalCard() + trendCard(G) + '</div>';
    $('res').innerHTML = h;
  }

  function compsTable(G) {
    var F = G.F, fi = G.fi, list = R.comps.map(function (x) { return { x: x }; });
    var key = VIEW.sort === 'adj' ? function (e) { return e.x.adj; } : VIEW.sort === 'price' ? function (e) { return e.x.row[fi.price]; } : null;
    if (key) list.sort(function (a, b) { return key(a) - key(b); });
    var keep = [], tail = [];                                  // 직접 뺀 매물 — 뺀 자리에 흐리게 남긴다(주소로만 온 것은 값을 몰라 끝에)
    S.ex.forEach(function (id) {
      var k = VIEW.exKeep[id];
      if (k) keep.push(k);
      else { var row = modelRows(G, S.model).find(function (r) { return String(r[fi.id]) === id; }); if (row) tail.push({ x: { row: row }, ex: true }); }
    });
    keep.filter(function (k) { return k.sort === VIEW.sort; }).sort(function (a, b) { return a.pos - b.pos; })
      .forEach(function (k) { list.splice(Math.min(k.pos, list.length), 0, { x: k.x, ex: true }); });
    keep.filter(function (k) { return k.sort !== VIEW.sort; }).forEach(function (k) {   // 정렬을 바꾼 뒤면 그 정렬에서 들어갈 자리에
      var e = { x: k.x, ex: true }, i = 0;
      if (key) while (i < list.length && key(list[i]) <= key(e)) i++; else i = list.length;
      list.splice(i, 0, e);
    });
    var shown = (VIEW.all ? list : list.slice(0, SHOW + keep.length)).concat(tail);
    var h = '<div class="card"><div class="v2-tools"><div class="card-title">① 비교 매물 <span class="hint">체크하면 그 매물을 빼고 다시 계산합니다</span></div>' +
      seg('sort', [['sim', '유사도순'], ['adj', '보정가순'], ['price', '호가순']], VIEW.sort, '정렬') + '</div>';
    h += '<div class="v2-tablewrap"><table class="t v2-tbl"><thead><tr><th>제외</th><th class="num">유사도' + q(TIP.sim) + '</th><th>등록</th><th class="num">주행</th>' +
      '<th>색상</th><th>등급</th><th>성능 (글로비스)</th><th class="num">호가' + q(TIP.price) + '</th><th class="num">보정 후' + q(TIP.adj) + '</th><th>상태</th>' +
      '<th class="num">체류' + q(TIP.dwell) + '</th><th class="num">인하' + q(TIP.cut) + '</th><th>엔카</th></tr></thead><tbody>';
    shown.forEach(function (e) { h += rowHtml(G, e); });
    h += '</tbody></table></div>';
    if (list.length > SHOW) {
      h += '<div class="v2-actions"><button type="button" class="v2-btn" data-act="more">' + (VIEW.all ? '처음 ' + SHOW + '대만 보기' : '전체 ' + list.length + '대 보기') + '</button></div>';
    }
    return h + '</div>';
  }

  function rowHtml(G, e) {
    var x = e.x, row = x.row, ex = !!e.ex, F = G.F, fi = G.fi, id = row[fi.id], sold = row[fi.sold] === 1;
    var trim = F.trims[row[fi.t]], gv = row[fi.gv], p0 = row[fi.p0], price = row[fi.price];
    var state = (ex ? '직접 제외 · ' : x.outlier ? '<span class="tag tag-soon">이상치</span> ' : '') + (sold ? '판매 ' + mmdd(row[fi.sd]) : '판매중');
    return '<tr class="' + (ex ? 'is-ex' : x.outlier ? 'is-out' : '') + '">' +
      '<td><input type="checkbox" data-ex="' + id + '"' + (ex ? ' checked' : '') + ' aria-label="이 매물 빼기"></td>' +
      '<td class="num">' + (x.sim != null ? x.sim : '–') + '</td><td>' + ym(row[fi.reg]) + '</td>' +
      '<td class="num">' + (row[fi.km] / 1e4).toFixed(1) + '만</td><td>' + esc(F.colors[row[fi.col]]) + '</td>' +
      '<td>' + esc(F.grades[row[fi.g]] + (trim ? ' ' + trim : '')) + '</td>' +
      '<td>' + row[fi.perf] + '등급' + (gv != null ? ' (' + gv + '점·감점 ' + row[fi.gp] + ')' : '') + ' · ' + esc(F.labels[row[fi.acc]]) + dmButton(G, row) + '</td>' +
      '<td class="num price">' + man(price) + '</td><td class="num">' + (x.adj != null ? '<b>' + man(x.adj) + '</b>' : '–') + '</td>' +
      '<td>' + state + '</td><td class="num">' + (x.dwell != null ? x.dwell + '일' : '–') + '</td>' +
      '<td class="num">' + (p0 != null && p0 > price ? '−' + man(p0 - price) : '–') + '</td>' +
      '<td><a href="https://fem.encar.com/cars/detail/' + id + '" target="_blank" rel="noopener">보기 ↗</a></td></tr>';
  }

  function dmButton(G, row) {                                // 손상 부위 펼치기(기획안 5.1.3 ①) — 누르면 아래에 한 줄
    var dm = ENG.damage(G, row), n = G.fi.dm != null && row[G.fi.dm] ? row[G.fi.dm].length : 0;
    return dm.length ? ' <button type="button" class="v2-dmb" data-dmt="' + esc(dm.join(' · ')) + '" aria-expanded="false">▸ 손상 ' + n + '곳</button>' : '';
  }
  function toggleDamage(b) {
    var tr = b.closest('tr'), next = tr.nextElementSibling, open = next && next.classList.contains('v2-dmrow');
    if (open) next.remove();
    else {
      var row = document.createElement('tr'), td = document.createElement('td');
      row.className = 'v2-dmrow';
      td.colSpan = tr.children.length;
      td.textContent = '손상 부위: ' + b.getAttribute('data-dmt');
      row.appendChild(td);
      tr.parentNode.insertBefore(row, tr.nextSibling);
    }
    b.setAttribute('aria-expanded', open ? 'false' : 'true');
    b.textContent = (open ? '▸' : '▾') + b.textContent.slice(1);
  }

  function basisCard(G, car, c) {
    var b = R.basis, fi = G.fi, kept = R.comps.filter(function (x) { return !x.outlier; });
    var tAge = Math.floor(G.F.now_ym / 100) * 12 + G.F.now_ym % 100 - (+S.y * 12 + +S.m);
    var dAge = tAge - mean(kept.map(function (x) { return x.age; }));
    var dKm = car['주행km'] - mean(kept.map(function (x) { return x.row[fi.km]; }));
    var deps = kept.map(function (x) { return x.row[fi.dep]; });
    var lines = [
      ['차령', b['차령'], '대상 차가 평균 ' + Math.abs(dAge).toFixed(1) + '개월 ' + (dAge >= 0 ? '더 오래됨' : '더 새것')],
      ['주행', b['주행'], '평균 ' + (Math.abs(dKm) / 1e4).toFixed(1) + '만km ' + (dKm >= 0 ? '더 탐' : '덜 탐')],
      ['성능', b['성능'], c['상태'] === '미상' ? '상태 미상 — 보정 안 함' : '감가율 대상 ' + c['성능감가율'] + '% · 비교 평균 ' + mean(deps).toFixed(1) + '%'],
      ['색상', b['색상'], S.color ? '흰색·진주 대비 계열 차이' : '색상 상관없음 — 보정 안 함'],
      ['렌트', b['렌트'], S.rent ? '대상 차가 렌트 번호판' : '렌트 번호판 비교 매물과의 차이'],
      ['등급', b['등급'], '등급·세부등급 차이'],
      ['시점', b['시점'], '판매 매물의 마지막 호가를 지금 시세로(시세지수)']
    ];
    var h = '<div class="card"><div class="card-title">② 보정 근거 <span class="hint">비교 매물 평균 · 만원</span></div><table class="v2-basis">';
    lines.forEach(function (l) {
      if (!l[1] && l[0] !== '차령' && l[0] !== '주행') return;
      h += '<tr><td>' + l[0] + '</td><td class="v">' + signed(l[1]) + '</td><td class="why">' + esc(l[2]) + '</td></tr>';
    });
    if (R.repair) h += '<tr><td>수리비</td><td class="v">−' + man(R.repair) + '</td><td class="why">입력한 예상 수리비</td></tr>';
    return h + '</table><p class="v2-help">보정 계수: ' + esc(COEF_LEVEL[R.coefLevel] || R.coefLevel) + '(매주 데이터에서 추정)</p></div>';
  }

  function niceTicks(a, z, n) {
    var span = z - a, step = Math.pow(10, Math.floor(Math.log(span / n) / Math.LN10)), e = span / n / step;
    if (e >= 7.5) step *= 10; else if (e >= 3.5) step *= 5; else if (e >= 1.5) step *= 2;
    var t = [];
    for (var v = Math.ceil(a / step) * step; v <= z; v += step) t.push(Math.round(v / step) * step);
    return t;
  }

  function distCard(G) {
    var fi = G.fi, W = 640, H = 176, L = 16, RR = 16, T = 34, B = 30, cy = (T + H - B) / 2;
    var vals = R.comps.map(function (x) { return x.adj; }).concat([R.lo, R.hi, R.est]);
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals), sp = (mx - mn) || mx * 0.1 || 1;
    var a = mn - sp * 0.05, z = mx + sp * 0.05;
    function px(v) { return L + (v - a) / (z - a) * (W - L - RR); }
    var h = '<svg class="v2-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="보정 후 비교 매물 가격 분포">';
    niceTicks(a, z, 5).forEach(function (t) {
      h += '<line x1="' + px(t) + '" x2="' + px(t) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--line)" stroke-width="1"/>' +
        '<text x="' + px(t) + '" y="' + (H - B + 18) + '" text-anchor="middle">' + man(t) + '</text>';
    });
    h += '<rect x="' + px(R.lo) + '" y="' + T + '" width="' + Math.max(px(R.hi) - px(R.lo), 1) + '" height="' + (H - B - T) + '" fill="var(--accent-wash)"/>';
    var placed = [], pts = R.comps.slice().sort(function (p, q) { return p.adj - q.adj; });
    pts.forEach(function (x) {                              // 겹치지 않게 위아래로 쌓는다(벌집형)
      var cx = px(x.adj), y = cy;
      for (var k = 1; k < 40; k++) {
        var hit = placed.some(function (p) { return Math.abs(p[0] - cx) < 11 && Math.abs(p[1] - y) < 11; });
        if (!hit) break;
        y = cy + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 11;
      }
      y = Math.max(T + 6, Math.min(H - B - 6, y));
      placed.push([cx, y]);
      var fill = x.outlier ? 'var(--tx-4)' : x.sold ? 'var(--bg-1)' : 'var(--accent)';
      var stroke = x.outlier ? 'var(--bg-1)' : x.sold ? 'var(--accent)' : 'var(--bg-1)';
      var tip = '보정 후 ' + man(x.adj) + '만\n호가 ' + man(x.row[fi.price]) + '만 · ' + ym(x.row[fi.reg]) + ' 등록 · ' +
        (x.row[fi.km] / 1e4).toFixed(1) + '만km\n유사도 ' + x.sim + ' · ' + (x.sold ? '최근 판매' : '판매중') + (x.outlier ? ' · 이상치(제외)' : '');
      h += '<circle cx="' + cx.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="5" fill="' + fill + '" stroke="' + stroke + '" stroke-width="2" data-tip="' + esc(tip) + '"/>';
    });
    var ex = px(R.est), anchor = ex < 70 ? 'start' : ex > W - 70 ? 'end' : 'middle';
    h += '<line x1="' + ex + '" x2="' + ex + '" y1="' + (T - 4) + '" y2="' + (H - B) + '" stroke="var(--tx-1)" stroke-width="2"/>' +
      '<text class="lbl" x="' + ex + '" y="' + (T - 10) + '" text-anchor="' + anchor + '">추정 ' + man(R.est) + '만' + (R.repair ? '(수리비 전)' : '') + '</text>';
    h += '</svg>';
    return '<div class="card"><div class="card-title">③ 가격 분포 <span class="hint">보정 후 가격</span></div>' +
      '<div class="v2-legend"><span><i style="background:var(--accent)"></i>판매중</span>' +
      '<span><i style="background:var(--bg-1);box-shadow:inset 0 0 0 2px var(--accent)"></i>최근 판매</span>' +
      '<span><i style="background:var(--tx-4)"></i>이상치(제외)</span>' +
      '<span><i style="background:var(--accent-wash);border-radius:2px"></i>범위 ' + man(R.lo) + '~' + man(R.hi) + '만</span></div>' + h + '</div>';
  }

  function signalCard() {
    var kept = R.comps.filter(function (x) { return !x.outlier; });
    var on = kept.filter(function (x) { return !x.sold; }), sold = kept.filter(function (x) { return x.sold; });
    var dw = median(sold.map(function (x) { return x.dwell; }).filter(function (v) { return v != null; }));
    var mOn = median(on.map(function (x) { return x.adj; })), mSold = median(sold.map(function (x) { return x.adj; }));
    var h = '<div class="card"><div class="card-title">④ 시장 신호 <span class="hint">소매 시장 기준 — 경매 수요 참고용</span></div><div class="v2-sig">' +
      '같은 조건 판매중 <b>' + on.length + '대</b>' + (S.sold ? ' · 최근 3개월 판매 <b>' + sold.length + '대</b>' : ' · 최근 판매 매물은 빼고 보는 중');
    if (dw != null) h += '<br>판매된 매물의 중위 체류일 <b>' + Math.round(dw) + '일</b>';
    if (mOn && mSold) h += '<br>판매된 매물의 보정가 중앙값은 판매중보다 <b>' + pct((mSold / mOn - 1) * 100) + '</b>';
    return h + '<br><span class="v2-help">판매 매물의 가격은 목록에서 사라지기 전 마지막 호가입니다(실제 거래가가 아님).</span></div></div>';
  }

  function trendCard(G) {
    var M = G.models[S.model], seg = (M && M.seg || '').split('·'), name = seg[1] + ' ' + seg[0];
    var pts = (X.mi.series[seg[1] + '|' + seg[0]] || []).filter(function (p) { return p['시세'] != null; });
    if (pts.length < 2) { name = seg[1] + ' 전체'; pts = (X.mi.series[seg[1] + '|전체'] || []).filter(function (p) { return p['시세'] != null; }); }
    var h = '<div class="card"><div class="card-title">⑤ 시세 추세 <span class="hint">' + esc(name) + ' 시세지수 · 7월 초 = 100</span></div>';
    if (pts.length < 2) return h + '<p class="v2-kv">추세 데이터가 아직 부족합니다.</p></div>';
    var W = 300, H = 110, L = 30, RR = 46, T = 14, B = 22;
    var vs = pts.map(function (p) { return p['시세']; }).concat([100]);
    var lo = Math.min.apply(null, vs) - 1, hi = Math.max.apply(null, vs) + 1;
    var dn = function (d) { return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5; }, d0 = dn(pts[0].date), d1 = dn(pts[pts.length - 1].date);
    function px(d) { return L + (dn(d) - d0) / ((d1 - d0) || 1) * (W - L - RR); }     // 실제 날짜 간격(시장 시황 차트와 같게)
    function py(v) { return T + (hi - v) / (hi - lo) * (H - T - B); }
    var s = '<svg class="v2-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(name) + ' 시세지수 추이">' +
      '<line x1="' + L + '" x2="' + (W - RR) + '" y1="' + py(100) + '" y2="' + py(100) + '" stroke="var(--line-hard)" stroke-width="1"/>' +
      '<text x="' + (L - 4) + '" y="' + (py(100) + 4) + '" text-anchor="end">100</text>', seg2 = [];
    pts.forEach(function (p, i) {                             // 16일 넘는 수집 공백은 옅은 선으로만 잇는다
      if (i && dn(p.date) - dn(pts[i - 1].date) > 16) {
        if (seg2.length > 1) s += '<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="' + seg2.join(' ') + '"/>';
        s += '<line x1="' + px(pts[i - 1].date).toFixed(1) + '" y1="' + py(pts[i - 1]['시세']).toFixed(1) + '" x2="' + px(p.date).toFixed(1) + '" y2="' + py(p['시세']).toFixed(1) +
          '" stroke="var(--tx-4)" stroke-width="1"/>';
        seg2 = [];
      }
      seg2.push(px(p.date).toFixed(1) + ',' + py(p['시세']).toFixed(1));
    });
    if (seg2.length > 1) s += '<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="' + seg2.join(' ') + '"/>';
    pts.forEach(function (p) {
      s += '<circle cx="' + px(p.date).toFixed(1) + '" cy="' + py(p['시세']).toFixed(1) + '" r="4" fill="var(--accent)" stroke="var(--bg-1)" stroke-width="2" data-tip="' +
        esc(p.date + '\n시세지수 ' + p['시세'] + (p.n_price ? ' · 신규 비교 ' + p.n_price.toLocaleString() + '대' : '')) + '"/>';
    });
    var last = pts[pts.length - 1];
    s += '<text class="lbl" x="' + (px(last.date) + 8) + '" y="' + (py(last['시세']) + 4) + '">' + Number(last['시세']).toFixed(1) + '</text>' +
      '<text x="' + px(pts[0].date) + '" y="' + (H - 6) + '" text-anchor="start">' + mmdd(pts[0].date) + '</text>' +
      '<text x="' + px(last.date) + '" y="' + (H - 6) + '" text-anchor="end">' + mmdd(last.date) + '</text></svg>';
    var mm = X.mmBy && X.mmBy[G.F.maker + '|' + S.model], own;                     // 이 세부모델의 신규 매물 시세(차종 비교와 같은 값)
    if (!X.mmBy) own = '세부모델 시세를 불러오는 중…';
    else if (mm && mm.pidx != null) own = '이 세부모델(' + S.model + ')만 보면 <b>' + Number(mm.pidx).toFixed(1) + '</b>(' + mmdd(X.mm.date) + ' 신규 매물, 7월 초 = 100). 차급보다 ' +
      (mm.pidx >= last['시세'] ? '<b>' + (mm.pidx - last['시세']).toFixed(1) + '</b> 높음' : '<b>' + (last['시세'] - mm.pidx).toFixed(1) + '</b> 낮음') + '.';
    else own = '이 세부모델만의 시세는 7월 초와 지금 신규 매물이 각각 10대 이상일 때 나옵니다.';
    return h + s + '<p class="v2-kv">' + own + '</p><p class="v2-help">세부모델 추이선은 매주 수집이 더 쌓이면 붙입니다.</p></div>';
  }

  // ───── 모델 요약 (5.1.5) ─────
  function modelStats(G) {
    var F = G.F, fi = G.fi, M = F.models[G.models[S.model].idx], rows = modelRows(G, S.model);   // 파일의 모델 정보(전체 판매중 포함)
    var on = rows.filter(function (r) { return r[fi.sold] === 0; }), sold = rows.filter(function (r) { return r[fi.sold] === 1; });
    var dw = median(sold.filter(function (r) { return r[fi.ds] != null && r[fi.sd]; }).map(function (r) { return days(r[fi.ds], r[fi.sd]); }));
    var cut = on.length ? on.filter(function (r) { return r[fi.p0] != null && r[fi.p0] > r[fi.price]; }).length / on.length : null;
    var gsel = !!S.grade && !VIEW.allGrades, mx = gsel ? on.filter(function (r) { return F.grades[r[fi.g]] === S.grade; }) : on;   // 시세표는 고른 등급만(전체로 바꿀 수 있음)
    var years = [];
    mx.forEach(function (r) { var y = Math.floor(r[fi.reg] / 100); if (years.indexOf(y) < 0) years.push(y); });
    years.sort(function (a, b) { return b - a; });
    var cells = years.map(function (y) {
      return KM_BANDS.map(function (b) {
        var rs = mx.filter(function (r) { return Math.floor(r[fi.reg] / 100) === y && r[fi.km] >= b[0] && r[fi.km] < b[1]; });
        return { rows: rs, n: rs.length, med: median(rs.map(function (r) { return r[fi.price]; })) };
      });
    });
    var grades = countBy(on, fi.g, F.grades).map(function (x) {
      var rs = on.filter(function (r) { return F.grades[r[fi.g]] === x[0]; });
      return { name: x[0], n: x[1], med: median(rs.map(function (r) { return r[fi.price]; })),
        year: middle(rs.map(function (r) { return Math.floor(r[fi.reg] / 100); })), km: median(rs.map(function (r) { return r[fi.km]; })),
        sold: sold.filter(function (r) { return F.grades[r[fi.g]] === x[0]; }).length };
    });
    return { M: M, on: on, sold: sold, dw: dw, cut: cut, years: years, cells: cells, grades: grades, seg: X.idx.segments[M.seg] || {}, gsel: gsel };
  }

  function tile(label, value, unit, sub) {                   // 숫자는 제목 글꼴, 단위는 본문 글꼴(작게)
    return '<div class="card"><div class="eyebrow">' + esc(label) + '</div><div class="v2-big v2-mid" style="margin-top:10px">' + esc(value) +
      (unit ? '<small>' + esc(unit) + '</small>' : '') + '</div><div class="v2-kv">' + esc(sub || '') + '</div></div>';
  }

  function summary(G, miss) {
    var st = modelStats(G), M = st.M, F = G.F;
    var h = (miss.length ? needCard(miss) : '') +
      '<div class="card v2-headcard"><div class="v2-head">' + esc(F.maker + ' ' + S.model) + ' · 모델 요약' + (miss.length ? ' <span class="v2-ref">참고</span>' : '') +
      '<br><span class="sub">비교 가능 매물 기준 · 기준 ' + dataDate() + '</span></div><button type="button" class="v2-btn" data-act="xlsxModel">엑셀 내려받기</button></div>';
    h += '<div class="v2-cards">' +
      tile('판매중', (M.onsale_all != null ? M.onsale_all : st.on.length).toLocaleString(), '대', '비교 가능(성능점검 있음) ' + st.on.length.toLocaleString() + '대') +
      tile('최근 3개월 판매', st.sold.length.toLocaleString(), '대', '목록에서 사라진 매물(재등록 제외)') +
      tile('중위 체류일', st.dw != null ? String(Math.round(st.dw)) : '–', st.dw != null ? '일' : '', st.seg.dwell != null ? '차급 평균 ' + st.seg.dwell + '일' : '') +
      tile('가격 인하 매물', st.cut != null ? (st.cut * 100).toFixed(1) : '–', st.cut != null ? '%' : '', st.seg.cut != null ? '차급 평균 ' + (st.seg.cut * 100).toFixed(1) + '%' : '') +
      tile('2주 판매율', '–', '', '주간 수집이 쌓이면 제공') + '</div>';
    h += matrixCard(st) + '<div class="v2-two-col">' + gradeCard(st) + trendCard(G) + '</div>';
    $('res').innerHTML = h;
  }

  function matrixCard(st) {
    var h = '<div class="card"><div class="v2-tools"><div class="card-title">시세표' + (st.gsel ? ' · ' + esc(S.grade) + ' 등급' : S.grade ? ' · 전체 등급' : '') +
      ' <span class="hint">판매중 호가 중앙값(만원) · 칸을 누르면 그 조건으로 한 대 산정 · 5대 미만 칸은 비움</span></div>' +
      (S.grade ? seg('mgrade', [['one', S.grade + '만'], ['all', '전체 등급']], VIEW.allGrades ? 'all' : 'one', '시세표 등급') : '') + '</div>';
    if (!st.years.length) return h + '<p class="v2-kv">판매중 매물이 없습니다.</p></div>';
    h += '<div class="v2-tablewrap"><table class="t v2-mtx"><thead><tr><th>최초등록 \\ 주행</th>' +
      KM_BANDS.map(function (b) { return '<th>' + b[2] + '</th>'; }).join('') + '<th>합계</th></tr></thead><tbody>';
    st.years.forEach(function (y, i) {
      var tot = st.cells[i].reduce(function (s, c) { return s + c.n; }, 0);
      h += '<tr><td><b>' + y + '년</b></td>' + st.cells[i].map(function (c, j) {
        return '<td>' + (c.n >= 5 ? '<button type="button" class="v2-cell" data-cell="' + i + '|' + j + '">' + man(c.med) + '<small>' + c.n + '대</small></button>'
          : '<span class="v2-na">' + (c.n ? c.n + '대' : '') + '</span>') + '</td>';
      }).join('') + '<td>' + tot + '대</td></tr>';
    });
    return h + '</tbody></table></div></div>';
  }

  function gradeCard(st) {
    var h = '<div class="card"><div class="card-title">등급별 <span class="hint">판매중 기준 · 등급을 누르면 그 등급으로 바꿉니다</span></div>' +
      '<div class="v2-tablewrap"><table class="t v2-tbl v2-gtbl"><thead><tr><th>등급</th><th class="num">판매중</th><th class="num">중앙 호가</th>' +
      '<th class="num">중위 연식</th><th class="num">중위 주행</th><th class="num">최근 판매</th></tr></thead><tbody>';
    st.grades.slice(0, 20).forEach(function (g) {
      h += '<tr><td><button type="button" class="v2-link" data-grade="' + esc(g.name) + '">' + esc(g.name) + '</button></td><td class="num">' + g.n +
        '</td><td class="num">' + man(g.med) + '</td><td class="num">' + g.year + '</td><td class="num">' + (g.km / 1e4).toFixed(1) + '만</td><td class="num">' + g.sold + '</td></tr>';
    });
    h += '</tbody></table></div>';
    if (st.grades.length > 20) h += '<p class="v2-help">판매중이 많은 20개 등급만 보여 줍니다(엑셀에는 전체).</p>';
    return h + '<p class="v2-help">2주 판매율은 주간 수집이 쌓이면 붙입니다.</p></div>';
  }

  function fillFromCell(i, j) {                              // 시세표 칸 → 한 대 산정 입력
    var G = grp(), st = modelStats(G), fi = G.fi, cell = st.cells[i][j];
    var reg = middle(cell.rows.map(function (r) { return r[fi.reg]; }));
    S.y = String(st.years[i]);
    S.m = String(reg % 100);
    S.km = String(Math.round(median(cell.rows.map(function (r) { return r[fi.km]; })) / 1000) * 1000);
    if (!S.grade) S.grade = countBy(cell.rows, fi.g, G.F.grades)[0][0];
    VIEW.mode = 'one';
    renderInputs();
    changed();
  }

  // ───── 엑셀 내려받기 ─────
  function exportOne() {
    if (!R || !LAST) return;
    var G = LAST.G, car = LAST.car, c = LAST.c, F = G.F, fi = G.fi;
    var sec = function (t) { return [{ v: t, bold: true }, null]; }, mw = function (v) { return { v: Math.round(v), money: true }; };
    var rows = [['항목', '값'], sec('대상 차'), ['제조사', F.maker], ['모델', S.grp], ['세부모델', S.model], ['등급', S.grade],
      ['세부등급', S.trim || '상관없음'], ['최초등록', S.y + '-' + pad(S.m)], ['주행(km)', { v: car['주행km'], money: true }],
      ['색상', S.color || '상관없음'], ['렌트 번호판', S.rent ? '예' : '아니오'], ['연료(이 모델·등급에서 추정)', car['연료'] || ''],
      sec('성능 상태'), ['상태', S.cond === '입력' ? '기록부 입력' : S.cond]];
    if (c['상태'] !== '미상') {
      rows.push(['사고 라벨', c['사고라벨']], ['성능등급', c['성능등급']], ['성능감가율(%)', c['성능감가율']], ['성능점검점수', c['성능점검점수']],
        ['글로비스 감점합', c['글로비스_감점합']], ['글로비스 종합평가점', c['글로비스_종합평가점']], ['글로비스 사고평가점', c['글로비스_사고평가점']],
        ['단순수리', c['단순수리'] ? '있음' : '없음']);
      if (S.cond === '입력') rows.push(['입력 부위', S.items.length ? ISC.summary(S.items) : '없음(상태 미상으로 계산)']);
      if (VIEW.condWarn.length) rows.push(['못 읽은 표기(계산에 넣지 않음)', VIEW.condWarn.join(', ')]);
    }
    rows.push(['기계 결함', ['없음', '경미', '결함'][+S.mech]], ['수리 필요', S.fixes.join(', ') || '없음'], ['예상 수리비(만원)', mw(R.repair)],
      sec('결과'), ['추정 시세(만원, 수리비 반영)', mw(R.price)], ['범위 하한(만원)', mw(R.range[0])], ['범위 상한(만원)', mw(R.range[1])]);
    if (R.est0 != null) rows.push(['상태 미상 · 무사고라면(만원)', mw(R.est0 - R.repair)]);
    rows.push(['환산 비율(%)', R.rate], ['환산 비율 출처', R.rateSource], ['환산가(만원)', mw(R.converted)], ['신뢰도', R.grade],
      ['비교 매물(대)', R.n], ['매칭 단계', R.stepName], ['이상치 제외(대)', R.out], ['직접 제외(대)', S.ex.length], sec('보정 근거(만원, 비교 매물 평균)'));
    ['차령', '주행', '성능', '색상', '렌트', '등급', '시점'].forEach(function (k) { rows.push([k, R.basis[k]]); });
    rows.push(['보정 계수 수준', R.coefLevel], sec('산정 기준'),
      ['데이터 기준', '엔카 ' + dataDate(true)],
      ['비교 매물 파일', F.version], ['보정 계수', X.coef.version], ['환산 비율', RatesStore.label(X.rates)],
      ['비교 범위', S.sold ? '판매중 + 최근 3개월 판매' : '판매중만'], ['산정 화면 주소', location.href],
      ['참고', '추정 시세는 엔카 호가 기준. 환산가는 팀 환산 비율(도·소매 갭 요약치)을 적용한 값']);
    var cr = [['유사도', '매물ID', '상태', '판매 확인일', '최초등록', '주행(km)', '색상', '등급', '세부등급', '연료', '성능등급', '사고 라벨', '손상 부위',
      '글로비스 종합', '글로비스 감점', '호가(만원)', '보정 후(만원)', '첫 호가(만원)', '인하(만원)', '체류일', '이상치', '직접 제외', '엔카 링크']];
    function line(row, x) {
      var p0 = row[fi.p0], price = row[fi.price], sold = row[fi.sold] === 1, reg = String(row[fi.reg]);
      return [x ? x.sim : null, row[fi.id], sold ? '판매' : '판매중', sold ? row[fi.sd] : null, reg.slice(0, 4) + '-' + reg.slice(4, 6), row[fi.km],
        F.colors[row[fi.col]], F.grades[row[fi.g]], F.trims[row[fi.t]] || null, F.fuels ? F.fuels[row[fi.fu]] : null, row[fi.perf], F.labels[row[fi.acc]],
        ENG.damage(G, row).join(' · ') || null,
        row[fi.gv], row[fi.gp], price, x ? Math.round(x.adj) : null, p0, p0 != null && p0 > price ? p0 - price : null,
        x && x.dwell != null ? x.dwell : null, x && x.outlier ? '예' : null, x ? null : '예', 'https://fem.encar.com/cars/detail/' + row[fi.id]];
    }
    R.comps.forEach(function (x) { cr.push(line(x.row, x)); });
    modelRows(G, S.model).filter(function (r) { return S.ex.indexOf(String(r[fi.id])) >= 0; }).forEach(function (r) { cr.push(line(r, null)); });
    XlsxWriter.download(fileSafe('시세산정_' + S.model + '_' + S.grade + '_' + today()) + '.xlsx', [
      { name: '산정 결과', rows: rows, header: true, widths: [32, 64] },
      { name: '비교 매물', rows: cr, header: true, freeze: true, money: [5, 15, 16, 17, 18],
        widths: [7, 11, 7, 11, 9, 10, 9, 18, 14, 8, 8, 12, 34, 10, 10, 10, 11, 11, 9, 7, 7, 8, 42] }]);
  }

  function exportModel() {
    var G = grp();
    if (!G || !S.model) return;
    var st = modelStats(G), F = G.F;
    var info = [['항목', '값'], ['모델', F.maker + ' ' + S.model], ['판매중(전체)', st.M.onsale_all], ['판매중(비교 가능)', st.on.length],
      ['최근 3개월 판매', st.sold.length], ['중위 체류일', st.dw != null ? Math.round(st.dw) : null], ['차급 평균 체류일', st.seg.dwell],
      ['가격 인하 매물 비율(%)', st.cut != null ? +(st.cut * 100).toFixed(1) : null], ['차급 평균 가격 인하 비율(%)', st.seg.cut != null ? +(st.seg.cut * 100).toFixed(1) : null],
      ['데이터 기준', '엔카 ' + dataDate(true)], ['비교 매물 파일', F.version], ['참고', '판매중 호가 기준. 시세표 칸은 5대 미만이면 비움']];
    var mx = [['최초등록 \\ 주행'].concat(KM_BANDS.map(function (b) { return b[2] + ' 중앙 호가'; }), KM_BANDS.map(function (b) { return b[2] + ' 대수'; }))];
    st.years.forEach(function (y, i) {
      mx.push([y + '년'].concat(st.cells[i].map(function (c) { return c.n >= 5 ? Math.round(c.med) : null; }), st.cells[i].map(function (c) { return c.n; })));
    });
    var gr = [['등급', '판매중', '중앙 호가(만원)', '중위 연식', '중위 주행(km)', '최근 3개월 판매']].concat(st.grades.map(function (g) {
      return [g.name, g.n, Math.round(g.med), g.year, Math.round(g.km), g.sold];
    }));
    XlsxWriter.download(fileSafe('모델요약_' + S.model + '_' + today()) + '.xlsx', [
      { name: '핵심 숫자', rows: info, header: true, widths: [28, 40] },
      { name: '시세표', rows: mx, header: true, freeze: true, money: [1, 2, 3, 4, 5], widths: [16, 16, 14, 15, 16, 16, 10, 10, 10, 10, 10] },
      { name: '등급별', rows: gr, header: true, freeze: true, money: [2, 4], widths: [30, 9, 15, 10, 14, 15] }]);
  }

  // ───── 화면 틀 · 이벤트 ─────
  function marketLine() {
    var pts = X.mi.series['전체|전체'] || [], last = null, crawls = X.mi.crawls || [];
    for (var i = pts.length - 1; i >= 0; i--) if (pts[i]['시세'] != null) { last = pts[i]; break; }
    var asOf = crawls.length ? crawls[crawls.length - 1].date : '';
    $('asOf').textContent = asOf ? '데이터 기준 ' + dataDate(true) : '—';
    if (!last) return;
    var f1 = function (v) { return Number(v).toFixed(1); };
    var h = '<span class="eyebrow">시장 · 7월 초 = 100</span><span>시세지수 <b>' + f1(last['시세']) + '</b></span>';
    if (last['재고'] != null) h += '<span>재고지수 <b>' + f1(last['재고']) + '</b></span>';
    h += last['시황'] != null ? '<span>시황지수 <b>' + f1(last['시황']) + '</b> ' + esc(last.label || '') + '</span>'
      : '<span>시황지수 — <span style="color:var(--tx-3)">판매속도가 생기는 다음 수집부터</span></span>';
    h += '<span style="color:var(--tx-3)">기준 ' + mmdd(last.date) + ' 목록</span><a class="v2-mlink" href="#/market">시장 시황 보기 →</a>';
    $('marketLine').innerHTML = '<div>' + h + '</div>';
  }

  function batch() {                                         // 묶음 산정(batch.js) — 처음 쓸 때 만든다(묶음에 추가도 여기로)
    if (!B) {
      B = V2Batch.create({ X: X, ENG: ENG, ISC: ISC, GROUPS: GROUPS, getJSON: getJSON, esc: esc, man: man, pad: pad, today: today,
        fileSafe: fileSafe, tile: tile, href: function (s) { return query(Object.assign(blank(), s), 'one'); } });
    }
    return B;
  }
  function addToBatch(btn) {                                 // 한 대 산정 → 묶음 산정 목록(기획안 6장)
    var n = batch().addCar({ name: S.mk + ' ' + S.model + ' ' + S.grade + (S.trim ? ' ' + S.trim : ''), reg: S.y + '-' + pad(S.m), year: S.y,
      km: S.km, color: S.color, cost: S.cost, rent: S.rent,
      cond: S.cond === '미상' || !S.items.length && S.cond === '입력' ? '' : S.cond === '무사고' ? '무사고' : ISC.toText(S.items) });
    btn.outerHTML = '<button type="button" class="v2-btn" data-act="openBatch">묶음 산정 열기 · ' + n + '대</button>';
  }

  function markMode(v) {
    document.querySelectorAll('button[data-seg="mode"]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === v); });
  }
  function applyMode() {                                     // 묶음 산정·환산 비율은 입력·결과 대신 각자의 화면
    var m = VIEW.mode;
    $('grid').hidden = m === 'batch' || m === 'rates';
    $('batch').hidden = m !== 'batch';
    $('ratesView').hidden = m !== 'rates';
    if (m === 'batch') {
      markMode('batch');
      batch().show($('batch'));
    } else if (m === 'rates') {
      markMode('rates');
      if (!RV) RV = V2Rates.create({ X: X, ENG: ENG, esc: esc, man: man, store: X.store, changed: function () {} });   // 한 대 산정은 돌아갈 때 다시 계산
      RV.show($('ratesView'));
    } else compute();
  }

  // ───── 화면 고르기: #/market = 시장 시황(market.js) · #/data = 데이터(data.js) · 그 밖 = 시세 산정 ─────
  function route() {
    var h0 = location.hash, page = h0.indexOf('#/market') === 0 ? 'market' : h0.indexOf('#/data') === 0 ? 'data' : 'price', market = page === 'market';
    $('priceView').hidden = page !== 'price';
    $('mbar').hidden = true;
    $('marketView').hidden = page !== 'market';
    $('dataView').hidden = page !== 'data';
    $('navPrice').classList.toggle('on', page === 'price');
    $('navMarket').classList.toggle('on', page === 'market');
    $('navData').classList.toggle('on', page === 'data');
    if (page === 'data') {
      if (!DV) DV = V2Data.create({ X: X, esc: esc, getJSON: getJSON, root: ROOT });
      DV.show($('dataView'));
      return Promise.resolve();
    }
    if (market) {
      if (!MK) {
        MK = V2Market.create({ X: X, esc: esc, man: man, getJSON: getJSON, fileSafe: fileSafe, today: today,
          href: function (s, mode) { return query(Object.assign(blank(), s), mode || 'one'); },
          hash: function (st) {                              // 시장 시황 상태도 주소에(공유·새로 고침)
            var q = new URLSearchParams();
            if (st.o !== '전체') q.set('o', st.o);
            if (st.s !== '전체') q.set('s', st.s);
            if (st.range !== 'all') q.set('range', st.range);
            if (st.sort !== 'on' || st.dir !== -1) { q.set('sort', st.sort); q.set('dir', st.dir > 0 ? '1' : '-1'); }
            var str = q.toString();
            history.replaceState(null, '', '#/market' + (str ? '?' + str : ''));
            $('navMarket').setAttribute('href', '#/market' + (str ? '?' + str : ''));   // 시세 산정에 갔다 와도 보던 그대로
          } });
      }
      var h = location.hash, i = h.indexOf('?');
      MK.show($('marketView'), new URLSearchParams(i >= 0 ? h.slice(i + 1) : ''));
      return Promise.resolve();
    }
    S = fromHash();
    $('navPrice').setAttribute('href', location.hash || '#/price');
    renderInputs();
    return loadGroup().then(function () { renderInputs(); applyMode(); });
  }

  function layout() {
    $('app').innerHTML = '<div id="priceView"><div class="v2-mode">' + seg('mode', [['one', '한 대 산정'], ['model', '모델 요약'], ['batch', '묶음 산정'], ['rates', '⚙ 환산 비율']], VIEW.mode, '산정 방식') + '</div>' +
      '<div class="v2-grid" id="grid"><aside class="card v2-input" id="inp" aria-label="대상 차 조건"></aside><section class="v2-result" id="res" aria-live="polite"></section></div>' +
      '<section class="v2-batch" id="batch" aria-label="묶음 산정" hidden></section>' +
      '<section class="v2-batch v2-rates" id="ratesView" aria-label="환산 비율 설정" hidden></section>' +
      '<div class="v2-mbar" id="mbar" hidden></div></div>' +
      '<section class="v2-batch v2-mk" id="marketView" aria-label="시장 시황" hidden></section>' +
      '<section class="v2-batch" id="dataView" aria-label="데이터" hidden></section>';
    var inp = $('inp'), res = $('res'), tip = $('tip');
    inp.addEventListener('change', function (e) {
      var t = e.target, k = t.getAttribute('data-k');
      if (!k) return;
      if (k === 'rent' || k === 'sold') { S[k] = t.checked; changed(); return; }
      if (k === 'km' || k === 'cost' || k === 'rate') { S[k] = t.value; changed(); return; }
      if (k === 'pos') { setPos(+t.getAttribute('data-i'), t.value); renderInputs(); changed(); return; }
      S[k] = t.value;
      if (k === 'mk') { S.grp = ''; S.model = ''; S.grade = ''; S.trim = ''; S.ex = []; }
      if (k === 'grp') { S.model = ''; S.grade = ''; S.trim = ''; S.ex = []; }
      if (k === 'model') { S.grade = ''; S.trim = ''; S.ex = []; }
      if (k === 'grade') { S.trim = ''; S.ex = []; }
      renderInputs();
      if (k === 'grp') { loadGroup().then(function () { renderInputs(); changed(); }).catch(fail); return; }
      changed();
    });
    inp.addEventListener('input', function (e) {
      var k = e.target.getAttribute('data-k');
      if (k === 'km' || k === 'cost' || k === 'rate') { S[k] = e.target.value; changed(); }
    });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.id === 'condText') { e.preventDefault(); parseCond(); } });
    function clicks(e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-need')) { focusNeed(b.getAttribute('data-need')); return; }
      var k = b.getAttribute('data-seg'), chipK = b.getAttribute('data-chip'), act = b.getAttribute('data-act'), v = b.getAttribute('data-v');
      if (k === 'sort') { VIEW.sort = v; compute(); return; }
      if (k === 'mode') { VIEW.mode = v; toHash(); applyMode(); return; }
      if (k === 'mgrade') { VIEW.allGrades = v === 'all'; compute(); return; }
      if (act === 'exClear') { S.ex = []; VIEW.exKeep = {}; changed(); return; }
      if (act === 'xlsx') { exportOne(); return; }
      if (b.hasAttribute('data-dmt')) { toggleDamage(b); return; }
      if (act === 'toBatch') { addToBatch(b); return; }
      if (act === 'openBatch') { VIEW.mode = 'batch'; toHash(); applyMode(); window.scrollTo(0, 0); return; }
      if (act === 'xlsxModel') { exportModel(); return; }
      var cell = b.getAttribute('data-cell'), gname = b.getAttribute('data-grade');
      if (cell) { fillFromCell(+cell.split('|')[0], +cell.split('|')[1]); return; }
      if (gname != null) { S.grade = gname; S.trim = ''; S.ex = []; renderInputs(); changed(); return; }
      if (k) { S[k] = v; if (k === 'cond') { VIEW.condWarn = []; VIEW.condOut = []; } renderInputs(); changed(); return; }
      if (chipK === 'color') { S.color = v; renderInputs(); changed(); return; }
      if (chipK === 'fix') { toggle(S.fixes, v); renderInputs(); changed(); return; }
      if (act === 'parse') { parseCond(); return; }
      if (act === 'clearExtra') { S.items = S.items.filter(posIndex); renderInputs(); changed(); return; }
      if (act === 'reset') { S = blank(); VIEW.all = false; VIEW.condWarn = []; VIEW.condOut = []; renderInputs(); changed(); return; }
      if (act === 'example') { example(); return; }
      if (act === 'more') { VIEW.all = !VIEW.all; compute(); return; }
      if (act === 'share') {
        var done = function () { b.textContent = '복사됨'; setTimeout(function () { b.textContent = '링크 복사'; }, 1500); };
        if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, function () { prompt('이 주소를 복사하세요', location.href); });
        else prompt('이 주소를 복사하세요', location.href);
      }
    }
    $('app').querySelector('.v2-mode').addEventListener('click', clicks);
    inp.addEventListener('click', clicks);
    res.addEventListener('click', clicks);
    res.addEventListener('change', function (e) {
      var id = e.target.getAttribute('data-ex');
      if (!id) return;
      if (S.ex.indexOf(id) < 0) {                              // 뺄 때 값과 자리를 기억 → 표에서 그 자리에 흐리게 남는다
        var fi = grp().fi, x = R && R.comps.find(function (c) { return String(c.row[fi.id]) === id; });
        var trs = [].slice.call(e.target.closest('tbody').children).filter(function (tr) { return !tr.classList.contains('v2-dmrow'); });
        if (x) VIEW.exKeep[id] = { x: x, pos: trs.indexOf(e.target.closest('tr')), sort: VIEW.sort };
      } else delete VIEW.exKeep[id];
      toggle(S.ex, id);
      changed();
    });
    res.addEventListener('mouseover', function (e) {
      var t = e.target.getAttribute && e.target.getAttribute('data-tip');
      if (!t) return;
      tip.textContent = t;
      tip.hidden = false;
    });
    res.addEventListener('mousemove', function (e) {
      if (tip.hidden) return;
      var x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
      tip.style.left = x + 'px';
      tip.style.top = (e.clientY + 14) + 'px';
    });
    res.addEventListener('mouseout', function (e) { if (e.target.getAttribute && e.target.getAttribute('data-tip')) tip.hidden = true; });
    res.addEventListener('focusin', function (e) {             // 키보드·휴대폰(누르면 포커스): ? 아래에 설명
      var t = e.target.getAttribute && e.target.getAttribute('data-tip');
      if (!t) return;
      var b = e.target.getBoundingClientRect();
      tip.textContent = t;
      tip.hidden = false;
      tip.style.left = Math.max(8, Math.min(b.left, window.innerWidth - tip.offsetWidth - 8)) + 'px';
      tip.style.top = (b.bottom + 6) + 'px';
    });
    res.addEventListener('focusout', function (e) { if (e.target.getAttribute && e.target.getAttribute('data-tip')) tip.hidden = true; });
    $('mbar').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.getAttribute('data-mb') === 'need') { focusNeed(b.getAttribute('data-need')); return; }
      window.scrollTo(0, $('res').getBoundingClientRect().top + window.pageYOffset - 64);
    });
    window.addEventListener('scroll', mbar, { passive: true });
    window.addEventListener('resize', mbar);
    window.addEventListener('hashchange', function () { route().catch(fail); });
  }

  function fail(err) {
    console.error(err);
    $('app').innerHTML = '<div class="alert">데이터를 불러오지 못했습니다: ' + esc(err && err.message || err) + '</div>';
  }

  function boot() {
    Promise.all(['comps/index.json', 'adj_coef.json', 'conversion_rates.json', 'inspection_model.json', 'market_index.json'].map(getJSON)
      .concat([RatesStore.load('/api/rates')]))                // 환산 비율 팀 수정(저장소가 없으면 초기값만)
      .then(function (a) {
        X.idx = a[0]; X.coef = a[1]; X.rates = a[2]; X.model = a[3]; X.mi = a[4]; X.store = a[5];
        RatesStore.apply(X.rates, X.store.team);
        X.yr = {};                                             // 세부모델 연식 범위(목록에 '(2019~2022)')
        X.idx.makers.forEach(function (mk) { mk.groups.forEach(function (g) { g.models.forEach(function (m) {
          if (m.y0 && m.y1) X.yr[mk.name + '|' + g.name + '|' + m.name] = m.y0 === m.y1 ? String(m.y0) : m.y0 + '~' + m.y1;
        }); }); });
        ENG = PriceEngine.create({ config: X.idx.engine, coef: X.coef, rates: X.rates });
        ISC = InspectionScore.create(X.model);
        S = fromHash();
        layout();
        marketLine();
        getJSON('market_models.json').then(function (j) {    // 세부모델 시세(⑤ 추세 한 줄) — 늦게 와도 되므로 따로
          X.mm = j; X.mmBy = {};
          j.models.forEach(function (m) { X.mmBy[m.maker + '|' + m.model] = m; });
          if (!$('priceView').hidden && (VIEW.mode === 'one' || VIEW.mode === 'model') && S.model) compute();
        }).catch(function () { X.mmBy = {}; });
        return route();
      })
      .catch(fail);
  }

  boot();
})();
