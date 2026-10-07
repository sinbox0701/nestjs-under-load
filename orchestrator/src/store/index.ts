// MetadataStore 구현: node:sqlite(`<runsDir>/_meta/lab.sqlite`) + `<runsDir>/<runId>/metadata.json`.
// 메서드는 포트 규칙대로 Promise 를 돌려주지만 내부 DB 는 동기(DatabaseSync)다.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseMetadataAnyVersion } from '@under-load/contracts';
import type { BatchSummary, RunMetadata, RunRow } from '@under-load/contracts';

import { summarizeBatch } from '../metadata/batch-summary.js';
import type { BatchRecord, MetadataStore, RunListFilter, RunRowPatch, SessionRecord } from '../ports.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS batches (
  batch_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  scenario TEXT NOT NULL,
  strategy TEXT NOT NULL,
  app_instances INTEGER NOT NULL,
  load_model TEXT NOT NULL,
  reps INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS batches_session ON batches(session_id);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  repetition INTEGER NOT NULL,
  scenario TEXT NOT NULL,
  strategy TEXT NOT NULL,
  app_instances INTEGER NOT NULL,
  model TEXT NOT NULL,
  instrumentation TEXT NOT NULL,
  status TEXT NOT NULL,
  valid INTEGER,
  invariants_passed INTEGER,
  violations_total INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at DESC, run_id DESC);
CREATE INDEX IF NOT EXISTS runs_batch ON runs(batch_id, repetition);
CREATE TABLE IF NOT EXISTS run_steps (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_steps_run ON run_steps(run_id, seq);
`;

type Row = Record<string, string | number | bigint | Uint8Array | null>;

const toBool = (v: unknown): boolean | null => (v === null || v === undefined ? null : Number(v) !== 0);
const fromBool = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);

function runFromRow(r: Row): RunRow {
  return {
    runId: r.run_id as string,
    batchId: r.batch_id as string,
    sessionId: r.session_id as string,
    repetition: Number(r.repetition),
    scenario: r.scenario as string,
    strategy: r.strategy as string,
    appInstances: Number(r.app_instances),
    model: r.model as RunRow['model'],
    instrumentation: r.instrumentation as RunRow['instrumentation'],
    status: r.status as RunRow['status'],
    valid: toBool(r.valid),
    invariantsPassed: toBool(r.invariants_passed),
    violationsTotal: r.violations_total === null ? null : Number(r.violations_total),
    startedAt: r.started_at as string,
    endedAt: (r.ended_at as string | null) ?? null,
  };
}

const batchFromRow = (r: Row): BatchRecord => ({
  batchId: r.batch_id as string,
  sessionId: r.session_id as string,
  scenario: r.scenario as string,
  strategy: r.strategy as string,
  appInstances: Number(r.app_instances),
  loadModel: r.load_model as BatchRecord['loadModel'],
  reps: Number(r.reps),
});

const encodeCursor = (startedAt: string, runId: string): string => Buffer.from(JSON.stringify([startedAt, runId])).toString('base64url');

function decodeCursor(cursor: string): [string, string] {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') return [v[0], v[1]];
  } catch {
    // 아래에서 던진다
  }
  throw new Error('잘못된 커서');
}

export type SqliteMetadataStoreOptions = {
  /** `runs/` 디렉터리. DB 는 `<runsDir>/_meta/lab.sqlite` */
  runsDir: string;
};

export class SqliteMetadataStore implements MetadataStore {
  private readonly db: DatabaseSync;
  private readonly runsDir: string;

  constructor(opts: SqliteMetadataStoreOptions) {
    this.runsDir = opts.runsDir;
    mkdirSync(join(opts.runsDir, '_meta'), { recursive: true });
    this.db = new DatabaseSync(join(opts.runsDir, '_meta', 'lab.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private metadataPath(runId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.startsWith('.')) throw new Error(`잘못된 runId: ${runId}`);
    return join(this.runsDir, runId, 'metadata.json');
  }

  // ─────────── 세션 ───────────

  async createSession(s: SessionRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO sessions (session_id, request_json, state, started_at, ended_at) VALUES (?, ?, ?, ?, ?)')
      .run(s.sessionId, JSON.stringify(s.request), s.state, s.startedAt, s.endedAt);
  }

  async updateSession(sessionId: string, patch: Partial<Pick<SessionRecord, 'state' | 'startedAt' | 'endedAt'>>): Promise<void> {
    const sets: string[] = [];
    const args: (string | null)[] = [];
    if (patch.state !== undefined) (sets.push('state = ?'), args.push(patch.state));
    if (patch.startedAt !== undefined) (sets.push('started_at = ?'), args.push(patch.startedAt));
    if (patch.endedAt !== undefined) (sets.push('ended_at = ?'), args.push(patch.endedAt));
    if (sets.length === 0) return;
    const res = this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE session_id = ?`).run(...args, sessionId);
    if (res.changes === 0) throw new Error(`세션 없음: ${sessionId}`);
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const r = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Row | undefined;
    if (!r) return null;
    return {
      sessionId: r.session_id as string,
      request: JSON.parse(r.request_json as string) as SessionRecord['request'],
      state: r.state as SessionRecord['state'],
      startedAt: (r.started_at as string | null) ?? null,
      endedAt: (r.ended_at as string | null) ?? null,
    };
  }

  // ─────────── 배치·실행 ───────────

  async createBatch(b: BatchRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO batches (batch_id, session_id, scenario, strategy, app_instances, load_model, reps) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(b.batchId, b.sessionId, b.scenario, b.strategy, b.appInstances, b.loadModel, b.reps);
  }

  async insertRun(row: RunRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, batch_id, session_id, repetition, scenario, strategy, app_instances, model, instrumentation,
           status, valid, invariants_passed, violations_total, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.runId,
        row.batchId,
        row.sessionId,
        row.repetition,
        row.scenario,
        row.strategy,
        row.appInstances,
        row.model,
        row.instrumentation,
        row.status,
        fromBool(row.valid),
        fromBool(row.invariantsPassed),
        row.violationsTotal,
        row.startedAt,
        row.endedAt,
      );
  }

  async updateRun(runId: string, patch: RunRowPatch): Promise<void> {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (patch.status !== undefined) (sets.push('status = ?'), args.push(patch.status));
    if (patch.valid !== undefined) (sets.push('valid = ?'), args.push(fromBool(patch.valid)));
    if (patch.invariantsPassed !== undefined) (sets.push('invariants_passed = ?'), args.push(fromBool(patch.invariantsPassed)));
    if (patch.violationsTotal !== undefined) (sets.push('violations_total = ?'), args.push(patch.violationsTotal));
    if (patch.endedAt !== undefined) (sets.push('ended_at = ?'), args.push(patch.endedAt));
    if (sets.length === 0) return;
    const res = this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE run_id = ?`).run(...args, runId);
    if (res.changes === 0) throw new Error(`실행 없음: ${runId}`);
  }

  async getRun(runId: string): Promise<RunRow | null> {
    const r = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as Row | undefined;
    return r ? runFromRow(r) : null;
  }

  async listRuns(filter: RunListFilter = {}): Promise<{ items: RunRow[]; next: string | null }> {
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.scenario !== undefined) (where.push('scenario = ?'), args.push(filter.scenario));
    if (filter.strategy !== undefined) (where.push('strategy = ?'), args.push(filter.strategy));
    if (filter.batchId !== undefined) (where.push('batch_id = ?'), args.push(filter.batchId));
    if (filter.before !== undefined) {
      const [startedAt, runId] = decodeCursor(filter.before);
      where.push('(started_at < ? OR (started_at = ? AND run_id < ?))');
      args.push(startedAt, startedAt, runId);
    }
    const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, run_id DESC LIMIT ?`;
    const rows = (this.db.prepare(sql).all(...args, limit + 1) as Row[]).map(runFromRow);
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, next: rows.length > limit && last ? encodeCursor(last.startedAt, last.runId) : null };
  }

  // ─────────── 단계 ───────────

  async addStep(runId: string, step: { name: string; at: string }): Promise<void> {
    this.db.prepare('INSERT INTO run_steps (run_id, name, at) VALUES (?, ?, ?)').run(runId, step.name, step.at);
  }

  async getSteps(runId: string): Promise<{ name: string; at: string }[]> {
    const rows = this.db.prepare('SELECT name, at FROM run_steps WHERE run_id = ? ORDER BY seq').all(runId) as Row[];
    return rows.map((r) => ({ name: r.name as string, at: r.at as string }));
  }

  // ─────────── 메타데이터 ───────────

  async saveMetadata(runId: string, metadata: RunMetadata): Promise<void> {
    if (!this.db.prepare('SELECT 1 FROM runs WHERE run_id = ?').get(runId)) throw new Error(`실행 없음: ${runId}`);
    const file = this.metadataPath(runId);
    const text = `${JSON.stringify(metadata, null, 2)}\n`;
    mkdirSync(join(this.runsDir, runId), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, text);
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    this.db.prepare('UPDATE runs SET metadata_json = ? WHERE run_id = ?').run(text, runId);
  }

  async getMetadata(runId: string): Promise<RunMetadata | null> {
    let text: string;
    try {
      text = readFileSync(this.metadataPath(runId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    // v0(schemaVersion 없음)도 읽는다. 0단계 파일은 v1 모양이 아니므로 그대로 돌려준다(소비자가 version 으로 구분).
    return parseMetadataAnyVersion(JSON.parse(text)).metadata as RunMetadata;
  }

  // ─────────── 배치 요약 ───────────

  async getBatchSummary(batchId: string): Promise<BatchSummary | null> {
    const b = this.db.prepare('SELECT * FROM batches WHERE batch_id = ?').get(batchId) as Row | undefined;
    return b ? this.summarize(batchFromRow(b)) : null;
  }

  async getSessionBatches(sessionId: string): Promise<BatchSummary[]> {
    const rows = this.db.prepare('SELECT * FROM batches WHERE session_id = ? ORDER BY rowid').all(sessionId) as Row[];
    const out: BatchSummary[] = [];
    for (const r of rows) out.push(await this.summarize(batchFromRow(r)));
    return out;
  }

  async getBatchRuns(batchId: string): Promise<RunRow[]> {
    const rows = this.db.prepare('SELECT * FROM runs WHERE batch_id = ? ORDER BY repetition').all(batchId) as Row[];
    return rows.map(runFromRow);
  }

  /** 결과(metadata.json)가 있는 실행만 요약에 넣는다. */
  private async summarize(batch: BatchRecord): Promise<BatchSummary> {
    const metadatas: RunMetadata[] = [];
    for (const run of await this.getBatchRuns(batch.batchId)) {
      const md = await this.getMetadata(run.runId);
      if (md) metadatas.push(md);
    }
    return summarizeBatch(batch, metadatas);
  }
}

export function createMetadataStore(opts: SqliteMetadataStoreOptions): SqliteMetadataStore {
  return new SqliteMetadataStore(opts);
}
