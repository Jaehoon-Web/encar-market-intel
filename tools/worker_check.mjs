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
r = await worker.fetch(new Request('https://x.test/v2/index.html'), env);
ok(r.status === 200 && (await r.text()).indexOf('<html') >= 0, '그 밖의 주소 → 정적 자산', r.status);
r = await call(env, 'PUT', { password: '팀비번-2026', rev: 3, by: '가'.repeat(10), cells, models: Array.from({ length: 501 }, (_, i) => ({ '제조사': 'A', '모델': 'M' + i, '비율': 10 })) });
ok(r.status === 400 || r.status === 413, '모델 501개 → 거절', r.status);
r = await worker.fetch(new Request('https://x.test/api/rates', { method: 'PUT', body: 'x'.repeat(70000) }), env);
ok(r.status === 413, '64KB 넘는 본문 → 413', r.status);

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

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
