// RunEngine(C8): 세션(요청 1건)의 수명주기 상태기계. scripts/run.mjs runSession 을 포트 위로 옮긴 것이다.
//
// 세션: 계획 생성 → 템플릿 DB 확인(없으면 prepare-template RunConfig 게시 → app 1대 restart → ready.prepared 확인 → is_template)
// 실행마다: app 정지 → 실행 DB 리셋 → RunConfig 게시 → app N대 start → readiness(runId 일치)
//          → 웜업(별도 k6 job) → discardSql → 본 실행 → 불변식 → 수집·메타데이터
// 중단·실패해도 그 실행의 메타데이터는 저장하고, 남은 실행은 돌리지 않는다.
// 의존 모듈은 전부 생성자 인자로 받은 포트로만 쓴다. 시간·대기는 Clock.
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { defaultPgProbe, INSTRUMENTATION_LEVELS } from '@under-load/contracts';
import type {
  InvariantResult,
  K6JobRequest,
  K6JobStatus,
  ReadyResponse,
  RunConfigV1,
  RunMetadata,
  RunRequest,
  RunRow,
  RunsAccepted,
  SessionResponse,
} from '@under-load/contracts';

import type {
  CallOptions,
  Clock,
  ContainerInfo,
  DbAdmin,
  DockerControl,
  DockerInfo,
  EventHub,
  InvariantRunner,
  K6Runner,
  K6Summary,
  Measured,
  MetadataStore,
  ObsClient,
  ProbeSource,
  ReadyProbe,
  RunConfigBoard,
  RunEngine,
  ScenarioCatalog,
  ScenarioDef,
  StartResult,
  ValidityVerdict,
} from '../ports.js';
import {
  buildPlan,
  k6DurationMs,
  makeBatchId,
  makeRunId,
  mergedSeedOptions,
  renderDiscardSql,
  stamp,
  strategyParams,
  validateRequest,
} from './plan.js';
import type { PlanItem } from './plan.js';

// ───────────────────────────── 단계 이름 ─────────────────────────────

/** 실행 1회의 단계 기록 이름(메타데이터 steps·`/runs/:id` steps·WS status.step). 순서도 이대로다. */
export const RUN_STEPS = Object.freeze({
  stopApps: 'app 정지',
  resetDb: '실행 DB 리셋',
  publishConfig: 'RunConfig 게시',
  startApps: 'app 시작 + readiness',
  warmup: 'k6 웜업',
  discardWarmup: '웜업 흔적 제거',
  main: 'k6 본 실행',
  invariants: '불변식 검사',
  collect: '수집·메타데이터 저장',
} as const);

// ───────────────────────────── 메타데이터 입력 ─────────────────────────────

/** 세션 시작 때 한 번 모으는 환경 사실(메타데이터 images·limits·host·postgres). 못 모은 값은 null. */
export type SessionFacts = {
  docker: DockerInfo | null;
  /** compose 서비스 이름 → 컨테이너(정지 포함). 조회 실패면 빈 배열 */
  containers: Record<string, ContainerInfo[]>;
  pgConfig: { hash: string; settings: Record<string, string> } | null;
};

/**
 * 메타데이터 조립기(T-107 buildMetadata)에 넘기는 입력. 엔진이 포트로 모은 값만 담는다.
 * git·호스트 OS·스택 프로필처럼 포트 밖의 값은 조립기(배선)가 채운다.
 */
export type RunMetadataInput = {
  sessionId: string;
  batchId: string;
  runId: string;
  repetition: number;
  request: RunRequest;
  scenario: ScenarioDef;
  strategy: { id: string; params: Record<string, unknown> };
  appInstances: number;
  /** 이 실행의 최종 상태(running 은 오지 않는다) */
  status: Exclude<RunRow['status'], 'running'>;
  /** 실패·중단 사유. done 이면 null */
  error: string | null;
  templateDb: string;
  seedOptions: Record<string, unknown>;
  /** 게시한 RunConfig(게시 전에 실패했으면 null) */
  runConfig: RunConfigV1 | null;
  pgProbe: { enabled: boolean; intervalMs: number | null };
  facts: SessionFacts;
  k6: {
    scriptHash: string | null;
    env: Record<string, string> | null;
    warmup: K6JobStatus | null;
    main: K6JobStatus | null;
    summary: K6Summary | null;
  };
  validity: ValidityVerdict;
  scrapeGaps: Measured<{ gaps: number; details?: Record<string, unknown> }> | null;
  invariants: InvariantResult[];
  steps: { name: string; at: string }[];
  /** 레포 기준 상대 경로(`runs/<runId>/…`). 만들지 못한 것은 null */
  artifacts: {
    runConfig: string | null;
    k6Summary: string | null;
    k6Html: string | null;
    events: string | null;
    agg: string | null;
    probe: string | null;
    promSnapshot: string | null;
    metadata: string;
  };
  startedAt: string;
  endedAt: string;
};

/** RunMetadataInput → RunMetadata v1. T-107 의 buildMetadata 를 배선(T-138)이 이 모양으로 감싸 넘긴다. */
export type MetadataBuilder = (input: RunMetadataInput) => RunMetadata;

// ───────────────────────────── 생성 인자 ─────────────────────────────

/** RunConfig 의 실행 무관 값(C1). */
export type RunConfigDefaults = {
  pool: RunConfigV1['pool'];
  timeouts: RunConfigV1['timeouts'];
  /** 계측 수준이 off 가 아니면 이 값으로 events 를 채운다 */
  events: NonNullable<RunConfigV1['events']>;
  /** OTel 이 켜지는 수준(full)에서 쓰는 수신 주소 */
  tracingEndpoint: string;
  redis: RunConfigV1['redis'];
};

export const DEFAULT_RUN_CONFIG: RunConfigDefaults = Object.freeze({
  // run.mjs buildRunConfig 와 같은 풀 크기. 0단계에 없던 값은 null(적용 안 함).
  pool: { min: 2, max: 10, acquireTimeoutMs: null },
  timeouts: { serverRequestMs: null, statementMs: null, idleInTxMs: null },
  events: { endpoint: 'http://orchestrator:4001/ingest/events', representativeActors: 8, flushMs: 100, batchMax: 500, bufferMax: 10000 },
  tracingEndpoint: 'http://tempo:4318/v1/traces',
  redis: null,
});

export type RunEngineOptions = {
  /** 오케스트레이터에서 본 runs 디렉터리(summary.json 읽기·events·probe·prom.json 쓰기) */
  runsDir: string;
  /** k6 컨테이너에서 본 runs 디렉터리. 기본 `/runs` */
  k6RunsDir?: string;
  /** app compose 서비스 이름. 기본 `app` */
  appService?: string;
  /** 메타데이터 images·limits 용으로 조회할 서비스. 기본 app·nginx·postgres·k6·redis */
  factServices?: readonly string[];
  /** 실행 readiness 제한. 기본 90초(run.mjs) */
  readyTimeoutMs?: number;
  /** 템플릿 준비(마이그레이션+시드) readiness 제한. 기본 5분 */
  prepareTimeoutMs?: number;
  /** readiness 조회 간격. 기본 500ms(run.mjs) */
  readyPollMs?: number;
  /** k6 job 상태 조회 간격. 기본 K6Runner 기본값 */
  k6PollMs?: number;
  /** k6 Prometheus remote-write(obs 프로필이 있을 때 켠다). 기본 false */
  prometheusRw?: boolean;
  runConfig?: Partial<RunConfigDefaults>;
};

export type RunEngineDeps = {
  clock: Clock;
  docker: DockerControl;
  db: DbAdmin;
  invariants: InvariantRunner;
  k6: K6Runner;
  store: MetadataStore;
  board: RunConfigBoard;
  hub: EventHub;
  probe: ProbeSource;
  obs: ObsClient;
  catalog: ScenarioCatalog;
  ready: ReadyProbe;
  buildMetadata: MetadataBuilder;
  options: RunEngineOptions;
  /** 진행 로그(기본: 버림) */
  log?: (message: string) => void;
  /** 세션 id 뒤에 붙는 짧은 난수(테스트 고정용). 기본 4자리 hex */
  randomSuffix?: () => string;
};

// ───────────────────────────── 내부 상태 ─────────────────────────────

type PlannedRun = PlanItem & { batchId: string; runId: string };

type Session = {
  sessionId: string;
  request: RunRequest;
  scenario: ScenarioDef;
  plan: PlannedRun[];
  state: SessionResponse['state'];
  startedAt: string | null;
  endedAt: string | null;
  current: { runId: string; step: string } | null;
  done: number;
  controller: AbortController;
  /** 세션이 끝나면(성공·실패·중단 무관) resolve */
  finished: Promise<void>;
  settle: () => void;
};

type RunOutcome = Exclude<RunRow['status'], 'running'>;

const DEFAULT_FACT_SERVICES = ['app', 'nginx', 'postgres', 'k6', 'redis'] as const;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function invalidVerdict(reasons: string[]): ValidityVerdict {
  return { valid: false, reasons, k6CpuAvgRatio: null, droppedCountedAsFailure: null, failuresTotal: 0, k6Cpu: null };
}

/** 레포 기준 아티팩트 경로(run.mjs 와 같은 `runs/<runId>/<name>`). */
const artifact = (runId: string, name: string) => `runs/${runId}/${name}`;

export function createRunEngine(deps: RunEngineDeps): RunEngine {
  return new LifecycleEngine(deps);
}

class LifecycleEngine implements RunEngine {
  private readonly d: RunEngineDeps;
  private readonly runConfigDefaults: RunConfigDefaults;
  private active: Session | null = null;

  constructor(deps: RunEngineDeps) {
    this.d = deps;
    this.runConfigDefaults = { ...DEFAULT_RUN_CONFIG, ...deps.options.runConfig };
  }

  // ───────────── 공개 메서드 ─────────────

  async start(request: RunRequest): Promise<StartResult> {
    // busy 판정과 자리 차지는 await 전에 동기로 한다(동시 start 경쟁 방지).
    if (this.active) return { kind: 'busy', sessionId: this.active.sessionId };
    const scenario = this.d.catalog.get(request.scenario);
    const errors = validateRequest(request, scenario);
    if (errors.length > 0 || !scenario) return { kind: 'invalid', errors };

    const now = this.d.clock.now();
    const sessionStamp = stamp(now);
    const suffix = this.d.randomSuffix?.() ?? randomBytes(2).toString('hex');
    const sessionId = `${sessionStamp}_${suffix}`;
    const plan: PlannedRun[] = buildPlan(request, scenario.minAppInstances).map((p) => {
      const batchId = makeBatchId(sessionStamp, request.scenario, p.strategy, p.appInstances);
      return { ...p, batchId, runId: makeRunId(batchId, p.repetition) };
    });

    let settle: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const session: Session = {
      sessionId,
      request,
      scenario,
      plan,
      state: 'queued',
      startedAt: null,
      endedAt: null,
      current: null,
      done: 0,
      controller: new AbortController(),
      finished,
      settle,
    };
    this.active = session;

    const batches: RunsAccepted['batches'] = [];
    for (const p of plan) {
      const b = batches.find((x) => x.batchId === p.batchId);
      if (b) b.runIds.push(p.runId);
      else batches.push({ batchId: p.batchId, strategy: p.strategy, appInstances: p.appInstances, runIds: [p.runId] });
    }

    try {
      await this.d.store.createSession({ sessionId, request, state: 'queued', startedAt: null, endedAt: null });
      for (const b of batches) {
        await this.d.store.createBatch({
          batchId: b.batchId,
          sessionId,
          scenario: request.scenario,
          strategy: b.strategy,
          appInstances: b.appInstances,
          loadModel: request.load.model,
          reps: request.reps,
        });
      }
    } catch (e) {
      this.active = null;
      session.settle();
      throw e;
    }

    void this.runSession(session);
    return { kind: 'accepted', accepted: { sessionId, batches } };
  }

  async abort(runId: string): Promise<boolean> {
    const s = this.active;
    if (!s || !s.plan.some((p) => p.runId === runId)) return false;
    this.log(`[${s.sessionId}] 중단 요청(${runId})`);
    s.controller.abort();
    return true;
  }

  async status(sessionId: string): Promise<SessionResponse | null> {
    const s = this.active;
    if (s && s.sessionId === sessionId) {
      return {
        sessionId,
        state: s.state,
        request: s.request,
        current: s.current,
        batches: await this.d.store.getSessionBatches(sessionId),
        startedAt: s.startedAt,
        endedAt: s.endedAt,
      };
    }
    const rec = await this.d.store.getSession(sessionId);
    if (!rec) return null;
    return {
      sessionId,
      state: rec.state,
      request: rec.request,
      current: null,
      batches: await this.d.store.getSessionBatches(sessionId),
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
    };
  }

  currentRunId(): string | null {
    return this.active?.current?.runId ?? null;
  }

  async idle(): Promise<void> {
    await this.active?.finished;
  }

  // ───────────── 세션 ─────────────

  private async runSession(s: Session): Promise<void> {
    // start() 가 먼저 돌아가도록 한 틱 미룬다.
    await Promise.resolve();
    const signal = s.controller.signal;
    let final: RunOutcome = 'done';
    try {
      s.state = 'running';
      s.startedAt = this.d.clock.nowIso();
      await this.d.store.updateSession(s.sessionId, { state: 'running', startedAt: s.startedAt });
      this.log(`[${s.sessionId}] ${s.plan.length}회 실행`);

      const facts = await this.collectFacts();
      const seedOptions = mergedSeedOptions(s.request, s.scenario);
      const templateDb = await this.ensureTemplate(s, seedOptions, signal);

      for (const item of s.plan) {
        if (signal.aborted) {
          final = 'aborted';
          break;
        }
        const outcome = await this.runOne(s, item, { templateDb, seedOptions, facts });
        s.done++;
        if (outcome !== 'done') {
          final = outcome;
          break;
        }
      }
    } catch (e) {
      final = signal.aborted ? 'aborted' : 'failed';
      this.log(`[${s.sessionId}] 세션 ${final}: ${errorMessage(e)}`);
    } finally {
      this.d.board.clear();
      s.state = final;
      s.current = null;
      s.endedAt = this.d.clock.nowIso();
      try {
        await this.d.store.updateSession(s.sessionId, { state: final, endedAt: s.endedAt });
      } catch (e) {
        this.log(`[${s.sessionId}] 세션 상태 저장 실패: ${errorMessage(e)}`);
      }
      this.active = null;
      s.settle();
    }
  }

  /** 메타데이터용 환경 사실. 하나가 실패해도 나머지는 모은다. */
  private async collectFacts(): Promise<SessionFacts> {
    const facts: SessionFacts = { docker: null, containers: {}, pgConfig: null };
    try {
      facts.docker = await this.d.docker.info();
    } catch (e) {
      this.log(`docker info 실패: ${errorMessage(e)}`);
    }
    for (const svc of this.d.options.factServices ?? DEFAULT_FACT_SERVICES) {
      try {
        facts.containers[svc] = await this.d.docker.list(svc);
      } catch (e) {
        facts.containers[svc] = [];
        this.log(`docker list ${svc} 실패: ${errorMessage(e)}`);
      }
    }
    try {
      facts.pgConfig = await this.d.db.configHash();
    } catch (e) {
      this.log(`pg_settings 해시 실패: ${errorMessage(e)}`);
    }
    return facts;
  }

  /** 템플릿 DB 가 없으면 app 1대를 prepare-template 모드로 재시작해 만들고 is_template 로 표시한다. */
  private async ensureTemplate(s: Session, seedOptions: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const data = { ...s.request.data, seedOptions };
    const name = this.d.db.templateName(s.request.scenario, data);
    const st = await this.d.db.templateStatus(name);
    if (st.exists && st.isTemplate) {
      this.log(`템플릿 DB ${name}: 이미 있음 → 재사용`);
      return name;
    }
    // exists && !isTemplate 는 이전 준비가 중간에 끊긴 흔적이다. app 의 prepare-template 이 다시 만든다.
    this.log(`템플릿 DB ${name}: 준비(app prepare-template)`);
    const prepRunId = `${s.sessionId}_prepare`;
    const strategy = s.request.strategies[0]!;
    this.d.board.publish({
      ...this.baseConfig(s.request, strategy, strategyParams(s.request, s.scenario, strategy)),
      task: 'prepare-template',
      runId: prepRunId,
      batchId: prepRunId,
      repetition: 1,
      prepareTemplate: { database: name, seedOptions },
    });
    const apps = await this.appContainers();
    if (apps.length === 0) throw new Error('app 컨테이너가 없다');
    const [first, ...rest] = apps;
    for (const c of rest) await this.d.docker.stop(c.name);
    await this.d.docker.restart(first!.name);
    await this.waitReady(
      [first!.name],
      (r) => r.runId === prepRunId && r.task === 'prepare-template' && r.prepared?.database === name,
      this.d.options.prepareTimeoutMs ?? 300_000,
      signal,
    );
    await this.d.db.markTemplate(name);
    return name;
  }

  // ───────────── 실행 1회 ─────────────

  private async runOne(
    s: Session,
    item: PlannedRun,
    env: { templateDb: string; seedOptions: Record<string, unknown>; facts: SessionFacts },
  ): Promise<RunOutcome> {
    const { clock, docker, db, k6, store, board, hub, probe, obs } = this.d;
    const signal = s.controller.signal;
    const { request, scenario, sessionId } = s;
    const { runId, batchId, repetition, appInstances } = item;
    const runDir = path.join(this.d.options.runsDir, runId);
    const k6RunDir = path.posix.join(this.d.options.k6RunsDir ?? '/runs', runId);
    const params = strategyParams(request, scenario, item.strategy);
    const pgProbe = request.pgProbe ?? defaultPgProbe(request.instrumentation);
    const startedAt = clock.nowIso();
    const steps: { name: string; at: string }[] = [];

    let outcome: RunOutcome = 'done';
    let error: string | null = null;
    let runConfig: RunConfigV1 | null = null;
    let scriptHash: string | null = null;
    let mainEnv: Record<string, string> | null = null;
    let warmupStatus: K6JobStatus | null = null;
    let mainStatus: K6JobStatus | null = null;
    let summary: K6Summary | null = null;
    let validity: ValidityVerdict | null = null;
    let scrapeGaps: RunMetadataInput['scrapeGaps'] = null;
    let invariants: InvariantResult[] = [];
    let hubBegun = false;
    let probeStarted = false;
    let probeUsed = false;
    let promSnapshot: string | null = null;

    await store.insertRun({
      runId,
      batchId,
      sessionId,
      repetition,
      scenario: request.scenario,
      strategy: item.strategy,
      appInstances,
      model: request.load.model,
      instrumentation: request.instrumentation,
      status: 'running',
      valid: null,
      invariantsPassed: null,
      violationsTotal: null,
      startedAt,
      endedAt: null,
    });
    s.current = { runId, step: '' };

    const record = async (name: string) => {
      const at = clock.nowIso();
      steps.push({ name, at });
      s.current = { runId, step: name };
      this.log(`[${runId}] ${name}`);
      try {
        await store.addStep(runId, { name, at });
      } catch (e) {
        this.log(`[${runId}] 단계 기록 실패: ${errorMessage(e)}`);
      }
      hub.publish({
        type: 'status',
        runId,
        at: clock.now(),
        data: { sessionId, step: name, state: s.state, repetition, progress: { done: s.done, total: s.plan.length } },
      });
    };
    const step = async (name: string) => {
      signal.throwIfAborted();
      await record(name);
    };
    const annotate = async (phase: 'reset' | 'warmup' | 'main' | 'invariants', text: string, timeMs: number, timeEndMs?: number) => {
      try {
        await obs.annotate({ runId, batchId, phase, text, timeMs, ...(timeEndMs !== undefined ? { timeEndMs } : {}) });
      } catch (e) {
        this.log(`[${runId}] 주석 실패: ${errorMessage(e)}`);
      }
    };

    let mainFrom = 0;
    let mainTo = 0;
    try {
      await hub.beginRun({ runId, batchId, sessionId, dir: runDir });
      hubBegun = true;

      // 1) 초기화: app 정지 → 실행 DB 리셋
      await step(RUN_STEPS.stopApps);
      const apps = await this.appContainers();
      for (const c of apps) await docker.stop(c.name);

      await step(RUN_STEPS.resetDb);
      await annotate('reset', `reset ${env.templateDb}`, clock.now());
      await db.resetRunDb(env.templateDb);

      // 2) RunConfig 게시 → app N대 시작 → readiness
      await step(RUN_STEPS.publishConfig);
      runConfig = { ...this.baseConfig(request, item.strategy, params), task: 'serve', runId, batchId, repetition };
      board.publish(runConfig);

      await step(RUN_STEPS.startApps);
      if (apps.length < appInstances) throw new Error(`app 컨테이너가 ${appInstances}대 필요한데 ${apps.length}대뿐이다`);
      const active = apps.slice(0, appInstances);
      for (const c of active) await docker.start(c.name);
      await this.waitReady(
        active.map((c) => c.name),
        (r) => r.runId === runId && r.task === 'serve',
        this.d.options.readyTimeoutMs ?? 90_000,
        signal,
      );

      // 3) 웜업(별도 job, 결과 버림) → 웜업 데이터 폐기
      if (k6DurationMs(request.load.warmup) > 0) {
        await step(RUN_STEPS.warmup);
        const summaryPath = path.posix.join(k6RunDir, 'warmup-summary.json');
        const wenv = k6.buildEnv({ scenario, request, runId, phase: 'warmup', strategy: item.strategy, summaryPath });
        const from = clock.now();
        warmupStatus = await this.runJob(this.job(runId, 'warmup', scenario, wenv, null, summaryPath), signal);
        await annotate('warmup', `warmup ${request.load.warmup}`, from, clock.now());
        if (scenario.discardSql) {
          await step(RUN_STEPS.discardWarmup);
          await db.execInRunDb(renderDiscardSql(scenario.discardSql, env.seedOptions));
        }
      }

      // 4) 본 실행(PG 프로브는 이 구간만)
      await step(RUN_STEPS.main);
      const summaryPath = path.posix.join(k6RunDir, 'summary.json');
      mainEnv = k6.buildEnv({ scenario, request, runId, phase: 'main', strategy: item.strategy, summaryPath });
      scriptHash = await k6.scriptHash(scenario, mainEnv);
      if (pgProbe.enabled && pgProbe.intervalMs !== null) {
        await probe.start({
          runId,
          intervalMs: pgProbe.intervalMs,
          outFile: path.join(runDir, 'probe.ndjson'),
          onSample: (data) => hub.publish({ type: 'probe', runId, at: clock.now(), data }),
        });
        probeStarted = true;
        probeUsed = true;
      }
      mainFrom = clock.now();
      mainStatus = await this.runJob(
        this.job(runId, 'main', scenario, mainEnv, path.posix.join(k6RunDir, 'report.html'), summaryPath),
        signal,
      );
      mainTo = clock.now();
      if (probeStarted) {
        probeStarted = false;
        await probe.stop();
      }
      await annotate('main', `main ${request.load.duration}`, mainFrom, mainTo);

      // 5) 불변식(DB 원장 기준)
      await step(RUN_STEPS.invariants);
      await annotate('invariants', 'invariants', clock.now());
      invariants = await this.d.invariants.run(scenario);
      hub.publish({ type: 'invariants', runId, at: clock.now(), data: invariants });

      // 6) 수집·유효성
      await step(RUN_STEPS.collect);
      try {
        summary = await k6.readSummary(path.join(runDir, 'summary.json'));
      } catch (e) {
        this.log(`[${runId}] summary 읽기 실패: ${errorMessage(e)}`);
      }
      scrapeGaps = await obs.scrapeGaps({ fromMs: mainFrom, toMs: mainTo });
      const snap = await obs.snapshot({ runId, fromMs: mainFrom, toMs: mainTo, outFile: path.join(runDir, 'prom.json') });
      if (snap.status === 'ok') promSnapshot = artifact(runId, 'prom.json');
      validity = summary
        ? k6.judgeValidity({ request, summary, k6: mainStatus, scrapeGaps: scrapeGaps.status === 'ok' ? scrapeGaps.gaps : null })
        : invalidVerdict(['k6 summary 를 읽지 못했다']);
    } catch (e) {
      outcome = signal.aborted ? 'aborted' : 'failed';
      error = outcome === 'aborted' ? '중단됨' : errorMessage(e);
      this.log(`[${runId}] ${outcome}: ${errorMessage(e)}`);
    } finally {
      if (probeStarted) {
        try {
          await probe.stop();
        } catch (e) {
          this.log(`[${runId}] 프로브 정지 실패: ${errorMessage(e)}`);
        }
      }
    }

    if (outcome !== 'done') {
      validity = invalidVerdict([outcome === 'aborted' ? '중단됨' : `실행 실패: ${error}`]);
      // 실패·중단도 메타데이터 저장 단계는 기록한다(중단 신호와 무관하게).
      await record(RUN_STEPS.collect);
    }
    const finalValidity = validity ?? invalidVerdict(['판정 없음']);

    const endedAt = clock.nowIso();
    const critical = invariants.filter((i) => i.severity === 'critical');
    const invariantsPassed = invariants.length === 0 ? null : critical.every((i) => i.passed === true);
    const violationsTotal = invariants.length === 0 ? null : critical.reduce((n, i) => n + (i.violations ?? 0), 0);

    try {
      const metadata = this.d.buildMetadata({
        sessionId,
        batchId,
        runId,
        repetition,
        request,
        scenario,
        strategy: { id: item.strategy, params },
        appInstances,
        status: outcome,
        error,
        templateDb: env.templateDb,
        seedOptions: env.seedOptions,
        runConfig,
        pgProbe,
        facts: env.facts,
        k6: { scriptHash, env: mainEnv, warmup: warmupStatus, main: mainStatus, summary },
        validity: finalValidity,
        scrapeGaps,
        invariants,
        steps: [...steps],
        artifacts: {
          runConfig: runConfig ? artifact(runId, 'run-config.json') : null,
          k6Summary: summary ? artifact(runId, 'summary.json') : null,
          k6Html: mainStatus ? artifact(runId, 'report.html') : null,
          events: hubBegun ? artifact(runId, 'events.ndjson') : null,
          agg: hubBegun ? artifact(runId, 'agg.ndjson') : null,
          probe: probeUsed ? artifact(runId, 'probe.ndjson') : null,
          promSnapshot,
          metadata: artifact(runId, 'metadata.json'),
        },
        startedAt,
        endedAt,
      });
      await store.saveMetadata(runId, metadata);
    } catch (e) {
      this.log(`[${runId}] 메타데이터 저장 실패: ${errorMessage(e)}`);
    }
    try {
      await store.updateRun(runId, { status: outcome, valid: finalValidity.valid, invariantsPassed, violationsTotal, endedAt });
    } catch (e) {
      this.log(`[${runId}] 실행 행 갱신 실패: ${errorMessage(e)}`);
    }
    hub.publish({ type: 'end', runId, at: clock.now(), data: { valid: finalValidity.valid, reasons: finalValidity.reasons } });
    if (hubBegun) {
      try {
        await hub.endRun(runId);
      } catch (e) {
        this.log(`[${runId}] 이벤트 종료 실패: ${errorMessage(e)}`);
      }
    }
    return outcome;
  }

  // ───────────── 보조 ─────────────

  /** RunConfig 의 실행 무관 부분(task·runId·batchId·repetition 은 호출부가 채운다). */
  private baseConfig(request: RunRequest, strategy: string, params: Record<string, unknown>) {
    const d = this.runConfigDefaults;
    const otel = INSTRUMENTATION_LEVELS[request.instrumentation].otel;
    return {
      schemaVersion: 1 as const,
      scenario: request.scenario,
      strategy,
      strategyParams: params,
      instrumentation: request.instrumentation,
      injectDelay: request.injectDelay,
      pool: d.pool,
      timeouts: d.timeouts,
      events: request.instrumentation === 'off' ? null : d.events,
      tracing: otel.enabled ? { endpoint: d.tracingEndpoint, rootSampleRatio: otel.rootSampleRatio } : null,
      redis: d.redis,
    };
  }

  private job(
    runId: string,
    phase: K6JobRequest['phase'],
    scenario: ScenarioDef,
    env: Record<string, string>,
    htmlExport: string | null,
    summaryPath: string,
  ): K6JobRequest {
    return {
      runId,
      phase,
      script: scenario.k6Script,
      env,
      tags: { run_id: runId, phase },
      prometheusRw: this.d.options.prometheusRw ?? false,
      htmlExport,
      summaryPath,
    };
  }

  /** job 제출 → 끝날 때까지 대기. 중단되면 job 을 abort 하고 AbortError 로 빠진다. */
  private async runJob(job: K6JobRequest, signal: AbortSignal): Promise<K6JobStatus> {
    signal.throwIfAborted();
    const { jobId } = await this.d.k6.submit(job);
    const opts: CallOptions & { pollMs?: number } = { signal };
    if (this.d.options.k6PollMs !== undefined) opts.pollMs = this.d.options.k6PollMs;
    let status: K6JobStatus;
    try {
      status = await this.d.k6.waitDone(jobId, opts);
    } catch (e) {
      if (signal.aborted) await this.abortJob(jobId);
      throw e;
    }
    if (signal.aborted) {
      await this.abortJob(jobId);
      signal.throwIfAborted();
    }
    return status;
  }

  private async abortJob(jobId: string): Promise<void> {
    try {
      await this.d.k6.abort(jobId);
    } catch (e) {
      this.log(`k6 job ${jobId} abort 실패: ${errorMessage(e)}`);
    }
  }

  /** app 컨테이너(compose number 오름차순). */
  private async appContainers(): Promise<ContainerInfo[]> {
    const list = await this.d.docker.list(this.d.options.appService ?? 'app');
    return [...list].sort((a, b) => a.number - b.number);
  }

  /** 모든 인스턴스가 조건에 맞는 ready 응답을 줄 때까지 조회한다. 제한 시간을 넘기면 throw. */
  private async waitReady(
    instances: string[],
    ok: (r: ReadyResponse) => boolean,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { clock } = this.d;
    const seen = new Set<string>();
    const deadline = clock.now() + timeoutMs;
    let last = '';
    for (;;) {
      for (const inst of instances) {
        if (seen.has(inst)) continue;
        signal.throwIfAborted();
        let r: ReadyResponse | null = null;
        try {
          r = await this.d.ready(inst, { signal });
        } catch (e) {
          signal.throwIfAborted();
          last = `${inst}: ${errorMessage(e)}`;
        }
        if (r && ok(r)) seen.add(inst);
        else if (r) last = `${inst}: ${JSON.stringify(r)}`;
      }
      if (seen.size === instances.length) return;
      if (clock.now() >= deadline) {
        throw new Error(`readiness 타임아웃(${timeoutMs}ms): ${seen.size}/${instances.length} 인스턴스 준비. 마지막 응답: ${last || '없음'}`);
      }
      await clock.sleep(this.d.options.readyPollMs ?? 500, { signal });
    }
  }

  private log(message: string): void {
    this.d.log?.(message);
  }
}
