/*
 * market.js — 새 사이트(v2) 시장 시황 화면 (기획안 5.2: 시황판 · 핵심 숫자 · 트렌드 · 차종 비교)
 *
 * 데이터: ../data/market_index.json(세그먼트별 지수 + 회차별 흐름, market_index.py) · ../data/market_models.json(세부모델별 숫자)
 * 위쪽 한 줄(국산·수입 · 기간)이 아래 전부에 적용된다. 시황판 행을 누르면 핵심 숫자·트렌드·차종 비교가 그 세그먼트로 바뀐다.
 * 날짜는 목록 관측일, 축은 실제 날짜 간격. 10일 넘는 공백은 음영, 5~16일이 아닌 구간의 흐름은 흐리게 그린다.
 *
 *   var M = V2Market.create(ctx);   M.show(el);      // ctx = app.js 가 넘기는 데이터·도우미
 */
(function (root) {
  'use strict';

  var SEGS = ['경차', '소형', '준중형', '중형', '대형', '스포츠', 'SUV', 'RV', '승합', '화물'];
  var IDX = [['시황', '시황지수', 'var(--s-cond)'], ['시세', '시세지수', 'var(--s-price)'], ['판매속도', '판매속도지수', 'var(--s-speed)'], ['재고', '재고지수', 'var(--s-stock)']];
  var GAP = 10, IRREG = [5, 16], PAGE = 100;
  var COLS = [['model', '세부모델', 's'], ['seg', '차급', 's'], ['on', '판매중', 'n'], ['price', '중앙 호가', 'n'], ['cut', '인하 매물', 'n'],
    ['sold90', '90일 판매', 'n'], ['dwell', '중위 체류', 'n'], ['rate_w', '주간 판매율', 'n'], ['weeks', '소진 주수', 'n'], ['pidx', '시세(7월=100)', 'n']];

  // 차종 비교 설명 — 표 머리글과 같은 말로(market_models.json 의 note 는 CSV 열 이름 설명이라 화면에는 쓰지 않는다)
  var MODEL_NOTE = '세부모델별 시장 숫자. 판매중 = 상세까지 확인한 판매중 매물 · 인하 매물 = 첫 호가보다 내린 매물 비율 · ' +
    '90일 판매·중위 체류 = 최근 90일 판매 대수와 중위 체류일(5대 이상일 때) · 주간 판매율 = 최근 판매속도 구간의 주간 판매율(구간 시작 10대 이상) · ' +
    '소진 주수 = 지금 재고가 다 팔리는 데 걸리는 주(1 ÷ 주간 판매율) · 시세(7월=100) = 새로 올라온 매물 시세(기준기간 = 100, 양쪽 10대 이상)';

  function create(ctx) {
    var MI = ctx.X.mi, esc = ctx.esc, man = ctx.man, el = null, MM = null, mmWait = null, HAVE = {}, YR = {};
    ctx.X.idx.makers.forEach(function (mk) {                 // 시세 산정에 비교 매물이 있는 세부모델(모델 요약으로 갈 수 있는 것) · 연식 범위
      mk.groups.forEach(function (g) { g.models.forEach(function (m) {
        var k = mk.name + '|' + g.name + '|' + m.name;
        HAVE[k] = true;
        if (m.y0 && m.y1) YR[k] = m.y0 === m.y1 ? String(m.y0) : m.y0 + '~' + m.y1;
      }); });
    });
    var V = { o: '전체', s: '전체', range: 'all', sort: 'on', dir: -1, q: '', shown: PAGE, table: false };

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
      return '<td class="num' + (latest ? '' : ' v2-dim') + '" title="' + esc(tip) + '"><b>' + f1(p[f]) + '</b>' + lab + (latest ? '' : '<small>' + md(p.date) + '</small>') +
        '<small>' + (j >= 0 ? delta(p[f], pts[j][f], 1) : '') + '</small></td>';
    }

    function board() {
      var rows = [['전체', '전체'], ['국산', '전체'], ['수입', '전체']].concat(SEGS.filter(function (s) { return MI.series[V.o + '|' + s]; }).map(function (s) { return [V.o, s]; }));
      var h = '<div class="card"><div class="card-title">시황판 <span class="hint">행을 누르면 아래 숫자·추이·차종 비교가 그 구분으로 바뀝니다 · ▲▼는 직전 값 대비</span></div>' +
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
        '. 흐린 값은 그 지수의 마지막 값(날짜 표시)입니다.</p></div>';
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
      var sub = irr ? span + ' 평균 — ' + (p.days > IRREG[1] ? '공백이 길어 그사이 들어왔다 팔린 매물이 빠져 낮게 나옴' : '구간이 짧아 7일로 늘린 값') : span + ' · 7일 환산';
      // 유입·판매·호가는 구간 값이라 간격이 5~16일이고 목록 누락 의심이 없는 직전 구간과만 비교 (83일 공백 평균과 비교하면 증감이 부풀어 보임)
      var r = null;
      if (!irr) for (var j = i - 1; j >= 0; j--) if (pts[j].new_w != null && pts[j].days >= IRREG[0] && pts[j].days <= IRREG[1] && !pts[j].sold_suspect) { r = pts[j]; break; }
      var vs = r && r !== q ? ' · ' + md(r.date) + ' 구간 대비' : '';
      return '<div class="v2-cards v2-bcards">' +
        t('판매중 재고', (p.on || 0).toLocaleString('ko-KR'), '대', (q ? md(q.date) + ' 대비' : '') + ' · 상세 확인 매물', q && q.on != null ? delta(p.on, q.on, 0, '대') : '') +
        t('주간 신규 유입', p.new_w != null ? p.new_w.toLocaleString('ko-KR') : '–', p.new_w != null ? '대' : '', p.new_w != null ? sub + vs : '첫 수집', r && p.new_w != null ? delta(p.new_w, r.new_w, 0, '대') : '') +
        t('주간 판매(추정)', p.sold_w != null ? p.sold_w.toLocaleString('ko-KR') : '–', p.sold_w != null ? '대' : '', p.sold_w != null ? sub + vs + (p.sold_suspect ? ' · 목록 누락으로 부풀었을 수 있음' : '') : '첫 수집',
          r && p.sold_w != null ? delta(p.sold_w, r.sold_w, 0, '대') : '') +
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
      h += '<div class="v2-subchart"><div class="v2-sub">주간 신규 유입 · 판매(추정) <span class="v2-dim">(구간 값을 7일로 환산, 대)</span></div>' +
        '<div class="v2-legend"><span><i style="background:var(--s-new);border-radius:2px"></i>신규 유입</span><span><i style="background:var(--s-sold);border-radius:2px"></i>판매(추정)</span>' +
        '<span><i style="background:var(--tx-4);opacity:.4;border-radius:2px"></i>구간이 5~16일이 아닌 값(비교 주의)</span></div>' + flowChart(pts) + '</div>';
      h += '<div class="v2-actions"><button type="button" class="v2-btn" data-m="table">' + (V.table ? '표 닫기' : '표로 보기') + '</button></div>';
      if (V.table) h += dataTable(pts);
      return h + '<p class="v2-help">판매중 재고 = 상세 화면까지 확인한 판매중 매물 · 신규 유입 = 직전 수집 뒤 엔카에 새로 올라온 매물 · ' +
        '판매(추정) = 그 사이 목록에서 사라진 매물(다시 올린 것은 뺌) · /주 = 7일로 환산한 값 · 신규 중앙 호가 = 새로 올라온 매물(30대 이상)의 첫 호가 가운데 값. ' +
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
      var tip = $('tip');
      if (tip) tip.hidden = true;
      Object.keys(CH).forEach(function (id) { var xh = $('xh-' + id); if (xh) xh.setAttribute('visibility', 'hidden'); });
    }
    function nearest(id, evt, svg) {
      var c = CH[id], r = svg.getBoundingClientRect(), x = (evt.clientX - r.left) / r.width * c.W, best = 0, bd = 1e9;
      c.pts.forEach(function (p, i) { var d = Math.abs(c.x(p.date) - x); if (d < bd) { bd = d; best = i; } });
      return best;
    }

    // ───── 차종 비교 ─────
    function models() {
      var h = '<div class="card" id="mModels"><div class="v2-tools"><div class="card-title">차종 비교 <span class="hint">세부모델별 · 머리글을 누르면 정렬 · 모델을 누르면 시세 산정의 모델 요약</span></div>' +
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
        var x = a[k], y = b[k];
        if (x == null && y == null) return b.on - a.on;
        if (x == null) return 1;
        if (y == null) return -1;
        return (typeof x === 'string' ? x.localeCompare(y, 'ko') : x - y) * d || b.on - a.on;
      });
      return list;
    }
    function modelTable() {
      var list = filtered(), iv = MM.speed_interval;
      var h = '<p class="v2-help" style="margin:0 0 8px">' + list.length.toLocaleString() + '개 모델 · 기준 ' + md(MM.date) + ' 목록' +
        (iv ? ' · 판매율 구간 ' + md(iv[0]) + '→' + md(iv[1]) : ' · 주간 판매율·소진 주수는 다음 주간 수집부터(지금은 83일 공백 뒤 첫 회차)') + '</p>' +
        '<div class="v2-tablewrap"><table class="t v2-tbl v2-mdl"><thead><tr>' + COLS.map(function (c) {
          var on = V.sort === c[0];
          return '<th class="' + (c[2] === 'n' ? 'num' : '') + '"><button type="button" class="v2-sorth' + (on ? ' on' : '') + '" data-sort="' + c[0] + '">' + c[1] +
            (on ? (V.dir > 0 ? ' ↑' : ' ↓') : '') + '</button></th>';
        }).join('') + '</tr></thead><tbody>';
      list.slice(0, V.shown).forEach(function (m) {
        var yk = m.maker + '|' + m.group + '|' + m.model, href = ctx.href({ mk: m.maker, grp: m.group, model: m.model }, 'model'),
          name = esc(m.maker + ' ' + m.model) + (YR[yk] ? ' <span class="v2-dim">(' + YR[yk] + ')</span>' : '');
        h += '<tr><td>' + (HAVE[m.maker + '|' + m.group + '|' + m.model] ? '<a class="v2-link" href="' + esc(href) + '">' + name + '</a>'
          : '<span title="성능점검 있는 비교 매물이 적어 시세 산정 대상이 아님">' + name + '</span>') + '</td><td>' + esc(m.seg + '·' + m.origin) + '</td>' +
          '<td class="num">' + m.on.toLocaleString() + '</td><td class="num">' + (m.price != null ? man(m.price) : '–') + '</td>' +
          '<td class="num">' + (m.cut * 100).toFixed(0) + '%</td><td class="num">' + m.sold90.toLocaleString() + '</td>' +
          '<td class="num">' + (m.dwell != null ? m.dwell + '일' : '–') + '</td><td class="num">' + (m.rate_w != null ? (m.rate_w * 100).toFixed(1) + '%' : '–') + '</td>' +
          '<td class="num">' + (m.weeks != null ? m.weeks + '주' : '–') + '</td><td class="num">' + (m.pidx != null ? f1(m.pidx) : '–') + '</td></tr>';
      });
      h += '</tbody></table></div>';
      if (list.length > V.shown) h += '<div class="v2-actions"><button type="button" class="v2-btn" data-m="more">' + Math.min(PAGE, list.length - V.shown) + '개 더 보기</button></div>';
      return h + '<p class="v2-help">' + esc(MODEL_NOTE) + '.</p>';
    }
    function exportModels() {
      var list = filtered();
      var rows = [['제조사', '모델', '세부모델', '차급', '국산·수입', '판매중(대)', '중앙 호가(만원)', '인하 매물 비율(%)', '최근 90일 판매(대)', '중위 체류일',
        '주간 판매율(%)', '재고 소진 주수', '시세(기준기간=100)']].concat(list.map(function (m) {
        return [m.maker, m.group, m.model, m.seg, m.origin, m.on, m.price, +(m.cut * 100).toFixed(1), m.sold90, m.dwell != null ? m.dwell : null,
          m.rate_w != null ? +(m.rate_w * 100).toFixed(2) : null, m.weeks != null ? m.weeks : null, m.pidx != null ? m.pidx : null];
      }));
      var info = [['항목', '값'], ['기준', MM.date + ' 목록'], ['구분', key().replace('|', ' ')], ['검색', V.q || '없음'],
        ['판매율 구간', MM.speed_interval ? MM.speed_interval.join(' → ') : '없음(다음 주간 수집부터)'], ['설명', MODEL_NOTE]];
      XlsxWriter.download(ctx.fileSafe('차종비교_' + key().replace('|', '_') + '_' + ctx.today()) + '.xlsx', [
        { name: '차종 비교', rows: rows, header: true, freeze: true, money: [5, 6, 8], widths: [12, 14, 26, 8, 9, 10, 13, 13, 14, 10, 12, 12, 14] },
        { name: '설명', rows: info, header: true, widths: [14, 100] }]);
    }
    function loadModels() {
      if (MM || mmWait) return mmWait;
      mmWait = ctx.getJSON('market_models.json').then(function (j) { MM = j; var t = $('mTable'); if (t) t.innerHTML = modelTable(); })
        .catch(function (e) { var t = $('mTable'); if (t) t.innerHTML = '<p class="v2-kv v2-bad">차종 비교 파일을 불러오지 못했습니다: ' + esc(e.message) + '</p>'; });
      return mmWait;
    }

    // ───── 그리기 · 이벤트 ─────
    function render() {
      if (!el) return;
      CH = {};
      CW = Math.round(Math.max(300, Math.min(1200, el.clientWidth - 42)));          // 카드 안쪽 폭 = 차트 폭 → 글자 크기 그대로
      el.innerHTML = filters() + board() + tiles() + trend() + models();
      ctx.hash(state());
    }
    function state() { return { o: V.o, s: V.s, range: V.range, sort: V.sort, dir: V.dir }; }
    function setState(q) {
      V.o = ['국산', '수입'].indexOf(q.get('o')) >= 0 ? q.get('o') : '전체';
      V.s = SEGS.indexOf(q.get('s')) >= 0 ? q.get('s') : '전체';
      V.range = q.get('range') === '3m' ? '3m' : 'all';
      if (q.get('sort') && COLS.some(function (c) { return c[0] === q.get('sort'); })) { V.sort = q.get('sort'); V.dir = q.get('dir') === '1' ? 1 : -1; }
    }
    function pickRow(k) {
      var p = k.split('|');
      V.o = p[0]; V.s = p[1]; V.shown = PAGE;
      render();
    }
    function onClick(e) {
      var row = e.target.closest('tr.v2-mrow');
      if (row) { pickRow(row.getAttribute('data-key')); return; }
      var b = e.target.closest('button');
      if (!b) return;
      var m = b.getAttribute('data-m'), v = b.getAttribute('data-v'), s = b.getAttribute('data-sort');
      if (m === 'o') { V.o = v; if (V.o === '전체' && V.s !== '전체') V.s = '전체'; V.shown = PAGE; render(); }
      else if (m === 'range') { V.range = v; render(); }
      else if (m === 'table') { V.table = !V.table; render(); }
      else if (m === 'more') { V.shown += PAGE; $('mTable').innerHTML = modelTable(); }
      else if (m === 'xlsx') { if (MM) exportModels(); }
      else if (s) { if (V.sort === s) V.dir = -V.dir; else { V.sort = s; V.dir = s === 'model' || s === 'seg' || s === 'dwell' || s === 'weeks' ? 1 : -1; } V.shown = PAGE; $('mTable').innerHTML = modelTable(); ctx.hash(state()); }
    }
    function onKey(e) {
      var row = e.target.closest && e.target.closest('tr.v2-mrow');
      if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickRow(row.getAttribute('data-key')); return; }
      var id = e.target.getAttribute && e.target.getAttribute('data-kchart');      // 차트에 초점 → ←→ 로 날짜 이동
      if (!id || !CH[id] || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      var c = CH[id], i = c.cur == null ? c.pts.length - 1 : c.cur + (e.key === 'ArrowRight' ? 1 : -1);
      i = Math.max(0, Math.min(c.pts.length - 1, i));
      var r = e.target.getBoundingClientRect();
      showTip(id, i, r.left + c.x(c.pts[i].date) / c.W * r.width, r.top + 20);
    }
    function onMove(e) {
      var hit = e.target.closest && e.target.closest('rect.v2-hit');
      if (!hit) return;
      var id = hit.getAttribute('data-chart');
      showTip(id, nearest(id, e, hit.ownerSVGElement), e.clientX, e.clientY);
    }
    function onOut(e) { if (e.target.closest && (e.target.closest('rect.v2-hit') || e.target.getAttribute('data-kchart'))) hideTip(); }
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
    }
    return { show: show };
  }

  var api = { create: create };
  root.V2Market = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
