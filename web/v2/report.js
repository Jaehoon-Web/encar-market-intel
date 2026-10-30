/*
 * report.js — 새 사이트(v2) 모델 리포트 화면 (기획안 5.5.2) — "이 모델은 지금 시장에서 어떤가?"
 *
 * 데이터(../data): report/index.json(세부모델별 잔존가치 지수·매물 경고 수 · 차급 잔존율, model_report.py)
 *   · report/<모델그룹 파일>.json(감가 곡선·잔존율 변화·공급 흐름·가격 인하·매물 목록 — 파일 이름은 comps 와 같음)
 *   · market_models.json(ctx.mm — 판매율·소진 주수·체류·인하·시세지수) · market_index.json(X.mi — 차급 시세지수·수집 회차)
 * 순서: ① 모델 고르기 ② 머리 ③ 동급 대비 지표 ④ 감가 곡선(겹쳐 보기) ⑤ 잔존율 표 ⑥ 시세 추세 · 공급·판매 추이 ⑦ 가격 인하 행동 ⑧ 매물 목록
 * 주소: #/report?mk=현대&grp=그랜저&model=더 뉴 그랜저 IG — 금액으로 보기 &y=amt, 겹쳐 볼 모델 &cmp=제조사|세부모델(최대 3개)
 * 그림 폭 = 카드 안쪽 폭(휴대폰에서도 글자 11px). 외부 공개 화면이라 팀 내부 가격 기준은 넣지 않는다(Q83).
 *
 *   var R = V2Report.create(ctx);   R.show(el, params);      // ctx = app.js subCtx()
 */
(function (root) {
  'use strict';

  var DOM_ORDER = ['현대', '제네시스', '기아', '쉐보레(GM대우)', '르노코리아(삼성)', 'KG모빌리티(쌍용)', '기타 제조사'];   // 엔카 국산 제조사 순서(시세 산정과 같음)
  var IRREG = [5, 16], RV_OK = 20, SPEED_N = 100, MAX_CMP = 3, TOPN = 6, ENCAR = 'https://fem.encar.com/cars/detail/';
  var LINES = [                                              // 이 모델 + 겹쳐 볼 모델 3개 — 색·선 모양·점 모양을 함께 바꿔 색만으로 구분하지 않게
    { c: 'var(--rp-c0)', dash: '', mk: 'circle' },
    { c: 'var(--rp-c1)', dash: '7 4', mk: 'square' },
    { c: 'var(--rp-c2)', dash: '2 3', mk: 'triangle' },
    { c: 'var(--rp-c3)', dash: '9 3 2 3', mk: 'diamond' }
  ];
  var SEG_LINE = { c: 'var(--rp-seg)', dash: '5 4', mk: '' };  // 동급(같은 차급·국산수입) 가운데 값
  var OVER100 = '1년 미만·1~2년 잔존율이 100%를 넘는 칸은 출고가가 옵션을 뺀 기본 가격으로 적혀 있어 호가가 출고가보다 높게 나온 경우일 수 있습니다.';
  var RVRULE = '출고가가 적힌 판매중 매물 가운데 잔존율이 5~150%인 매물만 씁니다(출고가가 잘못 적힌 매물을 거름). 동급 점선은 연차마다 20대 이상일 때만 그립니다.';

  function create(ctx) {
    var X = ctx.X, esc = ctx.esc, man = ctx.man;
    var el = null, IDX = null, MM = null, FILES = {}, WAIT = {}, idxWait = null, mmWait = null, RUN = 0, lastW = 0, CUR = null;
    var V = { mk: '', grp: '', model: '', unit: 'rv', cmp: [], msg: '', fmsg: '' };
    var KEY = {}, NAMES = {}, LIST = [];                     // 세부모델 찾기표: '제조사|세부모델' · '제조사 세부모델'(이름 찾기) → 같은 정보
    X.idx.makers.forEach(function (mk) {
      mk.groups.forEach(function (g) {
        g.models.forEach(function (m) {
          var o = { mk: mk.name, grp: g.name, model: m.name, file: g.file, origin: mk.origin, y0: m.y0, y1: m.y1,
            on: m.onsale_all != null ? m.onsale_all : m.onsale || 0 };   // 판매중 — report/index.json 이 오면 그 값으로 바꾼다
          KEY[mk.name + '|' + m.name] = o;
          NAMES[mk.name + ' ' + m.name] = o;
          LIST.push(o);
        });
      });
    });
    var BP = X.mi && X.mi.base_period ? md(X.mi.base_period[0]) + '~' + md(X.mi.base_period[1]) : '7월 초';
    var TIP = {                                              // 용어 설명(? 말풍선)
      rate: '지난 수집 구간에 목록에서 사라진(판매된) 매물 ÷ 구간 시작 판매중 매물을 7일 기준으로 맞춘 값입니다. 구간 시작이 10대 이상일 때만 냅니다. ' +
        '동급 = 같은 차급·국산/수입 전체. 판매중 100대 이상일 때 동급의 1.15배 이상이면 빠름, 0.87배 이하이면 느림으로 씁니다(마켓 펄스와 같은 기준).',
      weeks: '지금 판매중 매물이 다 팔리는 데 걸리는 주(1 ÷ 주간 판매율)입니다. 짧을수록 빨리 팔립니다.',
      dwell: '최근 90일에 팔린 매물이 엔카에 올라온 뒤 목록에서 사라지기까지 걸린 날수의 가운데 값입니다(5대 이상일 때).',
      cut: '판매중 매물 가운데 첫 호가보다 값을 내린 매물의 비율입니다. 동급은 같은 차급·국산/수입 세부모델들을 판매중 대수로 가중 평균한 값입니다.',
      pidx: '새로 올라온 매물(등록 7일 이내)의 첫 호가를 기준기간(' + BP + ') 같은 모델·등급 매물과 비교한 값입니다(기준기간 = 100). ' +
        '차령·주행·색상·성능을 맞추므로 시간에 따른 자연 감가는 빠집니다. 동급은 같은 차급·국산/수입 전체의 마지막 값입니다.',
      curve: '잔존율 = 판매중 매물의 지금 호가 ÷ 출고가. 차령 연차(0 = 1년 미만, 12+ = 12년 이상)별 가운데 값을 잇고, 띠는 가운데 50%(25~75%)입니다. ' +
        '연차당 10대 이상만 그리고 20대 미만은 흐리게 그립니다. 점선은 같은 차급·국산/수입 전체의 가운데 값입니다. 금액으로 바꾸면 연차별 호가 가운데 값(만원)을 봅니다. ' +
        '그림에 마우스를 올리거나 누르면 그 연차의 숫자가 나옵니다. 새 차에 가까운 연차의 잔존율이 100%를 넘으면 출고가가 옵션을 뺀 기본 가격으로 적힌 경우일 수 있습니다.',
      table: '판매중 매물의 연차별 잔존율(가운데 값)·가운데 50% 범위·호가 가운데 값·대수입니다. 동급은 같은 차급·국산/수입 전체. ' +
        '변화는 같은 연차 신규 매물(엔카 등록 7일 안에 처음 본 매물)의 첫 호가 ÷ 출고가를 기준기간(' + BP + ' 목록)과 최근 4주로 비교한 값입니다(양쪽 10대 이상). ' +
        '1년 미만·1~2년 잔존율이 100%를 넘으면 출고가가 옵션을 뺀 기본 가격으로 적힌 경우일 수 있습니다.',
      flow: '목록 관측일마다 판매중 매물(상세까지 확인한 것), 직전 수집 뒤 새로 올라온 매물(신규)과 목록에서 사라진 매물(판매 추정, 다시 올린 것은 뺌)입니다. ' +
        '신규·판매는 구간 대수를 7일 기준으로 맞춘 값입니다. 구간이 5~16일이 아니면 막대를 흐리게, 16일 넘는 공백은 회색 띠로 그립니다.',
      cutb: '이번 주 = 직전 목록과 마지막 목록에 모두 있는 판매중 매물(상세까지 확인한 매물)의 호가를 같은 매물끼리 비교한 값입니다. 한 주 사이 호가가 절반 아래로 내려가거나 두 배 넘게 오른 매물은 입력 실수로 보고 뺍니다. ' +
        '첫 호가 대비 = 판매중 매물이 처음 올린 값보다 내린 상태인지입니다. 가격 통계에서는 더미가·인수금 의심·가격 이상·핵심 결측·중복 매물을 뺍니다.',
      rvi: '판매중 매물마다 잔존율을 같은 차급·국산/수입·차령 연차 매물의 가운데 잔존율로 나눈 뒤, 그 가운데 값 × 100입니다(동급 = 100). ' +
        '연식 구성이 달라도 비교됩니다. 100보다 크면 같은 연차 동급보다 값을 잘 지킵니다. ' +
        '같은 연차 동급 매물이 20대 미만이면 앞뒤 1년을 묶어 비교하고, 그래도 모자라거나 출고가가 없는 매물은 뺍니다. 계산한 매물이 20대 미만이면 지수를 내지 않습니다.',
      low: '그 매물을 빼고 같은 세부모델의 비슷한 매물로 추정한 시세(시세 산정과 같은 방법)보다 호가가 크게 낮고, 추정 신뢰도가 높은 판매중 매물입니다. ' +
        '이상 매물을 걸러낼 때 씁니다. 사고·상태 차이나 호가 입력 오류일 수 있어 매물마다 확인이 필요합니다.',
      old: '엔카에 올라온 지 오래됐고 첫 호가보다 값을 내렸는데도 아직 판매중인 매물입니다.'
    };

    // ───── 도우미 ─────
    function $(id) { return document.getElementById(id); }
    function q(t) { return ' <span class="v2-q" tabindex="0" role="note" aria-label="' + esc(t) + '" data-tip="' + esc(t) + '">?</span>'; }
    function day(s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5; }
    function md(s) { return s ? (+s.slice(5, 7)) + '/' + (+s.slice(8, 10)) : ''; }
    function n0(v) { return Math.round(v).toLocaleString('ko-KR'); }
    function pc(v, d) { return (v * 100).toFixed(d == null ? 1 : d); }                  // 비율 → % 숫자
    function sgn(v, d) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d == null ? 1 : d); }
    function fmtW(v) { return v >= 100 ? n0(v) : String(Math.round(v * 10) / 10); }   // 주간 대수 — 작은 모델은 소수 1자리
    function cutAmt(v) { return Math.round(Math.abs(v)) ? '−' + man(Math.abs(v)) + '만' : '0만'; }   // 인하액 — 데이터 부호와 상관없이 "−50만"
    function cutPct(v) { return (Math.abs(v) >= 0.05 ? '−' : '') + Math.abs(v).toFixed(1) + '%'; }
    function over100(rows) { return rows.some(function (r) { return r[0] <= 1 && r[1] > 1; }); }   // 1년 미만·1~2년 잔존율 100% 초과 칸
    function ymTxt(v) { v = String(v); return v.slice(0, 4) + '.' + v.slice(4, 6); }
    function segName(seg) { var s = String(seg || '').split('·'); return s.length > 1 ? s[1] + ' ' + s[0] : String(seg || ''); }   // '대형·국산' → '국산 대형'
    function yrTxt(o) { return o && o.y0 && o.y1 ? (o.y0 === o.y1 ? String(o.y0) : o.y0 + '~' + o.y1) : ''; }
    function ageTxt(a) { return a >= 12 ? '12년 이상' : a === 0 ? '1년 미만' : a + '~' + (a + 1) + '년'; }
    function byOn(a, b) { return b.on - a.on; }
    function rowAt(rows, a) { for (var i = 0; i < rows.length; i++) if (rows[i][0] === a) return rows[i]; return null; }
    function reg(days) { return days != null && days >= IRREG[0] && days <= IRREG[1]; }
    function rvWhy(r) {                                      // 잔존율 선·칸이 없는 이유(문장 가운데 — "이 세부모델은 … 그리지 않습니다")
      if (!r) return '리포트 자료에 빠져 있어';
      if (!r.on) return '지금 판매중 매물이 없어';
      if (r.on < 10) return '판매중 매물이 10대 미만이라';
      if (!r.rvn) return '출고가가 적힌 판매중 매물이 없거나 아주 적어';
      return '판매중 매물이 10대 이상인 연차가 없어';
    }
    function thinTag(what) { return ' <span class="v2-mtag" title="판매중 ' + SPEED_N + '대 미만이라 ' + what + '을 붙이지 않습니다">표본 적음</span>'; }
    function niceTicks(a, z, n, min) {                       // min = 가장 작은 간격(대수 축은 1 — 0.5 눈금이 '1'로 보이지 않게)
      var span = z - a || 1, step = Math.pow(10, Math.floor(Math.log(span / n) / Math.LN10)), e = span / n / step;
      if (e >= 7.5) step *= 10; else if (e >= 3.5) step *= 5; else if (e >= 1.5) step *= 2;
      if (min && step < min) step = min;
      var t = [];
      for (var v = Math.ceil(a / step) * step; v <= z + 1e-9; v += step) t.push(Math.round(v / step) * step);
      return t;
    }
    function compact(v) {                                    // 축 눈금: 1.2만 · 5,000
      if (v < 1e4) return n0(v);
      var m = v / 1e4;
      return (Math.abs(m - Math.round(m)) < 0.05 ? Math.round(m) : m.toFixed(1)) + '만';
    }
    function widths() {                                      // 카드 안쪽 폭(카드 여백 20 × 2 + 테두리) — 두 칸이면 한 칸 폭
      var w = el.clientWidth || 600, col = w >= 2 * 360 + 16 ? (w - 16) / 2 : w;
      return { full: Math.floor(Math.max(240, Math.min(1200, w - 42))), half: Math.floor(Math.max(240, Math.min(620, col - 42))) };   // 내림 — 그림이 칸보다 커져 글자가 줄지 않게
    }

    // ───── 데이터 받기(한 번만, 실패도 기억) ─────
    function getIdx() {
      if (!idxWait) idxWait = ctx.getJSON('report/index.json').then(function (j) {
        IDX = j;
        LIST.forEach(function (o) { var r = j.models[o.mk + '|' + o.model]; if (r) o.on = r.on; });
        return j;
      }).catch(function (e) { IDX = { err: e && e.message || String(e) }; return IDX; });
      return idxWait;
    }
    function getMM() {
      if (!mmWait) mmWait = Promise.resolve(ctx.mm ? ctx.mm() : null).then(function (j) { MM = j && j.models ? prepMM(j) : { err: true }; return MM; },
        function () { MM = { err: true }; return MM; });
      return mmWait;
    }
    function prepMM(j) {                                     // 세부모델 찾기표 · 동급 인하 비율(판매중 대수 가중 평균)
      var by = {}, cut = {};
      j.models.forEach(function (m) {
        by[m.maker + '|' + m.model] = m;
        var k = m.seg + '·' + m.origin, c = cut[k] || (cut[k] = [0, 0]);
        if (m.cut != null && m.on) { c[0] += m.cut * m.on; c[1] += m.on; }
      });
      Object.keys(cut).forEach(function (k) { cut[k] = cut[k][1] ? cut[k][0] / cut[k][1] : null; });
      return { j: j, by: by, segCut: cut };
    }
    function getFile(f) {
      if (FILES[f]) return Promise.resolve(FILES[f]);
      if (!WAIT[f]) WAIT[f] = ctx.getJSON('report/' + f).then(function (j) { FILES[f] = j; return j; })
        .catch(function (e) { FILES[f] = { err: e && e.message || String(e) }; return FILES[f]; });
      return WAIT[f];
    }
    function fileModel(k) {                                  // 겹쳐 볼 모델의 그룹 파일 속 세부모델(없으면 null, 받는 중이면 undefined)
      var o = KEY[k], F = o && FILES[o.file];
      if (!F) return undefined;
      return F.models && F.models[o.model] || null;
    }

    // ───── 주소 ↔ 상태 ─────
    function makerOf(mk) { return mk ? X.idx.makers.find(function (m) { return m.name === mk; }) || null : null; }
    function groupOf(M, g) { return M && g ? M.groups.find(function (x) { return x.name === g; }) || null : null; }
    function inGroup(G, m) { return !!(G && m && G.models.some(function (x) { return x.name === m; })); }
    function setState(p) {
      V.mk = p.get('mk') || ''; V.grp = p.get('grp') || ''; V.model = p.get('model') || '';
      V.unit = p.get('y') === 'amt' ? 'amt' : 'rv';
      V.msg = ''; V.fmsg = '';
      var M = makerOf(V.mk);
      if (V.mk && !M) V.msg = '주소의 제조사 "' + V.mk + '"를 찾지 못했습니다. 아래에서 다시 고르세요.';
      if (!M) V.mk = V.grp = V.model = '';
      if (M && V.model && !inGroup(groupOf(M, V.grp), V.model)) {          // 모델그룹이 없거나 틀리면 세부모델로 찾는다
        var o = KEY[V.mk + '|' + V.model];
        if (o) V.grp = o.grp; else { V.msg = '"' + V.model + '" 세부모델을 찾지 못했습니다. 아래에서 다시 고르세요.'; V.model = ''; }
      }
      if (M && V.grp && !groupOf(M, V.grp)) { V.msg = '"' + V.grp + '" 모델을 찾지 못했습니다. 아래에서 다시 고르세요.'; V.grp = V.model = ''; }
      var me = V.mk + '|' + V.model;
      V.cmp = [];
      p.getAll('cmp').forEach(function (k) { if (KEY[k] && k !== me && V.cmp.indexOf(k) < 0 && V.cmp.length < MAX_CMP) V.cmp.push(k); });
    }
    function params() {
      var p = new URLSearchParams();
      if (V.mk) p.set('mk', V.mk);
      if (V.grp) p.set('grp', V.grp);
      if (V.model) p.set('model', V.model);
      if (V.model && V.unit === 'amt') p.set('y', 'amt');
      if (V.model) V.cmp.forEach(function (k) { p.append('cmp', k); });
      return p;
    }

    // ───── ① 모델 고르기 ─────
    function gsum(mk, g) { var s = 0; g.models.forEach(function (m) { var o = KEY[mk + '|' + m.name]; s += o ? o.on : 0; }); return s; }
    function msum(M) { var s = 0; M.groups.forEach(function (g) { s += gsum(M.name, g); }); return s; }
    function cnt(n) { return IDX && !IDX.err ? ' · 판매중 ' + n0(n) + '대' : ''; }
    function opt(v, label, cur) { return '<option value="' + esc(v) + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + esc(label) + '</option>'; }
    function pickHtml(text) {
      var M = makerOf(V.mk), G = groupOf(M, V.grp);
      var dom = X.idx.makers.filter(function (m) { return m.origin === '국산'; }).sort(function (a, b) { return DOM_ORDER.indexOf(a.name) - DOM_ORDER.indexOf(b.name); });
      var imp = X.idx.makers.filter(function (m) { return m.origin !== '국산'; }).map(function (m) { return { m: m, on: msum(m) }; }).sort(byOn);
      var mo = function (m) { return opt(m.name, m.name + cnt(msum(m)), V.mk); };
      var h = '<div class="card-title">모델 고르기 <span class="hint">제조사 → 모델 → 세부모델 · 또는 이름으로 찾기</span></div><div class="rp-sels">' +
        '<select class="filter-select" data-r="mk" aria-label="제조사">' + opt('', '제조사 선택', V.mk) +
        '<optgroup label="국산">' + dom.map(mo).join('') + '</optgroup>' +
        '<optgroup label="수입 · 많은 순">' + imp.slice(0, 8).map(function (x) { return mo(x.m); }).join('') + '</optgroup>' +
        '<optgroup label="수입 · 가나다순">' + imp.slice(8).map(function (x) { return x.m; }).sort(function (a, b) { return a.name.localeCompare(b.name, 'ko'); }).map(mo).join('') +
        '</optgroup></select>';
      var gs = M ? M.groups.map(function (g) { return { g: g, on: gsum(M.name, g) }; }).sort(byOn) : [];
      h += '<select class="filter-select" data-r="grp" aria-label="모델"' + (M ? '' : ' disabled') + '>' + opt('', M ? '모델 선택' : '—', V.grp) +
        gs.map(function (x) { return opt(x.g.name, x.g.name + cnt(x.on), V.grp); }).join('') + '</select>';
      var ms = G ? G.models.map(function (m) { return KEY[M.name + '|' + m.name]; }).sort(function (a, b) {   // 최신 세대부터(같으면 판매중 많은 순)
        return ((b.y1 || 0) - (a.y1 || 0)) || ((b.y0 || 0) - (a.y0 || 0)) || (b.on - a.on);
      }) : [];
      h += '<select class="filter-select" data-r="model" aria-label="세부모델"' + (G ? '' : ' disabled') + '>' + opt('', G ? '세부모델 선택' : '—', V.model) +
        ms.map(function (o) { return opt(o.model, o.model + (yrTxt(o) ? ' (' + yrTxt(o) + ')' : '') + cnt(o.on), V.model); }).join('') + '</select>';
      h += '<div class="rp-find"><input class="v2-in" id="rpQ" list="rpList" autocomplete="off" placeholder="이름으로 찾기 — 예: 그랜저 IG" aria-label="세부모델 이름으로 찾기" value="' +
        esc(text || '') + '"><button type="button" class="v2-btn" data-r="find">보기</button></div></div>';
      if (V.msg) h += '<p class="v2-help v2-bad">' + esc(V.msg) + '</p>';
      if (V.fmsg) h += '<p class="v2-help v2-bad">' + esc(V.fmsg) + '</p>';
      return h;
    }
    function renderPick(text) {
      var p = $('rpPick');
      if (!p) return;
      var inp = $('rpQ'), had = !!inp && document.activeElement === inp;
      p.innerHTML = pickHtml(text != null ? text : inp ? inp.value : '');
      if (had) $('rpQ').focus();
    }
    function norm(s) { return String(s).toUpperCase().replace(/[\s·\-_()]+/g, ''); }
    function best(raw) {                                     // 이름 찾기: 붙여 쓴 글 포함 → 낱말 모두 포함, 판매중 많은 순
      var qn = norm(raw), toks = raw.split(/\s+/).map(norm).filter(Boolean);
      var hit = LIST.filter(function (o) { return norm(o.mk + o.model).indexOf(qn) >= 0 || norm(o.model).indexOf(qn) >= 0; });
      if (!hit.length) hit = LIST.filter(function (o) { var t = norm(o.mk + o.grp + o.model); return toks.every(function (k) { return t.indexOf(k) >= 0; }); });
      return hit.sort(byOn)[0] || null;
    }
    function pickModel(o) { V.mk = o.mk; V.grp = o.grp; V.model = o.model; V.cmp = []; V.msg = ''; V.fmsg = ''; go(''); }
    function find() {
      var inp = $('rpQ'), raw = inp ? inp.value.trim() : '';
      if (!raw) return;
      var o = NAMES[raw] || best(raw);
      if (o) { pickModel(o); return; }
      V.fmsg = '"' + raw + '"에 맞는 세부모델이 없습니다. 제조사·모델 이름 일부로 찾아 보세요.';
      renderPick(raw);
    }

    // ───── 고르기 전 — 짧은 설명 + 바로가기 ─────
    function chip(o) {
      return '<a class="rp-chip" href="' + esc(ctx.reportHref(o.mk, o.grp, o.model)) + '">' + esc(o.mk + ' ' + o.model) + (yrTxt(o) ? ' <small>' + yrTxt(o) + '</small>' : '') +
        ' <small>' + n0(o.on) + '대</small></a>';
    }
    function introHtml() {
      var M = makerOf(V.mk), G = groupOf(M, V.grp), h = '<div class="card"><div class="card-title">모델 리포트 <span class="hint">세부모델 하나가 지금 시장에서 어떤지 한 화면에</span></div>' +
        '<p class="v2-kv">같은 차급·국산/수입(동급)과 비교한 판매 속도·인하·시세·잔존가치, 차령별 감가 곡선과 잔존율, 시세 추세와 공급·판매 흐름, 가격 인하, ' +
        '이상 의심·오래 안 팔리는 매물 목록을 봅니다. 위에서 세부모델을 고르거나 아래 바로가기를 누르세요.</p>';
      if (G) h += '<div class="v2-ssub">' + esc(M.name + ' ' + G.name) + ' 세부모델</div><div class="rp-chips">' +
        G.models.map(function (m) { return KEY[M.name + '|' + m.name]; }).sort(byOn).map(chip).join('') + '</div>';
      else if (M) h += '<div class="v2-ssub">' + esc(M.name) + ' · 판매중이 많은 세부모델</div><div class="rp-chips">' +
        LIST.filter(function (o) { return o.mk === M.name; }).sort(byOn).slice(0, TOPN * 2).map(chip).join('') + '</div>';
      else [['국산', true], ['수입', false]].forEach(function (x) {
        h += '<div class="v2-ssub">판매중이 많은 세부모델 · ' + x[0] + '</div><div class="rp-chips">' +
          LIST.filter(function (o) { return (o.origin === '국산') === x[1]; }).sort(byOn).slice(0, TOPN).map(chip).join('') + '</div>';
      });
      return h + (IDX ? '' : '<p class="v2-help"><span class="spinner v2-spin"></span>판매중 대수를 불러오는 중…</p>') + '</div>';
    }

    // ───── 본문 ─────
    function renderBody(again) {
      var b = $('rpBody');
      if (!b) return;
      lastW = el.clientWidth;
      var tok = ++RUN;
      var o = V.model ? KEY[V.mk + '|' + V.model] : null;
      if (!o) { CUR = null; b.innerHTML = introHtml(); return; }
      var F = FILES[o.file];
      if (!IDX || !MM || !F) {
        b.innerHTML = '<div class="card"><p class="v2-kv"><span class="spinner v2-spin"></span>' + esc(o.mk + ' ' + o.model) + ' 리포트를 불러오는 중…</p></div>';
        Promise.all([getIdx(), getMM(), getFile(o.file)]).then(function () { if (tok === RUN) renderBody(); });
        return;
      }
      if (IDX.err || F.err) {
        CUR = null;
        b.innerHTML = '<div class="card"><p class="v2-kv v2-bad">모델 리포트 파일을 불러오지 못했습니다: ' + esc(IDX.err || F.err) + '</p></div>';
        return;
      }
      var k = o.mk + '|' + o.model, r = IDX.models[k] || null, m = F.models && F.models[o.model] || null;
      CUR = { o: o, k: k, r: r, m: m, seg: (r && r.seg) || (m && m.seg) || '', mm: MM.by ? MM.by[k] || null : null, W: widths() };
      b.innerHTML = headHtml() + tilesHtml() + curveCard() + rvCard() + '<div class="v2-two-col">' + trendHtml() + flowCard() + '</div>' + cutCard() + listCard('low') + listCard('old');
      if (!again && el.clientWidth !== lastW) { renderBody(true); return; }   // 내용이 길어져 스크롤 막대가 생기면 폭이 줄어든다 — 그 폭으로 한 번 더(글자 11px 유지)
      loadCmp();
    }
    function loadCmp() {                                     // 겹쳐 볼 모델 파일 — 오면 감가 곡선·잔존율 표만 다시
      var miss = V.cmp.filter(function (k) { return fileModel(k) === undefined; }), model = V.model;
      if (miss.length) Promise.all(miss.map(function (k) { return getFile(KEY[k].file); })).then(function () { if (V.model === model) renderCurve(true); });
    }
    function renderCurve(withTable) {
      var c = $('rpCurve'), t = $('rpRv');
      if (!c || !t || !CUR) { renderBody(); return; }
      var a = document.activeElement, r = a && c.contains(a) && a.getAttribute('data-r');   // 다시 그려도 초점 자리는 그대로
      var sel = r ? a.tagName.toLowerCase() + '[data-r="' + r + '"]' + (a.getAttribute('data-v') ? '[data-v="' + a.getAttribute('data-v') + '"]' : '') : '';
      c.outerHTML = curveCard();
      if (withTable) t.outerHTML = rvCard();
      if (sel) refocus(sel);
    }

    // ───── ② 머리 ─────
    function headHtml() {
      var o = CUR.o, on = CUR.r ? CUR.r.on : o.on, yr = yrTxt(o);
      return '<div class="card v2-headcard"><div class="v2-head">' + esc(o.mk + ' ' + o.model) + (yr ? ' <span class="v2-dim">(' + yr + ')</span>' : '') +
        (on < RV_OK ? ' <span class="v2-mtag">표본 적음</span>' : '') +
        '<br><span class="sub">' + esc(segName(CUR.seg) || '차급 미상') + ' · 판매중 ' + n0(on) + '대 · 기준 ' + md(IDX.date) + ' 목록' +
        (!on ? ' · 지금 판매중 매물이 없어 대부분의 숫자를 낼 수 없습니다' : on < RV_OK ? ' · 판매중이 ' + RV_OK + '대 미만이라 숫자가 크게 흔들릴 수 있습니다' : '') + '</span></div>' +
        '<div class="v2-actions" style="margin:0"><a class="v2-btn primary" href="' + esc(ctx.priceHref({ mk: o.mk, grp: o.grp, model: o.model }, 'model')) + '">이 모델로 시세 산정 →</a>' +
        '<button type="button" class="v2-btn" data-r="share">링크 복사</button></div></div>';
    }

    // ───── ③ 동급 대비 지표 ─────
    function tile(label, tip, val, unit, sub) {
      return '<div class="card"><div class="eyebrow">' + esc(label) + q(tip) + '</div><div class="v2-big v2-mid" style="margin-top:10px">' + esc(val) +
        (unit ? '<small>' + esc(unit) + '</small>' : '') + '</div><div class="v2-kv">' + sub + '</div></div>';
    }
    function speed(ratio) {                                  // 시세 산정의 판매 속도와 같은 기준(±15%)
      var w = ratio >= 1.15 ? ['빠름', 'up'] : ratio <= 0.87 ? ['느림', 'dn'] : ['비슷', ''];
      return ' <span class="v2-pill ' + w[1] + '">' + w[0] + '</span>';
    }
    function segIdx(seg) {                                   // 동급 시세지수 = market_index 차급 시리즈의 마지막 값(없으면 구분 전체)
      var s = String(seg).split('·'), keys = [[s[1] + '|' + s[0], segName(seg)], [s[1] + '|전체', s[1] + ' 전체']];
      for (var i = 0; i < keys.length; i++) {
        var pts = (X.mi.series || {})[keys[i][0]] || [];
        for (var j = pts.length - 1; j >= 0; j--) if (pts[j]['시세'] != null) return { v: pts[j]['시세'], name: keys[i][1], date: pts[j].date };
      }
      return null;
    }
    function tilesHtml() {
      var mm = CUR.mm, r = CUR.r, J = MM.j || {}, sg = (J.segments || {})[CUR.seg] || null, iv = J.speed_interval;
      var none = MM.err ? '시장 숫자 파일을 불러오지 못했습니다' : !mm ? '판매중 매물이 없어 생략합니다' : '';
      var t = [], segTxt = function (v) { return '동급 <b>' + v + '</b>'; };
      var thin = mm && mm.on < SPEED_N, spd = function (ratio) {   // 판매중 100대 미만은 빠름·느림을 붙이지 않는다(마켓 펄스 주목 모델과 같은 기준)
        return thin ? thinTag('빠름·느림') : speed(ratio);
      };
      // 주간 판매율 · 재고 소진 — market_models 의 판매속도 구간
      if (mm && mm.rate_w != null) t.push(tile('주간 판매율', TIP.rate, pc(mm.rate_w), '%',
        (sg && sg.rate_w ? segTxt(pc(sg.rate_w) + '%') + spd(mm.rate_w / sg.rate_w) : '동급 값 없음') +
        (iv ? '<br><span class="v2-dim">구간 ' + md(iv[0]) + '→' + md(iv[1]) + '</span>' : '')));
      else t.push(tile('주간 판매율', TIP.rate, '–', '', none || (iv ? '구간 시작 판매중이 10대 미만이라 생략합니다' : '주간 수집 구간이 아직 없어 생략합니다')));
      if (mm && mm.weeks != null) t.push(tile('재고 소진', TIP.weeks, String(mm.weeks), '주', sg && sg.weeks ? segTxt(sg.weeks + '주') + spd(sg.weeks / mm.weeks) : '동급 값 없음'));
      else t.push(tile('재고 소진', TIP.weeks, '–', '', none || (mm && mm.rate_w === 0 ? '구간에 판매가 없어 계산하지 않습니다' : '주간 판매율이 없어 생략합니다')));
      if (mm && mm.dwell != null) t.push(tile('중위 체류일', TIP.dwell, String(mm.dwell), '일', sg && sg.dwell ? segTxt(sg.dwell + '일') + spd(sg.dwell / mm.dwell) : '동급 값 없음'));
      else t.push(tile('중위 체류일', TIP.dwell, '–', '', none || '최근 90일 판매가 5대 미만이라 생략합니다'));
      var sc = MM.segCut ? MM.segCut[CUR.seg] : null;
      if (mm && mm.cut != null && mm.on) {
        var dc = sc != null ? Math.round(mm.cut * 100) - Math.round(sc * 100) : null;
        t.push(tile('인하 매물', TIP.cut, pc(mm.cut, 0), '%', sc == null ? '동급 값 없음' : segTxt(pc(sc, 0) + '%') +   // 판매중 100대 미만은 많음·적음 대신 표본 적음(판매율 타일과 같은 기준)
          (thin ? thinTag('많음·적음') : ' · ' + (dc ? Math.abs(dc) + '%p ' + (dc > 0 ? '많음' : '적음') : '같음'))));
      } else t.push(tile('인하 매물', TIP.cut, '–', '', none || '판매중 매물이 없어 생략합니다'));
      var si = segIdx(CUR.seg);
      if (mm && mm.pidx != null) {
        var dp = si ? mm.pidx - si.v : null;
        t.push(tile('시세지수', TIP.pidx, Number(mm.pidx).toFixed(1), '', si ? segTxt(si.v.toFixed(1)) + (si.name !== segName(CUR.seg) ? '(' + esc(si.name) + ')' : '') + ' · ' +
          (Math.abs(dp) < 0.05 ? '같음' : Math.abs(dp).toFixed(1) + ' ' + (dp > 0 ? '높음' : '낮음')) : '동급 값 없음'));
      } else t.push(tile('시세지수', TIP.pidx, '–', '', none || '기준기간이나 최근 신규 매물이 10대 미만이라 생략합니다'));
      if (r && r.rvi != null) t.push(tile('잔존가치 지수', TIP.rvi, r.rvi.toFixed(1), '', '동급 <b>= 100</b> · 같은 연차 동급보다 ' +
        (Math.abs(r.rvi - 100) < 0.05 ? '같음' : Math.abs(r.rvi - 100).toFixed(1) + '% ' + (r.rvi > 100 ? '높음' : '낮음')) + '<br><span class="v2-dim">' + n0(r.rvn) + '대 기준</span>'));
      else t.push(tile('잔존가치 지수', TIP.rvi, '–', '', !r || !r.on || !r.rvn ? rvWhy(r) + ' 생략합니다' : r.rvn < RV_OK ?
        '잔존율을 계산한 판매중이 ' + n0(r.rvn) + '대(' + RV_OK + '대 미만)라 생략합니다' : '같은 차급·연차의 동급 잔존율이 모자라 계산하지 않습니다'));
      return '<div class="v2-cards v2-bcards rp-tiles">' + t.join('') + '</div>';
    }

    // ───── ④ 감가 곡선 ─────
    function pts(a) { return a.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '); }
    function marker(shape, x, y, r, color, faint, ring) {   // 점 모양 — 원 · 네모 · 세모 · 마름모(흰 테두리로 겹쳐도 보이게)
      var a = ' fill="' + color + '" stroke="var(--bg-1)" stroke-width="' + (ring || 1.5) + '"' + (faint ? ' opacity="0.4"' : '');
      if (shape === 'square') return '<rect x="' + (x - r * 0.9).toFixed(1) + '" y="' + (y - r * 0.9).toFixed(1) + '" width="' + (r * 1.8).toFixed(1) + '" height="' + (r * 1.8).toFixed(1) + '"' + a + '/>';
      if (shape === 'triangle') return '<polygon points="' + pts([[x, y - r * 1.25], [x + r * 1.15, y + r * 0.85], [x - r * 1.15, y + r * 0.85]]) + '"' + a + '/>';
      if (shape === 'diamond') return '<polygon points="' + pts([[x, y - r * 1.3], [x + r * 1.3, y], [x, y + r * 1.3], [x - r * 1.3, y]]) + '"' + a + '/>';
      return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r + '"' + a + '/>';
    }
    function keyIcon(st) {                                   // 범례 기호 — 선 모양 + 점 모양
      return '<svg class="rp-key" viewBox="0 0 26 12" aria-hidden="true"><line x1="1" y1="6" x2="25" y2="6" stroke="' + st.c + '" stroke-width="2"' +
        (st.dash ? ' stroke-dasharray="' + st.dash + '"' : '') + '/>' + (st.mk ? marker(st.mk, 13, 6, 3.4, st.c, false, 1) : '') + '</svg>';
    }
    function segRv() { return (IDX.seg_rv || {})[CUR.seg] || []; }
    function curveSeries() {
      var s = [{ k: CUR.k, label: CUR.o.mk + ' ' + CUR.o.model, rv: CUR.m && CUR.m.rv || [], st: LINES[0], me: true }];
      V.cmp.forEach(function (k, i) {
        var o = KEY[k], fm = fileModel(k), F = FILES[o.file];
        s.push({ k: k, label: o.mk + ' ' + o.model, rv: fm && fm.rv || [], st: LINES[i + 1], wait: fm === undefined, err: !!(F && F.err), none: fm === null && !(F && F.err) });
      });
      return s;
    }
    function curveCard() {
      var rvMode = V.unit === 'rv', sr = rvMode ? segRv() : [], series = curveSeries(), sname = segName(CUR.seg);
      var h = '<div class="card" id="rpCurve"><div class="v2-tools"><div class="card-title">감가 곡선' + q(TIP.curve) + ' <span class="hint">' +
        (rvMode ? '차령별 잔존율(호가 ÷ 출고가) · 판매중' : '차령별 호가 가운데 값(만원) · 판매중') + '</span></div>' +
        '<div class="segmented" role="group" aria-label="세로축">' + [['rv', '잔존율'], ['amt', '금액']].map(function (x) {
          return '<button type="button" data-r="unit" data-v="' + x[0] + '" aria-pressed="' + (V.unit === x[0]) + '" class="' + (V.unit === x[0] ? 'on' : '') + '">' + x[1] + '</button>';
        }).join('') + '</div></div>';
      h += '<div class="v2-legend rp-legend">';
      series.forEach(function (s, i) {                       // 선이 없는 이유 — 이 모델은 그림 아래 한 번만, 겹쳐 본 모델은 범례에
        var st = s.wait ? ' <span class="v2-dim">불러오는 중…</span>' : s.err ? ' <span class="v2-bad">불러오지 못함</span>' :
          !s.rv.length ? ' <span class="v2-dim">— ' + (i ? esc(rvWhy(IDX.models[s.k])) + ' 선 없음' : '선 없음') + '</span>' : '';
        h += '<span class="rp-lg">' + keyIcon(s.st) + '<span>' + esc(i ? s.label : CUR.o.model) + st + '</span>' +
          (i ? '<button type="button" class="rp-x" data-r="rm" data-k="' + esc(s.k) + '" aria-label="겹쳐 보기에서 빼기: ' + esc(s.label) + '" title="빼기">×</button>' : '') + '</span>';
      });
      if (rvMode && series[0].rv.length) h += '<span><i class="v2-band"></i>가운데 50%</span>';
      if (rvMode && sr.length) h += '<span class="rp-lg">' + keyIcon(SEG_LINE) + '<span>동급 ' + esc(sname) + '</span></span>';
      if (!rvMode && series.some(function (s) { return s.rv.length; })) h += '<span class="v2-dim">금액은 연차별 가운데 값만 — 가운데 50% 띠와 동급 선은 잔존율에서</span>';
      if (series.some(function (s) { return s.rv.some(function (r) { return r[5] < RV_OK; }); })) h += '<span><i style="background:var(--tx-3);opacity:.4"></i>' + RV_OK + '대 미만(참고)</span>';
      h += '</div>';
      var any = series.some(function (s) { return s.rv.length; }) || sr.length;
      if (any) h += curveSvg(series, sr, rvMode, CUR.W.full);
      if (!series[0].rv.length) h += '<p class="v2-kv">이 세부모델은 ' + esc(rvWhy(CUR.r)) + ' 감가 곡선을 그리지 않습니다' + (any && sr.length ? '(점선은 동급)' : '') + '.</p>';
      h += cmpPicker();
      var hi100 = rvMode && (series.some(function (s) { return over100(s.rv); }) || over100(sr));
      return h + '<p class="v2-help">' + RVRULE + '</p>' + (hi100 ? '<p class="v2-help">' + OVER100 + '</p>' : '') + '</div>';
    }
    function cmpPicker() {
      if (V.cmp.length >= MAX_CMP) return '<p class="v2-help">겹쳐 보기는 ' + MAX_CMP + '개까지입니다 — 범례의 ×로 빼고 다시 고르세요.</p>';
      var by = {}, me = String(CUR.seg).split('·')[1] || '';    // 차급별 후보 — 같은 차급이 맨 위, 다음은 같은 국산/수입 → 판매중 많은 차급 순
      Object.keys(IDX.models).forEach(function (k) {
        var x = IDX.models[k];
        if (KEY[k] && k !== CUR.k && V.cmp.indexOf(k) < 0 && x.rvn >= 10) (by[x.seg || ''] = by[x.seg || ''] || []).push(k);
      });
      var on = function (k) { return IDX.models[k].on; }, segs = Object.keys(by).map(function (s) {
        var t = 0;
        by[s].forEach(function (k) { t += on(k); });
        return { s: s, t: t, r: s === CUR.seg ? 0 : (s.split('·')[1] || '') === me ? 1 : 2 };
      }).sort(function (a, b) { return (a.r - b.r) || (b.t - a.t); });
      if (!segs.length) return '<p class="v2-help">겹쳐 볼 다른 모델이 없습니다.</p>';
      var mo = function (k) { var o = KEY[k]; return opt(k, o.mk + ' ' + o.model + (yrTxt(o) ? ' (' + yrTxt(o) + ')' : '') + ' · 판매중 ' + n0(on(k)) + '대', ''); };
      return '<div class="rp-cmp"><select class="filter-select" data-r="cmp" aria-label="다른 모델 겹쳐 보기"><option value="">+ 다른 모델 겹쳐 보기 (최대 ' + MAX_CMP + '개 · 같은 차급이 맨 위)</option>' +
        segs.map(function (x) {
          return '<optgroup label="' + esc((x.r ? '' : '같은 차급 · ') + (segName(x.s) || '차급 미상')) + '">' + by[x.s].sort(function (a, b) { return on(b) - on(a); }).map(mo).join('') + '</optgroup>';
        }).join('') + '</select></div>';
    }
    function runs(rows) {                                    // 이어지는 연차끼리(빈 연차에서 끊는다)
      var out = [];
      rows.forEach(function (r, i) { if (!i || r[0] - rows[i - 1][0] > 1) out.push([]); out[out.length - 1].push(r); });
      return out;
    }
    function curveSvg(series, sr, rvMode, W) {
      var H = Math.max(230, Math.min(340, Math.round(W * 0.42))), L = 46, R = 12, T = 24, B = 40, pw = W - L - R, ph = H - T - B, slot = pw / 13;
      var x = function (a) { return L + (Math.min(a, 12) + 0.5) * slot; };
      var val = function (r) { return rvMode ? r[1] : r[4]; };
      var hi = 0;
      series.forEach(function (s) { s.rv.forEach(function (r) { hi = Math.max(hi, rvMode && s.me ? r[3] : val(r)); }); });
      sr.forEach(function (r) { hi = Math.max(hi, r[1]); });
      hi = (hi || 1) * 1.08;
      var y = function (v) { return T + (1 - v / hi) * ph; };
      var me = series[0], last = me.rv[me.rv.length - 1];
      var h = '<svg class="v2-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('감가 곡선 — ' + me.label + ' 차령별 ' + (rvMode ? '잔존율' : '호가 가운데 값') +
        (last ? ', ' + ageTxt(last[0]) + ' ' + (rvMode ? pc(last[1]) + '%' : man(last[4]) + '만원') : '') + (series.length > 1 ? ', 겹쳐 본 모델 ' + (series.length - 1) + '개' : '')) + '">';
      niceTicks(0, hi, 5).forEach(function (t) {
        h += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(t).toFixed(1) + '" y2="' + y(t).toFixed(1) + '" stroke="' + (t ? 'var(--line)' : 'var(--line-hard)') + '" stroke-width="1"/>' +
          '<text x="' + (L - 6) + '" y="' + (y(t) + 4).toFixed(1) + '" text-anchor="end">' + (rvMode ? Math.round(t * 100) + '%' : compact(t)) + '</text>';
      });
      var step = slot < 22 ? 2 : 1;
      for (var a = 0; a <= 12; a += step) h += '<text x="' + x(a).toFixed(1) + '" y="' + (H - B + 16) + '" text-anchor="middle">' + (a === 12 ? '12+' : a) + '</text>';
      h += '<text x="' + (L + pw / 2).toFixed(1) + '" y="' + (H - 5) + '" text-anchor="middle">차령(년) · 12+ = 12년 이상</text>' +
        '<text x="0" y="' + (T - 10) + '">' + (rvMode ? '잔존율' : '만원') + '</text>';
      if (rvMode) runs(me.rv).forEach(function (run) {        // 이 모델 가운데 50% 띠 — 연차 하나뿐이면 세로 막대
        if (run.length === 1) h += '<line x1="' + x(run[0][0]).toFixed(1) + '" x2="' + x(run[0][0]).toFixed(1) + '" y1="' + y(run[0][3]).toFixed(1) + '" y2="' + y(run[0][2]).toFixed(1) +
          '" stroke="var(--accent-line)" stroke-width="6" stroke-linecap="round"/>';
        else h += '<polygon points="' + pts(run.map(function (r) { return [x(r[0]), y(r[3])]; }).concat(run.slice().reverse().map(function (r) { return [x(r[0]), y(r[2])]; }))) +
          '" fill="var(--accent-wash)" stroke="none"/>';
      });
      runs(sr).forEach(function (run) {                       // 동급 가운데 값(점선)
        if (run.length > 1) h += '<polyline fill="none" stroke="' + SEG_LINE.c + '" stroke-width="1.5" stroke-dasharray="' + SEG_LINE.dash + '" points="' +
          pts(run.map(function (r) { return [x(r[0]), y(r[1])]; })) + '"/>';
        else h += '<circle cx="' + x(run[0][0]).toFixed(1) + '" cy="' + y(run[0][1]).toFixed(1) + '" r="2.5" fill="' + SEG_LINE.c + '"/>';
      });
      for (var si = series.length - 1; si >= 0; si--) {      // 겹쳐 본 모델부터 그려 이 모델이 맨 위
        var s = series[si], st = s.st;
        runs(s.rv).forEach(function (run) {
          for (var i = 1; i < run.length; i++) {
            var p0 = run[i - 1], p1 = run[i], faint = p0[5] < RV_OK || p1[5] < RV_OK;
            h += '<line x1="' + x(p0[0]).toFixed(1) + '" y1="' + y(val(p0)).toFixed(1) + '" x2="' + x(p1[0]).toFixed(1) + '" y2="' + y(val(p1)).toFixed(1) +
              '" stroke="' + st.c + '" stroke-width="' + (s.me ? 2.5 : 2) + '" stroke-linecap="round"' + (st.dash ? ' stroke-dasharray="' + st.dash + '"' : '') + (faint ? ' opacity="0.4"' : '') + '/>';
          }
        });
        s.rv.forEach(function (r) { h += marker(st.mk, x(r[0]), y(val(r)), 4, st.c, r[5] < RV_OK); });
      }
      for (a = 0; a <= 12; a++) {                             // 마우스 올림 칸(연차 하나 폭) — 그 연차의 모든 선 값
        var tip = curveTip(a, series, sr);
        if (tip) h += '<rect class="rp-col" x="' + (L + a * slot).toFixed(1) + '" y="' + T + '" width="' + slot.toFixed(1) + '" height="' + ph + '" fill="transparent" data-tip="' + esc(tip) + '"/>';
      }
      return h + '</svg>';
    }
    function curveTip(a, series, sr) {
      var out = ['차령 ' + ageTxt(a)];
      series.forEach(function (s) {
        var r = rowAt(s.rv, a);
        if (r) out.push((s.me ? s.label.replace(CUR.o.mk + ' ', '') : s.label) + ': 잔존율 ' + pc(r[1]) + '%' + (s.me ? '(가운데 50% ' + pc(r[2]) + '~' + pc(r[3]) + '%)' : '') +
          ' · 호가 ' + man(r[4]) + '만 · ' + n0(r[5]) + '대' + (r[5] < RV_OK ? '(' + RV_OK + '대 미만 · 참고)' : ''));
      });
      var g = rowAt(sr, a);
      if (g) out.push('동급 ' + segName(CUR.seg) + ': 잔존율 ' + pc(g[1]) + '% · ' + n0(g[4]) + '대');
      return out.length > 1 ? out.join('\n') : '';
    }

    // ───── ⑤ 잔존율 표 ─────
    function rvCard() {
      var m = CUR.m, rv = m && m.rv || [], ch = m && m.rv_chg || [], sr = segRv();
      var cm = V.cmp.map(function (k) { var o = KEY[k], fm = fileModel(k); return { label: o.model, rv: fm === undefined ? undefined : fm && fm.rv || [] }; });
      var ages = [], add = function (rows) { (rows || []).forEach(function (r) { if (ages.indexOf(r[0]) < 0) ages.push(r[0]); }); };
      add(rv); add(ch); add(sr);                             // 줄 = 이 모델 · 동급 · 겹쳐 본 모델 연차 모두(이 모델 값이 없는 줄은 흐리게)
      cm.forEach(function (c) { add(c.rv); });
      ages.sort(function (a, b) { return a - b; });
      var h = '<div class="card" id="rpRv"><div class="card-title">잔존율 표' + q(TIP.table) + ' <span class="hint">판매중 · 차령 연차별 · 동급 = ' + esc(segName(CUR.seg)) + '</span></div>';
      if (!ages.length) return h + '<p class="v2-kv">이 세부모델은 ' + esc(rvWhy(CUR.r)) + ' 표를 비웁니다. 같은 차급의 동급 잔존율도 없습니다.</p></div>';
      h += '<div class="v2-tablewrap"><table class="t v2-tbl rp-tbl"><thead><tr><th>차령</th><th class="num">잔존율</th><th class="num">가운데 50%</th><th class="num">호가 가운데</th>' +
        '<th class="num">대수</th><th class="num">동급</th><th class="num">동급 대비</th><th class="num">변화(' + BP + '→최근 4주)</th>' +
        cm.map(function (c) { return '<th class="num">' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>';
      ages.forEach(function (a) {
        var r = rowAt(rv, a), g = rowAt(sr, a), c = rowAt(ch, a), thin = r && r[5] < RV_OK, mc = ' class="num rp-me"';
        h += '<tr' + (thin ? ' class="rp-thin"' : !r ? ' class="rp-none"' : '') + '><td>' + ageTxt(a) + (thin ? ' <span class="v2-mtag">참고</span>' : '') + '</td>' +
          '<td' + mc + '>' + (r ? '<b>' + pc(r[1]) + '%</b>' : '–') + '</td><td' + mc + '>' + (r ? pc(r[2]) + '~' + pc(r[3]) + '%' : '–') + '</td>' +
          '<td' + mc + '>' + (r ? man(r[4]) + '만' : '–') + '</td><td' + mc + '>' + (r ? n0(r[5]) + '대' : '–') + '</td>' +
          '<td class="num">' + (g ? pc(g[1]) + '%<small>' + n0(g[4]) + '대</small>' : '–') + '</td><td' + mc + '>' + (r && g ? sgn((r[1] - g[1]) * 100) + '%p' : '–') + '</td>' +
          '<td class="num">' + (c ? '<b>' + sgn((c[2] - c[1]) * 100) + '%p</b><small>' + pc(c[1]) + '→' + pc(c[2]) + '% · ' + n0(c[3]) + '·' + n0(c[4]) + '대</small>' : '–') + '</td>' +
          cm.map(function (x) {
            var y = x.rv ? rowAt(x.rv, a) : null;
            return '<td class="num">' + (x.rv === undefined ? '…' : y ? pc(y[1]) + '%' + '<small>' + n0(y[5]) + '대' + (y[5] < RV_OK ? ' · 참고' : '') + '</small>' : '–') + '</td>';
          }).join('') + '</tr>';
      });
      h += '</tbody></table></div>';
      var notes = [];
      if (!rv.length) notes.push('이 세부모델은 ' + esc(rvWhy(CUR.r)) + ' 이 모델 칸을 비웁니다.');
      else if (ages.length > rv.length) notes.push('흐린 줄은 이 세부모델의 판매중이 10대 미만인 연차라 동급·겹쳐 본 모델 값만 보여 드립니다.');
      if (rv.some(function (r) { return r[5] < RV_OK; })) notes.push('"참고"는 그 연차 판매중이 ' + RV_OK + '대 미만이라 흔들릴 수 있는 값입니다.');
      notes.push(ch.length ? '변화는 같은 연차 신규 매물의 첫 호가 ÷ 출고가를 기준기간과 최근 4주로 비교한 값입니다(작은 글씨 = 기준기간→최근 4주 잔존율 · 대수).'
        : '변화는 기준기간과 최근 4주 신규 매물이 양쪽 10대 이상인 연차가 없어 비웁니다.');
      if (over100(rv) || over100(sr) || cm.some(function (c) { return c.rv && over100(c.rv); })) notes.push(OVER100);
      return h + '<p class="v2-help">' + notes.join(' ') + '</p></div>';
    }

    // ───── ⑥ 시세 추세 · 공급·판매 추이 ─────
    function trendHtml() {
      if (!CUR.seg) return '<div class="card"><div class="card-title">시세 추세</div><p class="v2-kv">차급을 몰라 시세 추세를 그리지 않습니다.</p></div>';
      return ctx.trendCard(CUR.o.mk, CUR.o.model, CUR.seg, CUR.W.half);   // 시세 산정과 같은 카드
    }
    function flowCard() {
      var fl = CUR.m && CUR.m.flows || [], h = '<div class="card"><div class="card-title">공급·판매 추이' + q(TIP.flow) +
        ' <span class="hint">목록 관측일 · 회색 띠 = 16일 넘는 수집 공백</span></div>';
      if (!CUR.m) return h + '<p class="v2-kv">리포트 자료에 이 세부모델의 회차별 흐름이 없어 그리지 않습니다.</p></div>';
      if (fl.length < 2) return h + '<p class="v2-kv">수집 회차가 2회 미만이라 추이를 그리지 않습니다.</p></div>';
      var p = fl.map(function (r) { return { d: r[0], t: day(r[0]), on: r[1], nw: r[2], sd: r[3], days: r[4] }; });
      h += '<div class="v2-legend"><span><i class="v2-lkey" style="background:var(--rp-stock)"></i>판매중</span><span><i style="background:var(--rp-new);border-radius:2px"></i>신규/주</span>' +
        '<span><i style="background:var(--rp-sold);border-radius:2px"></i>판매/주</span><span><i style="background:var(--tx-4);opacity:.4;border-radius:2px"></i>구간이 5~16일이 아님</span></div>' + flowSvg(p, CUR.W.half);
      var e = p[p.length - 1], pv = p[p.length - 2];
      var line = md(e.d) + ' 판매중 매물은 <b>' + n0(e.on) + '대</b>' + (e.days != null && e.days <= IRREG[1] ? '로 ' + md(pv.d) + '보다 ' +
        (e.on === pv.on ? '변화가 없습니다' : n0(Math.abs(e.on - pv.on)) + '대 ' + (e.on > pv.on ? '늘었습니다' : '줄었습니다')) : '입니다') + '.';
      if (e.nw != null) line += ' 신규는 주 <b>' + fmtW(e.nw) + '대</b>, 판매는 주 <b>' + fmtW(e.sd) + '대</b>입니다' + (reg(e.days) ? '' : '(구간 ' + e.days + '일 — 참고)') + '.';
      if (e.nw != null && e.days <= IRREG[1]) {              // 판매중 변화 − (신규 − 판매) — 신규에 세지 않는 예전 등록 매물(마켓 펄스 '그 밖 유입'과 같은 식)
        var other = e.on - pv.on - Math.round((e.nw - e.sd) * e.days / 7);
        if (other > 0) line += ' 판매중 변화에는 지난 목록에 없던 예전 등록 매물 <b>' + n0(other) + '대</b>도 들어 있습니다(신규에 세지 않음).';
        else if (other < 0) line += ' 판매로 세지 않고 판매중에서 빠진 매물 <b>' + n0(-other) + '대</b>도 있습니다.';
      }
      var vs;
      if (reg(e.days) && reg(pv.days) && pv.nw != null) vs = '지난 구간(' + md(pv.d) + ')보다 신규 ' + arrow(e.nw - pv.nw) + ', 판매 ' + arrow(e.sd - pv.sd) + '입니다.';
      else vs = '<span class="v2-pill">짧음</span> 신규·판매의 지난주 대비는 ' + (pv.days == null ? md(pv.d) + '이 첫 수집이라' : pv.days > IRREG[1] ? md(pv.d) + '이 ' + pv.days + '일 공백 뒤 첫 회차라' :
        !reg(e.days) ? '마지막 구간이 ' + e.days + '일이라' : md(pv.d) + ' 구간이 ' + pv.days + '일로 짧아') + ' 내지 않습니다. 매주 수집이 이어지면 다음 회차부터 나옵니다.';
      var qn = flowQuality(p);
      return h + '<p class="v2-kv">' + line + '</p><p class="v2-kv">' + vs + '</p>' + (qn.txt ? '<p class="v2-help">' + qn.txt + '</p>' : '') + '</div>';
    }
    function flowQuality(p) {                                // 수집 품질 주의 — market_index 전체 시리즈의 회차 표시(전남광주 누락 · 7/30 판매 부풀림)
      var by = {}, jn = [], jns = [], sus = [], tip = {};
      ((X.mi && X.mi.series || {})['전체|전체'] || []).forEach(function (v) { by[v.date] = v; });
      p.forEach(function (v) {
        var f = by[v.d], t = [];
        if (!f) return;
        if (f.jn_gap) { jn.push(md(v.d)); t.push('전남광주 매물이 빠진 목록 — 판매중·신규' + (f.jn_gap_sold && v.sd != null ? '·판매' : '') + '가 낮게 잡힘'); }
        if (f.jn_gap && f.jn_gap_sold && v.sd != null) jns.push(md(v.d));
        if (f.sold_suspect && v.sd != null) { sus.push(md(v.d)); t.push('목록 일부가 빠져 판매가 부풀었을 수 있음'); }
        if (t.length) tip[v.d] = t.join('\n');
      });
      var s = [];
      if (jn.length) s.push(jn.join('·') + ' 목록은 전남광주 매물이 빠져 판매중·신규가 실제보다 낮게 잡혔습니다' + (jns.length ? '(' + jns.join('·') + '은 판매도)' : '') + '.');
      if (sus.length) s.push(sus.join('·') + ' 판매는 목록 일부가 빠져 부풀었을 수 있습니다.');
      return { txt: s.length ? '수집 품질: ' + s.join(' ') + ' 이 회차의 오르내림 일부는 시장 변화가 아니라 수집 탓일 수 있습니다.' : '', tip: tip };
    }
    function arrow(d) { return d > 0 ? '▲' + fmtW(d) : d < 0 ? '▼' + fmtW(-d) : '–'; }
    function flowSvg(p, W) {
      var L = 46, R = 12, T = 20, H1 = 80, MID = 32, H2 = 92, B = 24, b0 = T + H1 + MID, H = b0 + H2 + B;
      var a = p[0].t, z = p[p.length - 1].t;
      if (z - a < 7) { a -= 3; z += 3; }
      var pad = (z - a) * 0.04;
      a -= pad; z += pad;
      var x = function (t) { return L + (t - a) / (z - a) * (W - L - R); };
      var ons = p.map(function (v) { return v.on; }), lo = Math.min.apply(null, ons), hi = Math.max.apply(null, ons), sp = Math.max(hi - lo, hi * 0.05, 4);
      lo = Math.max(0, Math.floor(lo - sp * 0.2)); hi = Math.ceil(hi + sp * 0.2);   // 정수 끝 — 1~3대 모델도 눈금이 두 개 이상
      var y1 = function (v) { return T + (hi - v) / (hi - lo) * H1; };
      var top = 1;
      p.forEach(function (v) { if (v.nw != null) top = Math.max(top, v.nw, v.sd || 0); });
      top *= 1.12;
      var y2 = function (v) { return b0 + (1 - v / top) * H2; };
      var e = p[p.length - 1];
      var h = '<svg class="v2-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('공급·판매 추이 — ' + md(e.d) + ' 판매중 ' + n0(e.on) + '대' +
        (e.nw != null ? ', 신규 ' + fmtW(e.nw) + '대/주, 판매 ' + fmtW(e.sd) + '대/주' : '')) + '">';
      p.forEach(function (v, i) {                              // 16일 넘는 공백 음영(두 칸 모두)
        if (!i || v.t - p[i - 1].t <= IRREG[1]) return;
        var x0 = x(p[i - 1].t) + 6, x1 = x(v.t) - 6;
        if (x1 - x0 < 6) return;
        h += '<rect x="' + x0.toFixed(1) + '" y="' + T + '" width="' + (x1 - x0).toFixed(1) + '" height="' + (b0 + H2 - T) + '" fill="var(--bg-2)"/>';
        if (x1 - x0 >= 44) h += '<text x="' + ((x0 + x1) / 2).toFixed(1) + '" y="' + (b0 - 12) + '" text-anchor="middle">' + (v.t - p[i - 1].t) + '일 공백</text>';
      });
      niceTicks(lo, hi, 3, 1).forEach(function (t) {
        h += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y1(t).toFixed(1) + '" y2="' + y1(t).toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>' +
          '<text x="' + (L - 6) + '" y="' + (y1(t) + 4).toFixed(1) + '" text-anchor="end">' + compact(t) + '</text>';
      });
      niceTicks(0, top, 3, 1).forEach(function (t) {
        h += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y2(t).toFixed(1) + '" y2="' + y2(t).toFixed(1) + '" stroke="' + (t ? 'var(--line)' : 'var(--line-hard)') + '" stroke-width="1"/>' +
          '<text x="' + (L - 6) + '" y="' + (y2(t) + 4).toFixed(1) + '" text-anchor="end">' + compact(t) + '</text>';
      });
      h += '<text class="rp-ptitle" x="' + L + '" y="' + (T - 7) + '">판매중(대)</text><text class="rp-ptitle" x="' + L + '" y="' + (b0 - 26) + '">신규 · 판매(대/주)</text>';
      var seg = [];                                            // 판매중 선 — 긴 공백은 옅은 점선으로만 잇는다
      var flush = function () { if (seg.length > 1) h += '<polyline fill="none" stroke="var(--rp-stock)" stroke-width="2" stroke-linejoin="round" points="' + seg.join(' ') + '"/>'; seg = []; };
      p.forEach(function (v, i) {
        if (i && v.t - p[i - 1].t > IRREG[1]) {
          flush();
          h += '<line x1="' + x(p[i - 1].t).toFixed(1) + '" y1="' + y1(p[i - 1].on).toFixed(1) + '" x2="' + x(v.t).toFixed(1) + '" y2="' + y1(v.on).toFixed(1) +
            '" stroke="var(--rp-stock)" stroke-opacity="0.5" stroke-width="1" stroke-dasharray="2 3"/>';
        }
        seg.push(x(v.t).toFixed(1) + ',' + y1(v.on).toFixed(1));
      });
      flush();
      p.forEach(function (v) { h += '<circle cx="' + x(v.t).toFixed(1) + '" cy="' + y1(v.on).toFixed(1) + '" r="3.5" fill="var(--rp-stock)" stroke="var(--bg-1)" stroke-width="1.5"/>'; });
      h += '<text class="lbl v2-halo" x="' + (x(e.t) - 6).toFixed(1) + '" y="' + (y1(e.on) - 8).toFixed(1) + '" text-anchor="end">' + n0(e.on) + '</text>';
      var bars = p.filter(function (v) { return v.nw != null; }), gap = Infinity, base = y2(0);
      bars.forEach(function (v, i) { if (i) gap = Math.min(gap, x(v.t) - x(bars[i - 1].t)); });
      var bw = Math.max(2, Math.min(9, gap / 2 - 2));
      var bar = function (bx, v, color, faded) {               // 위쪽만 둥글게, 바닥은 각지게
        var by = y2(v), hg = Math.max(base - by, 0), r = Math.min(3, hg, bw / 2), n = function (k) { return k.toFixed(1); };
        return '<path d="M' + n(bx) + ',' + n(base) + 'V' + n(by + r) + 'Q' + n(bx) + ',' + n(by) + ' ' + n(bx + r) + ',' + n(by) + 'H' + n(bx + bw - r) +
          'Q' + n(bx + bw) + ',' + n(by) + ' ' + n(bx + bw) + ',' + n(by + r) + 'V' + n(base) + 'Z" fill="' + color + '"' + (faded ? ' opacity="0.35"' : '') + '/>';
      };
      bars.forEach(function (v) {
        var cx = x(v.t), faded = !reg(v.days);
        h += bar(cx - bw - 1, v.nw, 'var(--rp-new)', faded) + bar(cx + 1, v.sd, 'var(--rp-sold)', faded);
      });
      var used = [];                                           // 날짜 눈금 — 최근 회차부터, 겹치면 생략
      for (var i = p.length - 1; i >= 0; i--) {
        var lx = x(p[i].t);
        if (used.some(function (u) { return Math.abs(u - lx) < 30; })) continue;
        used.push(lx);
        h += '<text x="' + lx.toFixed(1) + '" y="' + (H - B + 16) + '" text-anchor="middle">' + md(p[i].d) + '</text>';
      }
      var qt = flowQuality(p).tip;
      p.forEach(function (v, i) {                              // 마우스 올림 칸 — 그 회차의 값(수집 품질 주의 포함)
        var xa = i ? (x(p[i - 1].t) + x(v.t)) / 2 : L, xb = i < p.length - 1 ? (x(v.t) + x(p[i + 1].t)) / 2 : W - R;
        var tip = md(v.d) + (v.days != null ? ' · 직전 수집과 ' + v.days + '일' : ' · 첫 수집') + '\n판매중 ' + n0(v.on) + '대' +
          (v.nw != null ? '\n신규 ' + fmtW(v.nw) + '대/주 · 판매 ' + fmtW(v.sd) + '대/주' : '\n신규·판매 없음(첫 수집)') +
          (v.days != null && !reg(v.days) ? '\n구간이 ' + v.days + '일 — ' + (v.days > IRREG[1] ? '공백이 길어 그사이 들어왔다 팔린 매물이 빠짐' : '구간이 짧아 흔들림') + '(비교 주의)' : '') +
          (qt[v.d] ? '\n' + qt[v.d] : '');
        h += '<rect class="rp-col" x="' + xa.toFixed(1) + '" y="' + T + '" width="' + Math.max(4, xb - xa).toFixed(1) + '" height="' + (b0 + H2 - T) + '" fill="transparent" data-tip="' + esc(tip) + '"/>';
      });
      h += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '" stroke="var(--line-hard)" stroke-width="1"/>';
      return h + '</svg>';
    }

    // ───── ⑦ 가격 인하 행동 ─────
    function segCutW(seg) {                                  // 동급 이번 주 인하 비율 = 같은 차급·구분 세부모델의 같은 매물 대수 가중
      var s = 0, n = 0;
      Object.keys(IDX.models).forEach(function (k) { var r = IDX.models[k]; if (r.seg === seg && r.cut_w != null && r.cut_w_n) { s += r.cut_w * r.cut_w_n; n += r.cut_w_n; } });
      return n ? s / n : null;
    }
    function weeklyRun() {                                   // 지금 이어지는 매주 수집 회차 수(16일 넘는 공백 뒤부터)
      var c = X.mi.crawls || [], n = c.length ? 1 : 0;
      for (var i = c.length - 1; i > 0 && c[i].gap_days != null && c[i].gap_days <= IRREG[1]; i--) n++;
      return n;
    }
    function hbar(name, v, mx, cls, me) {
      return '<div class="v2-hrow' + (me ? ' me' : '') + '"><span class="k">' + esc(name) + '</span><span class="trk"><i class="' + cls + '" style="width:' +
        (mx ? v / mx * 100 : 0).toFixed(1) + '%"></i></span><span class="v">' + pc(v) + '%</span></div>';
    }
    function cutCard() {
      var c = CUR.m && CUR.m.cut || {}, w = c.w, on = c.on, cr = X.mi.crawls || [], d1 = cr[cr.length - 1], d0 = cr[cr.length - 2], sname = segName(CUR.seg);
      var h = '<div class="card"><div class="card-title">가격 인하 행동' + q(TIP.cutb) + ' <span class="hint">판매자들이 값을 내리고 있나 · 동급 = ' + esc(sname) + '</span></div>';
      h += '<div class="v2-ssub">이번 주 같은 매물 <span class="hint">' + (d0 && d1 ? md(d0.date) + '→' + md(d1.date) + ' 두 목록에 모두 있는 판매중 매물' : '') + '</span>' +
        (d1 && !reg(d1.gap_days) ? '<span class="v2-pill" title="수집 간격이 5~16일이 아니라 한 주 변화로 보기 어렵습니다">짧음</span>' : '') + '</div>';
      if (w && w.n) {
        var sw = segCutW(CUR.seg), mx = Math.max(w.cut, sw || 0);
        h += hbar('이 세부모델', w.cut, mx, 'me', true) + (sw != null ? hbar('동급 ' + sname, sw, mx, 'base') : '') +
          '<p class="v2-kv">' + n0(w.n) + '대 가운데 <b>' + pc(w.cut) + '%</b>가 값을 내렸고' +
          (w.med_pct != null && w.cut > 0 ? '(내린 폭 가운데 값 <b>' + cutPct(w.med_pct) + '</b>' + (w.med_amt != null ? ', <b>' + cutAmt(w.med_amt) + '</b>' : '') + ')' : '') +
          ', <b>' + pc(w.up) + '%</b>가 올렸습니다.' +
          (w.n < RV_OK ? ' <span class="v2-mtag">표본 적음</span>' : '') + '</p>';
      } else h += '<p class="v2-kv">두 목록에 모두 있는 판매중 매물이 없어 생략합니다.</p>';
      h += '<div class="v2-ssub">첫 호가 대비 <span class="hint">판매중 매물이 처음 올린 값보다 내린 상태인가</span></div>';
      if (on && on.n && on.share != null) h += '<p class="v2-kv">판매중 ' + n0(on.n) + '대 가운데 <b>' + pc(on.share) + '%</b>가 첫 호가보다 내린 상태입니다' +
        (on.med_amt != null && on.share > 0 ? '(내린 폭 가운데 값 <b>' + cutAmt(on.med_amt) + '</b>' + (on.med_pct != null ? ', <b>' + cutPct(on.med_pct) + '</b>' : '') + ')' : '') + '.' +
        (on.n < RV_OK ? ' <span class="v2-mtag">표본 적음</span>' : '') + '</p>';
      else h += '<p class="v2-kv">판매중 매물이 없어 생략합니다.</p>';
      h += '<div class="v2-ssub">첫 인하까지 걸리는 날</div>';
      var run = weeklyRun();
      h += c.first_cut_days != null ? '<p class="v2-kv">엔카 등록 뒤 첫 인하까지 가운데 <b>' + n0(c.first_cut_days) + '일</b>입니다.</p>'
        : '<p class="v2-kv">' + (run < 3 ? '주간 목록 가격이 쌓이는 중입니다(지금 ' + run + '회째 · 3회부터 계산).' : '첫 인하를 확인한 매물이 ' + RV_OK + '대 미만이라 생략합니다.') + '</p>';
      return h + '<p class="v2-help">위 지표의 "인하 매물"은 판매중 전체 기준이라, 가격 통계에서 뺀 매물만큼 이 카드의 대수·비율과 조금 다를 수 있습니다.</p></div>';
    }

    // ───── ⑧ 매물 목록 ─────
    function link(id) {
      return '<a class="v2-link" href="' + ENCAR + encodeURIComponent(id) + '" target="_blank" rel="noopener noreferrer" aria-label="엔카에서 매물 ' + esc(id) + ' 보기(새 창)">' + esc(id) + ' ↗</a>';
    }
    function listCard(kind) {
      var low = kind === 'low', list = CUR.m && CUR.m[kind] || [], n = CUR.r ? CUR.r[kind] : list.length, rules = IDX.rules || {};
      var tip = (low ? TIP.low : TIP.old) + (rules[kind] ? ' 기준: ' + rules[kind] + '.' : '');   // 기준 문구는 report/index.json rules 그대로
      var h = '<div class="card"><div class="card-title">' + (low ? '이상 의심 매물' : '오래 안 팔리는 매물') + q(tip) +
        ' <span class="hint">' + esc(rules[kind] || '') + '</span></div>';
      if (!list.length) return h + '<p class="v2-kv">' + (n ? '판매중 ' + n0(n) + '대가 이 기준에 걸렸지만 목록 자료가 없습니다.' : '이 기준에 걸린 판매중 매물이 없습니다.') + '</p></div>';
      h += '<p class="v2-kv">' + (n > list.length ? '이 기준에 걸린 판매중 매물 <b>' + n0(n) + '대</b> 가운데 ' + (low ? '호가 ÷ 추정이 낮은' : '체류가 긴') + ' ' + list.length + '대를 보여 드립니다.'
        : '이 기준에 걸린 판매중 매물은 <b>' + n0(n) + '대</b>입니다.') + '</p>';
      h += '<div class="v2-tablewrap"><table class="t v2-tbl rp-ltbl"><thead><tr><th>매물(엔카)</th><th>최초등록</th><th class="num">주행</th><th>등급</th>' +
        (low ? '<th>사고</th><th class="num">호가</th><th class="num">추정 시세</th><th class="num">호가 ÷ 추정</th>'
          : '<th class="num">첫 호가</th><th class="num">지금 호가</th><th class="num">내린 폭</th><th class="num">체류</th>') + '</tr></thead><tbody>';
      list.forEach(function (r) {
        h += '<tr><td>' + link(r[0]) + '</td>';
        if (low) h += '<td>' + ymTxt(r[4]) + '</td><td class="num">' + (r[5] / 1e4).toFixed(1) + '만km</td><td>' + esc(r[6]) + '</td><td>' + esc(r[7] || '') + '</td>' +
          '<td class="num">' + man(r[1]) + '만</td><td class="num">' + man(r[2]) + '만</td><td class="num"><b>' + pc(r[3]) + '%</b></td>';
        else h += '<td>' + ymTxt(r[4]) + '</td><td class="num">' + (r[5] / 1e4).toFixed(1) + '만km</td><td>' + esc(r[6]) + '</td>' +
          '<td class="num">' + man(r[2]) + '만</td><td class="num">' + man(r[1]) + '만</td><td class="num">' + ctx.signed(r[1] - r[2]) + '만<small>' + ctx.pct((r[1] / r[2] - 1) * 100) + '</small></td>' +
          '<td class="num"><b>' + n0(r[3]) + '일</b></td>';
        h += '</tr>';
      });
      return h + '</tbody></table></div><p class="v2-help">매물 번호를 누르면 엔카 상세 화면이 새 창으로 열립니다. 기준 ' + md(IDX.date) + ' 목록이라 그 뒤에 팔렸거나 값이 바뀌었을 수 있습니다.</p></div>';
    }

    // ───── 이벤트 ─────
    function go(text) { ctx.hash(params()); renderPick(text); renderBody(); }
    function onChange(e) {
      var t = e.target, k = t.getAttribute && t.getAttribute('data-r');
      if (!k) return;
      var v = t.value;
      if (k === 'cmp') { if (v) addCmp(v); return; }
      if (k === 'mk') { V.mk = v; V.grp = ''; V.model = ''; }
      else if (k === 'grp') {
        V.grp = v; V.model = '';
        var G = groupOf(makerOf(V.mk), v);
        if (G && G.models.length === 1) V.model = G.models[0].name;      // 세부모델이 하나뿐이면 바로
      } else if (k === 'model') V.model = v;
      else return;
      V.cmp = []; V.msg = ''; V.fmsg = '';
      go();
    }
    function addCmp(k) {
      if (!KEY[k] || V.cmp.indexOf(k) >= 0 || V.cmp.length >= MAX_CMP) return;
      V.cmp.push(k);
      ctx.hash(params());
      renderCurve(true);
      refocus('select[data-r="cmp"]');
      loadCmp();
    }
    function refocus(sel) {                                  // 감가 곡선 카드를 다시 그린 뒤 누른 자리로 초점
      var c = $('rpCurve'), x = c && (c.querySelector(sel) || c.querySelector('button[data-r="rm"]'));
      if (x) x.focus();
    }
    function onClick(e) {
      var b = e.target.closest && e.target.closest('button[data-r]');
      if (!b) return;
      var k = b.getAttribute('data-r');
      if (k === 'unit') {
        var v = b.getAttribute('data-v');
        if (v !== V.unit) { V.unit = v; ctx.hash(params()); renderCurve(false); refocus('button[data-r="unit"][data-v="' + v + '"]'); }
      } else if (k === 'rm') {
        var key = b.getAttribute('data-k');
        V.cmp = V.cmp.filter(function (x) { return x !== key; });
        ctx.hash(params());
        renderCurve(true);
        refocus('select[data-r="cmp"]');
      } else if (k === 'find') find();
      else if (k === 'share') share(b);
    }
    function share(b) {
      var done = function () { b.textContent = '복사됨'; setTimeout(function () { b.textContent = '링크 복사'; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, function () { prompt('이 주소를 복사하세요', location.href); });
      else prompt('이 주소를 복사하세요', location.href);
    }
    function onKey(e) { if (e.target.id === 'rpQ' && e.key === 'Enter') { e.preventDefault(); find(); } }
    function onInput(e) {                                    // 찾기 목록에서 고르면 바로(글자를 치는 중에는 기다림)
      if (e.target.id !== 'rpQ') return;
      var o = NAMES[e.target.value];
      if (o && (!e.inputType || e.inputType === 'insertReplacementText')) pickModel(o);
    }

    function show(container, p) {
      if (el !== container) {
        el = container;
        el.innerHTML = '<div class="card rp-pick" id="rpPick"></div><div class="rp-body" id="rpBody"></div><datalist id="rpList">' +
          LIST.slice().sort(byOn).map(function (o) { return '<option value="' + esc(o.mk + ' ' + o.model) + '" label="' + esc(o.grp + (yrTxt(o) ? ' · ' + yrTxt(o) : '')) + '"></option>'; }).join('') +
          '</datalist>';
        el.addEventListener('change', onChange);
        el.addEventListener('click', onClick);
        el.addEventListener('keydown', onKey);
        el.addEventListener('input', onInput);
        ctx.bindTips(el);
        var rt = 0;
        window.addEventListener('resize', function () {                  // 폭이 크게 바뀌면 그림을 다시(글자 크기 그대로)
          clearTimeout(rt);
          rt = setTimeout(function () { if (!el.hidden && Math.abs(el.clientWidth - lastW) > 8) renderBody(); }, 200);
        });
      }
      setState(p || new URLSearchParams());
      ctx.hash(params());                                    // 찾지 못한 이름은 뺀 주소로
      renderPick('');
      renderBody();
      if (!IDX) getIdx().then(function () { renderPick(); if (!V.model) renderBody(); });
      getMM();
    }
    return { show: show };
  }

  var api = { create: create };
  root.V2Report = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
