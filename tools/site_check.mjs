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
// 기본 주소(web/index.html)와 /v2/ 는 같은 화면. 이전 사이트(old.html)는 2026-11-03에 지웠다(기획 v2.25)
for (const page of ['index.html', 'v2/index.html']) {
  const h = fs.readFileSync(path.join(WEB, page), 'utf8'), dir = path.dirname(path.join(WEB, page));
  const refs = [...h.matchAll(/(?:src|href)="([^"#:]+)"/g)].map(m => m[1]).filter(r => !/^(https?:)?\/\//.test(r));
  const missing = refs.filter(r => !fs.existsSync(path.join(dir, r)));
  ok(!missing.length, `${page}이 부르는 파일 ${refs.length}개가 모두 있음`, missing.join(', '));
}
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'), v2html = fs.readFileSync(path.join(V2, 'index.html'), 'utf8');
for (const f of ['app.js', 'batch.js', 'rates.js', 'market.js', 'pulse.js', 'curve.js', 'data.js', 'auth.js', 'members.js']) ok(html.includes(`src="v2/${f}"`) && v2html.includes(`src="${f}"`), `${f}를 부름(기본 주소·/v2/)`);
ok(html.indexOf('src="v2/auth.js"') < html.indexOf('src="v2/app.js"') && html.indexOf('src="v2/members.js"') < html.indexOf('src="v2/admin.js"'), 'auth.js는 app.js보다, members.js는 admin.js보다 먼저(로그인 기획)');
ok(html.includes('location.replace(TO[m[1]])') && !/old\.html/.test(html + v2html) && !html.includes('noindex'),
  '기본 주소: 이전 사이트 주소(#/overview 등)는 같은 일을 하는 지금 화면으로, 이전 사이트 링크 없음');
ok(/<title>카리스마R/.test(html) && /카리스마R/.test(v2html) && html.includes('CARISMA · RETAIL'), '사이트 이름 카리스마R(CARISMA · RETAIL)');

section('데이터 파일');
const idx = read(path.join(DATA, 'comps', 'index.json'));
const groupFiles = idx.makers.flatMap(m => m.groups.map(g => g.file));
ok(idx.engine && idx.engine.steps && idx.makers.length > 20, `비교 매물 index.json (제조사 ${idx.makers.length}, 모델그룹 ${groupFiles.length})`);
const noFile = groupFiles.filter(f => !fs.existsSync(path.join(DATA, 'comps', f)));
ok(!noFile.length, '모델그룹 파일이 모두 있음', noFile.slice(0, 5).join(', '));
const models = idx.makers.flatMap(m => m.groups.flatMap(g => g.models));
ok(models.every(m => m.y0 && m.y1 && m.y0 <= m.y1), `세부모델 ${models.length}개 모두 연도 범위(y0·y1)`);
ok(idx.engine.stale && idx.engine.stale.tau > 0 && ['A', 'B', 'C'].every(g => idx.engine.range_k && idx.engine.range_k[g].length === 3 && idx.engine.range_k[g].every(k => k >= 0.8 && k <= 3)),
  `엔진 설정: 오래된 매물 가중(${idx.engine.stale && idx.engine.stale.d0}일 · ${idx.engine.stale && idx.engine.stale.tau}) · 범위 배수(기획 v2.33)`);
const audit = read(path.join(DATA, 'audit.json')), cmk = read(path.join(DATA, 'cond_market.json'));
ok(audit.mdape > 0 && audit.class && audit.class['무사고'] && audit.coverage && audit.coverage.A && Array.isArray(audit.warnings),
  `시세 점검 audit.json(${audit.date} · 오차 가운데 ${audit.mdape}% · 경고 ${audit.warnings.length}건)`);
ok(cmk.classes && cmk.classes['골격·판금'] && cmk.classes['골격·판금'].all && cmk.bands.length === 4, `감가 옆 시장 근거 cond_market.json(${cmk.date})`);
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
// 마켓 펄스(pulse_data.py) · 감가 곡선·동급 지표 데이터(model_report.py) — 기획안 5.5 · 5.7(모델 리포트 탭은 시세 산정으로 합침)
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
ok(rep.date === last.date && Object.keys(rep.models).length >= models.length, `감가 곡선·지표 index (세부모델 ${Object.keys(rep.models).length}개 · 비교 매물 ${models.length}개)`);
ok(rep.date === pulse.date && rep.date === mm.date, `마켓 펄스·감가 곡선·차종 비교 날짜가 같음(${pulse.date} · ${rep.date} · ${mm.date})`);
ok(/365일/.test(rep.rules && rep.rules.old || ''), `오래 안 팔리는 매물 기준 365일 (${rep.rules && rep.rules.old})`);
const haveModel = new Set(idx.makers.flatMap(m => m.groups.flatMap(g => g.models.map(x => `${m.name}|${g.name}|${x.name}`))));
const mvOut = ['전체', '국산', '수입'].flatMap(o => ['fast', 'slow', 'down', 'up'].flatMap(k => pulse.movers[o][k]))
  .filter(x => !haveModel.has(`${x.maker}|${x.group}|${x.model}`)).map(x => `${x.maker} ${x.model}`);
ok(!mvOut.length, '주목할 모델이 모두 시세 산정 모델 요약으로 열림(비교 매물 목록에 있음)', mvOut.slice(0, 5).join(', '));
const repMiss = groupFiles.filter(f => !fs.existsSync(path.join(DATA, 'report', f)));
ok(!repMiss.length, `감가 곡선 그룹 파일 ${groupFiles.length}개가 모두 있음`, repMiss.slice(0, 5).join(', '));
const repBad = [], repConv = [];
for (const f of groupFiles.filter(f => !repMiss.includes(f))) {                // 그룹 파일 전부: 모양 · 날짜 · '환산' 없음
  const txt = fs.readFileSync(path.join(DATA, 'report', f), 'utf8'), g = JSON.parse(txt);
  if (/환산/.test(txt)) repConv.push(f);
  if (g.date !== rep.date || !g.models || !Object.values(g.models).every(m => Array.isArray(m.rv) && Array.isArray(m.flows) && Array.isArray(m.low) &&
    Array.isArray(m.old) && m.cut && 'w' in m.cut && 'on' in m.cut)) repBad.push(f);
}
ok(!repBad.length, `감가 곡선 그룹 파일 ${groupFiles.length - repMiss.length}개 모양(rv·flows·cut·low·old)·날짜`, repBad.slice(0, 5).join(', '));
const noConv = ['v2/pulse.js', 'v2/curve.js', 'v2/market.js', 'data/pulse.json', 'data/report/index.json'].filter(f => /환산/.test(fs.readFileSync(path.join(WEB, f), 'utf8')))
  .concat(repConv.map(f => 'data/report/' + f));
const rcsv = new TextDecoder('euc-kr').decode(fs.readFileSync(path.join(WEB, 'downloads', 'residual_curves.csv')));
if (/환산/.test(rcsv)) noConv.push('downloads/residual_curves.csv');
ok(!noConv.length, '마켓 펄스·감가 곡선·동급 지표·시장 시황(외부 공개 화면)과 그 데이터에 환산 문구 없음', noConv.join(', '));
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
// 데이터 탭은 회원에게 요약 파일만(로그인 기획 Q288) — 매물 단위 원자료 2개는 목록에서 빼고, /downloads/* 는 Worker가 먼저 받아 회원만 · 요약만 준다.
// 마켓 펄스 자료와 비교 매물도 Worker가 먼저 받는다(잠금 · 로그인하지 않은 한도). 잠금 켜기는 [vars] AUTH_ENFORCE.
const shells = ['index.html', path.join('v2', 'index.html')].map(f => fs.readFileSync(path.join(WEB, f), 'utf8'));
const wtoml = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8'), rwf = (/run_worker_first\s*=\s*\[([^\]]*)\]/.exec(wtoml) || [])[1] || '';
const dataJs = fs.readFileSync(path.join(V2, 'data.js'), 'utf8');
ok(shells.every(h => /href="#\/data"/.test(h) && /id="authBox"/.test(h)) && ['"/api/*"', '"/downloads/*"', '"/data/pulse.json"', '"/data/comps/*"'].every(x => rwf.includes(x)) &&
   /\[vars\][\s\S]*AUTH_ENFORCE\s*=\s*"[01]"/.test(wtoml) && /RAW = \['listings_compact\.csv', 'history_accumulated\.zip'\]/.test(dataJs),
  '회원 문: 데이터 탭(요약 파일만 · 원자료 2개 뺌) · 로그인 칸 · Worker가 먼저 받는 주소 4개 · 잠금 스위치 AUTH_ENFORCE', rwf);

section('출처 이름(기획 v2.25)');
// 공개 폴더(web/)의 화면·코드·데이터·내려받기에 출처 사이트 이름이 없어야 한다 — 비교 매물의 원문 매물 링크 주소만 예외(사용자 결정 11-03)
const ALLOW = 'fem.encar.com/cars/detail/', srcHit = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(html|js|css|json|csv|md|txt|svg)$/.test(e.name) && e.name !== '_headers') continue;
    const b = fs.readFileSync(p), t = (e.name.endsWith('.csv') ? new TextDecoder('euc-kr').decode(b) : b.toString('utf8')).split(ALLOW).join('');
    if (/엔카|encar/i.test(t)) srcHit.push(path.relative(WEB, p));
  }
})(WEB);
ok(!srcHit.length, '공개 파일에 출처 사이트 이름 없음(원문 매물 링크 주소만 예외)', srcHit.slice(0, 8).join(', '));
const gone = ['old.html', 'app.js', 'README.md', 'dataset.json', 'insights.json', 'inventory.json', 'models.json', 'pricing.json', 'trend.json']
  .map(f => f.endsWith('.json') ? 'data/' + f : f).filter(f => fs.existsSync(path.join(WEB, f)));
ok(!gone.length, '이전 사이트 파일·이전 사이트 전용 데이터가 공개 폴더에 없음', gone.join(', '));

section('이용 통계(기획 v2.28)');
// 기록 장치는 다른 코드보다 먼저 읽혀야 오류까지 센다 · 바닥글에 익명 수집 안내 · 입력값·조건은 보내지 않는다(Q156·Q159)
const order = h => { const t = h.indexOf('track.js'), a = h.indexOf('app.js'), l = h.indexOf('inspection_score.js'); return t > 0 && t < l && t < a; };
ok(order(html) && order(v2html), 'track.js가 다른 화면 코드보다 먼저 읽힘(두 화면)');
ok(html.includes('이용 통계를 익명으로') && v2html.includes('이용 통계를 익명으로'), '바닥글에 이용 통계 익명 수집 안내(두 화면)');
const trk = fs.readFileSync(path.join(V2, 'track.js'), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
ok(!/\.value\b|innerText|cookie|X-Forwarded|CF-Connecting/i.test(trk), '기록 장치가 입력값·쿠키·IP를 읽지 않음');
const appSrc = fs.readFileSync(path.join(V2, 'app.js'), 'utf8'), calls = appSrc.match(/CT\.result\([^;]*;/g) || [];
ok(calls.length === 2 && calls.every(c => !/S\.(km|y|m|cost|color|cond|items|rate)\b|R\.|price/.test(c.replace(/JSON\.stringify\([^)]*\)\)/, ''))),
  '산정 결과 기록은 모델·등급만(연식·주행·상태·시세 없음)', calls.join(' | '));

const aOrder = h => { const ad = h.indexOf('admin.js'), a = h.lastIndexOf('app.js'); return ad > 0 && ad < a; };
ok(aOrder(html) && aOrder(v2html) && html.includes('href="#/admin"') && v2html.includes('href="#/admin"'), '관리자 화면 코드·링크(두 화면, 기획 v2.28 Q164)');
const ADM = require(path.join(V2, 'admin.js')).create({ esc: s => String(s) });
const mg = ADM._merge([{ day: 'a', sessions: 2, uids: ['u1', 'u2'], dev: { pc: 2, m: 0 }, sec: 100, scr: { pulse: { views: 2, sec: 100, sessions: 2 } }, act: { 'pulse|x': 1 }, models: {}, mmodels: {}, results: 1,
  msum: 0, batch: 0, cars: 0, exports: {}, funnel: [2, 1, 1, 0, 0], depth: [1, 0, 0, 0, 0, 0], last: {}, lastAct: {}, abandon: 0, fields: {}, paths: {}, entry: {}, entryCar: 0, err: {}, errs: [], ready: [800], load: [] },
  { day: 'b', empty: true }, { day: 'c', missing: true },
  { day: 'd', sessions: 1, uids: ['u2'], dev: { pc: 0, m: 1 }, sec: 50, scr: { pulse: { views: 1, sec: 50, sessions: 1 } }, act: { 'pulse|x': 2 }, models: {}, mmodels: {}, results: 0,
  msum: 0, batch: 0, cars: 0, exports: {}, funnel: [1, 0, 0, 0, 0], depth: [0, 0, 0, 0, 0, 0], last: {}, lastAct: {}, abandon: 0, fields: {}, paths: {}, entry: {}, entryCar: 0, err: {}, errs: [], ready: [900], load: [] }]);
ok(mg.visitors === 2 && mg.sessions === 3 && mg.sec === 150 && mg.act['pulse|x'] === 3 && mg.scr.pulse.views === 3 && mg.funnel[0] === 3 && mg.ready.length === 2,
  '관리자 화면: 여러 날 합치기(방문자는 익명 번호 겹침 빼고 2명, 빈 날·못 만든 날 건너뜀)', JSON.stringify([mg.visitors, mg.sessions, mg.sec]));
ok(ADM._actName('price.one|nav:basis') === '목차 → 산정 근거' && ADM._actName('price.one|sort=price') === '비교 매물 정렬: 호가' && ADM._actName('price.batch|batch:run') === '묶음: 산정하기',
  '관리자 화면: 기능 이름을 읽기 쉬운 말로');

section('라이브러리 동작(실제 데이터)');
const IS = require(path.join(WEB, 'lib', 'inspection_score.js')), PE = require(path.join(WEB, 'lib', 'price_engine.js')), CTB = require(path.join(WEB, 'lib', 'cond_table.js'));
const NM = require(path.join(WEB, 'lib', 'name_match.js')), RS = require(path.join(WEB, 'lib', 'rates_store.js'));
const XW = require(path.join(WEB, 'lib', 'xlsx_writer.js'));
for (const f of ['batch.js', 'rates.js', 'market.js', 'pulse.js', 'curve.js', 'data.js']) {
  let e = null;
  try { require(path.join(V2, f)); } catch (err) { e = err; }
  ok(!e, `${f} 읽힘`, e && e.message);
}
for (const f of ['app.js', 'track.js', 'admin.js', 'auth.js', 'members.js']) {   // 화면을 그리는 파일은 여기서 실행할 수 없어 문법만 본다(리뷰 11-05 · 로그인 기획)
  let e = null;
  try { new (require('node:vm').Script)(fs.readFileSync(path.join(V2, f), 'utf8'), { filename: f }); } catch (err) { e = err; }
  ok(!e, `${f} 문법`, e && e.message);
}
{                                                            // 주소(해시) 값은 남이 만든 링크일 수 있다 — 연·월은 숫자만 받는다(공유 링크로 스크립트가 들어가던 결함, 11-05)
  const app = fs.readFileSync(path.join(V2, 'app.js'), 'utf8');
  ok(app.includes(String.raw`if (!/^\d{4}$/.test(s.y)) s.y = '';`) && app.includes(String.raw`if (!/^(?:[1-9]|1[0-2])$/.test(s.m)) s.m = '';`) &&
     app.includes('function regText() { return esc('),
    '주소의 연·월은 숫자만 받고 화면에는 esc로 넣음');
}
const isc = IS.create(read(path.join(DATA, 'inspection_model.json')));
const cond = isc.parseText('좌프론트휀더 X, 본넷 W');
ok(cond.items.length === 2 && !cond.unknown.length, '성능 표기 읽기(좌프론트휀더 X, 본넷 W)', JSON.stringify(cond));
{                                                            // 기록부 글 읽기(기획 v2.31): 소리 맞추기 · 짐작 · 못 읽음 후보 · 팀 사전 · 고른 것
  const a = isc.parseText('프론트 헨다 좌 판, 휜더 우 교환, 도어 수리');
  const [t0, t1, t2] = a.tokens;
  ok(t0.kind === 'ok' && t0.label === '프론트 휀더(좌) 판금' && t1.kind === 'guess' && t1.label === '프론트 휀더(우) 교환' &&
     t2.kind === 'unknown' && t2.cands.some(c => c.label === '도어 판금' && c.save && c.save.t === '수리'),
  '글 읽기 — 같은 소리 · 짐작 · 못 읽음 후보', JSON.stringify(a.tokens.map(t => [t.kind, t.label, t.cands.map(c => c.label)])));
  const b = isc.parseText('도어 수리', { terms: [{ t: '수리', kind: 'status', status: '판금' }] });
  const c = isc.parseText('도어 수리', { picks: { '도어 수리': [{ part: '도어', side: null, pillar: null, status: '교환' }] } });
  ok(b.items.length === 1 && b.items[0].status === '판금' && b.tokens[0].kind === 'ok' && c.tokens[0].kind === 'picked' && c.items[0].status === '교환',
    '글 읽기 — 팀 사전 · 후보에서 고른 것', JSON.stringify([b.tokens, c.tokens]));
}
const ev = isc.evaluate({ state: '입력', items: cond.items, mechLevel: 0 });
ok(ev['성능등급'] >= 1 && ev['성능등급'] <= 9 && ev['사고라벨'], `성능 계산 → ${ev['사고라벨']} · ${ev['성능등급']}등급`);
const nm = NM.create(idx);
const res = nm.model('더 뉴 그랜저 IG 2.5 프리미엄', 2020);
ok(res.best && res.best.model === '더 뉴그랜저IG' && res.conf === 'high', `차명 매칭 → ${res.best && res.best.model} (${res.conf})`);
const CT = CTB.create(read(path.join(DATA, 'inspection_model.json')));
const eng = PE.create({ config: idx.engine, coef, rates, cond: CT });
const G = eng.group(read(path.join(DATA, 'comps', res.best.file)));
const gr = nm.grade(G, res.best.model, '더 뉴 그랜저 IG 2.5 프리미엄');
ok(gr && gr.grade === '가솔린 2.5' && gr.trim === '프리미엄', `등급 매칭 → ${gr && gr.grade} ${gr && gr.trim}`);
const R = eng.estimateCar(G, { '모델': res.best.model, '등급': gr.grade, '세부등급': gr.trim, '등록연월': 202003, '주행km': 60000, '색상계열': '흰색·진주',
  '렌트': false, '상태': { items: cond.items }, '수리비': 30, '연료': '가솔린' }, { sold: true });
ok(R && R.price > 500 && R.price < 6000 && R.n >= 5 && ['A', 'B', 'C'].includes(R.grade),
  `시세 산정 → ${R && Math.round(R.price)}만(${R && R.grade}, 비교 ${R && R.n}대), 환산 ${R && R.rate}% ${R && R.rateSource}`);
{                                                            // 묶음 비교의 보정 차이(기획 v2.29): 같은 계수로 — 오래되고 많이 탄 차는 차령·주행이 음수
  const base = { '모델': res.best.model, '등급': gr.grade, '세부등급': gr.trim, '등록연월': 202003, '주행km': 60000, '색상계열': '흰색·진주', '렌트': false };
  const a = eng.logParts(G, base), b = eng.logParts(G, Object.assign({}, base, { '등록연월': 201903, '주행km': 120000 }));
  ok(a && b && b['차령'] < a['차령'] && b['주행'] < a['주행'] && a.colorKnown && !a.condKnown, '보정 위치(logParts): 1년 더 오래되고 6만km 더 탄 차는 차령·주행이 음수 쪽',
    JSON.stringify([a, b]));
  const f1 = eng.factoryPrice(G, base), f2 = eng.factoryPrice(G, Object.assign({}, base, { '세부등급': '' })), f3 = eng.factoryPrice(G, Object.assign({}, base, { '모델': '없는 모델' }));
  ok(f1 && f1.exact && f1.n >= 3 && f1.op >= f1.lo && f1.op <= f1.hi && f1.op > 2000 && f1.op < 5000 && f2 && !f2.exact && f3 === null,
    `출고가(factoryPrice): 같은 세부등급·등록연도 ${f1 && f1.op}만(${f1 && f1.n}대) · 세부등급 없으면 등급 기준 ${f2 && f2.op}만 · 없는 모델은 없음`, JSON.stringify([f1, f2, f3]));
}
{                                                            // 기록부 가격 반영(기획 v2.32): 비교 매물은 상태와 무관 → 무사고 ≥ 판금 ≥ 교환 · 교환·판금 ≤ 미상 · 수리필요는 수리비
  const car = { '모델': res.best.model, '등급': gr.grade, '세부등급': gr.trim, '등록연월': 202003, '주행km': 60000, '색상계열': '흰색·진주', '렌트': false, '연료': '가솔린' };
  const at = st => eng.estimateCar(G, Object.assign({}, car, { '상태': st }), { sold: true });
  const U = at(null), C = at({ items: [] }), P = at({ items: [{ part: '프론트 패널', status: '판금' }] }), XF = at({ items: [{ part: '후드', status: '교환' }] }),
    WF = at({ items: [{ part: '후드', status: '판금' }] }), RF = at({ items: [{ part: '후드', status: '수리필요' }, { part: '앞범퍼', status: '수리필요', outside: true }] });
  ok(U && C && P && XF && WF && RF && C.price >= WF.price && WF.price >= XF.price && P.price <= U.price && WF.price <= U.price && C.base === P.base && C.base === U.base,
    `기록부 감가 순서 — 무사고 ${Math.round(C.price)} ≥ 후드 판금 ${Math.round(WF.price)} ≥ 교환 ${Math.round(XF.price)} · 프론트 패널 판금 ${Math.round(P.price)} ≤ 미상 ${Math.round(U.price)}`,
    JSON.stringify([C && C.price, WF && WF.price, XF && XF.price, P && P.price, U && U.price]));
  ok(RF && RF.repairAuto === 55 && Math.abs(RF.price - (C.price - 55)) < 1e-6 && Math.abs(P.D - CT.hist([{ part: '프론트 패널', status: '판금' }], P.base).D) < 1e-12 && P.D > 0.02 && P.D < 0.12,
    `수리필요 수리비(후드 30 + 앞범퍼 25 = ${RF && RF.repairAuto}만) · 프론트 패널 판금 감가 ${(P.D * 100).toFixed(2)}%(표와 같음)`, JSON.stringify([RF && RF.repairAuto, P && P.D]));
  // 환산가(v2.33): 기록부를 넣으면 무사고 시세 × (1 − 경매 기준 감가) × (1 − 환산 비율) − 수리비, 미상은 소매 감가 그대로
  ok(P.convD > 0 && Math.abs(P.converted - (P.base * (1 - P.convD) * (1 - P.rate / 100) - P.repairConv)) < 1e-6 && U.convD === U.D && C.convD === 0,
    `환산가 사고 감가 — 프론트 패널 판금 경매 기준 ${(P.convD * 100).toFixed(1)}%(소매 ${(P.D * 100).toFixed(1)}%) · 미상은 소매와 같음`, JSON.stringify([P.convD, P.D, U.convD, U.D]));
  // 환산가 수리비(Q261): 소매 시세는 수리필요 수리비를 다 빼고, 환산가는 반영 몫만 · 직접 입력 수리비는 둘 다 다 뺀다
  const sh = CT.repairShare(), RM = at({ items: [{ part: '후드', status: '수리필요' }] }), RM2 = eng.estimateCar(G, Object.assign({}, car, { '상태': { items: [{ part: '후드', status: '수리필요' }] }, '수리비': 40 }), { sold: true });
  ok(sh > 0 && sh < 100 && RF.repairShare === sh && Math.abs(RF.repairConv - 55 * sh / 100) < 1e-9 && Math.abs(RF.price - (C.price - 55)) < 1e-6 &&
     Math.abs(RF.converted - (RF.base * (1 - RF.convD) * (1 - RF.rate / 100) - RF.repairConv)) < 1e-6 && RF.converted > C.converted - 55 &&
     RM && RM2 && Math.abs((RM.converted - RM2.converted) - 40) < 1e-6 && Math.abs((RM.price - RM2.price) - 40) < 1e-6,
    `환산가 수리비 — 수리필요 55만 중 ${sh}%(${RF && RF.repairConv}만)만 빼고, 직접 입력 40만은 다 뺌 · 소매 시세는 55만 다 뺌`, JSON.stringify([sh, RF && RF.repairConv, RM && RM.converted, RM2 && RM2.converted]));
}
{                                                            // 감가 표 구조(v2.33): 차값이 높으면 사고 차 값도 높다 · 손상을 더하거나 판금→교환이면 값이 오르지 않는다
  const heavy = [{ part: '프론트 패널', status: '교환' }, { part: '크로스 멤버', status: '교환' }, { part: '인사이드 패널', side: '좌', status: '판금' },
    { part: '후드', status: '교환' }, { part: '프론트 휀더', side: '좌', status: '교환' }, { part: '프론트 휀더', side: '우', status: '판금' }, { part: '쿼터 패널', side: '좌', status: '교환' }];
  let prev = 0, mono = true;
  for (let p = 100; p <= 20000; p *= 1.05) { const v = p * (1 - CT.hist(heavy, p).D); if (v < prev - 1e-9) mono = false; prev = v; }
  ok(mono, '차값 배수: 무사고 시세가 오르면 사고 차 값(시세 × (1 − 감가))도 오르거나 같음(100만~2억, 손상 7곳)');
  const parts = ['후드', '프론트 휀더', '프론트 도어', '리어 도어', '트렁크 리드', '쿼터 패널', '루프 패널', '사이드실 패널', '프론트 패널', '크로스 멤버', '리어 패널', '트렁크 플로어'];
  let bad = 0, seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 2000; k++) {
    const items = [], n = 1 + rnd(8), price = 300 + rnd(9000);
    for (let i = 0; i < n; i++) items.push({ part: parts[rnd(parts.length)], side: rnd(2) ? '좌' : '우', status: rnd(2) ? '교환' : '판금' });
    const d0 = CT.hist(items, price).D, more = CT.hist(items.concat([{ part: parts[rnd(parts.length)], side: '좌', status: rnd(2) ? '교환' : '판금' }]), price).D;
    const up = items.map(x => x.status === '판금' ? Object.assign({}, x, { status: '교환' }) : x), dUp = CT.hist(up, price).D;
    if (more < d0 - 1e-12 || dUp < d0 - 1e-12) bad++;
  }
  ok(!bad, `곳 배수: 손상 하나를 더하거나 판금을 교환으로 바꿔도 감가가 줄지 않음(무작위 2,000건 · 어긋남 ${bad})`);
  ok([300, 800, 1500, 3000, 6000].every(p => CT.lightAt(p) > 0 && CT.lightAt(p) <= CT.hist([{ part: '사이드실 패널', side: '좌', status: '판금' }], p).D + 1e-12),
    '가장 가벼운 사고(미상의 하한)는 어떤 한 곳 사고보다 같거나 작음(차값마다)');
}
const before = eng.conversionRate(1500, 4, '현대', '더 뉴 그랜저 IG', '가솔린');
RS.apply(rates, { rev: 1, cells: rates.rates.map(r => r.map(() => null)), models: [{ '제조사': '현대', '모델': '더 뉴 그랜저 IG', '연료': '', '비율': 33.3 }] });
const after = eng.conversionRate(1500, 4, '현대', '더 뉴 그랜저 IG', '가솔린');
ok(after.rate === 33.3 && after.source === '팀 수정(모델)' && before.source !== after.source, `환산 비율 팀 수정 반영(${before.rate}% → ${after.rate}%)`);
RS.apply(rates, null);
ok(eng.conversionRate(1500, 4, '현대', '더 뉴 그랜저 IG', '가솔린').rate === before.rate, '팀 수정을 지우면 초기값으로');
const B = require(path.join(V2, 'batch.js'));
ok(B.kmOf('3.8만') === 38000 && B.regOf('22.03').y === 2022 && B.costOf('150,000') === 15 && B.colorOf('펄화이트') === '흰색·진주', '묶음 산정 값 읽기(주행·등록·수리비·색상)');
ok(B.kmOf('4만5천') === 45000 && B.regOf('19년 3월').y === 2019 && B.regOf('19년 3월').m === 3, '묶음 산정 값 읽기(4만5천 · 19년 3월)');
const ym = v => { const r = B.regOf(v); return r ? r.y + '-' + r.m : null; };
const xd = ['Mar-19', 'Mar-02', 'Jul-2021', 'March 2019', '2019-Mar', '1-Mar-19', '01 Mar 2019', '3/1/2019', '2019년 3월', '2019. 3. 1.'].map(ym);
ok(xd.join() === '2019-3,2002-3,2021-7,2019-3,2019-3,2019-3,2019-3,2019-3,2019-3,2019-3', '엑셀이 바꾼 날짜 모양 읽기(Mar-19 · 1-Mar-19 · 3/1/2019 …)', xd.join());
ok(B.regOf('Foo-19') === null && B.formTSV().includes('2019년 3월'), '달 이름이 아니면 날짜로 안 읽음 · 양식 최초등록은 엑셀이 안 바꾸는 2019년 3월');
const pf = [B.pullFromText('그랜저 IG 2.5 프리미엄 2019년 45000km'), B.pullFromText('푸조 2008 1.2 GT라인 2021 30000km'), B.pullFromText('아반떼 CN7 19년 3월 4만5천'), B.pullFromText('그랜저 2019 45000')];
ok(pf[0].reg.y === 2019 && pf[0].km === 45000 && pf[0].text === '그랜저 IG 2.5 프리미엄' && pf[1].reg.y === 2021 && pf[1].text === '푸조 2008 1.2 GT라인' &&
  pf[2].reg.m === 3 && pf[2].km === 45000 && pf[3].km === 45000, '한 칸에 이어 쓴 글에서 연식·주행 꺼내기(모델 이름 속 숫자는 그대로)', JSON.stringify(pf));
const ft = B.formTSV().split(/\r?\n/);
ok(ft.length === 3 && ft[0].split('\t').length === 8 && ft[0].startsWith('차량번호\t차명\t최초등록\t주행거리') && ft[0].endsWith('판매 가격'), '묶음 산정 양식(머리글 8열 — 판매 가격 포함 + 예시 2대, 탭 구분)', ft[0]);
const t = B.parseTSV('차명\t주행\n"그랜저\nIG"\t3.8만');
ok(t.length === 2 && t[1][0] === '그랜저 IG', '엑셀 붙여넣기(줄바꿈 든 칸)');
const xl = XW.build([{ name: '시험', rows: [['a', 'b'], [1, { v: 1234, money: true }]], header: true }]);
ok(xl && xl.length > 500 && xl[0] === 0x50 && xl[1] === 0x4b, `엑셀 파일 만들기(${xl && xl.length}바이트)`);

console.log(fail ? `\n실패 ${fail}건 / ${n}건` : `\n모두 통과 (${n}건)`);
process.exit(fail ? 1 : 0);
