/*
 * price_engine.js — 시세 산정 엔진 (사이트용, 기획안 5.1.2 · WP1)
 *
 * 파이썬 price_engine.py 와 같은 계산을 한다: 단계별 매칭 → 성능·D3 보정(+판매 매물 시점 보정) → 이상치 → 유사도 가중
 * 중앙값·범위 → 신뢰도 → 환산가·수리비. 같은 값인지는 python price_engine.py --parity 로 판매중 매물 전체를 검증한다.
 * 규칙·설정은 직접 고치지 말고 price_engine.py 에서 바꾼 뒤 다시 내보낸다(엔진 설정은 비교 매물 index.json 의 engine).
 *
 * 입력 파일
 *   비교 매물: index.json(선택 목록·engine) + 모델그룹 파일 g????????.json   ← python price_engine.py --export
 *   보정 계수: /data/adj_coef.json (D3) · 환산 비율: /data/conversion_rates.json
 *
 *   var eng = PriceEngine.create({ config: index.engine, coef: adjCoef, rates: conversionRates });
 *   var grp = eng.group(모델그룹 파일 JSON);
 *   eng.estimate(grp, '그랜저 IG', { grade: '2.4 프리미엄', trim: '', age: 103, km: 137763, rent: 0, color: '검정',
 *                                    dep: 2.5, perf: 8 });                 // dep·perf 가 null 이면 상태 미상
 *   eng.estimateCar(grp, { 모델: '그랜저 IG', 등급: '2.4 프리미엄', 등록연월: 201703, 주행km: 137763, 색상계열: '검정',
 *                          성능: { 감가율: 2.5, 등급: 8 } | null, 수리비: 30, 연료: '가솔린', 연식: 2017 });
 *
 * 결과: est·lo·hi(만원, 범위 25~75%) · n(비교 매물) · out(이상치) · step·stepName · grade(A·B·C) · est0(상태 미상일 때 무사고 기준)
 *       · comps(비교 매물: row·adj(보정가)·sim(유사도 0~100)·outlier) · basis(보정 근거, 만원) · coefLevel(모델·차급·시장)
 */
(function (root) {
  'use strict';

  function own(o, k) { return o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }
  function num(v) { return v === undefined ? 0 : v; }
  // numpy np.round 와 같은 반올림(정확히 .5 이면 짝수 쪽)
  function rint(y) { var f = Math.floor(y), d = y - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); }

  // 가중 분위수: 값 순(같으면 원래 순서)으로 놓고 누적 가중치가 처음으로 q 이상이 되는 값 — 파이썬 wquantile 과 같음
  function wq(v, w, q) {
    var n = v.length, o = new Array(n), c = new Float64Array(n), s = 0, i;
    for (i = 0; i < n; i++) o[i] = i;
    o.sort(function (a, b) { return v[a] - v[b] || a - b; });
    for (i = 0; i < n; i++) { s += w[o[i]]; c[i] = s; }
    var x = q * c[n - 1];
    for (i = 0; i < n && c[i] < x; i++);
    return v[o[Math.min(i, n - 1)]];
  }

  // numpy np.median 과 같음(짝수 개면 가운데 두 값의 평균)
  function median(a) {
    var s = Array.prototype.slice.call(a).sort(function (x, y) { return x - y; }), n = s.length, h = n >> 1;
    return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }

  function create(opt) {
    var E = opt.config, C = opt.coef, R = opt.rates;
    var STEPS = E.steps, COLORS = E.colors, SIM = E.sim, KM_CAP = E.km_cap;
    var MIN = E.min_comps, GOOD = E.good_comps, OUT_MAD = E.out_mad, OUT_FLOOR = E.out_floor, A_WIDTH = E.a_width;

    function vec(e) {
      return [e.age, e.km, e.rent].concat(COLORS.map(function (c) { return num(own(e.color, c)); }));
    }

    // 보정 계수: 모델 값, 없으면 차급 → 시장 값 (파이썬 Group 과 같은 순서)
    function coefFor(key, seg) {
      var m = own(C.models, key);
      if (m) return { b: vec(m), grade: m.grade || {}, trim: m.trim || {}, level: '모델' };
      var s = own(C.segments, seg);
      return { b: vec(s || C.market), grade: {}, trim: {}, level: s ? '차급' : '시장' };
    }

    function feOf(cf, g, t) { return num(own(cf.grade, g)) + num(own(own(cf.trim, g), t)); }

    function group(F) {
      var fi = {}, models = {};
      F.fields.forEach(function (f, i) { fi[f] = i; });
      F.models.forEach(function (m, i) { models[m.name] = { idx: i, seg: m.seg, n: m.n, onsale: m.onsale }; });
      return { F: F, fi: fi, models: models, cache: {} };
    }

    // 세부모델 하나의 비교 후보 배열 — 파일 안 순서 그대로(파이썬 엔진과 같은 순서라 동률 처리도 같다)
    function prepare(grp, name) {
      if (own(grp.cache, name)) return grp.cache[name];
      var M = own(grp.models, name);
      if (!M) return null;
      var F = grp.F, fi = grp.fi, cf = coefFor(F.maker + '|' + name, M.seg);
      var rows = F.rows.filter(function (r) { return r[fi.m] === M.idx; }), n = rows.length;
      var G = { n: n, rows: rows, cf: cf, ids: new Array(n), age: new Float64Array(n), km: new Float64Array(n), x: new Array(n),
        grades: new Array(n), trims: new Array(n), perf: new Float64Array(n), dep: new Float64Array(n), price: new Float64Array(n),
        sold: new Uint8Array(n), tf: new Float64Array(n), fe: new Float64Array(n) };
      for (var i = 0; i < n; i++) {
        var r = rows[i], col = F.colors[r[fi.col]], g = F.grades[r[fi.g]], t = F.trims[r[fi.t]];
        var km = Math.min(r[fi.km], KM_CAP) / 1e4;
        G.ids[i] = r[fi.id]; G.age[i] = r[fi.age]; G.km[i] = km;
        G.x[i] = [r[fi.age], km, r[fi.rent]].concat(COLORS.map(function (c) { return col === c ? 1 : 0; }));
        G.grades[i] = g; G.trims[i] = t; G.perf[i] = r[fi.perf]; G.dep[i] = r[fi.dep] / 100;
        G.price[i] = r[fi.price]; G.sold[i] = r[fi.sold]; G.tf[i] = r[fi.tf];
        G.fe[i] = feOf(cf, g, t);
      }
      grp.cache[name] = G;
      return G;
    }

    /* 대상 차 한 대. t: grade, trim, age(개월), km(km), rent(0/1), color(계열 | null=모름),
       dep(성능감가율 % | null=상태 미상), perf(성능등급 | null), excludeId(비교에서 뺄 매물 ID)
       o: { sold, time, weight, outlier, adjust } — 기본 모두 true. 비교 매물이 5대 미만이면 null */
    function estimate(grp, name, t, o) {
      var G = prepare(grp, name);
      if (!G) return null;
      o = Object.assign({ sold: true, time: true, weight: true, outlier: true, adjust: true }, o || {});
      var known = t.dep != null, tdep = known ? t.dep / 100 : 0, tperf = known ? t.perf : 0;
      var tage = t.age, tkm = Math.min(t.km, KM_CAP) / 1e4, tg = t.grade, tt = t.trim || '';
      var n0 = G.n, i, j, k;
      var base = new Uint8Array(n0), dage = new Float64Array(n0), dkm = new Float64Array(n0), same = new Uint8Array(n0),
        dperf = new Float64Array(n0);
      for (i = 0; i < n0; i++) {
        base[i] = (t.excludeId == null || G.ids[i] !== t.excludeId) && (o.sold || !G.sold[i]) ? 1 : 0;
        dage[i] = Math.abs(G.age[i] - tage);
        dkm[i] = Math.abs(G.km[i] - tkm);
        same[i] = G.grades[i] === tg ? 1 : 0;
        dperf[i] = known ? Math.abs(G.perf[i] - tperf) : 0;
      }
      var step = 0, sel = [];
      for (var s = 0; s < STEPS.length && !step; s++) {
        var st = STEPS[s];
        sel = [];
        for (i = 0; i < n0; i++) {
          if (base[i] && dage[i] <= st[2] && dkm[i] <= st[3] && (!st[1] || same[i]) && (!known || dperf[i] <= st[4])) sel.push(i);
        }
        if (sel.length >= MIN) step = s + 1;
      }
      if (!step) return null;

      var m = sel.length, b = G.cf.b.slice(), nb = b.length;
      if (t.color == null) for (j = 3; j < nb; j++) b[j] = 0;                 // 색상을 모르면 색상 보정 안 함
      var tx = [tage, tkm, t.rent ? 1 : 0].concat(COLORS.map(function (c) { return t.color === c ? 1 : 0; }));
      var tfe = feOf(G.cf, tg, tt);
      var p = new Float64Array(m), adj = new Float64Array(m), la = new Float64Array(m), w = new Float64Array(m);
      var parts = new Array(m), feD = new Float64Array(m), condL = new Float64Array(m), tfL = new Float64Array(m);
      for (k = 0; k < m; k++) {
        i = sel[k];
        var x = G.x[i], pr = new Array(nb);
        for (j = 0; j < nb; j++) pr[j] = (tx[j] - x[j]) * b[j];             // 항목별 로그 보정(차령·주행·렌트·색상)
        var lin = pr[0];
        for (j = 1; j < nb; j++) lin += pr[j];                                // 파이썬과 같은 순서로 더한다
        lin = lin + tfe - G.fe[i];
        var tf = o.time ? G.tf[i] : 1;
        if (!o.adjust) { lin = 0; tf = 1; }
        p[k] = G.price[i] * Math.exp(lin) * tf;
        var cond = known && o.adjust ? (1 - tdep) / (1 - G.dep[i]) : 1;
        adj[k] = p[k] * cond;
        var dist = dage[i] / SIM.age + dkm[i] / SIM.km + SIM.grade * (1 - same[i])
          + SIM.trim * (tt !== '' && G.trims[i] !== '' && G.trims[i] !== tt ? 1 : 0)
          + SIM.perf * dperf[i] + SIM.sold * G.sold[i];
        w[k] = o.weight ? Math.exp(-dist) : 1;
        la[k] = Math.log(adj[k]);
        parts[k] = pr; feD[k] = tfe - G.fe[i]; condL[k] = Math.log(cond); tfL[k] = Math.log(tf);
      }

      // 이상치: 로그 보정가가 가중 중앙값에서 3×MAD(최소 15%)보다 멀면 뺀다. 남는 매물이 5대 미만이면 빼지 않는다
      var med = wq(la, w, 0.5), dev = new Float64Array(m), keep = new Uint8Array(m).fill(1);
      for (k = 0; k < m; k++) dev[k] = Math.abs(la[k] - med);
      if (o.outlier) {
        var thr = Math.max(OUT_MAD * 1.4826 * median(dev), OUT_FLOOR), cnt = 0;
        for (k = 0; k < m; k++) { keep[k] = dev[k] <= thr ? 1 : 0; cnt += keep[k]; }
        if (cnt < MIN) keep.fill(1);
      }
      var lk = [], wk = [], l0 = [];
      for (k = 0; k < m; k++) {
        if (!keep[k]) continue;
        lk.push(la[k]); wk.push(w[k]);
        if (!known) l0.push(Math.log(p[k] / (1 - G.dep[sel[k]])));
      }
      var est = Math.exp(wq(lk, wk, 0.5)), lo = Math.exp(wq(lk, wk, 0.25)), hi = Math.exp(wq(lk, wk, 0.75));
      var n = lk.length, tight = hi / est - 1 <= A_WIDTH && 1 - lo / est <= A_WIDTH;
      var r = { est: est, lo: lo, hi: hi, n: n, out: m - n, step: step, stepName: STEPS[step - 1][0],
        grade: n >= GOOD && step <= 2 && tight ? 'A' : (step <= 4 ? 'B' : 'C'), coefLevel: G.cf.level };
      if (!known) r.est0 = Math.exp(wq(l0, wk, 0.5));                     // 무사고 기준 값(대상 감가율 0)

      // 보정 근거(만원): 항목별 로그 보정의 가중 평균을 추정 시세 기준 금액으로 — 표시용
      var names = ['차령', '주행', '렌트', '색상', '등급', '성능', '시점'], sums = [0, 0, 0, 0, 0, 0, 0], ws = 0, wmax = 0;
      for (k = 0; k < m; k++) wmax = Math.max(wmax, w[k]);
      for (k = 0; k < m; k++) {
        if (!keep[k]) continue;
        var pk = parts[k], colr = 0;
        for (j = 3; j < nb; j++) colr += pk[j];
        var v = [pk[0], pk[1], pk[2], colr, feD[k], condL[k], tfL[k]];
        for (j = 0; j < 7; j++) sums[j] += v[j] * w[k];
        ws += w[k];
      }
      r.basis = {};
      names.forEach(function (nm, q) { r.basis[nm] = Math.round(est * (Math.exp(sums[q] / ws) - 1)); });
      r.comps = sel.map(function (i2, q) {
        return { row: G.rows[i2], adj: adj[q], sim: rint(w[q] / wmax * 100), outlier: !keep[q], sold: !!G.sold[i2] };
      }).sort(function (a, c) { return c.sim - a.sim; });
      return r;
    }

    // 환산 비율(%)과 출처 — 팀 수정 → 모델 예외(기준표 + 가감) → 호가대×차령 기준표 (파이썬 conversion_rate 와 같음)
    function conversionRate(est, ageYears, maker, model, fuel, team) {
      if (team != null) return { rate: +team, source: '팀 수정' };
      var pi = R.price_bands.findIndex(function (b) { return b.max_manwon == null || est <= b.max_manwon; });
      var ai = R.age_bands.findIndex(function (b) { return b.max_years == null || ageYears <= b.max_years; });
      var base = R.rates[pi][ai];
      var ex = (R.model_exceptions || []).find(function (e) {
        return e['제조사'] === maker && e['모델'] === model && (!e['연료'] || e['연료'] === fuel);
      });
      if (ex) return { rate: rint((base + ex['가감']) * 10) / 10, source: '모델 예외' };
      return { rate: base, source: '호가대×차령 기준표' };
    }

    /* 사이트 입력 형태: 모델, 등급, 세부등급, 등록연월(yyyymm), 주행km, 색상계열, 렌트, 성능({감가율, 등급} | null=상태 미상),
       수리비(만원), 연료·연식(환산 비율 모델 예외용), 기준연월(기본 이번 달), 팀환산(%), excludeId */
    function estimateCar(grp, car, o) {
      var now = new Date(), ym = car['기준연월'] || now.getFullYear() * 100 + now.getMonth() + 1;
      var reg = car['등록연월'], perf = car['성능'] || null;
      var age = Math.floor(ym / 100) * 12 + ym % 100 - (Math.floor(reg / 100) * 12 + reg % 100);
      var r = estimate(grp, car['모델'], {
        grade: car['등급'], trim: car['세부등급'] || '', age: age, km: car['주행km'], rent: car['렌트'] ? 1 : 0,
        color: car['색상계열'] || null, dep: perf ? perf['감가율'] : null, perf: perf ? perf['등급'] : null, excludeId: car.excludeId
      }, o);
      if (!r) return null;
      var yrs = Math.floor(ym / 100) - (car['연식'] || Math.floor(reg / 100));
      var cv = conversionRate(r.est, yrs, grp.F.maker, car['모델'], car['연료'], car['팀환산']);
      var fix = +(car['수리비'] || 0);
      r.repair = fix; r.price = r.est - fix; r.range = [r.lo - fix, r.hi - fix];
      r.rate = cv.rate; r.rateSource = cv.source; r.converted = r.est * (1 - cv.rate / 100) - fix;
      return r;
    }

    return { group: group, prepare: prepare, estimate: estimate, estimateCar: estimateCar, conversionRate: conversionRate };
  }

  var api = { create: create };
  root.PriceEngine = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
