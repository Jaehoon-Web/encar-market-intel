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
  var COLOR_SW = { '': 'repeating-conic-gradient(#e7e5e4 0 25%, #fff 0 50%) 0 0/8px 8px', '흰색·진주': 'linear-gradient(135deg, #ffffff, #ece6da)',   // 색상 스와치(기획 v2.27 디자인 D)
    '검정': 'linear-gradient(135deg, #3a3a3a, #0a0a0a)', '회색·은색': 'linear-gradient(135deg, #d4d6da, #8c9099)', '청색': 'linear-gradient(135deg, #4a6fb5, #1e3566)',
    '기타': 'conic-gradient(#ef4444, #f59e0b, #22c55e, #3b82f6, #a855f7, #ef4444)' };
  var FIXES = ['외장', '내장', '광택', '룸클리닝', '휠', '타이어', '유리'];
  var STATUS3 = [['교환', 'X', '교환'], ['판금', 'W', '판금'], ['수리필요', 'R', '수리']];   // 기록부 상태 3가지(기획 v2.32 Q213): 이름 · 주소 기호 · 단추 글
  var OUT_CHIPS = ['앞범퍼', '뒷범퍼', '헤드램프', '리어램프', '앞유리', '사이드미러', '휠'];   // 기록부 밖 수리필요 → 수리비(Q224)
  var CTB = null;                                            // 기록부 감가 · 수리비 표(cond_table.js — 팀 수정 합친 것)
  var COEF_LEVEL = { '모델': '이 세부모델 자체 값', '차급': '같은 차급 평균 값(이 모델 표본이 없어서)', '시장': '시장 평균 값' };
  var SHOW = 10;                                            // 비교 매물 표 기본 행 수(인터뷰 Q40 — 그림 먼저, 표는 10행 + 펼치기)
  var KM_BANDS = [[0, 3e4, '3만 미만'], [3e4, 6e4, '3~6만'], [6e4, 1e5, '6~10만'], [1e5, 1.5e5, '10~15만'], [1.5e5, Infinity, '15만 이상']];
  var X = {}, ENG = null, ISC = null, NM = null, GROUPS = {}, R = null, recentTimer = 0, LAST = null, timer = 0, B = null, RV = null, MK = null, DV = null, MB = '';
  var PV = null;                                             // 마켓 펄스(pulse.js)
  var AV = null;                                             // 관리자(admin.js · 기획 v2.28)
  var VIEW = { sort: 'sim', all: false, mode: 'one', condWarn: [], condOut: [], exKeep: {}, allGrades: false, nameText: '', nameMsg: '', nameCands: [], recentOpen: false,
    posx: 'km', hl: null,                                    // posx: 내 차 위치 그림 가로축(km·age) · hl: 그림에서 누른 비교 매물 ID      // mode: one(한 대 산정) · model(모델 요약) · batch(묶음 산정) · rates(⚙ 환산 비율)
    open: {}, info: {}, carOpen: false, moreOpen: null, recOpen: null, shown: null, shownKey: '', countId: 0, riseKey: '',
    condText: '', condRes: null, condPicks: {}, condAlt: {}, condSave: null, condSaveMsg: '', condTerms: false, condDel: null };   // 기록부 글 읽기(기획 v2.31): 적은 글 · 읽은 결과 · 후보에서 고른 것(조각 원문 → 부위) · '다른 것' 펼침 · 팀 사전 저장 창   // 화면 정리(기획 v2.26·v2.27): open = 처음 접힌 섹션을 펼침 · info = 섹션 i 설명 펼침 · carOpen = 차 고르는 5칸 펼침 · moreOpen = 더 보기 · recOpen = 기록부 입력 창 · shown = 추정 시세 숫자 올라가기 · riseKey = 처음 그릴 때만 떠오르기
  var TIP = {                                                // 용어 설명(결과 카드·비교 매물 표의 ? — 마우스를 올리거나 누르면)
    est: '비슷한 온라인 매물(판매중 + 최근 3개월 판매)의 호가를 이 차 조건으로 맞춘 값(보정 후) 가운데 값입니다. 비슷한 매물일수록 크게 반영합니다. ' +
      '온라인 소매 호가 기준이라 실제 거래가와는 다릅니다. 범위는 실제 호가의 절반쯤이 들어가도록 잡은 구간입니다(보정 후 값의 가운데 50%를 신뢰도 · 성능 상태에 따라 넓힘).',
    conv: '경매에서 받을 만한 값(낙찰가 수준)의 추정입니다. 환산가 = 무사고 시세 × (1 − 경매 기준 사고 감가) × (1 − 환산 비율) − 수리비. ' +
      '경매 기준 사고 감가는 기록부를 넣었을 때 따로 계산하고(상태 미상이면 추정 시세의 감가와 같게), 기록부가 나쁠수록 덜 깎이지 않게 읽습니다 — 손상을 더하거나 판금을 교환으로 바꾸면 환산가가 같거나 낮아지고, 교환·판금이 있으면 상태 미상보다 높지 않습니다. ' +
      '수리비는 직접 넣은 수리비 전부와 수리필요 표준 수리비 중 ⚙에서 정한 몫만 뺍니다. ' +
      '환산 비율은 같은 조건의 경매 낙찰가가 온라인 소매 호가보다 얼마나 낮았는지로 정한 팀 기준입니다(⚙ 환산 비율). 무사고 시세로 비율을 찾고, 기준표는 칸 가운데 값 사이를 이어서 읽어 호가대·차령 경계에서 비율이 뛰지 않습니다.',
    grade: 'A = 비교 매물 10대 이상 · 3단계(차령 ±12개월)까지만 넓힘 · 넓히기 전 가운데 50% 범위가 ±8% 안. B = A가 아니면서 5단계(등급 무관)까지 — 비교 매물이 10대 미만이거나 조건을 더 넓힘. C = 6단계(같은 세부모델 전체)로 넓힌 참고값.',
    step: '비교 매물을 같은 등급·세부등급(트림)·가까운 차령·주행부터 찾고, 5대가 안 되면 범위를 한 단계씩 넓힙니다. 1단계(같은 트림)가 가장 좁은 조건이고, 세부등급을 고르지 않았으면 2단계부터 봅니다. 이름이 「가까운 이름」·「매물 이름」인 매물은 1단계에 쓰지 않습니다.',
    cond: '같은 차가 무사고였다면의 값입니다. 비교 매물은 성능 상태와 무관하게 고르고, 기록부의 교환 · 판금은 이력 감가로, 수리필요는 표준 수리비로 뺍니다(상태 미상은 비교 매물 평균 수준의 감가).',
    sim: '이 차와 얼마나 비슷한지(100 = 가장 비슷). 차령·주행·등급·성능이 가까울수록 높고, 높을수록 추정 시세에 크게 반영됩니다.',
    price: '온라인에 올라온 판매 희망 가격. 판매된 매물은 목록에서 사라지기 전 마지막 호가입니다.',
    adj: '이 매물이 이 차와 조건(차령·주행·색상·렌트·등급·성능·시점)이 같았다면 매겨졌을 호가. 추정 시세는 이 값들의 가운데 값입니다.',
    dwell: '온라인에 올라온 뒤 지난 날수(판매된 매물은 판매까지)',
    cut: '첫 호가보다 내린 금액',
    pos: '점은 비교 매물의 실제 호가입니다(판매된 매물은 목록에서 사라지기 전 마지막 호가). 별은 이 차의 추정 시세, 세로 띠는 추정 범위(25~75%)입니다. ' +
      '점선은 이 차와 다른 조건이 같고 주행(또는 연식)만 다를 때의 값으로, 매주 데이터에서 추정한 보정 계수로 그립니다. 점을 누르면 아래 표의 그 매물로 갑니다.',
    speed: '차급 대비는 이 세부모델과 같은 차급(국산·수입 구분) 전체의 주간 판매율을 비교합니다(±15% 안이면 비슷). 가격 위치별 일수는 최근 3개월에 판매된 비교 매물을 ' +
      '이 차 조건으로 맞춘 값(보정가)이 추정가보다 얼마나 쌌는지·비쌌는지로 나눠, 온라인에 올라온 뒤 목록에서 사라지기까지 걸린 날수의 가운데 값을 보여 줍니다. 판매자가 내린 매물도 섞일 수 있습니다.',
    ladder: '같은 세부모델 안에서 연식·주행, 등급, 성능 상태에 따라 값이 어떻게 달라지는지 봅니다. 시세표와 등급별은 판매중 매물의 호가 가운데 값이고, ' +
      '성능 상태별은 매물을 이 차 조건으로 맞춘 뒤 사고 단계끼리 비교한 값입니다(사고 차 매각가를 잡을 때 참고).',
    flow: '비교 매물 호가의 가운데 값에서 출발해 조건 차이를 맞추는 보정(비교 매물 평균)을 더하면 추정 시세가 됩니다. "나머지"는 가운데 값끼리의 차이로, ' +
      '매물마다 보정이 달라서 생깁니다. 환산가는 무사고 시세에서 경매 기준 사고 감가 · 환산 비율 · 수리비 몫을 뺀 경매 예상가입니다.',
    trend: '시세지수는 그 회차에 새로 올라온 매물(등록 7일 이내)의 첫 호가를 7월 초(7/1~7/15) 같은 모델·등급 매물과 비교한 값입니다. 차령·주행·색상·성능을 맞추므로 ' +
      '시간에 따른 자연 감가는 빠집니다(100보다 낮으면 같은 조건의 차가 7월 초보다 싸게 나온다는 뜻). 세부모델 점은 신규 매물 10대 이상인 회차만 찍고, 옅은 띠는 표본 수로 생기는 ' +
      '흔들림의 2배 범위입니다(흔들림 = 신규 매물 수로 생기는 표준오차, 마켓 펄스·시장 시황과 같은 뜻). 방향은 최근 4주 기울기가 흔들림의 2배를 넘을 때만 오름·내림으로 씁니다. 회색 점선은 같은 차급(국산·수입 구분) 전체입니다.'
  };
  var DOM_ORDER = ['현대', '제네시스', '기아', '쉐보레(GM대우)', '르노코리아(삼성)', 'KG모빌리티(쌍용)', '기타 제조사'];   // 국산 제조사 순서
  var RECENT = 'v2.recent';                                  // 최근 산정(이 브라우저에만)
  var BOOTED = false, ROUTING = false;                       // 화면을 다 그렸나 · 주소로 다시 그리는 중(그동안 입력 칸 change는 무시 — 리뷰 11-05 U1-9)
  var CV = null;                                             // 동급 대비 지표 · 감가 곡선(curve.js)
  var MODES = ['model', 'batch', 'rates'];                  // 주소 view= 로 남는 화면
  var S = blank();

  function blank() {
    return { mk: '', grp: '', model: '', grade: '', trim: '', y: '', m: '', km: '', color: '', rent: false,
      cond: '미상', items: [], mech: '0', fixes: [], cost: '', sold: true, rate: '', ex: [] };
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
  function regText() { return esc(S.m ? S.y + '-' + pad(S.m) : S.y + '년(월 미상 · 6월로 계산)'); }
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
    var comps = /^comps\/g/.test(p) && window.V2Auth;        // 로그인하지 않은 비교 매물 한도는 브라우저마다 센다(로그인 기획 5.4)
    return fetch(DATA + p, comps ? { headers: { 'x-cr-a': V2Auth.anon() } } : undefined).then(function (r) {
      if (r.status === 429) return r.json().catch(function () { return {}; }).then(function (j) { var e = new Error(j.error || '잠시 뒤 다시 해 주세요'); e.code = 'limit'; throw e; });
      if (!r.ok) throw new Error(p + ' ' + r.status);
      if (!/json/i.test(r.headers.get('content-type') || 'json')) throw new Error(p + ' — 파일이 없습니다');   // 없는 파일에 화면 HTML이 오는 경우
      return r.json();
    });
  }
  function kmNum(s) {                                       // "4.2만" · "42,000" · "6만키로" → 42000 (묶음 산정과 같은 읽기)
    var t = String(s == null ? '' : s).replace(/\s|km|㎞|키로/gi, '');   // 한 대 산정만: 86.000 = 86,000(점 쉼표) · 100 미만 소수 = 만km(8.6 → 8.6만) — 리뷰 11-05: 9km · 86km로 읽던 결함
    if (/^\d{1,3}\.\d{3}$/.test(t)) return V2Batch.kmOf(t.replace('.', ''));
    if (/^\d{1,2}\.\d{1,2}$/.test(t)) return V2Batch.kmOf(t + '만');
    return V2Batch.kmOf(s);
  }
  function manNum(s) {                                      // 만원: "30" · "30만" · "500,000원" · "1억" — 단위 없이 1만 이상이면 원(묶음 산정과 같은 읽기, 리뷰 11-05: 300000이 30억으로)
    if (String(s == null ? '' : s).trim() === '') return null;
    var v = V2Batch.costOf(s);
    return v != null && isFinite(v) && v >= 0 ? v : null;
  }
  function rateOf(s) {                                      // 환산 비율 칸 → { v, warn } — 0~60%만 쓰고 밖이면 자동 비율(리뷰 11-05: 150 → 환산가 음수)
    var t = String(s == null ? '' : s).replace(/[%\s]/g, '');
    if (t === '') return { v: null, warn: '' };
    var v = Number(t);
    if (!isFinite(v) || v < 0 || v > 60) return { v: null, warn: '0~60 사이로 넣으세요 — 지금은 자동 비율로 계산' };
    return { v: v, warn: v > 0 && v < 1 ? v + '%로 계산합니다(' + Math.round(v * 100) + '%라면 ' + Math.round(v * 100) + ')' : '' };
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

  // ───── 매물 이름 → 경매 4단계 이름 (기획 v2.23 Q109 — 매물 이름으로 된 옛 주소·최근 산정 기록을 새 이름으로 연다) ─────
  function legacyModel(s) {                                 // 모델그룹·세부모델: index 세부모델의 en(붙은 매물 원래 이름)에서 찾는다
    var mk = X.idx.makers.find(function (m) { return m.name === s.mk; });
    if (!mk || (!s.grp && !s.model)) return null;
    var g0 = mk.groups.find(function (g) { return g.name === s.grp; });
    if (g0 && (!s.model || g0.models.some(function (m) { return m.name === s.model; }))) return null;   // 지금 이름이면 그대로
    var best = null, y = +s.y || 0;
    mk.groups.forEach(function (g) { g.models.forEach(function (m) { (m.en || []).forEach(function (e) {
      if (s.model ? e[1] !== s.model || (e[0] && e[0] !== s.grp && g.name !== s.grp) : e[0] !== s.grp) return;
      var sc = e[2] + (y && y >= e[4] && y <= e[5] ? 1e7 : 0);   // 등록 연도가 맞는 쪽 먼저, 그다음 대수
      if (!best || sc > best.sc) best = { sc: sc, g: g.name, m: m.name };
    }); }); });
    if (!best) return null;
    var from = s.model || s.grp;
    s.grp = best.g;
    if (s.model) s.model = best.m;
    return { from: from, to: s.grp + (s.model ? ' › ' + s.model : '') };
  }
  function legacyGrade(s, G) {                               // 등급·세부등급: 그 세부모델 비교 매물의 매물 원래 등급(파일 머리말 enc)과 가장 많이 짝지은 것
    if (!G || !s.model || !s.grade || !G.F.enc || G.fi.en == null) return null;
    var rows = modelRows(G, s.model), fi = G.fi, c = {}, best = null;
    if (rows.some(function (r) { return G.F.grades[r[fi.g]] === s.grade; })) return null;
    rows.forEach(function (r) {
      var e = String(G.F.enc[r[fi.en]] || '').split('|'), k;
      if (e[1] !== s.grade || (s.trim && e[2] !== s.trim)) return;
      k = r[fi.g] + '|' + r[fi.t];
      c[k] = (c[k] || 0) + 1;
      if (!best || c[k] > c[best]) best = k;
    });
    if (!best) return null;
    var p = best.split('|'), from = s.grade + (s.trim ? ' ' + s.trim : '');
    s.grade = G.F.grades[+p[0]];
    s.trim = G.F.trims[+p[1]] || '';
    return { from: from, to: s.grade + (s.trim ? ' ' + s.trim : '') };
  }
  function legacyNote(a, b) {                                // 바꿔 연 사실을 차명 찾기 아래 안내 줄에
    if (!a && !b) return;
    VIEW.nameMsg = '예전 이름 「' + esc([a && a.from, b && b.from].filter(Boolean).join(' · ')) + '」을 경매 이름 「' +
      esc([a && a.to, b && b.to].filter(Boolean).join(' · ')) + '」으로 바꿔 열었습니다';
  }
  function encNames(mk, grp, model) {                        // 이 세부모델에 붙은 매물 원래 이름 [[매물 모델그룹, 매물 모델, 대수, 가까운 이름 대수, …], …]
    var m = X.idx.makers.find(function (x) { return x.name === mk; }), g = m && m.groups.find(function (x) { return x.name === grp; });
    var e = g && g.models.find(function (x) { return x.name === model; });
    return e && e.en || [];
  }
  function encLine(mk, grp, model) {                         // '매물 표기: 그랜저 하이브리드 (GN7) 590대 · 더 뉴 그랜저 하이브리드 (GN7) 7대(가까운 이름)'
    var en = encNames(mk, grp, model).filter(function (e) { return e[1]; });
    if (!en.length) return '';
    return '매물 표기: ' + en.slice(0, 3).map(function (e) {
      return e[1] + ' ' + e[2].toLocaleString() + '대' + (e[3] >= e[2] / 2 ? '(경매에 없는 이름 — 가까운 이 이름에 붙임)' : '');
    }).join(' · ') + (en.length > 3 ? ' 외' : '');
  }
  function encOfRow(G, row) {                                // 비교 매물 한 대의 매물 원래 이름 { model, grade, trim } — 없으면 null
    if (!G.F.enc || G.fi.en == null) return null;
    var e = String(G.F.enc[row[G.fi.en]] || '').split('|');
    return e.length < 3 ? null : { model: e[0], grade: e[1], trim: e[2] };
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
  function condState() {                                     // 시세 엔진에 넘길 상태(기획 v2.32): 미상 null · 무사고 [] · 기록부 부위
    if (S.cond === '무사고') return { items: [] };
    if (S.cond === '입력' && S.items.length) return { items: S.items };
    return null;
  }
  function isImport() {
    var mk = (X.idx.makers || []).filter(function (m) { return m.name === S.mk; })[0];
    return !!mk && mk.origin === '수입';
  }
  function pctS(v) { return (v < 0 ? '−' : v > 0 ? '+' : '') + Math.abs(v).toFixed(1) + '%'; }
  function condResult() {
    if (S.cond === '미상' || (S.cond === '입력' && !S.items.length)) return ISC.evaluate({ state: '미상' });   // 기록부 입력인데 부위가 없으면 미상(무사고로 치지 않음)
    var input = { state: S.cond === '무사고' ? '무사고' : '입력', items: S.cond === '입력' ? S.items : [], mechLevel: +S.mech };
    return ISC.evaluate(input);
  }

  // ───── 주소 ↔ 입력 ─────
  var KEYS = ['mk', 'grp', 'model', 'grade', 'trim', 'y', 'm', 'km', 'color', 'cost', 'rate'];
  function itemsCode(items) {
    var code = {};
    STATUS3.forEach(function (s) { code[s[0]] = s[1]; });
    return items.map(function (it) { return [it.part, it.side || '', it.pillar || '', code[it.status] || it.status].join('|'); }).join(';');
  }
  function itemsDecode(str) {                                // 옛 주소의 7가지 기호(X·W·절단·U·T·C·A)도 3가지로 읽는다
    var name = { X: '교환', W: '판금', R: '수리필요', '절단': '교환', U: '수리필요', T: '수리필요', C: '수리필요', A: '수리필요' };
    return String(str || '').split(';').filter(Boolean).map(function (x) {
      var p = x.split('|'), it = { part: p[0], side: p[1] || null, pillar: p[2] || null, status: name[p[3]] || CondTable.STATUS3[p[3]] || p[3] };
      if (CTB && !CTB.info(p[0])) it.outside = true;
      return it;
    });
  }
  function query(s, mode) {
    var q = new URLSearchParams();
    KEYS.forEach(function (k) { if (s[k] !== '' && s[k] != null) q.set(k, s[k]); });
    if (s.rent) q.set('rent', '1');
    if (s.cond !== '미상') q.set('cond', s.cond);
    if (s.cond === '입력' && s.items.length) q.set('it', itemsCode(s.items));
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
    VIEW.carKey = S.mk + '|' + S.grp + '|' + S.model;           // 지금 차(주소로 다른 차를 열 때만 기록부 글을 비운다 — route)
    var nav = $('navPrice');                                 // 시장 시황에서 돌아올 때 하던 산정으로
    if (nav) nav.setAttribute('href', query(S, VIEW.mode));
  }
  function fromHash() {
    var h = location.hash, i = h.indexOf('?'), q = new URLSearchParams(i >= 0 ? h.slice(i + 1) : ''), s = blank();
    KEYS.forEach(function (k) { if (q.has(k)) s[k] = q.get(k); });
    if (!/^\d{4}$/.test(s.y)) s.y = '';                       // 주소 값은 남이 만든 링크일 수 있다 — 연·월은 숫자만(화면 글에 그대로 들어가는 곳이 있어서)
    if (!/^(?:[1-9]|1[0-2])$/.test(s.m)) s.m = '';
    s.rent = q.get('rent') === '1';
    s.cond = ['무사고', '입력'].indexOf(q.get('cond')) >= 0 ? q.get('cond') : '미상';
    s.items = itemsDecode(q.get('it'));
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
  function seg(k, opts, cur, aria) {                         // opts = [값, 이름(, 말풍선)]
    return '<div class="segmented" role="group" aria-label="' + aria + '">' + opts.map(function (o) {
      return '<button type="button" data-seg="' + k + '" data-v="' + esc(o[0]) + '" class="' + (String(cur) === String(o[0]) ? 'on' : '') + '"' +
        (o[2] ? ' title="' + esc(o[2]) + '"' : '') + '>' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }

  // ───── 결과 섹션 · 내비게이터(기획 v2.26 · 5.9) — 번호 + 제목 + i(설명은 접어 둠), 오른쪽 목차에 핵심 숫자 ─────
  function sec(id, no, title, info, body, o) {                // o.fold: 처음 접힘 · o.peek: 제목 옆 짧은 숫자 · o.tools: 오른쪽 조작
    o = o || {};
    var folded = !!o.fold && !VIEW.open[id], infoOpen = !!VIEW.info[id], has = info && info.filter(Boolean).length;
    return '<section class="v2-sec' + (folded ? ' is-folded' : '') + '" id="sec-' + id + '" data-sec="' + id + '" aria-labelledby="sech-' + id + '">' +
      '<div class="v2-sech' + (o.headless ? ' v2-sr' : '') + '"><span class="v2-secno" aria-hidden="true">' + (no < 10 ? '0' : '') + no + '</span><h2 id="sech-' + id + '">' + esc(title) + '</h2>' +
      (has && !o.headless ? infoBtn(id, title) : '') +
      (o.peek ? '<span class="v2-peek">' + o.peek + '</span>' : '') +
      '<span class="v2-sectools">' + (folded ? '' : o.tools || '') + (o.fold ? '<button type="button" class="v2-btn v2-foldbtn" data-fold="' + id + '" aria-expanded="' + !folded + '">' +
        (folded ? '펼치기 ▾' : '접기 ▴') + '</button>' : '') + '</span></div>' +
      (has ? '<div class="v2-info" id="info-' + id + '"' + (infoOpen ? '' : ' hidden') + '>' + info.filter(Boolean).map(function (x) {
        return '<p>' + (x[0] ? '<b>' + esc(x[0]) + '</b> ' : '') + esc(x[1]) + '</p>';
      }).join('') + '</div>' : '') + body + '</section>';
  }
  function infoBtn(id, title) {                              // 섹션 i 단추(머리 없는 섹션은 본문 안에 둔다)
    return '<button type="button" class="v2-ibtn" data-info="' + id + '" aria-expanded="' + !!VIEW.info[id] + '" aria-controls="info-' + id + '" aria-label="' + esc(title) + ' 설명">i</button>';
  }
  function navSet(top, items) {                              // top = [[이름, 값, 클래스]] · items = [[id, 번호, 이름, 값]]
    var el = $('snav');
    if (!el) return;
    if (!items) { el.hidden = true; el.innerHTML = ''; return; }
    el.innerHTML = '<div class="nv-top">' + top.map(function (t) { return '<div><span>' + esc(t[0]) + '</span><b class="' + (t[2] || '') + '">' + t[1] + '</b></div>'; }).join('') + '</div>' +
      '<ol>' + items.map(function (x) {
        return '<li><button type="button" data-go="' + x[0] + '"><span class="no">' + x[1] + '</span><span>' + esc(x[2]) + '</span>' + (x[3] ? '<span class="v">' + x[3] + '</span>' : '') + '</button></li>';
      }).join('') + '</ol><button type="button" class="nv-up" data-go="top">↑ 조건 바꾸기</button>';
    el.hidden = false;
    spy();
  }
  function navVal(id, v) {                                   // 나중에 오는 숫자(시장 숫자·감가 곡선)만 그 자리에서 바꾼다
    var b = $('snav') && $('snav').querySelector('[data-go="' + id + '"]');
    if (!b) return;
    var s = b.querySelector('.v');
    if (!v) { if (s) s.remove(); return; }
    if (!s) { s = document.createElement('span'); s.className = 'v'; b.appendChild(s); }
    s.textContent = v;
  }
  var spyRaf = 0;
  function spy() {                                           // 지금 보는 섹션 = 화면 위쪽 선을 지난 마지막 섹션(맨 아래까지 내리면 마지막 섹션)
    spyRaf = 0;
    var nav = $('snav'), bar = $('condbar'), inp = $('inp');
    if (VIEW.recOpen !== false && S.cond === '입력') recAuto();
    if (bar) bar.hidden = !bar.innerHTML || !nav || nav.hidden || !inp || inp.getBoundingClientRect().bottom > hdrBottom() + 8;
    if (!nav || nav.hidden) return;
    var secs = $('res').querySelectorAll('.v2-sec'), lim = window.innerWidth >= 1200 ? 140 : 190, cur = secs[0] || null;
    secs.forEach(function (s) { if (s.getBoundingClientRect().top <= lim) cur = s; });
    if (secs.length && window.innerHeight + window.pageYOffset >= document.documentElement.scrollHeight - 4) cur = secs[secs.length - 1];
    var id = cur && cur.getAttribute('data-sec');
    if (window.CT && R && VIEW.mode === 'one' && cur) CT.depth(Array.prototype.indexOf.call(secs, cur) + 1);   // 이용 통계: 결과 어디까지 봤나
    nav.querySelectorAll('li [data-go]').forEach(function (b) {
      var on = b.getAttribute('data-go') === id;
      if (on === b.classList.contains('on')) return;
      b.classList.toggle('on', on);
      if (on) {
        b.setAttribute('aria-current', 'true');
        if (window.innerWidth < 1200) {                     // 가로 줄에서 지금 섹션이 보이게 — 왼쪽에 붙은 숫자 알약 오른쪽 빈 곳의 가운데로(리뷰 11-05: 휴대폰에서 알약이 탭을 가림)
          var tp = nav.querySelector('.nv-top'), pw = tp ? tp.offsetWidth + 10 : 0;
          var l = b.offsetLeft - pw - (nav.clientWidth - pw) / 2 + b.offsetWidth / 2;
          nav.scrollTo({ left: Math.max(0, l) });
        }
      } else b.removeAttribute('aria-current');
    });
  }
  function hdrBottom() { var hd = document.querySelector('header'); return hd ? hd.getBoundingClientRect().bottom : 54; }
  function goSec(id) {
    if (id === 'top') { window.scrollTo({ top: 0, behavior: 'smooth' }); var nt = $('nameText'); if (nt) nt.focus({ preventScroll: true }); return; }   // 조건은 맨 위(기획 v2.27)
    var el = $('sec-' + id);
    if (!el) return;
    if (el.classList.contains('is-folded')) { foldSec(id); el = $('sec-' + id); }   // 다시 그려 새 요소
    var nav = $('snav'), off = hdrBottom() + (window.innerWidth >= 1200 && $('condbar') && $('condbar').innerHTML ? 56 : 0);
    if (window.innerWidth < 1200 && nav && !nav.hidden) off += nav.offsetHeight;
    window.scrollTo({ top: el.getBoundingClientRect().top + window.pageYOffset - off - 12, behavior: 'smooth' });
  }
  function foldSec(id) {                                     // 접힌 섹션 펼치기·접기 — 내용은 이미 그려 두었으므로 클래스만 바꾼다
    var el = $('sec-' + id);
    if (!el) return;
    VIEW.open[id] = el.classList.contains('is-folded');
    compute();                                               // 도구(정렬 등)·숫자까지 같은 모양으로 다시
  }
  function infoSec(id, b) {
    VIEW.info[id] = !VIEW.info[id];
    var p = $('info-' + id);
    if (p) p.hidden = !VIEW.info[id];
    b.setAttribute('aria-expanded', String(VIEW.info[id]));
  }
  function segLabel(seg) { var s = String(seg || '').split('·'); return s.length > 1 ? s[1] + ' ' + s[0] : String(seg || ''); }   // '대형·국산' → '국산 대형'
  function chip(k, v, label, on) {
    return '<button type="button" class="seg-chip' + (on ? ' on' : '') + '" data-chip="' + k + '" data-v="' + esc(v) + '">' + esc(label) + '</button>';
  }

  function cell(label, html, cls) {                          // 조건 패널 한 칸(기획 v2.27 디자인 D) — 라벨 위, 값 아래
    return '<div class="v2-f v2-ccell' + (cls ? ' ' + cls : '') + '"><span class="v2-l">' + label + '</span>' + html + '</div>';
  }
  function focusSel(el) {                                    // 다시 그린 뒤 같은 칸을 찾을 선택자
    if (!el || !el.getAttribute) return null;
    if (el.id) return '#' + el.id;
    var a = ['data-k', 'data-seg', 'data-chip', 'data-act', 'data-pos', 'data-out'].filter(function (x) { return el.hasAttribute(x); });
    if (!a.length) return null;
    return a.map(function (x) { return '[' + x + '="' + String(el.getAttribute(x)).replace(/["\\]/g, '') + '"]'; }).join('') +
      (el.hasAttribute('data-v') ? '[data-v="' + String(el.getAttribute('data-v')).replace(/["\\]/g, '') + '"]' : '') + (el.hasAttribute('data-i') ? '[data-i="' + el.getAttribute('data-i') + '"]' : '');
  }
  function renderInputs() {                                   // 맨 위 조건 패널(기획 v2.27 Q145): 찾기 → 차(다 고르면 한 줄 경로) → 연식·주행·수리비 → 색상·성능·렌트 → 더 보기
    var ae = document.activeElement, fsel = ae && $('inp') && $('inp').contains(ae) ? focusSel(ae) : null;
    var mk = makerOf(), g = groupOf(), G = grp(), rows = G && S.model ? modelRows(G, S.model) : [], fi = G && G.fi;
    var h = '<div class="v2-crow">' +
      '<div class="v2-search"><span class="ic" aria-hidden="true">⌕</span><input class="v2-in" id="nameText" autocomplete="off" aria-label="차명 한 줄로 찾기" placeholder="차명 한 줄로 찾기 · 예: 그랜저 IG 2.5 프리미엄 2020" value="' +
      esc(VIEW.nameText) + '"><button type="button" class="v2-btn primary" data-act="findName">찾기</button></div>' +
      '<div class="v2-nmsg" id="nameMsg"' + (VIEW.nameMsg ? '>' + VIEW.nameMsg : ' hidden>') + '</div>' + recentHtml() +
      '<div class="v2-cacts"><button type="button" class="v2-btn" data-act="share">링크 복사</button><button type="button" class="v2-btn" data-act="reset">초기화</button>' +
      (S.model ? '' : '<button type="button" class="v2-btn primary" data-act="example">예시로 채워 보기</button>') + '</div></div>';

    var outYr = S.model && S.y && !fits(S.model) ? '<p class="v2-help v2-bad">등록 ' + esc(S.y) + '년은 이 세대' + yrOf(S.mk, S.grp, S.model) + ' 기간 밖입니다 — 다른 세대인지 확인하세요</p>' : '';
    var path = '';
    if (S.model && S.grade && !VIEW.carOpen) {                // 다 골랐으면 한 줄 경로로(Q138·Q145) — 누르면 다시 다섯 칸
      path = '<button type="button" class="v2-path" data-act="carOpen" aria-label="차 다시 고르기"><span class="v2-l">차</span><span class="pv">' +
        esc([S.mk, S.grp, S.model + yrOf(S.mk, S.grp, S.model), S.grade, S.trim || '세부등급 상관없음'].join(' › ')) + '</span><small>바꾸기</small></button>';
    } else {
      var mlab = function (m) { return [m.name, m.name + ' · ' + total(m).toLocaleString() + '대']; };
      var dom = X.idx.makers.filter(function (m) { return m.origin === '국산'; })
        .sort(function (a, b) { return DOM_ORDER.indexOf(a.name) - DOM_ORDER.indexOf(b.name); });
      var imp = X.idx.makers.filter(function (m) { return m.origin !== '국산'; }).sort(function (a, b) { return total(b) - total(a); });
      var mopts = [];
      if (G) {                                                 // 최신 세대부터(같으면 매물 많은 순) — 등록 연도를 넣었으면 맞는 세대가 위로, 안 맞는 세대는 구분선 아래
        var ms = G.F.models.slice().sort(function (a, b) {
          var ra = yrN(a.name) || [0, 0], rb = yrN(b.name) || [0, 0];
          return (fitScore(b.name) - fitScore(a.name)) || (rb[1] - ra[1]) || (rb[0] - ra[0]) || (b.n - a.n);
        });
        ms.forEach(function (x) {
          if (S.y && !fits(x.name) && mopts.length && fits(mopts[mopts.length - 1][0])) mopts.push(['-', '── 등록 ' + S.y + '년과 안 맞는 세대 ──', true]);
          mopts.push([x.name, x.name + yrOf(S.mk, S.grp, x.name) + ' · ' + x.n.toLocaleString() + '대']);
        });
      }
      var grades = rows.length ? countBy(rows, fi.g, G.F.grades) : [], gfuel = gradeFuel(G, rows), fuels = [];
      grades.forEach(function (x) { var f = gfuel[x[0]] || '기타'; if (fuels.indexOf(f) < 0) fuels.push(f); });
      var glab = function (x) { return [x[0], x[0] + ' · ' + x[1].toLocaleString() + '대']; };
      var trims = S.grade && rows.length ? countBy(rows.filter(function (r) { return G.F.grades[r[fi.g]] === S.grade; }), fi.t, G.F.trims)
        .filter(function (x) { return x[0]; }) : [];              // 주소로 열 때는 모델그룹 파일을 받기 전에도 그린다
      h += '<div class="v2-cgrid">' +
        cell('제조사', selG('mk', ['', '제조사 선택'], [{ label: '국산', opts: dom.map(mlab) }, { label: '수입 · 많은 순', opts: imp.slice(0, 8).map(mlab) },
          { label: '수입 · 가나다순', opts: imp.slice(8).sort(function (a, b) { return a.name.localeCompare(b.name, 'ko'); }).map(mlab) }], S.mk)) +
        cell('모델', sel('grp', [['', mk ? '모델 선택' : '—']].concat((mk ? mk.groups.slice().sort(byN) : []).map(function (x) {
          return [x.name, x.name + ' · ' + x.n.toLocaleString() + '대'];
        })), S.grp, !mk)) +
        cell('세부모델', sel('model', [['', G ? '세부모델 선택' : (g ? '불러오는 중…' : '—')]].concat(mopts), S.model, !G)) +
        cell('등급', fuels.length > 1                         // 연료가 둘 이상이면 연료로 묶는다— 많은 연료부터
          ? selG('grade', ['', '등급 선택'], fuels.map(function (f) {
            return { label: f, opts: grades.filter(function (x) { return (gfuel[x[0]] || '기타') === f; }).map(glab) };
          }), S.grade, !S.model)
          : sel('grade', [['', S.model ? '등급 선택' : '—']].concat(grades.map(glab)), S.grade, !S.model)) +
        cell('세부등급', sel('trim', [['', trims.length ? '상관없음' : '—']].concat(trims.map(function (x) {
          return [x[0], x[0] + ' · ' + x[1].toLocaleString() + '대'];
        })), S.trim, !trims.length)) + '</div>' + outYr;
    }

    var years = [];                                            // 세부모델 전이면 모델그룹 전체 연도 — 연도를 먼저 넣으면 맞는 세대가 위로 온다
    (rows.length ? rows : G ? G.F.rows : []).forEach(function (r) { var y = Math.floor(r[fi.reg] / 100); if (years.indexOf(y) < 0) years.push(y); });
    var has = years.slice(), yn = S.model ? yrN(S.model) : null, nowY = new Date().getFullYear();
    if (yn) for (var yy = yn[0] - 1; yy <= Math.min(nowY, yn[1] + 1); yy++) if (years.indexOf(yy) < 0) years.push(yy);
    if (S.y && years.indexOf(+S.y) < 0) years.push(+S.y);
    years.sort(function (a, b) { return b - a; });
    var kmv = kmNum(S.km);
    h += '<div class="v2-cgrid' + (path ? ' v2-cgrid-path' : '') + '">' + path +
      cell('최초등록 · 월 모르면 6월', '<div class="v2-two">' + sel('y', [['', '연도']].concat(years.map(function (y) { return [y, y + '년' + (rows.length && has.indexOf(y) < 0 ? ' (매물 없음)' : '')]; })), S.y, !G) +
        sel('m', [['', '월 모름']].concat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(function (m) { return [m, m + '월']; })), S.m, !G) + '</div>') +
      cell('주행거리', '<div class="v2-unit"><input class="v2-in" data-k="km" inputmode="numeric" autocomplete="off" placeholder="42,000" value="' +
        esc(kmv != null && /^\d+$/.test(String(S.km).trim()) ? kmv.toLocaleString('ko-KR') : S.km) + '"><span>km</span></div><p class="v2-rate" id="kmNote" hidden></p>', 'v2-ccell-km') +
      cell('예상 수리비', '<div class="v2-unit"><input class="v2-in" data-k="cost" inputmode="numeric" autocomplete="off" placeholder="0" title="시세·환산가에서 그대로 뺍니다" value="' +
        esc(S.cost) + '"><span>만원</span></div><p class="v2-rate v2-bad" id="costNote" hidden></p>') + '</div>' + (path ? outYr : '');

    h += '<div class="v2-crow3"><div class="v2-cgroup"><span class="v2-glabel">색상</span><div class="v2-cpills" role="group" aria-label="색상">' +
      [['', '상관없음']].concat(COLORS.map(function (c) { return [c, c]; })).map(function (c) {
        var on = S.color === c[0];
        return '<button type="button" class="v2-cpill' + (on ? ' on' : '') + '" data-chip="color" data-v="' + esc(c[0]) + '" aria-pressed="' + on + '">' +
          '<span class="sw" style="background:' + COLOR_SW[c[0]] + '"></span>' + esc(c[1]) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="v2-cgroup"><span class="v2-glabel">성능 상태</span>' + seg('cond', [['미상', '미상', '넣지 않음 — 비교 매물 평균 수준의 사고 감가(가장 가벼운 사고 감가를 넘지 않음)로 계산하고, 무사고라면 값을 함께 보여 줍니다'],
        ['무사고', '무사고', '이상 없음을 직접 고름'], ['입력', '기록부 입력', '성능·상태점검기록부 부위 37곳을 옮겨 적습니다(한 부위에 여러 상태면 가장 심한 것) — 다시 누르면 접고 펼칩니다']], S.cond, '성능 상태') + '</div>' +
      '<label class="v2-toggle"><input type="checkbox" data-k="rent"' + (S.rent ? ' checked' : '') + '><span class="trk" aria-hidden="true"></span>렌트 번호판(하·허·호)</label></div>';
    if (S.cond === '입력') h += recOpen() ? condPanel() : recSum();
    h += '<div class="notebox v2-condout" id="condOut"></div>';

    var nonDef = S.mech !== '0' || S.fixes.length > 0 || !S.sold || S.rate !== '';   // 기본값이 아니면 더 보기를 펼쳐 둔다(바꾼 것이 숨지 않게)
    h += '<details class="v2-more"' + ((VIEW.moreOpen == null ? nonDef : VIEW.moreOpen) ? ' open' : '') + '><summary>더 보기 <small>수리 상태 · 환산 비율 · 최근 판매</small>' +
      (nonDef ? '<i>바꾼 값 있음</i>' : '') + '</summary><div class="v2-cgrid">' +
      cell('기계 결함', seg('mech', [['0', '없음'], ['1', '경미', '표시만 — 호가 영향이 거의 없음'], ['2', '결함', '표시만 — 호가 영향이 거의 없음']], S.mech, '기계 결함')) +
      cell('환산 비율', '<div class="v2-unit"><input class="v2-in" data-k="rate" inputmode="decimal" autocomplete="off" placeholder="비우면 자동" value="' + esc(S.rate) +
        '"><span>%</span></div><p class="v2-rate" id="rateNote"></p>') + '</div>' +
      '<div class="v2-cgrid">' + cell('수리 필요 · 기록용', '<div class="v2-chips">' + FIXES.map(function (f) { return chip('fix', f, f, S.fixes.indexOf(f) >= 0); }).join('') + '</div>' +
        (S.fixes.length && !manNum(S.cost) ? '<p class="v2-note">값에는 예상 수리비만 반영됩니다</p>' : ''), 'v2-ccell-wide') + '</div>' +
      '<label class="v2-toggle"><input type="checkbox" data-k="sold"' + (S.sold ? ' checked' : '') + '><span class="trk" aria-hidden="true"></span>최근 3개월 판매 매물 포함</label></details>';
    $('inp').innerHTML = h;
    updateCond();
    markNeed(missing());
    if (fsel) { try { var fe = $('inp').querySelector(fsel); if (fe) fe.focus({ preventScroll: true }); } catch (e) { /* 못 찾으면 그대로 */ } }
  }

  function posBtns(i, cur, lab) {                            // 37곳 한 칸: — · 교환 · 판금 · 수리(Q214)
    return '<span class="v2-ps" role="group" aria-label="' + esc(lab) + '">' + [['', '—']].concat(STATUS3.map(function (x) { return [x[0], x[2]]; })).map(function (x) {
      var on = cur === x[0];
      return '<button type="button" class="' + (on ? 'on' : '') + (x[0] ? ' s-' + x[2] : '') + '" data-pos="' + i + '" data-v="' + esc(x[0]) + '" aria-pressed="' + on + '">' + x[1] + '</button>';
    }).join('') + '</span>';
  }
  function outAt(o) { return S.items.some(function (it) { return it.part === o && it.status === '수리필요'; }); }
  function outWon(o) { return CTB.repair([{ part: o, status: '수리필요' }], isImport()).sum; }
  function condPanel() {
    var boards = [];
    ISC.positions.forEach(function (p, i) {
      var b = boards[boards.length - 1];
      if (!b || b.name !== p.board) boards.push(b = { name: p.board, list: [] });
      b.list.push(i);
    });
    var h = '<div class="v2-cond v2-rec" id="recPanel"><div class="v2-rec-h"><b>성능·상태점검기록부</b><span id="recCount">' + (S.items.length ? S.items.length + '곳 입력' : '부위 입력 전') + '</span>' +
      '<button type="button" class="v2-link" data-act="recFold" aria-expanded="true">접기 ▴</button></div><div class="v2-text v2-text2"><textarea class="v2-in" id="condText" rows="2" spellcheck="false" autocomplete="off" ' +
      'aria-label="기록부 글로 적기" placeholder="글로 적기 — 좌앞휀다 판, 본넷 교, 운전석 뒷도어 교환 (치는 대로 읽습니다)">' + esc(VIEW.condText) + '</textarea></div>' +
      '<div class="v2-msg" id="condMsg">' + condMsgHtml() + '</div>';
    boards.forEach(function (b) {
      h += '<div class="v2-board"><div class="v2-board-t">' + esc(b.name) + '</div><div class="v2-pos">';
      b.list.forEach(function (i) {
        var p = ISC.positions[i], cur = statusAt(p);
        h += '<div class="v2-p' + (cur ? ' set' : '') + '" data-pi="' + i + '"><span title="' + esc(p.label) + '">' + esc(p.label) + '</span>' + posBtns(i, cur, p.label) + '</div>';
      });
      h += '</div></div>';
    });
    h += '<div class="v2-board"><div class="v2-board-t">기록부 밖 수리필요 <small>범퍼 · 램프 · 유리 … — 표준 수리비를 뺍니다</small></div><div class="v2-outs" id="recOuts">' + outsHtml() + '</div></div>';
    return h + '<div id="recExtra">' + extraHtml() + '</div></div>';
  }
  function outsHtml() {
    return OUT_CHIPS.map(function (o) {
      var on = outAt(o);
      return '<button type="button" class="v2-cpill' + (on ? ' on' : '') + '" data-out="' + esc(o) + '" aria-pressed="' + on + '">' + esc(o) + ' <small>' + outWon(o) + '만</small></button>';
    }).join('');
  }
  function extraHtml() {                                     // 아래 37곳에 없는 부위(글에서 읽은 앞뒤 모를 도어 · 위치 모를 필러 · 칩에 없는 기록부 밖 부위 등)
    var extra = S.items.filter(function (it) { return !posIndex(it) && !(it.outside && OUT_CHIPS.indexOf(it.part) >= 0 && !it.side); });
    return extra.length ? '<p class="v2-help">목록 밖 부위(글에서 읽음): ' + esc(ISC.summary(extra)) +
      ' <button type="button" class="v2-btn" data-act="clearExtra">지우기</button></p>' : '';
  }

  function recOpen() { return VIEW.recOpen != null ? VIEW.recOpen : !S.items.length; }   // 부위를 넣은 채로 열면(주소·최근 산정) 접어 둔다
  function recSum() {                                        // 접힌 기록부 — 한 줄 요약, 누르면 다시 펼침(기획 v2.27)
    return '<button type="button" class="v2-recsum" data-act="recUnfold" aria-expanded="false"><b>성능·상태점검기록부</b><span>' +
      (S.items.length ? S.items.length + '곳 · ' + esc(ISC.summary(S.items)) : '부위 입력 전 — 상태 미상으로 계산') + '</span><em>펼치기 ▾</em></button>';
  }
  function recAuto() {                                       // 펼친 기록부 창을 다 지나 아래로 내려가면 접는다 — 보던 화면은 그 자리에
    var rp = $('recPanel');
    if (!rp || !rp.offsetParent || rp.getBoundingClientRect().bottom > hdrBottom()) return;   // 다른 화면(숨김)에서는 그대로
    var res = $('res'), y0 = res.getBoundingClientRect().top, bd = document.body;
    bd.style.overflowAnchor = 'none';                        // 브라우저의 스크롤 고정과 겹쳐 두 번 움직이지 않게 직접 맞춘다
    VIEW.recOpen = false;
    renderInputs();
    window.scrollBy(0, res.getBoundingClientRect().top - y0);
    requestAnimationFrame(function () { bd.style.overflowAnchor = ''; });
  }

  // A. 차명 한 줄 → 제조사·모델·세부모델·등급·세부등급(묶음 산정과 같은 D5 매칭). 연도를 적으면 등록 연도로도 쓴다
  function nameParts(raw) {                                  // 차명 글 → { text(차명만), reg: { y, m, guess }, km }
    var pf = V2Batch.pullFromText(raw);                      // 묶음 산정과 같은 읽기
    if (pf.reg && pf.reg.guess && nameYear(pf.reg.y, raw)) {  // 그 연도가 적힌 제조사의 모델 이름이면(푸조 2008) 연식이 아니라 차명
      var only = V2Batch.pullFromText(raw.replace(new RegExp('(^|\\s)' + pf.reg.y + '(?=\\s|$)'), ' '));
      if (!only.reg) return { text: (only.text + ' ' + pf.reg.y).trim(), reg: null, km: pf.km };
    }
    return pf;
  }
  function nameYear(y, raw) {                                // 글에 적힌 제조사에 그 숫자 이름의 모델이 있나(푸조 2008 · 3008) — 그랜저 2008은 연식
    var re = new RegExp('(^|[^0-9])' + y + '([^0-9]|$)'), t = String(raw).replace(/\s/g, '').toUpperCase();
    return X.idx.makers.some(function (mk) {
      var names = [mk.name].concat(mk.name.match(/[^()]+/g) || []).map(function (n) { return n.replace(/\s/g, '').toUpperCase(); });
      return names.some(function (n) { return n.length >= 2 && t.indexOf(n) >= 0; }) && mk.groups.some(function (g) { return re.test(g.name); });
    });
  }
  function findName() {
    var raw = $('nameText').value.trim(), np = nameParts(raw), text = np.text || raw;
    VIEW.nameText = raw;
    if (!raw) return;
    var year = np.reg ? np.reg.y : (S.y ? +S.y : null);
    NM = NM || NameMatch.create(X.idx);
    var res0 = NM.model(text, year);
    if (!res0.best) { VIEW.nameMsg = '<span class="v2-bad">못 찾았습니다 — 아래에서 직접 고르세요</span>'; VIEW.nameCands = []; VIEW.carOpen = true; renderInputs(); return; }
    var top = res0.best.score, files = [];
    res0.cands.forEach(function (c) { if (c.score >= top - 2.5 && files.indexOf(c.file) < 0) files.push(c.file); });
    $('nameMsg').hidden = false;
    $('nameMsg').textContent = '찾는 중…';
    loadFiles(files).then(function () {
      var res = NM.refine(res0, text, year, function (f) { return GROUPS[f] || null; });
      if (S.model && (res.best.maker !== S.mk || res.best.model !== S.model)) {   // 다른 차를 찾았으면 이전 차의 기록부 · 수리비를 넘기지 않는다(리뷰 11-05 U1-4)
        newCar();
        VIEW.keptNote = np.km == null && !!(S.km || S.color);   // 주행 · 색상을 남겼으면 알린다
        if (!np.reg) S.m = '';
      }
      if (np.reg) { S.y = String(np.reg.y); S.m = np.reg.guess ? '' : String(np.reg.m); }
      if (np.km != null) S.km = String(np.km);
      VIEW.nameCands = res.conf === 'high' ? [] : res.cands.filter(function (c) { return c !== res.best; }).slice(0, 3);
      return loadFiles([res.best.file]).then(function () { setModel(res.best, text, res.conf); });   // 다시 고른 1등이 창 밖 후보일 수도 있다
    }).catch(fail);
  }
  function loadFiles(files) {
    return Promise.all(files.map(function (f) { return GROUPS[f] ? null : getJSON('comps/' + f).then(function (F) { GROUPS[f] = ENG.group(F); }); }));
  }
  function newCar() {                                        // 다른 차 — 성능 상태 · 기록부 · 수리비 · 찾기 안내를 비운다(주행 · 색상 · 연식은 둔다)
    S.cond = '미상'; S.items = []; S.cost = ''; S.fixes = []; S.ex = []; VIEW.exKeep = {}; VIEW.recOpen = null;
    resetRec();
    VIEW.nameMsg = ''; VIEW.nameCands = [];
  }
  function setModel(b, text, conf) {                         // 찾은(고른) 세부모델로 다섯 칸을 채운다
    var G = GROUPS[b.file], gr = G ? NM.grade(G, b.model, text) : null, lab = esc(b.maker + ' › ' + b.group + ' › ' + b.model) + yrOf(b.maker, b.group, b.model);
    S.mk = b.maker; S.grp = b.group; S.model = b.model; S.grade = gr ? gr.grade : ''; S.trim = gr ? gr.trim || '' : ''; S.ex = []; VIEW.exKeep = {}; VIEW.carOpen = false;
    VIEW.carKey = S.mk + '|' + S.grp + '|' + S.model;           // 주소가 바뀌어도(route) 이 안내는 남긴다
    var g = gr ? ' · ' + esc(gr.grade + (gr.trim ? ' ' + gr.trim : '')) : ' · 등급은 직접 고르세요';
    VIEW.nameMsg = (conf === 'high' ? '찾음: <b>' + lab + g + '</b>' : conf === 'pick' ? '고름: <b>' + lab + g + '</b>' :
      '<span class="v2-warnt">확인 필요</span> <b>' + lab + g + '</b>') + (gr && gr.conf === 'low' ? ' — 등급은 확인하세요' : '') +
      (VIEW.nameCands.length ? '<br>다른 후보: ' + VIEW.nameCands.map(function (c, i) {
        return '<button type="button" class="v2-btn v2-cand" data-act="pickCand" data-i="' + i + '">' + esc(c.model) + yrOf(c.maker, c.group, c.model) + '</button>';
      }).join('') : '') + (VIEW.keptNote ? '<br><span class="v2-dim">주행 · 색상은 이전 차 값 그대로입니다 — 다르면 고치세요(기록부 · 수리비는 비웠습니다)</span>' : '');
    VIEW.keptNote = false;
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
  function recentList() { try { return JSON.parse(localStorage.getItem(RECENT) || '[]'); } catch (e) { return []; } }
  function saveRecent() {                                    // 결과가 나온 차를 이 브라우저에 최근 10대로(같은 조건이면 맨 위로)
    if (!R || !LAST || !S.model) return;
    var hash = query(S, 'one'), list = recentList().filter(function (x) { return x.hash !== hash; });
    list.unshift({ hash: hash, label: S.mk + ' ' + S.model + ' ' + S.grade + (S.trim ? ' ' + S.trim : ''), sub: regText() + ' · ' + (kmNum(S.km) / 1e4).toFixed(1) + '만km',
      price: Math.round(R.price), conv: Math.round(R.converted), at: Date.now() });
    try { localStorage.setItem(RECENT, JSON.stringify(list.slice(0, 10))); } catch (e) { /* 저장 못 해도 산정은 된다 */ }
  }
  function recentHtml() {                                    // 최근 산정— 누르면 그 차를 다시 연다
    var rl = recentList();
    if (!rl.length) return '';
    var when = function (t) { var d = new Date(t); return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
    return '<div class="v2-recent"><button type="button" class="v2-link" data-act="recent">최근 산정 ' + rl.length + '대 ' + (VIEW.recentOpen ? '▴' : '▾') + '</button>' +
      (VIEW.recentOpen ? '<ul>' + rl.map(function (x) {
        return '<li><a href="' + esc(x.hash) + '">' + esc(x.label) + '</a><span>' + esc(x.sub) + ' · 추정 ' + man(x.price) + '만 · 환산 ' + man(x.conv) + '만 · ' + when(x.at) + '</span></li>';
      }).join('') + '</ul><button type="button" class="v2-link" data-act="recentClear">기록 지우기</button>' : '') + '</div>';
  }

  // ───── 기록부 글 읽기(기획 v2.31 5.14 · 인터뷰 Q198~Q212) — 치는 대로 읽고, 조각마다 읽은 것 · 짐작 · 못 읽음(후보)을 한 줄씩 ─────
  var TERMS = { store: false, writable: false, team: null }, TERM_PW = '', condTimer = null;   // 팀 표기 사전(/api/terms) · 이번 방문 동안 기억하는 비밀번호
  function termList() { return TERMS.team && TERMS.team.items || []; }
  function condParse(text) {
    var picks = {};
    Object.keys(VIEW.condPicks).forEach(function (k) { picks[k] = VIEW.condPicks[k].items; });
    return ISC.parseText(text, { terms: termList(), picks: picks, status3: true });
  }
  function condLive() { clearTimeout(condTimer); VIEW.condSaveMsg = ''; condTimer = setTimeout(applyCondText, 250); }   // 치다가 0.25초 쉬면
  function applyCondText() {
    clearTimeout(condTimer);
    var el = $('condText');
    if (el) VIEW.condText = el.value;
    var prev = VIEW.condRes && VIEW.condRes.state === '입력' ? VIEW.condRes.items : [];
    var others = S.items.filter(function (it) { return !prev.some(function (p) { return key(p) === key(it) && p.status === it.status; }); });   // 글이 아닌 곳(단추 · 칩 · 주소)에서 온 부위
    var r = VIEW.condRes = VIEW.condText.trim() ? condParse(VIEW.condText) : null, mine = r && r.state === '입력' ? r.items : [];
    S.items = mine.filter(function (it) { return !others.some(function (o) { return key(o) === key(it); }); }).concat(others);
    VIEW.condWarn = r ? r.unknown : []; VIEW.condOut = r ? r.outside || [] : [];
    refreshRec();
    changed();
  }
  function syncText() {                                      // 글 칸을 쓰고 있으면 단추로 바꾼 부위를 글에도 — 글이 늘 지금 부위와 같게(못 읽은 조각은 뒤에 남김)
    if (!VIEW.condText.trim()) return;
    VIEW.condText = [condLine(S.items)].concat(VIEW.condWarn || []).filter(Boolean).join(', ');
    VIEW.condRes = condParse(VIEW.condText);
    var el = $('condText');
    if (el) el.value = VIEW.condText;
  }
  function resetRec() {                                      // 기록부 글 · 읽은 결과 · 고른 후보 · 팀 사전 창을 비운다(다른 차로 넘어갈 때)
    VIEW.condText = ''; VIEW.condRes = null; VIEW.condPicks = {}; VIEW.condAlt = {}; VIEW.condWarn = []; VIEW.condOut = [];
    VIEW.condSave = null; VIEW.condSaveMsg = ''; VIEW.condDel = null;
  }
  function refreshRec() {                                    // 입력 칸은 그대로 두고(치는 중) 부위 칸 · 머리 숫자 · 목록 밖 부위 · 읽은 결과만 바꾼다
    var rp = $('recPanel');
    if (!rp) { renderInputs(); return; }
    rp.querySelectorAll('.v2-p[data-pi]').forEach(function (el) {
      var p = ISC.positions[+el.getAttribute('data-pi')], cur = statusAt(p);
      el.classList.toggle('set', !!cur);
      el.querySelectorAll('button[data-pos]').forEach(function (b) { var on = b.getAttribute('data-v') === cur; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    });
    var ro = $('recOuts');
    if (ro) ro.innerHTML = outsHtml();
    $('recCount').textContent = S.items.length ? S.items.length + '곳 입력' : '부위 입력 전';
    $('recExtra').innerHTML = extraHtml();
    $('condMsg').innerHTML = condMsgHtml();
    updateCond();
  }
  function condMsgHtml() {
    var r = VIEW.condRes, h;
    if (!r) h = '<span class="v2-dim">줄임말 · 오타도 읽습니다(펜터 · 헨다 → 휀더, 교 · 판 → 교환 · 판금, FL · RR, 운전석 · 조수석). [교환] 본넷, 앞휀다처럼 상태를 앞에 써도 됩니다.</span>';
    else {
      h = '<ol class="v2-rd" aria-label="읽은 결과">' + r.tokens.map(condRow).join('') + '</ol>';
      r.notes.filter(function (n) { return /두 번|'경미'/.test(n); }).forEach(function (n) { h += '<p class="v2-help">' + esc(n) + '</p>'; });
      if (r.state === '무사고' && !r.items.length) h += '<p class="v2-help">기록부 37곳에 해당하는 손상이 없습니다 <button type="button" class="v2-btn" data-act="condClean">무사고로 바꾸기</button></p>';
    }
    if (VIEW.condSaveMsg) h += '<p class="v2-help rd-done">' + VIEW.condSaveMsg + '</p>';
    var tl = termList();
    if (tl.length) {                                         // 팀 표기 사전 보기 · 지우기(잘못 넣은 것)
      h += '<p class="v2-help rd-terms"><button type="button" class="v2-link" data-act="condTerms" aria-expanded="' + !!VIEW.condTerms + '">팀 표기 사전 ' + tl.length + '개 ' + (VIEW.condTerms ? '▴' : '▾') + '</button></p>';
      if (VIEW.condTerms) {
        h += '<ul class="rd-tl">' + tl.map(function (x, i) {
          var what = x.kind === 'part' ? x.part + (x.side ? '(' + x.side + ')' : '') + (x.pillar ? '(' + x.pillar + ')' : '') : x.kind === 'status' ? x.status : x.kind;
          return '<li><b>' + esc(x.t) + '</b> = ' + esc(what) + ' <small>' + esc(x.by || '') + ' · ' + esc(RatesStore.kst(x.at).slice(0, 10)) + '</small>' +
            (TERMS.writable ? ' <button type="button" class="v2-link" data-act="condTermDel" data-i="' + i + '">지우기</button>' : '') +
            (VIEW.condDel === i ? delForm(x) : '') + '</li>';
        }).join('') + '</ul>';
      }
    }
    return h;
  }
  function termWho() {                                       // 팀 사전 저장 칸 — '설정 수정' 권한이 있는 회원이면 이름 · 공용 비밀번호 없이(로그인 기획 Q272)
    var u = window.V2Auth && V2Auth.canEdit() ? V2Auth.user() : null;
    if (u) return '<span class="rd-me">' + esc(u.name) + '(로그인)으로</span><input type="hidden" id="termBy" value="' + esc(u.name) + '"><input type="hidden" id="termPw" value="">';
    var by = ''; try { by = localStorage.getItem('v2.rates.by') || ''; } catch (e) { /* 없어도 된다 */ }
    return '<input class="v2-in" id="termBy" autocomplete="name" placeholder="이름" value="' + esc(by) + '">' +
      '<input class="v2-in" id="termPw" type="password" autocomplete="current-password" placeholder="수정 비밀번호" value="' + esc(TERM_PW) + '">';
  }
  function delForm(x) {
    return '<span class="rd-save"><b>사전에서 지울 표기: \'' + esc(x.t) + '\'</b>' + termWho() +
      '<button type="button" class="v2-btn primary" data-act="condTermDelGo">지우기</button><button type="button" class="v2-link" data-act="condSaveClose">닫기</button><em id="termMsg"></em></span>';
  }
  function guessTxt(t) {
    return t.guess.map(function (g) { return g.from === '좌우' ? g.to : "'" + g.from + "' → " + g.to; }).join(' · ') || (t.inh === 'later' ? '상태는 뒤 조각에서' : '');
  }
  function condRow(t, k) {
    var b = '', body, extra = '', cands = '';
    function candBtns(list) {
      return list.map(function (c, ci) {
        return '<button type="button" class="v2-btn v2-cand" data-act="condPick" data-t="' + k + '" data-c="' + ci + '">' + esc(c.label) + '</button>';
      }).join('');
    }
    if (t.kind === 'ok') body = esc(t.label);
    else if (t.kind === 'guess') {
      b = '<i class="rd-g">짐작</i>';
      body = esc(t.label) + ' <small>' + esc(guessTxt(t)) + '</small>';
      if (t.cands.length) {
        extra = VIEW.condAlt[t.text] ? '<span class="rd-c">다른 것: ' + candBtns(t.cands) + '</span>'
          : '<button type="button" class="v2-link" data-act="condAlt" data-t="' + k + '">다른 것 ▾</button>';
      }
    } else if (t.kind === 'picked') {
      var pk = VIEW.condPicks[t.text] || {};
      b = '<i class="rd-p">고름</i>';
      body = esc(t.label);
      extra = '<button type="button" class="v2-link" data-act="condUnpick" data-t="' + k + '">되돌리기</button>' +
        (pk.save && TERMS.writable && !pk.saved ? '<button type="button" class="v2-link" data-act="condSaveOpen" data-t="' + k + '">팀 사전에 저장</button>' : '');
      if (VIEW.condSave === t.text) extra += termForm(pk.save);
    } else if (t.kind === 'outside') { b = '<i class="rd-o">계산 제외</i>'; body = '기록부 밖 부위(' + esc(t.label) + ')'; }
    else if (t.kind === 'paint') { b = '<i class="rd-o">계산 제외</i>'; body = '도색만 — 기록부에 안 적히는 항목'; }
    else if (t.kind === 'header') body = esc(t.label);
    else if (t.kind === 'clean') { b = '<i class="rd-o">무시</i>'; body = '이상 없음 — 다른 부위가 함께 있어 무시'; }
    else if (t.kind === 'ignore') body = '<span class="v2-dim">읽을 부위 없음</span>';
    else {
      b = '<i class="rd-b">못 읽음</i>';
      body = esc(t.why) + (t.cands.length ? ' — 맞는 것을 고르세요' : ' — 고쳐 써 주세요');
      cands = t.cands.length ? '<span class="rd-c">' + candBtns(t.cands) + '</span>' : '';
    }
    return '<li class="rd-' + t.kind + '"><span class="rd-src">' + esc(t.text) + '</span><span class="rd-ar" aria-hidden="true">→</span><span class="rd-res">' + b + body +
      '</span>' + (extra || cands ? '<span class="rd-x">' + extra + cands + '</span>' : '') + '</li>';
  }
  function termForm(save) {                                  // 팀 표기 사전에 저장 — 환산 비율과 같은 비밀번호(인터뷰 Q209)
    var what = save.kind === 'part' ? save.part + (save.side ? '(' + save.side + ')' : '') + (save.pillar ? '(' + save.pillar + ')' : '') : save.status;
    return '<span class="rd-save"><b>\'' + esc(save.t) + '\' = ' + esc(what) + '</b> 다음부터 팀 모두가 이렇게 읽습니다' + termWho() +
      '<button type="button" class="v2-btn primary" data-act="condSave">저장</button><button type="button" class="v2-link" data-act="condSaveClose">닫기</button>' +
      '<em id="termMsg"></em></span>';
  }
  function condAct(act, el) {                                // 결과 줄의 단추들
    var r = VIEW.condRes, t = r && r.tokens[+el.getAttribute('data-t')];
    if (act === 'condClean') { S.cond = '무사고'; S.items = []; VIEW.condWarn = []; VIEW.recOpen = null; renderInputs(); changed(); return; }
    if (act === 'condTerms') { VIEW.condTerms = !VIEW.condTerms; VIEW.condDel = null; $('condMsg').innerHTML = condMsgHtml(); return; }
    if (act === 'condTermDel') { VIEW.condDel = +el.getAttribute('data-i'); $('condMsg').innerHTML = condMsgHtml(); return; }
    if (act === 'condTermDelGo') {
      var x = termList()[VIEW.condDel], by0 = ($('termBy').value || '').trim(), pw0 = $('termPw').value;
      if (!x) return;
      if (!by0) { $('termMsg').textContent = '이름을 넣어 주세요'; $('termBy').focus(); return; }
      $('termMsg').textContent = '지우는 중…';
      RatesStore.save('/api/terms', { password: pw0, by: by0, del: [x.t] }).then(function (team) {
        TERM_PW = pw0; TERMS.team = team; VIEW.condDel = null;
        VIEW.condSaveMsg = "팀 사전에서 지웠습니다: '" + esc(x.t) + "'";
        applyCondText();
      }).catch(function (e) { var m = $('termMsg'); if (m) m.textContent = e.message || '지우지 못했습니다'; });
      return;
    }
    if (!t && act !== 'condSave' && act !== 'condSaveClose') return;
    if (act === 'condAlt') { VIEW.condAlt[t.text] = true; $('condMsg').innerHTML = condMsgHtml(); return; }
    if (act === 'condPick') {
      var c = t.cands[+el.getAttribute('data-c')];
      if (!c) return;
      VIEW.condPicks[t.text] = { items: c.items, save: c.save };
      VIEW.condSaveMsg = '';
      applyCondText();
      return;
    }
    if (act === 'condUnpick') { delete VIEW.condPicks[t.text]; VIEW.condSave = null; applyCondText(); return; }
    if (act === 'condSaveOpen') { VIEW.condSave = t.text; $('condMsg').innerHTML = condMsgHtml(); var pw = $('termPw'); if (pw && !pw.value) pw.focus(); return; }
    if (act === 'condSaveClose') { VIEW.condSave = null; VIEW.condDel = null; $('condMsg').innerHTML = condMsgHtml(); return; }
    if (act === 'condSave') {
      var key = VIEW.condSave, pk = VIEW.condPicks[key], by = ($('termBy').value || '').trim(), pw2 = $('termPw').value;
      if (!pk || !pk.save) return;
      if (!by) { $('termMsg').textContent = '이름을 넣어 주세요'; $('termBy').focus(); return; }
      $('termMsg').textContent = '저장하는 중…';
      RatesStore.save('/api/terms', { password: pw2, by: by, add: [pk.save] }).then(function (team) {
        if (pw2) try { localStorage.setItem('v2.rates.by', by); } catch (e) { /* 이름 기억 못 해도 된다 */ }
        TERM_PW = pw2; TERMS.team = team;
        pk.saved = true;
        delete VIEW.condPicks[key];                          // 이제 사전으로 읽힌다
        VIEW.condSave = null;
        VIEW.condSaveMsg = "팀 사전에 넣었습니다: '" + esc(pk.save.t) + "' — 다음부터 팀 모두가 자동으로 읽습니다";
        applyCondText();
      }).catch(function (e) {
        var m = $('termMsg');
        if (m) m.textContent = e.message || '저장하지 못했습니다';
      });
    }
  }

  function updateCond() {                                    // 성능 상태 설명 = 부위별 감가 내역(기획 v2.32 Q228)
    var el = $('condOut');
    if (!el) return;
    var st = condState(), folded = S.cond === '입력' && !recOpen();
    el.hidden = !st && (S.cond !== '입력' || folded);       // 미상 설명은 버튼 말풍선으로(기획 v2.26) · 접힌 기록부는 요약 줄이 안내
    if (!st) {
      el.innerHTML = S.cond === '입력' ? '부위를 고르거나 글로 적어 넣으세요 — 그 전엔 <b>상태 미상</b>(비교 매물 평균 상태)으로 계산합니다.' : '';
      return;
    }
    el.innerHTML = condBreak(st, R && R.base, R && R.repairManual);
  }
  function condMarketLine(label, nloc, base) {              // 감가 옆 시장 근거(기획 v2.33 Q238) — 같은 사고 단계 · 같은 손상 곳수(· 같은 차값대) 판매 매물의 무사고 대비 호가 차이(주간 점검)
    var M = X.condMarket, row = M && M.classes && label ? M.classes[label] : null;
    if (!row || !nloc) return '';
    var nb = nloc >= 3 ? '3곳+' : nloc + '곳', b = base == null ? null : base < 1000 ? '1천 미만' : base < 2000 ? '1~2천' : base < 4000 ? '2~4천' : '4천+';
    var both = b ? row[nb + '|' + b] : null, use = both || row[nb], what = both ? ' · 손상 ' + nb + ' · 차값 ' + b : use ? ' · 손상 ' + nb : '';
    if (!use) { use = row.all; what = ''; }
    if (!use || use[1] < 30) return '';
    return '같은 사고 단계(' + esc(label) + ')' + what + ' 판매 매물은 무사고보다 평균 <b>' + Math.abs(use[0]).toFixed(1) + '%</b> ' + (use[0] <= 0 ? '낮게' : '높게') + ' 올라와 있습니다(' +
      use[1].toLocaleString('ko-KR') + '대 · ' + esc(M.date || '') + ' 점검)';
  }
  function condBreak(st, base, manual) {                     // 감가 내역: 부위 → 한 번 감가 → 합계, 수리필요 수리비, 직접 입력 수리비
    var c = condResult(), h = CTB.hist(st.items, base), rp = CTB.repair(st.items, isImport()), cap = CTB.table.cap;
    var out = '<b>' + esc(c['사고라벨'] || '무사고') + '</b> · 이력 감가 <b>' + (h.D ? '−' + (h.D * 100).toFixed(1) + '%' : '없음') + '</b>' +
      (base && h.D ? ' (−' + man(base * h.D) + '만)' : '') + (rp.sum ? ' · 수리필요 수리비 <b>−' + rp.sum + '만</b>' +
        (CTB.repairShare() < 100 ? '(환산가에는 ' + man(rp.sum * CTB.repairShare() / 100) + '만)' : '') : '') + (manual ? ' · 직접 입력 수리비 <b>−' + man(manual) + '만</b>' : '');
    var ml = h.D ? condMarketLine(c['사고라벨'], CTB.classOf(st.items).n, base) : '';
    if (ml) out += '<div class="v2-mkt">' + ml + '</div>';
    if (h.D && h.mult) {                                     // 차값 배수(v2.33 Q241) — 1에서 멀 때만 밝힌다
      var mn = [];
      if (Math.abs(h.mult['외판'] - 1) >= 0.05) mn.push('외판 ×' + h.mult['외판'].toFixed(2));
      if (h.frame && Math.abs(h.mult['골격'] - 1) >= 0.05) mn.push('골격 ×' + h.mult['골격'].toFixed(2));
      if (mn.length) out += '<div class="v2-mnote">차값 반영 ' + mn.join(' · ') + ' — 같은 손상이라도 차값에 따라 시장이 깎는 정도가 달라서(⚙ 감가 표)</div>';
    }
    if (h.lines.length) out += '<ul class="v2-cl">' + h.lines.map(function (l) {
      return '<li' + (l.once ? ' class="once"' : '') + '>' + esc(l.label) + (l.nth ? ' <i>' + l.nth + '번째 곳이라 덜 깎음</i>' : '') + ' <b>' +
        (l.capped ? '같은 칸 ' + cap + '곳 넘어 셈 안 함' : pctS(l.pct)) + '</b></li>';
    }).join('') + '</ul>';
    if (rp.lines.length) out += '<ul class="v2-cl">' + rp.lines.map(function (l) { return '<li>' + esc(l.label) + ' <b>−' + l.won + '만</b></li>'; }).join('') + '</ul>';
    return out;
  }

  function parseCond() { applyCondText(); }                 // 못 읽은 표기가 있어도 읽은 부위는 반영하고, 못 읽은 것은 결과 맨 위에 경고

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

  // 꼭 필요한데 빈 칸 — 결과 자리 '남은 칸' 안내와 조건 칸 테두리에 같이 쓴다. 모델 요약은 세부모델까지만 있으면 된다
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
  function fieldNotes(G, km) {                               // 주행 · 수리비 칸 아래: 읽은 값 · 확인할 값(리뷰 11-05 U1-6 · U1-7)
    var kn = $('kmNote'), cn = $('costNote'), raw = String(S.km || '').trim(), k = [];
    if (kn) {
      if (km != null && raw && !/^[\d,]+$/.test(raw)) k.push(km.toLocaleString('ko-KR') + 'km로 읽음');
      if (km != null && G && S.y) {
        var ym = G.F.now_ym, age = Math.max(1, (Math.floor(ym / 100) * 12 + ym % 100) - (+S.y * 12 + (+S.m || 6))) / 12;
        if (km > 500000) k.push('50만km가 넘습니다 — 확인하세요');
        else if (age >= 2 && km / age < 1000) k.push('연 1천km도 안 됩니다 — 만km라면 8.6만처럼');
        else if (age >= 1 && km / age > 60000) k.push('연 6만km가 넘습니다 — 확인하세요');
      }
      kn.textContent = k.join(' · ');
      kn.hidden = !k.length;
      kn.classList.toggle('v2-bad', k.length > (km != null && raw && !/^[\d,]+$/.test(raw) ? 1 : 0));
    }
    if (cn) {
      var cr = String(S.cost || '').trim(), cv0 = manNum(cr);
      cn.textContent = cr && cv0 == null ? '못 읽음 — 50 · 50만 · 500,000원처럼 넣으세요' : cr && !/^[\d.]+$/.test(cr) ? man(cv0) + '만원으로 읽음' : cr && +cr >= 10000 ? '원으로 보고 ' + man(cv0) + '만원' : '';
      cn.hidden = !cn.textContent;
    }
  }

  function calc() {
    clearTimeout(recentTimer);
    var G = grp(), miss = missing(), km = kmNum(S.km), M = G && S.model && G.models[S.model];
    fieldNotes(G, km);
    markMode(VIEW.mode);                                     // 탭은 고른 그대로 — 빈 칸이 있다고 모델 요약 탭으로 넘기지 않는다
    markNeed(miss);
    pageHead();
    if (window.CT) {                                         // 이용 통계: 고르다 만 칸(입력하다 포기) · 고른 모델(단계 흐름 '차 고름')
      CT.miss(S.mk ? miss.map(function (x) { return x.name.split(' — ')[0]; }).join(',') : '');
      if (S.model) CT.pick(S.model);
    }
    if (M && (VIEW.mode === 'model' || miss.length)) {
      R = null; summary(G, miss); MB = miss.length ? needBar(miss) : bar('모델 요약 보기 ↓');
      if (VIEW.mode === 'model' && window.CT) CT.result('model|' + S.mk + '|' + S.model, S.model, '', 'model');
      return;
    }   // 빈 칸이 남았으면 안내 + 모델 요약(참고)
    if (miss.length || !G) { R = null; guide(miss); MB = miss.length ? needBar(miss) : ''; return; }
    var c = condResult(), rv = rateOf(S.rate), rate = rv.v;
    var car = {
      '모델': S.model, '등급': S.grade, '세부등급': S.trim, '등록연월': +S.y * 100 + (+S.m || 6), '주행km': km,
      '색상계열': S.color || null, '렌트': S.rent, '상태': condState(), '수입': isImport(),
      '수리비': manNum(S.cost) || 0, '연료': fuelOf(G), '팀환산': rate != null && isFinite(rate) ? rate : undefined,
      excludeIds: S.ex.map(Number)
    };
    R = ENG.estimateCar(G, car, { sold: S.sold });
    if (!R) { noComps(G); MB = bar('비교 매물 5대 미만 — 결과 보기 ↓'); return; }
    var yrs = Math.floor(G.F.now_ym / 100) - Math.floor(car['등록연월'] / 100);
    var auto = ENG.conversionRate(R.base, yrs, G.F.maker, S.model, car['연료']);   // 엔진처럼 무사고 시세로 찾는다(리뷰 11-05: 안내 % ≠ 적용 %)
    var note = $('rateNote');
    if (note) { note.textContent = (rv.warn ? rv.warn + ' · ' : '') + '자동 ' + auto.rate + '%'; note.classList.toggle('v2-bad', !!rv.warn); note.title = auto.source + (car['연료'] ? ' · ' + car['연료'] : ''); }
    var cn = $('costNote'), cst = manNum(S.cost);
    if (cn && cst != null && cst >= R.est * 0.5) { cn.hidden = false; cn.textContent = '수리비 ' + man(cst) + '만이 시세(수리 전 ' + man(R.est) + '만)의 절반이 넘습니다 — 단위를 확인하세요'; }
    LAST = { G: G, car: car, c: c };
    renderResult(G, car, c);
    updateCond();                                            // 감가 내역의 금액은 무사고 시세가 나온 뒤에
    if (window.CT) CT.result(JSON.stringify(Object.assign({}, S, { ex: [] })), S.model, S.grade + (S.trim ? ' ' + S.trim : ''), 'one');   // 모델·등급만 남긴다(Q156)
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
    navSet();
    condBar(null, null);
    $('res').innerHTML = miss.length ? needCard(miss) : '<div class="card"><div class="card-title">비교 매물을 불러오는 중…</div></div>';
  }
  function needCard(miss) {                                  // 남은 칸만 이름으로(누르면 그 칸으로 간다) · 한 줄 시작 안내와 예시 단추는 제목 줄·조건 패널에 있다(기획 v2.27)
    return '<div class="card v2-needcard"><div class="card-title">' + (VIEW.mode === 'model' ? '모델 요약' : '한 대 산정') + '까지 남은 칸</div><div class="v2-needs">' + miss.map(function (x) {
        return '<button type="button" class="v2-needchip" data-need="' + x.keys[0] + '">' + esc(x.name) + '</button>';
      }).join('') + '</div>' +
      (S.mk && !S.model ? '<div class="v2-actions"><button type="button" class="v2-btn primary" data-act="example">예시로 채워 보기</button></div>' : '') + '</div>';
  }

  function noComps(G) {
    var M = G.models[S.model];
    navSet();
    condBar(null, null);
    $('res').innerHTML = '<div class="card"><div class="card-title">비교 매물이 5대 미만이라 산정할 수 없습니다</div>' +
      '<p class="v2-kv">' + esc(S.model) + ' 비교 매물 ' + (M ? M.n + '대(판매중 ' + M.onsale + '대)' : '없음') +
      (S.sold ? '' : ' · 최근 판매 매물을 포함하면 늘어날 수 있습니다') + (S.ex.length ? ' · 직접 뺀 매물 ' + S.ex.length + '대' : '') + '</p>' +
      (S.ex.length ? '<p class="v2-actions"><button type="button" class="v2-btn primary" data-act="exClear">뺀 매물 ' + S.ex.length + '대 모두 되돌리기</button>' +
        '<button type="button" class="v2-btn" data-act="exLast">마지막에 뺀 1대만 되돌리기</button></p>' : '') + '</div>';
  }

  // ───── 결과(기획 v2.26 · v2.27 디자인 D) — 제목(차 이름) 아래 ① 시세(히어로) ② 산정 근거 ③ 동급 대비 ④ 판매·추세(처음 접힘) ⑤ 가격 사다리 ⑥ 비교 매물 ─────
  function shortSrc(s) { return String(s || '').replace('호가대×차령 기준표', '기준표'); }
  function pageHead() {                                      // 페이지 제목 = 지금 차(없으면 화면 이름) · 아래 줄 = 조건 한 줄
    var t = $('pTitle'), sub = $('pSub');
    if (!t) return;
    var mode = VIEW.mode, F = grp() && grp().F, mk = (F && F.maker) || S.mk, km = kmNum(S.km), enc = S.model ? encLine(S.mk, S.grp, S.model) : '';
    var title = mode === 'batch' ? '묶음 산정' : mode === 'rates' ? '환산 비율' : S.model ? esc(mk + ' ' + S.model) +
      (mode === 'one' && S.grade ? '<span> · ' + esc(S.grade + (S.trim ? ' ' + S.trim : '')) + '</span>' : '<span>' + esc(yrOf(S.mk, S.grp, S.model)) + '</span>') : mode === 'model' ? '모델 요약' : '시세 산정';
    var line = mode === 'batch' ? '엑셀 목록을 붙여 넣으면 여러 대를 한 번에 산정합니다' : mode === 'rates' ? '경매 낙찰가로 정한 팀 환산 비율' :
      mode === 'model' ? (S.model ? '세부모델 한눈에 보기 · 등급 무관' : '세부모델까지 고르면 바로 나옵니다') :
      S.model && S.y && km != null ? regText() + ' 등록' + (S.m ? '' : '(월 미상 · 6월로 계산)') + ' · ' + km.toLocaleString('ko-KR') + 'km · 색상 ' + (S.color || '상관없음') +
        ' · ' + condTxt() + (S.rent ? ' · 렌트 번호판' : '') : '차명을 넣거나 아래에서 차를 고르면 바로 시세가 나옵니다';
    t.innerHTML = title;
    sub.innerHTML = esc(line) + (enc && (mode === 'one' || mode === 'model') ? '<small>' + esc(enc) + '</small>' : '');
  }
  function countUp(to, key) {                                // 추정 시세 숫자 올라가기(900ms, easeOutQuart) — 같은 차는 이전 값에서, 새 차는 0에서
    var el = $('heroNum');
    if (!el) return;
    var from = VIEW.shownKey === key && VIEW.shown != null ? VIEW.shown : 0, id = ++VIEW.countId;
    VIEW.shown = to; VIEW.shownKey = key;
    if (from === to || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) { el.textContent = man(to); return; }
    var t0 = performance.now();
    setTimeout(function () { if (id === VIEW.countId && el.isConnected) el.textContent = man(to); }, 1000);   // 화면이 가려져 프레임이 멈춰도 최종 값은 보이게
    (function step(now) {
      if (id !== VIEW.countId || !el.isConnected) return;
      var k = Math.min(1, (now - t0) / 900), e = 1 - Math.pow(1 - k, 4);
      el.textContent = man(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }
  function condTxt() {                                      // 제목 줄·조건 바의 상태 말
    return S.cond === '입력' ? (S.items.length ? '기록부 ' + S.items.length + '곳' : '상태 미상(기록부 입력 전)') : S.cond === '무사고' ? '무사고' : '상태 미상';
  }
  function condBar(G, car) {                                 // 스크롤하면 위에 붙는 작은 조건 바(기획 v2.27 Q145)
    var el = $('condbar');
    if (!el) return;
    el.innerHTML = !car ? '' : '<div class="cb"><span class="t">' + esc(S.model + ' · ' + S.grade + (S.trim ? ' ' + S.trim : '')) + '</span><span class="s">' + regText() + ' · ' +
      (car['주행km'] / 1e4).toFixed(1) + '만 km · ' + esc(S.color || '색상 상관없음') + ' · ' + esc(condTxt()) + '</span>' +
      '<button type="button" class="v2-btn" data-act="toCond">조건 바꾸기 ↑</button></div>';
  }
  function condTip(r) {                                     // 무사고였다면 칩 말풍선 — 감가 내역 한 줄씩
    var t = '무사고 시세 ' + man(r.base) + '만에서';
    (r.condLines || []).forEach(function (l) { t += '\n' + l.label + ' ' + (l.capped ? '(셈 안 함)' : pctS(l.pct)); });
    if (r.D) t += '\n이력 감가 합계 −' + (r.D * 100).toFixed(1) + '% (−' + man(r.base * r.D) + '만)';
    (r.repairLines || []).forEach(function (l) { t += '\n' + l.label + ' −' + l.won + '만'; });
    if (r.repairManual) t += '\n직접 입력 수리비 −' + man(r.repairManual) + '만';
    return t;
  }
  function fpChip(fp, r) {                                   // 출고가(신차 소비자가) · 잔존율(추정 시세 ÷ 출고가, 수리비 빼기 전 — 감가 곡선과 같은 정의)
    if (!fp) return '';
    var tip = '출고가(신차 소비자가) — ' + fp.basis + ' 매물 ' + fp.n + '대의 출고가 가운데 값' + (fp.lo !== fp.hi ? '\n그 매물들의 출고가 ' + man(fp.lo) + '~' + man(fp.hi) + '만' : '') +
      '\n잔존율 = 추정 시세(수리비 빼기 전) ÷ 출고가' +
      (fp.exact ? '' : S.trim ? '\n세부등급이 같은 매물이 적어 등급 기준으로 넓혔습니다' : '\n세부등급을 고르지 않아 등급 전체 매물로 봤습니다 — 세부등급을 고르면 더 정확합니다');
    return '<span class="v2-hfp" data-tip="' + esc(tip) + '" tabindex="0">출고가 <b>' + man(fp.op) + '만</b> · 잔존율 <b>' + Math.round(r.est / fp.op * 100) + '%</b>' +
      (fp.exact ? '' : ' <small>등급 기준</small>') + '</span>';
  }
  function rise(key) { var on = VIEW.riseKey !== key; VIEW.riseKey = key; return on; }   // 새 차를 처음 그릴 때만 섹션이 떠오른다(조건을 바꿀 때마다 깜빡이지 않게)
  function renderResult(G, car, c) {
    var r = R, M = G.models[S.model], co = curveOf(G), km = VIEW.posx === 'km', cf = ENG.prepare(G, S.model).cf.b, key = S.mk + '|' + S.model + '|' + S.grade + '|' + S.trim;
    var stepNo = r.stepName.split(' ')[0], stepName = r.stepName.slice(stepNo.length + 1);
    var span = Math.max(1, r.range[1] - r.range[0]), lo0 = r.range[0] - span / 2, hi0 = r.range[1] + span / 2, at = function (v) { return Math.max(0, Math.min(100, (v - lo0) / (hi0 - lo0) * 100)).toFixed(1) + '%'; };
    var rec = S.cond === '입력' && S.items.length > 0, base0 = r.base - r.repairManual, fp = ENG.factoryPrice ? ENG.factoryPrice(G, car) : null;   // 출고가(사용자 요청 11-04)
    var hero = '<div class="v2-hero-row"><div class="v2-hero"><div class="v2-hero-top"><span class="v2-hlabel"><i aria-hidden="true"></i>추정 시세 · 온라인 소매 호가 기준' + infoBtn('price', '시세') + '</span>' +
      '<div class="v2-hacts">' + (batch().hasCar(batchCar()) ? '<button type="button" class="v2-btn" data-act="openBatch">묶음에 있음 · 열기</button>' :
        '<button type="button" class="v2-btn" data-act="toBatch" title="이 차를 묶음 산정 목록에 한 줄로 더합니다. 기계 결함·직접 뺀 매물·직접 넣은 환산 비율은 넘어가지 않습니다">＋ 묶음에 추가</button>') +
      '<button type="button" class="v2-btn" data-act="xlsx">엑셀 ↓</button><button type="button" class="v2-btn primary" data-act="sheet" title="인쇄·PDF용 한 장. 환산가는 고를 때만 넣습니다">한 장 요약 →</button></div></div>' +
      '<div class="v2-hnum"><span id="heroNum">' + man(VIEW.shownKey === key && VIEW.shown != null ? VIEW.shown : 0) + '</span><small>만원</small></div>' +
      '<div class="v2-range" role="img" aria-label="가운데 50% 범위 ' + man(r.range[0]) + '~' + man(r.range[1]) + '만, 추정 ' + man(r.price) + '만">' +
      '<div class="trk"></div><div class="iqr" style="left:' + at(r.range[0]) + ';right:calc(100% - ' + at(r.range[1]) + ')"></div><div class="knob" style="left:' + at(r.price) + '"></div>' +
      '<div class="lab"><span>' + man(r.range[0]) + '만</span><span>가운데 50% 범위</span><span>' + man(r.range[1]) + '만</span></div></div>' +
      '<div class="v2-hchips">' + fpChip(fp, r) + (r.est0 != null ? '<span>무사고라면 <b>' + man(r.est0 - r.repair) + '만</b></span>' : '') +
      (rec ? '<span class="v2-hfp" tabindex="0" data-tip="' + esc(condTip(r)) + '">무사고였다면 <b>' + man(base0) + '만</b> · 기록부 ' + pct((r.price - base0) / base0 * 100) + '</span>' : '') +
      (r.repair ? '<span>수리비 <b>−' + man(r.repair) + '만</b> 반영</span>' : '') +
      '<span>비교 매물 <b>' + r.n + '대</b>' + (r.out ? ' · 이상치 제외 ' + r.out + '대' : '') + '</span></div></div>' +
      '<div class="v2-hside"><div class="v2-conv"><div class="lab">환산가 · 경매 예상가</div><div class="num"><b>' + man(r.converted) + '</b><small>만원</small></div>' +
      '<div class="foot"><span class="rt">−' + r.rate + '%</span>환산 비율 · ' + esc(shortSrc(r.rateSource)) + convFix(r) + '</div>' +
      (convLine(r) ? '<div class="foot v2-convd">' + convLine(r) + '</div>' : '') + '</div>' +
      '<div class="v2-conf"><div class="ring g-' + r.grade + '" style="--p:' + ({ A: 88, B: 62, C: 34 }[r.grade] || 50) + '"><span>' + r.grade + '</span></div><div>' +
      '<div class="lab">신뢰도</div><div class="big">' + stepNo + '단계 · ' + esc(stepName) + '</div><div class="sm">비교 매물 ' + r.n + '대 기준' +
      (S.ex.length ? ' · 직접 뺀 ' + S.ex.length + '대 <button type="button" class="v2-link" data-act="exClear">되돌리기</button>' : '') + (r.grade === 'C' ? ' · 참고값' : '') + '</div></div></div></div></div>';
    if (r.grade === 'C') hero += '<div class="notebox v2-warnbox v2-cwarn"><b>참고용 — 신뢰도 C.</b> ' + cWhy(r) + '</div>';   // 기획 v2.33 Q248
    if (VIEW.condWarn.length) hero += '<div class="notebox v2-warnbox"><b>못 읽은 성능 표기는 계산에 넣지 않았습니다:</b> ' + esc(VIEW.condWarn.join(', ')) +
      (S.items.length ? '' : ' — 읽은 부위가 없어 상태 미상으로 계산') + '</div>';
    var h = sec('price', 1, '시세', [['추정 시세', TIP.est], ['환산가', TIP.conv], ['신뢰도', TIP.grade],
      ['비교 매물 찾기', stepNo + '단계(' + stepName + ')까지 넓혀 찾았습니다. ' + TIP.step], rec ? ['무사고였다면', TIP.cond] : null], hero, { headless: true });

    h += sec('basis', 2, '산정 근거', [['내 차 위치', TIP.pos],
      ['점선', '이 차에서 ' + (km ? '주행만' : '연식만') + ' 다를 때의 값 — ' + (km ? '주행 1만km 늘 때마다 ' : '1년 오래될 때마다 ') + pct((Math.exp(km ? cf[1] : cf[0] * 12) - 1) * 100) + '.'],
      ['보정 흐름', TIP.flow + ' 항목 이름에 마우스를 올리면 그 보정의 이유가 나옵니다.'], ['보정 계수', (COEF_LEVEL[R.coefLevel] || R.coefLevel) + '(매주 데이터에서 추정).']],
      posCard(G, car) + flowCard(G, car, c));

    h += sec('market', 3, '동급 대비', cv().info(), cv().tiles(co) + cv().card(co, myCurve(G, car), chartW(1100, 9999)),
      { peek: M && M.seg ? esc(segLabel(M.seg)) + ' · ' + esc(S.model) + ' 전체(등급 무관)' : '' });

    var sd = speedData(G), mm = sd.mm, speedV = mm && mm.rate_w != null ? '주 ' + (mm.rate_w * 100).toFixed(1) + '%' : '';
    h += sec('speed', 4, '판매 · 추세', [['판매 속도', TIP.speed], ['시세 추세', TIP.trend], ['방향', '매주 수집이 4주 쌓이기 전에는 짧은 기간으로 보고 "짧음"을 붙입니다.']],
      speedCard(G) + trendCard(G), { fold: true, peek: [speedV, mm && mm.pidx != null ? '시세지수 ' + Number(mm.pidx).toFixed(1) : ''].filter(Boolean).join(' · ') });

    var ld = ladderData(G, car, c);
    h += sec('ladder', 5, '가격 사다리', [['가격 사다리', TIP.ladder], ['연식 × 주행', '굵은 칸 = 이 차. 칸을 누르면 그 조건으로 다시 산정합니다. 판매중 5대 미만 칸은 비웁니다.'],
      ['성능 상태별', ladderNote(ld)]], ladderCard(G, car, c, ld), { tools: S.grade ? seg('mgrade', [['one', S.grade + '만'], ['all', '전체 등급']], VIEW.allGrades ? 'all' : 'one', '시세표 등급') : '' });

    h += sec('comps', 6, '비교 매물', [['빼기', '체크하면 그 매물을 빼고 다시 계산합니다. 뺀 매물은 표에 흐리게 남고, 신뢰도의 되돌리기로 모두 되돌립니다.'],
      ['유사도', TIP.sim], ['호가', TIP.price], ['보정 후', TIP.adj], ['체류', TIP.dwell], ['인하', TIP.cut], ['금액', '표의 금액은 모두 만원입니다.'],
      ['매물 표기', '경매 이름을 붙이기 전 매물에 적힌 이름입니다. 가까운 이름 = 경매 데이터에 같은 이름이 없어 가장 가까운 경매 이름에 붙인 매물, 매물 이름 = 맞는 경매 이름이 없어 매물 이름을 그대로 쓴 매물.']],
      compsTable(G), { peek: R.comps.length + '대 · 만원', tools: seg('sort', [['sim', '유사도순'], ['adj', '보정가순'], ['price', '호가순']], VIEW.sort, '정렬') });
    $('res').innerHTML = h;
    $('res').classList.toggle('v2-rise', rise(key));
    countUp(Math.round(r.price), key);
    condBar(G, car);
    navSet([['추정 시세', man(r.price)], ['환산가', man(r.converted)], ['신뢰도', r.grade, 'g-' + r.grade]],
      [['price', 1, '시세', man(r.price)], ['basis', 2, '산정 근거'], ['market', 3, '동급 대비', cv().tag()],
        ['speed', 4, '판매 · 추세', speedV], ['ladder', 5, '가격 사다리'], ['comps', 6, '비교 매물', R.comps.length + '대']]);
    loadCurve(co);
  }

  // ───── 동급 대비 지표 · 감가 곡선(curve.js, 기획 v2.24) ─────
  function cv() {
    if (!CV) CV = V2Curve.create({ X: X, esc: esc, man: man, getJSON: getJSON, mm: function () { return X.mmWait; } });
    return CV;
  }
  function curveOf(G) {                                       // 지금 고른 세부모델 → curve.js 입력
    var g = groupOf(), M = G.models[S.model];
    return { mk: S.mk, grp: S.grp, model: S.model, file: g ? g.file : null, seg: M ? M.seg : '' };
  }
  function myCurve(G, car) {                                  // 내 차 ★ — 차령(년) · 추정 시세 · 출고가(비교 매물 출고가의 가운데 값)
    var ym = G.F.now_ym, reg = car['등록연월'], fi = G.fi;
    var age = (Math.floor(ym / 100) * 12 + ym % 100 - (Math.floor(reg / 100) * 12 + reg % 100)) / 12;
    var fp = ENG.factoryPrice ? ENG.factoryPrice(G, car) : null;   // 시세 박스의 출고가와 같은 값(같은 세부등급·등록연도 → 넓혀 감)
    var ops = fi.op == null ? [] : R.comps.filter(function (x) { return !x.outlier && x.row[fi.op] > 0; }).map(function (x) { return x.row[fi.op]; });
    return { age: Math.max(0, age), est: R.est, op: fp ? fp.op : ops.length >= 3 ? median(ops) : null };
  }
  function loadCurve(co) {                                    // 리포트 자료·시장 숫자가 오면 지표 줄·곡선만 다시(같은 세부모델일 때)
    var key = co.mk + '|' + co.model;
    cv().load(co).then(function () { if (S.mk + '|' + S.model === key) { cv().refresh(); navVal('market', VIEW.mode === 'one' ? cv().tag() : ''); } });
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
    var shown = (VIEW.all ? list : list.slice(0, SHOW + keep.length)).concat(tail), ec = {};
    R.comps.forEach(function (x) { var t = encText(G, x.row); ec[t] = (ec[t] || 0) + 1; });
    ENC_MAIN = Object.keys(ec).sort(function (a, b) { return ec[b] - ec[a]; })[0] || '';
    var h = '<div class="card">';
    h += '<div class="v2-tablewrap"><table class="t v2-tbl"><thead><tr><th title="체크하면 그 매물을 빼고 다시 계산합니다">빼기</th><th class="num">유사도</th><th>등록</th><th class="num">주행</th>' +
      '<th>색상</th><th>등급</th><th>성능 (글로비스)</th><th class="num">호가</th><th class="num">보정 후</th><th>상태</th>' +
      '<th class="num">체류</th><th class="num">인하</th><th>매물</th></tr></thead><tbody>';
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
      '<td>' + esc(F.grades[row[fi.g]] + (trim ? ' ' + trim : '')) + encSmall(G, row) + '</td>' +
      '<td>' + esc(F.labels[row[fi.acc]]) + (x.D ? ' <small>−' + (x.D * 100).toFixed(1) + '%</small>' : '') + dmButton(G, row) + '</td>' +
      '<td class="num price">' + man(price) + '</td><td class="num">' + (x.adj != null ? '<b>' + man(x.adj) + '</b>' : '–') + '</td>' +
      '<td>' + state + '</td><td class="num">' + (x.dwell != null ? x.dwell + '일' : '–') + '</td>' +
      '<td class="num">' + (p0 != null && p0 > price ? '−' + man(p0 - price) : '–') + '</td>' +
      '<td><a href="https://fem.encar.com/cars/detail/' + id + '" target="_blank" rel="noopener">보기 ↗</a></td></tr>';
  }

  function encText(G, row) {                                 // 비교 매물 한 대의 매물 표기 한 줄
    var e = encOfRow(G, row);
    return e ? (e.model !== S.model ? e.model + ' ' : '') + e.grade + (e.trim ? ' ' + e.trim : '') : '';
  }
  var ENC_MAIN = '';                                         // 비교 매물에서 가장 흔한 매물 표기 — 같은 것은 행마다 되풀이하지 않는다(기획 v2.26, ① 조건 차량에 한 번)
  function encSmall(G, row) {                                // 등급 칸 아래 작게: 흔한 것과 다른 매물 표기 · 가까운 이름 표시(기획 v2.23 Q101·Q102)
    var q = G.fi.q != null && row[G.fi.q], t = encText(G, row);
    if (t === ENC_MAIN) t = '';
    if (!t && !q) return '';
    return '<small class="v2-encrow">' + (q === 1 ? '<span title="경매 데이터에 같은 이름이 없어 가장 가까운 경매 이름에 붙인 매물입니다">가까운 이름</span> '
      : q === 2 ? '<span title="경매 데이터에 맞는 이름이 없어 매물 이름을 그대로 쓴 매물입니다">매물 이름</span> ' : '') +
      (t ? '매물 표기: ' + esc(t) : '') + '</small>';
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
    var W = chartW(1100, 9999), H = W >= 700 ? 380 : Math.max(260, Math.min(340, Math.round(W * 0.62)));   // 한 줄 전체 폭(기획 v2.26 Q127) — 설명은 섹션 i
    return '<div class="card"><div class="v2-tools"><div class="card-title">내 차 위치</div>' +
      seg('posx', [['km', '주행 × 호가'], ['age', '차령 × 호가']], VIEW.posx, '가로축') + '</div>' + posLegend() + posSvg(G, car, W, H, '') + '</div>';
  }

  function posLegend() {
    var hasOut = R.comps.some(function (x) { return x.outlier; });
    return '<div class="v2-legend"><span><i style="background:var(--accent)"></i>판매중</span>' +
      '<span><i style="background:var(--bg-1);box-shadow:inset 0 0 0 2px var(--accent)"></i>최근 3개월 판매</span>' +
      (hasOut ? '<span><i style="background:var(--tx-4)"></i>이상치</span>' : '') +
      '<span><i class="v2-medot" aria-hidden="true"></i>내 차 ' + man(R.est) + '만</span>' +
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
      '" height="' + (H - T - B) + '"/></clipPath><radialGradient id="' + clip + 'g"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/>' +
      '<stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></radialGradient></defs>';
    niceTicks(y0, y1, 5).forEach(function (t) {
      h += '<line x1="' + L + '" x2="' + (W - RR) + '" y1="' + py(t).toFixed(1) + '" y2="' + py(t).toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>' +
        '<text x="' + (L - 8) + '" y="' + (py(t) + 4).toFixed(1) + '" text-anchor="end">' + man(t) + '</text>';
    });
    var xt = [];
    if (km) xt = niceTicks(x0, x1, Math.max(3, Math.round(W / 140))).map(function (t) { return [t, t + '만']; });
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
    h += '<polyline clip-path="url(#' + clip + ')" fill="none" stroke="var(--tx-1)" stroke-opacity=".35" stroke-width="1.5" stroke-dasharray="4 5" points="' + bl.join(' ') + '"/>';
    var order = function (p) { return p.ex ? 0 : p.c.outlier ? 1 : p.c.sold ? 2 : 3; };   // 흐린 것부터 그려 진한 점이 위로
    pts.sort(function (a, b) { return order(a) - order(b); }).forEach(function (p) {
      var x = p.c, row = x.row, id = row[fi.id], st = p.ex ? 'ex' : x.outlier ? 'out' : x.sold ? 'sold' : 'on';
      var fill = { on: 'var(--accent)', sold: 'var(--bg-1)', out: 'var(--line-hard)', ex: 'none' }[st];
      var stroke = { on: 'var(--accent)', sold: 'var(--accent)', out: 'var(--line-hard)', ex: 'var(--tx-4)' }[st];
      var tip = '호가 ' + man(row[fi.price]) + '만 · ' + (x.sold ? '판매 ' + mmdd(row[fi.sd]) + '(마지막 호가)' : '판매중') + '\n' + ym(row[fi.reg]) + ' 등록 · ' +
        (row[fi.km] / 1e4).toFixed(1) + '만km · ' + G.F.grades[row[fi.g]] + '\n' + G.F.labels[row[fi.acc]] + (x.D ? ' · 이력 감가 −' + (x.D * 100).toFixed(1) + '%' : '') +
        (x.adj != null && !p.ex ? ' · 보정 후 ' + man(x.adj) + '만' : '') + (p.ex ? '\n직접 뺀 매물(계산 제외)' : x.outlier ? '\n이상치(계산 제외)' : '') + '\n누르면 아래 표에서 보기';
      h += '<circle class="v2-pt" data-pt="' + id + '" cx="' + px(p.x).toFixed(1) + '" cy="' + py(p.y).toFixed(1) + '" r="4" fill="' + fill + '" stroke="' + stroke +
        '" stroke-width="' + (st === 'sold' ? 1.6 : 1) + '"' + (st === 'ex' ? ' stroke-dasharray="2 2"' : '') + ' data-tip="' + esc(tip) + '"/>';
      if (String(VIEW.hl) === String(id)) h += '<circle cx="' + px(p.x).toFixed(1) + '" cy="' + py(p.y).toFixed(1) + '" r="8" fill="none" stroke="var(--tx-1)" stroke-width="2"/>';
    });
    var sy = py(R.est), right = bx < W - RR - 140, lw = 112, lx = right ? bx + 14 : bx - 14 - lw, ly = Math.max(T, sy - 40);
    var rtip = esc('이 차 추정 시세 ' + man(R.est) + '만' + (R.repair ? '(수리비 전)' : '') + '\n범위 ' + man(R.lo) + '~' + man(R.hi) + '만(보정 후 가운데 50%)');
    h += '<circle cx="' + bx.toFixed(1) + '" cy="' + sy.toFixed(1) + '" r="44" fill="url(#' + clip + 'g)" pointer-events="none"/>' +
      '<circle class="v2-me" cx="' + bx.toFixed(1) + '" cy="' + sy.toFixed(1) + '" r="8" fill="var(--tx-1)" stroke="var(--bg-1)" stroke-width="3" data-tip="' + rtip + '"/>' +
      '<rect x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" width="' + lw + '" height="28" rx="14" fill="var(--tx-1)" pointer-events="none"/>' +
      '<text class="v2-mel" x="' + (lx + lw / 2).toFixed(1) + '" y="' + (ly + 18).toFixed(1) + '" text-anchor="middle">내 차 ' + man(R.est) + '만' + (R.repair ? '*' : '') + '</text></svg>';
    return h;
  }

  // ───── 보정 흐름(보강안 1단계) — 비교 매물 호가 가운데 값 → 항목별 보정(평균) → 추정 시세 → 환산가 · 아래에 보정 후 모임 ─────
  function flowData(G, car, c) {                             // 보정 흐름 줄(카드·한 장 요약) — split = 추정 시세 다음 줄 번호, conv = 환산 줄(한 장 요약에서 환산가를 뺄 때 같이 뺀다)
    var b = R.basis, fi = G.fi, kept = R.comps.filter(function (x) { return !x.outlier; });
    var tAge = Math.floor(G.F.now_ym / 100) * 12 + G.F.now_ym % 100 - (+S.y * 12 + (+S.m || 6));
    var dAge = tAge - mean(kept.map(function (x) { return x.age; }));
    var dKm = car['주행km'] - mean(kept.map(function (x) { return x.row[fi.km]; }));
    var deps = kept.map(function (x) { return (x.D || 0) * 100; });
    var why = {
      '차령': '대상 차가 평균 ' + Math.abs(dAge).toFixed(1) + '개월 ' + (dAge >= 0 ? '더 오래됨' : '더 새것'),
      '주행': '평균 ' + (Math.abs(dKm) / 1e4).toFixed(1) + '만km ' + (dKm >= 0 ? '더 탐' : '덜 탐'),
      '성능': !condState() ? '상태 미상 — 비교 매물 평균 상태(이력 감가 ' + (R.D * 100).toFixed(1) + '%)로 계산' :
        '이력 감가 내 차 ' + (R.D * 100).toFixed(1) + '% · 비교 매물 평균 ' + mean(deps).toFixed(1) + '% — 비교 매물마다 사고 이력을 되돌린 뒤 내 차 상태로',
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
      out += '<span class="k' + (r.main ? ' main' : '') + '"' + (r.why ? ' data-tip="' + esc(r.why) + '" tabindex="0"' : '') + '>' + esc(r.k) + '</span><span class="trk">' + mark + '</span>' +
        '<span class="v ' + ud + (r.main ? ' main' : '') + '">' + (r.t === 'tot' ? man(r.v) : signed(r.d)) + '</span><span class="why">' + esc(r.why) + '</span>';
    });
    return out + '</div>';
  }

  function convLine(r) {                                     // 환산가 옆 '경매 기준 사고 감가'(기획 v2.33 Q257) — 기록부를 넣었고 사고가 있을 때
    if (!condState() || !(r.D > 0) || r.convD == null) return '';
    return '경매 기준 사고 감가 −' + (r.convD * 100).toFixed(1) + '% (소매 −' + (r.D * 100).toFixed(1) + '%)';
  }
  function convFix(r) {                                      // 환산가에서 뺀 수리비 — 수리필요 표준 수리비는 반영 몫만(Q261)
    return r.repairConv ? ' · 수리비 −' + man(r.repairConv) + '만' + (r.repairAuto && r.repairShare < 100 ? '(수리필요는 ' + r.repairShare + '%만)' : '') : '';
  }
  function cWhy(r) {                                         // 신뢰도 C 가 왜 약한지 · 점검 숫자(audit.json)
    var why = [], g = X.audit && X.audit.grade && X.audit.grade.C;
    if (r.n < 10) why.push('비교 매물이 ' + r.n + '대뿐');
    if (r.step >= 6) why.push('모델 전체로 넓혀 찾은 값'); else if (r.step >= 5) why.push('다른 등급까지 넓혀 찾은 값');
    return (why.length ? why.join('이고 ') + '이라 ' : '') + '오차가 큽니다(신뢰도 C는 실제 호가와 가운데 ' + (g ? g.mdape.toFixed(1) : '11') +
      '% 차이, 네 대 중 한 대꼴 20% 넘게 빗나감). 위 범위(' + man(r.range[0]) + ' ~ ' + man(r.range[1]) + '만)를 함께 보세요.';
  }
  function flowCard(G, car, c) {
    var f = flowData(G, car, c), rows = f.rows, split = f.split;
    var h = '<div class="card"><div class="card-title">보정 흐름 <span class="hint">만원 · 보정은 비교 매물 평균</span></div>' + flowBlock(rows.slice(0, split)) +
      (convLine(R) ? '<div class="v2-convbar"><span>무사고 ' + man(R.base) + '</span><em>→ 경매 기준 사고 −' + (R.convD * 100).toFixed(1) + '% → 환산 −' + R.rate + '%' +
        (R.repairConv ? ' → 수리비 −' + man(R.repairConv) : '') + ' →</em><b>환산가 ' + man(R.converted) + '</b></div>'
        : '<div class="v2-convbar"><span>' + man(R.est) + (R.repairConv ? ' − 수리비 ' + man(R.repairConv) : '') + '</span><em>→ −' + R.rate + '% · −' + man(R.est * R.rate / 100) + ' →</em><b>환산가 ' + man(R.converted) + '</b></div>');
    return h + '<div class="v2-fsub">보정 후 비교 매물 분포 · 가운데 50% 범위</div>' + distHist() + '</div>';
  }

  function niceTicks(a, z, n) {
    var span = z - a, step = Math.pow(10, Math.floor(Math.log(span / n) / Math.LN10)), e = span / n / step;
    if (e >= 7.5) step *= 10; else if (e >= 3.5) step *= 5; else if (e >= 1.5) step *= 2;
    var t = [];
    var dp = Math.max(0, -Math.floor(Math.log(step) / Math.LN10 + 1e-9));   // 0.2 단위면 소수 한 자리(4.6000000001 같은 꼬리 없이)
    for (var v = Math.ceil(a / step) * step; v <= z + step * 1e-9; v += step) t.push(+(Math.round(v / step) * step).toFixed(dp));
    return t;
  }

  function distHist() {                                      // 보정 후 가격 분포 막대(디자인 D) — 내 차 구간은 진하게, 가운데 50%는 옅게
    var vals = R.comps.filter(function (x) { return !x.outlier; }).map(function (x) { return x.adj; });
    if (!vals.length) return '';
    var lo = Math.min.apply(null, vals.concat([R.lo])), hi = Math.max.apply(null, vals.concat([R.hi])), n = 28, w = (hi - lo) / n || 1, bins = [];
    for (var i = 0; i < n; i++) bins.push(0);
    vals.forEach(function (v) { bins[Math.min(n - 1, Math.floor((v - lo) / w))]++; });
    var top = Math.max.apply(null, bins), me = Math.min(n - 1, Math.floor((R.est - lo) / w));
    var bars = bins.map(function (c, i) {
      var a = lo + i * w, b = a + w, cls = i === me ? 'me' : (b > R.lo && a < R.hi ? 'iqr' : '');
      return '<i class="' + cls + '" style="height:' + Math.max(4, c / top * 100).toFixed(0) + '%" data-tip="' + man(a) + '~' + man(b) + '만 · ' + c + '대"></i>';
    }).join('');
    var ticks = niceTicks(lo, hi, 4).filter(function (t) { return t >= lo && t <= hi; });
    return '<div class="v2-hist">' + bars + '</div><div class="v2-histx">' + ticks.map(function (t) {
      return '<span style="left:' + ((t - lo) / (hi - lo) * 100).toFixed(1) + '%">' + man(t) + '</span>';
    }).join('') + '</div>';
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
    var ok = mm && !mm.new_cov && (mm.rate_w == null || (mm.n_start || 0) >= 50);   // 새로 수집 · 판매율 표본 50대 미만은 빠름·느림을 말하지 않는다(리뷰 11-05, pulse_data MOVER_START)
    d.newCov = !!(mm && mm.new_cov);
    if (ok && sg && mm.rate_w != null && sg.rate_w) d.vs = { by: 'rate', ratio: mm.rate_w / sg.rate_w, word: word(mm.rate_w / sg.rate_w) };   // 주간 판매율(지난 구간 판매 ÷ 시작 재고, 7일 환산)
    else if (ok && sg && mm.dwell != null && sg.dwell) d.vs = { by: 'dwell', ratio: sg.dwell / mm.dwell, word: word(sg.dwell / mm.dwell) };   // 없으면 중위 체류일로
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
    var h = '<div class="card"><div class="card-title">판매 속도</div>' +
      '<div class="v2-kv">같은 조건 판매중 <b>' + d.on + '대</b>' + (S.sold ? ' · 최근 3개월 판매 <b>' + d.sold + '대</b>' : ' · 최근 판매 매물은 빼고 보는 중') + '</div>';
    // ① 차급 대비 — 주간 판매율. 없으면 중위 체류일로
    if (d.loading) h += '<p class="v2-kv">차급 비교를 불러오는 중…</p>';
    else if (d.vs && d.vs.by === 'rate') {
      var mx = Math.max(mm.rate_w, sg.rate_w), bar = function (name, v, cls, me) {
        return '<div class="v2-hrow' + (me ? ' me' : '') + '"><span class="k">' + esc(name) + '</span><span class="trk"><i class="' + cls + '" style="width:' +
          (v / mx * 100).toFixed(1) + '%"></i></span><span class="v">주 ' + (v * 100).toFixed(1) + '%</span></div>';
      };
      h += '<div class="v2-ssub">차급 대비 <span class="v2-pill ' + vsCls(d.vs.word) + '">' + sname + '보다 ' + d.vs.word + ' ' + pct((d.vs.ratio - 1) * 100) + '</span></div>' +
        bar('이 세부모델', mm.rate_w, 'me', true) + bar(sname, sg.rate_w, 'base');
    } else if (d.vs) {
      h += '<div class="v2-ssub">차급 대비 <span class="v2-pill ' + vsCls(d.vs.word) + '">' + sname + '보다 ' + d.vs.word + '</span></div>' +
        '<p class="v2-kv">중위 체류 <b>' + mm.dwell + '일</b> · 차급 ' + sg.dwell + '일</p>';
    } else h += '<p class="v2-note">' + (d.newCov ? '새로 수집한 매물이 많아 차급 비교는 몇 주 뒤부터 나옵니다' : '매물이 적어 차급과 비교하지 않음') + '</p>';
    // ② 가격 위치별 판매까지 일수 — 보정가(이 차 조건으로 맞춘 값)가 추정가보다 얼마나 쌌나·비쌌나
    h += '<div class="v2-ssub">가격 위치별 판매까지 일수</div>';
    if (!d.bk) h += '<p class="v2-note">판매된 비교 매물이 적어 생략</p>';
    else {
      var top = Math.max.apply(null, d.bk.map(function (b) { return b.days; }));
      d.bk.forEach(function (b) {
        h += '<div class="v2-hrow' + (b.me ? ' me' : '') + '"><span class="k">' + posLabel(b.lo, b.hi) + (b.me ? ' · 추정가' : '') + '</span><span class="trk"><i class="' +
          (b.me ? 'me' : 'base') + '" style="width:' + (b.days / top * 100).toFixed(1) + '%"></i></span><span class="v">' + Math.round(b.days) + '일 <small>' + b.n + '대</small></span></div>';
      });
    }
    // ③ 인하 — 가끔 참고(Q48)
    if (d.cut) h += '<p class="v2-kv v2-cutline">첫 호가보다 내린 판매중 <b>' + Math.round(d.cut.share * 100) + '%</b>' +
      (d.cut.med != null ? ' · 중앙 −' + man(d.cut.med) + '만' : '') + '</p>';
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
      base0: R.base };
  }

  function ladderNote(d) {                                   // 성능 상태별 설명(섹션 i) — 숫자가 들어가 매번 만든다
    return '같은 모델 매물을 이 차의 차령·주행·등급·색상으로 맞춘 뒤 사고 단계별 가운데 값을 무사고와 비교했습니다(' + POS_MIN + '대 이상인 단계만). ' +
      (d.base0 ? '만원은 이 차가 무사고일 때 ' + man(d.base0) + '만 기준. ' : '') + (d.mine ? '' : '이 차는 성능 상태를 넣지 않아 표시가 없습니다. ') +
      (d.mine && S.cond === '입력' && S.items.length ? '추정 시세(무사고 대비 ' + pct((R.est / R.base - 1) * 100) + ')는 이 차의 기록부 감가까지 본 값이라 단계 평균과 다를 수 있습니다.' : '');
  }
  function ladderCard(G, car, c, d0) {
    var d = d0 || ladderData(G, car, c), gs = d.gs, gme = d.gme, cl = d.cl, mine = d.mine, base0 = d.base0;
    var h = '<div class="card"><div class="v2-ladder"><div><div class="v2-ssub">연식 × 주행 · ' + esc(S.model) + '</div>' + matrixTable(d.st, d.yi, d.kj) + '</div>';
    var gmax = Math.max.apply(null, gs.map(function (g) { return g.med; }).concat([1]));
    h += '<div><div class="v2-ssub">등급별</div>' + (gs.length ? gs.map(function (g) {
      var me = g.name === S.grade;
      return '<div class="v2-hrow' + (me ? ' me' : '') + '"><span class="k"><button type="button" class="v2-link" data-grade="' + esc(g.name) + '">' + esc(g.name) + '</button>' + (me ? ' · 이 차' : '') +
        '</span><span class="trk"><i class="' + (me ? 'me' : 'base') + '" style="width:' + (g.med / gmax * 100).toFixed(1) + '%"></i></span><span class="v">' + man(g.med) +
        ' <small>' + (gme && !me ? signed(g.med - gme.med) + ' · ' : '') + g.n + '대</small></span></div>';
    }).join('') : '<p class="v2-kv">판매중 5대 이상인 등급이 없습니다.</p>');
    h += '<div class="v2-ssub" style="margin-top:14px">성능 상태별 · 무사고 대비</div>';
    if (!cl) h += '<p class="v2-note">무사고 매물이 적어 비교하지 않음</p>';
    else {
      var lo = Math.min.apply(null, cl.map(function (x) { return x.rel; }).concat([-0.01]));
      cl.forEach(function (x) {
        var me = x.k === mine;
        h += '<div class="v2-hrow' + (me ? ' me' : '') + '"><span class="k">' + esc(x.k) + (me ? ' · 이 차' : '') + '</span><span class="trk"><i class="' + (x.rel < 0 ? 'dn' : 'base') +
          '" style="width:' + (Math.abs(x.rel) / Math.abs(lo) * 100).toFixed(1) + '%"></i></span><span class="v">' + (x.k === '무사고' ? '기준' : pct(x.rel * 100)) +
          (base0 && x.k !== '무사고' ? ' <small>' + man(base0 * (1 + x.rel)) + '만</small>' : ' <small>' + x.n + '대</small>') + '</span></div>';
      });
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

  function trendData(G) { var M = G.models[S.model]; return trendDataOf(G.F.maker, S.model, M && M.seg); }
  function trendDataOf(maker, model, segStr) {               // 시세 추세 숫자(카드·한 장 요약·엑셀 분석 시트) — 점마다 흔들림 se = 지수 × 1.2533 × σ ÷ √신규 대수
    var seg = (segStr || '').split('·'), sname = seg[1] + ' ' + seg[0], skey = seg[1] + '|' + seg[0];
    var has = function (p) { return p['시세'] != null; }, raw = (X.mi.series[skey] || []).filter(has);
    if (raw.length < 2) { sname = seg[1] + ' 전체'; skey = seg[1] + '|전체'; raw = (X.mi.series[skey] || []).filter(has); }
    var ssig = (X.mi.price_sig || {})[skey] || 0.075;
    var sp = raw.map(function (p) { var n = p.n_price || 1; return { date: p.date, t: dayN(p.date), v: p['시세'], n: n, se: p['시세'] * 1.2533 * ssig / Math.sqrt(n) }; });
    var mm = X.mmBy && X.mmBy[maker + '|' + model], dates = X.mm && X.mm.trend_dates || [];
    var mp = mm && mm.ps ? mm.ps.map(function (q) { var d = dates[q[0]]; return { date: d, t: dayN(d), v: q[1], n: q[2], se: q[1] * 1.2533 * mm.sig / Math.sqrt(q[2]) }; }) : [];
    var cr = X.mi.crawls || [], latest = cr.length ? cr[cr.length - 1].date : sp.length ? sp[sp.length - 1].date : null, t1 = latest ? dayN(latest) : 0;
    var run = sp.length ? sp[sp.length - 1] : null;          // 지금 이어지는 매주 수집의 첫 회차 → 4주 방향이 나오는 날
    for (var i = sp.length - 1; i > 0 && sp[i].t - sp[i - 1].t <= TR_GAP; i--) run = sp[i - 1];
    return { model: model, sname: sname, sp: sp, mp: mp, mm: mm, latest: latest, t1: t1, loading: !X.mmBy,
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
      esc('시세지수 추이(7월 초 = 100)' + (lm ? ' — ' + T.model + ' ' + lm.v.toFixed(1) : '') + (ls ? ', ' + T.sname + ' ' + ls.v.toFixed(1) : '')) + '">';
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
    trRuns(T.mp).forEach(function (r) {                      // 세부모델 흔들림 2배 띠(1.96·se) — 점 하나뿐인 구간은 세로 막대로
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
      T.mp.forEach(function (p) { if (p.t >= g.t0 && p.t <= g.t1) tip.push(mmdd(p.date) + ' ' + T.model + ' ' + p.v.toFixed(1) + '(신규 ' + p.n + '대 · 흔들림 ±' + p.se.toFixed(1) + ')'); });
      T.sp.forEach(function (p) { if (p.t >= g.t0 && p.t <= g.t1) tip.push(mmdd(p.date) + ' ' + T.sname + ' ' + p.v.toFixed(1) + '(신규 ' + p.n.toLocaleString('ko-KR') + '대)'); });
      h += '<rect x="' + xa.toFixed(1) + '" y="' + TT + '" width="' + Math.max(4, xb - xa).toFixed(1) + '" height="' + (H - TT - B) + '" fill="transparent" data-tip="' + esc(tip.join('\n')) + '"/>';
    });
    return h + '</svg>';
  }

  function dirPill(D) { return D ? '<span class="v2-pill ' + (D.dir === '오름' ? 'up' : D.dir === '내림' ? 'dn' : '') + '">' + D.dir + ' ' + signedF(D.d) + '</span>' : '—'; }

  function trendCard(G) { var M = G.models[S.model]; return trendCardOf(G.F.maker, S.model, M && M.seg, chartW(1100, 9999)); }
  function trendCardOf(maker, model, seg, W) {               // 시세 추세 카드 — 한 대 산정과 모델 요약이 같이 쓴다
    var T = trendDataOf(maker, model, seg), mp = T.mp, sp = T.sp, D = mp.length >= 2 ? T.dm : T.ds, short = !D || D.short;
    var h = '<div class="card"><div class="card-title">시세 추세 <span class="hint">시세지수 · 7월 초 = 100</span>' +
      (short && (sp.length >= 2 || mp.length) ? ' <span class="v2-pill" title="매주 수집이 4주가 안 돼 방향을 짧은 기간으로 봅니다">짧음</span>' : '') + '</div>';
    if (sp.length < 2 && !mp.length) return h + '<p class="v2-note">추세 데이터가 아직 부족합니다</p></div>';
    h += '<div class="v2-legend">' + (mp.length ? '<span><i class="v2-lkey" style="background:var(--accent)"></i>' + esc(model) + '</span>' : '') +
      (sp.length ? '<span><i class="v2-dash"></i>' + esc(T.sname) + '</span>' : '') + (mp.length ? '<span><i class="v2-band"></i>흔들림 2배 범위</span>' : '') + '</div>' + trendSvg(T, W);
    var lm = mp[mp.length - 1], ls = sp[sp.length - 1], txt;          // 숫자와 방향 표시만(기획 v2.26 Q133) — 읽는 법은 섹션 i
    if (lm) txt = mmdd(lm.date) + ' 세부모델 <b>' + lm.v.toFixed(1) + '</b>' + (ls && ls.date === lm.date ? ' · ' + esc(T.sname) + ' <b>' + ls.v.toFixed(1) + '</b> <span class="v2-pill ' +
      (lm.v - ls.v >= 0.05 ? 'up' : lm.v - ls.v <= -0.05 ? 'dn' : '') + '">차급 대비 ' + signedF(lm.v - ls.v) + '</span>' : '');
    else txt = (T.loading ? '불러오는 중… ' : T.mm && T.mm.pidx != null ? '세부모델 <b>' + Number(T.mm.pidx).toFixed(1) + '</b>(선은 점이 모자라 생략) · ' : '세부모델은 신규 매물이 적어 차급 선만 · ') +
      (ls ? mmdd(ls.date) + ' ' + esc(T.sname) + ' <b>' + ls.v.toFixed(1) + '</b>' : '');
    var dl = !D ? '' : (D.short ? '방향(' + D.weeks + '주)' : '최근 4주') + ' · ' + (mp.length ? '세부모델 ' + dirPill(T.dm) + ' · ' : '') + esc(T.sname) + ' ' + dirPill(T.ds);
    return h + '<p class="v2-kv">' + txt + '</p>' + (dl ? '<p class="v2-kv">' + dl + '</p>' : '') + '</div>';
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

  function segCut(seg) {                                     // 차급 인하 매물 비율 = 같은 차급·구분 세부모델 인하 비율의 판매중 대수 가중(curve.js 지표 줄과 같은 식)
    if (!X.mm || !seg) return null;
    if (!X.mmCut) {
      var a = {};
      X.mmCut = {};
      X.mm.models.forEach(function (m) {
        if (m.cut == null || !m.on || m.new_cov) return;                 // 새로 수집 모델은 동급 기준에서 뺀다(리뷰 11-05)
        var c = a[m.seg + '·' + m.origin] || (a[m.seg + '·' + m.origin] = [0, 0]);
        c[0] += m.cut * m.on; c[1] += m.on;
      });
      Object.keys(a).forEach(function (k) { X.mmCut[k] = a[k][0] / a[k][1]; });
    }
    return X.mmCut[seg] != null ? X.mmCut[seg] : null;
  }
  function modelMarket(G) {                                  // 모델 요약의 판매 숫자 — 지표 줄과 같은 market_models(온라인 판매중 전체) 기준
    var seg = G.models[S.model] && G.models[S.model].seg, mm = X.mmBy && X.mmBy[G.F.maker + '|' + S.model] || null;
    var thin = !mm || mm.on < 100, w = function (r) { return r >= 1.15 ? '빠름' : r <= 0.87 ? '느림' : '비슷'; };
    return { mm: mm, sg: X.mm && X.mm.segments && X.mm.segments[seg] || {}, sc: segCut(seg), loading: !X.mmBy,
      word: function (r) { return thin ? '' : ' · ' + w(r); } };   // 판매중 100대 미만은 빠름·느림을 붙이지 않는다(지표 줄과 같은 기준)
  }

  function summary(G, miss) {                                // 모델 요약(기획 v2.26·v2.27 — 한 대 산정과 같은 틀): ① 판매 현황 ② 동급 대비 ③ 시세표 ④ 등급별 ⑤ 시세 추세
    var st = modelStats(G), K = modelMarket(G), mm = K.mm, co = curveOf(G), seg0 = G.models[S.model] && G.models[S.model].seg, M = st.M;
    var onN = mm ? mm.on : M.onsale_all != null ? M.onsale_all : st.on.length;
    var h = miss.length ? needCard(miss) : '';
    h += sec('model', 1, '판매 현황', [['숫자 기준', '판매중·판매율·체류일·인하·시세지수·잔존가치는 온라인 판매중 전체, 최근 판매·시세표·등급별은 비교 가능 매물(성능점검 있음) 기준입니다.'],
      ['최근 3개월 판매', '비교 가능 매물 중 목록에서 사라진 매물(재등록 제외)입니다.']],
      '<div class="v2-cards">' + tile('판매중', onN.toLocaleString(), '대', '비교 가능 ' + st.on.length.toLocaleString() + '대') +
      tile('최근 3개월 판매', st.sold.length.toLocaleString(), '대', '') + '</div>',
      { tools: (miss.length ? '<span class="v2-ref">참고</span>' : '') + '<button type="button" class="v2-btn" data-act="xlsxModel">엑셀 ↓</button>' });
    h += sec('market', 2, '동급 대비', cv().info(), cv().tiles(co) + cv().card(co, null, chartW(1100, 9999)),
      { peek: seg0 ? esc(segLabel(seg0)) + ' · ' + esc(S.model) + ' 전체(등급 무관)' : '' });
    h += sec('matrix', 3, '시세표' + (st.gsel ? ' · ' + S.grade : ''), [['시세표', '판매중 호가 중앙값(만원)입니다. 칸을 누르면 그 조건으로 한 대 산정합니다. 판매중 5대 미만 칸은 비웁니다.']],
      matrixCard(st), { tools: S.grade ? seg('mgrade', [['one', S.grade + '만'], ['all', '전체 등급']], VIEW.allGrades ? 'all' : 'one', '시세표 등급') : '' });
    h += sec('grades', 4, '등급별', [['등급별', '판매중 기준입니다. 등급을 누르면 그 등급으로 바꿉니다. 판매중이 많은 20개 등급만 보여 줍니다(엑셀에는 전체).']], gradeCard(st));
    h += sec('trend', 5, '시세 추세', [['시세 추세', TIP.trend], ['방향', '매주 수집이 4주 쌓이기 전에는 짧은 기간으로 보고 "짧음"을 붙입니다.']], trendCard(G));
    $('res').innerHTML = h;
    $('res').classList.toggle('v2-rise', rise('model|' + S.mk + '|' + S.model));
    condBar(null, null);
    navSet([['판매중', onN.toLocaleString()], ['주간 판매율', mm && mm.rate_w != null ? (mm.rate_w * 100).toFixed(1) + '%' : '–'], ['시세지수', mm && mm.pidx != null ? Number(mm.pidx).toFixed(1) : '–']],
      [['model', 1, '판매 현황'], ['market', 2, '동급 대비'], ['matrix', 3, '시세표'], ['grades', 4, '등급별', st.grades.length + '개'], ['trend', 5, '시세 추세']]);
    loadCurve(co);
  }

  function matrixCard(st) { return '<div class="card">' + matrixTable(st, -1, -1) + '</div>'; }   // 제목·등급 바꾸기는 섹션 머리(기획 v2.26)
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
    var h = '<div class="card"><div class="v2-tablewrap"><table class="t v2-tbl v2-gtbl"><thead><tr><th>등급</th><th class="num">판매중</th><th class="num">중앙 호가</th>' +
      '<th class="num">중위 연식</th><th class="num">중위 주행</th><th class="num">최근 판매</th></tr></thead><tbody>';
    st.grades.slice(0, 20).forEach(function (g) {
      h += '<tr><td><button type="button" class="v2-link" data-grade="' + esc(g.name) + '">' + esc(g.name) + '</button></td><td class="num">' + g.n +
        '</td><td class="num">' + man(g.med) + '</td><td class="num">' + g.year + '</td><td class="num">' + (g.km / 1e4).toFixed(1) + '만</td><td class="num">' + g.sold + '</td></tr>';
    });
    h += '</tbody></table></div>';
    if (st.grades.length > 20) h += '<p class="v2-note">판매중 많은 20개 등급만 · 엑셀에는 전체</p>';
    return h + '</div>';
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
    if (condState()) {
      rows.push(['사고 단계', c['사고라벨'] || '무사고'], ['이력 감가(%)', Math.round(R.D * 1000) / 10], ['이력 감가(만원)', mw(R.base * R.D)]);
      if (S.cond === '입력') rows.push(['입력 부위', S.items.length ? ISC.summary(S.items) : '없음(상태 미상으로 계산)']);
      (R.condLines || []).forEach(function (l) { rows.push(['  ' + l.label, l.capped ? '셈 안 함' : l.pct + '%']); });
      if (VIEW.condWarn.length) rows.push(['못 읽은 표기(계산에 넣지 않음)', VIEW.condWarn.join(', ')]);
    } else rows.push(['미상 계산', '비교 매물 평균 상태(이력 감가 ' + (Math.round(R.D * 1000) / 10) + '%)']);
    (R.repairLines || []).forEach(function (l) { rows.push(['  ' + l.label + '(만원)', -l.won]); });
    rows.push(['기계 결함', ['없음', '경미', '결함'][+S.mech]], ['수리 필요', S.fixes.join(', ') || '없음'], ['수리필요 수리비(자동, 만원)', R.repairAuto],
      ['예상 수리비(직접 입력, 만원)', mw(R.repairManual)], ['수리비 합계(만원)', mw(R.repair)], ['무사고 시세(만원)', mw(R.base)],
      sec('결과'), ['추정 시세(만원, 수리비 반영)', mw(R.price)], ['범위 하한(만원)', mw(R.range[0])], ['범위 상한(만원)', mw(R.range[1])]);
    if (R.est0 != null) rows.push(['상태 미상 · 무사고라면(만원)', mw(R.est0 - R.repair)]);
    var fpx = ENG.factoryPrice ? ENG.factoryPrice(G, car) : null;
    if (fpx) rows.push(['출고가(만원, 신차 소비자가)', mw(fpx.op)], ['출고가 근거', fpx.basis + ' 매물 ' + fpx.n + '대의 가운데 값(' + man(fpx.lo) + '~' + man(fpx.hi) + '만)'],
      ['잔존율(%, 추정 시세 ÷ 출고가)', Math.round(R.est / fpx.op * 1000) / 10]);
    rows.push(['환산 비율(%)', R.rate], ['환산 비율 출처', R.rateSource], ['환산가 사고 감가(%, 기록부를 넣으면 경매 기준)', Math.round((R.convD || 0) * 1000) / 10],
      ['환산가 수리비(만원, 수리필요는 ' + R.repairShare + '%만)', mw(R.repairConv)], ['환산가(만원)', mw(R.converted)], ['신뢰도', R.grade],
      ['비교 매물(대)', R.n], ['매칭 단계', R.stepName], ['이상치 제외(대)', R.out], ['직접 제외(대)', S.ex.length], sec('보정 근거(만원, 비교 매물 평균)'));
    ['차령', '주행', '성능', '색상', '렌트', '등급', '시점'].forEach(function (k) { rows.push([k, R.basis[k]]); });
    rows.push(['보정 계수 수준', R.coefLevel], sec('산정 기준'),
      ['데이터 기준', '온라인 매물 ' + dataDate(true)],
      ['비교 매물 파일', F.version], ['보정 계수', X.coef.version], ['환산 비율', RatesStore.label(X.rates)],
      ['비교 범위', S.sold ? '판매중 + 최근 3개월 판매' : '판매중만'], ['산정 화면 주소', shareUrl()],
      ['차 이름', '경매장 4단계 표기(모델·세부모델·등급·세부등급). ' + (encLine(S.mk, S.grp, S.model) || '매물 표기 없음')],
      ['참고', '추정 시세는 온라인 소매 호가 기준. 환산가는 팀 환산 비율(도·소매 갭 요약치)을 적용한 값']);
    var cr = [['유사도', '매물ID', '상태', '판매 확인일', '최초등록', '주행(km)', '색상', '등급', '세부등급', '매물 세부모델', '매물 등급', '매물 세부등급', '이름 근거',
      '연료', '사고 라벨', '이력 감가(%)', '손상 부위',
      '글로비스 종합', '글로비스 감점', '호가(만원)', '보정 후(만원)', '첫 호가(만원)', '인하(만원)', '체류일', '이상치', '직접 제외', '매물 링크']];
    function line(row, x) {
      var p0 = row[fi.p0], price = row[fi.price], sold = row[fi.sold] === 1, reg = String(row[fi.reg]), e = encOfRow(G, row);
      return [x ? x.sim : null, row[fi.id], sold ? '판매' : '판매중', sold ? row[fi.sd] : null, reg.slice(0, 4) + '-' + reg.slice(4, 6), row[fi.km],
        F.colors[row[fi.col]], F.grades[row[fi.g]], F.trims[row[fi.t]] || null,
        e ? e.model : null, e ? e.grade : null, e ? e.trim || null : null, fi.q != null ? ['정확', '가까운 이름', '매물 이름'][row[fi.q]] || null : null,   // 매물 원래 이름(기획 v2.23)
        F.fuels ? F.fuels[row[fi.fu]] : null, F.labels[row[fi.acc]], x && x.D != null ? Math.round(x.D * 1000) / 10 : null,
        ENG.damage(G, row).join(' · ') || null,
        row[fi.gv], row[fi.gp], price, x ? Math.round(x.adj) : null, p0, p0 != null && p0 > price ? p0 - price : null,
        x && x.dwell != null ? x.dwell : null, x && x.outlier ? '예' : null, x ? null : '예', 'https://fem.encar.com/cars/detail/' + row[fi.id]];
    }
    R.comps.forEach(function (x) { cr.push(line(x.row, x)); });
    modelRows(G, S.model).filter(function (r) { return S.ex.indexOf(String(r[fi.id])) >= 0; }).forEach(function (r) { cr.push(line(r, null)); });
    XlsxWriter.download(fileSafe('시세산정_' + S.model + '_' + S.grade + (S.trim ? '_' + S.trim : '') + '_' + (S.m ? S.y + '-' + pad(S.m) : S.y) + '_' +
      (kmNum(S.km) / 1e4).toFixed(1) + '만km_' + today()) + '.xlsx', [
      { name: '산정 결과', rows: rows, header: true, widths: [32, 64] },
      { name: '비교 매물', rows: cr, header: true, freeze: true, money: [5, 19, 20, 21, 22],
        widths: [7, 11, 7, 11, 9, 10, 9, 18, 14, 24, 20, 14, 11, 8, 8, 12, 34, 10, 10, 10, 11, 11, 9, 7, 7, 8, 42] },
      { name: '분석', rows: analysisRows(G, car, c), widths: [40, 14, 14, 18, 16, 14, 12] }]);
  }

  function exportModel() {
    var G = grp();
    if (!G || !S.model) return;
    var st = modelStats(G), F = G.F, K = modelMarket(G), mm = K.mm || {}, sg = K.sg, iv = X.mm && X.mm.speed_interval;
    var r1 = function (v) { return v == null ? null : +(v * 100).toFixed(1); };   // 비율 → % 소수 1자리(화면 카드와 같은 반올림)
    var info = [['항목', '값'], ['모델', F.maker + ' ' + S.model], ['판매중(전체)', K.mm ? mm.on : st.M.onsale_all], ['판매중(비교 가능)', st.on.length],
      ['최근 3개월 판매(비교 가능)', st.sold.length],
      ['주간 판매율(%)', r1(mm.rate_w)], ['차급 주간 판매율(%)', r1(sg.rate_w)], ['판매율 구간', iv ? iv[0] + '→' + iv[1] : null],
      ['중위 체류일(최근 90일 판매)', K.mm ? mm.dwell : st.dw != null ? Math.round(st.dw) : null], ['차급 중위 체류일', K.mm ? sg.dwell : st.seg.dwell],
      ['가격 인하 매물 비율(%)', K.mm ? r1(mm.cut) : r1(st.cut)], ['차급 가격 인하 비율(%)', K.mm ? r1(K.sc) : r1(st.seg.cut)],
      ['데이터 기준', '온라인 매물 ' + dataDate(true)], ['비교 매물 파일', F.version],
      ['참고', (K.mm ? '판매중·판매율·체류일·인하 비율은 온라인 판매중 전체 기준. ' : '시장 숫자가 없어 체류일·인하 비율은 비교 가능 매물 기준. ') +
        '최근 3개월 판매·시세표·등급별은 비교 가능 매물(성능점검 있음). 시세표 칸은 5대 미만이면 비움']];
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
      [B('목록 관측일'), B('세부모델 지수'), B('세부모델 신규(대)'), B('세부모델 흔들림(±, 표준오차)'), B(td.sname + ' 지수'), B(td.sname + ' 신규(대)')]);
    var dates = [];
    td.mp.concat(td.sp).forEach(function (p) { if (dates.indexOf(p.date) < 0) dates.push(p.date); });
    dates.sort().forEach(function (dt) {
      var m = td.mp.find(function (p) { return p.date === dt; }), s = td.sp.find(function (p) { return p.date === dt; });
      rows.push([dt, m ? m.v : null, m ? m.n : null, m ? f1(m.se) : null, s ? s.v : null, s ? s.n : null]);
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
      (ld.base0 ? ' · 만원은 이 차가 무사고일 때 ' + man(ld.base0) + '만 기준' : '')], [], ['데이터 기준', '온라인 매물 ' + dataDate(true)]);
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
    var cond = !condState() ? '성능 상태 미상(평균 상태로 계산)' : (c['사고라벨'] || '무사고') + (r.D ? ' · 이력 감가 −' + (r.D * 100).toFixed(1) + '%' : '') +
      (r.repairAuto ? ' · 수리필요 −' + r.repairAuto + '만' : '') + (S.cond === '입력' && S.items.length ? '(' + ISC.summary(S.items) + ')' : '');
    var h = '<div class="sh-top"><div><div class="sh-eyebrow">시세 산정 요약</div><div class="sh-title">' + esc(F.maker + ' ' + S.model) + ' · ' + esc(S.grade + (S.trim ? ' ' + S.trim : '')) + '</div>' +
      '<div class="sh-sub">' + regText() + ' 등록 · ' + car['주행km'].toLocaleString('ko-KR') + 'km · ' + esc(S.color || '색상 상관없음') + (S.rent ? ' · 렌트 번호판' : '') + ' · ' + esc(cond) + '</div>' +
      (encLine(S.mk, S.grp, S.model) ? '<div class="sh-sub">' + esc(encLine(S.mk, S.grp, S.model)) + '</div>' : '') + '</div>' +   // 경매장 이름 옆 매물 표기(기획 v2.23 Q102)
      '<div class="sh-date">데이터 기준 ' + dataDate(true) + '<br>작성 ' + stamp + '</div></div>';
    h += '<div class="sh-nums"><div class="sh-num main"><span>추정 시세 · 온라인 소매 호가 기준</span><b>' + man(r.price) + '<small>만원</small></b><em>범위 ' + man(r.range[0]) + ' ~ ' + man(r.range[1]) +
      '만(보정 후 가운데 50%)' + (r.repair ? ' · 수리비 −' + man(r.repair) + '만 반영' : '') +
      (S.cond === '입력' && S.items.length ? ' · 무사고였다면 ' + man(r.base - r.repairManual) + '만' : r.est0 != null ? ' · 무사고라면 ' + man(r.est0 - r.repair) + '만' : '') +
      (function () { var fp = ENG.factoryPrice ? ENG.factoryPrice(G, car) : null; return fp ? '<br>출고가 ' + man(fp.op) + '만 · 잔존율 ' + Math.round(r.est / fp.op * 100) + '%' + (fp.exact ? '' : '(등급 기준)') : ''; })() +
      '</em></div>' +
      (o.conv ? '<div class="sh-num"><span>환산가 · 경매 예상가</span><b>' + man(r.converted) + '<small>만원</small></b><em>환산 비율 ' + r.rate + '% · ' + esc(r.rateSource) + convFix(r) +
        (convLine(r) ? '<br>' + convLine(r) : '') + '</em></div>' : '') +
      '<div class="sh-num"><span>신뢰도</span><b>' + r.grade + '</b><em>비교 매물 ' + r.n + '대 · ' + stepNo + '단계(' + esc(stepName) + ')' + (r.out ? ' · 이상치 제외 ' + r.out + '대' : '') + '</em></div></div>';
    var f = flowData(G, car, c), after = [];                // 한 장에 들어가게 수리비·환산은 막대 대신 한 줄로
    if (r.repair) after.push('수리비 −' + man(r.repair) + '만 → 수리비 반영 <b>' + man(r.price) + '만</b>');
    var cfx = r.repairConv ? ' · 수리비 −' + man(r.repairConv) + '만' : '';
    if (o.conv) after.push(convLine(r) ? '무사고 ' + man(r.base) + '만 → 경매 기준 사고 −' + (r.convD * 100).toFixed(1) + '% · 환산 −' + r.rate + '%' + cfx + ' → 환산가 <b>' + man(r.converted) + '만</b>'
      : '환산 −' + r.rate + '%(' + signed(-r.est * r.rate / 100) + '만 · ' + esc(r.rateSource) + ')' + cfx + ' → 환산가 <b>' + man(r.converted) + '만</b>');
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
        '<td><span class="g">' + esc(F.grades[row[fi.g]] + (trim ? ' ' + trim : '')) + '</span></td><td>' + esc(F.labels[row[fi.acc]]) + (x.D ? ' −' + (x.D * 100).toFixed(1) + '%' : '') + '</td>' +
        '<td class="num">' + man(row[fi.price]) + '</td><td class="num"><b>' + man(x.adj) + '</b></td><td>' + (x.sold ? '판매 ' + mmdd(row[fi.sd]) : '판매중') + '</td>' +
        '<td class="num">' + (x.dwell != null ? x.dwell + '일' : '–') + '</td></tr>';
    });
    h += '</tbody></table>';
    return h + '<div class="sh-foot">근거: 온라인 매물(' + dataDate(true) + ') 중 같은 세부모델 비교 매물 ' + kept.length + '대(판매중 ' + nOn + ' · 최근 3개월 판매 ' + (kept.length - nOn) +
      ')를 이 차 조건으로 맞춘 값. 보정 계수: ' + esc(COEF_LEVEL[r.coefLevel] || r.coefLevel) + '. 추정 시세는 온라인 소매 호가 기준 추정치로 실제 거래가와 다를 수 있습니다. 판매 = 목록에서 사라짐(추정).' +
      (o.conv ? ' 환산가 = 무사고 시세 × (1 − 경매 기준 사고 감가) × (1 − 환산 비율) − 수리비(직접 입력 전부 + 수리필요 표준 수리비의 반영 몫). 상태 미상이면 사고 감가는 추정 시세와 같게.' : '') + (o.url ? '<br>산정 화면: ' + esc(readableUrl()) : '') + '</div>';
  }
  function shareUrl() { return location.origin + location.pathname + location.hash; }   // 받은 사람이 이용 통계에서 빠지지 않게 쿼리는 뺀다
  function readableUrl() {                                   // 주소의 한글을 풀어 읽기 쉽게(그대로 붙여 넣어도 열린다)
    try { return decodeURI(shareUrl()); } catch (e) { return shareUrl(); }
  }

  // ───── 화면 틀 · 이벤트 ─────
  function marketLine() {
    var pts = X.mi.series['전체|전체'] || [], last = null, crawls = X.mi.crawls || [];
    for (var i = pts.length - 1; i >= 0; i--) if (pts[i]['시세'] != null) { last = pts[i]; break; }
    var asOf = crawls.length ? crawls[crawls.length - 1].date : '';
    $('asOf').textContent = asOf ? asOf.slice(5, 7) + '.' + asOf.slice(8, 10) + '(' + '일월화수목금토'.charAt(new Date(asOf + 'T00:00:00').getDay()) + ') 목록 기준' : '—';
    if (!last) return;
    var f1 = function (v) { return Number(v).toFixed(1); };
    var lab = last.label || '', tone = /강세/.test(lab) ? 'up' : /약세/.test(lab) ? 'dn' : '';
    var h = '<span class="v2-tick" title="7월 초 = 100 · ' + mmdd(last.date) + ' 목록">시세지수<b>' + f1(last['시세']) + '</b></span>';
    if (last['재고'] != null) h += '<span class="v2-tick">재고지수<b>' + f1(last['재고']) + '</b></span>';
    if (last['시황'] != null) h += '<span class="v2-tick">시황지수<b>' + f1(last['시황']) + '</b>' + (lab ? '<i class="' + tone + '">' + esc(lab) + '</i>' : '') + '</span>';
    h += '<a class="v2-mlink" href="#/market">시장 시황 →</a>';
    $('marketLine').innerHTML = '<div>' + h + '</div>';
  }

  function batch() {                                         // 묶음 산정(batch.js) — 처음 쓸 때 만든다(묶음에 추가도 여기로)
    if (!B) {
      B = V2Batch.create({ X: X, ENG: ENG, ISC: ISC, GROUPS: GROUPS, getJSON: getJSON, esc: esc, man: man, pad: pad, today: today,
        fileSafe: fileSafe, tile: tile, href: function (s) { return query(Object.assign(blank(), s), 'one'); },
        terms: { list: termList, writable: function () { return !!TERMS.writable; }, pw: function () { return TERM_PW; },   // 기록부 팀 표기 사전(기획 v2.31)
          save: function (adds, by, pw) {
            return RatesStore.save('/api/terms', { password: pw, by: by, add: adds }).then(function (team) {
              TERMS.team = team; TERM_PW = pw;
              try { localStorage.setItem('v2.rates.by', by); } catch (e) { /* 이름 기억 못 해도 된다 */ }
              return team;
            });
          } } });
    }
    return B;
  }
  function batchCar() {                                     // 묶음 산정 한 줄로 넘길 이 차
    return { name: S.mk + ' ' + S.model + ' ' + S.grade + (S.trim ? ' ' + S.trim : ''), reg: S.m ? S.y + '-' + pad(S.m) : S.y, year: S.y,
      km: S.km, color: S.color, cost: S.cost, rent: S.rent,
      cond: S.cond === '미상' || !S.items.length && S.cond === '입력' ? '' : S.cond === '무사고' ? '무사고' : condLine(S.items) };
  }
  function condLine(items) {                                 // 묶음 줄의 성능 글 — 상태 이름으로 써야 수리필요도 남는다(기호 X·W 글은 수리필요를 버림, 리뷰 11-05 D2-7)
    return ISC.summary(items).split(' · ').join(', ');
  }
  function addToBatch(btn) {                                 // 한 대 산정 → 묶음 산정 목록(기획안 6장) — 같은 차가 이미 있으면 더하지 않는다
    var r = batch().addCar(batchCar());
    btn.outerHTML = '<button type="button" class="v2-btn" data-act="openBatch">' + (r.dup ? '이미 묶음에 있음 · ' : '묶음 산정 열기 · ') + r.n + '대</button>';
  }

  function markMode(v) {
    document.querySelectorAll('button[data-seg="mode"]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === v); });
  }
  function applyMode() {                                     // 묶음 산정·환산 비율은 입력·결과 대신 각자의 화면
    var m = VIEW.mode, must = m !== 'one' && window.V2Auth && V2Auth.mustChange(), lk = must || m !== 'one' && window.V2Auth && V2Auth.locked(m);
    if (window.CT) CT.screen('price.' + m);                  // 이용 통계(기획 v2.28) — 지금 화면
    pageHead();
    navLocks();
    $('modeLock').hidden = !lk;
    if (lk) {                                                // 회원 전용(로그인 기획 Q277) — 자물쇠 안내만
      $('grid').hidden = true; $('batch').hidden = true; $('ratesView').hidden = true;
      markMode(m);
      $('modeLock').innerHTML = must ? V2Auth.mustHtml() : V2Auth.lockHtml(m);
      return;
    }
    $('grid').hidden = m === 'batch' || m === 'rates';
    $('batch').hidden = m !== 'batch';
    $('ratesView').hidden = m !== 'rates';
    if (m === 'batch') {
      markMode('batch');
      batch().show($('batch'));
    } else if (m === 'rates') {
      markMode('rates');
      if (!RV) RV = V2Rates.create({ X: X, ENG: ENG, esc: esc, man: man, store: X.store, changed: function () {},   // 한 대 산정은 돌아갈 때 다시 계산
        cond: { base: X.model.cond, store: X.condStore, CT: function () { return CTB; },                  // 기록부 감가 · 수리비 표(기획 v2.32)
          apply: function (team) {                         // 표가 바뀌면 비교 매물 감가도 다시(모델별로 계산해 둔 것을 비움)
            X.condStore.team = team; CTB.apply(team);
            Object.keys(GROUPS).forEach(function (f) { GROUPS[f].cache = {}; });
          } } });
      RV.show($('ratesView'));
    } else compute();
  }

  // ───── 화면 고르기: #/pulse = 마켓 펄스(pulse.js) · #/market = 시장 시황(market.js) · #/data = 데이터(data.js, 회원만) · #/login · #/signup · #/account(auth.js) · 그 밖 = 시세 산정(#/report 옛 주소 → 모델 요약) ─────
  var PAGES = { pulse: '#/pulse', report: '#/report', market: '#/market', data: '#/data', admin: '#/admin', login: '#/login', signup: '#/signup', account: '#/account' }, PAGE0 = null;
  function route() {
    var h0 = location.hash, page = 'price';
    Object.keys(PAGES).forEach(function (k) { if (h0.indexOf(PAGES[k]) === 0) page = k; });
    if (window.V2Auth && V2Auth.mustChange() && !/^(price|account|login|signup)$/.test(page)) {   // 임시 비밀번호로 들어왔으면 새 비밀번호부터(로그인 기획 3.2)
      location.replace('#/account?next=' + encodeURIComponent(h0));
      return Promise.resolve();
    }
    if (page !== 'report') {                                 // 다른 화면으로 넘어오면 맨 위부터(마켓 펄스 아래쪽 링크로 모델 요약에 와도 중간에 서지 않게)
      if (PAGE0 && PAGE0 !== page) window.scrollTo(0, 0);
      PAGE0 = page;
    }
    var market = page === 'market', qs = function () { var i = h0.indexOf('?'); return new URLSearchParams(i >= 0 ? h0.slice(i + 1) : ''); };
    $('priceView').hidden = page !== 'price';
    $('mbar').hidden = true;
    $('marketView').hidden = page !== 'market';
    $('dataView').hidden = page !== 'data';
    $('adminView').hidden = page !== 'admin';
    $('pulseView').hidden = page !== 'pulse';
    var authPage = page === 'login' || page === 'signup' || page === 'account', lockPage = !!(window.V2Auth && V2Auth.locked(page));
    $('authView').hidden = !authPage;
    $('lockView').hidden = !lockPage;
    if (lockPage) { $('marketView').hidden = true; $('dataView').hidden = true; $('pulseView').hidden = true; }
    if (window.V2Auth) { V2Auth.header($('authBox')); navLocks(); }
    var fc = $('footConv');                                  // 아래 '환산가는 …' 안내는 시세 산정에서만(마켓 펄스·시장 시황은 외부에도 보여 주는 화면)
    if (fc) fc.hidden = page !== 'price';
    var na = $('navAdmin');
    if (na) na.classList.toggle('on', page === 'admin');
    [['navPrice', 'price'], ['navPulse', 'pulse'], ['navMarket', 'market'], ['navData', 'data']].forEach(function (n) {
      var a = $(n[0]);
      if (a) a.classList.toggle('on', page === n[1]);
      if (a && page === n[1]) {                               // 휴대폰 폭에서 탭 줄이 넘치면 지금 탭이 보이게 가로로만 민다
        var nav = a.parentNode, l = a.offsetLeft - nav.offsetLeft;
        if (l < nav.scrollLeft || l + a.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = l - (nav.clientWidth - a.offsetWidth) / 2;
      }
    });
    if (page !== 'price' && page !== 'report' && window.CT) CT.screen(page);   // 이용 통계(기획 v2.28) — 시세 산정은 applyMode 가 알린다
    if (authPage) { V2Auth.show(page, $('authView'), qs()); return Promise.resolve(); }   // 로그인 · 가입 신청 · 내 정보(로그인 기획 3장)
    if (lockPage) { $('lockView').innerHTML = V2Auth.lockHtml(page); return Promise.resolve(); }   // 회원 전용(Q277)
    if (page === 'pulse') {
      if (!PV) PV = V2Pulse.create(subCtx('#/pulse', 'navPulse'));
      PV.show($('pulseView'), qs());
      return Promise.resolve();
    }
    if (page === 'report') {                                 // 모델 리포트 탭은 시세 산정에 합쳤다(기획 v2.24 Q112) — 옛 주소는 그 모델의 모델 요약으로
      var rq = qs();
      history.replaceState(null, '', query(Object.assign(blank(), { mk: rq.get('mk') || '', grp: rq.get('grp') || '', model: rq.get('model') || '' }), 'model'));
      return route();
    }
    if (page === 'admin') {                                  // 관리자 대시보드(기획 v2.28 · 5.11.3) — 이용 통계, 비밀번호
      if (!AV) AV = V2Admin.create({ esc: esc, bindTips: bindTips, fileSafe: fileSafe, audit: function () { return X.audit; }, auth: window.V2Auth });   // 시세 점검 요약(v2.33) · 관리자 회원(로그인 기획)
      AV.show($('adminView'));
      return Promise.resolve();
    }
    if (page === 'data') {                                   // 데이터 — 회원에게 요약 파일만(로그인 기획 Q288)
      if (!DV) DV = V2Data.create({ X: X, esc: esc, getJSON: getJSON, root: ROOT });
      DV.show($('dataView'));
      return Promise.resolve();
    }
    if (market) {
      if (!MK) {
        MK = V2Market.create({ X: X, esc: esc, man: man, getJSON: getJSON, fileSafe: fileSafe, today: today, reportHref: reportHref, mm: function () { return X.mmWait; },
          href: function (s, mode) { return query(Object.assign(blank(), s), mode || 'one'); },
          hash: function (st) {                              // 시장 시황 상태도 주소에(공유·새로 고침)
            var q = new URLSearchParams();
            if (st.o !== '전체') q.set('o', st.o);
            if (st.s !== '전체') q.set('s', st.s);
            if (st.range !== 'all') q.set('range', st.range);
            if (st.sort !== 'on' || st.dir !== -1) { q.set('sort', st.sort); q.set('dir', st.dir > 0 ? '1' : '-1'); }
            if (st.qx && st.qx !== 'rv') q.set('qx', st.qx);   // 사분면 가로축(기본 잔존가치는 생략)
            var str = q.toString();
            history.replaceState(null, '', '#/market' + (str ? '?' + str : ''));
            $('navMarket').setAttribute('href', '#/market' + (str ? '?' + str : ''));   // 시세 산정에 갔다 와도 보던 그대로
          } });
      }
      var h = location.hash, i = h.indexOf('?');
      MK.show($('marketView'), new URLSearchParams(i >= 0 ? h.slice(i + 1) : ''));
      return Promise.resolve();
    }
    var it0 = JSON.stringify(S.items);
    ROUTING = true;
    S = fromHash();
    if (JSON.stringify(S.items) !== it0) VIEW.recOpen = null;
    var ck = S.mk + '|' + S.grp + '|' + S.model, tx = VIEW.condRes && VIEW.condRes.state === '입력' ? VIEW.condRes.items : [];
    if ((VIEW.carKey != null && VIEW.carKey !== ck) || (VIEW.condText && (S.cond !== '입력' || tx.some(function (p) { return !S.items.some(function (it) { return key(it) === key(p) && it.status === p.status; }); })))) {
      resetRec();                                            // 글이 지금 차의 부위와 다르면 이전 차의 글
      if (VIEW.carKey !== ck) { VIEW.nameMsg = ''; VIEW.nameCands = []; }
    }
    VIEW.carKey = ck;
    var lm = legacyModel(S);                                 // 매물 이름으로 된 옛 주소·최근 산정 → 경매 이름
    if (lm) toHash();
    $('navPrice').setAttribute('href', location.hash || '#/price');
    renderInputs();
    ROUTING = false;
    return loadGroup().then(function () {
      var lg = legacyGrade(S, grp());
      if (lg) toHash();
      legacyNote(lm, lg);
      var bad = urlCheck();
      if (bad.length) { toHash(); VIEW.nameMsg = '<span class="v2-warnt">주소의 ' + esc(bad.join(' · ')) + '을(를) 찾지 못해 비웠습니다</span>'; }
      renderInputs();
      applyMode();
    }, function (e) { ROUTING = false; throw e; });
  }

  function urlCheck() {                                      // 주소(남이 만든 링크 · 옛 주소)의 없는 세부모델 · 등급 · 세부등급 · 색상 → 비우고 이름을 돌려준다
    var G = grp(), out = [];
    if (S.color && COLORS.indexOf(S.color) < 0) { out.push('색상 「' + S.color + '」'); S.color = ''; }
    if (!G || !S.model) return out;
    if (!G.models[S.model]) { out.push('세부모델 「' + S.model + '」'); S.model = ''; S.grade = ''; S.trim = ''; return out; }
    var rows = modelRows(G, S.model), fi = G.fi;
    if (S.grade && !rows.some(function (r) { return G.F.grades[r[fi.g]] === S.grade; })) { out.push('등급 「' + S.grade + '」'); S.grade = ''; S.trim = ''; }
    if (S.trim && !rows.some(function (r) { return G.F.grades[r[fi.g]] === S.grade && G.F.trims[r[fi.t]] === S.trim; })) { out.push('세부등급 「' + S.trim + '」'); S.trim = ''; }
    return out;
  }
  function reportHref(mk, grp, model) {                      // 세부모델 한 개 보기 = 시세 산정 모델 요약(마켓 펄스·시장 시황에서 링크 — 기획 v2.24, 모델 리포트 탭을 합침)
    return query(Object.assign(blank(), { mk: mk || '', grp: grp || '', model: model || '' }), 'model');
  }
  function subCtx(path, navId) {                             // 마켓 펄스에 넘기는 데이터·도우미
    return { X: X, esc: esc, man: man, pct: pct, signed: signed, getJSON: getJSON, fileSafe: fileSafe, today: today, root: ROOT, bindTips: bindTips,
      mm: function () { return X.mmWait; },                  // market_models.json(Promise) — X.mm·X.mmBy 도 채워진다
      reportHref: reportHref,
      hash: function (q) {                                   // 화면 상태를 주소에(공유·새로 고침) — 위쪽 탭도 그 주소로
        var str = q ? q.toString() : '';
        history.replaceState(null, '', path + (str ? '?' + str : ''));
        var a = $(navId);
        if (a) a.setAttribute('href', path + (str ? '?' + str : ''));
      } };
  }
  function bindTips(el) {                                    // [data-tip] 말풍선(#tip) — 마우스는 따라다니고, 키보드·휴대폰은 초점 아래
    var tip = $('tip');
    if (!tip || el.getAttribute('data-tips')) return;
    el.setAttribute('data-tips', '1');
    el.addEventListener('mouseover', function (e) {
      var t = e.target.closest && e.target.closest('[data-tip]');
      if (!t) return;
      tip.textContent = t.getAttribute('data-tip');
      tip.hidden = false;
    });
    el.addEventListener('mousemove', function (e) {
      if (tip.hidden) return;
      tip.style.left = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8) + 'px';
      tip.style.top = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8) + 'px';
    });
    el.addEventListener('mouseout', function (e) {
      var t = e.target.closest && e.target.closest('[data-tip]');
      if (t && !(e.relatedTarget && t.contains(e.relatedTarget))) tip.hidden = true;
    });
    el.addEventListener('focusin', function (e) {
      var t = e.target.getAttribute && e.target.getAttribute('data-tip');
      if (!t) return;
      var b = e.target.getBoundingClientRect();
      tip.textContent = t;
      tip.hidden = false;
      tip.style.left = Math.max(8, Math.min(b.left, window.innerWidth - tip.offsetWidth - 8)) + 'px';
      tip.style.top = (b.bottom + 6) + 'px';
    });
    el.addEventListener('focusout', function () { tip.hidden = true; });
  }

  function lockMark(el, on) {                                // 잠긴 탭 · 단추 옆 자물쇠(로그인 기획 Q277) — 화면 낭독기에는 '마켓 펄스(회원 전용)'
    var s = el.querySelector('.v2-lock');
    if (on && !s) el.insertAdjacentHTML('beforeend', '<span class="v2-lock" aria-hidden="true">🔒</span>');
    if (!on && s) s.parentNode.removeChild(s);
    var name = el.textContent.replace('🔒', '').trim();
    if (on) { el.setAttribute('aria-label', name + '(회원 전용)'); el.setAttribute('title', '로그인하면 볼 수 있습니다'); }
    else if (el.hasAttribute('aria-label') && /\(회원 전용\)$/.test(el.getAttribute('aria-label'))) { el.removeAttribute('aria-label'); el.removeAttribute('title'); }
  }
  function navLocks() {
    var a = window.V2Auth;
    [['navPulse', 'pulse'], ['navMarket', 'market'], ['navData', 'data']].forEach(function (n) { var el = $(n[0]); if (el) lockMark(el, !!(a && a.locked(n[1]))); });
    document.querySelectorAll('button[data-seg="mode"]').forEach(function (b) { lockMark(b, !!(a && a.locked(b.getAttribute('data-v')))); });
  }
  var AUTH0 = null;
  function authChanged() {                                   // 로그인 · 로그아웃 → 머리 메뉴 · 자물쇠, 잠김이 바뀌면 지금 화면을 다시
    var a = window.V2Auth;
    if (!a) return;
    a.header($('authBox'));
    navLocks();
    var key = (a.member() ? 'm' : '-') + (a.state().enforce ? 'e' : '') + (a.admin() ? 'a' : '');
    if (AUTH0 !== null && AUTH0 !== key) route().catch(fail);
    AUTH0 = key;
  }
  function layout() {
    $('app').innerHTML = '<div id="priceView"><div class="v2-phead"><div class="v2-ptl"><h1 class="v2-h1" id="pTitle">시세 산정</h1><div class="v2-psub" id="pSub"></div></div>' +
      '<div class="v2-mode">' + seg('mode', [['one', '한 대 산정'], ['model', '모델 요약'], ['batch', '묶음 산정'], ['rates', '⚙ 환산 비율']], VIEW.mode, '산정 방식') + '</div></div>' +
      '<div id="modeLock" hidden></div>' +
      '<div class="v2-grid" id="grid"><section class="v2-cond" id="inp" aria-label="대상 차 조건"></section>' +
      '<div class="v2-rescol"><nav class="v2-snav" id="snav" aria-label="결과 목차" hidden></nav>' +
      '<div class="v2-main"><div class="v2-condbar" id="condbar" hidden></div><section class="v2-result" id="res" aria-live="polite"></section></div></div></div>' +
      '<section class="v2-batch" id="batch" aria-label="묶음 산정" hidden></section>' +
      '<section class="v2-batch v2-rates" id="ratesView" aria-label="환산 비율 설정" hidden></section>' +
      '<div class="v2-mbar" id="mbar" hidden></div></div>' +
      '<section class="v2-batch v2-pulse" id="pulseView" aria-label="마켓 펄스" hidden></section>' +
      '<section class="v2-batch v2-mk" id="marketView" aria-label="시장 시황" hidden></section>' +
      '<section class="v2-batch" id="dataView" aria-label="데이터" hidden></section>' +
      '<section class="v2-batch adm" id="adminView" aria-label="관리자" hidden></section>' +
      '<section class="v2-batch" id="authView" aria-label="로그인 · 가입 · 내 정보" hidden></section>' +
      '<section class="v2-batch" id="lockView" aria-label="회원 전용" hidden></section>';
    var inp = $('inp'), res = $('res'), tip = $('tip');
    inp.addEventListener('change', function (e) {
      var t = e.target, k = t.getAttribute('data-k');
      if (!k || ROUTING || !t.isConnected) return;            // 뒤로 가기로 다시 그린 칸의 이전 값이 새 차에 덮이지 않게
      if (k === 'rent' || k === 'sold') { S[k] = t.checked; changed(); return; }
      if (k === 'km' || k === 'cost' || k === 'rate') {
        S[k] = t.value;
        if (k === 'km' && /^[\d,\s]+$/.test(t.value) && kmNum(t.value) != null) { S.km = String(kmNum(t.value)); t.value = kmNum(t.value).toLocaleString('ko-KR'); }   // 50000 → 50,000
        changed();
        return;
      }
      if (k === 'pos') { setPos(+t.getAttribute('data-i'), t.value); syncText(); renderInputs(); changed(); return; }
      S[k] = t.value;
      if (k === 'grade' || k === 'trim') VIEW.carOpen = false;   // 다 고르면 한 줄 경로로 접는다(기획 v2.26 Q138)
      if (k === 'mk') { S.grp = ''; S.model = ''; S.grade = ''; S.trim = ''; S.ex = []; }
      if (k === 'grp') { S.model = ''; S.grade = ''; S.trim = ''; S.ex = []; }
      if (k === 'mk' || k === 'grp') newCar();
      if (k === 'model') { S.grade = ''; S.trim = ''; S.ex = []; VIEW.nameMsg = ''; VIEW.nameCands = []; }
      if (k === 'grade') { S.trim = ''; S.ex = []; }
      renderInputs();
      if (k === 'grp') { loadGroup().then(function () { renderInputs(); changed(); }).catch(fail); return; }
      changed();
    });
    inp.addEventListener('input', function (e) {
      if (e.target.id === 'condText') { condLive(); return; }
      if (ROUTING || !e.target.isConnected) return;
      var k = e.target.getAttribute('data-k');
      if (k === 'km' || k === 'cost' || k === 'rate') { S[k] = e.target.value; changed(); }
    });
    inp.addEventListener('toggle', function (e) {            // 더 보기 펼침 상태 기억(다시 그려도 그대로) — toggle 은 거품이 없어 잡기 단계에서
      if (e.target.classList && e.target.classList.contains('v2-more')) VIEW.moreOpen = e.target.open;
    }, true);
    inp.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (e.target.id === 'nameText') { e.preventDefault(); findName(); }
    });
    function clicks(e) {
      var pt = e.target.closest && e.target.closest('[data-pt]');   // 그림의 비교 매물 점
      if (pt) { showComp(pt.getAttribute('data-pt')); return; }
      var b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-need')) { focusNeed(b.getAttribute('data-need')); return; }
      if (b.hasAttribute('data-info')) { infoSec(b.getAttribute('data-info'), b); return; }
      if (b.hasAttribute('data-fold')) { foldSec(b.getAttribute('data-fold')); return; }
      var k = b.getAttribute('data-seg'), chipK = b.getAttribute('data-chip'), act = b.getAttribute('data-act'), v = b.getAttribute('data-v');
      if (k === 'sort') { VIEW.sort = v; compute(); return; }
      if (k === 'posx') { VIEW.posx = v; compute(); return; }
      if (k === 'mode') { VIEW.mode = v; toHash(); applyMode(); return; }
      if (k === 'mgrade') { VIEW.allGrades = v === 'all'; compute(); return; }
      if (act === 'exClear') { S.ex = []; VIEW.exKeep = {}; changed(); return; }
      if (act === 'exLast') { S.ex = S.ex.slice(0, -1); changed(); return; }
      if (act === 'xlsx') { exportOne(); return; }
      if (act === 'sheet') { sheetOpen(); return; }
      if (b.hasAttribute('data-dmt')) { toggleDamage(b); return; }
      if (act === 'toBatch') {
        if (window.V2Auth && V2Auth.locked('batch')) { V2Auth.notice('묶음 산정은 회원 전용입니다 — 로그인하면 이 차를 묶음에 넣을 수 있습니다.'); return; }
        addToBatch(b); return;
      }
      if (act === 'openBatch') { VIEW.mode = 'batch'; toHash(); applyMode(); window.scrollTo(0, 0); return; }
      if (act === 'xlsxModel') { exportModel(); return; }
      var cell = b.getAttribute('data-cell'), gname = b.getAttribute('data-grade');
      if (cell) { fillFromCell(+cell.split('|')[0], +cell.split('|')[1]); return; }
      if (gname != null) { S.grade = gname; S.trim = ''; S.ex = []; renderInputs(); changed(); return; }
      if (k === 'cond' && v === '입력' && S.cond === '입력') { VIEW.recOpen = !recOpen(); renderInputs(); return; }   // 다시 누르면 접고 펼친다
      if (k === 'cond') VIEW.recOpen = v === '입력' ? true : null;
      if (k) { S[k] = v; if (k === 'cond') { VIEW.condWarn = []; VIEW.condOut = []; } renderInputs(); changed(); return; }
      if (chipK === 'color') { S.color = v; renderInputs(); changed(); return; }
      if (chipK === 'fix') { toggle(S.fixes, v); renderInputs(); changed(); return; }
      if (act === 'parse') { parseCond(); return; }
      if (/^cond(Clean|Alt|Pick|Unpick|SaveOpen|SaveClose|Save|Terms|TermDel|TermDelGo)$/.test(act)) { condAct(act, b); return; }
      if (b.hasAttribute('data-pos')) { setPos(+b.getAttribute('data-pos'), b.getAttribute('data-v')); syncText(); refreshRec(); changed(); return; }   // 37곳 단추
      if (b.hasAttribute('data-out')) {                        // 기록부 밖 수리필요 칩
        var oo = b.getAttribute('data-out');
        if (outAt(oo)) S.items = S.items.filter(function (it) { return !(it.part === oo && it.status === '수리필요'); });
        else S.items.push({ part: oo, side: null, pillar: null, status: '수리필요', outside: true });
        syncText(); refreshRec(); changed(); return;
      }
      if (act === 'recFold' || act === 'recUnfold') { VIEW.recOpen = act === 'recUnfold'; renderInputs(); return; }
      if (act === 'findName') { findName(); return; }
      if (act === 'recent') { VIEW.recentOpen = !VIEW.recentOpen; renderInputs(); return; }
      if (act === 'recentClear') { try { localStorage.removeItem(RECENT); } catch (e) { /* 지우지 못해도 산정은 된다 */ } VIEW.recentOpen = false; renderInputs(); return; }
      if (act === 'pickCand') {                                 // 차명 찾기 다른 후보 고르기
        var c = VIEW.nameCands[+b.getAttribute('data-i')], text = nameParts(VIEW.nameText).text || VIEW.nameText;
        if (c) loadFiles([c.file]).then(function () { VIEW.nameCands = []; setModel(c, text, 'pick'); }).catch(fail);
        return;
      }
      if (act === 'clearExtra') {
        S.items = S.items.filter(function (it) { return posIndex(it) || (it.outside && OUT_CHIPS.indexOf(it.part) >= 0 && !it.side); });
        syncText(); renderInputs(); changed(); return;
      }
      if (act === 'reset') { S = blank(); VIEW.all = false; resetRec(); VIEW.nameText = ''; VIEW.nameMsg = ''; VIEW.nameCands = []; VIEW.carOpen = false; VIEW.moreOpen = null; VIEW.recOpen = null; VIEW.carKey = ''; renderInputs(); changed(); return; }
      if (act === 'retry') { route().catch(fail); return; }
      if (act === 'carOpen') { VIEW.carOpen = true; renderInputs(); var f = $('inp').querySelector('[data-k="grade"]'); if (f) f.focus(); return; }
      if (act === 'toCond') { goSec('top'); return; }
      if (act === 'example') { example(); return; }
      if (act === 'more') { VIEW.all = !VIEW.all; compute(); return; }
      if (act === 'share') {
        var done = function () { b.textContent = '복사됨'; setTimeout(function () { b.textContent = '링크 복사'; }, 1500); };
        if (navigator.clipboard) navigator.clipboard.writeText(shareUrl()).then(done, function () { prompt('이 주소를 복사하세요', shareUrl()); });
        else prompt('이 주소를 복사하세요', shareUrl());
      }
    }
    $('app').querySelector('.v2-mode').addEventListener('click', clicks);
    inp.addEventListener('click', clicks);
    res.addEventListener('click', clicks);
    $('condbar').addEventListener('click', clicks);              // 붙는 조건 바(결과 밖)의 '조건 바꾸기'
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
    res.addEventListener('mouseover', function (e) {           // 글자 안 굵은 숫자(<b>) 위에서도 말풍선이 뜨게 가장 가까운 [data-tip]
      var el = e.target.closest && e.target.closest('[data-tip]'), t = el && el.getAttribute('data-tip');
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
    res.addEventListener('mouseout', function (e) {
      var el = e.target.closest && e.target.closest('[data-tip]');
      if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) tip.hidden = true;
    });
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
    document.addEventListener('click', function (e) {          // 카드 설명 i(묶음 산정 — batch.js 의 data-ib): 같은 카드 안 .v2-info 를 펼치고 접는다
      var b = e.target.closest && e.target.closest('[data-ib]'), p = b && b.closest('.card') && b.closest('.card').querySelector('.v2-info');
      if (!p) return;
      p.hidden = !p.hidden;
      b.setAttribute('aria-expanded', String(!p.hidden));
    });
    $('snav').addEventListener('click', function (e) {          // 오른쪽 목차 — 누르면 그 섹션으로(접힌 섹션은 펼치고)
      var b = e.target.closest('[data-go]');
      if (b) goSec(b.getAttribute('data-go'));
    });
    function hdr() { var hd = document.querySelector('header'); document.documentElement.style.setProperty('--hdr', (hd ? hd.offsetHeight : 54) + 'px'); }   // 좁은 화면 가로 목차가 붙을 높이
    hdr();
    window.addEventListener('scroll', function () { if (!spyRaf) spyRaf = requestAnimationFrame(spy); }, { passive: true });
    window.addEventListener('resize', function () { hdr(); spy(); });
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
    if (err && err.code === 'limit' && window.V2Auth) { V2Auth.notice(err.message); return; }   // 로그인하지 않은 한도(1시간 새 모델 30개) — 화면은 그대로
    console.error(err);
    if (window.CT) CT.err('load', err && err.message || err);
    var msg = '<div class="card"><div class="card-title">데이터를 불러오지 못했습니다</div><p class="v2-kv">' + esc(err && err.message || err) +
      '</p><p class="v2-actions"><button type="button" class="v2-btn primary" data-act="retry">다시 시도</button></p></div>';
    if (BOOTED && $('res') && !$('priceView').hidden) { $('res').innerHTML = msg; return; }   // 처음 불러오기가 아니면 입력 패널은 그대로
    if (BOOTED && $('app')) { var bn = $('failBox'); if (!bn) { $('app').insertAdjacentHTML('afterbegin', '<div id="failBox"></div>'); bn = $('failBox'); } bn.innerHTML = msg; return; }
    $('app').innerHTML = '<div class="alert">데이터를 불러오지 못했습니다: ' + esc(err && err.message || err) + '</div>';
  }

  function boot() {
    Promise.all(['comps/index.json', 'adj_coef.json', 'conversion_rates.json', 'inspection_model.json', 'market_index.json'].map(getJSON)
      .concat([RatesStore.load('/api/rates'), RatesStore.load('/api/terms'), RatesStore.load('/api/cond')])   // 환산 비율 팀 수정 · 기록부 팀 표기 사전 · 감가 표 팀 수정
      .concat(['cond_market.json', 'audit.json'].map(function (f) { return getJSON(f).catch(function () { return null; }); }))   // 감가 옆 시장 근거 · 주간 점검(v2.33)
      .concat([window.V2Auth ? V2Auth.init() : null]))      // 로그인 상태(로그인 기획) — 실패해도 로그인 안 한 것으로
      .then(function (a) {
        X.idx = a[0]; X.coef = a[1]; X.rates = a[2]; X.model = a[3]; X.mi = a[4]; X.store = a[5]; TERMS = a[6]; X.condStore = a[7]; X.condMarket = a[8]; X.audit = a[9];
        CTB = CondTable.create(X.model).apply(X.condStore.team);   // 기록부 감가 · 수리비 표(기획 v2.32)
        X.terms = termList;                                  // 묶음 산정도 같은 팀 사전으로 읽는다
        RatesStore.apply(X.rates, X.store.team);
        X.yr = {}; X.yrN = {};                                 // 세부모델 연식 범위(목록에 '(2019~2022)' · 등록 연도 맞춤)
        X.idx.makers.forEach(function (mk) { mk.groups.forEach(function (g) { g.models.forEach(function (m) {
          if (m.y0 && m.y1) X.yr[mk.name + '|' + g.name + '|' + m.name] = m.y0 === m.y1 ? String(m.y0) : m.y0 + '~' + m.y1;
          if (m.y0 && m.y1) X.yrN[mk.name + '|' + g.name + '|' + m.name] = [m.y0, m.y1];
        }); }); });
        ENG = PriceEngine.create({ config: X.idx.engine, coef: X.coef, rates: X.rates, cond: CTB });
        ISC = InspectionScore.create(X.model);
        S = fromHash();
        layout();
        BOOTED = true;
        if (window.V2Auth) { V2Auth.onChange(authChanged); authChanged(); }
        marketLine();
        if (window.CT) CT.ev('perf', 'ready', Math.round(performance.now()));   // 이용 통계: 기본 데이터를 받아 화면을 그리기까지(ms)
        X.mmWait = getJSON('market_models.json').then(function (j) {   // 세부모델 시장 숫자(시세 추세·판매 속도·지표 줄) — 늦게 와도 되므로 따로
          X.mm = j; X.mmBy = {};
          j.models.forEach(function (m) { X.mmBy[m.maker + '|' + m.model] = m; });
          if (!$('priceView').hidden && (VIEW.mode === 'one' || VIEW.mode === 'model') && S.model) compute();
          return j;
        }).catch(function () { X.mmBy = {}; return null; });
        return route();
      })
      .catch(fail);
  }

  boot();
})();
