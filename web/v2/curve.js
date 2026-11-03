/*
 * curve.js — 시세 산정의 동급 대비 지표 6개 · 감가 곡선 (기획 v2.24, 인터뷰 Q112~Q115 — 모델 리포트 탭을 시세 산정에 합침)
 *
 *   var CV = V2Curve.create({ X, esc, man, getJSON, mm: () => X.mmWait, bindTips });
 *   CV.tiles({ mk, model, seg })                 → 지표 6개 줄(HTML, id="cvTiles") — 주간 판매율·재고 소진·중위 체류일·인하 매물·시세지수·잔존가치 지수
 *   CV.card({ mk, grp, model, file, seg }, me, W) → 감가 곡선 카드(HTML, id="cvCard") — me = { age(년), est(만원), op(출고가 만원 | null) } 면 내 차 ★
 *   CV.load(o).then(CV.refresh)                  → 리포트 자료(report/index.json · report/<모델그룹 파일>)·시장 숫자를 받은 뒤 두 곳을 다시 그린다
 *
 * 자료는 model_report.py 가 매주 만든다: 세부모델 연차별 잔존율 rv [연차, 가운데, 25%, 75%, 호가 가운데, 대수] · 동급 seg_rv · 잔존가치 지수 rvi.
 * 잔존율/금액 전환 · 겹쳐 보기(최대 3개)는 이 화면 안 상태(세부모델이 바뀌면 겹쳐 보기는 비운다).
 */
(function (root) {
  'use strict';

  var RV_OK = 20, SPEED_N = 100, MAX_CMP = 3;
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
    var IDX = null, idxWait = null, MM = null, FILES = {}, WAIT = {}, KEY = {};
    var V = { unit: 'rv', cmp: [], k: '' }, LAST = { tiles: null, card: null };
    X.idx.makers.forEach(function (mk) {                     // 세부모델 찾기표 '제조사|세부모델' → 모델그룹 파일
      mk.groups.forEach(function (g) {
        g.models.forEach(function (m) {
          KEY[mk.name + '|' + m.name] = { mk: mk.name, grp: g.name, model: m.name, file: g.file, y0: m.y0, y1: m.y1 };
        });
      });
    });
    var BP = X.mi && X.mi.base_period ? md(X.mi.base_period[0]) + '~' + md(X.mi.base_period[1]) : '7월 초';
    var TIP = {                                              // 용어 설명(? 말풍선) — 모델 리포트에서 옮김
      rate: '지난 수집 구간에 목록에서 사라진(판매된) 매물 ÷ 구간 시작 판매중 매물을 7일 기준으로 맞춘 값입니다. 구간 시작이 10대 이상일 때만 냅니다. ' +
        '동급 = 같은 차급·국산/수입 전체. 판매중 100대 이상일 때 동급의 1.15배 이상이면 빠름, 0.87배 이하이면 느림으로 씁니다(마켓 펄스와 같은 기준).',
      weeks: '지금 판매중 매물이 다 팔리는 데 걸리는 주(1 ÷ 주간 판매율)입니다. 짧을수록 빨리 팔립니다.',
      dwell: '최근 90일에 팔린 매물이 온라인에 올라온 뒤 목록에서 사라지기까지 걸린 날수의 가운데 값입니다(5대 이상일 때).',
      cut: '판매중 매물 가운데 첫 호가보다 값을 내린 매물의 비율입니다. 동급은 같은 차급·국산/수입 세부모델들을 판매중 대수로 가중 평균한 값입니다.',
      pidx: '새로 올라온 매물(등록 7일 이내)의 첫 호가를 기준기간(' + BP + ') 같은 모델·등급 매물과 비교한 값입니다(기준기간 = 100). ' +
        '차령·주행·색상·성능을 맞추므로 시간에 따른 자연 감가는 빠집니다. 동급은 같은 차급·국산/수입 전체의 마지막 값입니다.',
      rvi: '판매중 매물마다 잔존율을 같은 차급·국산/수입·차령 연차 매물의 가운데 잔존율로 나눈 뒤, 그 가운데 값 × 100입니다(동급 = 100). ' +
        '연식 구성이 달라도 비교됩니다. 100보다 크면 같은 연차 동급보다 값을 잘 지킵니다. 계산한 매물이 20대 미만이면 지수를 내지 않습니다.',
      curve: '잔존율 = 판매중 매물의 지금 호가 ÷ 출고가. 차령 연차(0 = 1년 미만, 12+ = 12년 이상)별 가운데 값을 잇고, 띠는 가운데 50%(25~75%)입니다. ' +
        '연차당 10대 이상만 그리고 20대 미만은 흐리게 그립니다. 점선은 같은 차급·국산/수입 전체의 가운데 값입니다. 금액으로 바꾸면 연차별 호가 가운데 값(만원)을 봅니다. ' +
        '★은 이 차의 차령과 추정 시세(잔존율은 비교 매물 출고가의 가운데 값으로 나눈 값)입니다. 그림에 마우스를 올리거나 누르면 그 연차의 숫자가 나옵니다.'
    };

    // ───── 도우미 ─────
    function q(t) { return ' <span class="v2-q" tabindex="0" role="note" aria-label="' + esc(t) + '" data-tip="' + esc(t) + '">?</span>'; }
    function md(s) { return s ? (+s.slice(5, 7)) + '/' + (+s.slice(8, 10)) : ''; }
    function n0(v) { return Math.round(v).toLocaleString('ko-KR'); }
    function pc(v, d) { return (v * 100).toFixed(d == null ? 1 : d); }
    function opt(v, label) { return '<option value="' + esc(v) + '">' + esc(label) + '</option>'; }
    function segName(seg) { var s = String(seg || '').split('·'); return s.length > 1 ? s[1] + ' ' + s[0] : String(seg || ''); }   // '대형·국산' → '국산 대형'
    function yrTxt(o) { return o && o.y0 && o.y1 ? (o.y0 === o.y1 ? String(o.y0) : o.y0 + '~' + o.y1) : ''; }
    function ageTxt(a) { return a >= 12 ? '12년 이상' : a === 0 ? '1년 미만' : a + '~' + (a + 1) + '년'; }
    function rowAt(rows, a) { for (var i = 0; i < rows.length; i++) if (rows[i][0] === a) return rows[i]; return null; }
    function over100(rows) { return rows.some(function (r) { return r[0] <= 1 && r[1] > 1; }); }
    function niceTicks(a, z, n) {
      var span = z - a || 1, step = Math.pow(10, Math.floor(Math.log(span / n) / Math.LN10)), e = span / n / step, t = [];
      if (e >= 7.5) step *= 10; else if (e >= 3.5) step *= 5; else if (e >= 1.5) step *= 2;
      for (var v = Math.ceil(a / step) * step; v <= z + 1e-9; v += step) t.push(Math.round(v / step) * step);
      return t;
    }
    function compact(v) {                                    // 축 눈금: 1.2만 · 5,000
      if (v < 1e4) return n0(v);
      var m = v / 1e4;
      return (Math.abs(m - Math.round(m)) < 0.05 ? Math.round(m) : m.toFixed(1)) + '만';
    }
    function rvWhy(r) {                                      // 잔존율 선·칸이 없는 이유(문장 가운데)
      if (!r) return '리포트 자료에 빠져 있어';
      if (!r.on) return '지금 판매중 매물이 없어';
      if (r.on < 10) return '판매중 매물이 10대 미만이라';
      if (!r.rvn) return '출고가가 적힌 판매중 매물이 없거나 아주 적어';
      return '판매중 매물이 10대 이상인 연차가 없어';
    }
    function thinTag(what) { return ' <span class="v2-mtag" title="판매중 ' + SPEED_N + '대 미만이라 ' + what + '을 붙이지 않습니다">표본 적음</span>'; }
    function speed(ratio) {                                  // 판매 속도 카드와 같은 기준(±15%)
      var w = ratio >= 1.15 ? ['빠름', 'up'] : ratio <= 0.87 ? ['느림', 'dn'] : ['비슷', ''];
      return ' <span class="v2-pill ' + w[1] + '">' + w[0] + '</span>';
    }
    function segIdx(seg) {                                   // 동급 시세지수 = market_index 차급 시리즈의 마지막 값(없으면 구분 전체)
      var s = String(seg).split('·'), keys = [[s[1] + '|' + s[0], segName(seg)], [s[1] + '|전체', s[1] + ' 전체']];
      for (var i = 0; i < keys.length; i++) {
        var pts = (X.mi && X.mi.series || {})[keys[i][0]] || [];
        for (var j = pts.length - 1; j >= 0; j--) if (pts[j]['시세'] != null) return { v: pts[j]['시세'], name: keys[i][1] };
      }
      return null;
    }

    // ───── 자료 받기(한 번만, 실패도 기억) ─────
    function getIdx() {
      if (!idxWait) idxWait = ctx.getJSON('report/index.json').then(function (j) { IDX = j; return j; })
        .catch(function (e) { IDX = { err: e && e.message || String(e), models: {} }; return IDX; });
      return idxWait;
    }
    function getFile(f) {
      if (!f) return Promise.resolve(null);
      if (!WAIT[f]) WAIT[f] = ctx.getJSON('report/' + f).then(function (j) { FILES[f] = j; return j; })
        .catch(function (e) { FILES[f] = { err: e && e.message || String(e) }; return FILES[f]; });
      return WAIT[f];
    }
    function getMM() {
      return Promise.resolve(ctx.mm ? ctx.mm() : null).then(function (j) {
        if (j && j.models && !MM) {                          // 동급 인하 비율 = 같은 차급·구분 세부모델 인하 비율의 판매중 대수 가중 평균
          var by = {}, cut = {};
          j.models.forEach(function (m) {
            by[m.maker + '|' + m.model] = m;
            var c = cut[m.seg + '·' + m.origin] || (cut[m.seg + '·' + m.origin] = [0, 0]);
            if (m.cut != null && m.on) { c[0] += m.cut * m.on; c[1] += m.on; }
          });
          Object.keys(cut).forEach(function (k) { cut[k] = cut[k][1] ? cut[k][0] / cut[k][1] : null; });
          MM = { j: j, by: by, segCut: cut };
        }
        if (!j) MM = MM || { err: true, by: {}, segCut: {}, j: {} };
        return MM;
      });
    }
    function fileModel(k) {                                  // 세부모델의 리포트 자료(없으면 null, 받는 중이면 undefined)
      var o = KEY[k], F = o && FILES[o.file];
      if (!o) return null;
      if (!F) return undefined;
      return F.models && F.models[o.model] || null;
    }
    function load(o) {                                       // 지표·곡선에 필요한 자료 전부(겹쳐 볼 모델 포함)
      setKey(o.mk + '|' + o.model);
      return Promise.all([getIdx(), getMM(), getFile(o.file)].concat(V.cmp.map(function (k) { return getFile(KEY[k] && KEY[k].file); })));
    }
    function setKey(k) { if (V.k !== k) { V.k = k; V.cmp = []; } }   // 세부모델이 바뀌면 겹쳐 보기는 비운다

    // ───── 지표 6개 ─────
    function tile(label, tip, val, unit, sub) {
      return '<div class="card"><div class="eyebrow">' + esc(label) + q(tip) + '</div><div class="v2-big v2-mid" style="margin-top:8px">' + esc(val) +
        (unit ? '<small>' + esc(unit) + '</small>' : '') + '</div><div class="v2-kv">' + sub + '</div></div>';
    }
    function tiles(o) {
      LAST.tiles = o;
      setKey(o.mk + '|' + o.model);
      var k = o.mk + '|' + o.model, wait = !MM || !IDX, mm = MM && MM.by[k], J = MM && MM.j || {}, sg = (J.segments || {})[o.seg] || null, iv = J.speed_interval;
      var r = IDX && IDX.models ? IDX.models[k] : null;
      var none = wait ? '불러오는 중…' : MM.err ? '시장 숫자 파일을 불러오지 못했습니다' : !mm ? '판매중 매물이 없어 생략합니다' : '';
      var t = [], segTxt = function (v) { return '동급 <b>' + v + '</b>'; };
      var thin = mm && mm.on < SPEED_N, spd = function (ratio) { return thin ? thinTag('빠름·느림') : speed(ratio); };
      if (mm && mm.rate_w != null) t.push(tile('주간 판매율', TIP.rate, pc(mm.rate_w), '%',
        (sg && sg.rate_w ? segTxt(pc(sg.rate_w) + '%') + spd(mm.rate_w / sg.rate_w) : '동급 값 없음') +
        (iv ? '<br><span class="v2-dim">구간 ' + md(iv[0]) + '→' + md(iv[1]) + '</span>' : '')));
      else t.push(tile('주간 판매율', TIP.rate, '–', '', none || (iv ? '구간 시작 판매중이 10대 미만이라 생략' : '주간 수집 구간이 아직 없음')));
      if (mm && mm.weeks != null) t.push(tile('재고 소진', TIP.weeks, String(mm.weeks), '주', sg && sg.weeks ? segTxt(sg.weeks + '주') + spd(sg.weeks / mm.weeks) : '동급 값 없음'));
      else t.push(tile('재고 소진', TIP.weeks, '–', '', none || (mm && mm.rate_w === 0 ? '구간에 판매가 없음' : '주간 판매율이 없어 생략')));
      if (mm && mm.dwell != null) t.push(tile('중위 체류일', TIP.dwell, String(mm.dwell), '일', sg && sg.dwell ? segTxt(sg.dwell + '일') + spd(sg.dwell / mm.dwell) : '동급 값 없음'));
      else t.push(tile('중위 체류일', TIP.dwell, '–', '', none || '최근 90일 판매가 5대 미만이라 생략'));
      var sc = MM && MM.segCut ? MM.segCut[o.seg] : null;
      if (mm && mm.cut != null && mm.on) {
        var dc = sc != null ? Math.round(mm.cut * 100) - Math.round(sc * 100) : null;
        t.push(tile('인하 매물', TIP.cut, pc(mm.cut, 0), '%', sc == null ? '동급 값 없음' : segTxt(pc(sc, 0) + '%') +
          (thin ? thinTag('많음·적음') : ' · ' + (dc ? Math.abs(dc) + '%p ' + (dc > 0 ? '많음' : '적음') : '같음'))));
      } else t.push(tile('인하 매물', TIP.cut, '–', '', none || '판매중 매물이 없어 생략'));
      var si = segIdx(o.seg);
      if (mm && mm.pidx != null) {
        var dp = si ? mm.pidx - si.v : null;
        t.push(tile('시세지수', TIP.pidx, Number(mm.pidx).toFixed(1), '', si ? segTxt(si.v.toFixed(1)) + (si.name !== segName(o.seg) ? '(' + esc(si.name) + ')' : '') + ' · ' +
          (Math.abs(dp) < 0.05 ? '같음' : Math.abs(dp).toFixed(1) + ' ' + (dp > 0 ? '높음' : '낮음')) : '동급 값 없음'));
      } else t.push(tile('시세지수', TIP.pidx, '–', '', none || '기준기간이나 최근 신규 매물이 10대 미만이라 생략'));
      if (r && r.rvi != null) t.push(tile('잔존가치 지수', TIP.rvi, r.rvi.toFixed(1), '', '동급 <b>= 100</b> · ' +
        (Math.abs(r.rvi - 100) < 0.05 ? '같음' : Math.abs(r.rvi - 100).toFixed(1) + '% ' + (r.rvi > 100 ? '높음' : '낮음')) + '<br><span class="v2-dim">' + n0(r.rvn) + '대 기준</span>'));
      else t.push(tile('잔존가치 지수', TIP.rvi, '–', '', !IDX ? '불러오는 중…' : !r || !r.on || !r.rvn ? rvWhy(r) + ' 생략' :
        r.rvn < RV_OK ? '잔존율을 계산한 판매중이 ' + n0(r.rvn) + '대라 생략' : '같은 연차 동급 잔존율이 모자라 생략'));
      return '<div class="cv-tiles" id="cvTiles"><div class="cv-thead">' + esc(segName(o.seg) || '차급 미상') + ' 동급 대비 · ' + esc(o.model) + ' 전체(등급 무관)</div>' +
        '<div class="v2-cards cv-tgrid">' + t.join('') + '</div></div>';
    }

    // ───── 감가 곡선 ─────
    function pts(a) { return a.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '); }
    function marker(shape, x, y, r, color, faint, ring) {   // 점 모양 — 원 · 네모 · 세모 · 마름모(흰 테두리로 겹쳐도 보이게)
      var a = ' fill="' + color + '" stroke="var(--bg-1)" stroke-width="' + (ring || 1.5) + '"' + (faint ? ' opacity="0.4"' : '');
      if (shape === 'square') return '<rect x="' + (x - r * 0.9).toFixed(1) + '" y="' + (y - r * 0.9).toFixed(1) + '" width="' + (r * 1.8).toFixed(1) + '" height="' + (r * 1.8).toFixed(1) + '"' + a + '/>';
      if (shape === 'triangle') return '<polygon points="' + pts([[x, y - r * 1.25], [x + r * 1.15, y + r * 0.85], [x - r * 1.15, y + r * 0.85]]) + '"' + a + '/>';
      if (shape === 'diamond') return '<polygon points="' + pts([[x, y - r * 1.3], [x + r * 1.3, y], [x, y + r * 1.3], [x - r * 1.3, y]]) + '"' + a + '/>';
      return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r + '"' + a + '/>';
    }
    function star(x, y, r, tip) {                            // 내 차 ★ — 말풍선은 마우스가 올라간 요소 자체의 data-tip 만 읽으므로 별에 직접
      var p = [];
      for (var i = 0; i < 10; i++) { var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; p.push([x + rr * Math.cos(a), y + rr * Math.sin(a)]); }
      return '<polygon points="' + pts(p) + '" fill="var(--tx-1)" stroke="var(--bg-1)" stroke-width="1.5"' + (tip ? ' data-tip="' + tip + '"' : '') + '/>';
    }
    function keyIcon(st) {                                   // 범례 기호 — 선 모양 + 점 모양
      return '<svg class="cv-key" viewBox="0 0 26 12" aria-hidden="true"><line x1="1" y1="6" x2="25" y2="6" stroke="' + st.c + '" stroke-width="2"' +
        (st.dash ? ' stroke-dasharray="' + st.dash + '"' : '') + '/>' + (st.mk ? marker(st.mk, 13, 6, 3.4, st.c, false, 1) : '') + '</svg>';
    }
    function runs(rows) {                                    // 이어지는 연차끼리(빈 연차에서 끊는다)
      var out = [];
      rows.forEach(function (r, i) { if (!i || r[0] - rows[i - 1][0] > 1) out.push([]); out[out.length - 1].push(r); });
      return out;
    }
    function series(o) {
      var me = fileModel(o.mk + '|' + o.model);
      var s = [{ k: o.mk + '|' + o.model, label: o.model, rv: me && me.rv || [], st: LINES[0], me: true, wait: me === undefined }];
      V.cmp.forEach(function (k, i) {
        var x = KEY[k], fm = fileModel(k), F = x && FILES[x.file];
        s.push({ k: k, label: x.mk + ' ' + x.model, rv: fm && fm.rv || [], st: LINES[i + 1], wait: fm === undefined, err: !!(F && F.err) });
      });
      return s;
    }
    function card(o, me, W) {
      LAST.card = { o: o, me: me, W: W };
      setKey(o.mk + '|' + o.model);
      var rvMode = V.unit === 'rv', sr = rvMode && IDX && IDX.seg_rv ? IDX.seg_rv[o.seg] || [] : [], sx = series(o), r = IDX && IDX.models ? IDX.models[o.mk + '|' + o.model] : null;
      var myY = me ? (rvMode ? (me.op ? me.est / me.op : null) : me.est) : null;
      var h = '<div class="card" id="cvCard"><div class="v2-tools"><div class="card-title">감가 곡선' + q(TIP.curve) + ' <span class="hint">' +
        (rvMode ? '차령별 잔존율(호가 ÷ 출고가) · 판매중' : '차령별 호가 가운데 값(만원) · 판매중') + ' · ' + esc(o.model) + ' 전체(등급 무관)</span></div>' +
        '<div class="segmented" role="group" aria-label="세로축">' + [['rv', '잔존율'], ['amt', '금액']].map(function (x) {
          return '<button type="button" data-cv="unit" data-v="' + x[0] + '" aria-pressed="' + (V.unit === x[0]) + '" class="' + (V.unit === x[0] ? 'on' : '') + '">' + x[1] + '</button>';
        }).join('') + '</div></div>';
      if (!IDX || sx[0].wait) return h + '<p class="v2-kv">감가 곡선 자료를 불러오는 중…</p></div>';
      h += '<div class="v2-legend cv-legend">';
      sx.forEach(function (s, i) {
        var st = s.wait ? ' <span class="v2-dim">불러오는 중…</span>' : s.err ? ' <span class="v2-bad">불러오지 못함</span>' :
          !s.rv.length ? ' <span class="v2-dim">— ' + (i ? esc(rvWhy(IDX.models[s.k])) + ' 선 없음' : '선 없음') + '</span>' : '';
        h += '<span class="cv-lg">' + keyIcon(s.st) + '<span>' + esc(s.label) + st + '</span>' +
          (i ? '<button type="button" class="cv-x" data-cv="rm" data-k="' + esc(s.k) + '" aria-label="겹쳐 보기에서 빼기: ' + esc(s.label) + '" title="빼기">×</button>' : '') + '</span>';
      });
      if (myY != null) h += '<span class="cv-lg"><svg class="cv-key" viewBox="0 0 26 12" aria-hidden="true">' + star(13, 6, 6) + '</svg><span>내 차(추정 시세)</span></span>';
      if (rvMode && sx[0].rv.length) h += '<span><i class="v2-band"></i>가운데 50%</span>';
      if (rvMode && sr.length) h += '<span class="cv-lg">' + keyIcon(SEG_LINE) + '<span>동급 ' + esc(segName(o.seg)) + '</span></span>';
      if (!rvMode && sx.some(function (s) { return s.rv.length; })) h += '<span class="v2-dim">금액은 연차별 가운데 값만 — 가운데 50% 띠와 동급 선은 잔존율에서</span>';
      if (sx.some(function (s) { return s.rv.some(function (x) { return x[5] < RV_OK; }); })) h += '<span><i style="background:var(--tx-3);opacity:.4"></i>' + RV_OK + '대 미만(참고)</span>';
      h += '</div>';
      var any = sx.some(function (s) { return s.rv.length; }) || sr.length;
      if (any) h += svg(o, sx, sr, rvMode, W, me, myY);
      if (!sx[0].rv.length) h += '<p class="v2-kv">이 세부모델은 ' + esc(rvWhy(r)) + ' 감가 곡선을 그리지 않습니다' + (any && sr.length ? '(점선은 동급)' : '') + '.</p>';
      if (me && rvMode && myY == null) h += '<p class="v2-help">비교 매물에 출고가가 없어 잔존율에는 내 차 ★을 찍지 않습니다 — 금액으로 바꾸면 보입니다.</p>';
      if (me && myY != null) h += '<p class="v2-kv">' + myLine(o, sx[0], me, rvMode, myY) + '</p>';
      h += picker(o);
      var hi100 = rvMode && (sx.some(function (s) { return over100(s.rv); }) || over100(sr));
      return h + '<p class="v2-help">' + RVRULE + '</p>' + (hi100 ? '<p class="v2-help">' + OVER100 + '</p>' : '') + '</div>';
    }
    function myLine(o, s, me, rvMode, myY) {                 // ★ 한 줄 설명: 같은 연차 이 모델 가운데 값과 견줌
      var a = Math.min(12, Math.floor(me.age)), row = rowAt(s.rv, a);
      var base = '내 차는 차령 <b>' + me.age.toFixed(1) + '년</b> · 추정 시세 <b>' + man(me.est) + '만</b>' + (me.op ? ' · 잔존율 <b>' + pc(me.est / me.op) + '%</b>(비교 매물 출고가 가운데 ' + man(me.op) + '만 기준)' : '');
      if (!row) return base + '.';
      var mv = rvMode ? row[1] : row[4], d = myY / mv - 1;
      return base + ' — 같은 연차(' + ageTxt(a) + ') ' + esc(o.model) + ' 가운데 ' + (rvMode ? pc(row[1]) + '%' : man(row[4]) + '만') + '보다 <b>' +
        (Math.abs(d) < 0.005 ? '비슷' : Math.abs(d * 100).toFixed(1) + '% ' + (d > 0 ? '높음' : '낮음')) + '</b>(등급·주행·상태가 달라 차이가 날 수 있음).';
    }
    function picker(o) {
      if (V.cmp.length >= MAX_CMP) return '<p class="v2-help">겹쳐 보기는 ' + MAX_CMP + '개까지입니다 — 범례의 ×로 빼고 다시 고르세요.</p>';
      var by = {}, me = String(o.seg).split('·')[1] || '', k0 = o.mk + '|' + o.model;    // 차급별 후보 — 같은 차급이 맨 위, 다음은 같은 국산/수입 → 판매중 많은 차급 순
      Object.keys(IDX.models).forEach(function (k) {
        var x = IDX.models[k];
        if (KEY[k] && k !== k0 && V.cmp.indexOf(k) < 0 && x.rvn >= 10) (by[x.seg || ''] = by[x.seg || ''] || []).push(k);
      });
      var on = function (k) { return IDX.models[k].on; }, segs = Object.keys(by).map(function (s) {
        var t = 0;
        by[s].forEach(function (k) { t += on(k); });
        return { s: s, t: t, r: s === o.seg ? 0 : (s.split('·')[1] || '') === me ? 1 : 2 };
      }).sort(function (a, b) { return (a.r - b.r) || (b.t - a.t); });
      if (!segs.length) return '';
      var mo = function (k) { var x = KEY[k]; return opt(k, x.mk + ' ' + x.model + (yrTxt(x) ? ' (' + yrTxt(x) + ')' : '') + ' · 판매중 ' + n0(on(k)) + '대'); };
      return '<div class="cv-cmp"><select class="filter-select" data-cv="cmp" aria-label="다른 모델 겹쳐 보기"><option value="">+ 다른 모델 겹쳐 보기 (최대 ' + MAX_CMP + '개 · 같은 차급이 맨 위)</option>' +
        segs.map(function (x) {
          return '<optgroup label="' + esc((x.r ? '' : '같은 차급 · ') + (segName(x.s) || '차급 미상')) + '">' + by[x.s].sort(function (a, b) { return on(b) - on(a); }).map(mo).join('') + '</optgroup>';
        }).join('') + '</select></div>';
    }
    function svg(o, sx, sr, rvMode, W, me, myY) {
      var H = Math.max(230, Math.min(340, Math.round(W * 0.42))), L = 46, R = 12, T = 24, B = 40, pw = W - L - R, ph = H - T - B, slot = pw / 13;
      var x = function (a) { return L + (Math.min(a, 12) + 0.5) * slot; };
      var val = function (r) { return rvMode ? r[1] : r[4]; };
      var hi = myY || 0;
      sx.forEach(function (s) { s.rv.forEach(function (r) { hi = Math.max(hi, rvMode && s.me ? r[3] : val(r)); }); });
      sr.forEach(function (r) { hi = Math.max(hi, r[1]); });
      hi = (hi || 1) * 1.08;
      var y = function (v) { return T + (1 - v / hi) * ph; };
      var m0 = sx[0], last = m0.rv[m0.rv.length - 1];
      var h = '<svg class="v2-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('감가 곡선 — ' + o.model + ' 차령별 ' + (rvMode ? '잔존율' : '호가 가운데 값') +
        (last ? ', ' + ageTxt(last[0]) + ' ' + (rvMode ? pc(last[1]) + '%' : man(last[4]) + '만원') : '') + (myY != null ? ', 내 차 ' + (rvMode ? pc(myY) + '%' : man(myY) + '만원') : '') +
        (sx.length > 1 ? ', 겹쳐 본 모델 ' + (sx.length - 1) + '개' : '')) + '">';
      niceTicks(0, hi, 5).forEach(function (t) {
        h += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(t).toFixed(1) + '" y2="' + y(t).toFixed(1) + '" stroke="' + (t ? 'var(--line)' : 'var(--line-hard)') + '" stroke-width="1"/>' +
          '<text x="' + (L - 6) + '" y="' + (y(t) + 4).toFixed(1) + '" text-anchor="end">' + (rvMode ? Math.round(t * 100) + '%' : compact(t)) + '</text>';
      });
      var step = slot < 22 ? 2 : 1, a;
      for (a = 0; a <= 12; a += step) h += '<text x="' + x(a).toFixed(1) + '" y="' + (H - B + 16) + '" text-anchor="middle">' + (a === 12 ? '12+' : a) + '</text>';
      h += '<text x="' + (L + pw / 2).toFixed(1) + '" y="' + (H - 5) + '" text-anchor="middle">차령(년) · 12+ = 12년 이상</text>' +
        '<text x="0" y="' + (T - 10) + '">' + (rvMode ? '잔존율' : '만원') + '</text>';
      if (rvMode) runs(m0.rv).forEach(function (run) {        // 이 모델 가운데 50% 띠 — 연차 하나뿐이면 세로 막대
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
      for (var si = sx.length - 1; si >= 0; si--) {          // 겹쳐 본 모델부터 그려 이 모델이 맨 위
        var s = sx[si], st = s.st;
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
        var tip = colTip(o, a, sx, sr);
        if (tip) h += '<rect class="cv-col" x="' + (L + a * slot).toFixed(1) + '" y="' + T + '" width="' + slot.toFixed(1) + '" height="' + ph + '" fill="transparent" data-tip="' + esc(tip) + '"/>';
      }
      if (myY != null) {                                      // 내 차 ★ — 차령은 연차 칸 안 실제 위치(3.4년 → 3~4년 칸의 40%)
        var mx = L + Math.min(me.age, 12.99) * slot, my = y(myY);
        var mt = esc('내 차: 차령 ' + me.age.toFixed(1) + '년 · 추정 시세 ' + man(me.est) + '만' + (me.op ? ' · 잔존율 ' + pc(me.est / me.op) + '%' : ''));
        h += '<g class="cv-me">' +
          '<line x1="' + mx.toFixed(1) + '" x2="' + mx.toFixed(1) + '" y1="' + my.toFixed(1) + '" y2="' + (T + ph) + '" stroke="var(--tx-2)" stroke-width="1" stroke-dasharray="2 3" pointer-events="none"/>' +
          star(mx, my, 8, mt) + '<text x="' + (mx + 10).toFixed(1) + '" y="' + (my - 8).toFixed(1) + '" class="cv-melab" data-tip="' + mt + '">내 차</text></g>';
      }
      return h + '</svg>';
    }
    function colTip(o, a, sx, sr) {
      var out = ['차령 ' + ageTxt(a)];
      sx.forEach(function (s) {
        var r = rowAt(s.rv, a);
        if (r) out.push(s.label + ': 잔존율 ' + pc(r[1]) + '%' + (s.me ? '(가운데 50% ' + pc(r[2]) + '~' + pc(r[3]) + '%)' : '') +
          ' · 호가 ' + man(r[4]) + '만 · ' + n0(r[5]) + '대' + (r[5] < RV_OK ? '(' + RV_OK + '대 미만 · 참고)' : ''));
      });
      var g = rowAt(sr, a);
      if (g) out.push('동급 ' + segName(o.seg) + ': 잔존율 ' + pc(g[1]) + '% · ' + n0(g[4]) + '대');
      return out.length > 1 ? out.join('\n') : '';
    }

    // ───── 다시 그리기 · 조작 ─────
    function refresh() {                                     // 자료가 온 뒤 지표 줄·곡선만 그 자리에서 다시
      var t = document.getElementById('cvTiles'), c = document.getElementById('cvCard');
      if (t && LAST.tiles) t.outerHTML = tiles(LAST.tiles);
      if (c && LAST.card) c.outerHTML = card(LAST.card.o, LAST.card.me, LAST.card.W);
    }
    function redrawCard(focus) {                             // focus = 다시 그린 뒤 초점을 둘 곳(키보드로 쓰던 자리를 잃지 않게)
      var c = document.getElementById('cvCard');
      if (!c || !LAST.card) return;
      var had = c.contains(document.activeElement);
      c.outerHTML = card(LAST.card.o, LAST.card.me, LAST.card.W);
      if (!had || !focus) return;
      var f = null;
      for (var i = 0; i < focus.length && !f; i++) f = document.querySelector(focus[i]);
      if (f) f.focus({ preventScroll: true });
    }
    var PICK = '#cvCard select[data-cv="cmp"]', FIRST_RM = '#cvCard [data-cv="rm"]';
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('#cvCard [data-cv]');
      if (!b || b.tagName === 'SELECT') return;
      var w = b.getAttribute('data-cv');
      if (w === 'unit') { V.unit = b.getAttribute('data-v'); redrawCard(['#cvCard [data-cv="unit"][data-v="' + V.unit + '"]']); }
      if (w === 'rm') { var k = b.getAttribute('data-k'); V.cmp = V.cmp.filter(function (x) { return x !== k; }); redrawCard([PICK, FIRST_RM]); }
    });
    document.addEventListener('change', function (e) {
      var s = e.target;
      if (!s.matches || !s.matches(PICK) || !s.value) return;
      if (V.cmp.indexOf(s.value) < 0 && V.cmp.length < MAX_CMP) V.cmp.push(s.value);
      var k = s.value;
      redrawCard([PICK, FIRST_RM]);
      getFile(KEY[k] && KEY[k].file).then(function () { redrawCard([PICK, FIRST_RM]); });
    });
    return { tiles: tiles, card: card, load: load, refresh: refresh, state: V };
  }

  var api = { create: create };
  root.V2Curve = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
