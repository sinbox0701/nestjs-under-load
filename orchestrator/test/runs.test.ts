// RunEngine(실행 수명주기) 테스트. 모든 의존 모듈은 가짜 포트, 시간은 가짜 Clock.
// 실행: tsc -p tsconfig.json && node --test "test/*.test.ts" (dist 를 import 한다)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import type { InvariantResult, K6JobRequest, K6JobStatus, ReadyResponse, RunConfigV1, RunMetadata, RunRequest, RunRow } from '@under-load/contracts';

import type {
  Clock,
  ContainerInfo,
  DbAdmin,
  DockerControl,
  EventHub,
  InvariantRunner,
  K6Runner,
  MetadataStore,
  ObsClient,
  ProbeSource,
  ReadyProbe,
  RunConfigBoard,
  ScenarioCatalog,
  ScenarioDef,
} from '../dist/ports.js';
import type { RunMetadataInput } from '../dist/runs/index.js';
import { buildPlan, createRunEngine, dashboardPeriod, k6DurationMs, renderDiscardSql, RUN_STEPS } from '../dist/runs/index.js';

// ───────────────────────────── 가짜 포트 ─────────────────────────────

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

function fakeClock(): Clock {
  let t = Date.UTC(2026, 9, 7, 1, 2, 3);
  return {
    now: () => t,
    nowIso: () => new Date(t).toISOString(),
    sleep: (ms, opts) =>
      new Promise((resolve, reject) => {
        if (opts?.signal?.aborted) return reject(abortError());
        t += ms;
        setImmediate(() => (opts?.signal?.aborted ? reject(abortError()) : resolve()));
      }),
  };
}

const container = (n: number): ContainerInfo => ({
  id: `id-app-${n}`,
  name: `lab-app-${n}`,
  service: 'app',
  number: n,
  state: 'exited',
  image: 'app:local',
  imageId: 'sha256:app',
  limits: { cpus: 1, memBytes: 512 * 1024 * 1024, cpuset: null },
});

const SCENARIO: ScenarioDef = {
  id: 'g02-stock-decrement',
  pack: 'generic',
  title: 'G02',
  minAppInstances: 1,
  k6Script: '/packs/generic/g02-stock-decrement/k6/template.js',
  invariantsSqlPath: 'packs/generic/g02-stock-decrement/invariants.sql',
  invariants: [{ id: 'sold-equals-decrement', severity: 'critical', sql: 'invariants.sql#sold_equals_decrement' }],
  discardSql: 'delete from g02_order where product_id > {{products}}',
  strategies: [
    { id: 'no-lock', params: {} },
    { id: 'row-lock', params: { lockTimeoutMs: 1000 } },
    { id: 'app-memory-lock', params: {} },
  ],
  seedDefaults: { products: 5, warmupProducts: 5, stockPerProduct: 100 },
};

function request(over: Partial<RunRequest> = {}): RunRequest {
  return {
    scenario: 'g02-stock-decrement',
    strategies: ['no-lock', 'row-lock'],
    strategyParams: {},
    appInstances: [2],
    includeMemoryLockSingle: true,
    reps: 3,
    load: {
      model: 'closed',
      profile: 'constant',
      vus: 50,
      rate: null,
      preAllocatedVUs: null,
      maxVUs: null,
      duration: '30s',
      warmup: '10s',
      thinkTimeMs: [0, 0],
      requestTimeout: '10s',
    },
    data: { seed: 42, seedOptions: { products: 3 }, distribution: { kind: 'uniform' } },
    scenarioParams: { qty: 1 },
    instrumentation: 'metrics',
    injectDelay: [],
    prediction: 'no-lock 이 2대에서 위반할 것이다',
    label: null,
    ...over,
  };
}

/** K6Runner.readSummary 결과(평평한 K6Summary). 엔진은 이 모양 그대로 RunMetadataInput.k6.summary 로 넘긴다. */
const SUMMARY = Object.freeze({
  requests: 100,
  throughputRps: 10,
  httpFailures: 0,
  dropped: 0,
  latencyMs: { success: { p50: 1, p95: 2, p99: 3, n: 100 }, failed: { p50: null, p95: null, p99: null, n: 0 } },
});

type World = ReturnType<typeof world>;

function world(
  opts: {
    templateExists?: boolean;
    /** 이전 준비가 끊긴 잔재(exists && !isTemplate) */
    templateLeftover?: boolean;
    apps?: number;
    ready?: (inst: string, cfg: RunConfigV1 | null) => ReadyResponse | null;
    /** 기본 /data/runs(없는 경로) */
    runsDir?: string;
  } = {},
) {
  const clock = fakeClock();
  const calls: string[] = [];
  const apps = Array.from({ length: opts.apps ?? 3 }, (_, i) => container(i + 1));
  const running = new Set<string>();

  const docker: DockerControl = {
    list: async (svc) => (svc === 'app' ? apps.map((c) => ({ ...c, state: running.has(c.name) ? 'running' : 'exited' })) : []),
    inspect: async () => apps[0]!,
    stop: async (n) => {
      calls.push(`docker.stop ${n}`);
      running.delete(n);
    },
    start: async (n) => {
      calls.push(`docker.start ${n}`);
      running.add(n);
    },
    restart: async (n) => {
      calls.push(`docker.restart ${n}`);
      running.add(n);
    },
    info: async () => ({ ncpu: 14, memTotalBytes: 1, serverVersion: 'x', operatingSystem: 'x', apiVersion: 'x' }),
  };

  let template = opts.templateLeftover
    ? { exists: true, isTemplate: false }
    : { exists: opts.templateExists ?? true, isTemplate: opts.templateExists ?? true };
  const db: DbAdmin = {
    templateName: async (scenario, data) => {
      calls.push(`db.templateName ${scenario.id} ${JSON.stringify(data.seedOptions)}`);
      return 'tpl_g02_abc';
    },
    templateStatus: async () => ({ ...template }),
    createTemplateDb: async (n) => {
      calls.push(`db.createTemplateDb ${n}`);
      template = { exists: true, isTemplate: false };
    },
    dropTemplateDb: async (n) => {
      calls.push(`db.dropTemplateDb ${n}`);
      template = { exists: false, isTemplate: false };
    },
    markTemplate: async (n) => {
      calls.push(`db.markTemplate ${n}`);
      template = { exists: true, isTemplate: true };
    },
    resetRunDb: async (t) => void calls.push(`db.resetRunDb ${t}`),
    execInRunDb: async (sql) => void calls.push(`db.exec ${sql}`),
    ensureRoles: async () => {},
    configHash: async () => ({ hash: 'sha256:pg', settings: {} }),
  };

  const invResult: InvariantResult[] = [{ id: 'sold-equals-decrement', severity: 'critical', violations: 0, passed: true }];
  const invariants: InvariantRunner = { run: async () => invResult };

  // k6: main 의 대기 동작을 테스트가 바꾼다.
  const jobs: (K6JobRequest & { jobId: string })[] = [];
  const aborted: string[] = [];
  const doneStatus = (state: K6JobStatus['state']): K6JobStatus => ({
    state,
    exitCode: 0,
    startedAt: clock.nowIso(),
    endedAt: clock.nowIso(),
    cpu: { before: null, after: null, cpuMaxCores: 2 },
  });
  const hooks: { onMainSubmit?: (job: K6JobRequest) => void; blockMain?: boolean } = {};
  const k6: K6Runner = {
    buildEnv: (i) => ({ PHASE: i.phase, RUN_ID: i.runId, SUMMARY_PATH: i.summaryPath, STRATEGY: i.strategy }),
    scriptHash: async () => 'sha256:script',
    submit: async (job) => {
      const jobId = `job-${jobs.length + 1}`;
      jobs.push({ ...job, jobId });
      calls.push(`k6.submit ${job.phase} ${job.runId}`);
      if (job.phase === 'main') hooks.onMainSubmit?.(job);
      return { jobId };
    },
    status: async () => doneStatus('done'),
    waitDone: async (jobId, o) => {
      const job = jobs.find((j) => j.jobId === jobId)!;
      if (job.phase === 'main' && hooks.blockMain) {
        // 중단될 때까지 끝나지 않는 본 실행. 가짜는 abort 를 직접 부르지 않는다(엔진이 부르는지 본다).
        await new Promise<void>((resolve) => {
          if (o?.signal?.aborted) return resolve();
          o?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return doneStatus('aborted');
      }
      return doneStatus('done');
    },
    abort: async (jobId) => void aborted.push(jobId),
    inspect: async () => ({}),
    readSummary: async (file, sec) => {
      calls.push(`k6.readSummary ${file} ${sec}`);
      return SUMMARY;
    },
    judgeValidity: () => ({ valid: true, reasons: [], k6CpuAvgRatio: 0.3, droppedCountedAsFailure: null, failuresTotal: 0, k6Cpu: {} }),
  };

  const rows = new Map<string, RunRow>();
  const insertOrder: string[] = [];
  const steps = new Map<string, { name: string; at: string }[]>();
  const metadata = new Map<string, RunMetadataInput>();
  const sessionStates: string[] = [];
  const batches: string[] = [];
  const store: MetadataStore = {
    createSession: async () => {},
    updateSession: async (_id, p) => {
      if (p.state) sessionStates.push(p.state);
    },
    getSession: async () => null,
    createBatch: async (b) => void batches.push(b.batchId),
    insertRun: async (r) => {
      rows.set(r.runId, { ...r });
      insertOrder.push(r.runId);
    },
    updateRun: async (id, p) => void rows.set(id, { ...rows.get(id)!, ...p }),
    getRun: async (id) => rows.get(id) ?? null,
    listRuns: async () => ({ items: [], next: null }),
    addStep: async (id, s) => void steps.set(id, [...(steps.get(id) ?? []), s]),
    getSteps: async (id) => steps.get(id) ?? [],
    // 가짜 조립기가 입력을 그대로 돌려주므로 입력 모양으로 보관한다.
    saveMetadata: async (id, m) => void metadata.set(id, m as unknown as RunMetadataInput),
    getMetadata: async () => null,
    getBatchSummary: async () => null,
    getSessionBatches: async () => [],
    getBatchRuns: async () => [],
  };

  const published: RunConfigV1[] = [];
  let current: RunConfigV1 | null = null;
  const board: RunConfigBoard = {
    publish: (c) => {
      published.push(c);
      current = c;
    },
    get: () => current,
    clear: () => {
      current = null;
    },
    current: () => current,
    fetchedBy: () => [],
  };

  const wsTypes: string[] = [];
  const hub: EventHub = {
    beginRun: async (c) => void calls.push(`hub.begin ${c.runId}`),
    endRun: async (id) => void calls.push(`hub.end ${id}`),
    ingest: async () => ({ ok: true, events: 0 }),
    publish: (m) => void wsTypes.push(m.type),
    snapshot: () => ({ events: [], agg: [] }),
    registerRoutes: () => {},
    renderMetrics: () => '',
    close: async () => {},
  };

  const probe: ProbeSource = {
    start: async (o) => void calls.push(`probe.start ${o.runId} ${o.intervalMs}`),
    stop: async () => {
      calls.push('probe.stop');
      return { samples: 0 };
    },
  };

  const obs: ObsClient = {
    prepareToken: async () => ({ status: 'not-measured' }),
    annotate: async () => ({ status: 'not-measured' }),
    snapshot: async () => ({ status: 'not-measured' }),
    scrapeGaps: async () => ({ status: 'not-measured' }),
  };

  const catalog: ScenarioCatalog = { list: () => [SCENARIO], get: (id) => (id === SCENARIO.id ? SCENARIO : undefined) };

  const ready: ReadyProbe = async (inst) => {
    if (!running.has(inst)) return null;
    const cfg = board.current();
    if (opts.ready) return opts.ready(inst, cfg);
    if (!cfg) return null;
    return {
      instance: inst,
      runId: cfg.runId,
      task: cfg.task,
      scenario: cfg.scenario,
      strategy: cfg.strategy,
      instrumentation: cfg.instrumentation,
      bootedAt: clock.nowIso(),
      ...(cfg.prepareTemplate ? { prepared: { database: cfg.prepareTemplate.database, durationMs: 5 } } : {}),
    };
  };

  const engine = createRunEngine({
    clock,
    docker,
    db,
    invariants,
    k6,
    store,
    board,
    hub,
    probe,
    obs,
    catalog,
    ready,
    buildMetadata: (input) => input as unknown as RunMetadata,
    options: { runsDir: opts.runsDir ?? '/data/runs', readyTimeoutMs: 2000, readyPollMs: 500 },
    randomSuffix: () => 'beef',
  });

  return { engine, calls, jobs, aborted, rows, insertOrder, steps, metadata, sessionStates, batches, published, wsTypes, hooks, running };
}

const NORMAL_STEPS = [
  RUN_STEPS.stopApps,
  RUN_STEPS.resetDb,
  RUN_STEPS.publishConfig,
  RUN_STEPS.startApps,
  RUN_STEPS.warmup,
  RUN_STEPS.discardWarmup,
  RUN_STEPS.main,
  RUN_STEPS.invariants,
  RUN_STEPS.collect,
];

async function startOk(w: World, req: RunRequest) {
  const r = await w.engine.start(req);
  assert.equal(r.kind, 'accepted');
  if (r.kind !== 'accepted') throw new Error('unreachable');
  return r.accepted;
}

// ───────────────────────────── 테스트 ─────────────────────────────

describe('RunEngine 수명주기', () => {
  it('AC-1: strategies 2 × [2] × reps 3 → 6회가 순서대로 돌고 단계 기록이 기대 순서다', async () => {
    const w = world();
    const acc = await startOk(w, request());
    assert.equal(acc.sessionId, '2026-10-07T01-02-03Z_beef');
    assert.deepEqual(
      acc.batches.map((b) => [b.strategy, b.appInstances, b.runIds.length]),
      [
        ['no-lock', 2, 3],
        ['row-lock', 2, 3],
      ],
    );
    await w.engine.idle();

    const expectedOrder = acc.batches.flatMap((b) => b.runIds);
    assert.equal(expectedOrder.length, 6);
    assert.deepEqual(w.insertOrder, expectedOrder);
    assert.ok(expectedOrder[0]!.endsWith('_g02_no-lock_i2_r1'));
    for (const runId of expectedOrder) {
      assert.deepEqual(
        (w.steps.get(runId) ?? []).map((s) => s.name),
        NORMAL_STEPS,
        runId,
      );
      const row = w.rows.get(runId)!;
      assert.equal(row.status, 'done');
      assert.equal(row.valid, true);
      assert.equal(row.invariantsPassed, true);
      assert.equal(row.violationsTotal, 0);
      const md = w.metadata.get(runId)!;
      assert.equal(md.status, 'done');
      assert.deepEqual(
        md.steps.map((s) => s.name),
        NORMAL_STEPS,
      );
      assert.equal(md.templateDb, 'tpl_g02_abc');
    }
    assert.deepEqual(w.sessionStates, ['running', 'done']);
    assert.equal(w.engine.currentRunId(), null);

    // 실행 1회의 포트 호출 순서(run.mjs 와 같은 흐름)
    const first = expectedOrder[0]!;
    const i = w.calls.indexOf(`hub.begin ${first}`);
    const slice = w.calls.slice(i, w.calls.indexOf(`hub.end ${first}`) + 1);
    assert.deepEqual(slice, [
      `hub.begin ${first}`,
      'docker.stop lab-app-1',
      'docker.stop lab-app-2',
      'docker.stop lab-app-3',
      'db.resetRunDb tpl_g02_abc',
      'docker.start lab-app-1',
      'docker.start lab-app-2',
      `k6.submit warmup ${first}`,
      // seedOptions.products=3 이 seedDefaults 의 5 를 덮는다
      'db.exec delete from g02_order where product_id > 3',
      // PG 프로브는 본 실행 구간만(제출 직전 시작, 끝난 뒤 정지)
      `probe.start ${first} 5000`,
      `k6.submit main ${first}`,
      'probe.stop',
      // 본 실행 길이 30s → 30초(throughputRps 분모)
      `k6.readSummary /data/runs/${first}/summary.json 30`,
      `hub.end ${first}`,
    ]);
    // 실행마다 serve RunConfig 게시, 템플릿이 있으니 prepare 는 없다
    assert.equal(w.published.length, 6);
    assert.ok(w.published.every((c) => c.task === 'serve'));
    assert.equal(w.published[3]!.strategy, 'row-lock');
    assert.deepEqual(w.published[3]!.strategyParams, { lockTimeoutMs: 1000 });
    // 본 실행 job: summaryPath·report 경로
    const main = w.jobs.find((j) => j.phase === 'main')!;
    assert.equal(main.summaryPath, `/runs/${first}/summary.json`);
    assert.equal(main.htmlExport, `/runs/${first}/report.html`);
    assert.deepEqual(main.tags, { run_id: first, phase: 'main' });
    // k6 내장 태그와 충돌하는 scenario 키는 어떤 job 에도 없다
    assert.ok(w.jobs.every((j) => !('scenario' in j.tags)));
    assert.ok(w.wsTypes.includes('status') && w.wsTypes.includes('invariants') && w.wsTypes.includes('end'));
  });

  it('T-147 AC-1: 템플릿이 없으면 createTemplateDb → prepare 게시·재시작 → prepared → prepare app 정지 → markTemplate', async () => {
    const w = world({ templateExists: false });
    await startOk(w, request({ reps: 1, strategies: ['no-lock'] }));
    await w.engine.idle();
    const prep = w.published[0]!;
    assert.equal(prep.task, 'prepare-template');
    assert.equal(prep.prepareTemplate?.database, 'tpl_g02_abc');
    // seedDefaults 와 요청 seedOptions 를 합쳐 세 키를 모두 채운다(T-121)
    assert.deepEqual(prep.prepareTemplate?.seedOptions, { products: 3, warmupProducts: 5, stockPerProduct: 100 });
    // 세션 시작 ~ 첫 실행 전까지의 포트 호출(템플릿 준비 구간)
    const tplCalls = w.calls.slice(0, w.calls.findIndex((c) => c.startsWith('hub.begin')));
    assert.deepEqual(tplCalls, [
      'db.templateName g02-stock-decrement {"products":3,"warmupProducts":5,"stockPerProduct":100}',
      'db.createTemplateDb tpl_g02_abc',
      'docker.stop lab-app-2',
      'docker.stop lab-app-3',
      'docker.restart lab-app-1',
      'docker.stop lab-app-1',
      'db.markTemplate tpl_g02_abc',
    ]);
    assert.equal(w.published[1]!.task, 'serve');
    assert.deepEqual(w.sessionStates, ['running', 'done']);
  });

  it('T-147 AC-2: 준비가 끊긴 잔재(exists && !isTemplate)는 dropTemplateDb 후 다시 만든다', async () => {
    const w = world({ templateLeftover: true });
    await startOk(w, request({ reps: 1, strategies: ['no-lock'] }));
    await w.engine.idle();
    const iDrop = w.calls.indexOf('db.dropTemplateDb tpl_g02_abc');
    const iCreate = w.calls.indexOf('db.createTemplateDb tpl_g02_abc');
    const iMark = w.calls.indexOf('db.markTemplate tpl_g02_abc');
    assert.ok(iDrop >= 0 && iCreate > iDrop && iMark > iCreate, w.calls.join('\n'));
    assert.deepEqual(w.sessionStates, ['running', 'done']);
  });

  it('템플릿이 이미 있으면 만들지도 지우지도 않는다', async () => {
    const w = world();
    await startOk(w, request({ reps: 1, strategies: ['no-lock'] }));
    await w.engine.idle();
    assert.ok(!w.calls.some((c) => /^db\.(createTemplateDb|dropTemplateDb|markTemplate)/.test(c)));
  });

  it('템플릿 준비가 실패(readiness 타임아웃)하면 만들던 DB 를 지우고 세션 failed', async () => {
    const w = world({ templateExists: false, ready: () => null });
    await startOk(w, request({ reps: 1, strategies: ['no-lock'] }));
    await w.engine.idle();
    const iCreate = w.calls.indexOf('db.createTemplateDb tpl_g02_abc');
    assert.ok(iCreate >= 0 && w.calls.indexOf('db.dropTemplateDb tpl_g02_abc') > iCreate);
    assert.ok(!w.calls.includes('db.markTemplate tpl_g02_abc'));
    assert.deepEqual(w.insertOrder, []);
    assert.deepEqual(w.sessionStates, ['running', 'failed']);
  });

  it('T-147 AC-5: readSummary 에 본 실행 길이(초)를 넘기고 summary 는 평평한 K6Summary 그대로 메타데이터 입력에 간다', async () => {
    const w = world();
    const req = request({ reps: 1, strategies: ['no-lock'] });
    const acc = await startOk(w, { ...req, load: { ...req.load, duration: '1m30s' } });
    await w.engine.idle();
    const runId = acc.batches[0]!.runIds[0]!;
    assert.deepEqual(
      w.calls.filter((c) => c.startsWith('k6.readSummary')),
      [`k6.readSummary /data/runs/${runId}/summary.json 90`],
    );
    const md = w.metadata.get(runId)!;
    // metadata.k6 조립(T-138 어댑터)이 펴서 넣을 값: requests·throughputRps·httpFailures·dropped·latencyMs.success/failed
    assert.deepEqual(md.k6.summary, SUMMARY);
    assert.deepEqual(Object.keys(md.k6.summary!).sort(), ['dropped', 'httpFailures', 'latencyMs', 'requests', 'throughputRps']);
    assert.deepEqual(Object.keys(md.k6.summary!.latencyMs).sort(), ['failed', 'success']);
    assert.deepEqual(Object.keys(md.k6).sort(), ['env', 'main', 'scriptHash', 'summary', 'warmup']);
    assert.equal(md.k6.scriptHash, 'sha256:script');
    assert.ok(w.jobs.length === 2 && w.jobs.every((j) => !('scenario' in j.tags)));
  });

  it('AC-2: app-memory-lock + includeMemoryLockSingle 이면 1대 케이스가 추가된다', async () => {
    const w = world();
    const acc = await startOk(w, request({ strategies: ['app-memory-lock'], reps: 1 }));
    assert.deepEqual(
      acc.batches.map((b) => b.appInstances),
      [2, 1],
    );
    await w.engine.idle();
    assert.equal(w.insertOrder.length, 2);
    assert.equal(w.rows.get(acc.batches[1]!.runIds[0]!)!.appInstances, 1);

    const w2 = world();
    const acc2 = await startOk(w2, request({ strategies: ['app-memory-lock'], reps: 1, includeMemoryLockSingle: false }));
    assert.deepEqual(
      acc2.batches.map((b) => b.appInstances),
      [2],
    );
    await w2.engine.idle();
  });

  it('AC-3: 본 실행 중 abort → k6 job abort, 그 실행은 aborted 로 메타데이터 저장, 남은 실행 없음', async () => {
    const w = world();
    w.hooks.blockMain = true;
    let firstRun = '';
    w.hooks.onMainSubmit = (job) => {
      firstRun = job.runId;
      setImmediate(() => void w.engine.abort(job.runId));
    };
    await startOk(w, request());
    await w.engine.idle();

    const mainJob = w.jobs.find((j) => j.phase === 'main')!;
    assert.deepEqual(w.aborted, [mainJob.jobId]);
    assert.deepEqual(w.insertOrder, [firstRun]);
    const row = w.rows.get(firstRun)!;
    assert.equal(row.status, 'aborted');
    assert.equal(row.valid, false);
    assert.notEqual(row.endedAt, null);
    const md = w.metadata.get(firstRun)!;
    assert.equal(md.status, 'aborted');
    assert.deepEqual(md.validity.reasons, ['중단됨']);
    assert.equal(w.metadata.size, 1);
    assert.ok(w.calls.includes('probe.stop'));
    assert.ok(w.calls.includes(`hub.end ${firstRun}`));
    assert.deepEqual(w.sessionStates, ['running', 'aborted']);
    assert.equal(w.jobs.filter((j) => j.phase === 'main').length, 1);
  });

  it('AC-4: readiness 에서 runId 가 다른 응답만 오면 타임아웃 → failed, 다음 실행 없음', async () => {
    const w = world({
      ready: (inst, cfg) =>
        cfg && { instance: inst, runId: 'other-run', task: 'serve', scenario: cfg.scenario, strategy: cfg.strategy, instrumentation: 'off', bootedAt: 'x' },
    });
    const acc = await startOk(w, request());
    await w.engine.idle();
    const first = acc.batches[0]!.runIds[0]!;
    assert.deepEqual(w.insertOrder, [first]);
    const row = w.rows.get(first)!;
    assert.equal(row.status, 'failed');
    assert.equal(row.valid, false);
    const md = w.metadata.get(first)!;
    assert.equal(md.status, 'failed');
    assert.match(md.error ?? '', /readiness 타임아웃/);
    assert.deepEqual(
      md.steps.map((s) => s.name),
      [RUN_STEPS.stopApps, RUN_STEPS.resetDb, RUN_STEPS.publishConfig, RUN_STEPS.startApps, RUN_STEPS.collect],
    );
    assert.equal(w.jobs.length, 0);
    assert.deepEqual(w.sessionStates, ['running', 'failed']);
  });

  it('AC-5: 진행 중 세션이 있으면 새 start 는 busy', async () => {
    const w = world();
    w.hooks.blockMain = true;
    const acc = await startOk(w, request());
    const again = await w.engine.start(request());
    assert.deepEqual(again, { kind: 'busy', sessionId: acc.sessionId });

    const st = await w.engine.status(acc.sessionId);
    assert.equal(st?.sessionId, acc.sessionId);
    assert.ok(st && (st.state === 'queued' || st.state === 'running'));

    assert.equal(await w.engine.abort('unknown-run'), false);
    assert.equal(await w.engine.abort(acc.batches[1]!.runIds[2]!), true);
    await w.engine.idle();
    // 끝나면 다시 받는다
    w.hooks.blockMain = false;
    const next = await w.engine.start(request({ reps: 1, strategies: ['no-lock'] }));
    assert.equal(next.kind, 'accepted');
    await w.engine.idle();
  });

  it('시나리오 정의와 맞지 않는 요청은 invalid(점 경로)', async () => {
    const w = world();
    const r = await w.engine.start(request({ strategies: ['no-lock', 'mystery'] }));
    assert.equal(r.kind, 'invalid');
    if (r.kind === 'invalid') assert.deepEqual(r.errors.map((e) => e.path), ['strategies.1']);
    const r2 = await w.engine.start(request({ scenario: 'nope' }));
    assert.equal(r2.kind, 'invalid');
    // invalid 는 자리를 차지하지 않는다
    const ok = await w.engine.start(request({ reps: 1, strategies: ['no-lock'] }));
    assert.equal(ok.kind, 'accepted');
    await w.engine.idle();
  });

  it('app 컨테이너가 모자라면 그 실행은 failed', async () => {
    const w = world({ apps: 1 });
    const acc = await startOk(w, request({ reps: 2 }));
    await w.engine.idle();
    assert.deepEqual(w.insertOrder, [acc.batches[0]!.runIds[0]!]);
    assert.match(w.metadata.get(w.insertOrder[0]!)!.error ?? '', /2대 필요/);
  });

  it('warmup 0s 면 웜업·폐기 단계를 건너뛴다', async () => {
    const w = world();
    const req = request({ reps: 1, strategies: ['no-lock'] });
    const acc = await startOk(w, { ...req, load: { ...req.load, warmup: '0s' } });
    await w.engine.idle();
    const runId = acc.batches[0]!.runIds[0]!;
    assert.deepEqual(
      (w.steps.get(runId) ?? []).map((s) => s.name),
      NORMAL_STEPS.filter((s) => s !== RUN_STEPS.warmup && s !== RUN_STEPS.discardWarmup),
    );
  });
});

describe('k6 HTML 보고서(T-150)', () => {
  it('report.html 은 실제로 생긴 경우에만 artifacts 에 넣고, 본 실행 job 에 대시보드 주기를 준다', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nul-runs-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const w = world({ runsDir: dir });
    // 첫 실행만 k6 가 보고서를 쓴 것으로 한다
    let n = 0;
    w.hooks.onMainSubmit = (job) => {
      if (n++ > 0) return;
      mkdirSync(path.join(dir, job.runId), { recursive: true });
      writeFileSync(path.join(dir, job.runId, 'report.html'), '<html></html>');
    };
    const acc = await startOk(w, request({ reps: 2, strategies: ['no-lock'] }));
    await w.engine.idle();
    const [r1, r2] = acc.batches[0]!.runIds;
    assert.equal(w.metadata.get(r1!)!.artifacts.k6Html, `runs/${r1}/report.html`);
    assert.equal(w.metadata.get(r2!)!.artifacts.k6Html, null);
    const main = w.jobs.find((j) => j.phase === 'main')!;
    const warm = w.jobs.find((j) => j.phase === 'warmup')!;
    assert.equal(main.env.K6_WEB_DASHBOARD_PERIOD, '1s');
    assert.equal('K6_WEB_DASHBOARD_PERIOD' in warm.env, false, '보고서를 내지 않는 웜업 job 엔 없다');
  });

  it('dashboardPeriod: 길이/30 을 1–10초로', () => {
    assert.deepEqual(['5s', '30s', '2m', '5m', '1h', undefined].map(dashboardPeriod), ['1s', '1s', '4s', '10s', '10s', '1s']);
  });
});

describe('계획·변환 보조', () => {
  it('buildPlan 은 요청에 1대가 있으면 memory-lock 1대를 더하지 않는다', () => {
    const plan = buildPlan(request({ strategies: ['app-memory-lock'], appInstances: [1, 2], reps: 1 }));
    assert.deepEqual(
      plan.map((p) => p.appInstances),
      [1, 2],
    );
  });

  it('k6DurationMs·renderDiscardSql', () => {
    assert.equal(k6DurationMs('1m30s'), 90_000);
    assert.equal(k6DurationMs('500ms'), 500);
    assert.equal(k6DurationMs('0s'), 0);
    assert.throws(() => k6DurationMs('10x'));
    assert.equal(renderDiscardSql('delete from t where id > {{products}} ', { products: 5 }), 'delete from t where id > 5');
    assert.throws(() => renderDiscardSql('x {{missing}}', {}));
    assert.throws(() => renderDiscardSql('x {{p}}', { p: '1; drop table t' }));
  });
});
