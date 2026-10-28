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
  var SHOW = 10;                                            // 비교 매물 표 기본 행 수(인터뷰 Q40 — 그림 먼저, 표는 10행 + 펼치기)
  var KM_BANDS = [[0, 3e4, '3만 미만'], [3e4, 6e4, '3~6만'], [6e4, 1e5, '6~10만'], [1e5, 1.5e5, '10~15만'], [1.5e5, Infinity, '15만 이상']];
  var X = {}, ENG = null, ISC = null, NM = null, GROUPS = {}, R = null, R0 = null, recentTimer = 0, LAST = null, timer = 0, B = null, RV = null, MK = null, DV = null, MB = '';
  var VIEW = { sort: 'sim', all: false, mode: 'one', condWarn: [], condOut: [], exKeep: {}, allGrades: false, nameText: '', nameMsg: '', nameCands: [], recentOpen: false,
    posx: 'km', hl: null };                                  // posx: 내 차 위치 그림 가로축(km·age) · hl: 그림에서 누른 비교 매물 ID      // mode: one(한 대 산정) · model(모델 요약) · batch(묶음 산정) · rates(⚙ 환산 비율)
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
    cut: '첫 호가보다 내린 금액',
    pos: '점은 비교 매물의 실제 호가입니다(판매된 매물은 목록에서 사라지기 전 마지막 호가). 별은 이 차의 추정 시세, 세로 띠는 추정 범위(25~75%)입니다. ' +
      '점선은 이 차와 다른 조건이 같고 주행(또는 연식)만 다를 때의 값으로, 매주 데이터에서 추정한 보정 계수로 그립니다. 점을 누르면 아래 표의 그 매물로 갑니다.',
    speed: '차급 대비는 이 세부모델과 같은 차급(국산·수입 구분) 전체의 주간 판매율을 비교합니다(±15% 안이면 비슷). 가격 위치별 일수는 최근 3개월에 판매된 비교 매물을 ' +
      '이 차 조건으로 맞춘 값(보정가)이 추정가보다 얼마나 쌌는지·비쌌는지로 나눠, 엔카에 올라온 뒤 목록에서 사라지기까지 걸린 날수의 가운데 값을 보여 줍니다. 판매자가 내린 매물도 섞일 수 있습니다.',
    ladder: '같은 세부모델 안에서 연식·주행, 등급, 성능 상태에 따라 값이 어떻게 달라지는지 봅니다. 시세표와 등급별은 판매중 매물의 호가 가운데 값이고, ' +
      '성능 상태별은 매물을 이 차 조건으로 맞춘 뒤 사고 단계끼리 비교한 값입니다(사고 차 매각가를 잡을 때 참고).',
    flow: '비교 매물 호가의 가운데 값에서 출발해 조건 차이를 맞추는 보정(비교 매물 평균)을 더하면 추정 시세가 됩니다. "나머지"는 가운데 값끼리의 차이로, ' +
      '매물마다 보정이 달라서 생깁니다. 환산가는 추정 시세에 환산 비율을 적용한 경매 예상가입니다.',
    trend: '시세지수는 그 회차에 새로 올라온 매물(등록 7일 이내)의 첫 호가를 7월 초(7/1~7/15) 같은 모델·등급 매물과 비교한 값입니다. 차령·주행·색상·성능을 맞추므로 ' +
      '시간에 따른 자연 감가는 빠집니다(100보다 낮으면 같은 조건의 차가 7월 초보다 싸게 나온다는 뜻). 세부모델 점은 신규 매물 10대 이상인 회차만 찍고, 옅은 띠는 표본 수로 생기는 ' +
      '흔들림(95%)입니다. 방향은 최근 4주 기울기가 흔들림의 2배를 넘을 때만 오름·내림으로 씁니다. 회색 점선은 같은 차급(국산·수입 구분) 전체입니다.'
  };
  var DOM_ORDER = ['현대', '제네시스', '기아', '쉐보레(GM대우)', '르노코리아(삼성)', 'KG모빌리티(쌍용)', '기타 제조사'];   // 엔카 국산 제조사 순서
  var RECENT = 'v2.recent';                                  // 최근 산정(이 브라우저에만)
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
  function yrN(name) { return X.yrN && X.yrN[S.mk + '|' + S.grp + '|' + name]; }     // [첫해, 끝해]
  function fitScore(name) {                                  // 등록 연도와 세대 기간: 2 = 기간 안 · 1 = ±1년(또는 연도·기간을 모름) · 0 = 밖
    var r = yrN(name), y = +S.y;
    return !S.y || !r ? 1 : y >= r[0] && y <= r[1] ? 2 : y >= r[0] - 1 && y <= r[1] + 1 ? 1 : 0;
  }
  function fits(name) { return fitScore(name) > 0; }
  function regText() { return S.m ? S.y + '-' + pad(S.m) : S.y + '년(월 미상 · 6월로 계산)'; }
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
  function opt(v, label, cur, dis) {
    return '<option value="' + esc(v) + '"' + (String(v) === String(cur) ? ' selected' : '') + (dis ? ' disabled' : '') + '>' + esc(label) + '</option>';
  }
  function sel(k, opts, cur, off) {
    return '<select class="filter-select" data-k="' + k + '"' + (off ? ' disabled' : '') + '>' +
      opts.map(function (o) { return opt(o[0], o[1], cur, o[2]); }).join('') + '</select>';
  }
  function selG(k, first, groups, cur, off) {                // 묶음(optgroup)이 있는 선택 상자 — first = [값, 글] 맨 위 한 줄
    return '<select class="filter-select" data-k="' + k + '"' + (off ? ' disabled' : '') + '>' + opt(first[0], first[1], cur) +
      groups.filter(function (g) { return g.opts.length; }).map(function (g) {
        return '<optgroup label="' + esc(g.label) + '">' + g.opts.map(function (o) { return opt(o[0], o[1], cur); }).join('') + '</optgroup>';
      }).join('') + '</select>';
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
    h += '<div class="v2-namefind"><div class="v2-text"><input class="v2-in" id="nameText" autocomplete="off" placeholder="차명으로 찾기 — 예: 더 뉴 그랜저 IG 2.5 프리미엄 2020" value="' +
      esc(VIEW.nameText) + '"><button type="button" class="v2-btn" data-act="findName">찾기</button></div>' +
      '<div class="v2-nmsg" id="nameMsg">' + (VIEW.nameMsg || '아래 다섯 칸을 차명 한 줄로 한 번에 채웁니다(연도를 적으면 등록 연도도)') + '</div></div>';
    h += recentHtml() + chipsHtml();
    var mlab = function (m) { return [m.name, m.name + ' · ' + total(m).toLocaleString() + '대']; };
    var dom = X.idx.makers.filter(function (m) { return m.origin === '국산'; })
      .sort(function (a, b) { return DOM_ORDER.indexOf(a.name) - DOM_ORDER.indexOf(b.name); });
    var imp = X.idx.makers.filter(function (m) { return m.origin !== '국산'; }).sort(function (a, b) { return total(b) - total(a); });
    h += field('제조사', selG('mk', ['', '제조사 선택'], [{ label: '국산', opts: dom.map(mlab) }, { label: '수입 · 많은 순', opts: imp.slice(0, 8).map(mlab) },
      { label: '수입 · 가나다순', opts: imp.slice(8).sort(function (a, b) { return a.name.localeCompare(b.name, 'ko'); }).map(mlab) }], S.mk));
    h += field('모델', sel('grp', [['', mk ? '모델 선택' : '—']].concat((mk ? mk.groups.slice().sort(byN) : []).map(function (x) {
      return [x.name, x.name + ' · ' + x.n.toLocaleString() + '대'];
    })), S.grp, !mk));
    var mopts = [];
    if (G) {                                                   // 최신 세대부터(같으면 매물 많은 순) — 등록 연도를 넣었으면 맞는 세대가 위로, 안 맞는 세대는 구분선 아래
      var ms = G.F.models.slice().sort(function (a, b) {
        var ra = yrN(a.name) || [0, 0], rb = yrN(b.name) || [0, 0];
        return (fitScore(b.name) - fitScore(a.name)) || (rb[1] - ra[1]) || (rb[0] - ra[0]) || (b.n - a.n);
      });
      ms.forEach(function (x) {
        if (S.y && !fits(x.name) && mopts.length && fits(mopts[mopts.length - 1][0])) mopts.push(['-', '── 등록 ' + S.y + '년과 안 맞는 세대 ──', true]);
        mopts.push([x.name, x.name + yrOf(S.mk, S.grp, x.name) + ' · ' + x.n.toLocaleString() + '대']);
      });
    }
    h += field('세부모델', sel('model', [['', G ? '세부모델 선택' : (g ? '불러오는 중…' : '—')]].concat(mopts), S.model, !G) +
      (S.model && S.y && !fits(S.model) ? '<p class="v2-help v2-bad">등록 ' + S.y + '년은 이 세대' + yrOf(S.mk, S.grp, S.model) +
        ' 기간 밖입니다 — 다른 세대인지 확인하세요</p>' : ''));
    var grades = rows.length ? countBy(rows, fi.g, G.F.grades) : [], gfuel = gradeFuel(G, rows), fuels = [];
    grades.forEach(function (x) { var f = gfuel[x[0]] || '기타'; if (fuels.indexOf(f) < 0) fuels.push(f); });
    var glab = function (x) { return [x[0], x[0] + ' · ' + x[1].toLocaleString() + '대']; };
    h += field('등급', fuels.length > 1                       // 연료가 둘 이상이면 연료로 묶는다(엔카처럼) — 많은 연료부터
      ? selG('grade', ['', '등급 선택'], fuels.map(function (f) {
        return { label: f, opts: grades.filter(function (x) { return (gfuel[x[0]] || '기타') === f; }).map(glab) };
      }), S.grade, !S.model)
      : sel('grade', [['', S.model ? '등급 선택' : '—']].concat(grades.map(glab)), S.grade, !S.model));
    var trims = S.grade && rows.length ? countBy(rows.filter(function (r) { return G.F.grades[r[fi.g]] === S.grade; }), fi.t, G.F.trims)
      .filter(function (x) { return x[0]; }) : [];                // 주소로 열 때는 모델그룹 파일을 받기 전에도 그린다
    h += field('세부등급<em>선택</em>', sel('trim', [['', trims.length ? '상관없음' : '—']].concat(trims.map(function (x) {
      return [x[0], x[0] + ' · ' + x[1].toLocaleString() + '대'];
    })), S.trim, !trims.length));
    var years = [];                                            // 세부모델 전이면 모델그룹 전체 연도 — 연도를 먼저 넣으면 맞는 세대가 위로 온다
    (rows.length ? rows : G ? G.F.rows : []).forEach(function (r) { var y = Math.floor(r[fi.reg] / 100); if (years.indexOf(y) < 0) years.push(y); });
    if (S.y && years.indexOf(+S.y) < 0) years.push(+S.y);
    years.sort(function (a, b) { return b - a; });
    h += field('최초등록<em>월은 몰라도 됨 — 6월로 계산</em>', '<div class="v2-two">' +
      sel('y', [['', '연도']].concat(years.map(function (y) { return [y, y + '년']; })), S.y, !G) +
      sel('m', [['', '월 모름']].concat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(function (m) { return [m, m + '월']; })), S.m, !G) + '</div>');
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
    h += field('수리 필요<em>기록용 — 값에는 아래 예상 수리비만 반영</em>', '<div class="v2-chips">' +
      FIXES.map(function (f) { return chip('fix', f, f, S.fixes.indexOf(f) >= 0); }).join('') + '</div>' +
      (S.fixes.length && !manNum(S.cost) ? '<p class="v2-help">고른 수리 항목은 값에 반영되지 않습니다 — 아래 예상 수리비를 넣으세요</p>' : ''));
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

  // A. 차명 한 줄 → 제조사·모델·세부모델·등급·세부등급(묶음 산정과 같은 D5 매칭). 연도를 적으면 등록 연도로도 쓴다
  function findName() {
    var raw = $('nameText').value.trim(), ym = yearIn(raw), text = ym ? ym.rest : raw;
    VIEW.nameText = raw;
    if (!raw) return;
    var year = ym ? ym.y : (S.y ? +S.y : null);
    NM = NM || NameMatch.create(X.idx);
    var res0 = NM.model(text, year);
    if (!res0.best) { VIEW.nameMsg = '<span class="v2-bad">못 찾았습니다 — 아래에서 직접 고르세요</span>'; VIEW.nameCands = []; renderInputs(); return; }
    var top = res0.best.score, files = [];
    res0.cands.forEach(function (c) { if (c.score >= top - 2.5 && files.indexOf(c.file) < 0) files.push(c.file); });
    $('nameMsg').textContent = '찾는 중…';
    loadFiles(files).then(function () {
      var res = NM.refine(res0, text, year, function (f) { return GROUPS[f] || null; });
      if (ym) S.y = String(ym.y);
      VIEW.nameCands = res.conf === 'high' ? [] : res.cands.filter(function (c) { return c !== res.best; }).slice(0, 3);
      return loadFiles([res.best.file]).then(function () { setModel(res.best, text, res.conf); });   // 다시 고른 1등이 창 밖 후보일 수도 있다
    }).catch(fail);
  }
  function yearIn(raw) {                                     // 차명 속 연도: 2020 · 2020년식 · 22년식 · 22년형 → { y, rest(연도를 뺀 글) }
    var m = raw.match(/(?:^|\s)((?:19|20)\d{2})\s*(?:년식|년형|년)?(?=\s|$)/) || raw.match(/(?:^|\s)(\d{2})\s*(?:년식|년형)(?=\s|$)/);
    if (!m) return null;
    var y = m[1].length === 4 ? +m[1] : (+m[1] > 50 ? 1900 : 2000) + +m[1];
    return { y: y, rest: (raw.slice(0, m.index) + ' ' + raw.slice(m.index + m[0].length)).trim() };
  }
  function loadFiles(files) {
    return Promise.all(files.map(function (f) { return GROUPS[f] ? null : getJSON('comps/' + f).then(function (F) { GROUPS[f] = ENG.group(F); }); }));
  }
  function setModel(b, text, conf) {                         // 찾은(고른) 세부모델로 다섯 칸을 채운다
    var G = GROUPS[b.file], gr = G ? NM.grade(G, b.model, text) : null, lab = esc(b.maker + ' › ' + b.group + ' › ' + b.model) + yrOf(b.maker, b.group, b.model);
    S.mk = b.maker; S.grp = b.group; S.model = b.model; S.grade = gr ? gr.grade : ''; S.trim = gr ? gr.trim || '' : ''; S.ex = []; VIEW.exKeep = {};
    var g = gr ? ' · ' + esc(gr.grade + (gr.trim ? ' ' + gr.trim : '')) : ' · 등급은 직접 고르세요';
    VIEW.nameMsg = (conf === 'high' ? '찾음: <b>' + lab + g + '</b>' : conf === 'pick' ? '고름: <b>' + lab + g + '</b>' :
      '<span class="v2-warnt">확인 필요</span> <b>' + lab + g + '</b>') + (gr && gr.conf === 'low' ? ' — 등급은 확인하세요' : '') +
      (VIEW.nameCands.length ? '<br>다른 후보: ' + VIEW.nameCands.map(function (c, i) {
        return '<button type="button" class="v2-btn v2-cand" data-act="pickCand" data-i="' + i + '">' + esc(c.model) + yrOf(c.maker, c.group, c.model) + '</button>';
      }).join('') : '');
    renderInputs();
    changed();
  }

  function gradeFuel(G, rows) {                              // 등급별 가장 흔한 연료
    var fi = G && G.fi, fc = {}, out = {};
    if (!rows.length || fi.fu == null) return out;
    rows.forEach(function (r) { var g = G.F.grades[r[fi.g]], f = G.F.fuels[r[fi.fu]] || '기타'; (fc[g] = fc[g] || {})[f] = (fc[g][f] || 0) + 1; });
    Object.keys(fc).forEach(function (g) { out[g] = Object.keys(fc[g]).sort(function (a, b) { return fc[g][b] - fc[g][a]; })[0]; });
    return out;
  }
  function chipsHtml() {                                     // 고른 조건 한 줄(엔카 조건 칩) — 누르면 그 칸으로. 긴 입력 칸에서 지금 조건을 한눈에
    var c = [], km = kmNum(S.km), cost = manNum(S.cost);
    if (S.model) c.push(['model', S.mk + ' › ' + S.model]); else if (S.grp) c.push(['grp', S.mk + ' › ' + S.grp]); else if (S.mk) c.push(['mk', S.mk]);
    if (S.grade) c.push(['grade', S.grade + (S.trim ? ' ' + S.trim : '')]);
    if (S.y) c.push(['y', S.m ? S.y + '-' + pad(S.m) : S.y + '년']);
    if (km != null) c.push(['km', (km / 1e4).toFixed(1) + '만km']);
    if (S.color) c.push(['color', S.color]);
    if (S.rent) c.push(['rent', '렌트']);
    if (S.cond === '무사고') c.push(['cond', '무사고']);
    if (S.cond === '입력') c.push(['cond', S.items.length ? ISC.summary(S.items.slice(0, 1)) + (S.items.length > 1 ? ' 외 ' + (S.items.length - 1) + '곳' : '') : '기록부(부위 없음)']);
    if (cost) c.push(['cost', '수리비 ' + cost + '만']);
    if (!c.length) return '';
    return '<div class="v2-cchips">' + c.map(function (x) { return '<button type="button" class="v2-cchip" data-need="' + x[0] + '">' + esc(x[1]) + '</button>'; }).join('') +
      '<button type="button" class="v2-link" data-act="reset">초기화</button></div>';
  }
  function recentList() { try { return JSON.parse(localStorage.getItem(RECENT) || '[]'); } catch (e) { return []; } }
  function saveRecent() {                                    // 결과가 나온 차를 이 브라우저에 최근 10대로(같은 조건이면 맨 위로)
    if (!R || !LAST || !S.model) return;
    var hash = query(S, 'one'), list = recentList().filter(function (x) { return x.hash !== hash; });
    list.unshift({ hash: hash, label: S.mk + ' ' + S.model + ' ' + S.grade + (S.trim ? ' ' + S.trim : ''), sub: regText() + ' · ' + (kmNum(S.km) / 1e4).toFixed(1) + '만km',
      price: Math.round(R.price), conv: Math.round(R.converted), at: Date.now() });
    try { localStorage.setItem(RECENT, JSON.stringify(list.slice(0, 10))); } catch (e) { /* 저장 못 해도 산정은 된다 */ }
  }
  function recentHtml() {                                    // 최근 산정(엔카 '최근 검색 조건') — 누르면 그 차를 다시 연다
    var rl = recentList();
    if (!rl.length) return '';
    var when = function (t) { var d = new Date(t); return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
    return '<div class="v2-recent"><button type="button" class="v2-link" data-act="recent">최근 산정 ' + rl.length + '대 ' + (VIEW.recentOpen ? '▴' : '▾') + '</button>' +
      (VIEW.recentOpen ? '<ul>' + rl.map(function (x) {
        return '<li><a href="' + esc(x.hash) + '">' + esc(x.label) + '</a><span>' + esc(x.sub) + ' · 추정 ' + man(x.price) + '만 · 환산 ' + man(x.conv) + '만 · ' + when(x.at) + '</span></li>';
      }).join('') + '</ul><button type="button" class="v2-link" data-act="recentClear">기록 지우기</button>' : '') + '</div>';
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
    if (!S.y) add('최초등록 연도', 'y', !!grp());              // 월은 몰라도 된다(6월로 계산 — 묶음 산정과 같음)
    if (kmNum(km) == null) add(km ? '주행거리 — "' + km + '"를 못 읽음(예: 42000, 4.2만)' : '주행거리', 'km', true);
    return out;
  }
  function markNeed(miss) {                                  // 지금 채울 수 있는 빈 칸에 테두리
    var on = {};
    miss.forEach(function (x) { if (x.on) x.keys.forEach(function (k) { on[k] = 1; }); });
    $('inp').querySelectorAll('[data-k]').forEach(function (el) { el.classList.toggle('v2-need', !!on[el.getAttribute('data-k')]); });
    $('inp').querySelectorAll('.v2-f').forEach(function (f) { f.classList.toggle('v2-needf', !!f.querySelector('.v2-need')); });   // 칸 이름 옆 '입력 필요'
  }
  function focusNeed(k) {                                    // 남은 칸 안내·조건 칩을 누르면 그 입력 칸으로(아직 못 여는 칸이면 지금 채울 칸으로)
    var el = $('inp').querySelector('[data-k="' + k + '"], [data-chip="' + k + '"], [data-seg="' + k + '"]');
    if (!el || el.disabled) el = $('inp').querySelector('.v2-need');
    if (!el) return;
    el.scrollIntoView({ block: 'center' });                 // 바로 이동(부드러운 스크롤은 포커스와 겹치면 멈출 수 있다)
    el.focus({ preventScroll: true });
  }

  function compute() { calc(); mbar(); }

  function calc() {
    clearTimeout(recentTimer);
    var G = grp(), miss = missing(), km = kmNum(S.km), M = G && S.model && G.models[S.model];
    markMode(VIEW.mode);                                     // 탭은 고른 그대로 — 빈 칸이 있다고 모델 요약 탭으로 넘기지 않는다
    markNeed(miss);
    R0 = null;
    if (M && (VIEW.mode === 'model' || miss.length)) { R = null; summary(G, miss); MB = miss.length ? needBar(miss) : bar('모델 요약 보기 ↓'); return; }   // 빈 칸이 남았으면 안내 + 모델 요약(참고)
    if (miss.length || !G) { R = null; guide(miss); MB = miss.length ? needBar(miss) : ''; return; }
    var c = condResult(), rate = S.rate === '' ? null : Number(S.rate);
    var car = {
      '모델': S.model, '등급': S.grade, '세부등급': S.trim, '등록연월': +S.y * 100 + (+S.m || 6), '주행km': km,
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
    clearTimeout(recentTimer);
    recentTimer = setTimeout(saveRecent, 2500);
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
  function needCard(miss) {                                  // 남은 칸만 이름으로(누르면 그 칸으로 간다) · 처음 방문이면 사이트 설명을 위에
    return (S.mk || VIEW.mode === 'model' ? '' : '<div class="card v2-intro"><div class="card-title">이 화면에서 하는 일</div><p>엔카에 올라온 비슷한 매물로 ' +
      '이 차의 <b>시세(엔카 소매 호가)</b>와 <b>경매 예상가(환산가)</b>를 근거와 함께 냅니다.</p><ol><li>왼쪽 맨 위에 차명을 한 줄로 넣거나' +
      '(예: 더 뉴 그랜저 IG 2.5 프리미엄 2020) 칸을 차례로 고르고</li><li>주행거리를 넣으면 바로 계산됩니다. 월·색상·성능 상태·수리비는 넣으면 더 정확해집니다.</li></ol>' +
      '<p>여러 대는 <a class="v2-link" href="#/price?view=batch">묶음 산정</a>에 엑셀을 붙여 넣고, 시장 흐름은 <a class="v2-link" href="#/market">시장 시황</a>에서 봅니다.</p></div>') +
      '<div class="card v2-needcard"><div class="card-title">' + (VIEW.mode === 'model' ? '모델 요약' : '한 대 산정') + '까지 남은 칸 ' +
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
      '<br><span class="sub">' + regText() + ' 등록 · ' + car['주행km'].toLocaleString('ko-KR') + 'km · ' + esc(S.color || '색상 상관없음') +
      (S.rent ? ' · 렌트' : '') + ' · ' + (c['상태'] === '미상' ? '상태 미상' : esc(c['사고라벨']) + ' · 성능 ' + c['성능등급'] + '등급 · 글로비스 ' +
        c['글로비스_종합평가점'] + '점·' + esc(c['글로비스_사고평가점'])) + '</span></div>' +
      '<div class="v2-actions" style="margin:0">' + (batch().hasCar(batchCar()) ? '<button type="button" class="v2-btn" data-act="openBatch">묶음에 있음 · 묶음 산정 열기</button>' :
        '<button type="button" class="v2-btn" data-act="toBatch" title="이 차를 묶음 산정 목록에 한 줄로 더합니다. 단순수리·기계 결함·직접 뺀 매물·직접 넣은 환산 비율은 넘어가지 않습니다">묶음에 추가</button>') +
      '<button type="button" class="v2-btn" data-act="xlsx">엑셀 내려받기</button>' +
      '<button type="button" class="v2-btn" data-act="sheet" title="인쇄·PDF용 한 장. 환산가는 고를 때만 넣습니다">한 장 요약</button></div></div>';
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

    h += '<div class="v2-two-col v2-wide">' + posCard(G, car) + flowCard(G, car, c) + '</div>';   // 보강안 1단계(기획 5.1.3-2): 그림 먼저, 표는 아래
    h += '<div class="v2-two-col">' + speedCard(G) + trendCard(G) + '</div>';
    h += ladderCard(G, car, c);
    h += compsTable(G);
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
    var h = '<div class="card"><div class="v2-tools"><div class="card-title">비교 매물 <span class="hint">체크하면 그 매물을 빼고 다시 계산합니다</span></div>' +
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
    return '<tr data-id="' + id + '" class="' + (ex ? 'is-ex' : x.outlier ? 'is-out' : '') + (String(VIEW.hl) === String(id) ? ' is-hl' : '') + '">' +
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

  function chartW(max, colMin) {                             // 그림 폭 = 카드 안쪽 폭(휴대폰에서도 글자가 작아지지 않게) — 한 칸이 colMin(기본 480 = 내 차 위치·보정 흐름) 이상이면 두 칸
    var w = $('res').clientWidth || 600, col = w >= 2 * (colMin || 480) + 16 ? (w - 16) / 2 : w;
    return Math.round(Math.max(300, Math.min(max, col - 40)));
  }

  // ───── 내 차 위치(보강안 1단계, 기획 5.1.3-2) — 비교 매물의 실제 호가 위에 이 차의 추정 범위와 같은 조건 기준선 ─────
  function posCard(G, car) {
    var km = VIEW.posx === 'km', W = chartW(620), cf = ENG.prepare(G, S.model).cf.b;
    var H = ($('res').clientWidth || 0) >= 976 ? 430 : Math.max(260, Math.min(340, Math.round(W * 0.62)));   // 두 칸일 때는 옆 보정 흐름 높이에 맞춰 크게
    return '<div class="card"><div class="v2-tools"><div class="card-title">내 차 위치' + q(TIP.pos) + ' <span class="hint">비교 매물 ' + R.comps.length + '대의 실제 호가</span></div>' +
      seg('posx', [['km', '주행 × 호가'], ['age', '차령 × 호가']], VIEW.posx, '가로축') + '</div>' + posLegend() + posSvg(G, car, W, H, '') +
      '<p class="v2-help">점선: 이 차에서 ' + (km ? '주행만' : '연식만') + ' 다를 때의 값 — ' + (km ? '주행 1만km 늘 때마다 ' : '1년 오래될 때마다 ') +
      pct((Math.exp(km ? cf[1] : cf[0] * 12) - 1) * 100) + '(' + esc(COEF_LEVEL[R.coefLevel] || R.coefLevel) + ').</p></div>';
  }

  function posLegend() {
    var hasOut = R.comps.some(function (x) { return x.outlier; });
    return '<div class="v2-legend"><span><i style="background:var(--accent)"></i>판매중</span>' +
      '<span><i style="background:var(--bg-1);box-shadow:inset 0 0 0 2px var(--accent)"></i>최근 3개월 판매</span>' +
      (hasOut ? '<span><i style="background:var(--tx-4)"></i>이상치</span>' : '') +
      '<span><i class="v2-star" aria-hidden="true">★</i>내 차 추정 · <i class="v2-rng" aria-hidden="true"></i>범위 ' + man(R.lo) + '~' + man(R.hi) + '만</span>' +
      '<span><i class="v2-dash"></i>같은 조건 기준선</span></div>';
  }

  function posSvg(G, car, W, H, sfx) {                      // sfx: 한 장 요약에 같은 그림을 또 그릴 때 clipPath id가 겹치지 않게
    var fi = G.fi, km = VIEW.posx === 'km', L = 52, RR = 18, T = 30, B = 46, clip = 'v2posclip' + sfx;
    var cap = X.idx.engine.km_cap / 1e4, mon = function (v) { return Math.floor(v / 100) * 12 + v % 100; };   // yyyymm → 월 수
    var xOf = function (row) { return km ? row[fi.km] / 1e4 : mon(row[fi.reg]); };
    var tx = km ? car['주행km'] / 1e4 : mon(car['등록연월']);
    var pts = R.comps.map(function (x) { return { x: xOf(x.row), y: x.row[fi.price], c: x }; });
    S.ex.forEach(function (id) {                             // 직접 뺀 매물 — 흐리게 남긴다(계산에는 안 씀)
      var k = VIEW.exKeep[id];
      if (k) pts.push({ x: xOf(k.x.row), y: k.x.row[fi.price], c: k.x, ex: true });
    });
    var cf = ENG.prepare(G, S.model).cf.b, tk = Math.min(tx, cap);
    function base(v) { return R.est * Math.exp(km ? cf[1] * (Math.min(v, cap) - tk) : cf[0] * (tx - v)); }   // 다른 조건은 이 차와 같고 주행(연식)만 다를 때
    var xs = pts.map(function (p) { return p.x; }).concat([tx]), ys = pts.map(function (p) { return p.y; }).concat([R.lo, R.hi]);
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var xp = (x1 - x0) * 0.05 || 1, yp = (y1 - y0) * 0.08 || y1 * 0.05;
    x0 -= xp; x1 += xp; y0 -= yp; y1 += yp;
    function px(v) { return L + (v - x0) / (x1 - x0) * (W - L - RR); }
    function py(v) { return T + (y1 - v) / (y1 - y0) * (H - T - B); }
    var h = '<svg class="v2-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="비교 매물 ' + R.comps.length + '대의 ' + (km ? '주행거리' : '등록 연월') +
      '와 호가, 이 차의 추정 시세 ' + man(R.est) + '만원과 범위"><defs><clipPath id="' + clip + '"><rect x="' + L + '" y="' + T + '" width="' + (W - L - RR) +
      '" height="' + (H - T - B) + '"/></clipPath></defs>';
    niceTicks(y0, y1, 5).forEach(function (t) {
      h += '<line x1="' + L + '" x2="' + (W - RR) + '" y1="' + py(t).toFixed(1) + '" y2="' + py(t).toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>' +
        '<text x="' + (L - 8) + '" y="' + (py(t) + 4).toFixed(1) + '" text-anchor="end">' + man(t) + '</text>';
    });
    var xt = [];
    if (km) xt = niceTicks(x0, x1, Math.max(3, Math.round(W / 95))).map(function (t) { return [t, t + '만']; });
    else {                                                   // 1월(기간이 짧으면 7월도) 눈금
      var sm = x1 - x0 > 40 ? 12 : 6;
      for (var m = Math.ceil((x0 - 1) / sm) * sm + 1; m <= x1; m += sm) xt.push([m, Math.floor((m - 1) / 12) + ((m - 1) % 12 ? '.7' : '')]);
      if (!xt.length) xt.push([tx, ym(car['등록연월'])]);        // 기간이 아주 짧으면 이 차의 등록 연월만
    }
    xt.forEach(function (t) {
      h += '<line x1="' + px(t[0]).toFixed(1) + '" x2="' + px(t[0]).toFixed(1) + '" y1="' + (H - B) + '" y2="' + (H - B + 5) + '" stroke="var(--line-hard)" stroke-width="1"/>' +
        '<text x="' + px(t[0]).toFixed(1) + '" y="' + (H - B + 18) + '" text-anchor="middle">' + t[1] + '</text>';
    });
    h += '<line x1="' + L + '" x2="' + (W - RR) + '" y1="' + (H - B) + '" y2="' + (H - B) + '" stroke="var(--line-hard)" stroke-width="1"/>' +
      '<text x="' + ((L + W - RR) / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + (km ? '주행거리(km)' : '최초등록 연월 · 오른쪽일수록 새 차') + '</text>' +
      '<text x="' + L + '" y="' + (T - 14) + '" text-anchor="end">만원</text>';
    var bx = px(tx);
    var bl = [];
    for (var i = 0; i <= 40; i++) { var v = x0 + (x1 - x0) * i / 40; bl.push(px(v).toFixed(1) + ',' + py(base(v)).toFixed(1)); }
    h += '<polyline clip-path="url(#' + clip + ')" fill="none" stroke="var(--tx-3)" stroke-width="1.5" stroke-dasharray="5 4" points="' + bl.join(' ') + '"/>';
    var order = function (p) { return p.ex ? 0 : p.c.outlier ? 1 : p.c.sold ? 2 : 3; };   // 흐린 것부터 그려 진한 점이 위로
    pts.sort(function (a, b) { return order(a) - order(b); }).forEach(function (p) {
      var x = p.c, row = x.row, id = row[fi.id], st = p.ex ? 'ex' : x.outlier ? 'out' : x.sold ? 'sold' : 'on';
      var fill = { on: 'var(--accent)', sold: 'var(--bg-1)', out: 'var(--tx-4)', ex: 'none' }[st];
      var stroke = { on: 'var(--bg-1)', sold: 'var(--accent)', out: 'var(--bg-1)', ex: 'var(--tx-4)' }[st];
      var tip = '호가 ' + man(row[fi.price]) + '만 · ' + (x.sold ? '판매 ' + mmdd(row[fi.sd]) + '(마지막 호가)' : '판매중') + '\n' + ym(row[fi.reg]) + ' 등록 · ' +
        (row[fi.km] / 1e4).toFixed(1) + '만km · ' + G.F.grades[row[fi.g]] + '\n성능 ' + row[fi.perf] + '등급 · ' + G.F.labels[row[fi.acc]] +
        (x.adj != null && !p.ex ? ' · 보정 후 ' + man(x.adj) + '만' : '') + (p.ex ? '\n직접 뺀 매물(계산 제외)' : x.outlier ? '\n이상치(계산 제외)' : '') + '\n누르면 아래 표에서 보기';
      h += '<circle class="v2-pt" data-pt="' + id + '" cx="' + px(p.x).toFixed(1) + '" cy="' + py(p.y).toFixed(1) + '" r="4" fill="' + fill + '" stroke="' + stroke +
        '" stroke-width="' + (st === 'sold' ? 1.6 : 1) + '"' + (st === 'ex' ? ' stroke-dasharray="2 2"' : '') + ' data-tip="' + esc(tip) + '"/>';
      if (String(VIEW.hl) === String(id)) h += '<circle cx="' + px(p.x).toFixed(1) + '" cy="' + py(p.y).toFixed(1) + '" r="8" fill="none" stroke="var(--tx-1)" stroke-width="2"/>';
    });
    var sy = py(R.est), yl = py(R.lo), yh = py(R.hi), sp = [];
    for (var j = 0; j < 10; j++) {                           // 별(이 차 추정 시세)
      var a = Math.PI / 5 * j - Math.PI / 2, rr = j % 2 ? 5 : 12;
      sp.push((bx + rr * Math.cos(a)).toFixed(1) + ',' + (sy + rr * Math.sin(a)).toFixed(1));
    }
    var right = bx < W - RR - 130, side = function (d) { return (bx + (right ? d : -d)).toFixed(1); }, anc = right ? 'start' : 'end';
    var rtip = esc('이 차 추정 시세 ' + man(R.est) + '만' + (R.repair ? '(수리비 전)' : '') + '\n범위 ' + man(R.lo) + '~' + man(R.hi) + '만(보정 후 가운데 50%)');
    h += '<g stroke-linecap="round" fill="none">' + [['var(--bg-1)', 6], ['var(--tx-1)', 2.5]].map(function (k) {   // 범위 막대(흰 테두리로 점 위에서도 보이게)
      return '<path d="M' + (bx - 7) + ' ' + yh.toFixed(1) + 'H' + (bx + 7) + 'M' + bx + ' ' + yh.toFixed(1) + 'V' + yl.toFixed(1) + 'M' + (bx - 7) + ' ' + yl.toFixed(1) +
        'H' + (bx + 7) + '" stroke="' + k[0] + '" stroke-width="' + k[1] + '"/>';
    }).join('') + '</g><polygon points="' + sp.join(' ') + '" fill="var(--tx-1)" stroke="var(--bg-1)" stroke-width="2.5" stroke-linejoin="round" data-tip="' + rtip + '"/>' +
      '<text class="lbl v2-halo" x="' + side(16) + '" y="' + (sy + 4).toFixed(1) + '" text-anchor="' + anc + '">내 차 ' + man(R.est) + '만' + (R.repair ? '(수리비 전)' : '') + '</text>' +
      '<text class="v2-halo" x="' + side(12) + '" y="' + (yl + 4).toFixed(1) + '" text-anchor="' + anc + '">' + man(R.lo) + '</text>' +
      '<text class="v2-halo" x="' + side(12) + '" y="' + (yh + 4).toFixed(1) + '" text-anchor="' + anc + '">' + man(R.hi) + '</text></svg>';
    return h;
  }

  // ───── 보정 흐름(보강안 1단계) — 비교 매물 호가 가운데 값 → 항목별 보정(평균) → 추정 시세 → 환산가 · 아래에 보정 후 모임 ─────
  function flowData(G, car, c) {                             // 보정 흐름 줄(카드·한 장 요약) — split = 추정 시세 다음 줄 번호, conv = 환산 줄(한 장 요약에서 환산가를 뺄 때 같이 뺀다)
    var b = R.basis, fi = G.fi, kept = R.comps.filter(function (x) { return !x.outlier; });
    var tAge = Math.floor(G.F.now_ym / 100) * 12 + G.F.now_ym % 100 - (+S.y * 12 + (+S.m || 6));
    var dAge = tAge - mean(kept.map(function (x) { return x.age; }));
    var dKm = car['주행km'] - mean(kept.map(function (x) { return x.row[fi.km]; }));
    var deps = kept.map(function (x) { return x.row[fi.dep]; });
    var why = {
      '차령': '대상 차가 평균 ' + Math.abs(dAge).toFixed(1) + '개월 ' + (dAge >= 0 ? '더 오래됨' : '더 새것'),
      '주행': '평균 ' + (Math.abs(dKm) / 1e4).toFixed(1) + '만km ' + (dKm >= 0 ? '더 탐' : '덜 탐'),
      '성능': c['상태'] === '미상' ? '상태 미상 — 보정 안 함' : '감가율 대상 ' + c['성능감가율'] + '% · 비교 평균 ' + mean(deps).toFixed(1) + '%',
      '색상': S.color ? '흰색·진주 대비 계열 차이' : '색상 상관없음 — 보정 안 함',
      '렌트': S.rent ? '대상 차가 렌트 번호판' : '렌트 번호판 비교 매물과의 차이',
      '등급': '등급·세부등급 차이',
      '시점': '판매 매물의 마지막 호가를 지금 시세로(시세지수)'
    };
    var start = median(kept.map(function (x) { return x.row[fi.price]; })), sum = 0;
    var rows = [{ t: 'tot', k: '비교 매물 호가', v: start, why: '가운데 값 · 이상치 뺀 ' + kept.length + '대 · 보정 전' }];
    ['차령', '주행', '성능', '색상', '렌트', '등급', '시점'].forEach(function (k) {
      if (!b[k] && k !== '차령' && k !== '주행') return;
      rows.push({ t: 'step', k: k, d: b[k], why: why[k] });
      sum += b[k];
    });
    var rest = Math.round(R.est - start - sum);
    if (rest) rows.push({ t: 'step', k: '나머지', d: rest, why: '가운데 값끼리의 차이(매물마다 보정이 달라 생김)' });
    rows.push({ t: 'tot', k: '추정 시세', v: R.est, why: '보정 후 가격의 가운데 값' + (R.repair ? '(수리비 전)' : ''), main: true });
    if (R.repair) {
      rows.push({ t: 'step', k: '수리비', d: -R.repair, why: '입력한 예상 수리비' });
      rows.push({ t: 'tot', k: '수리비 반영', v: R.price, why: '추정 시세 − 수리비' });
    }
    rows.push({ t: 'step', k: '환산 −' + R.rate + '%', d: -R.est * R.rate / 100, why: R.rateSource, conv: true });
    rows.push({ t: 'tot', k: '환산가', v: R.converted, why: '경매 예상가', main: true, conv: true });
    var cur = start, split = 0;
    rows.forEach(function (r, i) {
      if (r.t === 'tot') { r.a = r.b = cur = r.v; } else { r.a = cur; r.b = cur = cur + r.d; }
      if (r.k === '추정 시세') split = i + 1;
    });
    return { rows: rows, split: split };
  }

  function flowBlock(rs, title, cls) {                       // 보정과 환산은 크기가 달라 눈금을 따로 둔다(작은 보정도 보이게) · cls 'sh' = 한 장 요약(이유를 줄 아래로)
    var all = [];
    rs.forEach(function (r) { all.push(r.a, r.b); });
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all), gap = (hi - lo) * 0.06 || hi * 0.02;
    lo -= gap; hi += gap;
    var at = function (v) { return ((v - lo) / (hi - lo) * 100).toFixed(2) + '%'; };
    var out = (title ? '<div class="v2-fsub">' + title + '</div>' : '') + '<div class="v2-flow' + (cls ? ' ' + cls : '') + '" style="--est:' + at(R.est) + '">';
    rs.forEach(function (r) {
      var ud = r.t === 'tot' ? '' : r.d >= 0 ? 'up' : 'dn';
      var mark = r.t === 'tot' ? '<i class="tick" style="left:' + at(r.v) + '"></i>'
        : '<i class="seg ' + ud + '" style="left:' + at(Math.min(r.a, r.b)) + ';width:max(2px,' + (Math.abs(r.b - r.a) / (hi - lo) * 100).toFixed(2) + '%)"></i>';
      out += '<span class="k' + (r.main ? ' main' : '') + '">' + esc(r.k) + '</span><span class="trk">' + mark + '</span>' +
        '<span class="v ' + ud + (r.main ? ' main' : '') + '">' + (r.t === 'tot' ? man(r.v) : signed(r.d)) + '</span><span class="why">' + esc(r.why) + '</span>';
    });
    return out + '</div>';
  }

  function flowCard(G, car, c) {
    var f = flowData(G, car, c), rows = f.rows, split = f.split;
    var h = '<div class="card"><div class="card-title">보정 흐름' + q(TIP.flow) + ' <span class="hint">만원 · 보정은 비교 매물 평균</span></div>' +
      flowBlock(rows.slice(0, split)) + flowBlock([rows[split - 1]].concat(rows.slice(split)), '환산 — 경매 예상가까지(눈금이 위와 다름)');
    return h + '<div class="v2-fsub">보정 후 비교 매물 — 가운데 값이 추정 시세, 가운데 50%가 범위</div>' + distSvg(G) +
      '<p class="v2-help">보정 계수: ' + esc(COEF_LEVEL[R.coefLevel] || R.coefLevel) + '(매주 데이터에서 추정)</p></div>';
  }

  function niceTicks(a, z, n) {
    var span = z - a, step = Math.pow(10, Math.floor(Math.log(span / n) / Math.LN10)), e = span / n / step;
    if (e >= 7.5) step *= 10; else if (e >= 3.5) step *= 5; else if (e >= 1.5) step *= 2;
    var t = [];
    for (var v = Math.ceil(a / step) * step; v <= z; v += step) t.push(Math.round(v / step) * step);
    return t;
  }

  function distSvg(G) {                                      // 보정 후 가격 점 그래프(겹치지 않게 위아래로 쌓음) — 보정 흐름 아래 띠
    var fi = G.fi, W = chartW(620), H = 132, L = 16, RR = 16, T = 26, B = 26, cy = (T + H - B) / 2;
    var vals = R.comps.map(function (x) { return x.adj; }).concat([R.lo, R.hi, R.est]);
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals), sp = (mx - mn) || mx * 0.1 || 1;
    var a = mn - sp * 0.05, z = mx + sp * 0.05;
    function px(v) { return L + (v - a) / (z - a) * (W - L - RR); }
    var h = '<svg class="v2-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="보정 후 비교 매물 가격 분포">';
    niceTicks(a, z, 5).forEach(function (t) {
      h += '<line x1="' + px(t) + '" x2="' + px(t) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--line)" stroke-width="1"/>' +
        '<text x="' + px(t) + '" y="' + (H - B + 16) + '" text-anchor="middle">' + man(t) + '</text>';
    });
    h += '<rect x="' + px(R.lo) + '" y="' + T + '" width="' + Math.max(px(R.hi) - px(R.lo), 1) + '" height="' + (H - B - T) + '" fill="var(--accent-wash)"/>';
    var placed = [], pts = R.comps.slice().sort(function (p, q) { return p.adj - q.adj; });
    pts.forEach(function (x) {
      var cx = px(x.adj), y = cy;
      for (var k = 1; k < 40; k++) {
        var hit = placed.some(function (p) { return Math.abs(p[0] - cx) < 8 && Math.abs(p[1] - y) < 8; });
        if (!hit) break;
        y = cy + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 8;
      }
      y = Math.max(T + 5, Math.min(H - B - 5, y));
      placed.push([cx, y]);
      var fill = x.outlier ? 'var(--tx-4)' : x.sold ? 'var(--bg-1)' : 'var(--accent)';
      var stroke = x.outlier ? 'var(--bg-1)' : x.sold ? 'var(--accent)' : 'var(--bg-1)';
      var tip = '보정 후 ' + man(x.adj) + '만\n호가 ' + man(x.row[fi.price]) + '만 · ' + ym(x.row[fi.reg]) + ' 등록 · ' +
        (x.row[fi.km] / 1e4).toFixed(1) + '만km\n유사도 ' + x.sim + ' · ' + (x.sold ? '최근 판매' : '판매중') + (x.outlier ? ' · 이상치(제외)' : '') + '\n누르면 아래 표에서 보기';
      h += '<circle class="v2-pt" data-pt="' + x.row[fi.id] + '" cx="' + cx.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.6" fill="' + fill + '" stroke="' + stroke +
        '" stroke-width="1.5" data-tip="' + esc(tip) + '"/>';
    });
    var ex = px(R.est), anchor = ex < 70 ? 'start' : ex > W - 70 ? 'end' : 'middle';
    h += '<line x1="' + ex + '" x2="' + ex + '" y1="' + (T - 4) + '" y2="' + (H - B) + '" stroke="var(--tx-1)" stroke-width="2"/>' +
      '<text class="lbl" x="' + ex + '" y="' + (T - 9) + '" text-anchor="' + anchor + '">추정 ' + man(R.est) + '만' + (R.repair ? '(수리비 전)' : '') + '</text>';
    return h + '</svg>';
  }

  function showComp(id) {                                    // 그림에서 누른 매물 → 아래 비교 매물 표의 그 행(10행 밖이면 펼친다) · 그림에도 고리 표시
    VIEW.hl = id;
    if (!$('res').querySelector('tr[data-id="' + id + '"]')) VIEW.all = true;
    compute();
    var tr = $('res').querySelector('tr[data-id="' + id + '"]');
    if (tr) tr.scrollIntoView({ block: 'center' });
  }

  // ───── 판매 속도(보강안 2단계, 기획 5.1.3-2 C) — 차급 대비 · 가격 위치별 판매까지 일수 · 인하 ─────
  var POS_EDGES = [-Infinity, -8, -3, 3, 8, Infinity], POS_MIN = 10;   // 추정가 대비 보정가 위치(%) — 판매 10대 미만 구간은 이웃과 합침
  function posLabel(lo, hi) {
    var f = function (v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + '%'; };
    return lo === -Infinity ? f(hi) + ' 미만' : hi === Infinity ? f(lo) + ' 이상' : lo === -hi ? '±' + hi + '%' : f(lo) + ' ~ ' + f(hi);
  }
  function posBuckets() {
    var sold = R.comps.filter(function (x) { return !x.outlier && x.sold && x.dwell != null; });
    var bk = POS_EDGES.slice(0, -1).map(function (lo, i) { return { lo: lo, hi: POS_EDGES[i + 1], d: [] }; });
    sold.forEach(function (x) {
      var p = (x.adj / R.est - 1) * 100;
      for (var i = 0; i < bk.length; i++) if (p >= bk[i].lo && p < bk[i].hi) { bk[i].d.push(x.dwell); break; }
    });
    while (bk.length > 1) {                                  // 가장 적은 구간부터 더 적은 이웃과 합친다
      var k = -1;
      bk.forEach(function (b, i) { if (b.d.length < POS_MIN && (k < 0 || b.d.length < bk[k].d.length)) k = i; });
      if (k < 0) break;
      var j = k === 0 ? 1 : k === bk.length - 1 ? k - 1 : (bk[k - 1].d.length <= bk[k + 1].d.length ? k - 1 : k + 1), a = Math.min(k, j);
      bk.splice(a, 2, { lo: bk[a].lo, hi: bk[a + 1].hi, d: bk[a].d.concat(bk[a + 1].d) });
    }
    return { n: sold.length, bk: bk.length >= 2 ? bk : null };
  }

  function speedData(G) {                                    // 판매 속도 숫자(카드·한 장 요약·엑셀 분석 시트가 같이 씀)
    var M = G.models[S.model], seg = M && M.seg, fi = G.fi;
    var mm = X.mmBy && X.mmBy[G.F.maker + '|' + S.model], sg = X.mm && X.mm.segments && X.mm.segments[seg];
    var kept = R.comps.filter(function (x) { return !x.outlier; });
    var on = kept.filter(function (x) { return !x.sold; }), sold = kept.filter(function (x) { return x.sold; });
    var d = { sname: seg ? seg.split('·')[1] + ' ' + seg.split('·')[0] : '차급', mm: mm, sg: sg, on: on.length, sold: sold.length, loading: !X.mmBy, vs: null };
    var word = function (r) { return r >= 1.15 ? '빠름' : r <= 0.87 ? '느림' : '비슷'; };
    if (mm && sg && mm.rate_w != null && sg.rate_w) d.vs = { by: 'rate', ratio: mm.rate_w / sg.rate_w, word: word(mm.rate_w / sg.rate_w) };   // 주간 판매율(지난 구간 판매 ÷ 시작 재고, 7일 환산)
    else if (mm && sg && mm.dwell != null && sg.dwell) d.vs = { by: 'dwell', ratio: sg.dwell / mm.dwell, word: word(sg.dwell / mm.dwell) };   // 없으면 중위 체류일로
    var pb = posBuckets();
    d.pn = pb.n;
    d.bk = pb.bk && pb.bk.map(function (b) { return { lo: b.lo, hi: b.hi, n: b.d.length, days: median(b.d), me: b.lo <= 0 && 0 < b.hi }; });
    var cut = on.filter(function (x) { var p0 = x.row[fi.p0]; return p0 != null && p0 > x.row[fi.price]; });
    d.cut = on.length ? { share: cut.length / on.length, med: cut.length ? median(cut.map(function (x) { return x.row[fi.p0] - x.row[fi.price]; })) : null } : null;
    return d;
  }
  function vsCls(w) { return w === '빠름' ? 'up' : w === '느림' ? 'dn' : ''; }

  function speedCard(G) {
    var d = speedData(G), mm = d.mm, sg = d.sg, sname = d.sname;
    var h = '<div class="card"><div class="card-title">판매 속도' + q(TIP.speed) + ' <span class="hint">소매 시장 기준 · 판매 = 목록에서 사라짐(추정)</span></div>' +
      '<div class="v2-kv">같은 조건 판매중 <b>' + d.on + '대</b>' + (S.sold ? ' · 최근 3개월 판매 <b>' + d.sold + '대</b>' : ' · 최근 판매 매물은 빼고 보는 중') + '</div>';
    // ① 차급 대비 — 주간 판매율. 없으면 중위 체류일로
    if (d.loading) h += '<p class="v2-kv">차급 비교를 불러오는 중…</p>';
    else if (d.vs && d.vs.by === 'rate') {
      var mx = Math.max(mm.rate_w, sg.rate_w), bar = function (name, v, cls, me) {
        return '<div class="v2-hrow' + (me ? ' me' : '') + '"><span class="k">' + esc(name) + '</span><span class="trk"><i class="' + cls + '" style="width:' +
          (v / mx * 100).toFixed(1) + '%"></i></span><span class="v">주 ' + (v * 100).toFixed(1) + '%</span></div>';
      };
      h += '<div class="v2-ssub">차급 대비 <span class="v2-pill ' + vsCls(d.vs.word) + '">' + sname + '보다 ' + d.vs.word + ' ' + pct((d.vs.ratio - 1) * 100) + '</span></div>' +
        bar('이 세부모델', mm.rate_w, 'me', true) + bar(sname, sg.rate_w, 'base') +
        '<p class="v2-help">주간 판매율 = 지난 구간(' + mmdd(X.mm.speed_interval[0]) + '→' + mmdd(X.mm.speed_interval[1]) + ') 판매 ÷ 시작 재고, 7일 환산. ' +
        (mm.weeks ? '판매중 매물이 다 팔리는 데 약 <b>' + mm.weeks + '주</b>' + (sg.weeks ? '(차급 ' + sg.weeks + '주)' : '') + '. ' : '') +
        (mm.dwell != null && sg.dwell ? '최근 90일 판매의 중위 체류 ' + mm.dwell + '일(차급 ' + sg.dwell + '일). ' : '') + '주간 수집이 쌓일수록 안정됩니다.</p>';
    } else if (d.vs) {
      h += '<div class="v2-ssub">차급 대비 <span class="v2-pill ' + vsCls(d.vs.word) + '">' + sname + '보다 ' + d.vs.word + '</span></div>' +
        '<p class="v2-kv">최근 90일 판매의 중위 체류 <b>' + mm.dwell + '일</b>(차급 ' + sg.dwell + '일) — 주간 판매율은 판매중 매물이 적어 계산하지 않았습니다.</p>';
    } else h += '<p class="v2-kv">이 세부모델은 매물이 적어 차급과 비교하지 않습니다.</p>';
    // ② 가격 위치별 판매까지 일수 — 보정가(이 차 조건으로 맞춘 값)가 추정가보다 얼마나 쌌나·비쌌나
    h += '<div class="v2-ssub">가격 위치별 판매까지 일수 <span class="hint">판매된 비교 매물 ' + d.pn + '대 · 추정가 대비 보정가</span></div>';
    if (!d.bk) h += '<p class="v2-kv">판매된 비교 매물이 적어(구간마다 ' + POS_MIN + '대 이상 필요) 생략합니다.</p>';
    else {
      var top = Math.max.apply(null, d.bk.map(function (b) { return b.days; }));
      d.bk.forEach(function (b) {
        h += '<div class="v2-hrow' + (b.me ? ' me' : '') + '"><span class="k">' + posLabel(b.lo, b.hi) + (b.me ? ' · 추정가' : '') + '</span><span class="trk"><i class="' +
          (b.me ? 'me' : 'base') + '" style="width:' + (b.days / top * 100).toFixed(1) + '%"></i></span><span class="v">' + Math.round(b.days) + '일 <small>' + b.n + '대</small></span></div>';
      });
      var a = d.bk[0], z = d.bk[d.bk.length - 1];
      h += '<p class="v2-help">추정가보다 싸게 낸 매물(' + posLabel(a.lo, a.hi) + ')은 중위 ' + Math.round(a.days) + '일, 비싸게 낸 매물(' + posLabel(z.lo, z.hi) + ')은 ' +
        Math.round(z.days) + '일 만에 팔렸습니다. 일수 = 엔카에 올라온 날부터 목록에서 사라진 날까지.</p>';
    }
    // ③ 인하 — 가끔 참고(Q48)
    if (d.cut) h += '<p class="v2-kv v2-cutline">판매중 비교 매물의 <b>' + Math.round(d.cut.share * 100) + '%</b>가 첫 호가보다 내림' +
      (d.cut.med != null ? '(중앙 −' + man(d.cut.med) + '만)' : '') + '</p>';
    return h + '</div>';
  }

  // ───── 같은 모델 가격 사다리(보강안 2단계, 기획 5.1.3-2 E) — 연식×주행 시세표(내 칸) · 등급별 · 성능 상태별 ─────
  var ACC_ORDER = ['무사고', '외판1·판금', '외판1·교환', '외판2·판금', '외판2·교환', '골격·판금', '골격·교환'];
  function condLadder(G, car) {                              // 이 모델 매물을 이 차 조건(차령·주행·렌트·색상·등급·시점)으로 맞춘 뒤 사고 단계별 가운데 값 — 성능 보정만 빼고
    var P = ENG.prepare(G, S.model), fi = G.fi, F = G.F, b = P.cf.b.slice(), nb = b.length;
    if (!S.color) for (var j = 3; j < nb; j++) b[j] = 0;
    var ym = F.now_ym, reg = car['등록연월'], tage = Math.floor(ym / 100) * 12 + ym % 100 - (Math.floor(reg / 100) * 12 + reg % 100);
    var colors = X.idx.engine.colors, tx = [tage, Math.min(car['주행km'], X.idx.engine.km_cap) / 1e4, S.rent ? 1 : 0].concat(colors.map(function (c) { return S.color === c ? 1 : 0; }));
    var cg = P.cf.grade || {}, ct = (P.cf.trim || {})[S.grade] || {}, tfe = (cg[S.grade] || 0) + (ct[S.trim || ''] || 0);
    var by = {};
    for (var i = 0; i < P.n; i++) {
      var lin = 0;
      for (j = 0; j < nb; j++) lin += (tx[j] - P.x[i][j]) * b[j];
      var v = P.price[i] * Math.exp(lin + tfe - P.fe[i]) * P.tf[i], lab = F.labels[P.rows[i][fi.acc]];
      (by[lab] = by[lab] || []).push(v);
    }
    var base = by['무사고'] && by['무사고'].length >= POS_MIN ? median(by['무사고']) : null;
    if (!base) return null;
    return ACC_ORDER.concat(Object.keys(by).filter(function (k) { return ACC_ORDER.indexOf(k) < 0; }))
      .filter(function (k) { return by[k] && by[k].length >= POS_MIN; })
      .map(function (k) { return { k: k, n: by[k].length, rel: median(by[k]) / base - 1 }; });
  }

  function ladderData(G, car, c) {                           // 가격 사다리 숫자(카드·한 장 요약·엑셀 분석 시트)
    var st = modelStats(G), yi = st.years.indexOf(+S.y), kj = -1;
    KM_BANDS.forEach(function (bd, j) { if (car['주행km'] >= bd[0] && car['주행km'] < bd[1]) kj = j; });
    var gs = st.grades.filter(function (g) { return g.n >= 5; }).slice(0, 8).sort(function (a, b) { return b.med - a.med; });   // 판매중이 많은 8개 등급을 값 순으로(사다리)
    return { st: st, yi: yi, kj: kj, cell: yi >= 0 && kj >= 0 ? st.cells[yi][kj] : null, gs: gs, gme: gs.find(function (g) { return g.name === S.grade; }) || null,
      cl: condLadder(G, car), mine: c['상태'] === '미상' ? null : c['사고라벨'],
      base0: c['상태'] === '무사고' ? R.est : R0 ? R0.est : R.est0 != null ? R.est0 : null };
  }

  function ladderCard(G, car, c) {
    var d = ladderData(G, car, c), gs = d.gs, gme = d.gme, cl = d.cl, mine = d.mine, base0 = d.base0;
    var h = '<div class="card"><div class="v2-tools"><div class="card-title">같은 모델 가격 사다리' + q(TIP.ladder) + ' <span class="hint">' + esc(S.model) + ' · 판매중 호가 중앙값(만원)</span></div>' +
      (S.grade ? seg('mgrade', [['one', S.grade + '만'], ['all', '전체 등급']], VIEW.allGrades ? 'all' : 'one', '시세표 등급') : '') + '</div>' +
      '<div class="v2-ladder"><div><div class="v2-ssub">연식 × 주행 <span class="hint">굵은 칸 = 이 차 · 칸을 누르면 그 조건으로 다시 산정</span></div>' + matrixTable(d.st, d.yi, d.kj) + '</div>';
    var gmax = Math.max.apply(null, gs.map(function (g) { return g.med; }).concat([1]));
    h += '<div><div class="v2-ssub">등급별</div>' + (gs.length ? gs.map(function (g) {
      var me = g.name === S.grade;
      return '<div class="v2-hrow' + (me ? ' me' : '') + '"><span class="k"><button type="button" class="v2-link" data-grade="' + esc(g.name) + '">' + esc(g.name) + '</button>' + (me ? ' · 이 차' : '') +
        '</span><span class="trk"><i class="' + (me ? 'me' : 'base') + '" style="width:' + (g.med / gmax * 100).toFixed(1) + '%"></i></span><span class="v">' + man(g.med) +
        ' <small>' + (gme && !me ? signed(g.med - gme.med) + ' · ' : '') + g.n + '대</small></span></div>';
    }).join('') : '<p class="v2-kv">판매중 5대 이상인 등급이 없습니다.</p>');
    h += '<div class="v2-ssub" style="margin-top:14px">성능 상태별 <span class="hint">무사고 대비 · 다른 조건은 이 차로 맞춤</span></div>';
    if (!cl) h += '<p class="v2-kv">무사고 매물이 적어 비교하지 않습니다.</p>';
    else {
      var lo = Math.min.apply(null, cl.map(function (x) { return x.rel; }).concat([-0.01]));
      cl.forEach(function (x) {
        var me = x.k === mine;
        h += '<div class="v2-hrow' + (me ? ' me' : '') + '"><span class="k">' + esc(x.k) + (me ? ' · 이 차' : '') + '</span><span class="trk"><i class="' + (x.rel < 0 ? 'dn' : 'base') +
          '" style="width:' + (Math.abs(x.rel) / Math.abs(lo) * 100).toFixed(1) + '%"></i></span><span class="v">' + (x.k === '무사고' ? '기준' : pct(x.rel * 100)) +
          (base0 && x.k !== '무사고' ? ' <small>' + man(base0 * (1 + x.rel)) + '만</small>' : ' <small>' + x.n + '대</small>') + '</span></div>';
      });
      h += '<p class="v2-help">같은 모델 매물을 이 차의 차령·주행·등급·색상으로 맞춘 뒤 사고 단계별 가운데 값을 무사고와 비교했습니다(' + POS_MIN + '대 이상인 단계만). ' +
        (base0 ? '만원은 이 차가 무사고일 때 ' + man(base0) + '만 기준.' : '') + (mine ? '' : ' 이 차는 성능 상태를 넣지 않아 표시가 없습니다.') +
        (mine && R0 ? ' 위 추정 시세(무사고 대비 ' + pct((R.est / R0.est - 1) * 100) + ')는 이 차의 손상 부위·성능등급까지 본 값이라 단계 평균과 다를 수 있습니다.' : '') + '</p>';
    }
    return h + '</div></div></div>';
  }

  // ───── 시세 추세(보강안 3단계, 기획 5.1.3-2 D) — 세부모델 시세지수 + 차급 비교선(7월 초 = 100) · 최근 4주 방향 ─────
  var TR_GAP = 16;                                           // 이 일수보다 벌어진 회차 사이는 수집 공백(옅은 점선)
  function dayN(d) { return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5; }
  function dayStr(t) { return mmdd(new Date(t * 864e5).toISOString().slice(0, 10)); }
  function signedF(v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1); }

  function trendDir(pts, t1) {                               // 마지막 회차(t1)에서 31일 안 점들의 가중 최소제곱 기울기 × 기간 — 흔들림(표준오차)의 2배를 넘어야 오름·내림
    var w = pts.filter(function (p) { return p.t >= t1 - 31 && p.t <= t1; });
    if (w.length < 2 || w[w.length - 1].t - w[0].t < 5) return null;
    var a = w[0], z = w[w.length - 1], span = z.t - a.t, sw = 0, st = 0, sv = 0, sxx = 0, sxy = 0;
    w.forEach(function (p) { var k = 1 / (p.se * p.se); sw += k; st += k * p.t; sv += k * p.v; });
    w.forEach(function (p) { var k = 1 / (p.se * p.se), dt = p.t - st / sw; sxx += k * dt * dt; sxy += k * dt * (p.v - sv / sw); });
    var d = sxy / sxx * span, se = Math.sqrt(1 / sxx) * span;
    return { a: a, z: z, weeks: Math.round(span / 7), d: d, se: se, short: span < 25,
      dir: Math.abs(d) >= Math.max(0.5, 2 * se) ? (d > 0 ? '오름' : '내림') : '보합' };
  }

  function trendData(G) {                                    // 시세 추세 숫자(카드·한 장 요약·엑셀 분석 시트) — 점마다 흔들림 se = 지수 × 1.2533 × σ ÷ √신규 대수
    var M = G.models[S.model], seg = (M && M.seg || '').split('·'), sname = seg[1] + ' ' + seg[0], skey = seg[1] + '|' + seg[0];
    var has = function (p) { return p['시세'] != null; }, raw = (X.mi.series[skey] || []).filter(has);
    if (raw.length < 2) { sname = seg[1] + ' 전체'; skey = seg[1] + '|전체'; raw = (X.mi.series[skey] || []).filter(has); }
    var ssig = (X.mi.price_sig || {})[skey] || 0.075;
    var sp = raw.map(function (p) { var n = p.n_price || 1; return { date: p.date, t: dayN(p.date), v: p['시세'], n: n, se: p['시세'] * 1.2533 * ssig / Math.sqrt(n) }; });
    var mm = X.mmBy && X.mmBy[G.F.maker + '|' + S.model], dates = X.mm && X.mm.trend_dates || [];
    var mp = mm && mm.ps ? mm.ps.map(function (q) { var d = dates[q[0]]; return { date: d, t: dayN(d), v: q[1], n: q[2], se: q[1] * 1.2533 * mm.sig / Math.sqrt(q[2]) }; }) : [];
    var cr = X.mi.crawls || [], latest = cr.length ? cr[cr.length - 1].date : sp.length ? sp[sp.length - 1].date : null, t1 = latest ? dayN(latest) : 0;
    var run = sp.length ? sp[sp.length - 1] : null;          // 지금 이어지는 매주 수집의 첫 회차 → 4주 방향이 나오는 날
    for (var i = sp.length - 1; i > 0 && sp[i].t - sp[i - 1].t <= TR_GAP; i--) run = sp[i - 1];
    return { sname: sname, sp: sp, mp: mp, mm: mm, latest: latest, t1: t1, loading: !X.mmBy,
      dm: mp.length >= 2 ? trendDir(mp, t1) : null, ds: sp.length >= 2 ? trendDir(sp, t1) : null, from4: run ? run.t + 28 : null };
  }

  function trRuns(pts) {                                     // 수집 공백(TR_GAP일 넘게 벌어진 곳)으로 나눈 이어지는 회차들
    var out = [];
    pts.forEach(function (p, i) { if (!i || p.t - pts[i - 1].t > TR_GAP) out.push([]); out[out.length - 1].push(p); });
    return out;
  }
  function trLine(pts, stroke, dash, xy) {
    var rs = trRuns(pts), s = '';
    rs.forEach(function (r, i) {
      if (i) s += '<polyline fill="none" stroke="' + stroke + '" stroke-opacity="0.5" stroke-width="1" stroke-dasharray="2 3" points="' + xy(rs[i - 1][rs[i - 1].length - 1]) + ' ' + xy(r[0]) + '"/>';
      if (r.length > 1) s += '<polyline fill="none" stroke="' + stroke + '" stroke-width="2" stroke-linejoin="round"' + (dash ? ' stroke-dasharray="5 3"' : '') +
        ' points="' + r.map(function (p) { return xy(p); }).join(' ') + '"/>';
    });
    return s;
  }

  function trendSvg(T, W) {
    var H = Math.max(180, Math.min(240, Math.round(W * 0.42))), wide = W >= 400, L = 34, RR = wide ? 86 : 40, TT = 12, B = 24;
    var all = T.sp.concat(T.mp), ts = all.map(function (p) { return p.t; });
    var t0 = Math.min.apply(null, ts), t1 = Math.max.apply(null, ts.concat([T.t1]));
    var vs = [100];
    T.sp.forEach(function (p) { vs.push(p.v); });
    T.mp.forEach(function (p) { vs.push(p.v - 1.96 * p.se, p.v + 1.96 * p.se); });
    var lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs), gap = Math.max(0.6, (hi - lo) * 0.08);
    lo -= gap; hi += gap;
    var px = function (t) { return L + (t - t0) / ((t1 - t0) || 1) * (W - L - RR); };
    var py = function (v) { return TT + (hi - v) / (hi - lo) * (H - TT - B); };
    var xy = function (p, v) { return px(p.t).toFixed(1) + ',' + py(v == null ? p.v : v).toFixed(1); };
    var lm = T.mp[T.mp.length - 1], ls = T.sp[T.sp.length - 1];
    var h = '<svg class="v2-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
      esc('시세지수 추이(7월 초 = 100)' + (lm ? ' — ' + S.model + ' ' + lm.v.toFixed(1) : '') + (ls ? ', ' + T.sname + ' ' + ls.v.toFixed(1) : '')) + '">';
    var ticks = niceTicks(lo, hi, 4);
    ticks.forEach(function (v) {
      h += '<line x1="' + L + '" x2="' + (W - RR) + '" y1="' + py(v).toFixed(1) + '" y2="' + py(v).toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>' +
        '<text x="' + (L - 6) + '" y="' + (py(v) + 4).toFixed(1) + '" text-anchor="end">' + (+v.toFixed(1)) + '</text>';
    });
    h += '<line x1="' + L + '" x2="' + (W - RR) + '" y1="' + py(100).toFixed(1) + '" y2="' + py(100).toFixed(1) + '" stroke="var(--line-hard)" stroke-width="1.5"/>' +
      (ticks.indexOf(100) < 0 ? '<text x="' + (L - 6) + '" y="' + (py(100) + 4).toFixed(1) + '" text-anchor="end">100</text>' : '');
    var d0 = new Date(t0 * 864e5), m = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1) / 864e5;   // 달 눈금(1일)
    while (m <= t1) {
      var dm = new Date(m * 864e5);
      h += '<line x1="' + px(m).toFixed(1) + '" x2="' + px(m).toFixed(1) + '" y1="' + (H - B) + '" y2="' + (H - B + 4) + '" stroke="var(--line-hard)" stroke-width="1"/>' +
        '<text x="' + px(m).toFixed(1) + '" y="' + (H - B + 16) + '" text-anchor="middle">' + (dm.getUTCMonth() + 1) + '월</text>';
      m = Date.UTC(dm.getUTCFullYear(), dm.getUTCMonth() + 1, 1) / 864e5;
    }
    h += '<line x1="' + L + '" x2="' + (W - RR) + '" y1="' + (H - B) + '" y2="' + (H - B) + '" stroke="var(--line-hard)" stroke-width="1"/>';
    trRuns(T.mp).forEach(function (r) {                      // 세부모델 흔들림 띠(95%) — 점 하나뿐인 구간은 세로 막대로
      if (r.length > 1) h += '<polygon points="' + r.map(function (p) { return xy(p, p.v + 1.96 * p.se); }).concat(r.slice().reverse().map(function (p) { return xy(p, p.v - 1.96 * p.se); })).join(' ') +
        '" fill="var(--accent-wash)" stroke="none"/>';
      else h += '<line x1="' + px(r[0].t).toFixed(1) + '" x2="' + px(r[0].t).toFixed(1) + '" y1="' + py(r[0].v + 1.96 * r[0].se).toFixed(1) + '" y2="' + py(r[0].v - 1.96 * r[0].se).toFixed(1) +
        '" stroke="var(--accent-line)" stroke-width="5" stroke-linecap="round"/>';
    });
    h += trLine(T.sp, 'var(--tx-3)', true, xy) + trLine(T.mp, 'var(--accent)', false, xy);
    T.sp.forEach(function (p) { h += '<circle cx="' + px(p.t).toFixed(1) + '" cy="' + py(p.v).toFixed(1) + '" r="3" fill="var(--bg-1)" stroke="var(--tx-3)" stroke-width="1.5"/>'; });
    T.mp.forEach(function (p) { h += '<circle cx="' + px(p.t).toFixed(1) + '" cy="' + py(p.v).toFixed(1) + '" r="3.5" fill="var(--accent)" stroke="var(--bg-1)" stroke-width="1.5"/>'; });
    var ends = [];                                           // 끝 값 이름표(겹치면 위아래로 벌린다)
    if (lm) ends.push({ p: lm, t: (wide ? '세부모델 ' : '') + lm.v.toFixed(1), c: 'lbl' });
    if (ls) ends.push({ p: ls, t: (wide ? '차급 ' : '') + ls.v.toFixed(1), c: '' });
    ends.forEach(function (e) { e.y = py(e.p.v) + 4; });
    if (ends.length === 2 && Math.abs(ends[0].y - ends[1].y) < 13 && Math.abs(ends[0].p.t - ends[1].p.t) < 3) {
      var mid = (ends[0].y + ends[1].y) / 2, up = ends[0].p.v >= ends[1].p.v ? 0 : 1;
      ends[up].y = mid - 7; ends[1 - up].y = mid + 7;
    }
    ends.forEach(function (e) { h += '<text class="' + e.c + '" x="' + (px(e.p.t) + 8).toFixed(1) + '" y="' + e.y.toFixed(1) + '">' + e.t + '</text>'; });
    var grp = [];                                            // 마우스 올림 칸(점보다 넓게) — 이틀 안 회차는 한 칸에 두 선 값을 함께
    all.slice().sort(function (a, b) { return a.t - b.t; }).forEach(function (p) {
      var g = grp[grp.length - 1];
      if (g && p.t - g.t0 <= 2) g.t1 = p.t; else grp.push({ t0: p.t, t1: p.t });
    });
    grp.forEach(function (g, i) {
      var xa = i ? (px(grp[i - 1].t1) + px(g.t0)) / 2 : L - 4, xb = i < grp.length - 1 ? (px(g.t1) + px(grp[i + 1].t0)) / 2 : W, tip = [];
      T.mp.forEach(function (p) { if (p.t >= g.t0 && p.t <= g.t1) tip.push(mmdd(p.date) + ' ' + S.model + ' ' + p.v.toFixed(1) + '(신규 ' + p.n + '대 · 흔들림 ±' + (1.96 * p.se).toFixed(1) + ')'); });
      T.sp.forEach(function (p) { if (p.t >= g.t0 && p.t <= g.t1) tip.push(mmdd(p.date) + ' ' + T.sname + ' ' + p.v.toFixed(1) + '(신규 ' + p.n.toLocaleString('ko-KR') + '대)'); });
      h += '<rect x="' + xa.toFixed(1) + '" y="' + TT + '" width="' + Math.max(4, xb - xa).toFixed(1) + '" height="' + (H - TT - B) + '" fill="transparent" data-tip="' + esc(tip.join('\n')) + '"/>';
    });
    return h + '</svg>';
  }

  function dirPill(D) { return D ? '<span class="v2-pill ' + (D.dir === '오름' ? 'up' : D.dir === '내림' ? 'dn' : '') + '">' + D.dir + ' ' + signedF(D.d) + '</span>' : '—'; }

  function trendCard(G) {
    var T = trendData(G), mp = T.mp, sp = T.sp, D = mp.length >= 2 ? T.dm : T.ds, short = !D || D.short;
    var h = '<div class="card"><div class="card-title">시세 추세' + q(TIP.trend) +
      (short && (sp.length >= 2 || mp.length) ? ' <span class="v2-pill" title="매주 수집이 4주가 안 돼 방향을 짧은 기간으로 봅니다">짧음</span>' : '') +
      ' <span class="hint">' + (mp.length ? '세부모델 vs ' : '') + esc(T.sname) + ' · 시세지수(7월 초 = 100)</span></div>';
    if (sp.length < 2 && !mp.length) return h + '<p class="v2-kv">추세 데이터가 아직 부족합니다.</p></div>';
    h += '<div class="v2-legend">' + (mp.length ? '<span><i class="v2-lkey" style="background:var(--accent)"></i>' + esc(S.model) + '</span>' : '') +
      (sp.length ? '<span><i class="v2-dash"></i>' + esc(T.sname) + '</span>' : '') + (mp.length ? '<span><i class="v2-band"></i>표본 흔들림(95%)</span>' : '') + '</div>' + trendSvg(T, chartW(620, 360));
    var lm = mp[mp.length - 1], ls = sp[sp.length - 1], txt;
    if (lm) txt = mmdd(lm.date) + ' 세부모델 <b>' + lm.v.toFixed(1) + '</b>' + (ls && ls.date === lm.date ? ' · ' + esc(T.sname) + ' <b>' + ls.v.toFixed(1) + '</b> — 7월 초 대비 차급보다 <b>' +
      Math.abs(lm.v - ls.v).toFixed(1) + '</b> ' + (lm.v >= ls.v ? '높음' : '낮음') : '') + (T.latest && lm.date !== T.latest ? ' (' + mmdd(T.latest) + '은 신규 매물이 10대 미만이라 비움)' : '') + '.';
    else txt = (T.loading ? '세부모델 시세를 불러오는 중… ' : T.mm && T.mm.pidx != null ? '이 세부모델만 보면 <b>' + Number(T.mm.pidx).toFixed(1) + '</b>(' + mmdd(X.mm.date) +
      ' 신규 매물) — 회차별 점이 모자라 선은 그리지 않습니다. ' : '이 세부모델은 7월 초나 회차별 신규 매물이 10대 미만이라 선을 그리지 않습니다(차급 선만). ') +
      (ls ? mmdd(ls.date) + ' ' + esc(T.sname) + ' <b>' + ls.v.toFixed(1) + '</b>.' : '');
    var dl = !D ? '직전 수집과 간격이 길어 방향은 아직 내지 않습니다' + (T.from4 ? ' — 4주 방향은 ' + dayStr(T.from4) + '부터' : '') + '.'
      : (D.short ? '방향(짧음) ' + mmdd(D.a.date) + '→' + mmdd(D.z.date) + ' ' + D.weeks + '주' : '최근 4주(' + mmdd(D.a.date) + '→' + mmdd(D.z.date) + ')') + ': ' +
        (mp.length ? '세부모델 ' + dirPill(T.dm) + ' · ' : '') + esc(T.sname) + ' ' + dirPill(T.ds) + (D.short && T.from4 ? ' — 4주 방향은 ' + dayStr(T.from4) + '부터' : '');
    return h + '<p class="v2-kv">' + txt + '</p><p class="v2-kv">' + dl + '</p>' +
      '<p class="v2-help">' + (mp.length ? '옅은 띠 = 신규 매물 수로 생기는 흔들림(95%). ' : '') + '방향은 표본 흔들림보다 크게 움직였을 때만 오름·내림으로 씁니다.</p></div>';
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
    return h + matrixTable(st, -1, -1) + '</div>';
  }

  function matrixTable(st, yi, kj) {                         // yi·kj = 이 차의 연식 행·주행 열(강조, 없으면 -1)
    if (!st.years.length) return '<p class="v2-kv">판매중 매물이 없습니다.</p>';
    var h = '<div class="v2-tablewrap"><table class="t v2-mtx"><thead><tr><th>최초등록 \\ 주행</th>' +
      KM_BANDS.map(function (b) { return '<th>' + b[2] + '</th>'; }).join('') + '<th>합계</th></tr></thead><tbody>';
    st.years.forEach(function (y, i) {
      var tot = st.cells[i].reduce(function (s, c) { return s + c.n; }, 0);
      h += '<tr><td><b>' + y + '년</b></td>' + st.cells[i].map(function (c, j) {
        return '<td' + (i === yi && j === kj ? ' class="me"' : '') + '>' + (c.n >= 5 ? '<button type="button" class="v2-cell" data-cell="' + i + '|' + j + '">' + man(c.med) + '<small>' + c.n + '대</small></button>'
          : '<span class="v2-na">' + (c.n ? c.n + '대' : '') + '</span>') + '</td>';
      }).join('') + '<td>' + tot + '대</td></tr>';
    });
    return h + '</tbody></table></div>';
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
      ['세부등급', S.trim || '상관없음'], ['최초등록', regText()], ['주행(km)', { v: car['주행km'], money: true }],
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
    XlsxWriter.download(fileSafe('시세산정_' + S.model + '_' + S.grade + (S.trim ? '_' + S.trim : '') + '_' + (S.m ? S.y + '-' + pad(S.m) : S.y) + '_' +
      (kmNum(S.km) / 1e4).toFixed(1) + '만km_' + today()) + '.xlsx', [
      { name: '산정 결과', rows: rows, header: true, widths: [32, 64] },
      { name: '비교 매물', rows: cr, header: true, freeze: true, money: [5, 15, 16, 17, 18],
        widths: [7, 11, 7, 11, 9, 10, 9, 18, 14, 8, 8, 12, 34, 10, 10, 10, 11, 11, 9, 7, 7, 8, 42] },
      { name: '분석', rows: analysisRows(G, car, c), widths: [40, 14, 14, 18, 16, 14, 12] }]);
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

  function analysisRows(G, car, c) {                         // 엑셀 '분석' 시트(보강안 3단계 G, Q53) — 판매 속도·시세 추세·가격 사다리 숫자(그림은 넣지 않음)
    var sd = speedData(G), td = trendData(G), ld = ladderData(G, car, c), st = ld.st, rows = [];
    var B = function (t) { return { v: t, bold: true }; }, f1 = function (v) { return v == null || !isFinite(v) ? null : Math.round(v * 10) / 10; };
    var mw = function (v, bold) { return v == null ? null : { v: Math.round(v), money: true, bold: !!bold }; };
    var mm = sd.mm || {}, sg = sd.sg || {}, iv = X.mm && X.mm.speed_interval;
    rows.push([B('판매 속도 — 소매 시장 기준 · 판매 = 목록에서 사라짐(추정)')], [B('항목'), B('이 세부모델'), B(sd.sname), B('비고')],
      ['같은 조건 비교 매물 판매중(대)', sd.on], ['같은 조건 최근 3개월 판매(대)', S.sold ? sd.sold : null, null, S.sold ? null : '최근 판매 매물을 빼고 계산함'],
      ['주간 판매율(%)', f1(mm.rate_w != null ? mm.rate_w * 100 : null), f1(sg.rate_w != null ? sg.rate_w * 100 : null), iv ? iv[0] + '→' + iv[1] + ' 판매 ÷ 시작 재고, 7일 환산' : null],
      ['재고 소진(주)', mm.weeks != null ? mm.weeks : null, sg.weeks != null ? sg.weeks : null, '1 ÷ 주간 판매율'],
      ['중위 체류일(최근 90일 판매)', mm.dwell != null ? mm.dwell : null, sg.dwell != null ? sg.dwell : null],
      ['차급 대비', sd.vs ? sd.vs.word + (sd.vs.by === 'rate' ? ' ' + pct((sd.vs.ratio - 1) * 100) : '') : '비교 안 함', null,
        sd.vs ? (sd.vs.by === 'rate' ? '주간 판매율 비교 · ±15% 안이면 비슷' : '중위 체류일 비교(주간 판매율 없음)') : '매물이 적음'],
      [], [B('가격 위치(추정가 대비 보정가)'), B('판매(대)'), B('판매까지 중위 일수'), B('비고')]);
    if (sd.bk) sd.bk.forEach(function (b) { rows.push([posLabel(b.lo, b.hi) + (b.me ? ' · 추정가' : ''), b.n, Math.round(b.days), b.me ? '이 차 추정가가 든 구간' : null]); });
    else rows.push(['판매된 비교 매물이 적어 생략(구간마다 ' + POS_MIN + '대 이상 필요)', sd.pn]);
    if (sd.cut) rows.push(['판매중 인하 매물 비율(%)', f1(sd.cut.share * 100), null, '첫 호가보다 내린 매물'], ['인하 폭 중앙(만원)', mw(sd.cut.med)]);
    rows.push([], [B('시세 추세 — 시세지수(7월 초 = 100) · 신규 매물(등록 7일 이내) 첫 호가를 같은 조건으로 맞춰 비교')],
      [B('목록 관측일'), B('세부모델 지수'), B('세부모델 신규(대)'), B('세부모델 흔들림(±, 95%)'), B(td.sname + ' 지수'), B(td.sname + ' 신규(대)')]);
    var dates = [];
    td.mp.concat(td.sp).forEach(function (p) { if (dates.indexOf(p.date) < 0) dates.push(p.date); });
    dates.sort().forEach(function (dt) {
      var m = td.mp.find(function (p) { return p.date === dt; }), s = td.sp.find(function (p) { return p.date === dt; });
      rows.push([dt, m ? m.v : null, m ? m.n : null, m ? f1(1.96 * m.se) : null, s ? s.v : null, s ? s.n : null]);
    });
    if (!td.mp.length) rows.push(['세부모델 선 없음 — 7월 초나 회차별 신규 매물이 10대 미만']);
    var D = td.mp.length ? td.dm : td.ds;
    rows.push([B('방향'), B('기간'), B('세부모델 변화'), B('세부모델 판정'), B(td.sname + ' 변화'), B(td.sname + ' 판정')],
      [D ? (D.short ? '짧음(' + D.weeks + '주)' : '최근 4주') : '계산 안 됨', D ? D.a.date + '→' + D.z.date : null,
        td.dm ? f1(td.dm.d) : null, td.dm ? td.dm.dir : null, td.ds ? f1(td.ds.d) : null, td.ds ? td.ds.dir : null],
      ['판정: 마지막 회차에서 31일 안 점들의 기울기 × 기간, 흔들림(표준오차)의 2배를 넘어야 오름·내림' + (D && D.short && td.from4 ? ' · 4주 방향은 ' + dayStr(td.from4) + '부터' : '')]);
    rows.push([], [B('같은 모델 가격 사다리 — 연식 × 주행, 판매중 호가 중앙값(만원' + (st.gsel ? ', ' + S.grade + ' 등급' : ', 전체 등급') + ') · 5대 미만 칸은 비움 · 굵은 값 = 이 차 칸')],
      [B('최초등록 \\ 주행')].concat(KM_BANDS.map(function (b) { return B(b[2]); }), [B('합계(대)')]));
    st.years.forEach(function (y, i) {
      rows.push([y + '년' + (i === ld.yi ? ' ◀ 이 차' : '')].concat(st.cells[i].map(function (cc, j) { return cc.n >= 5 ? mw(cc.med, i === ld.yi && j === ld.kj) : null; }),
        [st.cells[i].reduce(function (s, cc) { return s + cc.n; }, 0)]));
    });
    rows.push([B('대수')].concat(KM_BANDS.map(function (b) { return B(b[2]); })));
    st.years.forEach(function (y, i) { rows.push([y + '년'].concat(st.cells[i].map(function (cc) { return cc.n; }))); });
    if (ld.cell) rows.push(['이 차 칸: ' + st.years[ld.yi] + '년 × ' + KM_BANDS[ld.kj][2].replace('만', '만km') + ' — ' + (ld.cell.n >= 5 ? man(ld.cell.med) + '만(' + ld.cell.n + '대)' : ld.cell.n + '대(5대 미만이라 비움)')]);
    rows.push([], [B('등급(판매중 5대 이상, 많은 8개를 값 순으로)'), B('판매중(대)'), B('중앙 호가(만원)'), B('이 차 등급과 차이(만원)')]);
    ld.gs.forEach(function (g) { rows.push([g.name + (g.name === S.grade ? ' ◀ 이 차' : ''), g.n, mw(g.med), ld.gme && g !== ld.gme ? Math.round(g.med - ld.gme.med) : null]); });
    if (!ld.gs.length) rows.push(['판매중 5대 이상인 등급이 없음']);
    rows.push([], [B('성능 상태(사고 단계)'), B('대수'), B('무사고 대비(%)'), B('이 차가 그 단계일 때(만원)')]);
    if (ld.cl) ld.cl.forEach(function (x) { rows.push([x.k + (x.k === ld.mine ? ' ◀ 이 차' : ''), x.n, x.k === '무사고' ? 0 : f1(x.rel * 100), ld.base0 ? mw(ld.base0 * (1 + x.rel)) : null]); });
    else rows.push(['무사고 매물이 적어 비교 안 함']);
    rows.push(['같은 모델 매물을 이 차의 차령·주행·등급·색상으로 맞춘 뒤 사고 단계별 가운데 값을 무사고와 비교(' + POS_MIN + '대 이상인 단계만)' +
      (ld.base0 ? ' · 만원은 이 차가 무사고일 때 ' + man(ld.base0) + '만 기준' : '')], [], ['데이터 기준', '엔카 ' + dataDate(true)]);
    return rows;
  }

  // ───── 한 장 요약(보강안 3단계, 기획 5.1.3-2 F) — 인쇄·PDF 한 장. 환산가·산정 화면 주소는 고를 때만 넣는다(외부용은 끔, Q55·Q59) ─────
  var SHEET = null, PAGE_PX = 794;                           // A4 폭 210mm ≈ 794px
  function sheetOpen() {
    if (!R || !LAST) return;
    sheetClose();
    SHEET = { conv: false, url: false };                     // 열 때마다 끈 상태로 — 외부에 보낼 때 환산가가 실수로 나가지 않게
    var dlg = document.createElement('div');
    dlg.className = 'v2-sheetdlg';
    dlg.id = 'sheetDlg';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', '한 장 요약 미리보기');
    dlg.innerHTML = '<div class="bar"><b>한 장 요약</b><label><input type="checkbox" data-sheet="conv"> 환산가 포함</label>' +
      '<label><input type="checkbox" data-sheet="url"> 산정 화면 주소 포함</label>' +
      '<span class="hint">외부에 보낼 때는 둘 다 끄세요(주소로 들어가면 환산가가 보입니다). 인쇄 창에서 대상을 "PDF로 저장"으로 고르면 파일이 됩니다.</span>' +
      '<button type="button" class="v2-btn primary" data-sheet-act="print">인쇄 · PDF</button><button type="button" class="v2-btn" data-sheet-act="close">닫기</button></div>' +
      '<div class="v2-page" id="sheetPage"><div class="v2-sheet" id="sheet"></div></div>';
    document.body.appendChild(dlg);
    document.body.classList.add('v2-sheeton');
    dlg.addEventListener('change', function (e) {
      var k = e.target.getAttribute('data-sheet');
      if (k) { SHEET[k] = e.target.checked; sheetRender(); }
    });
    dlg.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sheet-act]');
      if (!b) { if (e.target === dlg) sheetClose(); return; }
      if (b.getAttribute('data-sheet-act') === 'print') sheetPrint(); else sheetClose();
    });
    document.addEventListener('keydown', sheetKey);
    window.addEventListener('resize', sheetFit);
    sheetRender();
    dlg.querySelector('input').focus();
  }
  function sheetKey(e) { if (e.key === 'Escape') sheetClose(); }
  function sheetClose() {
    var dlg = $('sheetDlg');
    if (!dlg) return;
    dlg.remove();
    document.body.classList.remove('v2-sheeton');
    document.removeEventListener('keydown', sheetKey);
    window.removeEventListener('resize', sheetFit);
    var b = $('res') && $('res').querySelector('[data-act="sheet"]');
    if (b) b.focus();
  }
  function sheetFit() {                                      // 미리보기만 창 폭에 맞춰 줄인다(인쇄는 원래 크기 — 인쇄 CSS가 zoom 을 1로)
    var p = $('sheetPage');
    if (p) p.style.zoom = Math.min(1, (window.innerWidth - 32) / PAGE_PX).toFixed(3);
  }
  function sheetRender() {
    var el = $('sheet');
    if (el && R && LAST) { el.innerHTML = sheetHtml(SHEET); sheetFit(); }
  }
  function sheetPrint() {
    var t = document.title;                                  // PDF 저장 파일 이름 = 문서 제목
    document.title = fileSafe('시세요약_' + S.model + '_' + S.grade + '_' + (S.m ? S.y + '-' + pad(S.m) : S.y) + '_' + (kmNum(S.km) / 1e4).toFixed(1) + '만km_' + today());
    var back = function () { document.title = t; window.removeEventListener('afterprint', back); };
    window.addEventListener('afterprint', back);
    window.print();
  }

  function speedLine(sd) {
    var t = sd.vs ? esc(sd.sname) + '보다 <b>' + sd.vs.word + (sd.vs.by === 'rate' ? ' ' + pct((sd.vs.ratio - 1) * 100) : '') + '</b>' +
      (sd.vs.by === 'rate' ? '(주간 판매율 ' + (sd.mm.rate_w * 100).toFixed(1) + '% vs ' + (sd.sg.rate_w * 100).toFixed(1) + '%)' : '(중위 체류 ' + sd.mm.dwell + '일 vs ' + sd.sg.dwell + '일)')
      : '차급 비교 없음(매물 적음)';
    if (sd.bk) t += ' · 판매까지 중위 ' + sd.bk.map(function (b) { return posLabel(b.lo, b.hi) + ' ' + Math.round(b.days) + '일'; }).join(', ');
    if (sd.cut) t += ' · 판매중 ' + Math.round(sd.cut.share * 100) + '% 인하' + (sd.cut.med != null ? '(중앙 −' + man(sd.cut.med) + '만)' : '');
    return t;
  }
  function trendLine(T) {
    var lm = T.mp[T.mp.length - 1], ls = T.sp[T.sp.length - 1], D = T.mp.length ? T.dm : T.ds;
    var t = (lm ? '세부모델 <b>' + lm.v.toFixed(1) + '</b>(' + mmdd(lm.date) + ')' : '세부모델 선 없음(신규 매물 적음)') +
      (ls ? ' · ' + esc(T.sname) + ' ' + ls.v.toFixed(1) + '(' + mmdd(ls.date) + ')' : '') + ' — 7월 초 = 100';
    if (D) t += ' · ' + (D.short ? D.weeks + '주 방향(짧음)' : '최근 4주') + ': ' + (T.mp.length ? '세부모델 ' + (T.dm ? T.dm.dir + ' ' + signedF(T.dm.d) : '—') + ', ' : '') +
      '차급 ' + (T.ds ? T.ds.dir + ' ' + signedF(T.ds.d) : '—');
    return t;
  }
  function ladderLine(ld) {
    var st = ld.st, out = [], cm = ld.cl && ld.mine ? ld.cl.find(function (x) { return x.k === ld.mine; }) : null;
    if (ld.cell && ld.cell.n >= 5) out.push(st.years[ld.yi] + '년 × ' + KM_BANDS[ld.kj][2].replace('만', '만km') + (st.gsel ? '(' + esc(S.grade) + ')' : '(전체 등급)') +
      ' 판매중 중앙 <b>' + man(ld.cell.med) + '만</b>(' + ld.cell.n + '대)');
    if (ld.gme) out.push(esc(S.grade) + ' 등급 중앙 ' + man(ld.gme.med) + '만(' + ld.gme.n + '대)');
    if (cm && cm.k !== '무사고') out.push(esc(cm.k) + ' 단계 무사고 대비 ' + pct(cm.rel * 100) + '(' + cm.n + '대)');
    return out.join(' · ') || '같은 연식·주행 칸 판매중이 5대 미만';
  }

  function sheetHtml(o) {
    var G = LAST.G, car = LAST.car, c = LAST.c, F = G.F, fi = G.fi, r = R, km = VIEW.posx === 'km';
    var now = new Date(), stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
    var stepNo = r.stepName.split(' ')[0], stepName = r.stepName.slice(stepNo.length + 1);
    var kept = r.comps.filter(function (x) { return !x.outlier; }), nOn = kept.filter(function (x) { return !x.sold; }).length;
    var cond = c['상태'] === '미상' ? '성능 상태 미상' : c['사고라벨'] + ' · 성능 ' + c['성능등급'] + '등급 · 글로비스 ' + c['글로비스_종합평가점'] + '점·' + c['글로비스_사고평가점'] +
      (S.cond === '입력' && S.items.length ? '(' + ISC.summary(S.items) + ')' : '');
    var h = '<div class="sh-top"><div><div class="sh-eyebrow">시세 산정 요약</div><div class="sh-title">' + esc(F.maker + ' ' + S.model) + ' · ' + esc(S.grade + (S.trim ? ' ' + S.trim : '')) + '</div>' +
      '<div class="sh-sub">' + regText() + ' 등록 · ' + car['주행km'].toLocaleString('ko-KR') + 'km · ' + esc(S.color || '색상 상관없음') + (S.rent ? ' · 렌트 번호판' : '') + ' · ' + esc(cond) + '</div></div>' +
      '<div class="sh-date">데이터 기준 ' + dataDate(true) + '<br>작성 ' + stamp + '</div></div>';
    h += '<div class="sh-nums"><div class="sh-num main"><span>추정 시세 · 엔카 소매 호가 기준</span><b>' + man(r.price) + '<small>만원</small></b><em>범위 ' + man(r.range[0]) + ' ~ ' + man(r.range[1]) +
      '만(보정 후 가운데 50%)' + (r.repair ? ' · 수리비 −' + man(r.repair) + '만 반영' : '') +
      (R0 ? ' · 무사고였다면 ' + man(R0.price) + '만' : r.est0 != null ? ' · 무사고라면 ' + man(r.est0 - r.repair) + '만' : '') + '</em></div>' +
      (o.conv ? '<div class="sh-num"><span>환산가 · 경매 예상가</span><b>' + man(r.converted) + '<small>만원</small></b><em>환산 비율 ' + r.rate + '% · ' + esc(r.rateSource) + '</em></div>' : '') +
      '<div class="sh-num"><span>신뢰도</span><b>' + r.grade + '</b><em>비교 매물 ' + r.n + '대 · ' + stepNo + '단계(' + esc(stepName) + ')' + (r.out ? ' · 이상치 제외 ' + r.out + '대' : '') + '</em></div></div>';
    var f = flowData(G, car, c), after = [];                // 한 장에 들어가게 수리비·환산은 막대 대신 한 줄로
    if (r.repair) after.push('수리비 −' + man(r.repair) + '만 → 수리비 반영 <b>' + man(r.price) + '만</b>');
    if (o.conv) after.push('환산 −' + r.rate + '%(' + signed(-r.est * r.rate / 100) + '만 · ' + esc(r.rateSource) + ') → 환산가 <b>' + man(r.converted) + '만</b>');
    h += '<div class="sh-two"><div><div class="sh-h">내 차 위치 <span>' + (km ? '주행' : '차령') + ' × 실제 호가 · 비교 매물 ' + r.comps.length + '대</span></div>' + posLegend() + posSvg(G, car, 350, 262, 'S') + '</div>' +
      '<div><div class="sh-h">보정 흐름 <span>만원 · 보정은 비교 매물 평균</span></div>' + flowBlock(f.rows.slice(0, f.split), '', 'sh') +
      (after.length ? '<div class="sh-after">' + after.join('<br>') + '</div>' : '') + '</div></div>';
    h += '<div class="sh-lines"><div><b>판매 속도</b>' + speedLine(speedData(G)) + '</div><div><b>시세 추세</b>' + trendLine(trendData(G)) + '</div><div><b>같은 모델</b>' + ladderLine(ladderData(G, car, c)) + '</div></div>';
    var top = kept.slice(0, 10);
    h += '<div class="sh-h">비교 매물 상위 ' + top.length + '대 <span>유사도순 · 계산에 쓴 ' + kept.length + '대 중</span></div><table class="sh-tbl"><thead><tr><th class="num">유사도</th><th>등록</th><th class="num">주행</th>' +
      '<th>색상</th><th>등급</th><th>성능</th><th class="num">호가</th><th class="num">보정 후</th><th>상태</th><th class="num">체류</th></tr></thead><tbody>';
    top.forEach(function (x) {
      var row = x.row, trim = F.trims[row[fi.t]];
      h += '<tr><td class="num">' + x.sim + '</td><td>' + ym(row[fi.reg]) + '</td><td class="num">' + (row[fi.km] / 1e4).toFixed(1) + '만</td><td>' + esc(F.colors[row[fi.col]]) + '</td>' +
        '<td><span class="g">' + esc(F.grades[row[fi.g]] + (trim ? ' ' + trim : '')) + '</span></td><td>' + row[fi.perf] + '등급 · ' + esc(F.labels[row[fi.acc]]) + '</td>' +
        '<td class="num">' + man(row[fi.price]) + '</td><td class="num"><b>' + man(x.adj) + '</b></td><td>' + (x.sold ? '판매 ' + mmdd(row[fi.sd]) : '판매중') + '</td>' +
        '<td class="num">' + (x.dwell != null ? x.dwell + '일' : '–') + '</td></tr>';
    });
    h += '</tbody></table>';
    return h + '<div class="sh-foot">근거: 엔카 매물(' + dataDate(true) + ') 중 같은 세부모델 비교 매물 ' + kept.length + '대(판매중 ' + nOn + ' · 최근 3개월 판매 ' + (kept.length - nOn) +
      ')를 이 차 조건으로 맞춘 값. 보정 계수: ' + esc(COEF_LEVEL[r.coefLevel] || r.coefLevel) + '. 추정 시세는 엔카 소매 호가 기준 추정치로 실제 거래가와 다를 수 있습니다. 판매 = 목록에서 사라짐(추정).' +
      (o.conv ? ' 환산가 = 추정 시세 × (1 − 환산 비율) − 수리비(팀 환산 비율).' : '') + (o.url ? '<br>산정 화면: ' + esc(readableUrl()) : '') + '</div>';
  }
  function readableUrl() {                                   // 주소의 한글을 풀어 읽기 쉽게(그대로 붙여 넣어도 열린다)
    try { return decodeURI(location.href); } catch (e) { return location.href; }
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
  function batchCar() {                                     // 묶음 산정 한 줄로 넘길 이 차
    return { name: S.mk + ' ' + S.model + ' ' + S.grade + (S.trim ? ' ' + S.trim : ''), reg: S.m ? S.y + '-' + pad(S.m) : S.y, year: S.y,
      km: S.km, color: S.color, cost: S.cost, rent: S.rent,
      cond: S.cond === '미상' || !S.items.length && S.cond === '입력' ? '' : S.cond === '무사고' ? '무사고' : ISC.toText(S.items) };
  }
  function addToBatch(btn) {                                 // 한 대 산정 → 묶음 산정 목록(기획안 6장) — 같은 차가 이미 있으면 더하지 않는다
    var r = batch().addCar(batchCar());
    btn.outerHTML = '<button type="button" class="v2-btn" data-act="openBatch">' + (r.dup ? '이미 묶음에 있음 · ' : '묶음 산정 열기 · ') + r.n + '대</button>';
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
    inp.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (e.target.id === 'condText') { e.preventDefault(); parseCond(); }
      if (e.target.id === 'nameText') { e.preventDefault(); findName(); }
    });
    function clicks(e) {
      var pt = e.target.closest && e.target.closest('[data-pt]');   // 그림의 비교 매물 점
      if (pt) { showComp(pt.getAttribute('data-pt')); return; }
      var b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-need')) { focusNeed(b.getAttribute('data-need')); return; }
      var k = b.getAttribute('data-seg'), chipK = b.getAttribute('data-chip'), act = b.getAttribute('data-act'), v = b.getAttribute('data-v');
      if (k === 'sort') { VIEW.sort = v; compute(); return; }
      if (k === 'posx') { VIEW.posx = v; compute(); return; }
      if (k === 'mode') { VIEW.mode = v; toHash(); applyMode(); return; }
      if (k === 'mgrade') { VIEW.allGrades = v === 'all'; compute(); return; }
      if (act === 'exClear') { S.ex = []; VIEW.exKeep = {}; changed(); return; }
      if (act === 'xlsx') { exportOne(); return; }
      if (act === 'sheet') { sheetOpen(); return; }
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
      if (act === 'findName') { findName(); return; }
      if (act === 'recent') { VIEW.recentOpen = !VIEW.recentOpen; renderInputs(); return; }
      if (act === 'recentClear') { try { localStorage.removeItem(RECENT); } catch (e) { /* 지우지 못해도 산정은 된다 */ } VIEW.recentOpen = false; renderInputs(); return; }
      if (act === 'pickCand') {                                 // 차명 찾기 다른 후보 고르기
        var c = VIEW.nameCands[+b.getAttribute('data-i')], yi = yearIn(VIEW.nameText), text = yi ? yi.rest : VIEW.nameText;
        if (c) loadFiles([c.file]).then(function () { VIEW.nameCands = []; setModel(c, text, 'pick'); }).catch(fail);
        return;
      }
      if (act === 'clearExtra') { S.items = S.items.filter(posIndex); renderInputs(); changed(); return; }
      if (act === 'reset') { S = blank(); VIEW.all = false; VIEW.condWarn = []; VIEW.condOut = []; VIEW.nameText = ''; VIEW.nameMsg = ''; VIEW.nameCands = []; renderInputs(); changed(); return; }
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
    window.addEventListener('hashchange', function () { sheetClose(); route().catch(fail); });
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
        X.yr = {}; X.yrN = {};                                 // 세부모델 연식 범위(목록에 '(2019~2022)' · 등록 연도 맞춤)
        X.idx.makers.forEach(function (mk) { mk.groups.forEach(function (g) { g.models.forEach(function (m) {
          if (m.y0 && m.y1) X.yr[mk.name + '|' + g.name + '|' + m.name] = m.y0 === m.y1 ? String(m.y0) : m.y0 + '~' + m.y1;
          if (m.y0 && m.y1) X.yrN[mk.name + '|' + g.name + '|' + m.name] = [m.y0, m.y1];
        }); }); });
        ENG = PriceEngine.create({ config: X.idx.engine, coef: X.coef, rates: X.rates });
        ISC = InspectionScore.create(X.model);
        S = fromHash();
        layout();
        marketLine();
        getJSON('market_models.json').then(function (j) {    // 세부모델 시세(시세 추세 한 줄) — 늦게 와도 되므로 따로
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
