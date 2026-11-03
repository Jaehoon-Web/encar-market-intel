/*
 * worker/summary.js — 이용 통계 하루 요약(기획 v2.28 · 5.11). worker/index.js(새벽 작업 · 관리자 통계)와 tools/worker_check.mjs가 쓴다.
 * 입력: 하루치 기록(방문 sid · 시각 순으로 정렬) → 출력: 방문자·방문·보는 시간·화면·기능·모델·단계 흐름·결과 깊이·마지막 화면·
 * 입력하다 포기·경로·처음 화면·오류·속도. 사람은 익명 번호 목록(여러 날 방문자 수를 합칠 때 겹침을 빼려고)만 담는다.
 */
const TOP = 100;

export function summarize(day, rows) {
  const S = { day, uids: [], sessions: 0, dev: { pc: 0, m: 0 }, sec: 0, scr: {}, act: {}, models: {}, mmodels: {}, results: 0, msum: 0, batch: 0, cars: 0,
    exports: {}, funnel: [0, 0, 0, 0, 0], depth: [0, 0, 0, 0, 0, 0], last: {}, lastAct: {}, abandon: 0, fields: {}, paths: {}, entry: {}, entryCar: 0,
    err: {}, errs: [], ready: [], load: [] };
  const inc = (o, k, n = 1) => { if (k !== '' && k != null) o[k] = (o[k] || 0) + n; };
  const sc = k => S.scr[k] || (S.scr[k] = { views: 0, sec: 0, sessions: 0 });
  const uids = new Set();
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j < rows.length && rows[j].sid === rows[i].sid) j++;
    const ev = rows.slice(i, j);
    i = j;
    S.sessions++;
    uids.add(ev[0].uid);
    S.dev[ev[0].dev === 'm' ? 'm' : 'pc']++;
    let picked = false, exported = false, lastE = null, miss = '', seen = {}, seq = [], deep = {}, res = [];
    for (const e of ev) {
      const t = e.type;
      if (t === 'start') { inc(S.entry, e.scr); if (e.name === 'car') S.entryCar++; }
      else if (t === 'view') { sc(e.scr).views++; seen[e.scr] = 1; if (seq[seq.length - 1] !== e.scr) seq.push(e.scr); }
      else if (t === 'vis') { const n = Math.min(3600, Math.max(0, +e.val || 0)); sc(e.scr).sec += n; S.sec += n; }
      else if (t === 'act') inc(S.act, e.scr + '|' + e.name);
      else if (t === 'pick') picked = true;
      else if (t === 'result') {
        if (e.scr === 'price.model') { S.msum++; inc(S.mmodels, e.name); }
        else { S.results++; inc(S.models, e.name + '|' + e.val); res.push(String(e.ts)); }
        miss = '';
      } else if (t === 'depth') deep[e.name] = Math.max(deep[e.name] || 0, +e.val || 0);
      else if (t === 'miss') miss = e.name;
      else if (t === 'export') { inc(S.exports, e.name); exported = true; }
      else if (t === 'batch') { S.batch++; S.cars += Math.max(0, +e.val || 0); }
      else if (t === 'err') { inc(S.err, e.name); if (S.errs.length < 20) S.errs.push([e.ts, e.scr, e.name, e.val]); }
      else if (t === 'perf' && (e.name === 'ready' || e.name === 'load') && S[e.name].length < 500) S[e.name].push(+e.val || 0);
      if (t === 'view' || t === 'act' || t === 'result' || t === 'export' || t === 'pick' || t === 'miss' || t === 'batch') lastE = e;
    }
    Object.keys(seen).forEach(k => sc(k).sessions++);
    const deepAny = res.some(id => (deep[id] || 1) >= 2);    // 단계 흐름: 들어옴 → 차 고름 → 결과 → 근거(02까지) → 내보내기
    S.funnel[0]++;
    if (picked || res.length) S.funnel[1]++;
    if (res.length) S.funnel[2]++;
    if (deepAny) S.funnel[3]++;
    if (res.length && exported) S.funnel[4]++;
    res.forEach(id => { S.depth[Math.min(6, Math.max(1, deep[id] || 1)) - 1]++; });
    if (lastE) {
      inc(S.last, lastE.scr);
      inc(S.lastAct, lastE.scr + '|' + (lastE.type === 'act' ? lastE.name : lastE.type === 'export' ? 'export:' + lastE.name : '@' + lastE.type));
    }
    if (miss) { S.abandon++; miss.split(',').forEach(f => inc(S.fields, f.trim())); }   // 결과 없이 칸이 빈 채로 끝난 방문
    if (seq.length) inc(S.paths, seq.slice(0, 4).join('>'));
  }
  S.uids = [...uids];
  for (const k of ['act', 'models', 'mmodels', 'lastAct', 'paths', 'fields']) {   // 긴 꼬리는 잘라 둔다(하루 요약을 가볍게)
    const e = Object.entries(S[k]).sort((a, b) => b[1] - a[1]);
    if (e.length > TOP) S[k] = Object.fromEntries(e.slice(0, TOP));
  }
  return S;
}
