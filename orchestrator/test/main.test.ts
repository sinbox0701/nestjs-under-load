// 배선(T-138) 테스트: 가짜 포트로 조립·종료(SIGTERM), 어댑터(메타데이터·ready·redis·k6 상한·git), env 매핑, HTTP 413·bind 분리.
// 실행: tsc -p tsconfig.json && node --test "test/*.test.ts" (dist 를 import 한다)
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import type { K6JobStatus, RunConfigV1, RunRequest } from '@under-load/contracts';

import { loadPackCatalog } from '../dist/api/index.js';
import { loadConfig } from '../dist/config.js';
import { createEventHub } from '../dist/event-hub/index.js';
import { createRouters, DRAIN_LIMIT, startHttpServers } from '../dist/http/index.js';
import {
  boundK6Runner,
  createMetadataBuilder,
  createReadyProbe,
  detectStackProfiles,
  installShutdown,
  memText,
  readGitInfo,
  resolveEnv,
  sharedBuffersText,
  startOrchestrator,
  withManifestRedis,
} from '../dist/main.js';
import type { OrchestratorPorts } from '../dist/main.js';
import type { Clock, K6Runner, RunConfigBoard } from '../dist/ports.js';
import type { RunMetadataInput } from '../dist/runs/index.js';

const repoDir = path.resolve(import.meta.dirname, '../..');
const fx = (name: string) => JSON.parse(readFileSync(path.join(repoDir, 'engine/contracts/fixtures', name), 'utf8'));
const catalog = loadPackCatalog(repoDir);
const HOST = 'localhost:4000';

function call(port: number, p: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ agent: false, host: '127.0.0.1', port, path: p, method: opts.method ?? 'GET', headers: { host: HOST, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

const refused = (port: number) =>
  call(port, '/health').then(
    (r) => `응답 ${r.status}`,
    (e: NodeJS.ErrnoException) => e.code ?? e.message,
  );

/** 즉시 진행하는 가짜 시계(sleep 은 수동 해제). */
function manualClock() {
  const waiters: { ms: number; resolve: () => void }[] = [];
  const clock: Clock = {
    now: () => 0,
    nowIso: () => new Date(0).toISOString(),
    sleep: (ms, opts) =>
      new Promise<void>((resolve, reject) => {
        if (opts?.signal?.aborted) return reject(new Error('aborted'));
        waiters.push({ ms, resolve });
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  };
  return { clock, fire: () => waiters.splice(0).forEach((w) => w.resolve()), waiters };
}

const unused = (name: string) =>
  new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        return () => {
          throw new Error(`${name}.${String(prop)} 를 부르면 안 된다`);
        };
      },
    },
  );

function fakePorts(over: Partial<OrchestratorPorts> = {}) {
  const calls: string[] = [];
  const board: RunConfigBoard = { publish: () => {}, get: () => null, clear: () => {}, current: () => null, fetchedBy: () => [] };
  const ports: OrchestratorPorts = {
    clock: manualClock().clock,
    docker: unused('docker') as OrchestratorPorts['docker'],
    db: {
      ...(unused('db') as OrchestratorPorts['db']),
      ensureRoles: async () => {
        calls.push('ensureRoles');
      },
    },
    invariants: unused('invariants') as OrchestratorPorts['invariants'],
    k6: unused('k6') as OrchestratorPorts['k6'],
    store: unused('store') as OrchestratorPorts['store'],
    board,
    hub: createEventHub({ clock: manualClock().clock }),
    probe: {
      start: async () => {},
      stop: async () => {
        calls.push('probe.stop');
        return { samples: 0 };
      },
    },
    obs: unused('obs') as OrchestratorPorts['obs'],
    catalog,
    ready: async () => null,
    buildMetadata: () => {
      throw new Error('buildMetadata 를 부르면 안 된다');
    },
    ...over,
  };
  return { ports, calls };
}

const listen = { publicPort: 0, internalPort: 0, bindHost: '127.0.0.1', allowedHosts: [HOST], allowedOrigins: ['http://127.0.0.1:8080'] };

describe('조립·종료(AC-4)', () => {
  it('가짜 포트로 두 리스너를 열고, SIGTERM 에 리스너를 닫고 exit(0)', async () => {
    const { ports, calls } = fakePorts();
    const warnings: string[] = [];
    const handle = await startOrchestrator({
      ports,
      listen,
      runsDir: tmpdir(),
      version: '1.2.3',
      gitSha: 'abc1234',
      engine: { runsDir: tmpdir() },
      prepareGrafana: async () => {
        throw new Error('grafana 연결 거부');
      },
      onClose: () => {
        calls.push('onClose');
      },
      log: () => {},
      warn: (m) => warnings.push(m),
    });
    await handle.startup;
    assert.deepEqual(calls, ['ensureRoles']);
    assert.ok(warnings.some((w) => w.includes('Grafana 토큰 준비 실패')), '토큰 실패는 경고');

    const health = await call(handle.ports.public, '/health', { headers: { origin: 'http://127.0.0.1:8080' } });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true, version: '1.2.3', gitSha: 'abc1234' });
    assert.equal((await call(handle.ports.public, '/internal/run-config')).status, 404, '공개 리스너에 내부 라우트 없음');
    assert.equal((await call(handle.ports.internal, '/internal/run-config?instance=app-1')).status, 204);
    const metrics = await call(handle.ports.internal, '/metrics');
    assert.equal(metrics.status, 200);
    assert.match(metrics.body, /lab_orch_ingest_events_total 0/);
    assert.match(metrics.body, /lab_orch_file_write_errors_total 0/);

    const proc = new EventEmitter() as EventEmitter & { exit(code?: number): void };
    const exited = new Promise<number | undefined>((resolve) => {
      proc.exit = (code) => resolve(code);
    });
    installShutdown(handle, proc, () => {});
    proc.emit('SIGTERM');
    assert.equal(await exited, 0);
    assert.equal(await refused(handle.ports.public), 'ECONNREFUSED', '공개 리스너 닫힘');
    assert.equal(await refused(handle.ports.internal), 'ECONNREFUSED', '내부 리스너 닫힘');
    assert.deepEqual(calls, ['ensureRoles', 'probe.stop', 'onClose']);
  });

  it('역할 보장이 실패해도 리스너는 살아 있다(경고)', async () => {
    const { ports } = fakePorts();
    ports.db = {
      ...ports.db,
      ensureRoles: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const warnings: string[] = [];
    const handle = await startOrchestrator({ ports, listen, runsDir: tmpdir(), version: 'v', gitSha: 's', engine: { runsDir: tmpdir() }, log: () => {}, warn: (m) => warnings.push(m) });
    await handle.startup;
    assert.ok(warnings.some((w) => w.includes('PG 역할 보장 실패')));
    assert.equal((await call(handle.ports.public, '/health')).status, 200);
    await handle.close();
    await handle.close(); // 두 번 불러도 같은 결과
  });
});

describe('HTTP 배선 보정', () => {
  it('내부 리스너 bind host 를 따로 줄 수 있다', async () => {
    const routers = createRouters();
    routers.internal.add('GET', '/internal/x', (ctx) => ctx.empty(204));
    const s = await startHttpServers({ routers, guard: listen, publicPort: 0, internalPort: 0, bindHost: '127.0.0.1', internalBindHost: '127.0.0.1', onError: () => {} });
    try {
      const addr = s.internal.address();
      assert.equal(typeof addr === 'object' && addr ? addr.address : null, '127.0.0.1');
      assert.equal((await call(s.ports.internal, '/internal/x')).status, 204);
    } finally {
      await s.close();
    }
  });

  it('413 이면 응답을 보내고, 남은 본문이 상한을 넘으면 연결을 끊는다', async () => {
    const routers = createRouters();
    routers.public.add('POST', '/echo', async (ctx) => ctx.json(200, await ctx.readJson(16)));
    const s = await startHttpServers({ routers, guard: listen, publicPort: 0, internalPort: 0, bindHost: '127.0.0.1', onError: () => {} });
    try {
      const big = JSON.stringify({ x: 'y'.repeat(100) });
      const declared = await call(s.ports.public, '/echo', { method: 'POST', body: big, headers: { 'content-type': 'application/json' } });
      assert.equal(declared.status, 413);
      // content-length 없이(chunked) 흘려 보내도 413
      const chunked = await call(s.ports.public, '/echo', { method: 'POST', body: big, headers: { 'transfer-encoding': 'chunked' } });
      assert.equal(chunked.status, 413);
      assert.equal((await call(s.ports.public, '/echo', { method: 'POST', body: '{"a":1}' })).status, 200);
      // 상한(DRAIN_LIMIT)을 넘게 흘려 보내면 서버가 연결을 끊는다
      const cut = await new Promise<string>((resolve) => {
        const req = request({ agent: false, host: '127.0.0.1', port: s.ports.public, path: '/echo', method: 'POST', headers: { host: HOST, 'transfer-encoding': 'chunked' } });
        req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
        req.on('response', (res) => res.resume());
        req.on('close', () => resolve('closed'));
        const chunk = Buffer.alloc(1024 * 1024, 120);
        let sent = 0;
        const pump = () => {
          while (sent < DRAIN_LIMIT + 4 * 1024 * 1024) {
            sent += chunk.length;
            if (!req.write(chunk)) return void req.once('drain', pump);
          }
          req.end();
        };
        pump();
      });
      assert.match(cut, /EPIPE|ECONNRESET/);
    } finally {
      await s.close();
    }
  });
});

describe('env', () => {
  it('compose 변수 이름을 config 이름으로 옮긴다', () => {
    const c = loadConfig(
      resolveEnv({
        DOCKER_HOST: 'tcp://socket-proxy:2375',
        COMPOSE_PROJECT_NAME: 'nul-x',
        POSTGRES_HOST: 'pg',
        POSTGRES_PORT: '6543',
        POSTGRES_SUPERUSER: 'root',
        POSTGRES_SUPERUSER_PASSWORD: 'pw',
        LAB_OBSERVER_PASSWORD: 'obs-pw',
      }),
    );
    assert.equal(c.docker.url, 'http://socket-proxy:2375');
    assert.equal(c.docker.composeProject, 'nul-x');
    assert.deepEqual([c.pg.host, c.pg.port, c.pg.adminUser, c.pg.adminPassword, c.pg.observerPassword], ['pg', 6543, 'root', 'pw', 'obs-pw']);
    assert.equal(c.obs.grafanaAdminPassword, 'grafana_local');
    // config 이름이 있으면 그것이 우선
    assert.equal(loadConfig(resolveEnv({ PG_HOST: 'a', POSTGRES_HOST: 'b' })).pg.host, 'a');
  });
});

describe('git·스택 프로필', () => {
  it('git 이 읽히면 HEAD 앞 7자와 dirty', async () => {
    const g = await readGitInfo(async (args) => (args[0] === 'rev-parse' ? '0123456789abcdef\n' : ' M a.ts\n'), 'unknown');
    assert.deepEqual(g, { sha: '0123456', dirty: true });
  });

  it('git 이 못 읽으면 GIT_SHA 폴백, dirty=null', async () => {
    const fail = async () => {
      throw new Error('not a git repository');
    };
    assert.deepEqual(await readGitInfo(fail, 'fedcba9876'), { sha: 'fedcba9', dirty: null });
    assert.deepEqual(await readGitInfo(fail, 'unknown'), { sha: null, dirty: null });
  });

  it('STACK_PROFILES 가 없으면 compose 서비스로 판단, 조회 실패는 꺼짐', async () => {
    const docker = { list: async (svc: string) => (svc === 'grafana' ? [{} as never] : []) };
    assert.deepEqual(await detectStackProfiles(docker, undefined, () => {}), ['obs']);
    assert.deepEqual(await detectStackProfiles(docker, 'trace, bogus', () => {}), ['trace']);
    const warns: string[] = [];
    const broken = {
      list: async () => {
        throw new Error('403');
      },
    };
    assert.deepEqual(await detectStackProfiles(broken, '', (m) => warns.push(m)), []);
    assert.equal(warns.length, 2);
  });
});

describe('어댑터', () => {
  const runConfig: RunConfigV1 = fx('run-config.v1.json');

  it('RunConfig 게시: manifest requires 에 redis 가 있으면 주소, serve 는 run-config.json 으로', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nul-main-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const published: RunConfigV1[] = [];
    const base: RunConfigBoard = { publish: (c) => published.push(c), get: () => null, clear: () => {}, current: () => null, fetchedBy: () => [] };
    const board = withManifestRedis(base, { catalog, redis: { host: 'redis', port: 6379 }, runsDir: dir, warn: assert.fail });
    board.publish({ ...runConfig, strategy: 'redis-lock', redis: null });
    board.publish({ ...runConfig, task: 'prepare-template', runId: 'prep', strategy: 'row-lock', redis: { host: 'x', port: 1 } });
    board.publish({ ...runConfig, strategy: 'row-lock', redis: { host: 'x', port: 1 } });
    assert.deepEqual(published[0]!.redis, { host: 'redis', port: 6379 });
    assert.equal(published[1]!.redis, null);
    assert.equal(published[2]!.redis, null);
    const file = path.join(dir, runConfig.runId, 'run-config.json');
    await board.flushed();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).strategy, 'row-lock');
    assert.equal(existsSync(path.join(dir, 'prep')), false, 'prepare-template 은 파일로 남기지 않는다');
  });

  it('ReadyProbe: 200 은 응답, 그 밖은 null, 호출자 중단은 throw', async () => {
    const ready = fx('ready.json');
    const urls: string[] = [];
    const fake = (status: number, body: unknown): typeof fetch =>
      (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    assert.deepEqual(await createReadyProbe({ port: 3000, timeoutMs: 1000, fetch: fake(200, ready) })('nestjs-under-load-app-1'), ready);
    assert.equal(urls[0], 'http://nestjs-under-load-app-1:3000/_lab/ready');
    assert.equal(await createReadyProbe({ port: 3000, timeoutMs: 1000, fetch: fake(503, { ready: false }) })('a'), null);
    assert.equal(await createReadyProbe({ port: 3000, timeoutMs: 1000, fetch: fake(200, { nope: 1 }) })('a'), null);
    const refusedFetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    assert.equal(await createReadyProbe({ port: 3000, timeoutMs: 1000, fetch: refusedFetch })('a'), null);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(createReadyProbe({ port: 3000, timeoutMs: 1000, fetch: refusedFetch })('a', { signal: ac.signal }));
  });

  it('k6 waitDone 상한: 시간이 지나면 signal 을 abort 한다', async () => {
    const { clock, fire, waiters } = manualClock();
    let seen: AbortSignal | undefined;
    const done: K6JobStatus = fx('k6-job-status.json');
    const inner = {
      waitDone: (_id: string, o?: { signal?: AbortSignal }) =>
        new Promise<K6JobStatus>((resolve) => {
          seen = o?.signal;
          o?.signal?.addEventListener('abort', () => resolve({ ...done, state: 'aborted' }), { once: true });
        }),
    } as unknown as K6Runner;
    const bounded = boundK6Runner(inner, { clock, waitMaxMs: 1000 });
    const p = bounded.waitDone('job-1');
    assert.equal(waiters[0]!.ms, 1000);
    assert.equal(seen!.aborted, false);
    fire();
    assert.equal((await p).state, 'aborted');
    assert.equal(seen!.aborted, true);
  });

  it('메타데이터: 평평한 K6Summary·scriptHash·git·redis·limits·scrapeGaps', () => {
    const req: RunRequest = { ...fx('run-request.json'), strategies: ['redis-lock'], strategyParams: {} };
    const summary = {
      requests: 3000,
      throughputRps: 100,
      httpFailures: 2,
      dropped: 0,
      latencyMs: { success: { p50: 1, p95: 2, p99: 3, n: 2998 }, failed: { p50: 4, p95: 5, p99: 6, n: 2 } },
    };
    const app = {
      id: 'c1',
      name: 'nestjs-under-load-app-1',
      service: 'app',
      number: 1,
      state: 'running',
      image: 'nestjs-under-load/app:dev',
      imageId: 'sha256:app',
      limits: { cpus: 1, memBytes: 512 * 1024 ** 2, cpuset: null },
    };
    const input: RunMetadataInput = {
      sessionId: 's1',
      batchId: 'b1',
      runId: 'r1',
      repetition: 1,
      request: req,
      scenario: catalog.get('g02-stock-decrement')!,
      strategy: { id: 'redis-lock', params: {} },
      appInstances: 2,
      status: 'done',
      error: null,
      templateDb: 'tpl_g02_x',
      seedOptions: req.data.seedOptions,
      runConfig: { ...runConfig, strategy: 'redis-lock' },
      pgProbe: { enabled: true, intervalMs: 1000 },
      facts: {
        docker: { ncpu: 14, memTotalBytes: 11 * 1024 ** 3, serverVersion: '28', operatingSystem: 'Docker Desktop', apiVersion: '1.51' },
        containers: { app: [app], postgres: [{ ...app, service: 'postgres', imageId: 'sha256:pg', limits: { cpus: 2, memBytes: 2 * 1024 ** 3, cpuset: '6-8' } }] },
        pgConfig: { hash: 'sha256:cfg', settings: { max_connections: '100', shared_buffers: '16384' } },
      },
      k6: { scriptHash: 'sha256:script', env: { A: '1' }, warmup: null, main: null, summary },
      validity: { valid: true, reasons: [], k6CpuAvgRatio: 0.4, droppedCountedAsFailure: null, failuresTotal: 2, k6Cpu: { avg: 0.4 } },
      scrapeGaps: null,
      invariants: [],
      steps: [{ name: 'app 정지', at: 't' }],
      artifacts: { runConfig: 'runs/r1/run-config.json', k6Summary: 'runs/r1/summary.json', k6Html: null, events: null, agg: null, probe: null, promSnapshot: null, metadata: 'runs/r1/metadata.json' },
      startedAt: '2026-10-07T00:00:00.000Z',
      endedAt: '2026-10-07T00:01:00.000Z',
    };
    const build = createMetadataBuilder({
      stackProfiles: [],
      git: () => ({ sha: 'abc1234', dirty: false }),
      catalog,
      redisMaxmemoryPolicy: 'noeviction',
      host: { arch: 'arm64', cpu: null },
    });
    const md = build(input);
    assert.deepEqual(md.k6, summary);
    assert.equal(md.k6Script.hash, 'sha256:script');
    assert.deepEqual(md.git, { sha: 'abc1234', dirty: false });
    assert.deepEqual(md.redis, { used: true, maxmemoryPolicy: 'noeviction' });
    assert.deepEqual(md.limits.app, { cpus: 1, mem: '512m', cpuset: 'none' });
    assert.deepEqual(md.limits.postgres, { cpus: 2, mem: '2g', cpuset: '6-8' });
    assert.equal(md.images.app, 'sha256:app');
    assert.equal(md.host.dockerNcpu, 14);
    assert.equal(md.postgres.sharedBuffers, '128MB');
    assert.equal(md.postgres.maxConnections, 100);
    assert.equal(md.validity.checks.scrapeGaps, 'not-measured');
    assert.deepEqual(md.pgProbe, { enabled: true, intervalMs: 1000 });
    assert.deepEqual(md.pool, runConfig.pool);
    assert.equal(md.timeouts.poolAcquireMs, runConfig.pool.acquireTimeoutMs);

    const md2 = createMetadataBuilder({ stackProfiles: ['obs'], git: () => ({ sha: null, dirty: null }), catalog, redisMaxmemoryPolicy: 'noeviction' })({
      ...input,
      strategy: { id: 'row-lock', params: {} },
      request: { ...req, strategies: ['row-lock'] },
      scrapeGaps: { status: 'ok', gaps: 1, details: { series: 3 } },
      k6: { ...input.k6, summary: null },
    });
    assert.deepEqual(md2.redis, { used: false, maxmemoryPolicy: null });
    assert.deepEqual(md2.validity.checks.scrapeGaps, { gaps: 1, details: { series: 3 } });
    assert.equal(md2.k6, null);
    assert.deepEqual(md2.stack.profiles, ['obs']);
  });

  it('표기 변환', () => {
    assert.equal(memText(null), null);
    assert.equal(memText(128 * 1024 ** 2), '128m');
    assert.equal(memText(1000), '1000b');
    assert.equal(sharedBuffersText('262144'), '2GB');
    assert.equal(sharedBuffersText(undefined), null);
  });
});
