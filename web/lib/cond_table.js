/*
 * cond_table.js — 기록부 가격 반영(기획 v2.32 5.15, 인터뷰 Q213~Q232)
 *
 * 상태 3가지: 교환(X · 용접절단) · 판금(W · 용접) · 수리필요(아직 안 고친 손상 — 요철 · 손상 · 부식 · 흠집 …).
 *   이력 감가 D(교환 · 판금): ln(1 − D) = Σ 1곳당 값(같은 부위 그룹 · 같은 상태는 cap 곳까지, 골격은 골격 전체로 셈)
 *                                     + 사고 이력 한 번 + 골격 한 번(무사고 시세가 싸면 작게)
 *   수리비(수리필요): 부위별 표준 수리비(만원) — 기록부 밖 부위(범퍼 · 램프 …)도. 수입은 배수
 *   미상: min(비교 매물 평균 감가, 가장 가벼운 사고 감가) — 교환 · 판금을 넣으면 미상보다 같거나 낮다(Q215)
 * 표는 /data/inspection_model.json 의 cond(inspection_score.py 가 내보냄) + 팀이 ⚙에서 고친 것(/api/cond).
 * 시세 엔진(price_engine.js · price_engine.py)이 비교 매물마다 같은 계산을 하므로, 계산 순서를 바꾸면 파이썬도 같이 바꾼다.
 *
 *   var CT = CondTable.create(model);  CT.apply(team);
 *   CT.hist(items, base) → { D, lines: [{ label, pct }], any, frame }   items: [{ part, side, pillar, status }]
 *   CT.compsD(names, price) → D        names: 비교 매물 손상 목록 ['후드(교환)', '쿼터 패널(경미)', …]
 *   CT.repair(items, imported) → { sum, lines: [{ label, won }] }
 *   CT.light → 가장 가벼운 사고 하나의 감가(0~1)
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
      if (team && team.once) Object.keys(team.once).forEach(function (k) { if (k in T.once && k !== '저가') T.once[k] = team.once[k]; });
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
      ['사고', '골격', '골격_저가'].forEach(function (k) { T.once[k] = neg(T.once[k]) || 0; });
      var most = -Infinity;                                    // 가장 가벼운 사고 = 사고 이력 한 번 + 가장 작은 1곳 값
      T.rows.forEach(function (r) { ['교환', '판금'].forEach(function (s) { if (r[s] != null && r[s] > most) most = r[s]; }); });
      light = 1 - (1 + T.once['사고'] / 100) * (1 + (most === -Infinity ? 0 : most) / 100);
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
    function frameOnce(price) {                               // 무사고 시세가 싸면 골격 낙인이 작다(1,000만 아래 → 1,500만 이상, 사이는 직선)
      var lo = T.once['저가'][0], hi = T.once['저가'][1], a = T.once['골격_저가'], b = T.once['골격'];
      if (price == null || price >= hi) return b;
      if (price <= lo) return a;
      return a + (b - a) * (price - lo) / (hi - lo);
    }

    // 이력 감가 — 순서: 부위(적힌 순) → 사고 이력 한 번 → 골격 한 번. 파이썬 cond_hist 와 같은 순서로 더한다
    function hist(items, price) {
      var L = 0, cnt = {}, lines = [], any = false, frame = false;
      (items || []).forEach(function (it) {
        var s = STATUS3[it.status], inf = info(it.part);
        if ((s !== '교환' && s !== '판금') || !inf) return;
        any = true;
        if (inf.rank === '골격') frame = true;
        var key = (inf.rank === '골격' ? '골격' : inf.group) + '|' + s;
        cnt[key] = (cnt[key] || 0) + 1;
        if (cnt[key] > T.cap) { lines.push({ label: label(it) + ' ' + s, pct: 0, capped: true }); return; }
        var v = rowValue(inf, s);
        L += Math.log(1 + v / 100);
        lines.push({ label: label(it) + ' ' + s, pct: v });
      });
      if (any) { L += Math.log(1 + T.once['사고'] / 100); lines.push({ label: '사고 이력(한 번)', pct: T.once['사고'], once: true }); }
      if (frame) { var f = frameOnce(price); L += Math.log(1 + f / 100); lines.push({ label: '골격(한 번)', pct: f, once: true }); }
      return { D: 1 - Math.exp(L), L: L, lines: lines, any: any, frame: frame };
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

    var api = { create: create, apply: apply, hist: hist, compsD: compsD, fromNames: fromNames, repair: repair, outsideCat: outsideCat,
      status3: function (s) { return STATUS3[s] || null; }, frameOnce: frameOnce, info: info, label: label };
    apply(null);
    return api;
  }

  var api = { create: create, STATUS3: STATUS3 };
  root.CondTable = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
