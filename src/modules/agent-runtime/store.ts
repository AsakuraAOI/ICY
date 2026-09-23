import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ModelMessage } from '../llm/contracts.js';

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type DeliveryStatus = 'none' | 'pending' | 'sent' | 'failed' | 'unknown';

export interface StoredRun {
  readonly id: string;
  readonly eventKey: string;
  readonly sessionKey: string;
  readonly generation: number;
  readonly status: RunStatus;
  readonly delivery: DeliveryStatus;
  readonly input: string;
  readonly result: string | null;
  readonly errorKind: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

type Row = Record<string, unknown>;

/** SQLite 持有会话、任务和交付状态；所有状态变更在单进程内串行事务提交。 */
export class AgentStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE,
        session_key TEXT NOT NULL, generation INTEGER NOT NULL,
        status TEXT NOT NULL, delivery TEXT NOT NULL DEFAULT 'none',
        input TEXT NOT NULL, result TEXT, error_kind TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_key) REFERENCES sessions(session_key)
      );
      CREATE INDEX IF NOT EXISTS runs_session_recent ON runs(session_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL,
        generation INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        run_id TEXT NOT NULL,
        FOREIGN KEY(session_key) REFERENCES sessions(session_key)
      );
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_key, generation, id);
    `);
    // 上一次进程消失时未完成的 run 不自动重放，避免重复工具副作用。
    this.#db.prepare("UPDATE runs SET status = 'interrupted', updated_at = ? WHERE status IN ('queued', 'running')")
      .run(Date.now());
    const now = Date.now();
    const bodyBefore = now - 7 * 24 * 60 * 60 * 1_000;
    const metadataBefore = now - 30 * 24 * 60 * 60 * 1_000;
    this.#db.prepare('DELETE FROM messages WHERE run_id IN (SELECT id FROM runs WHERE created_at < ?)')
      .run(bodyBefore);
    this.#db.prepare("UPDATE runs SET input = '', result = NULL WHERE created_at < ?")
      .run(bodyBefore);
    this.#db.prepare('DELETE FROM runs WHERE created_at < ?').run(metadataBefore);
  }

  create(input: { id: string; eventKey: string; sessionKey: string; text: string }): {
    run: StoredRun; duplicate: boolean;
  } {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('INSERT OR IGNORE INTO sessions (session_key) VALUES (?)').run(input.sessionKey);
      const generation = Number((this.#db.prepare('SELECT generation FROM sessions WHERE session_key = ?')
        .get(input.sessionKey) as Row).generation);
      const now = Date.now();
      const result = this.#db.prepare(`INSERT OR IGNORE INTO runs
        (id, event_key, session_key, generation, status, delivery, input, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', 'none', ?, ?, ?)`)
        .run(input.id, input.eventKey, input.sessionKey, generation, input.text, now, now);
      const row = this.#db.prepare('SELECT * FROM runs WHERE event_key = ?').get(input.eventKey);
      this.#db.exec('COMMIT');
      return { run: readRun(row), duplicate: Number(result.changes) === 0 };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  get(id: string): StoredRun | null {
    const row = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row === undefined ? null : readRun(row);
  }

  byEventKey(eventKey: string): StoredRun | null {
    const row = this.#db.prepare('SELECT * FROM runs WHERE event_key = ?').get(eventKey);
    return row === undefined ? null : readRun(row);
  }

  latest(sessionKey: string): StoredRun | null {
    const row = this.#db.prepare(
      `SELECT runs.* FROM runs JOIN sessions USING (session_key)
       WHERE runs.session_key = ? AND runs.generation = sessions.generation
       ORDER BY runs.created_at DESC, runs.rowid DESC LIMIT 1`,
    ).get(sessionKey);
    return row === undefined ? null : readRun(row);
  }

  pendingCount(sessionKey: string): number {
    const row = this.#db.prepare(
      "SELECT COUNT(*) AS n FROM runs WHERE session_key = ? AND status IN ('queued', 'running')",
    ).get(sessionKey) as Row;
    return Number(row.n);
  }

  countSince(since: number, sessionKey?: string): number {
    const row = sessionKey === undefined
      ? this.#db.prepare('SELECT COUNT(*) AS n FROM runs WHERE created_at >= ?').get(since)
      : this.#db.prepare('SELECT COUNT(*) AS n FROM runs WHERE created_at >= ? AND session_key = ?')
        .get(since, sessionKey);
    return Number((row as Row).n);
  }

  markRunning(id: string): boolean {
    return Number(this.#db.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(Date.now(), id).changes) > 0;
  }

  history(sessionKey: string, generation: number, limit = 16): ModelMessage[] {
    const rows = this.#db.prepare(`SELECT role, content FROM (
      SELECT id, role, content FROM messages WHERE session_key = ? AND generation = ?
      ORDER BY id DESC LIMIT ?
    ) ORDER BY id`).all(sessionKey, generation, limit) as Row[];
    return rows.map((row) => ({ role: row.role as 'user' | 'assistant', content: String(row.content) }));
  }

  complete(id: string, generation: number, text: string): boolean {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#db.prepare('SELECT session_key, input, status FROM runs WHERE id = ?').get(id) as Row | undefined;
      const current = row === undefined ? undefined : this.#db.prepare(
        'SELECT generation FROM sessions WHERE session_key = ?',
      ).get(String(row.session_key)) as Row | undefined;
      if (row?.status !== 'running' || Number(current?.generation) !== generation) {
        this.#db.exec('COMMIT');
        return false;
      }
      const sessionKey = String(row.session_key);
      const insert = this.#db.prepare(
        'INSERT INTO messages (session_key, generation, role, content, run_id) VALUES (?, ?, ?, ?, ?)',
      );
      insert.run(sessionKey, generation, 'user', String(row.input), id);
      insert.run(sessionKey, generation, 'assistant', text, id);
      this.#db.prepare("UPDATE runs SET status = 'completed', delivery = 'pending', result = ?, updated_at = ? WHERE id = ?")
        .run(text, Date.now(), id);
      this.#db.exec('COMMIT');
      return true;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  fail(id: string, kind: string, result: string, status: 'failed' | 'cancelled' = 'failed'): boolean {
    return Number(this.#db.prepare(`UPDATE runs SET status = ?, delivery = 'pending', error_kind = ?,
      result = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')`)
      .run(status, kind, result, Date.now(), id).changes) > 0;
  }

  setDelivery(id: string, status: DeliveryStatus): void {
    this.#db.prepare('UPDATE runs SET delivery = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }

  canDeliver(id: string, generation: number): boolean {
    const row = this.#db.prepare(`SELECT 1 AS valid FROM runs
      JOIN sessions USING (session_key)
      WHERE runs.id = ? AND runs.generation = ? AND sessions.generation = ?
        AND runs.status IN ('completed', 'failed')`).get(id, generation, generation);
    return row !== undefined;
  }

  interrupt(id: string): void {
    this.#db.prepare(`UPDATE runs SET status = 'interrupted', delivery = 'none',
      error_kind = 'shutdown', updated_at = ? WHERE id = ? AND status IN ('queued', 'running')`)
      .run(Date.now(), id);
  }

  reset(sessionKey: string): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('INSERT OR IGNORE INTO sessions (session_key) VALUES (?)').run(sessionKey);
      this.#db.prepare('UPDATE sessions SET generation = generation + 1 WHERE session_key = ?').run(sessionKey);
      this.#db.prepare('DELETE FROM messages WHERE session_key = ?').run(sessionKey);
      this.#db.prepare("UPDATE runs SET input = '', result = NULL WHERE session_key = ?").run(sessionKey);
      this.#db.prepare(`UPDATE runs SET status = 'cancelled', delivery = 'none', result = NULL,
        error_kind = 'reset', updated_at = ?
        WHERE session_key = ? AND status IN ('queued', 'running')`).run(Date.now(), sessionKey);
      this.#db.prepare(`UPDATE runs SET delivery = 'none' WHERE session_key = ?
        AND status = 'cancelled' AND delivery = 'pending'`).run(sessionKey);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.#db.close(); }
}

function readRun(value: unknown): StoredRun {
  const row = value as Row;
  return {
    id: String(row.id), eventKey: String(row.event_key), sessionKey: String(row.session_key),
    generation: Number(row.generation), status: row.status as RunStatus,
    delivery: row.delivery as DeliveryStatus, input: String(row.input),
    result: row.result === null ? null : String(row.result),
    errorKind: row.error_kind === null ? null : String(row.error_kind),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}
