// price_engine_parity.js — 사이트 시세 엔진(web/lib/price_engine.js) ↔ 파이썬 엔진(price_engine.py) 일치 검증
// 실행은 python price_engine.py --parity (비교 매물 파일과 정답 자료를 만들어 이 스크립트에 넘긴다)
//   node tools/price_engine_parity.js <정답.json> <비교 매물 폴더> <adj_coef.json> <conversion_rates.json>
'use strict';
const fs = require('fs');
const path = require('path');
const PE = require(path.join(__dirname, '..', 'web', 'lib', 'price_engine.js'));

const [fixturePath, compsDir, coefPath, ratesPath] = process.argv.slice(2);
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const index = read(path.join(compsDir, 'index.json'));
const eng = PE.create({ config: index.engine, coef: read(coefPath), rates: read(ratesPath) });
const { cases, cars } = read(fixturePath);
const groups = {};
const grp = f => groups[f] || (groups[f] = eng.group(read(path.join(compsDir, f))));

// 실수는 상대 오차 1e-9 이내면 같음(실제로는 거의 모두 비트까지 같아야 한다), 나머지는 완전히 같아야 함
const close = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));
let failures = 0;

function compare(title, list, run, numF, exactF) {
  const bad = {};
  let n = 0, fail = 0, none = 0, bitSame = 0, numCount = 0, maxRel = 0, ns = 0n;
  for (const c of list) {
    n++;
    const s = process.hrtime.bigint();
    const got = run(c);
    ns += process.hrtime.bigint() - s;
    if (c.exp == null || got == null) {
      if ((c.exp == null) !== (got == null)) { fail++; (bad['산정 여부'] = bad['산정 여부'] || []).push([c.id, got && got.est, c.exp && c.exp.est]); }
      else none++;
      continue;
    }
    let ok = true;
    for (const f of numF) {
      if (!(f in c.exp)) continue;
      numCount++;
      if (got[f] === c.exp[f]) bitSame++;
      else maxRel = Math.max(maxRel, Math.abs(got[f] - c.exp[f]) / Math.max(1, Math.abs(c.exp[f])));
      if (!close(got[f], c.exp[f])) { ok = false; (bad[f] = bad[f] || []).push([c.id, got[f], c.exp[f]]); }
    }
    for (const f of exactF) {
      if (!(f in c.exp)) continue;
      if (got[f] !== c.exp[f]) { ok = false; (bad[f] = bad[f] || []).push([c.id, got[f], c.exp[f]]); }
    }
    if (!ok) fail++;
  }
  failures += fail;
  const ms = Number(ns) / 1e6;
  console.log(`\n[${title}] ${n.toLocaleString()}건 · 불일치 ${fail.toLocaleString()}건 · 산정 불가(양쪽 같음) ${none.toLocaleString()}건 · ` +
    `실수 ${numCount.toLocaleString()}개 중 비트까지 같음 ${(bitSame / Math.max(numCount, 1) * 100).toFixed(2)}% (최대 상대 차 ${maxRel.toExponential(1)}) · ` +
    `1건 평균 ${(ms / n).toFixed(3)}ms`);
  const keys = Object.keys(bad);
  if (!keys.length) console.log(`  ✓ ${numF.concat(exactF).join('·')} 모두 일치`);
  for (const f of keys) console.log(`  ✗ ${f}: ${bad[f].length.toLocaleString()}건  예) ` + bad[f].slice(0, 3).map(x => JSON.stringify(x)).join('  '));
}

// 1) 판매중 매물 하나씩 — 상태 입력 · 상태 미상 (자기 자신은 비교에서 뺀다)
const t0 = Date.now();
compare('매물 단위 산정', cases, c => {
  const r = eng.estimate(grp(c.f), c.m, { grade: c.grade, trim: c.trim, age: c.age, km: c.km, rent: c.rent, color: c.color,
    dep: c.dep, perf: c.perf, excludeId: c.id });
  if (!r) return null;
  const cv = eng.conversionRate(r.est, c.yrs, c.maker, c.m, c.fuel);
  return Object.assign(r, { rate: cv.rate, src: cv.source });
}, ['est', 'lo', 'hi', 'est0', 'rate'], ['n', 'out', 'step', 'grade', 'src']);
console.log(`  모델그룹 파일 ${Object.keys(groups).length}개 읽음 · 전체 ${((Date.now() - t0) / 1000).toFixed(1)}초`);

// 2) 사이트 입력 형태 — 등록연월·기준연월로 차령 계산, 환산가·수리비 차감까지
compare('사이트 입력(estimateCar)', cars.map(c => Object.assign({ id: c.car.excludeId }, c)), c => {
  const r = eng.estimateCar(grp(c.f), c.car);
  return r && Object.assign(r, { 시세: r.price, 환산가: r.converted, 환산비율: r.rate, 환산출처: r.rateSource });
}, ['est', 'lo', 'hi', 'est0', '시세', '환산가', '환산비율'], ['n', 'step', 'grade', '환산출처']);

// 3) 예시 한 건 — 화면에 나갈 값
const ex = cars.find(c => c.exp && c.car['성능']);
if (ex) {
  const r = eng.estimateCar(grp(ex.f), ex.car);
  const car = ex.car;
  console.log(`\n[예시] ${car['제조사']} ${car['모델']} · ${car['등급']} · ${car['등록연월']} · ${car['주행km'].toLocaleString()}km · ` +
    `성능 ${car['성능']['등급']}등급 · 수리비 ${car['수리비']}만`);
  console.log(`  추정 시세 ${Math.round(r.est).toLocaleString()}만 (범위 ${Math.round(r.lo).toLocaleString()}~${Math.round(r.hi).toLocaleString()}) · ` +
    `신뢰도 ${r.grade} · 비교 ${r.n}대 · ${r.stepName} · 계수 ${r.coefLevel}`);
  console.log(`  수리비 반영 시세 ${Math.round(r.price).toLocaleString()}만 · 환산가 ${Math.round(r.converted).toLocaleString()}만 (비율 ${r.rate}%, ${r.rateSource})`);
  console.log('  보정 근거(만원): ' + Object.entries(r.basis).filter(([, v]) => v).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(' · '));
  console.log('  비교 매물 상위 3: ' + r.comps.slice(0, 3).map(c => `유사도 ${c.sim} · 보정 ${Math.round(c.adj).toLocaleString()}만` +
    (c.sold ? ' · 판매' : '')).join(' / '));
}

console.log(failures ? `\n✗ 불일치 ${failures.toLocaleString()}건` : '\n✓ 전부 일치');
process.exit(failures ? 1 : 0);
