import { z } from 'zod';

/**
 * C1 RunConfig 전달 · C5 앱 Prometheus 지표 이름 · C6 계측 수준 스위치 값.
 * 정본: docs/CONTRACTS-phase1.md. 이 파일과 문서가 다르면 둘을 같이 고친다.
 */

// ─────────────────────────────── C6 계측 수준 ───────────────────────────────

/** 계측 수준. 순서가 곧 포함 관계(off ⊂ metrics ⊂ full). */
export const INSTRUMENTATION_LEVEL_VALUES = ['off', 'metrics', 'full'] as const;
export const InstrumentationLevelSchema = z.enum(INSTRUMENTATION_LEVEL_VALUES);
export type InstrumentationLevel = z.infer<typeof InstrumentationLevelSchema>;

export interface InstrumentationLevelSpec {
  /** 켜지는 지표의 최고 수준. METRICS 의 level 이 이 값 이하인 지표만 켠다(off = RED + 주입 카운터 + info). */
  readonly metricsUpTo: InstrumentationLevel;
  /** OTel. off·metrics 는 SDK 를 시작하지 않는다. */
  readonly otel:
    | { readonly enabled: false }
    | { readonly enabled: true; readonly sampler: 'parentbased'; readonly representativeFlag: '01'; readonly rootSampleRatio: number };
  /** 이벤트: 끔 | agg 만 | 대표 전체 + agg */
  readonly events: 'off' | 'agg' | 'representative+agg';
  /** SQL 샘플: 끔 | 대표 요청만 */
  readonly sqlSample: 'off' | 'representative';
  readonly ormQueryLogger: boolean;
  /** PG 프로브 기본 주기(ms). null = 끔. RunRequest.pgProbe 로 따로 켜고 끌 수 있다. */
  readonly pgProbeIntervalMs: number | null;
}

/** C6 표 그대로. */
export const INSTRUMENTATION_LEVELS: Readonly<Record<InstrumentationLevel, InstrumentationLevelSpec>> = Object.freeze({
  off: {
    metricsUpTo: 'off',
    otel: { enabled: false },
    events: 'off',
    sqlSample: 'off',
    ormQueryLogger: false,
    pgProbeIntervalMs: null,
  },
  metrics: {
    metricsUpTo: 'metrics',
    otel: { enabled: false },
    events: 'agg',
    sqlSample: 'off',
    ormQueryLogger: false,
    pgProbeIntervalMs: 5000,
  },
  full: {
    metricsUpTo: 'full',
    otel: { enabled: true, sampler: 'parentbased', representativeFlag: '01', rootSampleRatio: 0.1 },
    events: 'representative+agg',
    sqlSample: 'representative',
    ormQueryLogger: true,
    pgProbeIntervalMs: 1000,
  },
});

/** RunRequest.pgProbe 를 생략했을 때의 값(C6 「PG 프로브 기본」 열). */
export function defaultPgProbe(level: InstrumentationLevel): { enabled: boolean; intervalMs: number | null } {
  const ms = INSTRUMENTATION_LEVELS[level].pgProbeIntervalMs;
  return { enabled: ms !== null, intervalMs: ms };
}

// ─────────────────────────────── C5 지표 이름 ───────────────────────────────

/** app 이 부팅할 때 붙이는 기본 라벨. `instance` 는 스크레이프 대상에서 온다. */
export const METRIC_DEFAULT_LABELS = ['run_id', 'scenario', 'strategy', 'instrumentation'] as const;

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricSpec {
  readonly name: string;
  readonly type: MetricType;
  readonly labels: readonly string[];
  /** 라벨 값이 문서에 고정된 경우만. */
  readonly labelValues?: Readonly<Record<string, readonly string[]>>;
  /** 켜지는 최저 계측 수준. 'always' = 오케스트레이터 지표(계측 수준과 무관). */
  readonly level: InstrumentationLevel | 'always';
  readonly component: 'app' | 'orchestrator';
  /** prom-client collectDefaultMetrics 가 내는 지표. */
  readonly promClientDefault?: true;
}

const app = (
  name: string,
  type: MetricType,
  level: InstrumentationLevel,
  labels: readonly string[] = [],
  labelValues?: Record<string, readonly string[]>,
): MetricSpec => ({ name, type, labels, level, component: 'app', ...(labelValues ? { labelValues } : {}) });
const promDefault = (name: string, type: MetricType, labels: readonly string[] = []): MetricSpec => ({
  name,
  type,
  labels,
  level: 'metrics',
  component: 'app',
  promClientDefault: true,
});
const orch = (name: string, type: MetricType, labels: readonly string[] = []): MetricSpec => ({
  name,
  type,
  labels,
  level: 'always',
  component: 'orchestrator',
});

/** `lab_http_request_duration_seconds` 버킷 범위(초). 1ms–10s. 개별 경계는 C5 가 고정하지 않는다. */
export const HTTP_DURATION_BUCKET_RANGE_SECONDS = [0.001, 10] as const;

/** C5 표 전체(문서 순서). */
export const METRICS: readonly MetricSpec[] = Object.freeze([
  app('lab_http_request_duration_seconds', 'histogram', 'off', ['method', 'route', 'status']),
  app('lab_http_requests_in_flight', 'gauge', 'off', ['route']),
  promDefault('nodejs_eventloop_lag_p50_seconds', 'gauge'),
  promDefault('nodejs_eventloop_lag_p99_seconds', 'gauge'),
  promDefault('nodejs_gc_duration_seconds', 'histogram', ['kind']),
  promDefault('nodejs_heap_size_used_bytes', 'gauge'),
  promDefault('nodejs_heap_size_total_bytes', 'gauge'),
  promDefault('process_resident_memory_bytes', 'gauge'),
  promDefault('nodejs_external_memory_bytes', 'gauge'),
  promDefault('process_cpu_seconds_total', 'counter'),
  app('lab_eventloop_utilization', 'gauge', 'metrics'),
  app('lab_uv_threadpool_size', 'gauge', 'metrics'),
  app('lab_db_pool_connections', 'gauge', 'metrics', ['state'], { state: ['total', 'idle', 'waiting'] }),
  app('lab_db_pool_acquire_duration_seconds', 'histogram', 'metrics'),
  app('lab_db_pool_acquire_timeouts_total', 'counter', 'metrics'),
  app('lab_orm_flush_duration_seconds', 'histogram', 'metrics'),
  app('lab_orm_flush_changesets', 'histogram', 'metrics'),
  app('lab_orm_transactions_total', 'counter', 'metrics', ['result'], { result: ['commit', 'rollback'] }),
  app('lab_orm_transaction_duration_seconds', 'histogram', 'metrics', ['result'], { result: ['commit', 'rollback'] }),
  app('lab_orm_query_duration_seconds', 'histogram', 'full', ['type'], {
    type: ['select', 'insert', 'update', 'delete', 'other'],
  }),
  app('lab_orm_identity_map_size', 'histogram', 'full'),
  app('lab_events_emitted_total', 'counter', 'metrics', ['kind']),
  app('lab_events_dropped_total', 'counter', 'metrics'),
  app('lab_events_batches_failed_total', 'counter', 'metrics'),
  app('lab_injected_delay_total', 'counter', 'off', ['point']),
  app('lab_injected_delay_seconds_total', 'counter', 'off', ['point']),
  app('lab_instrumentation_info', 'gauge', 'off', ['level']),
  orch('lab_orch_ingest_events_total', 'counter'),
  orch('lab_orch_ingest_rejected_total', 'counter', ['reason']),
  orch('lab_orch_ws_clients', 'gauge'),
]);

/** C5 의 지표 이름 전체(문서 순서). 히스토그램의 `_bucket`/`_sum`/`_count` 접미사는 포함하지 않는다. */
export const METRIC_NAMES: readonly string[] = Object.freeze(METRICS.map((m) => m.name));

/** Grafana 주석 태그(C5 「그 밖의 고정값」). `run:<runId>`, `batch:<batchId>`, `phase:<…>` 와 함께 쓴다. */
export const GRAFANA_ANNOTATION_TAG = 'nul';
export const GRAFANA_ANNOTATION_PHASES = ['reset', 'warmup', 'main', 'invariants'] as const;
export const DASHBOARD_UIDS = ['nul-run-overview', 'nul-red', 'nul-use-app', 'nul-use-pg', 'nul-loadgen'] as const;
/** 대시보드 변수 이름. 시간 범위는 from/to. */
export const DASHBOARD_RUN_VAR = 'run_id';

// ─────────────────────────────── C1 RunConfig ───────────────────────────────

export const RUN_CONFIG_TASKS = ['serve', 'prepare-template'] as const;

export const InjectDelaySchema = z.object({ point: z.string().min(1), ms: z.number().int().min(0) });
export type InjectDelay = z.infer<typeof InjectDelaySchema>;

const msOrNull = z.number().int().min(0).nullable();
const record = z.record(z.string(), z.unknown());

export const RunConfigEventsSchema = z.object({
  endpoint: z.string().min(1),
  representativeActors: z.number().int().min(0),
  flushMs: z.number().int().min(1),
  batchMax: z.number().int().min(1),
  bufferMax: z.number().int().min(1),
});

export const RunConfigTracingSchema = z.object({
  endpoint: z.string().min(1),
  rootSampleRatio: z.number().min(0).max(1),
});

/**
 * RunConfig v1. 오케스트레이터가 게시하고 app 이 부팅할 때 받는다.
 * null 의 뜻: `pool.acquireTimeoutMs`·`timeouts.*` = 적용하지 않음, `events`·`tracing` = 보내지 않음,
 * `redis` = 시나리오가 안 씀. 0단계 파일을 올릴 때 이 null 들로 채운다(0단계 동작 보존).
 */
export const RunConfigV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    task: z.enum(RUN_CONFIG_TASKS),
    runId: z.string().min(1),
    batchId: z.string().min(1),
    repetition: z.number().int().min(1),
    scenario: z.string().min(1),
    strategy: z.string().min(1),
    strategyParams: record,
    instrumentation: InstrumentationLevelSchema,
    injectDelay: z.array(InjectDelaySchema),
    pool: z.object({
      min: z.number().int().min(0),
      max: z.number().int().min(1),
      acquireTimeoutMs: msOrNull,
    }),
    timeouts: z.object({
      serverRequestMs: msOrNull,
      statementMs: msOrNull,
      idleInTxMs: msOrNull,
    }),
    events: RunConfigEventsSchema.nullable(),
    tracing: RunConfigTracingSchema.nullable(),
    redis: z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535) }).nullable(),
    prepareTemplate: z.object({ database: z.string().min(1), seedOptions: record }).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.task === 'prepare-template' && !c.prepareTemplate) {
      ctx.addIssue({ code: 'custom', path: ['prepareTemplate'], message: 'task=prepare-template 이면 prepareTemplate 이 필요하다' });
    }
    if (c.task === 'serve' && c.prepareTemplate !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['prepareTemplate'], message: 'prepareTemplate 은 task=prepare-template 일 때만 쓴다' });
    }
    if (c.pool.min > c.pool.max) {
      ctx.addIssue({ code: 'custom', path: ['pool', 'min'], message: 'pool.min 이 pool.max 보다 크다' });
    }
  });
export type RunConfigV1 = z.infer<typeof RunConfigV1Schema>;
/** 1단계 이후 코드가 다루는 RunConfig 는 항상 v1 이다. */
export type RunConfig = RunConfigV1;

/** 0단계 파일(`scripts/run.mjs` 가 쓰는 run-config.json, `schemaVersion` 없음). apps/app/src/config/run-config.ts 와 같은 규칙. */
export const RunConfigV0Schema = z.object({
  runId: z.string().min(1),
  batchId: z.string().min(1),
  repetition: z.number().int().min(1),
  scenario: z.string().min(1),
  strategy: z.string().min(1),
  strategyParams: record.default({}),
  instrumentation: InstrumentationLevelSchema.default('off'),
  injectDelay: z.array(InjectDelaySchema).default([]),
  pool: z
    .object({
      min: z.number().int().min(0).default(2),
      max: z.number().int().min(1).default(10),
    })
    .default({ min: 2, max: 10 }),
});
export type RunConfigV0 = z.infer<typeof RunConfigV0Schema>;

/** 0단계 → v1. 0단계에 없던 값은 null(적용 안 함), task 는 serve. */
export function upgradeRunConfigV0(v0: RunConfigV0): RunConfigV1 {
  return {
    schemaVersion: 1,
    task: 'serve',
    runId: v0.runId,
    batchId: v0.batchId,
    repetition: v0.repetition,
    scenario: v0.scenario,
    strategy: v0.strategy,
    strategyParams: v0.strategyParams,
    instrumentation: v0.instrumentation,
    injectDelay: v0.injectDelay,
    pool: { min: v0.pool.min, max: v0.pool.max, acquireTimeoutMs: null },
    timeouts: { serverRequestMs: null, statementMs: null, idleInTxMs: null },
    events: null,
    tracing: null,
    redis: null,
  };
}

const hasSchemaVersion = (raw: unknown): boolean =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'schemaVersion' in raw;

/**
 * RunConfig 를 받아 v1 로 돌려준다. `schemaVersion` 키가 없으면 0단계 파일로 보고 기본값으로 채운다.
 * `schemaVersion` 이 있는데 1 이 아니면 실패. 실패하면 ZodError 를 던진다.
 */
export function parseRunConfig(raw: unknown): RunConfigV1 {
  if (hasSchemaVersion(raw)) return RunConfigV1Schema.parse(raw);
  return upgradeRunConfigV0(RunConfigV0Schema.parse(raw));
}

/** `GET /_lab/ready` 응답. task=prepare-template 이면 마이그레이션과 시드가 끝난 뒤 200 과 prepared 를 싣는다. */
export const ReadyResponseSchema = z.object({
  instance: z.string().min(1),
  runId: z.string().min(1),
  task: z.enum(RUN_CONFIG_TASKS),
  scenario: z.string().min(1),
  strategy: z.string().min(1),
  instrumentation: InstrumentationLevelSchema,
  /** ISO 8601 */
  bootedAt: z.string().min(1),
  prepared: z.object({ database: z.string().min(1), durationMs: z.number().min(0) }).optional(),
});
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;

/** C1 전달 방식의 고정값. */
export const RUN_CONFIG_FETCH = Object.freeze({
  path: '/internal/run-config',
  /** 쿼리 `instance=<INSTANCE_NAME>` */
  instanceQuery: 'instance',
  retryIntervalMs: 1000,
  maxAttempts: 30,
  /** 204 = 대기 모드(`/_lab` 만 응답) */
  standbyStatus: 204,
  envUrl: 'ORCHESTRATOR_URL',
  envFile: 'RUN_CONFIG_PATH',
  defaultUrl: 'http://orchestrator:4001',
});
