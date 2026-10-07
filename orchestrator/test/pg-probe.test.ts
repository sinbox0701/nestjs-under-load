// PG 프로브 테스트. 단위(가짜 커넥션·가짜 Clock)는 항상, 통합은 PG_PROBE_TEST_URL 이 있을 때만 돈다.
// 예: PG_PROBE_TEST_URL=postgres://postgres:pw@127.0.0.1:55513/postgres pnpm --filter @under-load/orchestrator test
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import pg from 'pg';

import { buildBlockingTree, createPgConnect, createPgProbe, maskQuery } from '../dist/pg-probe/index.js';
import type { ProbeConnection } from '../dist/pg-probe/index.js';
import type { Clock, ProbeData } from '../dist/ports.js';

/** sleep 이 한 틱 양보만 하고 돌아오는 가짜 시계(abort 면 reject). */
function fakeClock(): Clock {
  return {
    now: () => 0,
    nowIso: () => '2026-01-01T00:00:00.000Z',
    sleep: (_ms, opts) =>
      new Promise<void>((resolve, reject) => {
        if (opts?.signal?.aborted) return reject(new Error('aborted'));
        const t = setImmediate(resolve);
        opts?.signal?.addEventListener('abort', () => {
          clearImmediate(t);
          reject(new Error('aborted'));
        });
      }),
  };
}

/** 실제 시간 시계(통합용). abort 면 조용히 반환. */
const realClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
  sleep: (ms, o) =>
    new Promise<void>((res) => {
      const t = setTimeout(res, ms);
      o?.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        res();
      });
    }),
};

const dirs: string[] = [];
async function tmpFile() {
  const d = await mkdtemp(join(tmpdir(), 'nul-probe-'));
  dirs.push(d);
  return join(d, 'runs', 'r1', 'probe.ndjson');
}
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('차단 트리', () => {
  it('AC-1: 1→2→3 사슬은 깊이 2', () => {
    const t = buildBlockingTree([
      { pid: 2, blockedBy: [1] },
      { pid: 3, blockedBy: [2] },
    ]);
    assert.equal(t.depth, 2);
    assert.equal(t.roots.length, 1);
    assert.equal(t.roots[0]!.pid, 1);
    assert.equal(t.roots[0]!.waiters[0]!.waiters[0]!.pid, 3);
  });
  it('차단 없음 → 깊이 0, 교착(순환)에도 끝난다', () => {
    assert.equal(buildBlockingTree([]).depth, 0);
    const cyc = buildBlockingTree([
      { pid: 1, blockedBy: [2] },
      { pid: 2, blockedBy: [1] },
    ]);
    assert.equal(cyc.depth, 0);
  });
});

describe('query 마스킹', () => {
  it('AC-2: 숫자 → $n, 문자열 → $s', () => {
    assert.equal(maskQuery("where id = 42 and name = 'x'"), 'where id = $n and name = $s');
  });
  it('이스케이프된 따옴표·식별자 숫자·소수', () => {
    assert.equal(maskQuery("select t1.a from t1 where b = 'it''s' and c = 3.5"), 'select t1.a from t1 where b = $s and c = $n');
  });
  it('200자로 자르고 null 은 null', () => {
    assert.equal(maskQuery('x'.repeat(500))!.length, 200);
    assert.equal(maskQuery(null), null);
  });
});

describe('ProbeSource', () => {
  const row = { pid: 7, application_name: 'app', state: 'active', wait_event_type: 'Lock', wait_event: 'transactionid', xact_age_ms: 12.5, query: "update t set v = 1 where id = 'a'", blocked_by: [3] };

  it('AC-3: enabled=false 면 연결도 쿼리도 0건', async () => {
    let connects = 0;
    const probe = createPgProbe({
      clock: fakeClock(),
      enabled: false,
      database: 'lab_run',
      connect: async () => {
        connects++;
        return { query: async () => ({ rows: [] }), end: async () => {} };
      },
    });
    await probe.start({ runId: 'r1', intervalMs: 10, outFile: await tmpFile(), onSample: () => assert.fail('표본 없음') });
    assert.deepEqual(await probe.stop(), { samples: 0 });
    assert.equal(connects, 0);
  });

  it('표본을 onSample·probe.ndjson 으로 내보내고 stop 이 마지막 표본을 남긴다', async () => {
    const queries: unknown[][] = [];
    let ended = false;
    const conn: ProbeConnection = {
      query: async (_sql, params) => {
        queries.push(params);
        return { rows: [row] };
      },
      end: async () => {
        ended = true;
      },
    };
    const got: ProbeData[] = [];
    const outFile = await tmpFile();
    const probe = createPgProbe({ clock: fakeClock(), enabled: true, database: 'lab_run', connect: async () => conn });
    await probe.start({ runId: 'r1', intervalMs: 10, outFile, onSample: (d) => got.push(d) });
    await assert.rejects(() => probe.start({ runId: 'r1', intervalMs: 10, outFile, onSample: () => {} }), /이미 실행 중/);
    await new Promise((r) => setTimeout(r, 30));
    const { samples } = await probe.stop();
    assert.ok(samples >= 2);
    assert.equal(got.length, samples);
    assert.equal(ended, true);
    assert.deepEqual(queries[0], ['lab_run']);
    assert.deepEqual(got[0], {
      sessions: [{ pid: 7, appName: 'app', state: 'active', waitEventType: 'Lock', waitEvent: 'transactionid', xactAgeMs: 12.5, query: 'update t set v = $n where id = $s' }],
      blocking: [{ pid: 7, blockedBy: [3] }],
      lockWaiters: 1,
    });
    const lines = (await readFile(outFile, 'utf8')).trim().split('\n');
    assert.equal(lines.length, samples);
    assert.equal(JSON.parse(lines[0]!).lockWaiters, 1);
    assert.deepEqual(await probe.stop(), { samples: 0 }); // 멈춘 뒤 stop 은 no-op
  });

  it('조회 실패는 삼키고 계속 돈다', async () => {
    let n = 0;
    const errors: unknown[] = [];
    const conn: ProbeConnection = {
      query: async () => {
        if (++n === 1) throw new Error('boom');
        return { rows: [] };
      },
      end: async () => {},
    };
    const probe = createPgProbe({ clock: fakeClock(), enabled: true, database: 'lab_run', connect: async () => conn, onError: (e) => errors.push(e) });
    await probe.start({ runId: 'r1', intervalMs: 10, outFile: await tmpFile(), onSample: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    const { samples } = await probe.stop();
    assert.equal(errors.length, 1);
    assert.ok(samples >= 1);
  });
});

/**
 * 접속(인증 OK → ReadyForQuery)까지만 응답하고 그 뒤 조회에는 답하지 않는 가짜 PG 서버.
 * 막힌 조회와 끊긴 연결을 PG 없이 재현한다.
 */
async function silentPgServer() {
  const sockets: Socket[] = [];
  const server = createServer((sock) => {
    sockets.push(sock);
    let greeted = false;
    sock.on('data', () => {
      if (greeted) return; // 시작 메시지 뒤의 조회는 무시(막힘)
      greeted = true;
      const auth = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]); // 'R' AuthenticationOk
      const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]); // 'Z' ReadyForQuery(idle)
      sock.write(Buffer.concat([auth, ready]));
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    sockets,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('createPgConnect(AC-4)', () => {
  it('막힌 조회는 query_timeout 으로 끝나고, 끊긴 연결 오류는 onError 로 간다(프로세스 유지)', async () => {
    const srv = await silentPgServer();
    after(() => srv.close());
    const errors: unknown[] = [];
    const connect = createPgConnect({ host: '127.0.0.1', port: srv.port, user: 'u', password: 'p', database: 'lab_run', onError: (e) => errors.push(e) });
    const conn = await connect({ queryTimeoutMs: 50 });
    const t0 = Date.now();
    await assert.rejects(conn.query('select 1', []), /timeout/i);
    assert.ok(Date.now() - t0 < 2000, '표본 간격 근처에서 끝난다');

    // 서버가 연결을 끊으면 pg.Client 가 'error' 를 낸다: 리스너가 없으면 uncaughtException 으로 프로세스가 죽는다
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      for (const s of srv.sockets) s.destroy();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    assert.deepEqual(uncaught, []);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /terminated/i);
  });

  it('createPgProbe 는 표본 간격을 query 제한으로 넘긴다', async () => {
    const seen: unknown[] = [];
    const probe = createPgProbe({
      clock: fakeClock(),
      enabled: true,
      database: 'lab_run',
      connect: async (o) => {
        seen.push(o);
        return { query: async () => ({ rows: [] }), end: async () => {} };
      },
    });
    await probe.start({ runId: 'r1', intervalMs: 250, outFile: await tmpFile(), onSample: () => {} });
    await probe.stop();
    assert.deepEqual(seen, [{ queryTimeoutMs: 250 }]);
  });
});

const PG_URL = process.env.PG_PROBE_TEST_URL;
describe('통합(PG)', { skip: PG_URL ? false : 'PG_PROBE_TEST_URL 없음' }, () => {
  it('AC-4: 두 세션이 같은 행을 FOR UPDATE 하면 lockWaiters ≥ 1', async () => {
    const db = new URL(PG_URL!).pathname.slice(1);
    const a = new pg.Client({ connectionString: PG_URL });
    const b = new pg.Client({ connectionString: PG_URL });
    const obs = new pg.Client({ connectionString: PG_URL });
    await Promise.all([a.connect(), b.connect(), obs.connect()]);
    const outFile = await tmpFile();
    const probe = createPgProbe({ clock: realClock, enabled: true, database: db, connect: async () => obs as unknown as ProbeConnection });
    const seen: ProbeData[] = [];
    try {
      await a.query('create table if not exists nul_probe_t(id int primary key)');
      await a.query('insert into nul_probe_t values (1) on conflict do nothing');
      await a.query('begin');
      await a.query('select * from nul_probe_t where id = 1 for update');
      await b.query('begin');
      const blocked = b.query('select * from nul_probe_t where id = 1 for update');
      await new Promise((r) => setTimeout(r, 200));
      await probe.start({ runId: 'r1', intervalMs: 50, outFile, onSample: (d) => seen.push(d) });
      await new Promise((r) => setTimeout(r, 300));
      const { samples } = await probe.stop();
      assert.ok(samples >= 1);
      assert.ok(seen.some((d) => d.lockWaiters >= 1 && d.blocking.some((e) => e.blockedBy.length >= 1)));
      await a.query('rollback');
      await blocked;
      await b.query('rollback');
    } finally {
      await a.query('rollback').catch(() => {});
      await b.query('rollback').catch(() => {});
      await Promise.all([a.end(), b.end()]);
    }
  });
});
