/*
 * cond_table.js — 기록부 가격 반영(기획 v2.32 5.15, 인터뷰 Q213~Q232)
 *
 * 상태 3가지: 교환(X · 용접절단) · 판금(W · 용접) · 수리필요(아직 안 고친 손상 — 요철 · 손상 · 부식 · 흠집 …).
 *   이력 감가 D(교환 · 판금): ln(1 − D) = Σ k번째 곳 배수 × 차값 배수 × 1곳당 값(같은 부위 그룹 · 같은 상태는 cap 곳까지, 골격은 골격 전체로 셈)
 *                                     + 사고 이력 한 번 + 골격 한 번 (차값 배수 — 기획 v2.33 5.16)
 *   차값 배수: 무사고 시세가 band.anchors(만원)일 때 외판 · 골격 값, 사이는 로그 차값으로 이어서(구간 경계에서 값이 튀지 않게)
 *   k번째 곳 배수(order): 감가가 큰 곳부터 — 늘지 않는 배수라 곳을 더하거나 판금을 교환으로 바꿔도 값이 오르지 않는다
 *   수리비(수리필요): 부위별 표준 수리비(만원) — 기록부 밖 부위(범퍼 · 램프 …)도. 수입은 배수
 *   미상: min(비교 매물 평균 감가, 가장 가벼운 사고 감가) — 교환 · 판금을 넣으면 미상보다 같거나 낮다(Q215)
 * 표는 /data/inspection_model.json 의 cond(inspection_score.py 가 내보냄) + 팀이 ⚙에서 고친 것(/api/cond).
 * 시세 엔진(price_engine.js · price_engine.py)이 비교 매물마다 같은 계산을 하므로, 계산 순서를 바꾸면 파이썬도 같이 바꾼다.
 *
 *   var CT = CondTable.create(model);  CT.apply(team);
 *   CT.hist(items, base) → { D, lines: [{ label, pct }], any, frame }   items: [{ part, side, pillar, status }]
 *   CT.compsD(names, price) → D        names: 비교 매물 손상 목록 ['후드(교환)', '쿼터 패널(경미)', …]
 *   CT.repair(items, imported) → { sum, lines: [{ label, won }] } · CT.repairShare() → 환산가에 빼는 수리필요 수리비 몫(%, Q261)
 *   CT.lightAt(price) → 그 차값에서 가장 가벼운 사고 하나의 감가(0~1) · CT.mult(외판|골격, price) → 차값 배수
 */
(function (root) {
  'use strict';

  var STATUS3 = { 교환: '교환', 용접절단: '교환', 판금: '판금', 요철: '수리필요', 손상: '수리필요', 부식: '수리필요', 흠집: '수리필요', 경미: '수리필요', 수리필요: '수리필요' };

  function create(model) {
    var parts = model.parts, generic = model.generic_parts || {}, base = JSON.parse(JSON.stringify(model.cond));
    var T, rows, light, cat = {}, rankOfGroup = {};
    Object.keys(parts).forEach(function (p) { if (parts[p].group) rankOfGroup[parts[p].group] = parts[p].rank; });
    Object.keys(base.outside_cat || {}).forEach(function (c) { base.outside_cat[c].forEach(function (w) { cat[w.replace(/\s+/g, '')] = c; }); });

    function info(part) { return parts[part] || (generic[part] ? parts[generic[part]] : null); }
    function label(it) { return it.part + (it.pillar ? '(' + it.pillar + ')' : '') + (it.side ? '(' + it.side + ')' : ''); }
    function neg(v) { return v == null || !isFinite(v) ? null : Math.min(0, +v); }

    // 팀 수정을 합치고 고친다: 같은 줄에서 교환 ≤ 판금 ≤ 0, 판금이 비면 단계 기본, 한 번 감가 ≤ 0
    function apply(team) {
      T = JSON.parse(JSON.stringify(base));
      if (team && team.rows) team.rows.forEach(function (tr) {
        var r = T.rows.filter(function (x) { return x.key === tr.key; })[0];
        if (r) { if ('교환' in tr) r['교환'] = tr['교환']; if ('판금' in tr) r['판금'] = tr['판금']; }
      });
      if (team && team.once) Object.keys(team.once).forEach(function (k) { if (k in T.once) T.once[k] = team.once[k]; });
      if (team && team.band) ['외판', '골격'].forEach(function (g) { if (team.band[g]) T.band[g] = team.band[g].slice(); });
      if (team && team.order) T.order = team.order.slice();
      if (team && team.auction && T.auction) {
        if (team.auction.count) team.auction.count.forEach(function (row, i) { if (row && T.auction.count[i]) T.auction.count[i] = row.slice(); });
        ['band', 'age'].forEach(function (k) {
          if (team.auction[k]) ['외판', '골격'].forEach(function (g) { if (team.auction[k][g]) T.auction[k][g] = team.auction[k][g].slice(); });
        });
      }
      if (team && team.repair) Object.keys(team.repair).forEach(function (k) {
        if (k === 'outside' && team.repair.outside) Object.keys(team.repair.outside).forEach(function (c) { T.repair.outside[c] = +team.repair.outside[c]; });
        else if (k !== 'outside') T.repair[k] = +team.repair[k];
      });
      rows = {};
      T.rows.forEach(function (r) { rows[r.key] = r; r['판금'] = neg(r['판금']); r['교환'] = neg(r['교환']); });
      T.rows.forEach(function (r) {                            // 교환은 그 줄의 판금(비었으면 단계 판금)보다 덜 깎이지 않게
        var rk = rows[rankOfGroup[r.key]], pg = r['판금'] != null ? r['판금'] : rk ? rk['판금'] : null;
        if (pg != null && r['교환'] != null && r['교환'] > pg) r['교환'] = pg;
      });
      ['사고', '골격'].forEach(function (k) { T.once[k] = neg(T.once[k]) || 0; });
      ['외판', '골격'].forEach(function (g) { T.band[g] = T.band[g].map(function (v) { return Math.max(0, +v); }); });
      var prev = null;                                         // k번째 곳 배수는 늘지 않게
      T.order = T.order.map(function (v) { v = Math.max(0, +v); prev = prev == null ? v : Math.min(prev, v); return prev; });
      if (T.auction) {                                         // 경매 기준 감가: 값 ≤ 0, 곳이 늘면 덜 깎이지 않게, 배수 ≥ 0
        T.auction.count = T.auction.count.map(function (row) {
          var pv = 0;
          return row.map(function (v) { pv = Math.min(pv, Math.min(0, +v)); return pv; });
        });
        ['band', 'age'].forEach(function (k) { ['외판', '골격'].forEach(function (g) { T.auction[k][g] = T.auction[k][g].map(function (v) { return Math.max(0, +v); }); }); });
      }
      light = lightAt(null);
      api.light = light;
      api.table = T;
      return api;
    }

    function rowValue(inf, s) {                               // 부위 그룹 줄(예외) → 단계 줄
      var r = rows[inf.group];
      if (r && r[s] != null && inf.rank !== '골격') return r[s];
      var rk = rows[inf.rank];
      return rk && rk[s] != null ? rk[s] : 0;
    }
    function mult(g, price) {                                 // 차값 배수 — anchors 사이는 로그 차값으로 이어서, 밖이면 끝 값. 값을 모르면 1
      var A = T.band.anchors, V = T.band[g];
      if (price == null || !(price > 0)) return 1;
      if (price <= A[0]) return V[0];
      for (var k = 0; k < A.length - 1; k++) {
        if (price < A[k + 1]) {
          var t = (Math.log(price) - Math.log(A[k])) / (Math.log(A[k + 1]) - Math.log(A[k]));
          return V[k] + t * (V[k + 1] - V[k]);
        }
      }
      return V[V.length - 1];
    }

    // 이력 감가 — 부위(감가가 큰 곳부터 k번째 배수) → 사고 이력 한 번 → 골격 한 번. 파이썬 Cond.hist 와 같은 순서로 더한다
    // lines 의 pct 는 차값 · k번째 배수를 넣은 실제 감가(%), base 는 표 값
    function hist(items, price) {
      var cnt = {}, lines = [], any = false, frame = false, ent = [], mo = mult('외판', price), mf = mult('골격', price);
      (items || []).forEach(function (it) {
        var s = STATUS3[it.status], inf = info(it.part);
        if ((s !== '교환' && s !== '판금') || !inf) return;
        any = true;
        if (inf.rank === '골격') frame = true;
        var key = (inf.rank === '골격' ? '골격' : inf.group) + '|' + s;
        cnt[key] = (cnt[key] || 0) + 1;
        if (cnt[key] > T.cap) { lines.push({ label: label(it) + ' ' + s, pct: 0, capped: true }); return; }
        var v = rowValue(inf, s), line = { label: label(it) + ' ' + s, pct: v, base: v };
        lines.push(line);
        ent.push({ lv: Math.log(1 + v / 100) * (inf.rank === '골격' ? mf : mo), line: line, i: ent.length });
      });
      var L = 0;
      ent.slice().sort(function (a, b) { return a.lv - b.lv || a.i - b.i; }).forEach(function (e, k) {
        var w = T.order[Math.min(k, T.order.length - 1)], c = w * e.lv;
        L += c;
        e.line.pct = (Math.exp(c) - 1) * 100;
        if (w < 1) e.line.nth = k + 1;                         // 몇 번째 곳이라 덜 깎였나(표시용)
      });
      if (any) {
        var a = mo * Math.log(1 + T.once['사고'] / 100);
        L += a; lines.push({ label: '사고 이력(한 번)', pct: (Math.exp(a) - 1) * 100, base: T.once['사고'], once: true });
      }
      if (frame) {
        var f = mf * Math.log(1 + T.once['골격'] / 100);
        L += f; lines.push({ label: '골격(한 번)', pct: (Math.exp(f) - 1) * 100, base: T.once['골격'], once: true });
      }
      return { D: 1 - Math.exp(L), L: L, lines: lines, any: any, frame: frame, mult: { 외판: mo, 골격: mf } };
    }

    function classOf(items) {                                 // 사고 단계(골격 · 외판2 · 외판1 중 가장 높은 것 × 교환 있으면 교환)와 교환 · 판금 곳수
      var has = {}, n = 0, lab = null;
      (items || []).forEach(function (it) {
        var s = STATUS3[it.status], inf = info(it.part);
        if ((s !== '교환' && s !== '판금') || !inf) return;
        n++;
        has[inf.rank + '|' + s] = 1;
      });
      ['골격', '외판2', '외판1'].some(function (rk) {
        return ['교환', '판금'].some(function (s) { if (has[rk + '|' + s]) { lab = rk + '·' + s; return true; } return false; });
      });
      return { label: lab, n: n };
    }
    function interp(A, V, x, logx) {                          // A 칸 사이를 이어서(logx 면 로그 값으로) — 값을 모르면 1, 밖이면 끝 값
      if (x == null || (logx && !(x > 0))) return 1;
      if (x <= A[0]) return V[0];
      for (var k = 0; k < A.length - 1; k++) {
        if (x < A[k + 1]) {
          var t = logx ? (Math.log(x) - Math.log(A[k])) / (Math.log(A[k + 1]) - Math.log(A[k])) : (x - A[k]) / (A[k + 1] - A[k]);
          return V[k] + t * (V[k + 1] - V[k]);
        }
      }
      return V[V.length - 1];
    }
    // 환산가용 경매 기준 사고 감가(0~1, 기획 v2.33) — 사고 단계 × 곳수 기본값 × 차값 배수 × 연식 배수. 표가 없으면 null
    function auctionD(items, price, age) {
      var A = T.auction;
      if (!A) return null;
      var c = classOf(items);
      if (!c.label) return 0;
      var i = A.classes.indexOf(c.label);
      if (i < 0) return null;
      var g = c.label.indexOf('골격') === 0 ? '골격' : '외판', base = A.count[i][Math.min(c.n, 6) - 1];
      var mb = interp(A.band.anchors, A.band[g], price, true), ma = interp(A.age.anchors, A.age[g], age, false);
      return 1 - Math.exp(Math.log(1 + base / 100) * mb * ma);
    }

    function lightAt(price) {                                 // 그 차값에서 가장 가벼운 사고 한 곳 — 미상은 이보다 덜 깎지 않는다(Q215)
      var best = null;
      T.rows.forEach(function (r) {
        var g = r.key === '골격' ? '골격' : '외판', m = mult(g, price);
        ['교환', '판금'].forEach(function (s) {
          var v = r[s];
          if (v == null) return;                               // 빈 칸은 단계 줄 값을 쓰므로 단계 줄에서 이미 셈
          var L = T.order[0] * Math.log(1 + v / 100) * m + mult('외판', price) * Math.log(1 + T.once['사고'] / 100);
          if (g === '골격') L += m * Math.log(1 + T.once['골격'] / 100);
          var d = 1 - Math.exp(L);
          if (best == null || d < best) best = d;
        });
      });
      return best || 0;
    }

    function fromNames(names) {                               // '프론트 휀더(교환)' → { part, status }
      return (names || []).map(function (x) {
        var i = x.lastIndexOf('(');
        return i < 0 ? null : { part: x.slice(0, i), side: null, pillar: null, status: x.slice(i + 1, -1) };
      }).filter(Boolean);
    }
    function compsD(names, price) { return names && names.length ? hist(fromNames(names), price).D : 0; }

    function outsideCat(part) { return cat[String(part).replace(/\s+/g, '')] || '기타'; }
    function repair(items, imported) {                        // 수리필요 부위별 표준 수리비(만원)
      var R = T.repair, x = imported ? R['수입배수'] || 1 : 1, sum = 0, lines = [];
      (items || []).forEach(function (it) {
        if (STATUS3[it.status] !== '수리필요') return;
        var inf = info(it.part), won;
        if (!inf) won = R.outside[outsideCat(it.part)] != null ? R.outside[outsideCat(it.part)] : R.outside['기타'];
        else if (R[it.part] != null) won = R[it.part];
        else won = inf.rank === '골격' ? R['골격'] : R['외판'];
        won = Math.round(won * x);
        sum += won;
        lines.push({ label: label(it) + ' 수리필요', won: won });
      });
      return { sum: sum, lines: lines };
    }
    function repairShare() {                                  // 환산가에 빼는 수리필요 수리비 몫(%) — 경매는 수리할 곳을 소매보다 덜 깎는다(Q261)
      var v = T.repair['환산반영'];
      return v == null || !isFinite(+v) ? 100 : Math.min(100, Math.max(0, +v));
    }

    var api = { create: create, apply: apply, hist: hist, compsD: compsD, fromNames: fromNames, repair: repair, repairShare: repairShare, outsideCat: outsideCat,
      status3: function (s) { return STATUS3[s] || null; }, mult: mult, lightAt: lightAt, classOf: classOf, auctionD: auctionD, info: info, label: label };
    apply(null);
    return api;
  }

  var api = { create: create, STATUS3: STATUS3 };
  root.CondTable = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
