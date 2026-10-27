/*
 * worker/index.js — 사이트 Worker: 정적 자산(web/) + 환산 비율 팀 공용 저장소 API (기획안 5.1.6 · D6)
 *
 *   GET /api/rates          → { ok, store, writable, team }   팀이 고친 것(아직 없으면 team = null)
 *   GET /api/rates?rev=N    → { ok, team }                    N판(되돌리기용, 180일 보관)
 *   PUT /api/rates          본문 { password, rev, by, note, cells, models } → { ok, team }   새 판 저장
 *
 * 초기값(경매 갭 분석 요약치)은 정적 파일 /data/conversion_rates.json 이고, 여기에는 팀이 고친 것만 둔다.
 *   cells  = 기준표(호가대 × 차령)와 같은 꼴의 2차원 배열. 숫자면 그 칸을 팀 값으로, null 이면 초기값 그대로
 *   models = [{ 제조사, 모델(엔카 세부모델), 연료(비우면 전체), 비율, 메모 }] — 모델별 비율(모델 예외보다 먼저)
 * 바인딩(wrangler.toml · Cloudflare 설정): RATES = KV 저장소, RATES_PASSWORD = 수정 비밀번호(비밀값), ASSETS = 정적 자산.
 * 그 밖의 주소는 정적 자산으로 넘긴다. 비밀번호가 틀리면 1초 쉬고 401(무차별 대입 방지, KV에는 쓰지 않는다).
 */
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/rates') {
      if (request.method === 'GET') return get(url, env);
      if (request.method === 'PUT') return put(request, env);
      return json({ ok: false, error: 'GET 또는 PUT만 됩니다' }, 405);
    }
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: '없는 주소입니다' }, 404);
    return env.ASSETS.fetch(request);
  }
};
