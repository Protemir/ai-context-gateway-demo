// Durable Object (SQLite) behind the Worker: technical journal, metric counters,
// repeat-guard fingerprints and the demo's daily budget. Same interface as MemoryLedger.
import { DurableObject } from 'cloudflare:workers';

const KEEP_JOURNAL = 3000;

export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT, data TEXT);
      CREATE INDEX IF NOT EXISTS journal_rid ON journal(request_id);
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (fp TEXT PRIMARY KEY, until INTEGER NOT NULL, data TEXT);
      CREATE TABLE IF NOT EXISTS daily (key TEXT PRIMARY KEY, value REAL NOT NULL);
    `);
  }

  begin({ fp, day, ipKey, live }) {
    const out = { blocked: null };
    const b = this.sql.exec('SELECT until, data FROM blocks WHERE fp = ?', fp).toArray()[0];
    if (b && b.until > Date.now()) out.blocked = JSON.parse(b.data);
    if (day) {
      const get = (k) => this.sql.exec('SELECT value FROM daily WHERE key = ?', k).toArray()[0]?.value || 0;
      out.neuronsToday = get(`neurons:${day}`);
      out.ipAll = get(`ip:${day}:${ipKey}`);
      out.ipLive = get(`iplive:${day}:${ipKey}`);
      this.bump(`ip:${day}:${ipKey}`, 1);
    }
    return out;
  }

  bump(key, by) {
    this.sql.exec('INSERT INTO daily (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value', key, by);
  }

  finish({ entry, deltas, block, neurons, day, ipKey }) {
    // the per-IP live quota counts real model calls only (rejected requests cost nothing)
    if (day && ipKey && entry?.upstream_calls && entry.mode !== "mock") this.bump(`iplive:${day}:${ipKey}`, entry.upstream_calls);
    for (const [k, v] of Object.entries(deltas || {})) {
      this.sql.exec('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value', k, v);
    }
    this.sql.exec('INSERT INTO journal (request_id, data) VALUES (?, ?)', entry.request_id, JSON.stringify(entry));
    this.sql.exec('DELETE FROM journal WHERE seq <= (SELECT MAX(seq) FROM journal) - ?', KEEP_JOURNAL);
    if (block) {
      this.sql.exec(
        'INSERT INTO blocks (fp, until, data) VALUES (?, ?, ?) ON CONFLICT(fp) DO UPDATE SET until = excluded.until, data = excluded.data',
        block.fp, Date.now() + block.seconds * 1000, JSON.stringify({ request_id: block.request_id, estimated_tokens: block.estimated_tokens }),
      );
    }
    if (neurons && day) this.bump(`neurons:${day}`, neurons);
    if (Math.random() < 0.02) this.sql.exec('DELETE FROM blocks WHERE until < ?', Date.now());
  }

  metrics() {
    const o = {};
    for (const r of this.sql.exec('SELECT name, value FROM counters').toArray()) o[r.name] = r.value;
    return o;
  }

  journal(limit = 50, ids = null) {
    if (ids?.length) {
      const out = [];
      for (let i = 0; i < ids.length; i += 50) {
        const part = ids.slice(i, i + 50);
        const rows = this.sql.exec(`SELECT data FROM journal WHERE request_id IN (${part.map(() => '?').join(',')})`, ...part).toArray();
        out.push(...rows.map((r) => JSON.parse(r.data)));
      }
      return out;
    }
    return this.sql.exec('SELECT data FROM journal ORDER BY seq DESC LIMIT ?', Math.min(500, limit)).toArray().map((r) => JSON.parse(r.data));
  }

  budget(day) {
    return this.sql.exec('SELECT value FROM daily WHERE key = ?', `neurons:${day}`).toArray()[0]?.value || 0;
  }
}
