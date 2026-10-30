/*
 * pulse.js — 새 사이트(v2) 마켓 펄스 화면 (기획안 5.5.1: 숫자 4묶음 · 이번 주 요약 · 주목할 모델 · 차급별 이번 주 · 매물 경고)
 *
 * 데이터: ../data/pulse.json(pulse_data.py — 이번 목록과 지난주 목록 비교)
 *         ../data/report/index.json(model_report.py — 이상 의심·오래 안 팔리는 매물 수, 없으면 그 카드만 뺀다)
 * 위쪽 전체·국산·수입 선택(주소 ?o=)이 아래 전부에 적용된다(요약 문장만 전체 시장 기준). 비교는 지난주 대비 — 지난주 값이 없거나
 * 수집 간격이 5~16일이 아니면 화살표 대신 '짧음'과 이유(Q84·Q88). 유관부서·외부가 보는 화면이라 팀 내부 기준값은 넣지 않는다(Q83).
 *
 *   var P = V2Pulse.create(ctx);   P.show(el, params);      // ctx = app.js subCtx() — 데이터·도우미(bindTips·reportHref·hash 등)
 */
(function (root) {
  'use strict';

  var SEGS = ['경차', '소형', '준중형', '중형', '대형', '스포츠', 'SUV', 'RV', '승합', '화물'];
  var ORIGINS = ['전체', '국산', '수입'];
  var IRREG = [5, 16], TOP = 5;
  var TIP = {                                                // 용어 설명(? 말풍선)
    on: '엔카 상세 화면까지 확인한 판매중 매물 수입니다(목록 관측일 기준).',
    fresh: '직전 목록 뒤 엔카에 새로 올라온 매물입니다. 목록 간격이 7일이 아니면 7일 기준으로 맞춘 값입니다.',
    other: '지난 목록에는 없었지만 엔카 등록일이 지난 목록을 받은 날이거나 그보다 앞선 매물입니다(지난 목록을 받은 뒤 같은 날 올라온 매물, 등록하고 한참 뒤에 ' +
      '목록에 나타난 매물 등). 신규 유입에는 세지 않으므로 판매중 재고 변화 = 신규 유입 − 판매 + 그 밖 유입입니다.',
    sold: '판매는 거래를 직접 확인한 값이 아니라 추정입니다. 지난 목록에 있다가 이번 목록에서 사라진 매물을 판매로 셉니다(다시 올린 매물은 뺌). ' +
      '판매자가 그냥 내린 매물도 섞일 수 있습니다.',
    rate: '주간 판매율 = 지난주 판매중이던 매물 가운데 한 주 동안 팔린(목록에서 사라진) 비율입니다. 목록 간격이 7일이 아니면 7일 기준으로 맞춥니다.',
    weeks: '재고 소진 주수 = 지금 판매율이 이어질 때 판매중 매물이 다 팔리는 데 걸리는 주 수(1 ÷ 주간 판매율)입니다. 길수록 재고가 쌓이는 중입니다.',
    same: '같은 매물 = 지난주와 이번 주 목록에 모두 있고 엔카 상세 화면까지 확인한 판매중 매물입니다. 같은 차의 호가가 어떻게 바뀌었는지만 보므로, ' +
      '새로 들어오고 팔려 나가는 매물 구성에 흔들리지 않습니다. 큰 숫자는 그 매물들의 호가 합계 변화입니다. 더미 가격·인수금 의심·가격 이상·핵심 정보가 빠진 매물과 ' +
      '제조사를 모르는 매물은 빼고, 한 주에 호가가 절반 아래로 내리거나 2배 넘게 오른 관측도 호가 입력 오류로 보고 뺍니다.',
    idx: '지수 = 7월 초(기준기간 목록) 수준을 100으로 둔 값입니다. 시세 = 새로 올라온 매물의 호가를 같은 모델·등급의 기준기간 매물과 조건을 맞춰 비교 · ' +
      '판매속도 = 판매율을 기준기간과 비교 · 재고 = 목록 매물 수를 기준기간과 비교 · 시황 = 세 지수를 묶은 값(재고는 적을수록 높게). 시황 102 이상 강세, 98 이하 약세입니다.',
    low: '이상 의심 매물 = 같은 세부모델의 다른 매물로 이 매물의 시세를 추정했을 때(시세 산정과 같은 방법) 호가가 추정의 75%보다 낮고 추정 신뢰도가 A·B인 ' +
      '판매중 매물입니다. 이상 매물을 걸러낼 때 참고하세요. 사고·상태 차이나 호가 입력 오류처럼 목록에 드러나지 않은 사정일 수 있어 매물마다 확인이 필요합니다.',
    old: '오래 안 팔리는 매물 = 엔카에 올라온 지 1년(365일) 이상 되었고 첫 호가보다 값을 내린 판매중 매물입니다.',
    fast: '주간 판매율이 같은 차급(국산·수입 구분)의 1.15배 이상인 세부모델입니다. 배수가 큰 순으로 5개까지(판매중 100대 이상).',
    slow: '주간 판매율이 같은 차급(국산·수입 구분)의 0.87배 이하인 세부모델 가운데 재고 소진 주수가 긴 순으로 5개까지입니다(판매중 100대 이상). ' +
      '판매중이 지난주보다 늘었으면(재고 증가) 함께 적습니다 — 전남광주 누락이나 수집 범위가 두 목록에서 다르면 적지 않습니다.',
    down: '새로 올라온 매물로 잰 세부모델 시세 지수(7월 초 = 100)가 지난주보다 내린 모델입니다. 표본 수로 생기는 흔들림의 2배(최소 0.5)를 넘는 것만, ' +
      '많이 내린 순으로 5개까지(판매중 100대 이상).',
    up: '새로 올라온 매물로 잰 세부모델 시세 지수(7월 초 = 100)가 지난주보다 오른 모델입니다. 표본 수로 생기는 흔들림의 2배(최소 0.5)를 넘는 것만, ' +
      '많이 오른 순으로 5개까지(판매중 100대 이상).'
  };
  var MOVE = [['fast', '빨리 팔리는'], ['slow', '쌓이는'], ['down', '가격 내리는'], ['up', '가격 오르는']];
  var NONE = { fast: '판매율이 차급의 1.15배 이상인 모델이 없습니다.', slow: '판매율이 차급의 0.87배 이하인 모델이 없습니다.',
    down: '흔들림 기준을 넘게 내린 모델이 없습니다.', up: '흔들림 기준을 넘게 오른 모델이 없습니다.' };

  function create(ctx) {
    var esc = ctx.esc, el = null, P = null, R = null, wait = null, err = null, HAVE = {}, V = { o: '전체' };
    ((ctx.X.idx || {}).makers || []).forEach(function (mk) {          // 모델 리포트가 있는 세부모델(시세 산정 비교 목록과 같은 범위)
      mk.groups.forEach(function (g) { g.models.forEach(function (m) { HAVE[mk.name + '|' + g.name + '|' + m.name] = true; }); });
    });

    // ───── 도우미 ─────
    function md(s) { return (+s.slice(5, 7)) + '/' + (+s.slice(8, 10)); }
    function plusDays(s, n) { return new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10) + n)).toISOString().slice(0, 10); }
    function cnt(v) { return v == null ? '–' : Math.round(v).toLocaleString('ko-KR'); }
    function rate(r) { return r == null ? '–' : (r * 100).toFixed(1) + '%'; }                    // 0~1 비율 → 13.0%
    function f1(v) { return v == null ? '–' : Number(v).toFixed(1); }
    function sgn(v) { return v == null ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1); }   // 이미 % 인 값 → −0.5
    function cutAmt(v) { var a = Math.abs(v); return (Math.round(a) ? '−' : '') + cnt(a) + '만'; }   // 내린 금액(양수) → −50만(모델 리포트와 같은 표기)
    function jo(w, a, b) {                                    // 받침 있으면 a(과·은), 없으면 b(와·는)
      var c = w.charCodeAt(w.length - 1);
      return w + (c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28 ? a : b);
    }
    function segName(o, s) { return o + ' ' + s; }
    function q(t) { return '<span class="v2-q" tabindex="0" role="note" aria-label="' + esc(t) + '" data-tip="' + esc(t) + '">?</span>'; }
    function shortTag(why) {                                  // 지난주 값이 없을 때 화살표 대신(이유는 말풍선)
      return '<span class="v2-pill v2-pshort" tabindex="0" role="note" aria-label="' + esc('짧음: ' + why) + '" data-tip="' + esc(why) + '">짧음</span>';
    }
    function arrow(d, k, unit) {                              // 반올림해 0 이면 '변화 없음'(−0.0% 처럼 보이지 않게)
      var a = Math.abs(d).toFixed(k);
      return +a === 0 ? '변화 없음' : (d > 0 ? '▲' : '▼') + (k ? a : Number(a).toLocaleString('ko-KR')) + (unit || '');
    }
    function change(cur, prev, mode) {                        // mode: pct = 대수 % 변화 · pp = 0~1 비율 차(%p) · ppv = % 값 차(%p) · pt = 지수 차 · wk = 주 차
      if (cur == null || prev == null || (mode === 'pct' && !prev)) return '';
      if (mode === 'pct') {                                   // 0.0% 로 반올림되는 작은 변화는 대수 차로
        var p = (cur / prev - 1) * 100;
        return +Math.abs(p).toFixed(1) === 0 && cur !== prev ? arrow(cur - prev, 0, '대') : arrow(p, 1, '%');
      }
      if (mode === 'pp') return arrow((cur - prev) * 100, 1, '%p');
      return arrow(cur - prev, 1, mode === 'ppv' ? '%p' : mode === 'wk' ? '주' : '');
    }
    function vs(cur, prev, mode, kind) {                      // 카드 한 줄의 지난주 대비: 화살표 또는 '짧음'
      if (cur == null) return '';
      var c = change(cur, prev, mode);
      return c ? '<span class="v2-pd">' + c + '</span>' : shortTag(why(kind));
    }

    // ───── '짧음'의 이유 ─────
    function crawlAt(d) {                                     // market_index.json 수집 회차 중 그 목록일
      var cs = (ctx.X.mi && ctx.X.mi.crawls) || [];
      for (var i = 0; i < cs.length; i++) if (cs[i].date === d) return { i: i, all: cs };
      return null;
    }
    function prevWhy() {                                      // 지난 목록(prev)의 그 앞 간격
      var x = crawlAt(P.prev), g = x ? x.all[x.i].gap_days : undefined;
      if (g === undefined) return '주간 수집이 아닌 회차라';
      if (g == null) return '첫 수집이라';
      return g > IRREG[1] ? g + '일 공백 뒤 첫 회차라' : '직전 목록과 ' + g + '일 간격이라';
    }
    function nextWeek() { return md(plusDays(P.date, 7)); }
    var NAME = { on: '판매중', fresh: '신규 유입', sold: '판매', rate: '판매율', px: '같은 매물 가격 변화' };   // pulse.json notes 의 지표 이름
    function whenNote() {                                     // notes 중 '지난주 대비는 …가 11/4 수집부터, …가 11/11 수집부터 나옵니다(…).'
      var n = P.notes || [];
      for (var i = 0; i < n.length; i++) if (n[i].indexOf('지난주 대비는 ') === 0) return n[i];
      return null;
    }
    function startOf(kind) {                                  // 그 지표의 지난주 대비 시작 회차('11/11') — 전남광주 복귀 주는 데이터가 건너뜀
      if (kind === 'idx') return nextWeek();                  // 지수는 지난 회차 값만 있으면 된다
      if (P.starts) return P.starts[NAME[kind]] ? md(P.starts[NAME[kind]]) : null;   // pulse.json starts(지표 → 첫 회차)
      var n = whenNote(), m = {};                             // 예전 파일: notes 문장에서 읽는다
      if (!n) return null;
      n.replace(/^지난주 대비는 /, '').replace(/ 나옵니다[\s\S]*$/, '').split(', ').forEach(function (p) {
        var r = /^(.+?)[이가] (\d{1,2}\/\d{1,2}) 수집부터$/.exec(p);
        if (r) r[1].split('·').forEach(function (k) { m[k] = r[2]; });
      });
      return m[NAME[kind]] || null;
    }
    function why(kind) {                                      // kind: on·fresh(판매중·신규) · sold · rate · px · idx · all(위쪽 줄)
      if (!P.prev) return '첫 수집이라 지난주 값이 없습니다.';
      if (!P.weekly) return '이번 목록이 지난 목록(' + md(P.prev) + ')과 ' + P.days + '일 간격이라 주간 비교를 하지 않습니다(5~16일일 때만).';
      if (!P.prev_weekly && kind !== 'on') {
        var head = '지난주(' + md(P.prev) + ' 목록)는 ' + prevWhy() + ' 그 주 값이 없습니다.', d = kind === 'all' ? null : startOf(kind);
        return kind === 'all' ? head : head + (d ? ' 지난주 대비는 ' + d + ' 수집부터 나옵니다.' : ' 지난주 대비가 언제부터 나오는지는 아래 \'참고\'를 보세요.');
      }
      if (kind === 'on' || kind === 'fresh') return '전남광주 매물이 빠진 목록과 다시 잡힌 목록 사이라 지난주와 비교하지 않습니다.';
      if (kind === 'sold') return '전남광주 누락이나 목록 누락 의심으로 판매가 어긋난 주라 지난주와 비교하지 않습니다.';
      if (kind === 'px') return '지난주 같은 매물 가격 관측이 없습니다.';
      return '지난주 값이 없습니다(표본 부족).';
    }
    function weeklyRun() {                                    // 이번 목록까지 매주(5~16일 간격) 이어진 수집 회차 수
      var x = crawlAt(P.date), n = 1;
      if (!x) return 0;
      for (var i = x.i; i > 0 && x.all[i].gap_days >= IRREG[0] && x.all[i].gap_days <= IRREG[1]; i--) n++;
      return n;
    }

    // ───── ① 위쪽 줄 ─────
    function top() {
      var seg = '<div class="segmented" role="group" aria-label="국산·수입 구분">' + ORIGINS.map(function (o) {
        return '<button type="button" data-m="o" data-v="' + esc(o) + '" class="' + (V.o === o ? 'on' : '') + '" aria-pressed="' + (V.o === o) + '">' + esc(o) + '</button>';
      }).join('') + '</div>';
      var when = !P ? '' : md(P.date) + ' 목록' + (!P.prev ? '' : P.weekly ? ' · 지난주 ' + md(P.prev) + ' 대비' + (P.days !== 7 ? '(' + P.days + '일 간격)' : '')
        : ' · 지난 목록 ' + md(P.prev) + '(' + P.days + '일 전)');
      return '<div class="v2-ptop"><h2 class="v2-ptitle">마켓 펄스' + (when ? ' <span>' + esc(when) + '</span>' : '') + '</h2>' + seg + shortLine() + '</div>';
    }
    function shortLine() {                                    // 매주 수집이 짧은 동안: '짧음' + 이유(Q88)
      if (!P || (P.prev && P.weekly && P.prev_weekly)) return '';
      var run = weeklyRun(), n = whenNote(), txt = !P.prev ? '첫 수집이라 지난주와 비교할 숫자가 없습니다.'
        : !P.weekly ? '지난 목록과 ' + P.days + '일 간격이라 이번 주 신규·판매·판매율·같은 매물 가격 변화를 내지 않습니다.'
        : (n ? n.replace(/\([^()]*\)\.$/, '.')                  // 지표별 시작 회차는 pulse.json notes 문장 그대로(이유는 '짧음' 말풍선)
          : '지난주 대비 신규·판매·판매율·같은 매물 가격 변화가 언제부터 나오는지는 아래 \'참고\'를 보세요.') + pauseSame() + nowSame();
      return '<div class="v2-pshortline">' + shortTag(why('all')) + (run > 1 ? '<b>매주 수집 ' + run + '회째</b>' : '') + '<span>' + esc(txt) + '</span></div>';
    }
    function pauseSame() {                                    // 앞으로 한 주 쉬는 지표(전남광주 복귀 주) — 자세한 날짜는 참고
      return (P.notes || []).some(function (t) { return t.indexOf('비교하지 않습니다 — ') >= 0; })
        ? ' 전남광주 매물이 다시 들어오는 주에는 일부 지표를 한 주 쉽니다(아래 참고).' : '';
    }
    function nowSame() {                                      // 지금도 지난주와 비교하는 것 — ' 판매중 재고와 시세·재고 지수는 지난주와 비교합니다.'
      var g = P.groups[V.o + '|전체'] || P.groups['전체|전체'] || {}, ip = g.idx_prev || {}, a = [];
      var ix = ['시세', '판매속도', '재고', '시황'].filter(function (k) { return ip[k] != null; });
      if (g.on_prev != null) a.push('판매중 재고');
      if (ix.length) a.push(ix.join('·') + ' 지수');
      if (!a.length) return '';
      var s = a.length > 1 ? jo(a[0], '과', '와') + ' ' + a[1] : a[0];
      return ' ' + jo(s, '은', '는') + ' 지난주와 비교합니다.';
    }

    // ───── ② 숫자 4묶음 ─────
    function tile(label, tip, big, unit, delta, body, foot) {
      return '<div class="card v2-pcard"><div class="eyebrow">' + esc(label + (V.o !== '전체' ? ' · ' + V.o : '')) + q(tip) + '</div>' +
        '<div class="v2-big v2-mid">' + big + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</div>' +
        '<div class="v2-pdelta">' + delta + '</div>' + (body ? '<div class="v2-prows">' + body + '</div>' : '') +
        (foot ? '<p class="v2-pfoot">' + esc(foot) + '</p>' : '') + '</div>';
    }
    function row(k, tip, v, d) {
      return '<div class="v2-prow"><span class="k">' + k + (tip ? q(tip) : '') + '</span><span class="v">' + v + (d ? ' ' + d : '') + '</span></div>';
    }
    function deltaLine(cur, prev, mode, kind, base) {         // 큰 숫자 아래: 지난주 대비 또는 '짧음' + 무엇이 없는지
      if (cur == null) return shortTag(why(kind)) + '<span>이번 주 값 없음</span>';
      var c = change(cur, prev, mode);
      return c ? '<span class="v2-pd">' + c + '</span><span>' + esc(base) + '</span>' : shortTag(why(kind)) + '<span>지난주 대비 없음</span>';
    }
    function weekFoot() {
      return P.weekly && P.days !== 7 ? '구간이 ' + P.days + '일이라 /주 값은 7일 기준으로 맞춘 값입니다.' : '';
    }
    function otherIn(g) {                                     // 판매중 재고 변화 − (신규 − 판매) = 지난 목록에 없던 예전 등록 매물(신규 유입에 세지 않음)
      if (!P.weekly || g.on_prev == null || g.new_w == null || g.sold_w == null) return null;
      return g.on - g.on_prev - Math.round((g.new_w - g.sold_w) * P.days / 7);   // /주 값을 구간 대수로 되돌림(7일이면 그대로)
    }
    function stockTile(g) {
      var o = otherIn(g);
      return tile('판매중 재고', TIP.on, cnt(g.on), '대', deltaLine(g.on, g.on_prev, 'pct', 'on', '지난주 ' + cnt(g.on_prev) + '대 대비'),
        row('신규 유입', TIP.fresh, g.new_w != null ? '<b>' + cnt(g.new_w) + '</b>대/주' : '–', vs(g.new_w, g.new_w_prev, 'pct', 'fresh')) +
        (o != null ? row('그 밖 유입', TIP.other, '<b>' + (o > 0 ? '+' : o < 0 ? '−' : '') + cnt(Math.abs(o)) + '</b>대' + (P.days !== 7 ? '(약)' : '')) : ''), weekFoot());
    }
    function soldTile(g) {
      return tile('판매(추정)', TIP.sold, cnt(g.sold_w), g.sold_w != null ? '대/주' : '', deltaLine(g.sold_w, g.sold_w_prev, 'pct', 'sold', '지난주 ' + cnt(g.sold_w_prev) + '대 대비'),
        row('주간 판매율', TIP.rate, '<b>' + rate(g.rate_w) + '</b>', vs(g.rate_w, g.rate_w_prev, 'pp', 'rate')) +
        row('재고 소진', TIP.weeks, g.weeks != null ? '<b>' + f1(g.weeks) + '</b>주' : g.rate_w === 0 ? '판매 없음' : '–', vs(g.weeks, g.weeks_prev, 'wk', 'rate')));
    }
    function stack(x) {                                       // 같은 매물 내림·그대로·올림 비율 막대
      var flat = Math.max(0, 1 - x.cut - x.up), parts = [['dn', x.cut, '내린 매물'], ['flat', flat, '그대로'], ['up', x.up, '올린 매물']];
      var lab = '같은 매물 ' + cnt(x.n) + '대 중 ' + parts.map(function (p) { return p[2] + ' ' + rate(p[1]); }).join(', ');
      return '<div class="v2-pstack" role="img" aria-label="' + esc(lab) + '">' + parts.filter(function (p) { return p[1] > 0; }).map(function (p) {
        return '<i class="' + p[0] + '" style="flex:' + (p[1] * 100).toFixed(2) + ' 1 0" data-tip="' + esc(p[2] + ' ' + rate(p[1]) + '(약 ' + cnt(p[1] * x.n) + '대)') + '"></i>';
      }).join('') + '</div>';
    }
    function priceTile(g) {
      var x = g.px, xp = g.px_prev || {};
      if (!x) return tile('같은 매물 가격 변화', TIP.same, '–', '', deltaLine(null, null, '', 'px', ''), '', '');
      var cut = '<b>' + rate(x.cut) + '</b>' + (x.cut_med_pct != null ? ' · 중앙 ' + sgn(x.cut_med_pct) + '%' + (x.cut_med_amt != null ? '·' + cutAmt(x.cut_med_amt) : '') : '');
      return tile('같은 매물 가격 변화', TIP.same, sgn(x.chg_wtd), '%', deltaLine(x.chg_wtd, xp.chg_wtd, 'ppv', 'px', '지난주 ' + sgn(xp.chg_wtd) + '% 대비'),
        stack(x) + row('<i class="v2-pkey dn"></i>내린 매물', '', cut, vs(x.cut, xp.cut, 'pp', 'px')) +
        row('<i class="v2-pkey up"></i>올린 매물', '', '<b>' + rate(x.up) + '</b>', vs(x.up, xp.up, 'pp', 'px')),
        '두 목록에 모두 있는 ' + cnt(x.n) + '대의 호가 합계 기준입니다(매물별 가운데 값 ' + sgn(x.chg_med) + '%).' +
        (x.n_bad ? ' 호가가 절반 아래·2배 넘게 바뀐 ' + cnt(x.n_bad) + '대는 입력 오류로 보고 뺐습니다.' : ''));
    }
    function idxTile(g) {
      var i = g.idx || {}, ip = g.idx_prev || {};
      var lab = i.label ? ' <span class="v2-mlab ' + (i.label === '강세' ? 'up' : i.label === '약세' ? 'down' : '') + '">' + esc(i.label) + '</span>' : '';
      var r = function (k) { return row(k, '', '<b>' + f1(i[k]) + '</b>', vs(i[k], ip[k], 'pt', 'idx')); };
      var bp = (ctx.X.mi || {}).base_period, tip = bp ? TIP.idx.replace('기준기간 목록', md(bp[0]) + '~' + md(bp[1]) + ' 목록') : TIP.idx;
      return tile('지수 · 7월 초 = 100', tip, f1(i['시황']) + '<small>시황</small>' + lab, '', deltaLine(i['시황'], ip['시황'], 'pt', 'idx', '지난주 ' + f1(ip['시황']) + ' 대비'),
        r('시세') + r('판매속도') + r('재고'), '');
    }
    function cards() {
      var g = P.groups[V.o + '|전체'];
      if (!g) return '<div class="card"><p class="v2-kv">' + esc(V.o) + ' 숫자가 이번 파일에 없습니다.</p></div>';
      return '<div class="v2-pcards">' + stockTile(g) + soldTile(g) + priceTile(g) + idxTile(g) + '</div>';
    }

    // ───── ③ 이번 주 요약 ─────
    function summaryCard() {
      var s = P.summary || [], n = P.notes || [], li = function (t) { return '<li>' + esc(t) + '</li>'; };
      return '<div class="card"><div class="card-title">이번 주 요약 <span class="hint">자동 문장 · 기준을 넘는 변화만' + (V.o !== '전체' ? ' · 전체 시장 기준' : '') + '</span></div>' +
        (s.length ? '<ul class="v2-notes">' + s.map(li).join('') + '</ul>' : '<p class="v2-kv">이번 주에는 기준을 넘는 변화가 없어 요약 문장을 만들지 않았습니다.</p>') +
        (n.length ? '<div class="v2-ssub">참고</div><ul class="v2-pnotes">' + n.map(li).join('') + '</ul>' : '') + '</div>';
    }

    // ───── ④ 주목할 모델 ─────
    function modelName(mk, grp, model) {                      // 모델 리포트 링크(대상이 아니면 이름만)
      var name = esc(mk + ' ' + model);
      return HAVE[mk + '|' + grp + '|' + model] ? '<a class="v2-link" href="' + esc(ctx.reportHref(mk, grp, model)) + '">' + name + '</a>'
        : '<span class="nm" title="모델 리포트 대상이 아닙니다(비교 매물이 적음)">' + name + '</span>';
    }
    function moverRow(kind, m) {
      var s = segName(m.origin, m.seg), v, sub;
      if (kind === 'fast') { v = '주 ' + rate(m.rate_w); sub = s + ' ' + rate(m.seg_rate) + '의 ' + m.ratio.toFixed(1) + '배'; }
      else if (kind === 'slow') {
        var rm = R && R.models && R.models[m.maker + '|' + m.model], oc = rm ? rm.on_chg : null;   // 판매중 지난주 대비(모델 리포트 index)
        v = m.weeks != null ? f1(m.weeks) + '주' : '판매 없음';
        sub = s + ' ' + (m.seg_weeks != null ? f1(m.seg_weeks) + '주' : '–') + ' · 판매율 주 ' + rate(m.rate_w) + (oc ? ' · 재고 ' + arrow(oc * 100, 1, '%') : '');
      }
      else { v = arrow(m.d, 1); sub = s + ' · 시세 ' + f1(m.p0) + '→' + f1(m.p1) + ' · 흔들림 ±' + f1(m.se); }
      return '<li>' + modelName(m.maker, m.group, m.model) + '<span class="v">' + esc(v) + '</span><small>' + esc(sub + ' · 판매중 ' + cnt(m.on) + '대') + '</small></li>';
    }
    function moversCard() {
      var M = (P.movers || {})[V.o] || {};
      var h = '<div class="card"><div class="card-title">주목할 모델 <span class="hint">' + (V.o !== '전체' ? esc(V.o) + ' · ' : '') +
        '판매중 100대 이상 세부모델 · 누르면 모델 리포트</span></div><div class="v2-pmv">';
      MOVE.forEach(function (k) {
        var rows = M[k[0]] || [];
        h += '<section><div class="v2-ssub">' + esc(k[1]) + q(TIP[k[0]]) + '</div>' + (rows.length
          ? '<ol class="v2-plist">' + rows.map(function (m) { return moverRow(k[0], m); }).join('') + '</ol>'
          : '<p class="v2-pnone">' + esc(P.weekly ? NONE[k[0]] : '주간 수집 간격이 아니라 이번 주에는 고르지 않았습니다.') + '</p>') + '</section>';
      });
      return h + '</div><p class="v2-help">' + esc((P.weekly ? '판매율은 ' + md(P.prev) + '→' + md(P.date) + ' 구간, ' : '') +
        '빨리 팔리는·쌓이는 모델은 같은 차급(국산·수입 구분)의 판매율과, 가격 내리는·오르는 모델은 지난주 세부모델 시세 지수와 견줍니다. ' +
        '흔들림 = 표본 수로 생기는 오차로, 그 2배를 넘는 변화만 고릅니다.') + '</p></div>';
    }

    // ───── ⑤ 차급별 이번 주 ─────
    function marketHref(k) {                                  // 차급 → 시장 시황(추이)
      var p = k.split('|'), s = new URLSearchParams();
      if (p[0] !== '전체') s.set('o', p[0]);
      if (p[1] !== '전체') s.set('s', p[1]);
      return '#/market' + (s.toString() ? '?' + s.toString() : '');
    }
    function td(v, sub) { return '<td class="num"><b>' + v + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</td>'; }
    function th(label, tip, cur, prev, kind) {                // 머리글 — 이 구분 전체에 지난주 값이 없으면 '짧음'
      return '<th class="num">' + label + (tip ? q(tip) : '') + (cur != null && prev == null ? ' ' + shortTag(why(kind)) : '') + '</th>';
    }
    function segRow(k, first) {
      var g = P.groups[k], s = k.split('|')[1], x = g.px, xp = g.px_prev || {};
      var name = s !== '전체' ? s : V.o === '전체' ? '전체' : V.o + ' 전체';
      var cutSub = [change(x && x.cut, xp.cut, 'pp'), x && x.cut_med_pct != null ? '중앙 ' + sgn(x.cut_med_pct) + '%' : ''].filter(Boolean).join(' · ');
      return '<tr class="' + (first ? 'v2-ptot' : '') + (g.low_sample ? ' v2-plow' : '') + '"><td><a class="v2-link" href="' + esc(marketHref(k)) + '" title="시장 시황에서 추이 보기">' + esc(name) + '</a>' +
        (g.low_sample ? ' <span class="v2-mtag">표본 적음</span>' : '') + '</td>' +
        td(cnt(g.on), change(g.on, g.on_prev, 'pct')) + td(cnt(g.new_w), change(g.new_w, g.new_w_prev, 'pct')) + td(cnt(g.sold_w), change(g.sold_w, g.sold_w_prev, 'pct')) +
        td(rate(g.rate_w), change(g.rate_w, g.rate_w_prev, 'pp')) + td(x ? sgn(x.chg_wtd) + '%' : '–', x ? change(x.chg_wtd, xp.chg_wtd, 'ppv') : '') +
        td(x ? rate(x.cut) : '–', cutSub) + '</tr>';
    }
    function segTable() {
      var keys = [V.o + '|전체'].concat(SEGS.map(function (s) { return V.o + '|' + s; })).filter(function (k) { return P.groups[k]; });
      if (!keys.length) return '';
      var t = P.groups[keys[0]], x = t.px || {}, xp = t.px_prev || {};
      var h = '<div class="card"><div class="card-title">차급별 이번 주 <span class="hint">' + esc(V.o) + ' · ▲▼ 지난주' + (P.prev ? '(' + md(P.prev) + ')' : '') +
        ' 대비 · 차급을 누르면 시장 시황의 추이</span></div><div class="v2-tablewrap"><table class="t v2-tbl v2-ptbl"><thead><tr><th>차급</th>' +
        th('판매중', TIP.on, t.on, t.on_prev, 'on') + th('신규/주', TIP.fresh, t.new_w, t.new_w_prev, 'fresh') + th('판매/주', TIP.sold, t.sold_w, t.sold_w_prev, 'sold') +
        th('주간 판매율', TIP.rate, t.rate_w, t.rate_w_prev, 'rate') + th('같은 매물 가격 변화', TIP.same, x.chg_wtd, xp.chg_wtd, 'px') +
        th('이번 주 인하', '', x.cut, xp.cut, 'px') + '</tr></thead><tbody>';
      keys.forEach(function (k, i) { h += segRow(k, !i); });
      return h + '</tbody></table></div><p class="v2-help">신규/주·판매/주 = 7일 기준 대수 · 같은 매물 가격 변화 = 두 목록에 모두 있는 매물의 호가 합계 변화 · ' +
        '이번 주 인하 = 그 매물 가운데 이번 주에 값을 내린 비율(중앙 = 내린 매물의 가운데 인하율, 첫 호가 대비 인하 매물 비율과 다름). 흐린 행은 표본이 적은 차급(신규 비교·시작 재고·목록 매물 중 하나가 300대 미만)이라 참고만 하세요.</p></div>';
    }

    // ───── ⑥ 매물 경고 ─────
    function flagList() {                                     // report/index.json 세부모델 → 선택한 구분만
      var out = [];
      Object.keys(R.models).forEach(function (k) {
        var m = R.models[k], sp = String(m.seg || '').split('·'), i = k.indexOf('|');
        if (V.o !== '전체' && sp[1] !== V.o) return;
        out.push({ maker: k.slice(0, i), model: k.slice(i + 1), group: m.group, seg: sp[0], origin: sp[1] || '', on: m.on || 0, low: m.low || 0, old: m.old || 0 });
      });
      return out;
    }
    function flagCol(list, f, label, tip, rule) {
      var tot = 0, on = 0;
      list.forEach(function (m) { tot += m[f]; on += m.on; });
      if (V.o === '전체' && R.flags_total && R.flags_total[f] != null) tot = R.flags_total[f];
      var top = list.filter(function (m) { return m[f] > 0; }).sort(function (a, b) { return b[f] - a[f] || b.on - a.on; }).slice(0, TOP);
      return '<section><div class="eyebrow">' + esc(label) + q(tip) + '</div><div class="v2-big v2-mid">' + cnt(tot) + '<small>대</small></div>' +
        '<div class="v2-kv">시세 비교 대상 세부모델 판매중 ' + cnt(on) + '대의 ' + (on ? (tot / on * 100).toFixed(1) : '–') + '%</div><div class="v2-ssub">많은 세부모델</div>' +
        (top.length ? '<ol class="v2-plist">' + top.map(function (m) {
          return '<li>' + modelName(m.maker, m.group, m.model) + '<span class="v">' + cnt(m[f]) + '대</span><small>' +
            esc(segName(m.origin, m.seg) + ' · 판매중 ' + cnt(m.on) + '대의 ' + (m.on ? (m[f] / m.on * 100).toFixed(1) : '–') + '%') + '</small></li>';
        }).join('') + '</ol>' : '<p class="v2-pnone">해당 매물이 없습니다.</p>') + (rule ? '<p class="v2-help">기준: ' + esc(rule) + '</p>' : '') + '</section>';
    }
    function warnCard() {
      if (!R || !R.models) return '';                         // 파일이 없으면 이 카드만 뺀다
      var list = flagList(), rules = R.rules || {};
      return '<div class="card"><div class="card-title">매물 경고 <span class="hint">' + (V.o !== '전체' ? esc(V.o) + ' · ' : '') + (R.date ? md(R.date) + ' ' : '') +
        '판매중 매물 · 매물 목록은 모델 리포트에서</span></div><div class="v2-pwarn">' +
        flagCol(list, 'low', '이상 의심 매물', TIP.low, rules.low) + flagCol(list, 'old', '오래 안 팔리는 매물', TIP.old, rules.old) + '</div></div>';
    }

    // ───── 그리기 · 이벤트 ─────
    function render() {
      if (!el) return;
      var body = err ? '<div class="card"><p class="v2-kv v2-bad">마켓 펄스 파일을 불러오지 못했습니다: ' + esc(err.message || err) + '</p>' +
          '<p class="v2-help">잠시 뒤 다시 열어 주세요. 주간 수집이 끝나면 새 숫자가 올라옵니다.</p></div>'
        : !P ? '<div class="card"><p class="v2-kv"><span class="spinner v2-spin"></span>마켓 펄스 숫자를 불러오는 중…</p></div>'
        : cards() + summaryCard() + moversCard() + segTable() + warnCard();
      el.innerHTML = top() + body;
      if (!el.hidden) ctx.hash(state());                      // 다른 화면으로 옮긴 뒤 늦게 그려지면 주소를 건드리지 않는다
    }
    function state() { var s = new URLSearchParams(); if (V.o !== '전체') s.set('o', V.o); return s; }
    function setState(s) { V.o = ORIGINS.indexOf(s.get('o')) >= 0 ? s.get('o') : '전체'; }
    function load() {
      if (P || wait) return wait;
      wait = Promise.all([ctx.getJSON('pulse.json'), ctx.getJSON('report/index.json').catch(function () { return null; })])
        .then(function (a) { P = a[0]; R = a[1]; err = null; render(); })
        .catch(function (e) { err = e; wait = null; render(); });          // 다음에 열 때 다시 받는다
      return wait;
    }
    function onClick(e) {
      var b = e.target.closest && e.target.closest('button[data-m]');
      if (!b || b.getAttribute('data-m') !== 'o') return;
      V.o = b.getAttribute('data-v');
      render();
    }

    function show(container, s) {
      if (el !== container) {
        el = container;
        el.addEventListener('click', onClick);
        ctx.bindTips(el);                                     // [data-tip] 말풍선(? · 짧음 · 막대)
      }
      if (s) setState(s);
      render();
      load();
    }
    return { show: show };
  }

  var api = { create: create };
  root.V2Pulse = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
