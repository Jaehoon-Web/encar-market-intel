/*
 * market.js — 새 사이트(v2) 시장 시황 화면 (기획안 5.2: 시황판 · 핵심 숫자 · 트렌드 · 차종 비교, 5.5.3: 차종 사분면)
 *
 * 데이터: ../data/market_index.json(세그먼트별 지수 + 회차별 흐름, market_index.py) · ../data/market_models.json(세부모델별 숫자)
 *        · ../data/report/index.json(세부모델 잔존가치 지수, model_report.py — 못 불러오면 사분면의 가치 축만 끈다)
 * 위쪽 한 줄(국산·수입 · 기간)이 아래 전부에 적용된다. 시황판 행을 누르면 핵심 숫자·트렌드·사분면·차종 비교가 그 세그먼트로 바뀐다.
 * 날짜는 목록 관측일, 축은 실제 날짜 간격. 10일 넘는 공백은 음영, 5~16일이 아닌 구간의 흐름은 흐리게 그린다.
 * 사분면 점·차종 비교의 세부모델을 누르면 모델 리포트, 차종 비교 행 끝 '모델 요약'은 시세 산정으로 간다.
 *
 *   var M = V2Market.create(ctx);   M.show(el, params);      // ctx = app.js 가 넘기는 데이터·도우미(reportHref·mm 포함)
 */
(function (root) {
  'use strict';

  var SEGS = ['경차', '소형', '준중형', '중형', '대형', '스포츠', 'SUV', 'RV', '승합', '화물'];
  var IDX = [['시황', '시황지수', 'var(--s-cond)'], ['시세', '시세지수', 'var(--s-price)'], ['판매속도', '판매속도지수', 'var(--s-speed)'], ['재고', '재고지수', 'var(--s-stock)']];
  var GAP = 10, IRREG = [5, 16], PAGE = 100;
  var COLS = [['model', '세부모델', 's'], ['seg', '차급', 's'], ['on', '판매중', 'n'], ['price', '중앙 호가', 'n'], ['cut', '인하 매물', 'n'],
    ['sold90', '90일 판매', 'n'], ['dwell', '중위 체류', 'n'], ['rate_w', '주간 판매율', 'n'], ['weeks', '소진 주수', 'n'], ['pidx', '시세(7월=100)', 'n'],
    ['rvi', '잔존가치', 'n'], ['d1', '시세 1주', 'n']];

  // 차종 비교 설명 — 표 머리글과 같은 말로(market_models.json 의 note 는 CSV 열 이름 설명이라 화면에는 쓰지 않는다)
  var MODEL_NOTE = '세부모델별 시장 숫자. 판매중 = 상세까지 확인한 판매중 매물 · 인하 매물 = 첫 호가보다 내린 매물 비율 · ' +
    '90일 판매·중위 체류 = 최근 90일 판매 대수와 중위 체류일(5대 이상일 때) · 주간 판매율 = 최근 판매속도 구간의 주간 판매율(구간 시작 10대 이상) · ' +
    '소진 주수 = 지금 재고가 다 팔리는 데 걸리는 주(1 ÷ 주간 판매율) · 시세(7월=100) = 새로 올라온 매물 시세(기준기간 = 100, 양쪽 10대 이상) · ' +
    '잔존가치 = 잔존가치 지수(판매중 매물마다 잔존율(호가 ÷ 출고가)을 같은 차급·국산수입·차령 연차의 가운데 잔존율로 나눈 값의 가운데 값 × 100, 동급 = 100, 계산한 매물 20대 이상일 때) · ' +
    '시세 1주 = 직전 목록 대비 세부모델 시세지수 변화(흐린 값은 신규 매물 수로 생기는 흔들림의 2배를 넘지 않아 보합으로 봄)';

  // 차종 사분면(기획안 5.5.3) — 가로축 두 가지 · 네 칸 이름(우상·좌상·우하·좌하 순) · 판매중 100대 이상 세부모델만
  var QX = { rv: '잔존가치 지수', trend: '시세 1주 변화' }, QMIN = 100, QCOVER = 2;   // QCOVER = 사분면 이름표 하나가 가려도 되는 다른 점 수(넘으면 이름표 생략)
  var QNAME = { rv: ['핵심 자산', '회전형', '보유형', '주의'], trend: ['오르며 빨리 팔림', '내리며 빨리 팔림', '오르나 느림', '내리며 느림'] };
  var QSUB = { rv: ['가치↑ 속도↑', '가치↓ 속도↑', '가치↑ 속도↓', '가치↓ 속도↓'], trend: ['시세↑ 판매율↑', '시세↓ 판매율↑', '시세↑ 판매율↓', '시세↓ 판매율↓'] };

  function create(ctx) {
    var MI = ctx.X.mi, esc = ctx.esc, man = ctx.man, el = null, MM = null, mmWait = null, mmErr = '', HAVE = {}, YR = {};
    var RV = null, rvWait = null, rvErr = '', WK = {}, ONMAX = 0;   // report/index.json(잔존가치 지수) · 세부모델 시세 1주 변화 · 점 크기 기준
    ctx.X.idx.makers.forEach(function (mk) {                 // 시세 산정에 비교 매물이 있는 세부모델(모델 요약으로 갈 수 있는 것) · 연식 범위
      mk.groups.forEach(function (g) { g.models.forEach(function (m) {
        var k = mk.name + '|' + g.name + '|' + m.name;
        HAVE[k] = true;
        if (m.y0 && m.y1) YR[k] = m.y0 === m.y1 ? String(m.y0) : m.y0 + '~' + m.y1;
      }); });
    });
    var V = { o: '전체', s: '전체', range: 'all', sort: 'on', dir: -1, q: '', shown: PAGE, table: false, qx: 'rv' };

    function $(id) { return document.getElementById(id); }
    function day(s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5; }
    function md(s) { return (+s.slice(5, 7)) + '/' + (+s.slice(8, 10)); }
    function f1(v) { return v == null ? '–' : Number(v).toFixed(1); }
    function key() { return V.o + '|' + V.s; }
    function series(k) { return MI.series[k || key()] || []; }
    function last(pts, f) { for (var i = pts.length - 1; i >= 0; i--) if (pts[i][f] != null) return i; return -1; }
    function prevOf(pts, f, i) { for (var j = i - 1; j >= 0; j--) if (pts[j][f] != null) return j; return -1; }
    function lastDate() { var c = MI.crawls; return c[c.length - 1].date; }
    function inRange(p) { return V.range === 'all' || day(p.date) >= day(lastDate()) - 92; }
    function niceTicks(a, z, n) {
      var span = z - a || 1, step = Math.pow(10, Math.floor(Math.log(span / n) / Math.LN10)), e = span / n / step;
      if (e >= 7.5) step *= 10; else if (e >= 3.5) step *= 5; else if (e >= 1.5) step *= 2;
      var t = [];
      for (var v = Math.ceil(a / step) * step; v <= z + 1e-9; v += step) t.push(Math.round(v / step) * step);
      return t;
    }
    function compact(v) {                                    // 축 눈금·변화량: 12.5만 · 13만 · 5,000
      if (v < 1e4) return Math.round(v).toLocaleString('ko-KR');
      var m = v / 1e4;
      return (Math.abs(m - Math.round(m)) < 0.05 ? Math.round(m) : m.toFixed(1)) + '만';
    }
    function delta(cur, prev, digits, unit) {
      if (cur == null || prev == null) return '';
      var d = cur - prev, a = Math.abs(d);
      return (d > 0 ? '▲' : d < 0 ? '▼' : '–') + (a >= 1e4 ? compact(a) : digits ? a.toFixed(digits) : Math.round(a).toLocaleString('ko-KR')) + (unit || '');
    }
    function sgn1(v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1); }
    function med(a) { var s = a.slice().sort(function (x, y) { return x - y; }), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; }

    // ───── 세부모델 값: 잔존가치 지수 · 시세 1주 변화 ─────
    function mkey(m) { return m.maker + '|' + m.group + '|' + m.model; }
    function rvRec(m) { return RV && RV.models && RV.models[m.maker + '|' + m.model] || null; }
    function rviOf(m) { var r = rvRec(m); return r && r.rvi != null ? r.rvi : null; }
    function wkDates() {                                      // 1주 변화의 두 목록 관측일 [직전, 기준] — 기준 = market_models.json 의 date
      var c = MI.crawls, i = -1;
      c.forEach(function (x, j) { if (x.date === MM.date) i = j; });
      return i > 0 ? [c[i - 1].date, MM.date] : null;
    }
    function wk(m) {                                          // 시세 1주 변화 {d, se, sig}: ps 마지막 두 점이 직전→기준 목록일 때만. 흔들림 se_i = 지수 × 1.2533 × sig ÷ √신규 대수
      var k = mkey(m);
      if (k in WK) return WK[k];
      var ps = m.ps, td = MM.trend_dates || [], w = wkDates(), r = null, n = ps ? ps.length : 0;
      if (n >= 2 && w && m.sig && td[ps[n - 2][0]] === w[0] && td[ps[n - 1][0]] === w[1]) {
        var a = ps[n - 2], b = ps[n - 1], s = function (p) { return p[1] * 1.2533 * m.sig / Math.sqrt(p[2]); };
        var se = Math.sqrt(s(a) * s(a) + s(b) * s(b)), raw = b[1] - a[1];
        r = { d: Math.round(raw * 10) / 10, se: se, sig: Math.abs(raw) >= Math.max(0.5, 2 * se) };   // 오름·내림은 흔들림 2배(최소 0.5)를 넘을 때만 — 시세 추세와 같은 기준
      }
      WK[k] = r;
      return r;
    }
    function val(m, k) { var w; return k === 'rvi' ? rviOf(m) : k === 'd1' ? ((w = wk(m)) ? w.d : null) : m[k]; }

    // ───── 위쪽 한 줄 · 시황판 ─────
    function filters() {
      var seg = function (k, opts, cur) {
        return '<div class="segmented" role="group">' + opts.map(function (o) {
          return '<button type="button" data-m="' + k + '" data-v="' + esc(o[0]) + '" class="' + (cur === o[0] ? 'on' : '') + '">' + esc(o[1]) + '</button>';
        }).join('') + '</div>';
      };
      var c = MI.crawls, gaps = c.filter(function (x) { return x.gap_days > GAP; });
      return '<div class="v2-mfilter">' + seg('o', [['전체', '전체'], ['국산', '국산'], ['수입', '수입']], V.o) +
        seg('range', [['3m', '최근 3개월'], ['all', '전체 기간']], V.range) +
        '<span class="v2-help" style="margin:0">기준 ' + md(lastDate()) + ' 목록 · 기준기간(=100) ' + md(MI.base_period[0]) + '~' + md(MI.base_period[1]) +
        (gaps.length ? ' · 공백 ' + gaps.map(function (x) { return md(c[c.indexOf(x) - 1].date) + '→' + md(x.date) + '(' + x.gap_days + '일)'; }).join(', ') : '') + '</span></div>';
    }

    function spark(pts) {                                     // 시세지수 추이(작은 선) — 실제 날짜 간격, 공백은 끊는다
      var p = pts.filter(function (x) { return x['시세'] != null && inRange(x); });
      if (p.length < 2) return '';
      var W = 96, H = 26, a = day(p[0].date), z = day(p[p.length - 1].date) || a + 1;
      var lo = Math.min.apply(null, p.map(function (x) { return x['시세']; })), hi = Math.max.apply(null, p.map(function (x) { return x['시세']; }));
      if (hi - lo < 2) { lo -= 1; hi += 1; }
      var X = function (d) { return 3 + (day(d) - a) / ((z - a) || 1) * (W - 6); }, Y = function (v) { return 3 + (hi - v) / (hi - lo) * (H - 6); };
      var h = '<svg class="v2-spark" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">', seg = [];
      p.forEach(function (x, i) {
        if (i && day(x.date) - day(p[i - 1].date) > IRREG[1]) {                      // 긴 공백은 옅은 선으로만 잇는다
          if (seg.length > 1) h += '<polyline points="' + seg.join(' ') + '"/>';
          h += '<line class="gap" x1="' + X(p[i - 1].date).toFixed(1) + '" y1="' + Y(p[i - 1]['시세']).toFixed(1) + '" x2="' + X(x.date).toFixed(1) + '" y2="' + Y(x['시세']).toFixed(1) + '"/>';
          seg = [];
        }
        seg.push(X(x.date).toFixed(1) + ',' + Y(x['시세']).toFixed(1));
      });
      if (seg.length > 1) h += '<polyline points="' + seg.join(' ') + '"/>';
      var e = p[p.length - 1];
      return h + '<circle cx="' + X(e.date).toFixed(1) + '" cy="' + Y(e['시세']).toFixed(1) + '" r="2.5"/></svg>';
    }

    function cell(pts, f) {
      var i = last(pts, f);
      if (i < 0) return '<td class="num v2-dim">–</td>';
      var p = pts[i], j = prevOf(pts, f, i), latest = p.date === lastDate();
      var tip = (latest ? '' : '마지막 값 ' + p.date + ' · ') + (j >= 0 ? pts[j].date + ' 대비' : '');
      var lab = f === '시황' && p.label ? ' <span class="v2-mlab ' + (p.label === '강세' ? 'up' : p.label === '약세' ? 'down' : '') + '">' + esc(p.label) + '</span>' : '';
      var fix = f === '재고' && p.stock_fix;      // 전남광주가 빠진 회차: 실측 누락 대수를 더한 값
      if (fix) tip += (tip ? ' · ' : '') + '전남광주 누락분 ' + p.stock_fix.toLocaleString('ko-KR') + '대를 더한 값';
      return '<td class="num' + (latest ? '' : ' v2-dim') + '" title="' + esc(tip) + '"><b>' + f1(p[f]) + '</b>' + lab + (fix ? '<small>보정</small>' : '') + (latest ? '' : '<small>' + md(p.date) + '</small>') +
        '<small>' + (j >= 0 ? delta(p[f], pts[j][f], 1) : '') + '</small></td>';
    }

    function board() {
      var rows = [['전체', '전체'], ['국산', '전체'], ['수입', '전체']].concat(SEGS.filter(function (s) { return MI.series[V.o + '|' + s]; }).map(function (s) { return [V.o, s]; }));
      var h = '<div class="card"><div class="card-title">시황판 <span class="hint">행을 누르면 아래 숫자·추이·사분면·차종 비교가 그 구분으로 바뀝니다 · ▲▼는 직전 값 대비</span></div>' +
        '<div class="v2-tablewrap"><table class="t v2-tbl v2-board"><thead><tr><th>구분</th>' + IDX.map(function (x) { return '<th class="num">' + x[1] + '</th>'; }).join('') +
        '<th>시세 추이</th></tr></thead><tbody>';
      rows.forEach(function (r) {
        var k = r[0] + '|' + r[1], pts = series(k), on = r[0] === V.o && r[1] === V.s, li = pts.length ? pts[pts.length - 1] : null;
        var name = r[1] === '전체' ? r[0] : '└ ' + r[1];
        h += '<tr class="v2-mrow' + (on ? ' on' : '') + (r[1] !== '전체' ? ' sub' : '') + '" data-key="' + esc(k) + '" tabindex="0" aria-selected="' + on + '"><td>' + esc(name) +
          (li && li.low_sample ? ' <span class="v2-mtag">표본 적음</span>' : '') + '</td>' + IDX.map(function (x) { return cell(pts, x[0]); }).join('') +
          '<td>' + spark(pts) + '</td></tr>';
      });
      h += '</tbody></table></div><p class="v2-help">' + esc(MI.definitions['시황']) + '. 판매속도는 수집 간격이 5~16일인 구간만 계산합니다' +
        (series('전체|전체').some(function (p) { return p.date === lastDate() && p['판매속도'] != null; }) ? '' : ' — 지금은 공백 뒤 첫 회차라 판매속도·시황이 없고, 다음 주간 수집부터 나옵니다') +
        '. 흐린 값은 그 지수의 마지막 값(날짜 표시)입니다.' +
        (series('전체|전체').some(function (p) { return p.stock_fix; }) ? ' 재고의 "보정"은 엔카가 광주·전남 매물을 "전남광주"로 바꿔 목록에서 빠졌던 회차(7/29~)에 실측 누락 대수를 더한 값입니다.' : '') +
        '</p></div>';
      return h;
    }

    // ───── 핵심 숫자 ─────
    function tiles() {
      var pts = series(), i = pts.length - 1, p = pts[i], q = pts[i - 1] || null;
      if (!p) return '';
      var irr = p.days && (p.days < IRREG[0] || p.days > IRREG[1]);
      var span = p.days ? md(q.date) + '→' + md(p.date) + ' ' + p.days + '일' : '';
      var t = function (label, v, unit, sub, d) {
        return '<div class="card"><div class="eyebrow">' + esc(label) + '</div><div class="v2-big v2-mid" style="margin-top:10px">' + esc(v) +
          (unit ? '<small>' + esc(unit) + '</small>' : '') + '</div><div class="v2-kv">' + (d ? '<b>' + esc(d) + '</b> ' : '') + esc(sub) + '</div></div>';
      };
      var sub = irr ? span + ' 평균 — ' + (p.days > IRREG[1] ? '공백이 길어 그사이 들어왔다 팔린 매물이 빠져 낮게 나옴' : '구간이 짧아 7일로 늘린 값') : span + ' · 7일 기준';
      // 유입·판매·호가는 구간 값이라 간격이 5~16일이고 목록 누락 의심이 없는 직전 구간과만 비교 (83일 공백 평균과 비교하면 증감이 부풀어 보임).
      // 전남광주가 빠진 회차(jn_gap: 판매중·유입, jn_gap_sold: 판매)는 낮게 잡혀 기준으로 쓰지 않고, 그 회차 자체는 증감 대신 안내를 붙인다
      var ref = function (bad) {                                       // 유입·호가는 jn_gap, 판매는 jn_gap_sold 회차를 건너뛴다
        if (irr) return null;
        for (var j = i - 1; j >= 0; j--) {
          var x = pts[j];
          if (x.new_w != null && x.days >= IRREG[0] && x.days <= IRREG[1] && !x.sold_suspect && !x[bad]) return x;
        }
        return null;
      };
      var r = ref('jn_gap'), rs = ref('jn_gap_sold');
      var vsOf = function (x) { return x && x !== q ? ' · ' + md(x.date) + ' 구간 대비' : ''; }, vs = vsOf(r);
      var JN = ' · 전남광주 매물이 빠져 실제보다 낮게 잡힘';
      var onq = q && q.on != null && !p.jn_gap === !q.jn_gap;          // 전남광주가 빠진 회차와 다시 잡힌 회차는 판매중 재고를 비교하지 않음
      return '<div class="v2-cards v2-bcards">' +
        t('판매중 재고', (p.on || 0).toLocaleString('ko-KR'), '대', (onq ? md(q.date) + ' 대비 · ' : q ? md(q.date) + '은 전남광주가 빠진 회차라 비교 안 함 · ' : '') + '상세 확인 매물' + (p.jn_gap ? JN : ''),
          onq ? delta(p.on, q.on, 0, '대') : '') +
        t('주간 신규 유입', p.new_w != null ? p.new_w.toLocaleString('ko-KR') : '–', p.new_w != null ? '대' : '', p.new_w != null ? sub + (p.jn_gap ? JN : vs) : '첫 수집',
          r && p.new_w != null && !p.jn_gap ? delta(p.new_w, r.new_w, 0, '대') : '') +
        t('주간 판매(추정)', p.sold_w != null ? p.sold_w.toLocaleString('ko-KR') : '–', p.sold_w != null ? '대' : '',
          p.sold_w != null ? sub + (p.jn_gap_sold ? ' · 시작 목록에 전남광주 매물이 빠져 실제보다 낮게 잡힘' : vsOf(rs)) + (p.sold_suspect ? ' · 목록 누락으로 부풀었을 수 있음' : '') : '첫 수집',
          rs && p.sold_w != null && !p.jn_gap_sold ? delta(p.sold_w, rs.sold_w, 0, '대') : '') +
        t('신규 매물 중앙 호가', p.new_med != null ? man(p.new_med) : '–', p.new_med != null ? '만원' : '', '그 구간에 새로 등록된 매물의 첫 호가(구성에 따라 움직임)' + vs,
          r && r.new_med != null && p.new_med != null ? delta(p.new_med, r.new_med, 0, '만') : '') + '</div>';
    }

    // ───── 트렌드: 지수 · 흐름(재고 / 유입·판매) ─────
    var CH = {}, CW = 720;                                    // 그린 차트의 좌표(크로스헤어용) · 차트 폭 = 화면 폭(글자가 작아지지 않게)
    function frame(id, pts, W, H, L, R, T, B) {
      var a = day(pts[0].date), z = day(pts[pts.length - 1].date);
      if (z - a < 7) { a -= 3; z += 3; }
      var pad = (z - a) * 0.03;
      a -= pad; z += pad;
      var c = { id: id, pts: pts, W: W, H: H, L: L, R: R, T: T, B: B, a: a, z: z };
      c.x = function (d) { return L + (day(d) - a) / (z - a) * (W - L - R); };
      CH[id] = c;
      return c;
    }
    function gapBands(c) {                                    // 10일 넘는 공백 음영
      var h = '';
      c.pts.forEach(function (p, i) {
        if (!i) return;
        var g = day(p.date) - day(c.pts[i - 1].date);
        if (g <= GAP) return;
        var x0 = c.x(c.pts[i - 1].date) + 8, x1 = c.x(p.date) - 8;
        if (x1 - x0 < 10) return;
        h += '<rect x="' + x0.toFixed(1) + '" y="' + c.T + '" width="' + (x1 - x0).toFixed(1) + '" height="' + (c.H - c.T - c.B) + '" fill="var(--bg-2)"/>' +
          '<text x="' + ((x0 + x1) / 2).toFixed(1) + '" y="' + (c.T + 14) + '" text-anchor="middle">' + g + '일 공백</text>';
      });
      return h;
    }
    function xAxis(c) {
      var h = '<line x1="' + c.L + '" x2="' + (c.W - c.R) + '" y1="' + (c.H - c.B) + '" y2="' + (c.H - c.B) + '" stroke="var(--line-hard)" stroke-width="1"/>', used = [];
      c.pts.forEach(function (p) {
        var x = c.x(p.date);
        if (used.some(function (u) { return Math.abs(u - x) < 34; })) return;
        used.push(x);
        h += '<text x="' + x.toFixed(1) + '" y="' + (c.H - c.B + 16) + '" text-anchor="middle">' + md(p.date) + '</text>';
      });
      return h;
    }
    function overlay(c) {
      return '<line class="v2-xhair" id="xh-' + c.id + '" x1="0" x2="0" y1="' + c.T + '" y2="' + (c.H - c.B) + '" visibility="hidden"/>' +
        '<rect class="v2-hit" data-chart="' + c.id + '" x="' + c.L + '" y="' + c.T + '" width="' + (c.W - c.L - c.R) + '" height="' + (c.H - c.T - c.B) + '" fill="transparent"/>';
    }

    function indexChart(pts) {
      var c = frame('idx', pts, CW, 250, 40, 76, 16, 28), vals = [100];
      IDX.forEach(function (x) { pts.forEach(function (p) { if (p[x[0]] != null) vals.push(p[x[0]]); }); });
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), sp = Math.max(hi - lo, 6);
      lo -= sp * 0.08; hi += sp * 0.08;
      c.y = function (v) { return c.T + (hi - v) / (hi - lo) * (c.H - c.T - c.B); };
      var h = '<svg class="v2-chart" viewBox="0 0 ' + c.W + ' ' + c.H + '" role="img" aria-label="시황·시세·판매속도·재고 지수 추이" tabindex="0" data-kchart="idx">' + gapBands(c);
      niceTicks(lo, hi, 5).forEach(function (t) {
        h += '<line x1="' + c.L + '" x2="' + (c.W - c.R) + '" y1="' + c.y(t).toFixed(1) + '" y2="' + c.y(t).toFixed(1) + '" stroke="' + (t === 100 ? 'var(--line-hard)' : 'var(--line)') + '" stroke-width="1"/>' +
          '<text x="' + (c.L - 6) + '" y="' + (c.y(t) + 4).toFixed(1) + '" text-anchor="end">' + t + '</text>';
      });
      h += xAxis(c);
      var ends = [];
      IDX.forEach(function (x) {
        var f = x[0], seg = [], prev = null;
        var flush = function () { if (seg.length > 1) h += '<polyline fill="none" stroke="' + x[2] + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="' + seg.join(' ') + '"/>'; seg = []; };
        pts.forEach(function (p) {
          if (p[f] == null) { flush(); prev = null; return; }
          if (prev && day(p.date) - day(prev.date) > IRREG[1]) flush();       // 긴 공백은 잇지 않는다
          seg.push(c.x(p.date).toFixed(1) + ',' + c.y(p[f]).toFixed(1));
          prev = p;
        });
        flush();
        pts.forEach(function (p) {
          if (p[f] != null) h += '<circle cx="' + c.x(p.date).toFixed(1) + '" cy="' + c.y(p[f]).toFixed(1) + '" r="4" fill="' + x[2] + '" stroke="var(--bg-1)" stroke-width="2"/>';
        });
        var li = last(pts, f);
        if (li >= 0 && pts[li].date === pts[pts.length - 1].date) ends.push({ y: c.y(pts[li][f]), t: x[1].replace('지수', '') + ' ' + f1(pts[li][f]), x: c.x(pts[li].date) });
      });
      ends.sort(function (p, q) { return p.y - q.y; }).forEach(function (e, i, all) {   // 끝 라벨 — 겹치면 생략(범례·안내가 있음)
        if (i && e.y - all[i - 1].y < 13) return;
        h += '<text class="lbl" x="' + (e.x + 9).toFixed(1) + '" y="' + (e.y + 4).toFixed(1) + '">' + esc(e.t) + '</text>';
      });
      return h + overlay(c) + '</svg>';
    }

    function stockChart(pts) {
      var c = frame('stk', pts, CW, 150, 52, 76, 12, 26), p = pts.filter(function (x) { return x.on != null; });
      var vals = p.map(function (x) { return x.on; }), lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), sp = Math.max(hi - lo, hi * 0.05);
      lo = Math.max(0, lo - sp * 0.15); hi += sp * 0.15;
      c.y = function (v) { return c.T + (hi - v) / (hi - lo) * (c.H - c.T - c.B); };
      var h = '<svg class="v2-chart" viewBox="0 0 ' + c.W + ' ' + c.H + '" role="img" aria-label="판매중 재고 추이" tabindex="0" data-kchart="stk">' + gapBands(c);
      niceTicks(lo, hi, 4).forEach(function (t) {
        h += '<line x1="' + c.L + '" x2="' + (c.W - c.R) + '" y1="' + c.y(t).toFixed(1) + '" y2="' + c.y(t).toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>' +
          '<text x="' + (c.L - 6) + '" y="' + (c.y(t) + 4).toFixed(1) + '" text-anchor="end">' + compact(t) + '</text>';
      });
      h += xAxis(c);
      var seg = [];
      p.forEach(function (x, i) {
        if (i && day(x.date) - day(p[i - 1].date) > IRREG[1]) { if (seg.length > 1) h += '<polyline fill="none" stroke="var(--s-stock)" stroke-width="2" stroke-linejoin="round" points="' + seg.join(' ') + '"/>'; seg = []; }
        seg.push(c.x(x.date).toFixed(1) + ',' + c.y(x.on).toFixed(1));
      });
      if (seg.length > 1) h += '<polyline fill="none" stroke="var(--s-stock)" stroke-width="2" stroke-linejoin="round" points="' + seg.join(' ') + '"/>';
      p.forEach(function (x) { h += '<circle cx="' + c.x(x.date).toFixed(1) + '" cy="' + c.y(x.on).toFixed(1) + '" r="4" fill="var(--s-stock)" stroke="var(--bg-1)" stroke-width="2"/>'; });
      var e = p[p.length - 1];
      if (e) h += '<text class="lbl" x="' + (c.x(e.date) + 9).toFixed(1) + '" y="' + (c.y(e.on) + 4).toFixed(1) + '">' + e.on.toLocaleString('ko-KR') + '</text>';
      return h + overlay(c) + '</svg>';
    }

    function flowChart(pts) {
      var c = frame('flw', pts, CW, 170, 52, 76, 12, 26), p = pts.filter(function (x) { return x.new_w != null; });
      var hi = Math.max.apply(null, [1].concat(p.map(function (x) { return Math.max(x.new_w, x.sold_w); }))) * 1.12;
      c.y = function (v) { return c.T + (hi - v) / hi * (c.H - c.T - c.B); };
      var h = '<svg class="v2-chart" viewBox="0 0 ' + c.W + ' ' + c.H + '" role="img" aria-label="주간 신규 유입과 판매 추이" tabindex="0" data-kchart="flw">' + gapBands(c);
      niceTicks(0, hi, 4).forEach(function (t) {
        h += '<line x1="' + c.L + '" x2="' + (c.W - c.R) + '" y1="' + c.y(t).toFixed(1) + '" y2="' + c.y(t).toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>' +
          '<text x="' + (c.L - 6) + '" y="' + (c.y(t) + 4).toFixed(1) + '" text-anchor="end">' + compact(t) + '</text>';
      });
      h += xAxis(c);
      var gap = Infinity, base = c.y(0);                      // 막대 폭: 가까운 두 회차 사이에 두 막대가 겹치지 않게(최대 10px)
      p.forEach(function (x, i) { if (i) gap = Math.min(gap, c.x(x.date) - c.x(p[i - 1].date)); });
      var bw = Math.max(2, Math.min(10, gap / 2 - 2));
      var bar = function (x, v, color, faded) {                // 위쪽만 4px 둥글게, 바닥은 각지게
        var y = c.y(v), hgt = Math.max(base - y, 0), r = Math.min(4, hgt, bw / 2), n = function (z) { return z.toFixed(1); };
        return '<path d="M' + n(x) + ',' + n(base) + 'V' + n(y + r) + 'Q' + n(x) + ',' + n(y) + ' ' + n(x + r) + ',' + n(y) + 'H' + n(x + bw - r) +
          'Q' + n(x + bw) + ',' + n(y) + ' ' + n(x + bw) + ',' + n(y + r) + 'V' + n(base) + 'Z" fill="' + color + '"' + (faded ? ' opacity="0.4"' : '') + '/>';
      };
      p.forEach(function (x) {
        var cx = c.x(x.date), irr = x.days < IRREG[0] || x.days > IRREG[1];
        h += bar(cx - bw - 1, x.new_w, 'var(--s-new)', irr) + bar(cx + 1, x.sold_w, 'var(--s-sold)', irr);   // 두 막대 사이 2px 틈
      });
      return h + overlay(c) + '</svg>';
    }

    function trend() {
      var pts = series().filter(inRange), k = key();
      var h = '<div class="card"><div class="card-title">추이 — ' + esc(k.replace('|', ' ').replace(' 전체', '').replace('전체 ', '')) +
        ' <span class="hint">지수는 기준기간 = 100 · 회색 띠는 10일 넘는 수집 공백</span></div>';
      if (pts.length < 2) return h + '<p class="v2-kv">이 기간에 수집 회차가 2회 미만입니다. 전체 기간을 고르세요.</p></div>';
      h += '<div class="v2-legend">' + IDX.map(function (x) {
        return '<span><i class="v2-lkey" style="background:' + x[2] + '"></i>' + x[1] + '</span>';
      }).join('') + '</div>' + indexChart(pts);
      h += '<div class="v2-subchart"><div class="v2-sub">판매중 재고 <span class="v2-dim">(상세 확인 매물, 대)</span></div>' + stockChart(pts) + '</div>';
      h += '<div class="v2-subchart"><div class="v2-sub">주간 신규 유입 · 판매(추정) <span class="v2-dim">(구간 값을 7일 기준으로 맞춤, 대)</span></div>' +
        '<div class="v2-legend"><span><i style="background:var(--s-new);border-radius:2px"></i>신규 유입</span><span><i style="background:var(--s-sold);border-radius:2px"></i>판매(추정)</span>' +
        '<span><i style="background:var(--tx-4);opacity:.4;border-radius:2px"></i>구간이 5~16일이 아닌 값(비교 주의)</span></div>' + flowChart(pts) + '</div>';
      h += '<div class="v2-actions"><button type="button" class="v2-btn" data-m="table">' + (V.table ? '표 닫기' : '표로 보기') + '</button></div>';
      if (V.table) h += dataTable(pts);
      return h + '<p class="v2-help">판매중 재고 = 상세 화면까지 확인한 판매중 매물 · 신규 유입 = 직전 수집 뒤 엔카에 새로 올라온 매물 · ' +
        '판매(추정) = 그 사이 목록에서 사라진 매물(다시 올린 것은 뺌) · /주 = 7일 기준으로 맞춘 값 · 신규 중앙 호가 = 새로 올라온 매물(30대 이상)의 첫 호가 가운데 값. ' +
        '재고지수는 목록 기준이라 위의 판매중 재고(상세 확인 기준)와 다릅니다. 내려받은 CSV의 열 이름 설명은 데이터 탭에 있습니다.</p></div>';
    }

    function dataTable(pts) {
      var h = '<div class="v2-tablewrap"><table class="t v2-tbl"><thead><tr><th>목록 관측일</th>' + IDX.map(function (x) { return '<th class="num">' + x[0] + '</th>'; }).join('') +
        '<th class="num">판매중 재고</th><th class="num">구간(일)</th><th class="num">신규 유입/주</th><th class="num">판매/주</th><th class="num">신규 중앙 호가</th><th>메모</th></tr></thead><tbody>';
      pts.forEach(function (p) {
        var cr = MI.crawls.find(function (x) { return x.date === p.date; });
        h += '<tr><td>' + p.date + '</td>' + IDX.map(function (x) { return '<td class="num">' + f1(p[x[0]]) + '</td>'; }).join('') +
          '<td class="num">' + (p.on != null ? p.on.toLocaleString('ko-KR') : '–') + '</td><td class="num">' + (p.days || '–') + '</td>' +
          '<td class="num">' + (p.new_w != null ? p.new_w.toLocaleString('ko-KR') : '–') + '</td><td class="num">' + (p.sold_w != null ? p.sold_w.toLocaleString('ko-KR') : '–') + '</td>' +
          '<td class="num">' + (p.new_med != null ? man(p.new_med) : '–') + '</td><td class="v2-dim">' + esc(cr ? cr.note : '') + '</td></tr>';
      });
      return h + '</tbody></table></div>';
    }

    function tipFor(id, i) {                                   // 크로스헤어 안내: 그 날짜의 모든 값(값이 먼저)
      var c = CH[id], p = c.pts[i], cr = MI.crawls.find(function (x) { return x.date === p.date; }), rows = [];
      var row = function (color, v, label) { return '<div class="v2-trow"><i style="background:' + color + '"></i><b>' + v + '</b> ' + esc(label) + '</div>'; };
      if (id === 'idx') IDX.forEach(function (x) { rows.push(row(x[2], f1(p[x[0]]), x[1] + (x[0] === '시황' && p.label ? ' · ' + p.label : ''))); });
      if (id === 'stk') rows.push(row('var(--s-stock)', p.on != null ? p.on.toLocaleString('ko-KR') + '대' : '–', '판매중 재고'));
      if (id === 'flw') {
        rows.push(row('var(--s-new)', p.new_w != null ? p.new_w.toLocaleString('ko-KR') + '대' : '–', '신규 유입/주'));
        rows.push(row('var(--s-sold)', p.sold_w != null ? p.sold_w.toLocaleString('ko-KR') + '대' : '–', '판매/주' + (p.sold_suspect ? ' (부풀었을 수 있음)' : '')));
        if (p.days) rows.push('<div class="v2-tnote">구간 ' + p.days + '일' + (p.days < IRREG[0] || p.days > IRREG[1] ? ' — 비교 주의' : '') + '</div>');
      }
      return '<div class="v2-tdate">' + p.date + '</div>' + rows.join('') + (cr && cr.note ? '<div class="v2-tnote">' + esc(cr.note) + '</div>' : '');
    }
    function showTip(id, i, cx, cy) {
      var c = CH[id], tip = $('tip'), xh = $('xh-' + id);
      if (!c || !tip) return;
      var x = c.x(c.pts[i].date);
      if (xh) { xh.setAttribute('x1', x); xh.setAttribute('x2', x); xh.setAttribute('visibility', 'visible'); }
      tip.innerHTML = tipFor(id, i);
      tip.hidden = false;
      tip.style.left = Math.min(cx + 14, window.innerWidth - tip.offsetWidth - 8) + 'px';
      tip.style.top = (cy + 14) + 'px';
      c.cur = i;
    }
    function hideTip() {
      var tip = $('tip'), hl = $('qHl');
      if (tip) tip.hidden = true;
      if (hl) hl.setAttribute('visibility', 'hidden');                            // 사분면 점 강조
      Object.keys(CH).forEach(function (id) { var xh = $('xh-' + id); if (xh) xh.setAttribute('visibility', 'hidden'); });
    }
    function nearest(id, evt, svg) {
      var c = CH[id], r = svg.getBoundingClientRect(), x = (evt.clientX - r.left) / r.width * c.W, best = 0, bd = 1e9;
      c.pts.forEach(function (p, i) { var d = Math.abs(c.x(p.date) - x); if (d < bd) { bd = d; best = i; } });
      return best;
    }

    // ───── 차종 사분면(5.5.3): 세로 = 주간 판매율, 가로 = 잔존가치 지수 | 시세 1주 변화 ─────
    var QP = null, lastPT = '';                               // 그린 점(말풍선·키보드) · 마지막 누름 방식(터치는 첫 누름에 말풍선, 한 번 더 누르면 이동)
    function qAxis() { return V.qx === 'trend' || rvErr ? 'trend' : 'rv'; }   // 잔존가치 파일을 못 불러오면 추세 축만
    function quad() { return '<div class="card v2-quad" id="mQuad">' + quadInner() + '</div>'; }
    function refreshQuad() { var q = $('mQuad'); if (q) { hideTip(); q.innerHTML = quadInner(); } }
    function scopeName() { return [V.o, V.s].filter(function (x) { return x !== '전체'; }).join(' '); }
    function onMax() {                                        // 점 크기 기준(필터와 상관없이 같은 비율) = 사분면 대상 중 판매중 최대
      if (!ONMAX) MM.models.forEach(function (m) { if (m.on >= QMIN && m.rate_w != null && m.on > ONMAX) ONMAX = m.on; });
      return ONMAX || QMIN;
    }
    function textW(s, fs) {                                   // 글자 폭 어림(이름표 겹침 검사) — 한글은 글자 크기, 영문·숫자는 0.6배
      var w = 0;
      for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); w += c >= 0x1100 ? fs : c === 32 ? fs * 0.3 : fs * 0.6; }
      return w;
    }
    function rvWhy(m) {                                       // 잔존가치 지수가 없는 까닭
      var r = rvRec(m);
      return rvErr ? '잔존가치 지수 파일을 불러오지 못함' : !RV ? '불러오는 중' : !r ? '시세 산정·모델 리포트 대상이 아니라 계산 안 함'
        : r.rvn < 20 ? '잔존율을 계산한 판매중 매물이 ' + r.rvn + '대라(20대 미만) 계산 안 함' : '같은 차급·연차의 기준 잔존율이 없어 계산 안 함';
    }
    function mLink(m, label) {                                // 세부모델 → 모델 리포트(시세 산정 대상이 아니면 리포트가 없어 이름만)
      return HAVE[mkey(m)] ? '<a class="v2-link" href="' + esc(ctx.reportHref(m.maker, m.group, m.model)) + '">' + label + '</a>'
        : '<span title="성능점검 있는 비교 매물이 적어 시세 산정·모델 리포트 대상이 아님">' + label + '</span>';
    }
    function quadPts(ax) {                                    // 판매중 100대 이상 · 주간 판매율 있음 · 위쪽 국산·수입·차급 선택 → 가로축 값이 있는 것만 점으로
      var all = MM.models.filter(function (m) {
        return m.on >= QMIN && m.rate_w != null && (V.o === '전체' || m.origin === V.o) && (V.s === '전체' || m.seg === V.s);
      }), pts = [];
      all.forEach(function (m) {
        var w = wk(m), rv = rviOf(m), x = ax === 'rv' ? rv : w ? w.d : null;
        if (x != null) pts.push({ m: m, w: w, rv: rv, x: x, y: m.rate_w * 100, faded: ax === 'trend' && !w.sig });
      });
      return { all: all, pts: pts };
    }
    function qRange(vals, base, minHalf, sym) {               // 가로축 범위: 점 20개 이상이면 2~98% 안 + 기준선 — 넘는 점은 가장자리에 붙인다
      var s = vals.slice().sort(function (a, b) { return a - b; }), n = s.length, cut = n >= 20;
      var lo = Math.min(cut ? s[Math.floor((n - 1) * 0.02)] : s[0], base - minHalf), hi = Math.max(cut ? s[Math.ceil((n - 1) * 0.98)] : s[n - 1], base + minHalf);
      if (sym) { var e = Math.max(base - lo, hi - base); lo = base - e; hi = base + e; }   // 추세 축은 0 을 가운데로(오름·내림 같은 폭)
      var pad = (hi - lo) * 0.06;
      return { lo: lo, hi: hi, a: lo - pad, z: hi + pad };
    }
    function quadGuide(ax) {                                  // 제목 옆 ? 설명
      return ax === 'rv'
        ? '점 하나가 세부모델 하나입니다. 가로 = 잔존가치 지수(같은 연식의 동급 차보다 값을 잘 지키면 100보다 큼), 세로 = 주간 판매율(한 주에 판매중 매물 중 팔린 비율). ' +
          '기준선은 동급 100과 보이는 모델의 판매율 가운데 값입니다. 오른쪽 위 핵심 자산은 값도 지키고 빨리 팔리고, 왼쪽 아래 주의는 둘 다 약합니다.'
        : '점 하나가 세부모델 하나입니다. 가로 = 시세 1주 변화(새로 올라온 매물의 세부모델 시세지수 차이), 세로 = 주간 판매율. ' +
          '신규 매물이 적어 흔들림이 큰 변화는 흐리게 그립니다. 오른쪽 위는 값이 오르며 빨리 팔리고, 왼쪽 아래는 값이 내리며 느리게 팔립니다.';
    }
    function quadInner() {
      var ax = qAxis(), h = '<div class="v2-tools"><div class="card-title">차종 사분면' +
        '<span class="v2-q" tabindex="0" role="note" aria-label="사분면 읽는 법" data-tip="' + esc(quadGuide(ax)) + '">?</span>' +
        ' <span class="hint">판매중 ' + QMIN + '대 이상 세부모델 · 점을 누르면 모델 리포트</span></div>' +
        '<div class="segmented" role="group" aria-label="사분면 가로축">' + ['rv', 'trend'].map(function (k) {
          var off = k === 'rv' && rvErr;
          return '<button type="button" data-m="qx" data-v="' + k + '" class="' + (ax === k ? 'on' : '') + '" aria-pressed="' + (ax === k) + '"' +
            (off ? ' disabled title="잔존가치 지수 파일을 불러오지 못했습니다"' : '') + '>' + QX[k] + '</button>';
        }).join('') + '</div></div>';
      QP = null;
      if (mmErr) return h + '<p class="v2-kv v2-bad">차종 비교 파일을 불러오지 못해 사분면을 그리지 않습니다.</p>';
      if (!MM || (ax === 'rv' && !RV)) return h + '<p class="v2-kv"><span class="spinner v2-spin"></span>불러오는 중…</p>';
      var P = quadPts(ax), sc = scopeName(), n0 = P.all.length, n = P.pts.length;
      if (n < 3) {                                            // 점이 너무 적으면 숨기지 말고 까닭을 한 줄로
        var why = !n0 && !MM.speed_interval ? '주간 판매율이 아직 없어(수집 간격이 5~16일인 구간이 생기면 계산)'
          : !n0 ? (sc ? sc + '에는 ' : '') + '판매중 ' + QMIN + '대 이상이면서 주간 판매율이 있는 세부모델이 없어'
          : ax === 'trend' && !wkDates() ? '직전 목록이 없어 시세 1주 변화를 낼 수 없어'
          : n0 < 3 ? (sc ? sc + ' ' : '') + '판매중 ' + QMIN + '대 이상이면서 주간 판매율이 있는 세부모델이 ' + n0 + '개뿐' +   // 모델 수 자체가 적음 — 값이 빠진 것과 나눠 쓴다
            (n < n0 ? '이고(3개 미만) 그중 ' + QX[ax] + '가 있는 것은 ' + n + '개라' : '이라(3개 미만)')
          : (sc ? sc + ' ' : '') + '판매중 ' + QMIN + '대 이상 세부모델 ' + n0 + '개 중 ' + QX[ax] + '가 있는 것이 ' + n + '개뿐이라';
        return h + '<p class="v2-kv">' + esc(why) + ' 사분면을 그리지 않습니다. 아래 차종 비교 표에서 보세요.</p>' +
          (rvErr ? '<p class="v2-help">잔존가치 지수 파일을 불러오지 못해 가치 축은 껐습니다.</p>' : '');
      }
      var svg = quadSvg(ax, P.pts);                           // 먼저 그려야 범례가 '축 범위 밖' 점 수를 안다
      return h + quadLegend(ax, P) + svg + quadSum(ax, P) + quadHelp(ax, P);
    }

    function quadSvg(ax, pts) {
      var W = CW, H = Math.round(Math.max(300, Math.min(460, W * 0.56))), L = 44, R = 14, T = 24, B = 44, wide = W >= 600, w = wkDates();
      var bx = ax === 'rv' ? 100 : 0, ys = pts.map(function (p) { return p.y; }), by = med(ys);
      var xr = qRange(pts.map(function (p) { return p.x; }), bx, ax === 'rv' ? 10 : 1.5, ax === 'trend');
      var ylo = Math.min.apply(null, ys), yhi = Math.max.apply(null, ys), ysp = Math.max(yhi - ylo, 4);
      ylo = Math.max(0, ylo - ysp * 0.1); yhi += ysp * 0.1;
      var X = function (v) { return L + (v - xr.a) / (xr.z - xr.a) * (W - L - R); }, Y = function (v) { return T + (yhi - v) / (yhi - ylo) * (H - T - B); };
      var x0 = X(bx), y0 = Y(by), rmax = wide ? 15 : 11, top = onMax(), n = function (v) { return v.toFixed(1); };
      var tl = function (v) { return ax === 'trend' && v ? (v > 0 ? '+' : '−') + Math.abs(v) : String(v); };
      pts.forEach(function (p) {
        p.cl = p.x < xr.lo ? -1 : p.x > xr.hi ? 1 : 0;                            // 축 범위 밖 → 가장자리(말풍선에 실제 값)
        p.px = X(p.cl < 0 ? xr.lo - (xr.lo - xr.a) * 0.6 : p.cl > 0 ? xr.hi + (xr.z - xr.hi) * 0.6 : p.x);
        p.py = Y(p.y);
        p.r = Math.max(4, rmax * Math.sqrt(p.m.on / top));                       // 점 크기 ∝ √판매중(반지름 4 이상)
      });
      var h = '<svg class="v2-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" tabindex="0" data-kchart="quad" aria-label="' +
        esc('차종 사분면 — 가로 ' + QX[ax] + ', 세로 주간 판매율, 세부모델 ' + pts.length + '개. ←→로 점을 옮기고 Enter로 모델 리포트') + '">';
      h += '<rect x="' + n(x0) + '" y="' + T + '" width="' + n(Math.max(0, W - R - x0)) + '" height="' + n(Math.max(0, y0 - T)) + '" fill="var(--up-wash)" opacity="0.55"/>' +   // 우상·좌하 칸만 옅게
        '<rect x="' + L + '" y="' + n(y0) + '" width="' + n(Math.max(0, x0 - L)) + '" height="' + n(Math.max(0, H - B - y0)) + '" fill="var(--down-wash)" opacity="0.55"/>';
      niceTicks(ylo, yhi, 5).forEach(function (t) {
        var y = Y(t);
        h += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + n(y) + '" y2="' + n(y) + '" stroke="var(--line)" stroke-width="1"/>' +
          (Math.abs(y - y0) > 16 ? '<text x="' + (L - 6) + '" y="' + n(y + 4) + '" text-anchor="end">' + (+t.toFixed(1)) + '%</text>' : '');   // 글자 상자 높이 14px + 틈 2px — 기준선 글자와 붙으면 눈금 글자를 뺀다
      });
      niceTicks(xr.lo, xr.hi, wide ? 7 : 4).forEach(function (t) {
        var x = X(t);
        h += '<line x1="' + n(x) + '" x2="' + n(x) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--line)" stroke-width="1"/>' +
          (Math.abs(x - x0) > 18 ? '<text x="' + n(x) + '" y="' + (H - B + 16) + '" text-anchor="middle">' + tl(+t.toFixed(2)) + '</text>' : '');
      });
      h += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '" stroke="var(--line-hard)" stroke-width="1"/>' +
        '<line x1="' + n(x0) + '" x2="' + n(x0) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--line-hard)" stroke-width="1.5"/>' +
        '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + n(y0) + '" y2="' + n(y0) + '" stroke="var(--line-hard)" stroke-width="1.5"/>' +
        '<text class="v2-quad-base" x="' + (L - 6) + '" y="' + n(y0 + 4) + '" text-anchor="end">' + f1(by) + '%</text>' +
        '<text class="v2-quad-base" x="' + n(x0) + '" y="' + (H - B + 16) + '" text-anchor="middle">' + bx + '</text>' +
        '<text class="v2-quad-ax" x="4" y="' + (T - 10) + '">주간 판매율 ↑</text>' +
        '<text class="v2-quad-ax" x="' + (W - R) + '" y="' + (H - 8) + '" text-anchor="end">' +
        esc(ax === 'rv' ? '잔존가치 지수(동급 = 100) →' : '시세 1주 변화(' + md(w[0]) + '→' + md(w[1]) + ', 지수) →') + '</text>';
      var big = pts.slice().sort(function (a, b) { return b.m.on - a.m.on; });
      big.forEach(function (p) {                                                   // 큰 점 먼저 → 작은 점이 위에
        var c = p.m.origin === '수입' ? 'var(--accent)' : 'var(--info)';
        h += '<circle cx="' + n(p.px) + '" cy="' + n(p.py) + '" r="' + n(p.r) + '" fill="' + c + '" fill-opacity="' + (p.faded ? 0.22 : 0.72) +
          '" stroke="var(--bg-1)" stroke-width="1.5"' + (p.faded ? ' stroke-opacity="0.6"' : '') + '/>' +
          (p.cl ? '<circle cx="' + n(p.px) + '" cy="' + n(p.py) + '" r="' + n(p.r + 2.5) + '" fill="none" stroke="var(--tx-2)" stroke-width="1" stroke-dasharray="2 2"/>' : '');
      });
      var boxes = [];                                                              // 글자 자리(겹침 검사) [x0, y0, x1, y1]
      [[1, 0], [0, 0], [1, 1], [0, 1]].forEach(function (q, i) {                   // 네 칸 이름 — 칸 구석에(칸이 좁으면 생략, 아래 요약에 있음)
        var t = QNAME[ax][i], tw = textW(t, 12), qx0 = q[0] ? x0 : L, qx1 = q[0] ? W - R : x0, qy0 = q[1] ? y0 : T, qy1 = q[1] ? H - B : y0;
        if (qx1 - qx0 < tw + 12 || qy1 - qy0 < 22) return;
        var tx = q[0] ? qx1 - 6 : qx0 + 6, ty = q[1] ? qy1 - 7 : qy0 + 15;
        boxes.push(q[0] ? [tx - tw, ty - 12, tx, ty + 3] : [tx, ty - 12, tx + tw, ty + 3]);
        h += '<text class="v2-quad-ql v2-halo" x="' + n(tx) + '" y="' + n(ty) + '" text-anchor="' + (q[0] ? 'end' : 'start') + '">' + esc(t) + '</text>';
      });
      // 판매중 상위 이름표 — 오른쪽·왼쪽·위·아래 중 그림 안 · 다른 이름표·네 칸 이름·이름표 단 점과 안 겹치는 자리.
      // 다른 점을 전혀 안 건드리는 첫 자리, 없으면 가리는 점 중심(글자 테두리 2px + 글자 폭 어림 오차 2px)이 가장 적은 자리 — 그것도 QCOVER 개를 넘으면 생략(아래 네 칸 요약에 이름이 있음)
      var lab = big.slice(0, W >= 900 ? 10 : wide ? 8 : 5);
      var dotBox = function (p) { return [p.px - p.r, p.py - p.r, p.px + p.r, p.py + p.r, p]; };
      var dots = pts.map(dotBox), labDots = lab.map(dotBox);
      var hit = function (c, o) { return o[0] < c[2] && c[0] < o[2] && o[1] < c[3] && c[1] < o[3]; };
      var covers = function (c, p) {                                               // 이름표 c 가 가리는 다른 점 중심 수
        return pts.filter(function (o) { return o !== p && o.px > c[0] - 4 && o.px < c[2] + 4 && o.py > c[1] - 4 && o.py < c[3] + 4; }).length;
      };
      lab.forEach(function (p) {
        var t = p.m.model, tw = textW(t, 11), y = p.py + 4, g = p.r + 3;     // 후보 [x0, y0, x1, y1, 정렬, 글자 x, 글자 y]
        var cand = [[p.px + g, y - 11, p.px + g + tw, y + 3, 'start', p.px + g, y], [p.px - g - tw, y - 11, p.px - g, y + 3, 'end', p.px - g, y],   // 글자 상자 = 글자 기준선 −11 ~ +3
          [p.px - tw / 2, p.py - g - 14, p.px + tw / 2, p.py - g, 'middle', p.px, p.py - g - 3], [p.px - tw / 2, p.py + g, p.px + tw / 2, p.py + g + 14, 'middle', p.px, p.py + g + 11]].filter(function (c) {
          return c[0] >= L && c[2] <= W - R && c[1] >= T && c[3] <= H - B && !boxes.some(function (o) { return hit(c, o); }) &&
            !labDots.some(function (o) { return o[4] !== p && hit(c, o); });
        });
        var b = cand.filter(function (c) { return !dots.some(function (o) { return o[4] !== p && hit(c, o); }); })[0];
        if (!b) {
          cand.forEach(function (c) { c.k = covers(c, p); });
          b = cand.sort(function (a, z) { return a.k - z.k; })[0];                 // sort 는 같은 값이면 처음 순서(오른쪽 → 왼쪽 → 위 → 아래)
          if (b && b.k > QCOVER) b = null;
        }
        if (!b) return;
        boxes.push(b);
        h += '<text class="v2-quad-nm v2-halo" x="' + n(b[5]) + '" y="' + n(b[6]) + '" text-anchor="' + b[4] + '">' + esc(t) + '</text>';
      });
      h += '<circle class="v2-quad-hl" id="qHl" cx="0" cy="0" r="0" visibility="hidden"/>' +
        '<rect class="v2-quad-hit" x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '" fill="transparent"/></svg>';
      var order = pts.map(function (p, i) { return i; }).sort(function (a, b) { return pts[a].px - pts[b].px || pts[a].py - pts[b].py; });   // 키보드 ←→ 순서 = 가로 위치
      QP = { W: W, ax: ax, pts: pts, order: order, bx: bx, by: by, cur: null, sel: -1, clamped: pts.filter(function (p) { return p.cl; }).length };
      return h;
    }

    function quadLegend(ax, P) {
      var o = {};
      P.pts.forEach(function (p) { o[p.m.origin] = 1; });
      return '<div class="v2-legend">' + (o['국산'] && o['수입'] ? '<span><i style="background:var(--info)"></i>국산</span><span><i style="background:var(--accent)"></i>수입</span>' : '') +
        '<span>점 크기 = 판매중 대수</span>' +
        (ax === 'trend' ? '<span><i style="background:var(--tx-3);opacity:.3"></i>흐린 점 = 흔들림 2배 안(보합)</span>' : '') +
        (QP.clamped ? '<span><i class="v2-quad-lcl"></i>점선 테두리 = 축 범위 밖이라 가장자리에 그림</span>' : '') + '</div>';
    }

    function quadSum(ax, P) {                                 // 네 칸 대수 + 판매중이 많은 모델 3개(누르면 모델 리포트)
      var G = [[], [], [], []], flat = 0;
      P.pts.forEach(function (p) {
        if (p.faded) { flat++; return; }
        G[(p.y >= QP.by ? 0 : 2) + (p.x >= QP.bx ? 0 : 1)].push(p);   // 우상·좌상·우하·좌하
      });
      return '<div class="v2-quad-sum">' + G.map(function (g, i) {
        g.sort(function (a, b) { return b.m.on - a.m.on; });
        return '<div class="q' + i + '"><div><b>' + esc(QNAME[ax][i]) + '</b> ' + g.length + '개 <small>' + esc(QSUB[ax][i]) + '</small></div>' +
          '<div class="v2-quad-names">' + (g.length ? g.slice(0, 3).map(function (p) { return mLink(p.m, esc(p.m.model)); }).join(' · ') + (g.length > 3 ? ' 외' : '') : '–') + '</div></div>';
      }).join('') + '</div>' + (flat ? '<p class="v2-help" style="margin-top:6px">흔들림 2배를 넘지 않은 보합 ' + flat + '개는 네 칸에 세지 않았습니다.</p>' : '');
    }

    function quadHelp(ax, P) {
      var miss = P.all.length - P.pts.length, w = wkDates(), iv = MM.speed_interval, gap = w ? day(w[1]) - day(w[0]) : 0;
      var s = (ax === 'rv'
        ? '잔존가치 지수 = 판매중 매물마다 잔존율(호가 ÷ 출고가)을 같은 차급·국산수입·연차의 가운데 잔존율로 나눈 값의 가운데 값(동급 = 100)입니다. 100보다 크면 같은 연식의 동급 차보다 값을 잘 지킵니다.'
        : '시세 1주 변화 = 세부모델 시세지수(새로 올라온 매물, 7월 초 = 100)의 ' + md(w[0]) + '→' + md(w[1]) + ' 차이입니다. 신규 매물이 적으면 값이 흔들려서, ' +
          '변화가 흔들림의 2배(최소 0.5)를 넘을 때만 오름·내림으로 보고 나머지는 흐리게 그립니다(시세 산정의 시세 추세와 같은 기준).') +
        ' 가로 기준선은 ' + (ax === 'rv' ? '동급 100' : '변화 0') + ', 세로 기준선은 이 그림에 보이는 모델의 주간 판매율 가운데 값(' + f1(QP.by) + '%' +
        (iv ? ', ' + md(iv[0]) + '→' + md(iv[1]) + ' 구간' : '') + ')입니다.' +
        (miss ? ' ' + (ax === 'rv' ? '잔존가치 지수가 없는(잔존율을 계산한 매물 20대 미만) ' : '시세 1주 변화가 없는(직전·기준 목록 중 신규 매물이 10대 미만인 회차가 있는) ') + miss + '개는 뺐습니다.' : '') +
        (ax === 'trend' && (gap < IRREG[0] || gap > IRREG[1]) ? ' 직전 목록과 간격이 ' + gap + '일이라 1주 변화로 보기 어렵습니다.' : '') +
        (rvErr ? ' 잔존가치 지수 파일을 불러오지 못해 가치 축은 껐습니다.' : '') +
        ' 점을 누르면 모델 리포트로 갑니다(휴대폰은 처음 누르면 설명, 한 번 더 누르면 이동). 키보드는 그림에 초점을 두고 ←→로 점을 옮기고 Enter.';
      return '<p class="v2-help">' + esc(s) + '</p>';
    }

    function quadTip(p) {                                     // 점 말풍선 — 값이 먼저
      var m = p.m, w = p.w, row = function (v, label) { return '<div class="v2-quad-tr"><b>' + v + '</b> ' + esc(label) + '</div>'; };
      return '<div class="v2-tdate">' + esc(m.maker + ' ' + m.model) + '</div>' +
        '<div class="v2-quad-tsub">' + esc(m.seg + '·' + m.origin + ' · 판매중 ' + m.on.toLocaleString('ko-KR') + '대') + '</div>' +
        row(f1(m.rate_w * 100) + '%', '주간 판매율(가운데 ' + f1(QP.by) + '%)') +
        row(p.rv != null ? f1(p.rv) : '–', '잔존가치 지수' + (p.rv != null ? '(동급 100)' : ' — ' + rvWhy(m))) +
        row(w ? sgn1(w.d) + ' ±' + w.se.toFixed(1) : '–', '시세 1주' + (w ? ' · ' + (w.sig ? (w.d > 0 ? '오름' : '내림') : '보합(흔들림 2배 안)') : ' — 신규 매물이 적어 계산 안 함')) +
        (p.cl ? '<div class="v2-quad-tsub">축 범위 밖이라 가장자리에 그렸습니다</div>' : '') +
        '<div class="v2-quad-tsub">' + (HAVE[mkey(m)] ? (lastPT === 'touch' ? '한 번 더 누르면 모델 리포트' : '누르면 모델 리포트') : '모델 리포트 대상이 아님') + '</div>';
    }
    function quadShow(i, cx, cy) {                            // i 번 점 말풍선 + 테두리 강조(cx, cy = 화면 좌표)
      var p = QP.pts[i], tip = $('tip'), hl = $('qHl');
      QP.cur = i;
      if (hl) { hl.setAttribute('cx', p.px.toFixed(1)); hl.setAttribute('cy', p.py.toFixed(1)); hl.setAttribute('r', (p.r + 2.5).toFixed(1)); hl.setAttribute('visibility', 'visible'); }
      if (!tip) return;
      tip.innerHTML = quadTip(p);
      tip.hidden = false;
      var th = tip.offsetHeight, y = cy + 14 + th > window.innerHeight - 8 ? cy - 14 - th : cy + 14;   // 아래가 모자라면 위로
      tip.style.left = Math.max(8, Math.min(cx + 14, window.innerWidth - tip.offsetWidth - 8)) + 'px';
      tip.style.top = Math.max(8, y) + 'px';
    }
    function quadNear(e, svg) {                               // 포인터에서 가장 가까운 점 — 점 반지름 + 8px(최소 12px) 안에서만
      var r = svg.getBoundingClientRect(), s = r.width / QP.W, x = (e.clientX - r.left) / s, y = (e.clientY - r.top) / s, best = -1, bd = 1e9;
      QP.pts.forEach(function (p, i) {
        var dx = p.px - x, dy = p.py - y, d = Math.sqrt(dx * dx + dy * dy);
        if (d * s <= Math.max(12, p.r * s + 8) && d < bd) { bd = d; best = i; }
      });
      return best;
    }
    function go(p) {                                          // 모델 리포트로
      var m = p.m;
      if (!HAVE[mkey(m)]) return;
      hideTip();
      location.hash = ctx.reportHref(m.maker, m.group, m.model);
    }
    function quadClick(e, svg) {                              // 점 누름 → 모델 리포트(터치는 첫 누름에 말풍선, 같은 점을 한 번 더 누르면 이동)
      if (!QP) return;
      var i = quadNear(e, svg);
      if (i < 0) { QP.sel = -1; hideTip(); return; }
      if (lastPT === 'touch' && QP.sel !== i) { QP.sel = i; quadShow(i, e.clientX, e.clientY); return; }
      go(QP.pts[i]);
    }
    function quadKey(e) {                                     // 그림에 초점 → ←→ 로 점 이동(가로 위치 순), Enter 로 모델 리포트
      if (!QP || !QP.pts.length) return;
      if (e.key === 'Enter' && QP.cur != null) { e.preventDefault(); go(QP.pts[QP.cur]); return; }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var o = QP.order, j = QP.cur == null ? (e.key === 'ArrowRight' ? 0 : o.length - 1) : o.indexOf(QP.cur) + (e.key === 'ArrowRight' ? 1 : -1);
      j = Math.max(0, Math.min(o.length - 1, j));
      var r = e.target.getBoundingClientRect(), s = r.width / QP.W, p = QP.pts[o[j]];
      quadShow(o[j], r.left + p.px * s, r.top + p.py * s);
    }
    function textTip(t, x, y) {                               // [data-tip] 말풍선(? 설명) — 화면 안으로
      var tip = $('tip');
      if (!tip) return;
      tip.textContent = t;
      tip.hidden = false;
      tip.style.left = Math.max(8, Math.min(x, window.innerWidth - tip.offsetWidth - 8)) + 'px';
      tip.style.top = Math.max(8, Math.min(y, window.innerHeight - tip.offsetHeight - 8)) + 'px';
    }

    // ───── 차종 비교 ─────
    function models() {
      var h = '<div class="card" id="mModels"><div class="v2-tools"><div class="card-title">차종 비교 <span class="hint">세부모델별 · 머리글을 누르면 정렬 · 모델을 누르면 모델 리포트 · 행 끝 모델 요약은 시세 산정</span></div>' +
        '<div class="v2-actions" style="margin:0"><input class="v2-in v2-msearch" id="mQ" placeholder="모델 이름으로 찾기" value="' + esc(V.q) + '" autocomplete="off" aria-label="모델 찾기">' +
        '<button type="button" class="v2-btn" data-m="xlsx">엑셀 내려받기</button></div></div><div id="mTable">';
      return h + (MM ? modelTable() : '<p class="v2-kv"><span class="spinner v2-spin"></span>불러오는 중…</p>') + '</div></div>';
    }
    function filtered() {
      var q = V.q.trim().toUpperCase().replace(/\s+/g, '');
      var list = MM.models.filter(function (m) {
        if (V.o !== '전체' && m.origin !== V.o) return false;
        if (V.s !== '전체' && m.seg !== V.s) return false;
        return !q || (m.maker + m.model).toUpperCase().replace(/\s+/g, '').indexOf(q) >= 0;
      });
      var k = V.sort, d = V.dir;
      list.sort(function (a, b) {
        var x = val(a, k), y = val(b, k);
        if (x == null && y == null) return b.on - a.on;
        if (x == null) return 1;
        if (y == null) return -1;
        return (typeof x === 'string' ? x.localeCompare(y, 'ko') : x - y) * d || b.on - a.on;
      });
      return list;
    }
    function rvCell(m) {                                      // 잔존가치 지수 칸(없으면 까닭을 말풍선으로)
      var v = rviOf(m);
      return v != null ? f1(v) : '<span class="v2-dim" title="' + esc(rvWhy(m)) + '">–</span>';
    }
    function d1Cell(m) {                                      // 시세 1주 칸 — 흔들림 2배를 못 넘으면 흐리게
      var w = wk(m);
      if (!w) return '<span class="v2-dim" title="직전·기준 목록 중 신규 매물이 10대 미만인 회차가 있어 계산 안 함">–</span>';
      return '<span class="' + (w.sig ? (w.d > 0 ? 'v2-quad-up' : 'v2-quad-dn') : 'v2-dim') + '" title="흔들림 ±' + w.se.toFixed(1) +
        (w.sig ? ' — 2배를 넘어 ' + (w.d > 0 ? '오름' : '내림') : ' — 2배를 넘지 않아 보합') + '">' + sgn1(w.d) + '</span>';
    }
    function modelTable() {
      var list = filtered(), iv = MM.speed_interval, w = wkDates();
      var h = '<p class="v2-help" style="margin:0 0 8px">' + list.length.toLocaleString() + '개 모델 · 기준 ' + md(MM.date) + ' 목록' +
        (iv ? ' · 판매율 구간 ' + md(iv[0]) + '→' + md(iv[1]) : ' · 주간 판매율·소진 주수는 다음 주간 수집부터(지금은 83일 공백 뒤 첫 회차)') +
        (w ? ' · 시세 1주 ' + md(w[0]) + '→' + md(w[1]) : '') + (rvErr ? ' · 잔존가치 지수 파일을 불러오지 못했습니다' : '') + '</p>' +
        '<div class="v2-tablewrap"><table class="t v2-tbl v2-mdl"><thead><tr>' + COLS.map(function (c) {
          var on = V.sort === c[0];
          return '<th class="' + (c[2] === 'n' ? 'num' : '') + '"><button type="button" class="v2-sorth' + (on ? ' on' : '') + '" data-sort="' + c[0] + '">' + c[1] +
            (on ? (V.dir > 0 ? ' ↑' : ' ↓') : '') + '</button></th>';
        }).join('') + '<th>시세 산정</th></tr></thead><tbody>';
      list.slice(0, V.shown).forEach(function (m) {
        var k = mkey(m), name = esc(m.maker + ' ' + m.model) + (YR[k] ? ' <span class="v2-dim">(' + YR[k] + ')</span>' : '');
        h += '<tr><td>' + mLink(m, name) + '</td><td>' + esc(m.seg + '·' + m.origin) + '</td>' +
          '<td class="num">' + m.on.toLocaleString() + '</td><td class="num">' + (m.price != null ? man(m.price) : '–') + '</td>' +
          '<td class="num">' + (m.cut * 100).toFixed(0) + '%</td><td class="num">' + m.sold90.toLocaleString() + '</td>' +
          '<td class="num">' + (m.dwell != null ? m.dwell + '일' : '–') + '</td><td class="num">' + (m.rate_w != null ? (m.rate_w * 100).toFixed(1) + '%' : '–') + '</td>' +
          '<td class="num">' + (m.weeks != null ? m.weeks + '주' : '–') + '</td><td class="num">' + (m.pidx != null ? f1(m.pidx) : '–') + '</td>' +
          '<td class="num">' + rvCell(m) + '</td><td class="num">' + d1Cell(m) + '</td>' +
          '<td>' + (HAVE[k] ? '<a class="v2-quad-mini" href="' + esc(ctx.href({ mk: m.maker, grp: m.group, model: m.model }, 'model')) + '" title="시세 산정의 모델 요약으로">모델 요약</a>' : '') + '</td></tr>';
      });
      h += '</tbody></table></div>';
      if (list.length > V.shown) h += '<div class="v2-actions"><button type="button" class="v2-btn" data-m="more">' + Math.min(PAGE, list.length - V.shown) + '개 더 보기</button></div>';
      return h + '<p class="v2-help">' + esc(MODEL_NOTE) + '.</p>';
    }
    function exportModels() {
      var list = filtered(), w = wkDates();
      var rows = [['제조사', '모델', '세부모델', '차급', '국산·수입', '판매중(대)', '중앙 호가(만원)', '인하 매물 비율(%)', '최근 90일 판매(대)', '중위 체류일',
        '주간 판매율(%)', '재고 소진 주수', '시세(기준기간=100)', '잔존가치 지수(동급=100)', '시세 1주 변화', '시세 1주 흔들림(±)', '시세 1주 판정']].concat(list.map(function (m) {
        var d = wk(m);
        return [m.maker, m.group, m.model, m.seg, m.origin, m.on, m.price, +(m.cut * 100).toFixed(1), m.sold90, m.dwell != null ? m.dwell : null,
          m.rate_w != null ? +(m.rate_w * 100).toFixed(2) : null, m.weeks != null ? m.weeks : null, m.pidx != null ? m.pidx : null,
          rviOf(m), d ? d.d : null, d ? +d.se.toFixed(2) : null, d ? (d.sig ? (d.d > 0 ? '오름' : '내림') : '보합') : null];
      }));
      var info = [['항목', '값'], ['기준', MM.date + ' 목록'], ['구분', key().replace('|', ' ')], ['검색', V.q || '없음'],
        ['판매율 구간', MM.speed_interval ? MM.speed_interval.join(' → ') : '없음(다음 주간 수집부터)'],
        ['시세 1주', w ? w.join(' → ') + ' 목록의 세부모델 시세지수 차이 — 흔들림 2배(최소 0.5)를 넘으면 오름·내림, 아니면 보합' : '없음(직전 목록 없음)'],
        ['잔존가치 지수', RV && RV.rules && RV.rules.rvi ? RV.rules.rvi : rvErr ? '파일을 불러오지 못함' : '불러오는 중이라 비어 있음'], ['설명', MODEL_NOTE]];
      XlsxWriter.download(ctx.fileSafe('차종비교_' + key().replace('|', '_') + '_' + ctx.today()) + '.xlsx', [
        { name: '차종 비교', rows: rows, header: true, freeze: true, money: [5, 6, 8], widths: [12, 14, 26, 8, 9, 10, 13, 13, 14, 10, 12, 12, 14, 16, 12, 14, 11] },
        { name: '설명', rows: info, header: true, widths: [14, 100] }]);
    }
    function loadModels() {                                   // market_models.json — app.js 가 이미 불러오는 것(ctx.mm)을 같이 쓰고, 실패하면 직접 다시
      if (MM || mmWait) return mmWait;
      var p = ctx.mm && ctx.mm();
      mmWait = Promise.resolve(p).then(function (j) { return j || ctx.getJSON('market_models.json'); })
        .then(function (j) { MM = j; var t = $('mTable'); if (t) t.innerHTML = modelTable(); refreshQuad(); })
        .catch(function (e) {
          mmErr = e && e.message || String(e);
          var t = $('mTable');
          if (t) t.innerHTML = '<p class="v2-kv v2-bad">차종 비교 파일을 불러오지 못했습니다: ' + esc(mmErr) + '</p>';
          refreshQuad();
        });
      return mmWait;
    }
    function loadRV() {                                       // report/index.json(잔존가치 지수) — 못 불러오면 사분면 가치 축만 끈다
      if (RV || rvWait) return rvWait;
      rvWait = ctx.getJSON('report/index.json').then(function (j) { RV = j; }, function (e) { rvErr = e && e.message || String(e); })
        .then(function () { refreshQuad(); var t = $('mTable'); if (t && MM) t.innerHTML = modelTable(); });
      return rvWait;
    }

    // ───── 그리기 · 이벤트 ─────
    function render() {
      if (!el) return;
      CH = {};
      CW = Math.round(Math.max(300, Math.min(1200, el.clientWidth - 42)));          // 카드 안쪽 폭 = 차트 폭 → 글자 크기 그대로
      el.innerHTML = filters() + board() + tiles() + trend() + quad() + models();
      syncHash();
    }
    function state() { return { o: V.o, s: V.s, range: V.range, sort: V.sort, dir: V.dir, qx: V.qx }; }   // qx = 사분면 가로축(rv | trend)
    function syncHash() {                                     // 화면 상태를 주소에 — app.js 가 qx 를 아직 안 쓰면 여기서 붙인다(기본 rv 는 생략, 이미 있으면 그대로)
      ctx.hash(state());
      var h = location.hash;
      if (V.qx === 'rv' || h.indexOf('#/market') !== 0 || /[?&]qx=/.test(h)) return;
      h += (h.indexOf('?') >= 0 ? '&' : '?') + 'qx=' + V.qx;
      history.replaceState(null, '', h);
      var nav = $('navMarket');
      if (nav) nav.setAttribute('href', h);                   // 다른 탭에 갔다 와도 보던 그대로
    }
    function setState(q) {
      V.o = ['국산', '수입'].indexOf(q.get('o')) >= 0 ? q.get('o') : '전체';
      V.s = SEGS.indexOf(q.get('s')) >= 0 ? q.get('s') : '전체';
      V.range = q.get('range') === '3m' ? '3m' : 'all';
      if (q.get('sort') && COLS.some(function (c) { return c[0] === q.get('sort'); })) { V.sort = q.get('sort'); V.dir = q.get('dir') === '1' ? 1 : -1; }
      if (q.get('qx') === 'rv' || q.get('qx') === 'trend') V.qx = q.get('qx');      // 주소에 없으면 보던 그대로(정렬과 같은 방식)
    }
    function pickRow(k) {
      var p = k.split('|');
      V.o = p[0]; V.s = p[1]; V.shown = PAGE;
      render();
    }
    function onClick(e) {
      var qh = e.target.closest('rect.v2-quad-hit');
      if (qh) { quadClick(e, qh.ownerSVGElement); return; }
      var row = e.target.closest('tr.v2-mrow');
      if (row) { pickRow(row.getAttribute('data-key')); return; }
      var b = e.target.closest('button');
      if (!b) return;
      var m = b.getAttribute('data-m'), v = b.getAttribute('data-v'), s = b.getAttribute('data-sort');
      if (m === 'o') { V.o = v; if (V.o === '전체' && V.s !== '전체') V.s = '전체'; V.shown = PAGE; render(); }
      else if (m === 'range') { V.range = v; render(); }
      else if (m === 'qx') { V.qx = v; refreshQuad(); syncHash(); }
      else if (m === 'table') { V.table = !V.table; render(); }
      else if (m === 'more') { V.shown += PAGE; $('mTable').innerHTML = modelTable(); }
      else if (m === 'xlsx') { if (MM) exportModels(); }
      else if (s) { if (V.sort === s) V.dir = -V.dir; else { V.sort = s; V.dir = s === 'model' || s === 'seg' || s === 'dwell' || s === 'weeks' ? 1 : -1; } V.shown = PAGE; $('mTable').innerHTML = modelTable(); syncHash(); }
    }
    function onKey(e) {
      var row = e.target.closest && e.target.closest('tr.v2-mrow');
      if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickRow(row.getAttribute('data-key')); return; }
      var id = e.target.getAttribute && e.target.getAttribute('data-kchart');      // 차트에 초점 → ←→ 로 날짜 이동
      if (id === 'quad') { quadKey(e); return; }
      if (!id || !CH[id] || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      var c = CH[id], i = c.cur == null ? c.pts.length - 1 : c.cur + (e.key === 'ArrowRight' ? 1 : -1);
      i = Math.max(0, Math.min(c.pts.length - 1, i));
      var r = e.target.getBoundingClientRect();
      showTip(id, i, r.left + c.x(c.pts[i].date) / c.W * r.width, r.top + 20);
    }
    function onMove(e) {
      if (!e.target.closest) return;
      var t = e.target.closest('[data-tip]');
      if (t) { textTip(t.getAttribute('data-tip'), e.clientX + 14, e.clientY + 14); return; }
      var qh = e.target.closest('rect.v2-quad-hit');
      if (qh) { var i = QP ? quadNear(e, qh.ownerSVGElement) : -1; if (i >= 0) quadShow(i, e.clientX, e.clientY); else hideTip(); return; }
      var hit = e.target.closest('rect.v2-hit');
      if (!hit) return;
      var id = hit.getAttribute('data-chart');
      showTip(id, nearest(id, e, hit.ownerSVGElement), e.clientX, e.clientY);
    }
    function onOut(e) {
      if (e.target.closest && (e.target.closest('rect.v2-hit') || e.target.closest('rect.v2-quad-hit') || e.target.closest('[data-tip]') || e.target.getAttribute('data-kchart'))) hideTip();
    }
    function onFocus(e) {                                     // 키보드·휴대폰: ? 에 초점이 오면 그 아래에 설명
      var t = e.target.getAttribute && e.target.getAttribute('data-tip');
      if (!t) return;
      var b = e.target.getBoundingClientRect();
      textTip(t, b.left, b.bottom + 6);
    }
    var timer = 0;
    function onInput(e) {
      if (e.target.id !== 'mQ') return;
      V.q = e.target.value; V.shown = PAGE;
      clearTimeout(timer);
      timer = setTimeout(function () { if (MM) $('mTable').innerHTML = modelTable(); }, 150);
    }

    function show(container, q) {
      if (el !== container) {
        el = container;
        el.addEventListener('click', onClick);
        el.addEventListener('keydown', onKey);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerout', onOut);
        el.addEventListener('focusout', onOut);
        el.addEventListener('focusin', onFocus);
        el.addEventListener('pointerdown', function (e) { lastPT = e.pointerType || ''; });   // 터치인지(사분면 첫 누름은 말풍선)
        el.addEventListener('input', onInput);
        var rt = 0;
        window.addEventListener('resize', function () {                          // 폭이 크게 바뀌면 차트만 다시
          clearTimeout(rt);
          rt = setTimeout(function () { if (!el.hidden && Math.abs(el.clientWidth - 42 - CW) > 40) render(); }, 200);
        });
      }
      if (q) setState(q);
      render();
      loadModels();
      loadRV();
    }
    return { show: show };
  }

  var api = { create: create };
  root.V2Market = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
