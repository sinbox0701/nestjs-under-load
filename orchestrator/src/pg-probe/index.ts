// T-113 ProbeSource 구현. lab_observer 전용 커넥션 1개로 intervalMs 마다 pg_stat_activity·pg_blocking_pids 를 조회해
// ProbeData 로 내보내고 probe.ndjson 에 한 줄씩 남긴다. 설계: DESIGN §9.1(관측자 효과)·§9.2(PG).
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import pg from 'pg';

import type { Clock, ProbeData, ProbeSource, ProbeStart } from '../ports.js';
import { maskQuery } from './mask.js';

export { maskQuery } from './mask.js';
export { buildBlockingTree } from './tree.js';
export type { BlockingEdge, BlockingNode, BlockingTree } from './tree.js';

/** 프로브가 쓰는 최소 커넥션 모양(pg.Client 가 만족한다). 테스트는 가짜를 넘긴다. */
export interface ProbeConnection {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export type PgProbeDeps = {
  clock: Clock;
  /** false 면 start 가 아무 쿼리도 보내지 않는다(커넥션도 열지 않음). */
  enabled: boolean;
  /** 관측 대상 DB(lab_run) 이름 */
  database: string;
  /** 커넥션 1개를 연다. 기본 구현은 {@link createPgConnect}. queryTimeoutMs = 이번 실행의 표본 간격. */
  connect: (opts: { queryTimeoutMs: number }) => Promise<ProbeConnection>;
  /** 표본 실패 같은 비치명 오류 보고(기본: 무시). */
  onError?: (err: unknown) => void;
};

export type PgConnectConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** 연결이 끊기는 등 유휴 커넥션 오류(기본: 무시). 리스너가 없으면 pg.Client 의 'error' 가 프로세스를 죽인다. */
  onError?: (err: unknown) => void;
  /** 접속 제한(ms). 기본 5000 */
  connectTimeoutMs?: number;
};

/**
 * lab_observer 로 접속하는 기본 커넥터. 풀을 쓰지 않고 Client 1개다.
 * 막힌 조회가 다음 표본을 무한히 붙잡지 않도록 서버(statement_timeout)·클라이언트(query_timeout) 양쪽에 표본 간격만큼의 제한을 건다.
 */
export function createPgConnect(cfg: PgConnectConfig): (opts?: { queryTimeoutMs?: number }) => Promise<ProbeConnection> {
  const { onError, connectTimeoutMs, ...conn } = cfg;
  return async (opts) => {
    const timeout = opts?.queryTimeoutMs !== undefined && opts.queryTimeoutMs > 0 ? Math.ceil(opts.queryTimeoutMs) : undefined;
    const client = new pg.Client({
      ...conn,
      application_name: 'nul-probe',
      connectionTimeoutMillis: connectTimeoutMs ?? 5000,
      ...(timeout !== undefined ? { statement_timeout: timeout, query_timeout: timeout } : {}),
    });
    client.on('error', (err) => onError?.(err));
    await client.connect();
    return client as unknown as ProbeConnection;
  };
}

// 자기 자신(pg_backend_pid)은 뺀다. xact_start 없으면 xactAgeMs=null.
const SAMPLE_SQL = `
select pid,
       application_name,
       state,
       wait_event_type,
       wait_event,
       (extract(epoch from (now() - xact_start)) * 1000)::float8 as xact_age_ms,
       query,
       pg_blocking_pids(pid) as blocked_by
  from pg_stat_activity
 where datname = $1 and pid <> pg_backend_pid()
 order by pid`;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** 한 번 조회해 ProbeData 로 만든다. */
export async function sampleOnce(conn: ProbeConnection, database: string): Promise<ProbeData> {
  const { rows } = await conn.query(SAMPLE_SQL, [database]);
  const sessions: ProbeData['sessions'] = [];
  const blocking: ProbeData['blocking'] = [];
  for (const r of rows) {
    const pid = Number(r.pid);
    sessions.push({
      pid,
      appName: str(r.application_name),
      state: str(r.state),
      waitEventType: str(r.wait_event_type),
      waitEvent: str(r.wait_event),
      xactAgeMs: r.xact_age_ms === null || r.xact_age_ms === undefined ? null : Math.max(0, Number(r.xact_age_ms)),
      query: maskQuery(str(r.query)),
    });
    const blockedBy = Array.isArray(r.blocked_by) ? r.blocked_by.map(Number) : [];
    if (blockedBy.length > 0) blocking.push({ pid, blockedBy });
  }
  return { sessions, blocking, lockWaiters: blocking.length };
}

type Running = {
  opts: ProbeStart;
  conn: ProbeConnection;
  abort: AbortController;
  loop: Promise<void>;
  samples: number;
};

export function createPgProbe(deps: PgProbeDeps): ProbeSource {
  let running: Running | null = null;

  async function take(r: Running): Promise<void> {
    try {
      const data = await sampleOnce(r.conn, deps.database);
      await appendFile(r.opts.outFile, `${JSON.stringify({ t: deps.clock.nowIso(), ...data })}\n`);
      r.samples += 1;
      r.opts.onSample(data);
    } catch (err) {
      deps.onError?.(err);
    }
  }

  async function loop(r: Running): Promise<void> {
    while (!r.abort.signal.aborted) {
      await take(r);
      try {
        await deps.clock.sleep(r.opts.intervalMs, { signal: r.abort.signal });
      } catch {
        return; // abort → 종료
      }
    }
  }

  return {
    async start(opts) {
      if (running) throw new Error('pg-probe 가 이미 실행 중입니다');
      if (!deps.enabled) return;
      await mkdir(dirname(opts.outFile), { recursive: true });
      const conn = await deps.connect({ queryTimeoutMs: opts.intervalMs });
      const r: Running = { opts, conn, abort: new AbortController(), loop: Promise.resolve(), samples: 0 };
      running = r;
      r.loop = loop(r);
    },

    async stop() {
      const r = running;
      if (!r) return { samples: 0 };
      running = null;
      r.abort.abort();
      await r.loop;
      await take(r); // 마지막 표본
      try {
        await r.conn.end();
      } catch (err) {
        deps.onError?.(err);
      }
      return { samples: r.samples };
    },
  };
}
