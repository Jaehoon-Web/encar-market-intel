// worker_check.mjs — 사이트 Worker(worker/index.js)의 환산 비율 저장소 API · 이용 통계 기록 API 시험 (Cloudflare 없이 Node로)
//   node tools/worker_check.mjs
// 가짜 KV(메모리)와 가짜 정적 자산(web/ 폴더)을 붙여 GET·PUT·비밀번호·동시 저장·값 검사·되돌리기용 판 보관을 확인한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const worker = (await import(pathToFileURL(path.join(ROOT, 'worker', 'index.js')).href)).default;
const { d1 } = await import(pathToFileURL(path.join(ROOT, 'tools', 'd1_shim.mjs')).href);
const { summarize } = await import(pathToFileURL(path.join(ROOT, 'worker', 'summary.js')).href);

function kv() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v.v) : v.v; },
    async put(k, v, o) { m.set(k, { v, ttl: o && o.expirationTtl }); }
  };
}
const ASSETS = {
  async fetch(req) {
    const p = new URL(req.url).pathname, f = path.join(ROOT, 'web', p);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return new Response(fs.readFileSync(f), { status: 200 });
    return new Response('asset:' + p, { status: 200 });
  }
};
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'conversion_rates.json'), 'utf8'));
const blank = base.rates.map(r => r.map(() => null));
const call = (env, method, body, q = '') => worker.fetch(new Request('https://x.test/api/rates' + q, {
  method, headers: { 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body)
}), env).then(async r => ({ status: r.status, body: await r.json().catch(() => null), type: r.headers.get('content-type') }));

let fail = 0;
function ok(cond, name, extra) { console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond || extra === undefined ? '' : ' — ' + JSON.stringify(extra))); if (!cond) fail++; }

console.log('[저장소 연결 전]');
let r = await call({ ASSETS }, 'GET');
ok(r.status === 200 && r.body.store === false && r.body.team === null, 'KV 없음 → 읽기는 되고 store=false', r);
r = await call({ ASSETS }, 'PUT', { password: 'x' });
ok(r.status === 503, 'KV 없음 → 저장은 503', r);

console.log('[저장]');
const env = { ASSETS, RATES: kv(), RATES_PASSWORD: '팀비번-2026' };
r = await call(env, 'GET');
ok(r.status === 200 && r.body.store && r.body.writable && r.body.team === null, '처음 GET → team 없음, 수정 가능', r);
const cells = blank.map(row => row.slice());
cells[1][1] = 15.04;                                           // 1~2천 · 3~4년
let t0 = Date.now();
r = await call(env, 'PUT', { password: '틀림', rev: 0, by: '권재훈', cells, models: [] });
ok(r.status === 401 && Date.now() - t0 >= 900, '틀린 비밀번호 → 401(1초 쉼)', r.status);
ok(env.RATES.m.size === 0, '틀린 비밀번호는 KV에 쓰지 않음');
r = await call(env, 'PUT', { password: '팀비번-2026', rev: 0, by: '', cells, models: [] });
ok(r.status === 400 && /이름/.test(r.body.error), '이름 없음 → 400', r.body);
r = await call(env, 'PUT', { password: '팀비번-2026', rev: 0, by: '권재훈', cells: [[1, 2]], models: [] });
ok(r.status === 400 && /모양/.test(r.body.error), '기준표 모양 다름 → 400', r.body);
r = await call(env, 'PUT', { password: '팀비번-2026', rev: 0, by: '권재훈', cells: blank.map((row, i) => row.map((v, j) => i === 0 && j === 0 ? 75 : v)), models: [] });
ok(r.status === 400 && /0~60/.test(r.body.error), '비율 75% → 400', r.body);
r = await call(env, 'PUT', { password: '팀비번-2026', rev: 0, by: '권재훈', cells: blank, models: [] });
ok(r.status === 400 && /바뀐 것/.test(r.body.error), '바뀐 것 없음 → 400', r.body);
const models = [{ '제조사': '현대', '모델': '그랜저 IG', '연료': '', '비율': '14.55', '메모': '팀 경험치' }, { '제조사': '기아', '모델': '레이', '비율': 18 }];
r = await call(env, 'PUT', { password: '팀비번-2026', rev: 0, by: '권재훈', note: '첫 수정', cells, models });
ok(r.status === 200 && r.body.team.rev === 1, '저장 → 1판', r.body);
const t1 = r.body.team;
ok(t1.cells[1][1] === 15 && t1.models[0]['비율'] === 14.6 && t1.models[0]['수정자'] === '권재훈', '값 정리(소수 첫째 자리)·수정자 기록', t1);
ok(t1.log[0].what.some(w => w.indexOf(base.price_bands[1].label + '·' + base.age_bands[1].label) >= 0), '변경 기록에 호가대·차령 이름', t1.log[0]);

console.log('[동시 저장 · 판 보관]');
r = await call(env, 'PUT', { password: '팀비번-2026', rev: 0, by: '다른 사람', cells, models: [] });
ok(r.status === 409 && r.body.team && r.body.team.rev === 1, '예전 판(rev 0)으로 저장 → 409 + 지금 판', r.status);
const m2 = [models[0], { '제조사': '기아', '모델': '레이', '비율': 18.5 }];
r = await call(env, 'PUT', { password: '팀비번-2026', rev: 1, by: '김팀원', cells, models: m2 });
ok(r.status === 200 && r.body.team.rev === 2, '2판 저장', r.body);
const t2 = r.body.team;
ok(t2.models[0]['수정자'] === '권재훈' && t2.models[1]['수정자'] === '김팀원', '안 바뀐 모델은 수정자 그대로', t2.models);
ok(t2.log.length === 2 && t2.log[0].what.join().indexOf('레이 18 → 18.5%') >= 0, '변경 기록 쌓임', t2.log);
ok(env.RATES.m.get('team:1') && env.RATES.m.get('team:1').ttl === 180 * 86400, '1판 보관(180일)');
r = await call(env, 'GET', null, '?rev=1');
ok(r.status === 200 && r.body.team.rev === 1, '?rev=1 → 1판', r.status);
r = await call(env, 'GET', null, '?rev=2');
ok(r.status === 200 && r.body.team.rev === 2, '?rev=2 → 지금 판', r.status);
r = await call(env, 'GET', null, '?rev=9');
ok(r.status === 404, '없는 판 → 404', r.status);
r = await call(env, 'PUT', { password: '팀비번-2026', rev: 2, by: '김팀원', cells, models: [m2[1]] });
ok(r.status === 200 && r.body.team.log[0].what.some(w => /모델 삭제 그랜저 IG/.test(w)), '모델 삭제 기록', r.body.team && r.body.team.log[0]);

console.log('[그 밖]');
r = await worker.fetch(new Request('https://x.test/api/rates', { method: 'POST' }), env);
ok(r.status === 405, 'POST → 405', r.status);
r = await worker.fetch(new Request('https://x.test/api/other'), env);
ok(r.status === 404, '없는 /api 주소 → 404', r.status);
r = await worker.fetch(new Request('https://x.test/downloads/listings_compact.csv'), env);
ok(r.status === 401 && /회원/.test(await r.text()), '로그인하지 않으면 내려받기 파일 주소 → 401(회원에게 요약 파일만, 로그인 기획)', r.status);
r = await worker.fetch(new Request('https://x.test/v2/index.html'), env);
ok(r.status === 200 && (await r.text()).indexOf('<html') >= 0, '그 밖의 주소 → 정적 자산', r.status);
r = await call(env, 'PUT', { password: '팀비번-2026', rev: 3, by: '가'.repeat(10), cells, models: Array.from({ length: 501 }, (_, i) => ({ '제조사': 'A', '모델': 'M' + i, '비율': 10 })) });
ok(r.status === 400 || r.status === 413, '모델 501개 → 거절', r.status);
r = await worker.fetch(new Request('https://x.test/api/rates', { method: 'PUT', body: 'x'.repeat(70000) }), env);
ok(r.status === 413, '64KB 넘는 본문 → 413', r.status);

console.log('[팀 표기 사전 /api/terms (기획 v2.31)]');
const tcall = (env2, method, body) => worker.fetch(new Request('https://x.test/api/terms', {
  method, headers: { 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body)
}), env2).then(async x => ({ status: x.status, body: await x.json().catch(() => null) }));
r = await tcall({ ASSETS }, 'GET');
ok(r.status === 200 && r.body.store === false, '저장소 없음 → 읽기만(store=false)', r);
r = await tcall(env, 'GET');
ok(r.status === 200 && r.body.writable && r.body.team === null, '처음 → 사전 없음', r.body);
r = await tcall(env, 'PUT', { password: '틀림', by: '권재훈', add: [{ t: '보조석휀다', kind: 'part', part: '프론트 휀더', side: '우' }] });
ok(r.status === 401, '틀린 비밀번호 → 401', r.status);
r = await tcall(env, 'PUT', { password: '팀비번-2026', by: '권재훈', add: [{ t: '보조석휀다', kind: 'part', part: '없는 부위' }] });
ok(r.status === 400 && /부위/.test(r.body.error), '없는 부위 이름 → 400', r.body);
r = await tcall(env, 'PUT', { password: '팀비번-2026', by: '권재훈', add: [{ t: '문', kind: 'part', part: '도어' }] });
ok(r.status === 400 && /두 글자/.test(r.body.error), '한 글자 표기 → 400', r.body);
r = await tcall(env, 'PUT', { password: '팀비번-2026', by: '권재훈', add: [{ t: '보조석휀다', kind: 'part', part: '프론트 휀더', side: '우' }, { t: '수리', kind: 'status', status: '판금' }] });
ok(r.status === 200 && r.body.team.rev === 1 && r.body.team.items.length === 2 && r.body.team.items[0].side === '우', '더하기 → 1판 · 2개', r.body);
r = await tcall(env, 'PUT', { password: '팀비번-2026', by: '김팀원', add: [{ t: '수 리', kind: 'status', status: '손상' }], del: ['보조석 휀다'] });
ok(r.status === 200 && r.body.team.items.length === 1 && r.body.team.items[0].status === '손상' && r.body.team.items[0].by === '김팀원', '같은 표기(띄어쓰기 무시)는 바꾸고 지우기', r.body);

console.log('[기록부 감가 · 수리비 표 /api/cond (기획 v2.32)]');
const ccall = (env2, method, body) => worker.fetch(new Request('https://x.test/api/cond', {
  method, headers: { 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body)
}), env2).then(async x => ({ status: x.status, body: await x.json().catch(() => null) }));
r = await ccall(env, 'GET');
ok(r.status === 200 && r.body.writable && r.body.team === null, '처음 → 팀 수정 없음', r.body);
r = await ccall(env, 'PUT', { password: '틀림', rev: 0, by: '권재훈', rows: [] });
ok(r.status === 401, '틀린 비밀번호 → 401', r.status);
r = await ccall(env, 'PUT', { password: '팀비번-2026', rev: 0, by: '권재훈', rows: [{ key: '후드', '교환': -1, '판금': -2 }] });
ok(r.status === 400 && /교환은 판금보다/.test(r.body.error), '교환이 판금보다 덜 깎임 → 400', r.body);
r = await ccall(env, 'PUT', { password: '팀비번-2026', rev: 0, by: '권재훈', rows: [{ key: '후드', '교환': 3 }] });
ok(r.status === 400 && /~0/.test(r.body.error), '감가가 양수 → 400', r.body);
r = await ccall(env, 'PUT', { password: '팀비번-2026', rev: 0, by: '권재훈', repair: { '외판': 5000 } });
ok(r.status === 400 && /2,000/.test(r.body.error), '수리비 범위 밖 → 400', r.body);
r = await ccall(env, 'PUT', { password: '팀비번-2026', rev: 0, by: '권재훈', note: '후드 교환 더', rows: [{ key: '후드', '교환': -4.04, '판금': -1.6 }], repair: { '외판': 35, outside: { '범퍼': 30 } } });
ok(r.status === 200 && r.body.team.rev === 1 && r.body.team.rows.find(x => x.key === '후드')['교환'] === -4 && r.body.team.repair['외판'] === 35 &&
   r.body.team.repair.outside['범퍼'] === 30 && r.body.team.log[0].what.some(w => /후드 교환/.test(w)), '저장 → 1판(값 정리 · 변경 기록)', r.body);
r = await ccall(env, 'PUT', { password: '팀비번-2026', rev: 0, by: '김팀원', rows: [] });
ok(r.status === 409 && r.body.team.rev === 1, '예전 판으로 저장 → 409', r.status);
r = await ccall(env, 'PUT', { password: '팀비번-2026', rev: 1, by: '김팀원', rows: [{ key: '후드', '교환': -4, '판금': -1.6 }], repair: { '외판': 35, outside: { '범퍼': 30 } } });
ok(r.status === 400 && /바뀐 것/.test(r.body.error), '바뀐 것 없음 → 400', r.body);

r = await ccall(env, 'PUT', { password: '팀비번-2026', rev: 1, by: '김팀원', order: [1, 1, 0.8, 0.9, 0.7, 0.5] });
ok(r.status === 400 && /앞 곳보다/.test(r.body.error), '곳 배수가 뒤에서 커짐 → 400(v2.33)', r.body);
r = await ccall(env, 'PUT', { password: '팀비번-2026', rev: 1, by: '김팀원', band: { '외판': [0.1, 1, 1, 1] } });
ok(r.status === 400 && /차값 배수/.test(r.body.error), '차값 배수 범위 밖 → 400(v2.33)', r.body);
r = await ccall(env, 'PUT', { password: '팀비번-2026', rev: 1, by: '김팀원', auction: { count: [[-3, -2, -6, -9, -11, -13]] } });
ok(r.status === 400 && /곳이 늘면/.test(r.body.error), '경매 감가가 곳이 늘며 줄어듦 → 400(v2.33)', r.body);
r = await ccall(env, 'PUT', { password: '팀비번-2026', rev: 1, by: '김팀원', band: { '골격': [0.9, 1, 0.8, 0.8] }, order: [1, 1, 1, 0.9, 0.8, 0.6],
  auction: { band: { '외판': [0.5, 1, 1.2, 1.4] } } });
ok(r.status === 200 && r.body.team.rev === 2 && r.body.team.band['골격'][2] === 0.8 && r.body.team.order[3] === 0.9 && r.body.team.auction.band['외판'][0] === 0.5 &&
   r.body.team.log[0].what.some(w => /곳 배수/.test(w)) && r.body.team.log[0].what.some(w => /경매 차값 배수/.test(w)), '차값 · 곳 배수 · 경매 감가 저장 → 2판(v2.33)', r.body);
r = await ccall(env, 'PUT', { password: '팀비번-2026', rev: 2, by: '김팀원', repair: { '환산반영': 150 } });
ok(r.status === 400 && /0~100/.test(r.body.error), '환산가에 빼는 수리비 몫 범위 밖 → 400(Q261)', r.body);
r = await ccall(env, 'PUT', { password: '팀비번-2026', rev: 2, by: '김팀원', band: { '골격': [0.9, 1, 0.8, 0.8] }, order: [1, 1, 1, 0.9, 0.8, 0.6],
  auction: { band: { '외판': [0.5, 1, 1.2, 1.4] } }, repair: { '환산반영': 30.4 } });
ok(r.status === 200 && r.body.team.rev === 3 && r.body.team.repair['환산반영'] === 30 && r.body.team.log[0].what.join() === '환산가 반영 비율 → 30%',
   '환산가에 빼는 수리비 몫 저장 → 3판(정수 · 변경 기록 한 줄, Q261)', r.body);
{                                                            // 리뷰 11-05: 저장은 기본표와 다른 칸만(기본표를 다시 맞추면 나머지는 새 기본값) · 단계 판금 빈칸 = 초기값(감가가 사라지지 않게)
  const t3 = r.body.team;
  r = await ccall(env, 'PUT', Object.assign({ password: '팀비번-2026', rev: 3, by: '김팀원' }, t3, { rows: [{ key: '외판1', '교환': -2.5, '판금': null }] }));
  const t = r.body && r.body.team, o1 = t && t.rows.find(x => x.key === '외판1');
  ok(r.status === 200 && t.rev === 4 && o1 && o1['교환'] === -2.5 && !('판금' in o1) && t.rows.length === 1 && Object.keys(t.once).length === 0 &&
     t.band['골격'] && !t.band['외판'] && t.repair['환산반영'] === 30 && Object.keys(t.repair).length === 2 && Object.keys(t.repair.outside).length === 0 &&
     t.auction.count.every(x => x === null) && t.log[0].what.some(w => /외판1 교환/.test(w)) && !t.log[0].what.some(w => /판금/.test(w)),
  '바뀐 칸만 저장 · 판금 빈칸은 초기값(외판1 판금 감가가 남음)', t);
}
{                                                            // 리뷰 U4-3: 감가 표도 예전 판을 읽는다(⚙ 이 판 보기 · 되돌리기)
  const cget = q => worker.fetch(new Request('https://x.test/api/cond' + q), env).then(async x => ({ status: x.status, body: await x.json().catch(() => null) }));
  r = await cget('?rev=1');
  ok(r.status === 200 && r.body.team.rev === 1 && r.body.team.rows.find(x => x.key === '후드')['교환'] === -4, '감가 표 ?rev=1 → 1판', r.body);
  r = await cget('?rev=4');
  ok(r.status === 200 && r.body.team.rev === 4, '감가 표 ?rev=4 → 지금 판', r.status);
  r = await cget('?rev=9');
  ok(r.status === 404, '감가 표 없는 판 → 404', r.status);
  r = await cget('');
  ok(r.status === 200 && r.body.store && r.body.team.rev === 4, '감가 표 판 번호 없이 → 지금 판 그대로', r.body);
  ok(env.RATES.m.get('cond:1') && env.RATES.m.get('cond:1').ttl === 180 * 86400, '감가 표 1판 보관(180일)');
}

console.log('[이용 통계 기록 /api/ev (기획 v2.28)]');
const U = 'abcdefgh12345678', SI = 'session000000001';
const ev = (env2, body, headers = {}) => worker.fetch(new Request('https://x.test/api/ev', {
  method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: typeof body === 'string' ? body : JSON.stringify(body)
}), env2);
r = await ev({ ASSETS }, { u: U, s: SI, e: [[Date.now(), 'view', 'pulse', '', '']] });
ok(r.status === 204, '저장소(D1) 없음 → 204(사이트는 그대로)', r.status);
const S1 = d1(), envS = { ASSETS, STATS: S1 }, now = Date.now();
r = await ev(envS, { u: U, s: SI, d: 'm', e: [
  [now, 'start', 'price.one', 'car', ''], [now, 'view', 'price.one', '', ''], [now, 'result', 'price.one', '더 뉴그랜저IG', '가솔린 2.5'],
  [now, 'act', 'price.one', 'x'.repeat(100), 'y'.repeat(500)], [now, 'hack', 'price.one', '', ''], [now, 'view', 'Price<script>', '', ''],
  [now + 86400e3 * 5, 'vis', 'price.one', '', '12'], ['abc', 'err', 'price.one', 'js', 'boom']
] }, { origin: 'https://x.test' });
ok(r.status === 204, '같은 사이트에서 보냄 → 204', r.status);
let rows = (await S1.prepare('SELECT * FROM ev ORDER BY id').all()).results;
ok(rows.length === 6, '모르는 종류·이상한 화면 이름은 버림(8건 중 6건)', rows.map(x => x.type + ':' + x.scr));
ok(rows.every(x => x.uid === U && x.sid === SI && x.dev === 'm'), '익명 번호·방문·기기(m) 저장', rows[0]);
ok(Object.keys(rows[0]).sort().join() === 'day,dev,id,name,scr,sid,ts,type,uid,val', '저장 칸은 정해진 것만(IP·이름 칸 없음)', Object.keys(rows[0]));
ok(rows[2].name === '더 뉴그랜저IG' && rows[2].val === '가솔린 2.5', '결과는 모델·등급', rows[2]);
ok(rows[3].name.length === 60 && rows[3].val.length === 200, '이름 60자 · 값 200자로 자름', [rows[3].name.length, rows[3].val.length]);
ok(rows[4].ts <= Date.now() && rows[4].ts >= now - 5000 && rows[5].ts >= now - 5000, '틀린 시각(미래·글자)은 받은 시각으로', [rows[4].ts, rows[5].ts]);
const kst = new Date(now + 9 * 3600e3).toISOString().slice(0, 10);
ok(rows[0].day === kst, '날짜는 한국 시간 기준', [rows[0].day, kst]);
r = await ev(envS, { u: U, s: SI, e: [[now, 'view', 'pulse', '', '']] }, { origin: 'https://evil.example' });
ok(r.status === 403, '다른 사이트에서 보냄 → 403', r.status);
r = await ev(envS, { u: 'short', s: SI, e: [] });
ok(r.status === 400, '익명 번호 형식이 틀림 → 400', r.status);
r = await ev(envS, 'not json');
ok(r.status === 400, 'JSON 아님 → 400', r.status);
r = await ev(envS, { u: U, s: SI, d: 'tablet', e: Array.from({ length: 260 }, () => [now, 'act', 'data', 'download', '']) });
rows = (await S1.prepare("SELECT count(*) n, min(dev) d FROM ev WHERE scr = 'data'").all()).results[0];
ok(r.status === 204 && rows.n === 200 && rows.d === 'pc', '한 번에 200건까지 · 모르는 기기는 pc', rows);
r = await ev(envS, 'x'.repeat(70000));
ok(r.status === 413, '64KB 넘는 본문 → 413', r.status);
r = await worker.fetch(new Request('https://x.test/api/ev'), envS);
ok(r.status === 405, 'GET → 405', r.status);
const bad = { ASSETS, STATS: { prepare() { throw new Error('down'); }, batch() { return Promise.reject(new Error('down')); } } };
r = await ev(bad, { u: U, s: SI, e: [[now, 'view', 'pulse', '', '']] });
ok(r.status === 500 && (await r.json()).ok === false, '저장소 오류 → 500(화면은 기록 실패를 무시)', r.status);

console.log('[하루 요약 summarize (기획 v2.28 5.11.2)]');
const T0 = Date.parse('2026-11-02T01:00:00Z'), row = (sid, uid, k, type, scr, name = '', val = '', dev = 'pc') => ({ sid, uid, dev, ts: T0 + k * 1000, type, scr, name, val });
const rs = [
  // 방문 A: 들어옴 → 차 고름 → 결과 2건(첫 결과는 05까지, 둘째는 01만) → 엑셀 → 마켓 펄스로 이동해 끝
  row('a', 'u1', 0, 'start', 'price.one', 'car'), row('a', 'u1', 1, 'view', 'price.one'), row('a', 'u1', 2, 'pick', 'price.one', '그랜저'),
  row('a', 'u1', 3, 'result', 'price.one', '그랜저', '2.5'), row('a', 'u1', 4, 'depth', 'price.one', String(T0 + 3000), '5'), row('a', 'u1', 5, 'result', 'price.one', '그랜저', '3.0'),
  row('a', 'u1', 6, 'export', 'price.one', 'xlsx'), row('a', 'u1', 7, 'act', 'price.one', 'nav:basis'), row('a', 'u1', 8, 'view', 'pulse'), row('a', 'u1', 9, 'vis', 'price.one', '', '120'),
  row('a', 'u1', 10, 'vis', 'pulse', '', '30'), row('a', 'u1', 11, 'err', 'pulse', 'js', 'boom'), row('a', 'u1', 12, 'perf', 'price.one', 'ready', '900'),
  // 방문 B(같은 사람·휴대폰): 차를 고르다 등급·주행거리를 비운 채 끝(입력하다 포기)
  row('b', 'u1', 20, 'start', 'price.one', '', '', 'm'), row('b', 'u1', 21, 'view', 'price.one', '', '', 'm'), row('b', 'u1', 22, 'act', 'price.one', 'input:mk', '', 'm'),
  row('b', 'u1', 23, 'miss', 'price.one', '등급,주행거리', '', 'm'), row('b', 'u1', 24, 'vis', 'price.one', '', '99999', 'm'),
  // 방문 C: 묶음 산정 8대, 결과는 없음 · 빈 칸 기록이 나중에 풀림
  row('c', 'u2', 30, 'start', 'price.batch'), row('c', 'u2', 31, 'view', 'price.batch'), row('c', 'u2', 32, 'miss', 'price.batch', '등급'), row('c', 'u2', 33, 'miss', 'price.batch', ''),
  row('c', 'u2', 34, 'act', 'price.batch', 'batch:run'), row('c', 'u2', 35, 'batch', 'price.batch', 'run', '8'), row('c', 'u2', 36, 'view', 'market'), row('c', 'u2', 37, 'view', 'market')
];
const SM = summarize('2026-11-02', rs);
ok(SM.sessions === 3 && SM.uids.length === 2 && SM.dev.pc === 2 && SM.dev.m === 1, '방문 3 · 방문자 2(익명 번호) · PC 2 · 휴대폰 1', [SM.sessions, SM.uids, SM.dev]);
ok(SM.sec === 120 + 30 + 3600, '보는 시간 합(한 번에 1시간 넘는 값은 1시간으로)', SM.sec);
ok(SM.results === 2 && SM.models['그랜저|2.5'] === 1 && SM.models['그랜저|3.0'] === 1, '산정 결과 2건 · 모델·등급별', SM.models);
ok(JSON.stringify(SM.funnel) === '[3,1,1,1,1]', '단계 흐름: 들어옴 3 → 차 고름 1(세부모델까지 · 제조사만 고른 방문은 아님) → 결과 1 → 근거 1 → 내보내기 1', SM.funnel);
ok(JSON.stringify(SM.depth) === '[1,0,0,0,1,0]', '결과 깊이: 05까지 1건 · 01만 1건(시각으로 짝)', SM.depth);
ok(SM.abandon === 1 && SM.fields['등급'] === 1 && SM.fields['주행거리'] === 1, '입력하다 포기: 빈 칸이 남은 방문 1(풀린 빈 칸은 빼고)', [SM.abandon, SM.fields]);
ok(SM.last.pulse === 1 && SM.lastAct['pulse|@view'] === 1 && SM.lastAct['price.one|@miss'] === 1, '마지막 화면·행동', SM.lastAct);
ok(SM.paths['price.one>pulse'] === 1 && SM.paths['price.batch>market'] === 1, '이동 경로(같은 화면 연속은 하나로)', SM.paths);
ok(SM.entry['price.one'] === 2 && SM.entryCar === 1 && SM.batch === 1 && SM.cars === 8, '처음 화면 · 링크로 온 방문 · 묶음 8대', [SM.entry, SM.entryCar, SM.cars]);
ok(SM.err.js === 1 && SM.errs.length === 1 && SM.ready[0] === 900 && SM.exports.xlsx === 1, '오류 · 속도 · 내보내기', [SM.err, SM.ready, SM.exports]);
ok(SM.scr['price.one'].sessions === 2 && SM.scr.market.views === 2 && SM.act['price.one|nav:basis'] === 1, '화면별 방문·보기 · 기능', SM.scr);

console.log('[관리자 로그인 · 통계 (기획 v2.28 5.11.3)]');
const adm = (env2, method, p2, body, token) => worker.fetch(new Request('https://x.test' + p2, {
  method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}), body: body == null ? undefined : JSON.stringify(body)
}), env2).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const S2 = d1(), envA = { ASSETS, STATS: S2, ADMIN_PASSWORD: '관리-2026' };
r = await adm({ ASSETS, STATS: S2 }, 'POST', '/api/admin/login', { password: 'x' });
ok(r.status === 503, '관리자 비밀번호 설정 전 → 503', r.status);
let tA = Date.now();
r = await adm(envA, 'POST', '/api/admin/login', { password: '틀림' });
ok(r.status === 401 && Date.now() - tA >= 900, '틀린 비밀번호 → 1초 쉬고 401', r.status);
r = await adm(envA, 'POST', '/api/admin/login', { password: '관리-2026' });
const tok = r.body && r.body.token;
ok(r.status === 200 && /^\d{13}\.[A-Za-z0-9_-]{40,}$/.test(tok) && Math.abs(r.body.exp - Date.now() - 30 * 86400e3) < 5000, '맞는 비밀번호 → 30일 출입증', r.body);
ok(!JSON.stringify(r.body).includes('관리-2026'), '출입증에 비밀번호가 들어 있지 않음');
r = await adm(Object.assign({}, envA, { ADMIN_PASSWORD: '  관리-2026\n' }), 'POST', '/api/admin/login', { password: '관리-2026 ' });
ok(r.status === 200 && r.body.ok, '비밀값·입력의 앞뒤 빈칸·줄바꿈은 무시', r.status);
r = await adm(envA, 'GET', '/api/admin/stats?days=7');
ok(r.status === 401, '출입증 없이 통계 → 401', r.status);
r = await adm(envA, 'GET', '/api/admin/stats?days=7', null, tok.slice(0, -2) + 'xx');
ok(r.status === 401, '고친 출입증 → 401', r.status);
r = await adm(envA, 'GET', '/api/admin/stats?days=7', null, '1000000000000.' + tok.split('.')[1]);
ok(r.status === 401, '만료 시각을 바꾼 출입증 → 401', r.status);
r = await adm(Object.assign({}, envA, { ADMIN_PASSWORD: '새비번' }), 'GET', '/api/admin/stats?days=7', null, tok);
ok(r.status === 401, '비밀번호를 바꾸면 이전 출입증 무효', r.status);
// 시험 기록: 사흘 전·어제·오늘 (직접 넣음 — 받는 API는 이틀보다 오래된 시각을 받지 않으므로)
await S2.batch([S2.prepare("CREATE TABLE IF NOT EXISTS ev (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, day TEXT NOT NULL, uid TEXT NOT NULL, sid TEXT NOT NULL, dev TEXT, type TEXT NOT NULL, scr TEXT, name TEXT, val TEXT)")]);
const kd = ms => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10), NOW = Date.now();
const ins = S2.prepare('INSERT INTO ev (ts, day, uid, sid, dev, type, scr, name, val) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)');
const put2 = (k, sid, uid, type, scr, name = '', val = '') => ins.bind(NOW - k * 86400e3, kd(NOW - k * 86400e3), uid, sid, 'pc', type, scr, name, val).run();
for (const [k, sid, uid] of [[3, 's3', 'u1'], [1, 's1a', 'u1'], [1, 's1b', 'u2'], [0, 's0', 'u3'], [400, 'old', 'u9']]) {
  await put2(k, sid, uid, 'start', 'price.one'); await put2(k, sid, uid, 'view', 'price.one'); await put2(k, sid, uid, 'result', 'price.one', '쏘나타', '2.0');
}
r = await adm(envA, 'GET', '/api/admin/stats?days=7', null, tok);
const ds = r.body && r.body.days;
ok(r.status === 200 && ds.length === 7 && ds[6].day === kd(NOW) && ds[6].sessions === 1, '7일 · 마지막이 오늘(그때그때 셈)', ds && ds.map(d => d.day + ':' + (d.sessions || 0)));
ok(ds[5].sessions === 2 && ds[5].uids.length === 2 && ds[3].sessions === 1 && ds[4].empty, '지난 날은 요약을 만들어 씀(없는 날은 빈 요약)', ds && ds.map(d => d.sessions || (d.empty ? 'e' : '-')));
const made = (await S2.prepare('SELECT count(*) n FROM day_sum').all()).results[0].n;
ok(made === 5, '새벽 작업 전이면 한 번에 5일까지만(어제부터) 만들어 둠', made);
r = await adm(envA, 'GET', '/api/admin/stats?days=13', null, tok);
ok(r.status === 200 && r.body.days.length === 7, '기간은 7·30·90만(그 밖은 7)', r.body.days.length);
r = await adm(envA, 'GET', '/api/admin/stats?days=90', null, tok);
ok(r.status === 200 && r.body.days.length === 90 && r.body.days.filter(d => d.missing).length === 90 - 1 - 11, '90일 · 아직 못 만든 날은 missing(앞 요청들이 만든 6일 + 이번 5일, 다음에 이어서)', r.body.days.filter(d => d.missing).length);
let waited = null;
await worker.scheduled({ cron: '0 18 * * *' }, envA, { waitUntil(p3) { waited = p3; } });
await waited;
const oldLeft = (await S2.prepare("SELECT count(*) n FROM ev WHERE sid = 'old'").all()).results[0].n;
const y = JSON.parse((await S2.prepare('SELECT data FROM day_sum WHERE day = ?1').bind(kd(NOW - 86400e3)).first()).data);
ok(oldLeft === 0 && y.sessions === 2, '새벽 작업: 어제 요약 다시 만들고 1년 지난 기록 지움', [oldLeft, y.sessions]);
r = await worker.fetch(new Request('https://x.test/api/admin/stats', { method: 'POST' }), envA);
ok(r.status === 405, '통계는 GET만', r.status);

console.log('[회원 · 로그인 · 관리 (로그인 기획 PLAN_로그인_회원관리_기획안.md)]');
{
  const enc = s => new TextEncoder().encode(s);
  const b64u = buf => Buffer.from(new Uint8Array(buf)).toString('base64url');
  const ITER = 100000;                                          // 서버가 받는 가장 작은 값(실제 화면은 60만 번)
  const kdf = async (pw, salt, iter = ITER) => b64u(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc(salt), iterations: iter },
    await crypto.subtle.importKey('raw', enc(pw.normalize('NFC')), 'PBKDF2', false, ['deriveBits']), 256));
  const newSalt = () => b64u(crypto.getRandomValues(new Uint8Array(16)));
  const SU = d1(), O = 'https://x.test';
  const envU = { ASSETS, RATES: kv(), STATS: SU, RATES_PASSWORD: '팀비번-2026', ADMIN_PASSWORD: '관리-2026', AUTH_PEPPER: 'test-pepper-0123456789abcdef', AUTH_ENFORCE: '1' };
  const go = (method, p2, body, h = {}, env2 = envU) => worker.fetch(new Request(O + p2, {
    method, headers: Object.assign({ 'content-type': 'application/json', origin: O }, h), body: body == null ? undefined : JSON.stringify(body)
  }), env2).then(async x => { const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* 글 */ } return { status: x.status, body: j, text: t, cookie: x.headers.get('set-cookie') }; });
  const ck = c => ({ cookie: (/cr_s=([^;]*)/.exec(c || '') || [])[0] || '' });
  const signupAs = async (email, name, pw, h = {}) => { const salt = newSalt(); return go('POST', '/api/auth/signup', { email, name, salt, iter: ITER, dk: await kdf(pw, salt), consent: true }, h); };
  const loginAs = async (email, pw, remember = false, h = {}) => {
    const s = await go('GET', '/api/auth/salt?email=' + encodeURIComponent(email), null, h);
    return go('POST', '/api/auth/login', { email, dk: await kdf(pw, s.body.salt, s.body.iter), remember }, h);
  };

  let x = await go('GET', '/api/auth/me');
  ok(x.status === 200 && x.body.ready && x.body.enforce && x.body.user === null, '처음 → 회원 기능 준비됨 · 잠금 켬 · 로그인 안 함', x.body);
  const s1 = await go('GET', '/api/auth/salt?email=nobody@corp.test'), s2 = await go('GET', '/api/auth/salt?email=nobody@corp.test');
  ok(s1.body.salt.length === 22 && s1.body.salt === s2.body.salt && s1.body.iter === 600000, '없는 메일도 고정된 가짜 소금(가입 여부를 드러내지 않음)', s1.body);
  x = await go('POST', '/api/auth/signup', { email: 'bad', name: '주인', salt: newSalt(), iter: ITER, dk: 'x'.repeat(43), consent: true });
  ok(x.status === 400 && /메일/.test(x.body.error), '메일 모양이 틀림 → 400', x.body);
  x = await go('POST', '/api/auth/signup', { email: 'owner@corp.test', name: '주인', salt: newSalt(), iter: ITER, dk: 'x'.repeat(43) });
  ok(x.status === 400 && /동의/.test(x.body.error), '개인정보 동의 없음 → 400', x.body);
  x = await go('POST', '/api/auth/signup', { email: 'owner@corp.test', name: '주인', salt: newSalt(), iter: 50, dk: 'x'.repeat(43), consent: true });
  ok(x.status === 400, '다지는 횟수가 너무 적음 → 400', x.body);
  x = await signupAs('Owner@Corp.test', '주인', 'owner-pass1');
  ok(x.status === 200 && x.body.ok, '가입 신청 → 200(메일은 소문자로)', x.body);
  x = await signupAs('owner@corp.test', '가짜', 'other-pass2');
  const own = await SU.prepare("SELECT name, status, dup_at FROM users WHERE email = 'owner@corp.test'").first();
  ok(x.status === 200 && own.name === '주인' && own.status === 'pending' && own.dup_at > 0, '같은 메일 다시 신청 → 같은 답, 바꾸지 않고 중복 표시', own);
  x = await loginAs('owner@corp.test', 'owner-pass1');
  ok(x.status === 403 && x.body.code === 'pending', '승인 전 로그인 → 403 승인 대기', x.body);
  x = await go('GET', '/api/users');
  ok(x.status === 401, '관리자 아님 → 회원 목록 401', x.status);
  const lg = await go('POST', '/api/admin/login', { password: '관리-2026' }), BEAR = { authorization: 'Bearer ' + lg.body.token };
  x = await go('GET', '/api/users', null, BEAR);
  const oid = x.body.users.find(u => u.email === 'owner@corp.test').id;
  ok(x.status === 200 && x.body.users.length === 1 && x.body.users[0].status === 'pending' && x.body.users[0].dupAt, '관리자 비밀번호 출입증(전환 기간) → 회원 목록', x.body.users);
  x = await go('POST', '/api/users/' + oid + '/approve', null, BEAR);
  ok(x.status === 200, '승인', x.body);
  x = await go('POST', '/api/users/' + oid + '/role', { role: 'admin' }, BEAR);
  ok(x.status === 200, '관리자로 지정', x.body);
  for (let i = 0; i < 4; i++) x = await loginAs('owner@corp.test', 'wrong-pass9');
  ok(x.status === 401 && /5번/.test(x.body.error), '틀린 비밀번호 → 401(몇 번째인지 말하지 않음)', x.body);
  x = await loginAs('owner@corp.test', 'wrong-pass9');
  ok(x.status === 423 && x.body.code === 'locked', '5번째 → 15분 잠금 423', x.body);
  x = await loginAs('owner@corp.test', 'owner-pass1');
  ok(x.status === 423, '잠긴 동안은 맞는 비밀번호도 423', x.status);
  x = await go('POST', '/api/users/' + oid + '/unlock', null, BEAR);
  ok(x.status === 200, '관리자가 잠금 풀기', x.body);
  x = await loginAs('owner@corp.test', 'owner-pass1', true);
  const A = ck(x.cookie);
  ok(x.status === 200 && x.body.user.role === 'admin' && /HttpOnly/.test(x.cookie) && /Secure/.test(x.cookie) && /SameSite=Lax/.test(x.cookie) && /Max-Age=2592000/.test(x.cookie),
    '로그인(이 기기 기억) → 쿠키 HttpOnly · Secure · SameSite=Lax · 30일', x.cookie);
  x = await go('GET', '/api/auth/me', null, A);
  ok(x.body.user && x.body.user.name === '주인' && x.body.user.canEdit && x.body.pending === 0, '내 정보 · 관리자는 설정 수정 가능 · 승인 대기 수', x.body);

  x = await signupAs('member@corp.test', '팀원', 'member-pass1');
  x = await go('GET', '/api/auth/me', null, A);
  ok(x.body.pending === 1, '새 신청 → 관리자에게 대기 1', x.body.pending);
  x = await go('GET', '/api/users?status=pending', null, A);
  const bid = x.body.users[0].id;
  x = await worker.fetch(new Request(O + '/api/users/' + bid + '/approve', { method: 'POST', headers: { cookie: A.cookie } }), envU);
  ok(x.status === 401, '관리자 쿠키라도 다른 곳(Origin 없음)에서 보낸 승인 → 401', x.status);
  x = await go('POST', '/api/users/' + bid + '/approve', null, A);
  ok(x.status === 200, '관리자 회원이 화면에서 승인', x.body);
  x = await loginAs('member@corp.test', 'member-pass1', false);
  let B = ck(x.cookie);
  ok(x.status === 200 && !/Max-Age/.test(x.cookie) && !x.body.user.canEdit, '기억 안 함 → 브라우저를 닫으면 끝나는 쿠키 · 설정 수정 권한 없음', x.cookie);

  console.log('  (자료 문)');
  x = await go('GET', '/data/pulse.json');
  ok(x.status === 401 && x.body.code === 'login', '마켓 펄스 자료: 로그인 안 함 → 401', x.status);
  x = await go('GET', '/data/pulse.json', null, B);
  ok(x.status === 200, '마켓 펄스 자료: 회원 → 200', x.status);
  x = await go('GET', '/downloads/market_models.csv');
  ok(x.status === 401, '요약 CSV: 로그인 안 함 → 401', x.status);
  x = await go('GET', '/downloads/market_models.csv', null, B);
  ok(x.status === 200, '요약 CSV: 회원 → 200', x.status);
  x = await go('GET', '/downloads/listings_compact.csv', null, B);
  ok(x.status === 404, '매물 단위 원자료: 회원에게도 404', x.status);
  const cf = '/data/comps/' + fs.readdirSync(path.join(ROOT, 'web', 'data', 'comps')).find(f => /^g.*\.json$/.test(f));
  const anon = { 'x-cr-a': 'abcdefgh1234', 'cf-connecting-ip': '198.51.100.7' };
  let okN = 0;
  for (let i = 0; i < 30; i++) { x = await go('GET', cf, null, anon); if (x.status === 200) okN++; }
  x = await go('GET', cf, null, anon);
  ok(okN === 30 && x.status === 429 && x.body.code === 'limit', '비교 매물: 로그인 안 하면 1시간 30개, 31번째 429', [okN, x.status]);
  x = await go('GET', '/data/comps/index.json', null, anon);
  ok(x.status === 200, '비교 매물 목록(index.json)은 세지 않음', x.status);
  x = await go('GET', cf, null, Object.assign({}, anon, { 'x-cr-a': 'zzzzzzzz9999' }));
  ok(x.status === 200, '다른 브라우저(같은 주소)는 따로 셈', x.status);
  x = await go('GET', cf, null, Object.assign({}, anon, B));
  ok(x.status === 200, '회원은 한도 없음', x.status);

  console.log('  (팀 설정 · 권한)');
  const cells = base.rates.map(rr => rr.map(() => null)); cells[0][0] = 21.5;
  x = await go('PUT', '/api/rates', { password: '팀비번-2026', rev: 0, by: '공용', note: '메모 비밀', cells, models: [] });
  ok(x.status === 200 && x.body.team.updated_by === '공용', '공용 비밀번호로 저장(전환 기간)', x.body);
  x = await go('GET', '/api/rates');
  ok(x.status === 200 && x.body.team.cells[0][0] === 21.5 && x.body.team.updated_by === undefined && x.body.team.log === undefined, '로그인 안 함 → 값만(수정자 · 기록 뺌)', x.body.team);
  x = await go('GET', '/api/rates', null, B);
  ok(x.body.team.updated_by === '공용' && x.body.team.log.length === 1, '회원 → 수정자 · 기록까지', x.body.team.updated_by);
  cells[0][0] = 22;
  x = await go('PUT', '/api/rates', { rev: 1, cells, models: [] }, B);
  ok(x.status === 401, '설정 수정 권한 없는 회원이 비밀번호 없이 → 401', x.status);
  x = await go('POST', '/api/users/' + bid + '/edit', { canEdit: true }, A);
  ok(x.status === 200, '관리자가 설정 수정 권한 켬', x.body);
  x = await go('PUT', '/api/rates', { rev: 1, by: '아무개', cells, models: [] }, B);
  ok(x.status === 200 && x.body.team.updated_by === '팀원', '권한 있는 회원 → 비밀번호 없이 저장 · 이름은 계정 이름', x.body.team && x.body.team.updated_by);
  x = await worker.fetch(new Request(O + '/api/rates', { method: 'PUT', headers: { 'content-type': 'application/json', cookie: B.cookie }, body: JSON.stringify({ rev: 2, cells, models: [] }) }), envU);
  ok(x.status === 401, '같은 쿠키라도 다른 곳(Origin 없음)에서 보낸 저장 → 401', x.status);
  x = await go('GET', '/api/users/audit', null, A);
  ok(x.status === 200 && x.body.audit.some(a => a.action === 'settings' && a.actor === '팀원' && /환산 비율 2판/.test(a.detail)) && x.body.audit.some(a => a.action === 'approve'), '관리 기록: 승인 · 설정 수정(누가)', x.body.audit.slice(0, 3));

  console.log('  (비밀번호 · 임시 비밀번호 · 분실)');
  let ns = newSalt();
  x = await go('POST', '/api/auth/password', { dk: await kdf('틀림', (await go('GET', '/api/auth/salt?email=member@corp.test')).body.salt), salt: ns, iter: ITER, newDk: await kdf('member-pass2', ns) }, B);
  ok(x.status === 401, '지금 비밀번호가 틀림 → 401', x.status);
  const bs = (await go('GET', '/api/auth/salt?email=member@corp.test')).body.salt;
  x = await go('POST', '/api/auth/password', { dk: await kdf('member-pass1', bs), salt: ns, iter: ITER, newDk: await kdf('member-pass2', ns) }, B);
  const B2 = ck(x.cookie);
  ok(x.status === 200 && B2.cookie && B2.cookie !== B.cookie, '비밀번호 바꾸기 → 새 쿠키', x.status);
  x = await go('GET', '/api/auth/me', null, B);
  ok(x.body.user === null, '바꾸기 전 쿠키는 끊김(다른 기기 로그아웃)', x.body.user);
  B = B2;
  ns = newSalt();
  x = await go('POST', '/api/users/' + bid + '/temp', { salt: ns, iter: ITER, dk: await kdf('임시pw1234', ns) }, A);
  ok(x.status === 200, '관리자가 임시 비밀번호 발급(다진 값만)', x.body);
  x = await go('GET', '/api/auth/me', null, B);
  ok(x.body.user === null, '임시 비밀번호를 받으면 기존 로그인 끊김', x.body.user);
  x = await loginAs('member@corp.test', '임시pw1234');
  B = ck(x.cookie);
  ok(x.status === 200 && x.body.user.mustChange, '임시 비밀번호로 로그인 → 바꾸기 필요 표시', x.body.user);
  ns = newSalt();
  x = await go('POST', '/api/auth/password', { dk: await kdf('임시pw1234', (await go('GET', '/api/auth/salt?email=member@corp.test')).body.salt), salt: ns, iter: ITER, newDk: await kdf('member-pass3', ns) }, B);
  B = ck(x.cookie);
  x = await go('GET', '/api/auth/me', null, B);
  ok(x.body.user && !x.body.user.mustChange, '새 비밀번호로 바꾸면 표시 사라짐', x.body.user);
  x = await go('POST', '/api/auth/forgot', { email: 'member@corp.test' });
  const x2 = await go('POST', '/api/auth/forgot', { email: 'ghost@corp.test' });
  const lst = (await go('GET', '/api/users', null, A)).body.users;
  ok(x.status === 200 && x2.status === 200 && lst.find(u => u.id === bid).resetAt > 0, '비밀번호 분실 요청 → 관리자 목록에 표시 · 없는 메일도 같은 답', [x.status, x2.status]);

  console.log('  (등급 · 정지 · 탈퇴 · 밤 작업)');
  x = await go('POST', '/api/users/' + oid + '/role', { role: 'member' }, A);
  ok(x.status === 409, '마지막 관리자는 해제할 수 없음 → 409', x.body);
  x = await go('POST', '/api/users/' + bid + '/role', { role: 'admin' }, A);
  ok(x.status === 200, '다른 회원을 관리자로', x.body);
  x = await go('GET', '/api/auth/me', null, B);
  ok(x.body.user === null, '등급이 바뀌면 그 회원 로그인 끊김(다시 로그인)', x.body.user);
  x = await go('POST', '/api/users/' + oid + '/role', { role: 'member' }, A);
  ok(x.status === 200, '이제 관리자 둘 → 하나 해제 가능', x.body);
  x = await loginAs('member@corp.test', 'member-pass3');
  B = ck(x.cookie);
  x = await go('POST', '/api/users/' + bid + '/suspend', null, B);
  ok(x.status === 409, '마지막 관리자는 정지할 수 없음 → 409', x.body);
  const ownerSalt = (await go('GET', '/api/auth/salt?email=owner@corp.test')).body.salt;
  x = await loginAs('owner@corp.test', 'owner-pass1');
  const A2 = ck(x.cookie);
  x = await go('DELETE', '/api/auth/me', { dk: await kdf('owner-pass1', ownerSalt) }, A2);
  ok(x.status === 200 && /Max-Age=0/.test(x.cookie), '본인 탈퇴 → 쿠키 지움', x.status);
  const gone = await SU.prepare('SELECT email, name, pw, status FROM users WHERE id = ?1').bind(oid).first();
  ok(gone.status === 'deleted' && gone.email === 'deleted-' + oid && gone.name === '탈퇴한 회원' && gone.pw === '', '탈퇴하면 이름 · 메일 · 비밀번호 값을 지움', gone);
  x = await loginAs('owner@corp.test', 'owner-pass1');
  ok(x.status === 401, '탈퇴한 메일로 로그인 → 401', x.status);
  await signupAs('idle@corp.test', '쉬는사람', 'idle-pass1');
  const iid = (await SU.prepare("SELECT id FROM users WHERE email = 'idle@corp.test'").first()).id;
  await go('POST', '/api/users/' + iid + '/approve', null, B);
  await SU.prepare('UPDATE users SET last_seen = ?1').bind(Date.now() - 91 * 86400e3).run();
  let waitedU = null;
  await worker.scheduled({ cron: '0 18 * * *' }, envU, { waitUntil(p3) { waitedU = p3; } });
  await waitedU;
  const st = Object.fromEntries((await SU.prepare("SELECT email, status FROM users WHERE status != 'deleted'").all()).results.map(u => [u.email, u.status]));
  ok(st['idle@corp.test'] === 'suspended' && st['member@corp.test'] === 'active', '밤 작업: 90일 미접속 회원 정지 · 마지막 관리자는 그대로', st);
  x = await go('GET', '/api/users/audit', null, B);
  ok(x.body.audit.some(a => a.action === 'withdraw') && x.body.audit.some(a => a.action === 'suspend' && a.actor === '자동' && /90일/.test(a.detail)) && x.body.audit.some(a => a.action === 'temp'),
    '관리 기록: 탈퇴 · 자동 정지 · 임시 비밀번호', x.body.audit.map(a => a.action).slice(0, 8));

  console.log('  (남용 제한 · 준비 전 · 잠금 끔)');
  const ipS = { 'cf-connecting-ip': '203.0.113.9' };
  let last = null;
  for (let i = 0; i < 31; i++) last = await go('POST', '/api/auth/signup', { email: 'spam' + i + '@corp.test', name: '스팸', salt: newSalt(), iter: ITER, dk: 'y'.repeat(43), consent: true }, ipS);
  ok(last.status === 429, '가입 신청: 같은 주소 1시간 30번 넘으면 429', last.status);
  const ipL = { 'cf-connecting-ip': '203.0.113.10' };
  for (let i = 0; i < 30; i++) await go('POST', '/api/auth/login', { email: 'nobody' + i + '@corp.test', dk: 'z'.repeat(43) }, ipL);
  x = await go('POST', '/api/auth/login', { email: 'member@corp.test', dk: 'z'.repeat(43) }, ipL);
  ok(x.status === 429, '틀린 로그인: 같은 주소 1시간 30번 넘으면 429', x.status);
  x = await loginAs('member@corp.test', 'member-pass3', false, { 'cf-connecting-ip': '203.0.113.11' });
  ok(x.status === 200, '다른 주소에서 맞는 비밀번호 → 그대로 로그인', x.status);
  x = await go('POST', '/api/auth/login', { email: 'member@corp.test', dk: 'z'.repeat(43) }, { origin: 'https://evil.example' });
  ok(x.status === 403, '다른 사이트에서 보낸 로그인 → 403', x.status);
  const env0 = { ASSETS, RATES: kv(), STATS: d1() };
  x = await go('GET', '/api/auth/me', null, {}, env0);
  ok(x.status === 200 && x.body.ready === false && x.body.user === null, '비밀값(AUTH_PEPPER) 없음 → 회원 기능 준비 전(ready=false)', x.body);
  x = await go('POST', '/api/auth/login', { email: 'a@b.cc', dk: 'z'.repeat(43) }, {}, env0);
  ok(x.status === 503, '준비 전 로그인 → 503', x.status);
  x = await go('GET', '/api/rates', null, {}, env0);
  ok(x.status === 200, '준비 전에도 팀 설정 읽기는 그대로', x.status);
  const envOff = Object.assign({}, envU, { AUTH_ENFORCE: '0' });
  x = await go('GET', '/data/pulse.json', null, {}, envOff);
  ok(x.status === 200, '잠금 끔(AUTH_ENFORCE=0) → 마켓 펄스 자료 누구나', x.status);
  x = await go('GET', cf, null, anon, envOff);
  ok(x.status === 200, '잠금 끔 → 비교 매물 한도 없음', x.status);
  x = await go('GET', '/downloads/market_models.csv', null, {}, envOff);
  ok(x.status === 401, '잠금을 꺼도 내려받기는 회원만', x.status);
  const envB = Object.assign({}, envU, { STATS: { prepare() { throw new Error('down'); }, batch() { return Promise.reject(new Error('down')); } } });
  x = await go('GET', cf, null, anon, envB);
  ok(x.status === 200, '회원 저장소(D1) 오류 → 비교 매물은 그대로(공개 화면 한 대 산정은 계속)', x.status);
  x = await go('GET', '/api/rates', null, {}, envB);
  ok(x.status === 200 && x.body.team && x.body.team.cells && x.body.team.updated_by === undefined, '회원 저장소 오류 → 팀 설정 값은 그대로(이름은 뺌)', x.status);
  x = await go('GET', '/data/pulse.json', null, {}, envB);
  ok(x.status === 401, '회원 저장소 오류 → 회원 전용 자료는 막힌 채로', x.status);
}

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
