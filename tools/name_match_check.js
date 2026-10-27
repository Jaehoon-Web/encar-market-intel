// name_match_check.js — 차명 매칭 정확도 (실행은 python tools/name_match_check.py)
//   node tools/name_match_check.js <사례.json> <비교 매물 폴더>
'use strict';
const fs = require('fs');
const path = require('path');
const NM = require(path.join(__dirname, '..', 'web', 'lib', 'name_match.js'));
const PE = require(path.join(__dirname, '..', 'web', 'lib', 'price_engine.js'));

const [casesPath, compsDir] = process.argv.slice(2);
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const index = read(path.join(compsDir, 'index.json'));
const nm = NM.create(index);
const eng = PE.create({ config: index.engine, coef: { models: {}, segments: {}, market: { age: 0, km: 0, rent: 0, color: {} } }, rates: {} });
const groups = {};
const grp = f => groups[f] || (groups[f] = eng.group(read(path.join(compsDir, f))));
const cases = read(casesPath);

const stat = {}, conf = {}, bad = {}, badG = {};
const t0 = Date.now();
for (const c of cases) {
  const s = stat[c.v] || (stat[c.v] = { n: 0, model: 0, grade: 0, trim: 0, gradeN: 0 });
  s.n++;
  const m = nm.refine(nm.model(c.text, c.year), c.text, c.year, grp);
  const okM = m.best && m.best.model === c.exp.model && m.best.maker === c.exp.maker;
  const cf = conf[m.conf] || (conf[m.conf] = { n: 0, ok: 0 });
  cf.n++; if (okM) cf.ok++;
  if (!okM) { (bad[c.v] = bad[c.v] || []).push([c.text, c.year, m.best && m.best.model, c.exp.model]); continue; }
  s.model++;
  const g = nm.grade(grp(m.best.file), m.best.model, c.text);
  s.gradeN++;
  if (g && g.grade === c.exp.grade) {
    s.grade++;
    if (!c.exp.trim || !g.trim || g.trim === c.exp.trim) s.trim++;            // 세부등급은 비우거나 맞으면 정답
  } else (badG[c.v] = badG[c.v] || []).push([c.text, g && g.grade, c.exp.grade]);
}
const pct = (a, b) => (b ? (a / b * 100).toFixed(1) : '–') + '%';
console.log(`\n[방식별] 세부모델 · 등급(세부모델이 맞은 것 중) · 세부등급 충돌 없음 — ${((Date.now() - t0) / 1000).toFixed(1)}초`);
for (const [k, s] of Object.entries(stat)) {
  console.log(`  ${k}: ${s.n.toLocaleString()}건 · 세부모델 ${pct(s.model, s.n)} · 등급 ${pct(s.grade, s.gradeN)} · 세부등급 ${pct(s.trim, s.gradeN)}`);
}
console.log('\n[확신 표시별 세부모델 정답률]');
for (const k of ['high', 'mid', 'low', 'none']) if (conf[k]) console.log(`  ${k}: ${conf[k].n.toLocaleString()}건 · ${pct(conf[k].ok, conf[k].n)}`);
console.log('\n[세부모델 틀린 예] [입력, 연도, 고른 것, 정답]');
for (const [k, list] of Object.entries(bad)) console.log(`  ${k}: ` + list.slice(0, 4).map(x => JSON.stringify(x)).join('  '));
console.log('\n[등급 틀린 예] [입력, 고른 것, 정답]');
for (const [k, list] of Object.entries(badG)) console.log(`  ${k}: ` + list.slice(0, 5).map(x => JSON.stringify(x)).join('  '));
