// worker_check.mjs — 사이트 Worker(worker/index.js)의 환산 비율 저장소 API 시험 (Cloudflare 없이 Node로)
//   node tools/worker_check.mjs
// 가짜 KV(메모리)와 가짜 정적 자산(web/ 폴더)을 붙여 GET·PUT·비밀번호·동시 저장·값 검사·되돌리기용 판 보관을 확인한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const worker = (await import(pathToFileURL(path.join(ROOT, 'worker', 'index.js')).href)).default;

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

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
