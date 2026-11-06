// dev_server.mjs — 로컬 미리보기 서버: web/ 정적 파일 + 사이트 Worker(worker/index.js)의 /api 를 함께 띄운다
//   node tools/dev_server.mjs [포트=8792]
// 환산 비율 저장소(KV)는 encar_output/dev_kv.json 파일로 흉내 낸다(저장소에 올리지 않음). 수정 비밀번호는 환경 변수
// RATES_PASSWORD, 없으면 'dev'(관리자 비밀번호 ADMIN_PASSWORD도 같음). 이용 통계(D1)는 같은 폴더의 dev_stats.sqlite(Node 내장 SQLite)로 흉내 낸다.
// 회원 기능(로그인 기획)의 비밀값은 환경 변수 AUTH_PEPPER, 없으면 로컬 전용 시험 값 · 잠금(AUTH_ENFORCE)은 없으면 켬('1') — 회원 표는 dev_stats.sqlite 에 생긴다.
// 실제 배포(Cloudflare)와 같은 Worker 코드를 그대로 돌리므로 화면에서 저장 흐름까지 시험할 수 있다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB = path.join(ROOT, 'web');
const KV_FILE = path.join(ROOT, 'encar_output', 'dev_kv.json');
const PORT = Number(process.argv[2] || 8792);
const worker = (await import(pathToFileURL(path.join(ROOT, 'worker', 'index.js')).href)).default;
const { d1 } = await import(pathToFileURL(path.join(ROOT, 'tools', 'd1_shim.mjs')).href);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8', '.zip': 'application/zip', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

const store = fs.existsSync(KV_FILE) ? JSON.parse(fs.readFileSync(KV_FILE, 'utf8')) : {};
const RATES = {
  async get(k, type) { const v = store[k]; return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
  async put(k, v) { store[k] = v; fs.mkdirSync(path.dirname(KV_FILE), { recursive: true }); fs.writeFileSync(KV_FILE, JSON.stringify(store)); }
};
const ASSETS = {
  async fetch(request) {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.normalize(path.join(WEB, p));
    if (!f.startsWith(WEB) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return new Response('없는 파일: ' + p, { status: 404 });
    return new Response(request.method === 'HEAD' ? null : fs.readFileSync(f), { status: 200, headers: {
      'content-type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'content-length': String(fs.statSync(f).size) } });
  }
};
fs.mkdirSync(path.dirname(KV_FILE), { recursive: true });
const env = { RATES, ASSETS, RATES_PASSWORD: process.env.RATES_PASSWORD || 'dev', ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'dev', STATS: d1(path.join(path.dirname(KV_FILE), 'dev_stats.sqlite')),
  AUTH_PEPPER: process.env.AUTH_PEPPER === 'none' ? '' : process.env.AUTH_PEPPER || 'local-dev-pepper-not-for-production', AUTH_ENFORCE: process.env.AUTH_ENFORCE || '1' };   // AUTH_PEPPER=none → 회원 기능 준비 전(배포 첫걸음) 흉내

http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const headers = {};
    ['content-type', 'content-length', 'origin', 'authorization', 'cookie', 'x-cr-a', 'if-none-match'].forEach(h => { if (req.headers[h]) headers[h] = req.headers[h]; });
    const request = new Request('http://' + req.headers.host + req.url, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
    const response = await worker.fetch(request, env);
    const out = Object.fromEntries(response.headers);
    out['cache-control'] = 'no-store';
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(e && e.stack || e));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`사이트 http://127.0.0.1:${PORT}/  ·  /api/rates (가짜 KV ${path.relative(ROOT, KV_FILE)}, 비밀번호 '${env.RATES_PASSWORD === 'dev' ? 'dev' : '환경 변수'}')`);
});
