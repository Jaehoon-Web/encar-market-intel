// site_check.mjs — 새 사이트(web/v2) 정적 점검: 파일·데이터 모양·라이브러리 동작을 브라우저 없이 확인 (기획안 WP3 전체 QA)
//   node tools/site_check.mjs
// 1) index.html 이 부르는 파일이 다 있는지  2) 데이터 파일이 읽히고 필요한 항목이 있는지(비교 매물·지수·차종 비교·내려받기)
// 3) 라이브러리를 실제 데이터로 한 번씩 돌려 보기(성능 표기 읽기 → 차명 매칭 → 시세 산정 → 환산 비율 팀 수정 → 엑셀)
// 하나라도 틀리면 종료 코드 1
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB = path.join(ROOT, 'web'), V2 = path.join(WEB, 'v2'), DATA = path.join(WEB, 'data');
const require = createRequire(import.meta.url);
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
let fail = 0, n = 0;
function ok(cond, name, extra) { n++; if (!cond) fail++; console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || extra === undefined ? '' : ' — ' + extra)); }
function section(t) { console.log('[' + t + ']'); }

section('화면 파일');
// 기본 주소(web/index.html)와 /v2/ 는 같은 새 화면, old.html 은 이전 사이트(2026-10-27 교체)
for (const page of ['index.html', 'v2/index.html', 'old.html']) {
  const h = fs.readFileSync(path.join(WEB, page), 'utf8'), dir = path.dirname(path.join(WEB, page));
  const refs = [...h.matchAll(/(?:src|href)="([^"#:]+)"/g)].map(m => m[1]).filter(r => !/^(https?:)?\/\//.test(r));
  const missing = refs.filter(r => !fs.existsSync(path.join(dir, r)));
  ok(!missing.length, `${page}이 부르는 파일 ${refs.length}개가 모두 있음`, missing.join(', '));
}
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'), v2html = fs.readFileSync(path.join(V2, 'index.html'), 'utf8');
for (const f of ['app.js', 'batch.js', 'rates.js', 'market.js', 'pulse.js', 'report.js', 'data.js']) ok(html.includes(`src="v2/${f}"`) && v2html.includes(`src="${f}"`), `${f}를 부름(기본 주소·/v2/)`);
ok(html.includes("location.replace('old.html'") && html.includes('href="old.html"') && !html.includes('noindex'),
  '기본 주소: 이전 사이트 주소(#/overview 등)는 old.html로 보내고, 이전 사이트 링크가 있음');

section('데이터 파일');
const idx = read(path.join(DATA, 'comps', 'index.json'));
const groupFiles = idx.makers.flatMap(m => m.groups.map(g => g.file));
ok(idx.engine && idx.engine.steps && idx.makers.length > 20, `비교 매물 index.json (제조사 ${idx.makers.length}, 모델그룹 ${groupFiles.length})`);
const noFile = groupFiles.filter(f => !fs.existsSync(path.join(DATA, 'comps', f)));
ok(!noFile.length, '모델그룹 파일이 모두 있음', noFile.slice(0, 5).join(', '));
const models = idx.makers.flatMap(m => m.groups.flatMap(g => g.models));
ok(models.every(m => m.y0 && m.y1 && m.y0 <= m.y1), `세부모델 ${models.length}개 모두 연도 범위(y0·y1)`);
const coef = read(path.join(DATA, 'adj_coef.json'));
ok(coef.market && coef.models && Object.keys(coef.models).length > 100, `보정 계수(모델 ${Object.keys(coef.models).length}개)`);
const rates = read(path.join(DATA, 'conversion_rates.json'));
ok(rates.rates.length === rates.price_bands.length && rates.rates.every(r => r.length === rates.age_bands.length), '환산 비율 기준표 모양');
const mi = read(path.join(DATA, 'market_index.json'));
ok(Object.keys(mi.series).length === 33, `시황 지수 구분 ${Object.keys(mi.series).length}개`);
const last = mi.crawls[mi.crawls.length - 1];
ok(mi.crawls.every(c => c.date && 'gap_days' in c && c.list > 0 && c.detail > 0), `수집 회차 ${mi.crawls.length}개(목록·상세 대수 포함)`);
const all = mi.series['전체|전체'];
ok(all[all.length - 1].date === last.date, `전체 지수의 마지막 날짜 = 마지막 수집(${last.date})`);
ok(Object.values(mi.series).every(pts => pts.every((p, i) => !i || p.date > pts[i - 1].date)), '지수 날짜 오름차순');
ok(Object.values(mi.series).every(pts => pts.every(p => (p.new_w == null || p.new_w >= 0) && (p.sold_w == null || p.sold_w >= 0) && p.on >= 0)), '흐름 값이 음수가 아님');
const mm = read(path.join(DATA, 'market_models.json'));
ok(mm.models.length > 500 && mm.models.every(m => m.maker && m.model && m.on > 0 && m.cut >= 0 && m.cut <= 1), `차종 비교 ${mm.models.length}개 모델`);
ok(mm.date === last.date, `차종 비교 기준일 = 마지막 수집(${mm.date})`);
// 마켓 펄스(pulse_data.py) · 모델 리포트(model_report.py) — 기획안 5.5
const pulse = read(path.join(DATA, 'pulse.json'));
ok(pulse.date === last.date && pulse.groups && pulse.groups['전체|전체'] && pulse.groups['전체|전체'].on > 0, `마켓 펄스 pulse.json (기준 ${pulse.date})`);
ok(Object.keys(pulse.groups).length === Object.keys(mi.series).length, `마켓 펄스 구분 ${Object.keys(pulse.groups).length}개 = 시황 지수 구분`);
ok(['전체', '국산', '수입'].every(o => pulse.movers[o] && ['fast', 'slow', 'down', 'up'].every(k => Array.isArray(pulse.movers[o][k]) && pulse.movers[o][k].length <= 5)),
  '주목할 모델 4종 × 전체·국산·수입');
ok(Array.isArray(pulse.summary) && pulse.summary.length <= 3, `이번 주 요약 ${pulse.summary.length}줄`);
const IND = ['판매중', '신규 유입', '판매', '판매율', '같은 매물 가격 변화'];
ok(pulse.starts && typeof pulse.starts === 'object' && Object.keys(pulse.starts).every(k => IND.includes(k)) &&
  Object.values(pulse.starts).every(v => v === null || (/^\d{4}-\d{2}-\d{2}$/.test(v) && v > pulse.date)), '마켓 펄스 지표별 지난주 대비 시작 회차(starts)');
const rep = read(path.join(DATA, 'report', 'index.json'));
ok(rep.date === last.date && Object.keys(rep.models).length >= models.length, `모델 리포트 index (세부모델 ${Object.keys(rep.models).length}개 · 비교 매물 ${models.length}개)`);
ok(rep.date === pulse.date && rep.date === mm.date, `마켓 펄스·모델 리포트·차종 비교 날짜가 같음(${pulse.date} · ${rep.date} · ${mm.date})`);
ok(/365일/.test(rep.rules && rep.rules.old || ''), `오래 안 팔리는 매물 기준 365일 (${rep.rules && rep.rules.old})`);
const haveModel = new Set(idx.makers.flatMap(m => m.groups.flatMap(g => g.models.map(x => `${m.name}|${g.name}|${x.name}`))));
const mvOut = ['전체', '국산', '수입'].flatMap(o => ['fast', 'slow', 'down', 'up'].flatMap(k => pulse.movers[o][k]))
  .filter(x => !haveModel.has(`${x.maker}|${x.group}|${x.model}`)).map(x => `${x.maker} ${x.model}`);
ok(!mvOut.length, '주목할 모델이 모두 모델 리포트로 열림(비교 매물 목록에 있음)', mvOut.slice(0, 5).join(', '));
const repMiss = groupFiles.filter(f => !fs.existsSync(path.join(DATA, 'report', f)));
ok(!repMiss.length, `모델 리포트 그룹 파일 ${groupFiles.length}개가 모두 있음`, repMiss.slice(0, 5).join(', '));
const repBad = [], repConv = [];
for (const f of groupFiles.filter(f => !repMiss.includes(f))) {                // 그룹 파일 전부: 모양 · 날짜 · '환산' 없음
  const txt = fs.readFileSync(path.join(DATA, 'report', f), 'utf8'), g = JSON.parse(txt);
  if (/환산/.test(txt)) repConv.push(f);
  if (g.date !== rep.date || !g.models || !Object.values(g.models).every(m => Array.isArray(m.rv) && Array.isArray(m.flows) && Array.isArray(m.low) &&
    Array.isArray(m.old) && m.cut && 'w' in m.cut && 'on' in m.cut)) repBad.push(f);
}
ok(!repBad.length, `모델 리포트 그룹 파일 ${groupFiles.length - repMiss.length}개 모양(rv·flows·cut·low·old)·날짜`, repBad.slice(0, 5).join(', '));
const noConv = ['v2/pulse.js', 'v2/report.js', 'v2/market.js', 'data/pulse.json', 'data/report/index.json'].filter(f => /환산/.test(fs.readFileSync(path.join(WEB, f), 'utf8')))
  .concat(repConv.map(f => 'data/report/' + f));
const rcsv = new TextDecoder('euc-kr').decode(fs.readFileSync(path.join(WEB, 'downloads', 'residual_curves.csv')));
if (/환산/.test(rcsv)) noConv.push('downloads/residual_curves.csv');
ok(!noConv.length, '마켓 펄스·모델 리포트·시장 시황(외부 공개 화면)과 그 데이터에 환산 문구 없음', noConv.join(', '));
const metaDesc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
ok(metaDesc && !/환산/.test(metaDesc), '공유 미리보기(meta description)에 환산 문구 없음');
const dl = ['market_index.csv', 'market_models.csv', 'residual_curves.csv', 'listings_compact.csv', 'model_price_summary.csv', 'manufacturer_summary.csv',
  'region_summary.csv', 'trend_snapshots.csv', 'history_accumulated.zip'];
const dlMiss = dl.filter(f => !fs.existsSync(path.join(WEB, 'downloads', f)) || fs.statSync(path.join(WEB, 'downloads', f)).size < 100);
ok(!dlMiss.length, `내려받기 파일 ${dl.length}개`, dlMiss.join(', '));
const head = new TextDecoder('euc-kr').decode(fs.readFileSync(path.join(WEB, 'downloads', 'market_models.csv')).subarray(0, 200)).split(/\r?\n/)[0];
ok(head.startsWith('제조사,모델,세부모델'), 'CSV가 CP949(엑셀용)로 읽힘', head);
const big = fs.readdirSync(path.join(WEB, 'downloads')).concat(fs.readdirSync(DATA).map(f => '../data/' + f))
  .filter(f => { const p = path.join(WEB, 'downloads', f); return fs.statSync(p).isFile() && fs.statSync(p).size > 25 * 1048576; });
ok(!big.length, '배포 파일 25MiB 한도 안', big.join(', '));

section('라이브러리 동작(실제 데이터)');
const IS = require(path.join(WEB, 'lib', 'inspection_score.js')), PE = require(path.join(WEB, 'lib', 'price_engine.js'));
const NM = require(path.join(WEB, 'lib', 'name_match.js')), RS = require(path.join(WEB, 'lib', 'rates_store.js'));
const XW = require(path.join(WEB, 'lib', 'xlsx_writer.js'));
for (const f of ['batch.js', 'rates.js', 'market.js', 'pulse.js', 'report.js', 'data.js']) {
  let e = null;
  try { require(path.join(V2, f)); } catch (err) { e = err; }
  ok(!e, `${f} 읽힘`, e && e.message);
}
const isc = IS.create(read(path.join(DATA, 'inspection_model.json')));
const cond = isc.parseText('좌프론트휀더 X, 본넷 W');
ok(cond.items.length === 2 && !cond.unknown.length, '성능 표기 읽기(좌프론트휀더 X, 본넷 W)', JSON.stringify(cond));
const ev = isc.evaluate({ state: '입력', items: cond.items, mechLevel: 0 });
ok(ev['성능등급'] >= 1 && ev['성능등급'] <= 9 && ev['사고라벨'], `성능 계산 → ${ev['사고라벨']} · ${ev['성능등급']}등급`);
const nm = NM.create(idx);
const res = nm.model('더 뉴 그랜저 IG 2.5 프리미엄', 2020);
ok(res.best && res.best.model === '더 뉴 그랜저 IG' && res.conf === 'high', `차명 매칭 → ${res.best && res.best.model} (${res.conf})`);
const eng = PE.create({ config: idx.engine, coef, rates });
const G = eng.group(read(path.join(DATA, 'comps', res.best.file)));
const gr = nm.grade(G, res.best.model, '더 뉴 그랜저 IG 2.5 프리미엄');
ok(gr && gr.grade === '2.5', `등급 매칭 → ${gr && gr.grade} ${gr && gr.trim}`);
const R = eng.estimateCar(G, { '모델': res.best.model, '등급': gr.grade, '세부등급': gr.trim, '등록연월': 202003, '주행km': 60000, '색상계열': '흰색·진주',
  '렌트': false, '성능': { '감가율': ev['성능감가율'], '등급': ev['성능등급'] }, '수리비': 30, '연료': '가솔린' }, { sold: true });
ok(R && R.price > 500 && R.price < 6000 && R.n >= 5 && ['A', 'B', 'C'].includes(R.grade),
  `시세 산정 → ${R && Math.round(R.price)}만(${R && R.grade}, 비교 ${R && R.n}대), 환산 ${R && R.rate}% ${R && R.rateSource}`);
const before = eng.conversionRate(1500, 4, '현대', '더 뉴 그랜저 IG', '가솔린');
RS.apply(rates, { rev: 1, cells: rates.rates.map(r => r.map(() => null)), models: [{ '제조사': '현대', '모델': '더 뉴 그랜저 IG', '연료': '', '비율': 33.3 }] });
const after = eng.conversionRate(1500, 4, '현대', '더 뉴 그랜저 IG', '가솔린');
ok(after.rate === 33.3 && after.source === '팀 수정(모델)' && before.source !== after.source, `환산 비율 팀 수정 반영(${before.rate}% → ${after.rate}%)`);
RS.apply(rates, null);
ok(eng.conversionRate(1500, 4, '현대', '더 뉴 그랜저 IG', '가솔린').rate === before.rate, '팀 수정을 지우면 초기값으로');
const B = require(path.join(V2, 'batch.js'));
ok(B.kmOf('3.8만') === 38000 && B.regOf('22.03').y === 2022 && B.costOf('150,000') === 15 && B.colorOf('펄화이트') === '흰색·진주', '묶음 산정 값 읽기(주행·등록·수리비·색상)');
const t = B.parseTSV('차명\t주행\n"그랜저\nIG"\t3.8만');
ok(t.length === 2 && t[1][0] === '그랜저 IG', '엑셀 붙여넣기(줄바꿈 든 칸)');
const xl = XW.build([{ name: '시험', rows: [['a', 'b'], [1, { v: 1234, money: true }]], header: true }]);
ok(xl && xl.length > 500 && xl[0] === 0x50 && xl[1] === 0x4b, `엑셀 파일 만들기(${xl && xl.length}바이트)`);

console.log(fail ? `\n실패 ${fail}건 / ${n}건` : `\n모두 통과 (${n}건)`);
process.exit(fail ? 1 : 0);
