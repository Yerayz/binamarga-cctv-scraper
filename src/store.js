import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(directory, recordingsDir) {
    mkdirSync(directory, { recursive: true }); mkdirSync(recordingsDir, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'tolwatch.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);');
    for (const filename of readdirSync(recordingsDir).filter(f => /^[a-f0-9]{32}\.json$/.test(f))) {
      try {
        const job = JSON.parse(readFileSync(path.join(recordingsDir, filename), 'utf8'));
        if (job.status === 'completed' && /^[a-f0-9]{32}$/.test(job.id) && path.basename(job.filename) === job.filename && existsSync(path.join(recordingsDir, job.filename)) && !this.get('records', job.id)) this.save('records', { ...job, mode: 'manual' });
      } catch { /* Invalid legacy metadata is ignored. */ }
    }
  }
  table(table) { if (!['records', 'tasks'].includes(table)) throw new Error('Invalid table'); return table; }
  list(table) { return this.db.prepare(`SELECT data FROM ${this.table(table)}`).all().map(row => JSON.parse(row.data)); }
  get(table, id) { const row = this.db.prepare(`SELECT data FROM ${this.table(table)} WHERE id=?`).get(id); return row ? JSON.parse(row.data) : null; }
  save(table, item) { this.db.prepare(`INSERT INTO ${this.table(table)} (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(item.id, JSON.stringify(item)); return item; }
  delete(table, id) { this.db.prepare(`DELETE FROM ${this.table(table)} WHERE id=?`).run(id); }
  event(taskId, message, status = 'info') {
    this.db.prepare('INSERT INTO events(data) VALUES (?)').run(JSON.stringify({ taskId, message, status, at: new Date().toISOString() }));
    this.db.exec('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 2000)');
  }
  events(taskId) { return this.db.prepare('SELECT data FROM events ORDER BY id DESC LIMIT 200').all().map(row => JSON.parse(row.data)).filter(e => !taskId || e.taskId === taskId); }
  close() { this.db.close(); }
}
