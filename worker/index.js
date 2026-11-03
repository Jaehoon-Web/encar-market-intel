/*
 * worker/index.js — 사이트 Worker: 정적 자산(web/) + 환산 비율 팀 공용 저장소 API (기획안 5.1.6 · D6) + 이용 통계 기록 (기획안 5.11)
 *
 *   GET /api/rates          → { ok, store, writable, team }   팀이 고친 것(아직 없으면 team = null)
 *   GET /api/rates?rev=N    → { ok, team }                    N판(되돌리기용, 180일 보관)
 *   PUT /api/rates          본문 { password, rev, by, note, cells, models } → { ok, team }   새 판 저장
 *   POST /api/ev            본문 { u, s, d, e: [[시각, 종류, 화면, 이름, 값], …] } → 204   이용 통계(web/v2/track.js)
 *   POST /api/admin/login   본문 { password } → { ok, token, exp }   관리자 30일 출입증(web/v2/admin.js)
 *   GET  /api/admin/stats?days=7|30|90   머리글 Authorization: Bearer 출입증 → { ok, today, days: [하루 요약…] }
 *   매일 03:00(한국) 예약 작업 → 전날 하루 요약을 만들고 1년 지난 기록을 지운다
 *
 * 초기값(경매 갭 분석 요약치)은 정적 파일 /data/conversion_rates.json 이고, 여기에는 팀이 고친 것만 둔다.
 *   cells  = 기준표(호가대 × 차령)와 같은 꼴의 2차원 배열. 숫자면 그 칸을 팀 값으로, null 이면 초기값 그대로
 *   models = [{ 제조사, 모델(세부모델), 연료(비우면 전체), 비율, 메모 }] — 모델별 비율(모델 예외보다 먼저)
 * 바인딩(wrangler.toml · Cloudflare 설정): RATES = KV 저장소, RATES_PASSWORD = 수정 비밀번호(비밀값), ASSETS = 정적 자산,
 *   STATS = 이용 통계 D1(없으면 기록은 조용히 건너뜀), ADMIN_PASSWORD = 관리자 비밀번호(비밀값 — 사용자가 직접 넣음).
 * 그 밖의 주소는 정적 자산으로 넘긴다. 비밀번호가 틀리면 1초 쉬고 401(무차별 대입 방지, KV에는 쓰지 않는다).
 */
import { summarize } from './summary.js';

const KEY = 'team';
const KEEP_DAYS = 180;
const MAX_BODY = 64 * 1024;
const MAX_MODELS = 500;
const MAX_LOG = 100;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function digest(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))));
}
async function samePassword(a, b) {                          // 해시끼리 비교 — 길이·내용에 따라 걸리는 시간이 달라지지 않게
  const x = await digest(a), y = await digest(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const keyOf = m => m['제조사'] + '|' + m['모델'] + '|' + (m['연료'] || '');

function rate(v) {                                            // 0~60(%) · 소수 첫째 자리 · 빈칸은 null
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 60) throw new Error('비율은 0~60(%) 사이 숫자로 넣어 주세요: ' + str(v, 20));
  return Math.round(n * 10) / 10;
}

async function bandLabels(env, origin) {                    // 기준표 행·열 이름(호가대 · 차령) — 정적 초기값 파일에서
  try {
    const r = await env.ASSETS.fetch(new Request(origin + '/data/conversion_rates.json'));
    const b = await r.json();
    return { p: b.price_bands.map(x => x.label), a: b.age_bands.map(x => x.label) };
  } catch (e) {
    return null;
  }
}

// 새 판 만들기: 값 검사 · 모델별 수정자·수정일 · 바뀐 점 기록. L = 기준표 행·열 이름(없으면 번호로)
function build(cur, body, now, L) {
  const by = str(body.by, 30);
  if (!by) throw new Error('수정하는 사람 이름을 넣어 주세요');
  const cells = body.cells;
  if (!Array.isArray(cells) || !cells.length || cells.length > 10 || cells.some(r => !Array.isArray(r) || r.length !== cells[0].length || r.length > 10) ||
      (L && (cells.length !== L.p.length || cells[0].length !== L.a.length))) {
    throw new Error('기준표 모양이 맞지 않습니다');
  }
  const C = cells.map(r => r.map(rate));
  if (!Array.isArray(body.models) || body.models.length > MAX_MODELS) throw new Error('모델별 비율은 ' + MAX_MODELS + '개까지입니다');
  const old = {};
  ((cur && cur.models) || []).forEach(m => { old[keyOf(m)] = m; });
  const seen = {}, M = [];
  body.models.forEach(m => {
    const o = { '제조사': str(m['제조사'], 40), '모델': str(m['모델'], 80), '연료': str(m['연료'], 20), '비율': rate(m['비율']), '메모': str(m['메모'], 200) };
    if (!o['제조사'] || !o['모델']) throw new Error('모델별 비율에 제조사·모델이 비었습니다');
    if (o['비율'] === null) throw new Error(o['모델'] + ': 비율을 넣어 주세요');
    const k = keyOf(o), p = old[k];
    const same = p && p['비율'] === o['비율'] && p['메모'] === o['메모'];
    o['수정자'] = same ? p['수정자'] : by;
    o['수정일'] = same ? p['수정일'] : now;
    if (seen[k] != null) M[seen[k]] = o; else { seen[k] = M.length; M.push(o); }   // 같은 모델·연료는 뒤의 것
  });

  const what = [], pc = (cur && cur.cells) || [];
  C.forEach((r, i) => r.forEach((v, j) => {
    const p = pc[i] && pc[i][j] != null ? pc[i][j] : null;
    if (p !== v) what.push('기준표 ' + (L ? L.p[i] + '·' + L.a[j] : (i + 1) + '행 ' + (j + 1) + '열') + ' ' + (p == null ? '초기값' : p) + ' → ' + (v == null ? '초기값' : v));
  }));
  M.forEach(m => {
    const p = old[keyOf(m)], name = m['모델'] + (m['연료'] ? '(' + m['연료'] + ')' : '');
    if (!p) what.push('모델 추가 ' + name + ' ' + m['비율'] + '%');
    else if (p['비율'] !== m['비율']) what.push('모델 변경 ' + name + ' ' + p['비율'] + ' → ' + m['비율'] + '%');
    else if (p['메모'] !== m['메모']) what.push('메모 변경 ' + name);
  });
  Object.keys(old).forEach(k => { if (seen[k] == null) what.push('모델 삭제 ' + old[k]['모델'] + (old[k]['연료'] ? '(' + old[k]['연료'] + ')' : '')); });
  if (!what.length) throw new Error('바뀐 것이 없습니다');

  const rev = (cur ? cur.rev : 0) + 1, note = str(body.note, 200);
  const log = [{ rev, at: now, by, note, what: what.slice(0, 40) }].concat((cur && cur.log) || []).slice(0, MAX_LOG);
  return { rev, updated_at: now, updated_by: by, cells: C, models: M, log };
}

async function get(url, env) {
  if (!env.RATES) return json({ ok: true, store: false, writable: false, team: null });
  const want = url.searchParams.get('rev');
  if (want != null) {
    const cur = await env.RATES.get(KEY, 'json');
    const t = cur && String(cur.rev) === want ? cur : await env.RATES.get(KEY + ':' + Number(want), 'json');
    return t ? json({ ok: true, team: t }) : json({ ok: false, error: want + '판이 없습니다' }, 404);
  }
  const team = await env.RATES.get(KEY, 'json');
  return json({ ok: true, store: true, writable: !!env.RATES_PASSWORD, team });
}

async function put(request, env) {
  if (!env.RATES) return json({ ok: false, error: '저장소(KV)가 아직 연결되지 않았습니다' }, 503);
  if (!env.RATES_PASSWORD) return json({ ok: false, error: '수정 비밀번호가 아직 설정되지 않았습니다' }, 503);
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return json({ ok: false, error: '보낸 내용이 너무 큽니다' }, 413);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: '보낸 내용이 너무 큽니다' }, 413);
  let body;
  try { body = JSON.parse(text); } catch (e) { return json({ ok: false, error: '내용을 읽을 수 없습니다' }, 400); }
  if (!body || typeof body !== 'object') return json({ ok: false, error: '내용을 읽을 수 없습니다' }, 400);
  if (!(await samePassword(body.password == null ? '' : body.password, env.RATES_PASSWORD))) {
    await sleep(1000);
    return json({ ok: false, error: '비밀번호가 맞지 않습니다' }, 401);
  }
  const cur = await env.RATES.get(KEY, 'json');
  if (Number(body.rev) !== (cur ? cur.rev : 0)) {
    return json({ ok: false, error: '그사이 다른 사람이 저장했습니다. 다시 불러온 뒤 고쳐 주세요', team: cur }, 409);
  }
  let next;
  try {
    next = build(cur, body, new Date().toISOString(), await bandLabels(env, new URL(request.url).origin));
  } catch (e) {
    return json({ ok: false, error: e.message }, 400);
  }
  if (cur) await env.RATES.put(KEY + ':' + cur.rev, JSON.stringify(cur), { expirationTtl: KEEP_DAYS * 86400 });
  await env.RATES.put(KEY, JSON.stringify(next));
  return json({ ok: true, team: next });
}

// ───── 이용 통계(기획 v2.28 · 5.11, 인터뷰 Q148~Q173) ─────
// 익명 번호(u · 방문 s)와 행동만 받는다. 이름·IP·위치는 받지도 적지도 않는다(요청 머리글의 IP를 읽지 않음).
// 받은 묶음은 SQL 한 문장(json_each)으로 넣는다 — D1 무료 요금제의 '요청 한 번에 50문장' 한도와 무관하게.
const EV_TYPES = new Set(['start', 'view', 'vis', 'act', 'export', 'result', 'pick', 'depth', 'miss', 'batch', 'err', 'perf']);
const EV_MAX = 200;
const ID_RE = /^[a-z0-9]{16}$/;
const SCR_RE = /^[a-z.]{0,20}$/;
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS ev (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, day TEXT NOT NULL, uid TEXT NOT NULL, sid TEXT NOT NULL,' +
    ' dev TEXT, type TEXT NOT NULL, scr TEXT, name TEXT, val TEXT)',
  'CREATE INDEX IF NOT EXISTS ev_day ON ev(day)',
  'CREATE INDEX IF NOT EXISTS ev_sid ON ev(sid)',
  'CREATE TABLE IF NOT EXISTS day_sum (day TEXT PRIMARY KEY, data TEXT NOT NULL, made INTEGER NOT NULL)'
];
const EV_INSERT = 'INSERT INTO ev (ts, day, uid, sid, dev, type, scr, name, val) SELECT json_extract(value, \'$[0]\'), json_extract(value, \'$[1]\'), ?2, ?3, ?4,' +
  ' json_extract(value, \'$[2]\'), json_extract(value, \'$[3]\'), json_extract(value, \'$[4]\'), json_extract(value, \'$[5]\') FROM json_each(?1)';
const ready = new WeakMap();
function ensure(db) {                                         // 표가 없으면 만든다(저장소마다 한 번)
  let p = ready.get(db);
  if (!p) { p = db.batch(SCHEMA.map(q => db.prepare(q))).catch(e => { ready.delete(db); throw e; }); ready.set(db, p); }
  return p;
}
const kstDay = ms => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const empty = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });

async function ev(request, env) {
  if (!env.STATS) return empty();                              // 저장소 연결 전에도 사이트는 그대로
  const origin = request.headers.get('origin');
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch (e) { /* 'null' 등 */ }
    if (host !== new URL(request.url).host) return json({ ok: false, error: '이 사이트에서만 기록합니다' }, 403);
  }
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return json({ ok: false, error: '보낸 내용이 너무 큽니다' }, 413);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: '보낸 내용이 너무 큽니다' }, 413);
  let b;
  try { b = JSON.parse(text); } catch (e) { return json({ ok: false, error: '내용을 읽을 수 없습니다' }, 400); }
  if (!b || !ID_RE.test(b.u) || !ID_RE.test(b.s) || !Array.isArray(b.e)) return json({ ok: false, error: '형식이 맞지 않습니다' }, 400);
  const now = Date.now(), rows = [];
  for (const x of b.e.slice(0, EV_MAX)) {
    if (!Array.isArray(x) || !EV_TYPES.has(x[1])) continue;
    let t = Math.round(Number(x[0]));
    if (!Number.isFinite(t) || t > now + 60e3 || t < now - 2 * 86400e3) t = now;   // 브라우저 시계가 크게 틀리면 받은 시각으로
    const scr = str(x[2], 20);
    if (!SCR_RE.test(scr)) continue;
    rows.push([t, kstDay(t), x[1], scr, str(x[3], 60), str(x[4], 200)]);
  }
  if (!rows.length) return empty();
  await ensure(env.STATS);
  await env.STATS.prepare(EV_INSERT).bind(JSON.stringify(rows), b.u, b.s, b.d === 'm' ? 'm' : 'pc').run();
  return empty();
}

// ───── 관리자 대시보드(기획 v2.28 · 5.11.3) ─────
// 출입증 = 만료 시각 + HMAC(관리자 비밀번호로 서명). 비밀번호를 바꾸면 이전 출입증은 모두 무효. 비밀번호 자체는 어디에도 저장하지 않는다.
const ADMIN_DAYS = 30, KEEP_EV_DAYS = 365, KEEP_SUM_DAYS = 400;
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sign(env, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('admin:' + env.ADMIN_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function admitted(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const m = /^Bearer\s+(\d{12,16})\.([A-Za-z0-9_-]{20,})$/.exec(request.headers.get('authorization') || '');
  if (!m || +m[1] < Date.now()) return false;
  return samePassword(m[2], await sign(env, m[1]));
}
async function login(request, env) {
  if (!env.ADMIN_PASSWORD) return json({ ok: false, error: '관리자 비밀번호가 아직 설정되지 않았습니다 — Cloudflare에 ADMIN_PASSWORD(비밀값)를 넣어 주세요' }, 503);
  const text = await request.text();
  if (text.length > 2000) return json({ ok: false, error: '보낸 내용이 너무 큽니다' }, 413);
  let b = null;
  try { b = JSON.parse(text); } catch (e) { /* 아래에서 틀린 비밀번호로 */ }
  if (!(await samePassword(b && b.password != null ? b.password : '', env.ADMIN_PASSWORD))) {
    await sleep(1000);
    return json({ ok: false, error: '비밀번호가 맞지 않습니다' }, 401);
  }
  const exp = String(Date.now() + ADMIN_DAYS * 86400e3);
  return json({ ok: true, token: exp + '.' + await sign(env, exp), exp: +exp });
}

const dayRows = (db, d) => db.prepare('SELECT sid, uid, dev, ts, type, scr, name, val FROM ev WHERE day = ?1 ORDER BY sid, ts, id').bind(d).all().then(r => r.results);
async function rollup(db, d) {                               // 지난 날의 요약을 만들어 둔다(기록이 없는 날은 빈 요약 — 다시 찾지 않게)
  const rows = await dayRows(db, d), sum = rows.length ? summarize(d, rows) : { day: d, empty: true };
  await db.prepare('INSERT OR REPLACE INTO day_sum (day, data, made) VALUES (?1, ?2, ?3)').bind(d, JSON.stringify(sum), Date.now()).run();
  return sum;
}
async function stats(request, env, url) {
  if (!(await admitted(request, env))) return json({ ok: false, error: env.ADMIN_PASSWORD ? '다시 로그인해 주세요' : '관리자 비밀번호가 아직 설정되지 않았습니다' }, 401);
  const now = Date.now(), today = kstDay(now);
  if (!env.STATS) return json({ ok: true, store: false, today, now, days: [] });
  const n = [7, 30, 90].indexOf(+url.searchParams.get('days')) >= 0 ? +url.searchParams.get('days') : 7, list = [];
  for (let k = n - 1; k >= 0; k--) list.push(kstDay(now - k * 86400e3));
  await ensure(env.STATS);
  const have = {};
  (await env.STATS.prepare('SELECT day, data FROM day_sum WHERE day >= ?1 AND day < ?2').bind(list[0], today).all()).results
    .forEach(r => { have[r.day] = JSON.parse(r.data); });
  let budget = 5;                                             // 새벽 작업 전이면 여기서 만든다(한 번에 5일까지)
  for (const d of list.slice().reverse()) if (d !== today && !have[d] && budget-- > 0) have[d] = await rollup(env.STATS, d);   // 어제부터
  have[today] = summarize(today, await dayRows(env.STATS, today));   // 오늘은 그때그때(진행 중)
  return json({ ok: true, store: true, today, now, days: list.map(d => have[d] || { day: d, missing: true }) });
}
async function nightly(env) {                                // 매일 03:00(한국): 어제 요약(늦게 온 기록까지) · 빠진 이틀 채우기 · 1년 지난 기록 지우기
  if (!env.STATS) return;
  await ensure(env.STATS);
  const now = Date.now();
  await rollup(env.STATS, kstDay(now - 86400e3));
  for (const k of [2, 3]) {
    const d = kstDay(now - k * 86400e3);
    if (!(await env.STATS.prepare('SELECT 1 FROM day_sum WHERE day = ?1').bind(d).first())) await rollup(env.STATS, d);
  }
  await env.STATS.prepare('DELETE FROM ev WHERE day < ?1').bind(kstDay(now - KEEP_EV_DAYS * 86400e3)).run();
  await env.STATS.prepare('DELETE FROM day_sum WHERE day < ?1').bind(kstDay(now - KEEP_SUM_DAYS * 86400e3)).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/rates') {
      if (request.method === 'GET') return get(url, env);
      if (request.method === 'PUT') return put(request, env);
      return json({ ok: false, error: 'GET 또는 PUT만 됩니다' }, 405);
    }
    if (url.pathname === '/api/ev') {
      if (request.method !== 'POST') return json({ ok: false, error: 'POST만 됩니다' }, 405);
      try { return await ev(request, env); } catch (e) { return json({ ok: false, error: '기록하지 못했습니다' }, 500); }   // 기록 실패가 화면을 막지 않게
    }
    if (url.pathname === '/api/admin/login') {
      if (request.method !== 'POST') return json({ ok: false, error: 'POST만 됩니다' }, 405);
      return login(request, env);
    }
    if (url.pathname === '/api/admin/stats') {
      if (request.method !== 'GET') return json({ ok: false, error: 'GET만 됩니다' }, 405);
      return stats(request, env, url);
    }
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: '없는 주소입니다' }, 404);
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(nightly(env));
  }
};
