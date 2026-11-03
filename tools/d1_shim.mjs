// d1_shim.mjs — Cloudflare D1 흉내(Node 내장 SQLite). 로컬 미리보기(dev_server)와 Worker 시험(worker_check)이
// 배포와 같은 Worker 코드(worker/index.js)를 Cloudflare 없이 돌리려고 쓴다. 쓰는 기능만: prepare · bind · run · all · first · batch · exec.
import { DatabaseSync } from 'node:sqlite';

export function d1(file = ':memory:') {
  const db = new DatabaseSync(file);
  const isRead = sql => /^\s*(SELECT|WITH)\b/i.test(sql);
  const stmt = (sql, args = []) => ({
    sql,
    bind: (...a) => stmt(sql, a),
    async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    async all() { return { success: true, results: db.prepare(sql).all(...args) }; },
    async first(col) { const r = db.prepare(sql).get(...args); return r == null ? null : col ? r[col] : r; }
  });
  return {
    db,
    prepare: sql => stmt(sql),
    async batch(list) {                                       // D1처럼 한 번에(하나라도 실패하면 모두 되돌림)
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of list) out.push(isRead(s.sql) ? await s.all() : await s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql) { db.exec(sql); return { count: 1 }; }
  };
}
