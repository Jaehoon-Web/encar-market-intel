/*
 * worker/auth.js — 회원(가입 신청 · 관리자 승인 · 로그인) · 세션 · 잠금 · 남용 제한 · 회원 관리 API
 *   기획: PLAN_로그인_회원관리_기획안.md(인터뷰 Q267~Q290). index.js 가 주소를 나눠 여기로 보낸다.
 *
 * 저장소는 D1(env.STATS — 이용 통계와 같은 DB, 표 users · sessions · audit · rl). 비밀값 AUTH_PEPPER가 없으면 회원 기능은 503(준비 중).
 * 비밀번호 원문은 서버로 오지 않는다: 브라우저가 PBKDF2-SHA256(60만 번)으로 다진 값(dk)을 보내고, 서버는 HMAC(AUTH_PEPPER, dk)만 저장한다.
 *   무료 Worker는 요청당 계산 10ms라 서버에서 오래 다질 수 없어서다(기획 5.2). 저장소가 새어도 비밀값 없이는 맞혀 볼 수 없다.
 * 세션 = 무작위 토큰 쿠키(cr_s, HttpOnly · Secure · SameSite=Lax), D1에는 토큰의 해시만. 상태를 바꾸는 요청은 같은 사이트(Origin)에서만.
 *
 *   GET  /api/auth/me                 → { ok, ready, enforce, user|null, pending?, resets? }
 *   GET  /api/auth/salt?email=        → { ok, salt, iter }   없는 메일도 그럴듯한 고정 값(가입 여부를 드러내지 않게)
 *   POST /api/auth/signup             { email, name, salt, iter, dk, consent } → 가입 신청(관리자 승인 대기)
 *   POST /api/auth/login              { email, dk, remember } → 쿠키 · { ok, user }   5번 틀리면 15분 잠금
 *   POST /api/auth/logout · /api/auth/password { dk, salt, iter, newDk } · /api/auth/forgot { email }
 *   PATCH /api/auth/me { name } · DELETE /api/auth/me { dk }(탈퇴)
 *   GET  /api/users · /api/users/audit · POST /api/users/{id}/{approve|reject|suspend|resume|role|edit|unlock|temp} · DELETE /api/users/{id}   (관리자)
 */

export const COOKIE = 'cr_s';
const DAY = 86400e3, HOUR = 3600e3;
const REMEMBER_MS = 30 * DAY, IDLE_MS = 12 * HOUR;             // '이 기기 기억' 30일 · 아니면 쓰지 않은 지 12시간(Q279)
const LOCK_FAILS = 5, LOCK_MS = 15 * 60e3;                     // 5번 틀리면 15분(Q281)
export const KDF_ITER = 600000;
const KDF_MIN = 100000, KDF_MAX = 2000000;
const INACTIVE_MS = 90 * DAY, REJECT_KEEP_MS = 30 * DAY, SUSPEND_KEEP_MS = 365 * DAY;   // 90일 미접속 자동 정지(Q283) · 거절 30일 · 정지 1년 뒤 삭제(동의 문구)
// 접속 주소별 1시간(Q276 · 기획 5.4). 회사는 여러 사람이 한 공용 주소로 나가므로 주소 한도는 넉넉히 —
// 로그인은 틀린 시도만 세고(계정마다 5번 잠금이 따로 있음), 로그인하지 않은 비교 매물은 브라우저마다 30개 · 같은 주소 전체 300개
export const LIMITS = { loginFail: 30, signup: 30, forgot: 20, comps: 30, compsIp: 300 };
export const CONSENT_VER = '2026-11-06';
const MAX_AUTH_BODY = 4000;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, salt TEXT NOT NULL, iter INTEGER NOT NULL, pw TEXT NOT NULL,' +
    " role TEXT NOT NULL DEFAULT 'member', can_edit INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', must_change INTEGER NOT NULL DEFAULT 0," +
    ' fails INTEGER NOT NULL DEFAULT 0, lock_until INTEGER NOT NULL DEFAULT 0, reset_at INTEGER, dup_at INTEGER, created_at INTEGER NOT NULL, approved_at INTEGER,' +
    ' approved_by INTEGER, status_at INTEGER, last_seen INTEGER, consent_at INTEGER, consent_ver TEXT)',
  'CREATE TABLE IF NOT EXISTS sessions (th TEXT PRIMARY KEY, uid INTEGER NOT NULL, remember INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, seen_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid)',
  'CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor INTEGER, action TEXT NOT NULL, target INTEGER, detail TEXT)',
  'CREATE TABLE IF NOT EXISTS rl (k TEXT NOT NULL, w INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (k, w))'
];
const ready = new WeakMap();
export function ensureAuth(db) {                               // 표가 없으면 만든다(저장소마다 한 번)
  let p = ready.get(db);
  if (!p) { p = db.batch(SCHEMA.map(q => db.prepare(q))).catch(e => { ready.delete(db); throw e; }); ready.set(db, p); }
  return p;
}

// ───── 작은 도구 ─────
export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers) });
}
const enc = s => new TextEncoder().encode(String(s));
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pepper = env => String(env.AUTH_PEPPER || '').trim();
export const authReady = env => !!(env.STATS && pepper(env));
export const enforce = env => String(env.AUTH_ENFORCE || '') === '1';
const kstDay = ms => new Date(ms + 9 * HOUR).toISOString().slice(0, 10);
const kstHM = ms => new Date(ms + 9 * HOUR).toISOString().slice(11, 16);
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey('raw', enc('auth:' + pepper(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc(msg)));
}
async function sha(s) { return b64u(await crypto.subtle.digest('SHA-256', enc(s))); }
function same(a, b) {                                           // 같은 길이 문자열을 일정 시간에 비교
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
const pwHash = (env, dk) => hmac(env, 'pw|' + dk);
const SALT_RE = /^[A-Za-z0-9_-]{16,64}$/, DK_RE = /^[A-Za-z0-9_-]{43}$/;
function emailOf(v) {
  const e = String(v == null ? '' : v).trim().toLowerCase().normalize('NFC');
  return e.length <= 120 && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(e) ? e : null;
}
const nameOf = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().normalize('NFC').slice(0, 30);
const iterOf = v => { const n = Number(v); return Number.isInteger(n) && n >= KDF_MIN && n <= KDF_MAX ? n : null; };
async function body(request) {
  const text = await request.text();
  if (text.length > MAX_AUTH_BODY) throw Object.assign(new Error('보낸 내용이 너무 큽니다'), { status: 413 });
  try { const b = JSON.parse(text); if (b && typeof b === 'object') return b; } catch (e) { /* 아래 */ }
  throw Object.assign(new Error('내용을 읽을 수 없습니다'), { status: 400 });
}
export function sameSite(request) {                             // 상태를 바꾸는 요청은 이 사이트 화면에서 온 것만(쿠키를 노린 다른 사이트 요청 막기)
  const o = request.headers.get('origin');
  if (!o) return false;
  try { return new URL(o).host === new URL(request.url).host; } catch (e) { return false; }
}
export async function ipKey(env, request) {                    // 접속 주소는 그대로 두지 않는다 — 날마다 바뀌는 해시로 1시간만 센다
  return (await hmac(env, 'ip|' + kstDay(Date.now()) + '|' + (request.headers.get('cf-connecting-ip') || 'local'))).slice(0, 22);
}
export async function hit(db, k, limit) {                       // 1시간 창에 한 번 세고, 한도 안이면 true
  const w = Math.floor(Date.now() / HOUR);
  const n = await db.prepare('INSERT INTO rl (k, w, n) VALUES (?1, ?2, 1) ON CONFLICT(k, w) DO UPDATE SET n = n + 1 RETURNING n').bind(k, w).first('n');
  return Number(n) <= limit;
}
async function count(db, k) {
  return Number(await db.prepare('SELECT n FROM rl WHERE k = ?1 AND w = ?2').bind(k, Math.floor(Date.now() / HOUR)).first('n') || 0);
}
// 로그인하지 않은 비교 매물 받기(index.js 가 /data/comps/* 에서 부름) — 브라우저 번호(x-cr-a, 화면이 만든 무작위 값)마다 30개, 같은 주소 전체 300개
export async function anonQuota(env, request) {
  const db = env.STATS, ip = await ipKey(env, request), a = request.headers.get('x-cr-a') || '';
  await ensureAuth(db);
  const okA = await hit(db, 'comps:' + ip + ':' + (/^[a-z0-9]{8,32}$/.test(a) ? a : '-'), LIMITS.comps);
  const okIp = await hit(db, 'compsip:' + ip, LIMITS.compsIp);
  return okA && okIp;
}
async function audit(db, actor, action, target, detail) {
  await db.prepare('INSERT INTO audit (at, actor, action, target, detail) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(Date.now(), actor == null ? null : actor, action, target == null ? null : target, detail == null ? null : String(detail).slice(0, 300)).run();
}
const pub = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, canEdit: u.role === 'admin' || !!u.can_edit, mustChange: !!u.must_change });

// ───── 쿠키 · 세션 ─────
function cookieOf(request) {
  const m = /(?:^|;\s*)cr_s=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.get('cookie') || '');
  return m ? m[1] : null;
}
function setCookie(token, remember) {
  return COOKIE + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax' + (remember ? '; Max-Age=' + Math.round(REMEMBER_MS / 1000) : '');
}
const clearCookie = () => COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
async function newSession(db, uid, remember) {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const token = b64u(raw), now = Date.now();
  await db.prepare('INSERT INTO sessions (th, uid, remember, created_at, expires_at, seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?4)')
    .bind(await sha(token), uid, remember ? 1 : 0, now, now + (remember ? REMEMBER_MS : IDLE_MS)).run();
  return token;
}
// 쿠키 → { user, th, remember } | null. 쓰지 않은 세션은 늘리고(12시간 · 15분마다 한 번 씀), 회원의 마지막 접속은 하루 한 번만 고쳐 쓴다(D1 쓰기 줄이기)
export async function sessionOf(env, request) {
  if (!authReady(env)) return null;
  const token = cookieOf(request);
  if (!token) return null;
  const db = env.STATS;
  await ensureAuth(db);
  const th = await sha(token), now = Date.now();
  const r = await db.prepare('SELECT s.th, s.remember, s.expires_at, s.seen_at, u.* FROM sessions s JOIN users u ON u.id = s.uid WHERE s.th = ?1').bind(th).first();
  if (!r) return null;
  if (r.expires_at < now || r.status !== 'active') {
    await db.prepare('DELETE FROM sessions WHERE th = ?1').bind(th).run();
    return null;
  }
  if (now - r.seen_at > 15 * 60e3) {
    await db.prepare('UPDATE sessions SET seen_at = ?2, expires_at = ?3 WHERE th = ?1').bind(th, now, r.remember ? r.expires_at : now + IDLE_MS).run();
  }
  if (!r.last_seen || now - r.last_seen > DAY) await db.prepare('UPDATE users SET last_seen = ?2 WHERE id = ?1').bind(r.id, now).run();
  return { user: r, th, remember: !!r.remember };
}
export async function memberOf(env, request) { const s = await sessionOf(env, request); return s ? s.user : null; }
// 설정(⚙ · 팀 사전)을 고칠 수 있는 회원 — 관리자이거나 '설정 수정' 권한(Q272). 쿠키로 고치는 요청은 같은 사이트에서 온 것만
export async function editorOf(env, request) {
  if (!sameSite(request)) return null;
  const u = await memberOf(env, request);
  return u && (u.role === 'admin' || u.can_edit) ? u : null;
}
async function activeAdmins(db, except) {
  return Number(await db.prepare("SELECT count(*) n FROM users WHERE role = 'admin' AND status = 'active' AND id != ?1").bind(except == null ? -1 : except).first('n'));
}
async function anonymize(db, id) {                             // 탈퇴 · 삭제: 이름 · 메일 · 비밀번호 값을 지운다(기록에는 번호만 — 동의 문구)
  await db.batch([
    db.prepare("UPDATE users SET email = 'deleted-' || id, name = '탈퇴한 회원', salt = '', pw = '', status = 'deleted', role = 'member', can_edit = 0, must_change = 0," +
      ' reset_at = NULL, dup_at = NULL, status_at = ?2 WHERE id = ?1').bind(id, Date.now()),
    db.prepare('DELETE FROM sessions WHERE uid = ?1').bind(id)
  ]);
}

// ───── /api/auth/* ─────
async function me(env, request) {
  if (!env.STATS) return json({ ok: true, ready: false, enforce: enforce(env), user: null });
  if (!authReady(env)) return json({ ok: true, ready: false, enforce: enforce(env), user: null });
  const s = await sessionOf(env, request), out = { ok: true, ready: true, enforce: enforce(env), user: s ? pub(s.user) : null };
  if (s && s.user.role === 'admin') {
    const r = await env.STATS.prepare("SELECT sum(status = 'pending') p, sum(reset_at IS NOT NULL AND status != 'deleted') r FROM users").first();
    out.pending = Number(r && r.p || 0); out.resets = Number(r && r.r || 0);
  }
  return json(out);
}
async function salt(env, url) {
  const email = emailOf(url.searchParams.get('email'));
  if (!email) return json({ ok: false, error: '메일 주소를 확인해 주세요' }, 400);
  const r = await env.STATS.prepare("SELECT salt, iter FROM users WHERE email = ?1 AND status != 'deleted'").bind(email).first();
  return json({ ok: true, salt: r && r.salt ? r.salt : (await hmac(env, 'salt|' + email)).slice(0, 22), iter: r && r.iter ? r.iter : KDF_ITER });
}
async function signup(env, request) {
  const db = env.STATS;
  if (!(await hit(db, 'signup:' + await ipKey(env, request), LIMITS.signup))) return json({ ok: false, error: '가입 신청이 너무 잦습니다 — 한 시간 뒤에 다시 해 주세요' }, 429);
  const b = await body(request), email = emailOf(b.email), name = nameOf(b.name), iter = iterOf(b.iter);
  if (!email) return json({ ok: false, error: '메일 주소를 확인해 주세요' }, 400);
  if (!name) return json({ ok: false, error: '이름을 넣어 주세요' }, 400);
  if (!SALT_RE.test(String(b.salt || '')) || !DK_RE.test(String(b.dk || '')) || !iter) return json({ ok: false, error: '비밀번호를 다시 넣어 주세요' }, 400);
  if (b.consent !== true) return json({ ok: false, error: '개인정보 수집 · 이용에 동의해야 신청할 수 있습니다' }, 400);
  const now = Date.now(), pw = await pwHash(env, b.dk), cur = await db.prepare('SELECT id, status FROM users WHERE email = ?1').bind(email).first();
  if (cur && cur.status !== 'rejected') {                      // 이미 있는 메일: 같은 답(가입 여부를 드러내지 않음) — 관리자 화면에 '중복 신청'
    await db.prepare('UPDATE users SET dup_at = ?2 WHERE id = ?1').bind(cur.id, now).run();
  } else if (cur) {                                             // 거절된 메일은 다시 신청할 수 있다
    await db.prepare("UPDATE users SET name = ?2, salt = ?3, iter = ?4, pw = ?5, status = 'pending', created_at = ?6, status_at = ?6, dup_at = NULL, consent_at = ?6, consent_ver = ?7 WHERE id = ?1")
      .bind(cur.id, name, b.salt, iter, pw, now, CONSENT_VER).run();
  } else {
    await db.prepare("INSERT INTO users (email, name, salt, iter, pw, status, created_at, status_at, consent_at, consent_ver) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6, ?6, ?7)")
      .bind(email, name, b.salt, iter, pw, now, CONSENT_VER).run();
  }
  return json({ ok: true });
}
async function login(env, request) {
  const db = env.STATS;
  const ik = 'loginf:' + await ipKey(env, request);
  if ((await count(db, ik)) >= LIMITS.loginFail) return json({ ok: false, error: '틀린 로그인이 너무 잦습니다 — 한 시간 뒤에 다시 해 주세요' }, 429);
  const b = await body(request), email = emailOf(b.email), dk = String(b.dk || ''), now = Date.now();
  const WRONG = '메일 또는 비밀번호가 맞지 않습니다 — 5번 틀리면 15분 동안 잠깁니다';
  const u = email && DK_RE.test(dk) ? await db.prepare("SELECT * FROM users WHERE email = ?1 AND status != 'deleted'").bind(email).first() : null;
  const h = await pwHash(env, DK_RE.test(dk) ? dk : 'x');      // 없는 메일도 같은 계산(걸리는 시간으로 가입 여부를 알 수 없게)
  if (!u) { await hit(db, ik, LIMITS.loginFail); return json({ ok: false, error: WRONG }, 401); }
  if (u.lock_until > now) return json({ ok: false, code: 'locked', until: u.lock_until, error: kstHM(u.lock_until) + '까지 잠겨 있습니다 — 그 뒤에 다시 해 주세요' }, 423);
  if (!same(h, u.pw)) {
    await hit(db, ik, LIMITS.loginFail);
    const fails = u.fails + 1;
    if (fails >= LOCK_FAILS) {
      await db.prepare('UPDATE users SET fails = 0, lock_until = ?2 WHERE id = ?1').bind(u.id, now + LOCK_MS).run();
      return json({ ok: false, code: 'locked', until: now + LOCK_MS, error: LOCK_FAILS + '번 틀려 ' + kstHM(now + LOCK_MS) + '까지 잠겼습니다' }, 423);
    }
    await db.prepare('UPDATE users SET fails = ?2 WHERE id = ?1').bind(u.id, fails).run();
    return json({ ok: false, error: WRONG }, 401);
  }
  if (u.fails || u.lock_until) await db.prepare('UPDATE users SET fails = 0, lock_until = 0 WHERE id = ?1').bind(u.id).run();
  if (u.status === 'pending') return json({ ok: false, code: 'pending', error: '가입 신청을 확인하고 있습니다 — 관리자가 승인하면 들어올 수 있습니다' }, 403);
  if (u.status === 'rejected') return json({ ok: false, code: 'rejected', error: '가입 신청이 승인되지 않았습니다 — 관리자에게 문의해 주세요' }, 403);
  if (u.status !== 'active') return json({ ok: false, code: 'suspended', error: '정지된 계정입니다 — 관리자에게 문의해 주세요' }, 403);
  const remember = b.remember === true, token = await newSession(db, u.id, remember);
  await db.prepare('UPDATE users SET last_seen = ?2 WHERE id = ?1').bind(u.id, now).run();
  return json({ ok: true, user: pub(u) }, 200, { 'set-cookie': setCookie(token, remember) });
}
async function logout(env, request) {
  const token = cookieOf(request);
  if (token && env.STATS) { await ensureAuth(env.STATS); await env.STATS.prepare('DELETE FROM sessions WHERE th = ?1').bind(await sha(token)).run(); }
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
}
async function password(env, request, s) {
  const db = env.STATS, b = await body(request), iter = iterOf(b.iter);
  if (!DK_RE.test(String(b.dk || '')) || !same(await pwHash(env, b.dk), s.user.pw)) return json({ ok: false, error: '지금 비밀번호가 맞지 않습니다' }, 401);
  if (!SALT_RE.test(String(b.salt || '')) || !DK_RE.test(String(b.newDk || '')) || !iter) return json({ ok: false, error: '새 비밀번호를 다시 넣어 주세요' }, 400);
  if (b.newDk === b.dk && b.salt === s.user.salt) return json({ ok: false, error: '지금과 다른 비밀번호로 바꿔 주세요' }, 400);
  await db.batch([
    db.prepare('UPDATE users SET salt = ?2, iter = ?3, pw = ?4, must_change = 0, reset_at = NULL WHERE id = ?1').bind(s.user.id, b.salt, iter, await pwHash(env, b.newDk)),
    db.prepare('DELETE FROM sessions WHERE uid = ?1').bind(s.user.id)   // 다른 기기의 로그인도 끊는다
  ]);
  const token = await newSession(db, s.user.id, s.remember);
  await audit(db, s.user.id, 'password', s.user.id, s.user.must_change ? '임시 비밀번호 바꿈' : '');
  return json({ ok: true }, 200, { 'set-cookie': setCookie(token, s.remember) });
}
async function forgot(env, request) {
  const db = env.STATS;
  if (!(await hit(db, 'forgot:' + await ipKey(env, request), LIMITS.forgot))) return json({ ok: false, error: '요청이 너무 잦습니다 — 한 시간 뒤에 다시 해 주세요' }, 429);
  const email = emailOf((await body(request)).email);
  if (email) await db.prepare("UPDATE users SET reset_at = ?2 WHERE email = ?1 AND status IN ('active', 'suspended')").bind(email, Date.now()).run();
  return json({ ok: true });                                    // 없는 메일도 같은 답
}
async function rename(env, request, s) {
  const name = nameOf((await body(request)).name);
  if (!name) return json({ ok: false, error: '이름을 넣어 주세요' }, 400);
  await env.STATS.prepare('UPDATE users SET name = ?2 WHERE id = ?1').bind(s.user.id, name).run();
  return json({ ok: true, user: pub(Object.assign({}, s.user, { name })) });
}
async function withdraw(env, request, s) {
  const db = env.STATS, b = await body(request);
  if (!DK_RE.test(String(b.dk || '')) || !same(await pwHash(env, b.dk), s.user.pw)) return json({ ok: false, error: '비밀번호가 맞지 않습니다' }, 401);
  if (s.user.role === 'admin' && (await activeAdmins(db, s.user.id)) === 0) return json({ ok: false, error: '마지막 관리자는 탈퇴할 수 없습니다 — 다른 회원을 관리자로 먼저 지정해 주세요' }, 409);
  await anonymize(db, s.user.id);
  await audit(db, s.user.id, 'withdraw', s.user.id, '');
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
}

// ───── /api/users/* (관리자) — 관리자 회원의 세션, 또는 전환 기간 동안 관리자 비밀번호 출입증(Q273) ─────
async function adminActor(env, request, legacy) {
  const u = await memberOf(env, request);
  if (u && u.role === 'admin') return sameSite(request) || request.method === 'GET' ? { id: u.id, name: u.name } : null;
  return legacy && (await legacy(request, env)) ? { id: 0, name: '관리자 비밀번호' } : null;
}
const ACTIONS = new Set(['approve', 'reject', 'suspend', 'resume', 'role', 'edit', 'unlock', 'temp']);
async function users(env, url) {
  const st = url.searchParams.get('status');
  const rows = (await env.STATS.prepare("SELECT id, email, name, role, can_edit, status, must_change, lock_until, reset_at, dup_at, created_at, approved_at, last_seen FROM users WHERE status != 'deleted'" +
    (st && /^(pending|active|suspended|rejected)$/.test(st) ? ' AND status = ?1' : '') + " ORDER BY status = 'pending' DESC, created_at DESC LIMIT 1000").bind(...(st && /^(pending|active|suspended|rejected)$/.test(st) ? [st] : [])).all()).results;
  return json({ ok: true, now: Date.now(), users: rows.map(r => ({ id: r.id, email: r.email, name: r.name, role: r.role, canEdit: !!r.can_edit, status: r.status, mustChange: !!r.must_change,
    lockUntil: r.lock_until || 0, resetAt: r.reset_at, dupAt: r.dup_at, createdAt: r.created_at, approvedAt: r.approved_at, lastSeen: r.last_seen })) });
}
async function auditList(env) {
  const rows = (await env.STATS.prepare('SELECT a.id, a.at, a.actor, a.action, a.target, a.detail, ua.name actor_name, ut.name target_name, ut.email target_email FROM audit a' +
    ' LEFT JOIN users ua ON ua.id = a.actor LEFT JOIN users ut ON ut.id = a.target ORDER BY a.id DESC LIMIT 200').all()).results;
  return json({ ok: true, audit: rows.map(r => ({ at: r.at, action: r.action, detail: r.detail || '',
    actor: r.actor === 0 ? '관리자 비밀번호' : r.actor == null ? '자동' : r.actor_name || '#' + r.actor, target: r.target_name ? r.target_name + (r.target_email ? ' · ' + r.target_email : '') : r.target == null ? '' : '#' + r.target })) });
}
async function act(env, request, id, action, actor) {
  const db = env.STATS, u = await db.prepare("SELECT * FROM users WHERE id = ?1 AND status != 'deleted'").bind(id).first();
  if (!u) return json({ ok: false, error: '없는 회원입니다' }, 404);
  const b = action === 'role' || action === 'edit' || action === 'temp' ? await body(request) : {}, now = Date.now();
  const lastAdmin = u.role === 'admin' && u.status === 'active' && (await activeAdmins(db, u.id)) === 0;
  let q = null, detail = '';
  if (action === 'approve') {
    if (u.status !== 'pending' && u.status !== 'rejected') return json({ ok: false, error: '승인할 신청이 아닙니다' }, 409);
    q = db.prepare("UPDATE users SET status = 'active', approved_at = ?2, approved_by = ?3, status_at = ?2, last_seen = ?2, dup_at = NULL WHERE id = ?1").bind(id, now, actor.id);
  } else if (action === 'reject') {
    if (u.status !== 'pending') return json({ ok: false, error: '대기 중인 신청만 거절할 수 있습니다' }, 409);
    q = db.prepare("UPDATE users SET status = 'rejected', status_at = ?2 WHERE id = ?1").bind(id, now);
  } else if (action === 'suspend') {
    if (u.status !== 'active') return json({ ok: false, error: '활성 회원만 정지할 수 있습니다' }, 409);
    if (lastAdmin) return json({ ok: false, error: '마지막 관리자는 정지할 수 없습니다' }, 409);
    q = db.prepare("UPDATE users SET status = 'suspended', status_at = ?2 WHERE id = ?1").bind(id, now);
  } else if (action === 'resume') {
    if (u.status !== 'suspended') return json({ ok: false, error: '정지된 회원이 아닙니다' }, 409);
    q = db.prepare("UPDATE users SET status = 'active', status_at = ?2, last_seen = ?2, fails = 0, lock_until = 0 WHERE id = ?1").bind(id, now);
  } else if (action === 'role') {
    const role = b.role === 'admin' ? 'admin' : b.role === 'member' ? 'member' : null;
    if (!role) return json({ ok: false, error: '등급이 맞지 않습니다' }, 400);
    if (role === 'admin' && u.status !== 'active') return json({ ok: false, error: '활성 회원만 관리자로 지정할 수 있습니다' }, 409);
    if (role === 'member' && lastAdmin) return json({ ok: false, error: '마지막 관리자는 해제할 수 없습니다 — 다른 관리자를 먼저 지정해 주세요' }, 409);
    q = db.prepare('UPDATE users SET role = ?2 WHERE id = ?1').bind(id, role);
    detail = role === 'admin' ? '관리자로' : '회원으로';
  } else if (action === 'edit') {
    q = db.prepare('UPDATE users SET can_edit = ?2 WHERE id = ?1').bind(id, b.canEdit ? 1 : 0);
    detail = b.canEdit ? '설정 수정 켬' : '설정 수정 끔';
  } else if (action === 'unlock') {
    q = db.prepare('UPDATE users SET fails = 0, lock_until = 0 WHERE id = ?1').bind(id);
  } else if (action === 'temp') {                               // 임시 비밀번호: 관리자 화면(브라우저)이 만들어 다진 값만 보낸다 — 첫 로그인 때 바꾸게
    const iter = iterOf(b.iter);
    if (!SALT_RE.test(String(b.salt || '')) || !DK_RE.test(String(b.dk || '')) || !iter) return json({ ok: false, error: '임시 비밀번호를 다시 만들어 주세요' }, 400);
    q = db.prepare('UPDATE users SET salt = ?2, iter = ?3, pw = ?4, must_change = 1, reset_at = NULL, fails = 0, lock_until = 0 WHERE id = ?1').bind(id, b.salt, iter, await pwHash(env, b.dk));
  }
  const drop = action === 'suspend' || action === 'temp' || action === 'role';   // 정지 · 임시 비밀번호 · 등급이 바뀌면 그 회원의 로그인을 끊는다
  await db.batch(drop ? [q, db.prepare('DELETE FROM sessions WHERE uid = ?1').bind(id)] : [q]);
  await audit(db, actor.id, action, id, detail);
  return json({ ok: true });
}
async function remove(env, id, actor) {
  const db = env.STATS, u = await db.prepare("SELECT * FROM users WHERE id = ?1 AND status != 'deleted'").bind(id).first();
  if (!u) return json({ ok: false, error: '없는 회원입니다' }, 404);
  if (u.role === 'admin' && u.status === 'active' && (await activeAdmins(db, u.id)) === 0) return json({ ok: false, error: '마지막 관리자는 삭제할 수 없습니다' }, 409);
  await anonymize(db, id);
  await audit(db, actor.id, 'delete', id, u.status === 'pending' ? '대기 신청' : '');
  return json({ ok: true });
}

// 주소 나누기 — /api/auth/* · /api/users/* 가 아니면 null(index.js 가 계속). legacy = 관리자 비밀번호 출입증 확인(index.js admitted)
export async function route(request, env, url, legacy) {
  const p = url.pathname, m = request.method;
  if (!p.startsWith('/api/auth/') && p !== '/api/users' && !p.startsWith('/api/users/')) return null;
  try {
    if (p === '/api/auth/me' && m === 'GET') return await me(env, request);
    if (!env.STATS || !authReady(env)) return json({ ok: false, error: '회원 기능을 준비하고 있습니다 — 관리자 설정이 끝나면 쓸 수 있습니다' }, 503);
    await ensureAuth(env.STATS);
    if (p === '/api/auth/salt' && m === 'GET') return await salt(env, url);
    if (p.startsWith('/api/auth/')) {
      if (m !== 'GET' && !sameSite(request)) return json({ ok: false, error: '이 사이트 화면에서만 할 수 있습니다' }, 403);
      if (p === '/api/auth/signup' && m === 'POST') return await signup(env, request);
      if (p === '/api/auth/login' && m === 'POST') return await login(env, request);
      if (p === '/api/auth/logout' && m === 'POST') return await logout(env, request);
      if (p === '/api/auth/forgot' && m === 'POST') return await forgot(env, request);
      const s = await sessionOf(env, request);
      if (!s) return json({ ok: false, error: '로그인이 필요합니다' }, 401);
      if (p === '/api/auth/password' && m === 'POST') return await password(env, request, s);
      if (p === '/api/auth/me' && m === 'PATCH') return await rename(env, request, s);
      if (p === '/api/auth/me' && m === 'DELETE') return await withdraw(env, request, s);
      return json({ ok: false, error: '없는 주소입니다' }, 404);
    }
    const actor = await adminActor(env, request, legacy);
    if (!actor) return json({ ok: false, error: '관리자만 할 수 있습니다' }, 401);
    if (p === '/api/users' && m === 'GET') return await users(env, url);
    if (p === '/api/users/audit' && m === 'GET') return await auditList(env);
    const mm = /^\/api\/users\/(\d{1,9})(?:\/([a-z]+))?$/.exec(p);
    if (mm && !mm[2] && m === 'DELETE') return await remove(env, +mm[1], actor);
    if (mm && mm[2] && ACTIONS.has(mm[2]) && m === 'POST') return await act(env, request, +mm[1], mm[2], actor);
    return json({ ok: false, error: '없는 주소입니다' }, 404);
  } catch (e) {
    if (e && e.status) return json({ ok: false, error: e.message }, e.status);
    throw e;
  }
}

// 설정을 고친 회원 기록(Q282) — index.js 의 팀 설정 저장이 부른다
export async function auditEdit(env, user, what) {
  if (user && env.STATS) { await ensureAuth(env.STATS); await audit(env.STATS, user.id, 'settings', null, what); }
}

// 밤 작업(index.js nightly) — 90일 미접속 자동 정지(마지막 관리자는 빼고) · 만료 세션 · 제한 기록 · 오래된 거절 · 1년 지난 정지 계정
export async function nightlyAuth(env) {
  if (!authReady(env)) return;
  const db = env.STATS, now = Date.now();
  await ensureAuth(db);
  const idle = (await db.prepare("SELECT id, role FROM users WHERE status = 'active' AND COALESCE(last_seen, approved_at, created_at) < ?1 ORDER BY role = 'admin'").bind(now - INACTIVE_MS).all()).results;
  for (const u of idle) {
    if (u.role === 'admin' && (await activeAdmins(db, u.id)) === 0) continue;
    await db.batch([db.prepare("UPDATE users SET status = 'suspended', status_at = ?2 WHERE id = ?1").bind(u.id, now), db.prepare('DELETE FROM sessions WHERE uid = ?1').bind(u.id)]);
    await audit(db, null, 'suspend', u.id, '90일 미접속');
  }
  const old = (await db.prepare("SELECT id FROM users WHERE status = 'suspended' AND status_at < ?1").bind(now - SUSPEND_KEEP_MS).all()).results;
  for (const u of old) { await anonymize(db, u.id); await audit(db, null, 'delete', u.id, '정지 1년'); }
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now),
    db.prepare('DELETE FROM rl WHERE w < ?1').bind(Math.floor(now / HOUR) - 2),
    db.prepare("DELETE FROM users WHERE status = 'rejected' AND status_at < ?1").bind(now - REJECT_KEEP_MS)
  ]);
}
