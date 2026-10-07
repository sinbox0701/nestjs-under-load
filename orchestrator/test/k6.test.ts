// k6 실행기 클라이언트·env 변환·해시·summary 해석 테스트(가짜 실행기 HTTP 서버).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { K6JobRequest, RunRequest } from '@under-load/contracts';

import { createK6Runner } from '../dist/k6/index.js';
import type { Clock, ScenarioDef } from '../dist/ports.js';

const status = (state: string) => ({
  state,
  exitCode: state === 'running' ? null : 0,
  startedAt: '2026-10-07T09:00:00.000Z',
  endedAt: state === 'running' ? null : '2026-10-07T09:00:30.000Z',
  cpu: { before: null, after: null, cpuMaxCores: 2 },
});

const jobReq = (over: Partial<K6JobRequest> = {}): K6JobRequest => ({
  runId: 'r1',
  phase: 'main',
  script: '/packs/generic/g02-stock-decrement/k6/template.js',
  env: {},
  tags: {},
  prometheusRw: false,
  htmlExport: '/runs/r1/report.html',
  summaryPath: '/runs/r1/summary.json',
  ...over,
});

const scenario: ScenarioDef = {
  id: 'g02-stock-decrement',
  pack: 'generic',
  title: 't',
  minAppInstances: 2,
  k6Script: '/packs/generic/g02-stock-decrement/k6/template.js',
  invariantsSqlPath: 'x',
  invariants: [],
  discardSql: null,
  strategies: [],
  seedDefaults: { products: 5, warmupProducts: 5, stockPerProduct: 100 },
};

const closedReq = {
  scenario: 'g02-stock-decrement',
  strategies: ['no-lock'],
  strategyParams: {},
  appInstances: [2],
  includeMemoryLockSingle: false,
  reps: 1,
  load: { model: 'closed', profile: 'constant', vus: 50, rate: null, preAllocatedVUs: null, maxVUs: null, duration: '30s', warmup: '10s', thinkTimeMs: [0, 5], requestTimeout: '10s' },
  data: { seed: 42, seedOptions: { products: 5, warmupProducts: 5 }, distribution: { kind: 'uniform' } },
  scenarioParams: { qty: 2 },
  instrumentation: 'metrics',
  injectDelay: [],
  prediction: 'p',
  label: null,
} as unknown as RunRequest;

const openReq = { ...closedReq, load: { ...closedReq.load, model: 'open', vus: null, rate: 100, preAllocatedVUs: 50, maxVUs: 1000 } } as unknown as RunRequest;

/** 즉시 진행하는 가짜 시계. sleep 호출 수를 센다. */
function fakeClock() {
  const c = {
    sleeps: 0,
    now: () => 0,
    nowIso: () => '2026-10-07T09:00:00.000Z',
    sleep: async (_ms: number, opts?: { signal?: AbortSignal }) => {
      c.sleeps++;
      if (opts?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    },
  };
  return c as Clock & { sleeps: number };
}

describe('k6 실행기 클라이언트', () => {
  let server: Server;
  let url = '';
  let dir = '';
  const seen: { method: string; path: string; body: string }[] = [];
  let jobStates: string[] = [];
  let submitStatus = 202;
  let abortCalls = 0;
  /** true 면 abort 를 받아도 계속 running(멈춘 실행기) */
  let stuck = false;

  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

  before(async () => {
    server = createServer(async (req, res) => {
      const body = await read(req);
      const path = req.url ?? '';
      seen.push({ method: req.method ?? '', path, body });
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && path === '/jobs') return submitStatus === 202 ? send(202, { jobId: 'j1' }) : send(409, { error: '이미 실행 중인 job 이 있음' });
      if (req.method === 'GET' && path === '/jobs/j1') return send(200, status(jobStates.length > 1 ? (jobStates.shift() as string) : (jobStates[0] ?? 'done')));
      if (req.method === 'POST' && path === '/jobs/j1/abort') {
        abortCalls++;
        if (!stuck) jobStates = ['aborted'];
        return send(202, { jobId: 'j1' });
      }
      if (req.method === 'POST' && path === '/inspect') return send(200, { maxVUs: 10 });
      send(404, { error: '없는 경로' });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    dir = await mkdtemp(join(tmpdir(), 'k6-test-'));
    await mkdir(join(dir, 'packs/generic/g02-stock-decrement/k6'), { recursive: true });
    await writeFile(join(dir, 'packs/generic/g02-stock-decrement/k6/template.js'), '// script');
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const make = (clock = fakeClock()) => ({ clock, runner: createK6Runner({ runnerUrl: url, baseUrl: 'http://nginx', clock, repoDir: dir }) });

  it('submit: 202 면 jobId, 409 면 throw', async () => {
    const { runner } = make();
    submitStatus = 202;
    assert.deepEqual(await runner.submit(jobReq()), { jobId: 'j1' });
    submitStatus = 409;
    await assert.rejects(runner.submit(jobReq()), /이미 실행 중/);
    submitStatus = 202;
  });

  it('submit: /packs·/runs 밖이나 .. 경로는 보내지 않고 거부', async () => {
    const { runner } = make();
    seen.length = 0;
    await assert.rejects(runner.submit(jobReq({ script: '/etc/passwd' })), /script/);
    await assert.rejects(runner.submit(jobReq({ script: '/packs/../etc/x.js' })), /script/);
    await assert.rejects(runner.submit(jobReq({ summaryPath: '/tmp/s.json' })), /summaryPath/);
    await assert.rejects(runner.submit(jobReq({ htmlExport: '/runs/../x.html' })), /htmlExport/);
    await assert.rejects(runner.inspect('/x.js', {}), /script/);
    assert.equal(seen.length, 0);
  });

  it('waitDone: running 이 아닐 때까지 Clock.sleep 으로 간격을 두고 조회', async () => {
    jobStates = ['running', 'running', 'done'];
    const { runner, clock } = make();
    const s = await runner.waitDone('j1', { pollMs: 10 });
    assert.equal(s.state, 'done');
    assert.equal(clock.sleeps, 2);
  });

  it('waitDone: signal abort 면 job 을 abort 하고 최종 status 를 돌려준다', async () => {
    jobStates = ['running'];
    abortCalls = 0;
    const ac = new AbortController();
    ac.abort();
    const { runner } = make();
    const s = await runner.waitDone('j1', { signal: ac.signal });
    assert.equal(abortCalls, 1);
    assert.equal(s.state, 'aborted');
  });

  it('AC-5: abort 뒤에도 실행기가 running 이면 abortGraceMs 상한에서 throw 한다', async () => {
    jobStates = ['running'];
    abortCalls = 0;
    stuck = true;
    try {
      // sleep 한 번에 시간이 ms 만큼 흐르는 가짜 시계
      let t = 0;
      const clock: Clock = { now: () => t, nowIso: () => new Date(t).toISOString(), sleep: async (ms) => void (t += ms) };
      const runner = createK6Runner({ runnerUrl: url, baseUrl: 'http://nginx', clock, repoDir: dir, abortGraceMs: 30_000 });
      const ac = new AbortController();
      ac.abort();
      await assert.rejects(runner.waitDone('j1', { signal: ac.signal, pollMs: 1000 }), /30000ms 안에 끝나지 않았다/);
      assert.equal(abortCalls, 1, 'abort 는 한 번만 보낸다');
      assert.ok(t >= 30_000 && t <= 31_000, `상한 근처에서 끝난다(t=${t})`);
    } finally {
      stuck = false;
    }
  });

  it('inspect: 본문을 그대로 돌려준다', async () => {
    const { runner } = make();
    assert.deepEqual(await runner.inspect('/packs/a.js', { A: '1' }), { maxVUs: 10 });
  });

  it('AC-4: closed 면 MODEL=closed·VUS, RATE·PRE_VUS·MAX_VUS 없음', () => {
    const { runner } = make();
    const env = runner.buildEnv({ scenario, request: closedReq, runId: 'r1', phase: 'main', strategy: 'no-lock', summaryPath: '/runs/r1/summary.json' });
    assert.equal(env.MODEL, 'closed');
    assert.equal(env.VUS, '50');
    for (const k of ['RATE', 'MAX_VUS', 'PRE_VUS']) assert.equal(k in env, false, k);
    assert.equal(env.DURATION, '30s');
    assert.equal(env.QTY, '2');
    assert.equal(env.PRODUCT_MAX, '5');
    assert.equal(env.SUMMARY_PATH, '/runs/r1/summary.json');
    assert.equal('ZIPF_S' in env, false);
  });

  it('buildEnv: open 이면 RATE·PRE_VUS·MAX_VUS 가 있고 VUS 는 없다. 웜업은 짧은 지속·웜업 상품 범위', () => {
    const { runner } = make();
    const env = runner.buildEnv({ scenario, request: openReq, runId: 'r1', phase: 'warmup', strategy: 'no-lock', summaryPath: '/runs/r1/w.json' });
    assert.equal(env.MODEL, 'open');
    assert.deepEqual([env.RATE, env.PRE_VUS, env.MAX_VUS], ['100', '50', '1000']);
    assert.equal('VUS' in env, false);
    assert.equal(env.DURATION, '10s');
    assert.deepEqual([env.PRODUCT_MIN, env.PRODUCT_MAX], ['6', '10']);
  });

  it('AC-5: 스크립트 해시는 SUMMARY_PATH·PHASE 를 뺀 env 와 스크립트 내용으로 계산', async () => {
    const { runner } = make();
    const env = { BASE_URL: 'http://nginx', PHASE: 'main', RATE: '100', SUMMARY_PATH: '/runs/a/s.json' };
    const expected = createHash('sha256')
      .update('// script' + '\n' + JSON.stringify({ BASE_URL: 'http://nginx', RATE: '100' }))
      .digest('hex');
    assert.equal(await runner.scriptHash(scenario, env), expected);
    assert.equal(await runner.scriptHash(scenario, { ...env, PHASE: 'warmup', SUMMARY_PATH: '/runs/b/s.json' }), expected);
    assert.notEqual(await runner.scriptHash(scenario, { ...env, RATE: '200' }), expected);
  });

  it('AC-3: summary 의 expected_response 서브메트릭으로 성공·실패 지연을 분리', async () => {
    const file = join(dir, 'summary.json');
    await writeFile(
      file,
      JSON.stringify({
        metrics: {
          http_reqs: { values: { count: 3000, rate: 99.5 } },
          http_req_failed: { values: { rate: 0.01, passes: 30, fails: 2970 } },
          dropped_iterations: { values: { count: 7, rate: 0.2 } },
          'http_req_duration{expected_response:true}': { values: { med: 4, 'p(95)': 9, 'p(99)': 15, count: 2970 } },
          'http_req_duration{expected_response:false}': { values: { med: 10000, 'p(95)': 10001, 'p(99)': 10002, count: 30 } },
        },
      }),
    );
    const { runner } = make();
    assert.deepEqual(await runner.readSummary(file, 30), {
      requests: 3000,
      throughputRps: 100,
      httpFailures: 30,
      dropped: 7,
      latencyMs: {
        success: { p50: 4, p95: 9, p99: 15, n: 2970 },
        failed: { p50: 10000, p95: 10001, p99: 10002, n: 30 },
      },
    });
  });

  it('summary: threshold 로 만든 phase 태그 서브메트릭 키(phase:main,expected_response:…)도 읽는다', async () => {
    const file = join(dir, 'summary4.json');
    await writeFile(
      file,
      JSON.stringify({
        metrics: {
          http_reqs: { values: { count: 100, rate: 10 } },
          http_req_failed: { values: { rate: 0.4, passes: 40, fails: 60 } },
          'http_req_duration{phase:main}': { values: { med: 1, 'p(95)': 1, 'p(99)': 1, count: 100 } },
          'http_req_duration{phase:main,expected_response:true}': { values: { med: 2, 'p(95)': 3, 'p(99)': 4, count: 60 } },
          'http_req_duration{phase:main,expected_response:false}': { values: { med: 5, 'p(95)': 6, 'p(99)': 7, count: 40 } },
        },
      }),
    );
    const { runner } = make();
    const s = await runner.readSummary(file, 10);
    assert.deepEqual(s.latencyMs, { success: { p50: 2, p95: 3, p99: 4, n: 60 }, failed: { p50: 5, p95: 6, p99: 7, n: 40 } });
  });

  it('throughputRps: http_reqs.count / 본 실행 길이, 길이가 없거나 0 이하면 throw', async () => {
    const file = join(dir, 'summary3.json');
    // 포화로 gracefulStop 까지 늘어나 k6 rate(2100/43.2s≈48.6)가 낮게 잡힌 경우
    await writeFile(file, JSON.stringify({ metrics: { http_reqs: { values: { count: 2100, rate: 48.6 } } } }));
    const { runner } = make();
    assert.equal((await runner.readSummary(file, 30)).throughputRps, 70);
    await assert.rejects(runner.readSummary(file, 0), /본 실행 길이/);
    await assert.rejects(runner.readSummary(file, undefined as unknown as number), /본 실행 길이/);
  });

  it('summary: 실패 서브메트릭이 없고 count 도 없는 신버전 평탄 모양', async () => {
    const file = join(dir, 'summary2.json');
    await writeFile(
      file,
      JSON.stringify({
        metrics: {
          http_reqs: { count: 100, rate: 10 },
          http_req_failed: { passes: 0, fails: 100, value: 0 },
          'http_req_duration{expected_response:true}': { med: 2, 'p(95)': 3, 'p(99)': 4 },
        },
      }),
    );
    const { runner } = make();
    const s = await runner.readSummary(file, 30);
    assert.equal(s.dropped, 0);
    assert.deepEqual(s.latencyMs.success, { p50: 2, p95: 3, p99: 4, n: 100 });
    assert.deepEqual(s.latencyMs.failed, { p50: null, p95: null, p99: null, n: 0 });
  });
});
