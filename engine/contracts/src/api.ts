import { z } from 'zod';

import { AggWindowSchema, PoolStatsSchema, WireEventV0Schema } from './events.js';
import {
  InterventionSchema,
  InvariantResultSchema,
  INVARIANT_SEVERITIES,
  LoadModelSchema,
  RunMetadataAnySchema,
} from './metadata.js';
import { InjectDelaySchema, InstrumentationLevelSchema } from './run-config.js';

/**
 * C2 오케스트레이터 REST/WS · C7 k6 실행기 API.
 * 정본: docs/CONTRACTS-phase1.md.
 */

const bag = z.record(z.string(), z.unknown());
const nonEmpty = z.string().min(1);
const count = z.number().int().min(0);

// ─────────────────────────────── 포트·접근 제한 ───────────────────────────────

export const PUBLIC_PORT = 4000;
export const INTERNAL_PORT = 4001;
/** 공개 포트 Origin 허용 목록(Origin 이 있을 때). 나머지는 403. */
export const ALLOWED_ORIGINS = [
  'http://127.0.0.1:8080',
  'http://127.0.0.1:5173',
  'http://localhost:8080',
  'http://localhost:5173',
] as const;
/** 공개 포트 Host 허용 목록. */
export const ALLOWED_HOSTS = ['127.0.0.1:4000', 'localhost:4000', 'orchestrator:4000'] as const;

// ─────────────────────────────── 비교 조건(§7.3 + D1) ───────────────────────────────

/**
 * blocking 비교 조건 경로(DESIGN §7.3 순서 + D1 `stack.profiles`). `strategy` 는 넣지 않는다.
 * §7.3 의 `proxy` 는 메타데이터에서 `topology.proxy` 이고 `topology` 가 이미 덮으므로 따로 두지 않는다.
 * 경로 아래 값이 다르면 그 잎 경로(예: `load.vus`)를 diff 로 보고한다.
 */
export const COMPARABLE_PATHS = [
  'scenario',
  'profile',
  'limits',
  'topology',
  'pool',
  'postgres.configHash',
  'redis',
  'images',
  'timeouts',
  'data.seedHash',
  'load',
  'instrumentation',
  'pgProbe',
  'interventions',
  'chaos',
  'coldStart',
  'k6Script.hash',
  'stack.profiles',
] as const;
export type ComparablePath = (typeof COMPARABLE_PATHS)[number];

/**
 * strategy 에 딸린 비교 경로. 두 배치의 strategy id 가 다르면 이 경로(와 그 아래)의 차이는 비교 조건에서 제외한다
 * (예: row-lock 의 `timeouts.lockMs=1000` 과 no-lock 의 null). 같은 strategy 끼리는 그대로 blocking.
 */
export const STRATEGY_SCOPED_PATHS = ['strategy.params', 'timeouts.lockMs'] as const;

/** `axis` 로 쓸 수 있는 경로. 지정한 경로(와 그 아래)의 차이만 kind=axis 가 된다. */
export const AXIS_PATHS = ['topology.appInstances', 'instrumentation', 'pgProbe.enabled', 'interventions'] as const;
export const AxisPathSchema = z.enum(AXIS_PATHS);
export type AxisPath = z.infer<typeof AxisPathSchema>;

/** 다르면 warning(비교는 허용). */
export const WARNING_PATHS = ['git.sha'] as const;

// ─────────────────────────────── RunRequest ───────────────────────────────

/** k6 duration 문자열(예: 30s, 1m30s, 500ms). */
export const K6DurationSchema = z.string().regex(/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/);

export const LOAD_PROFILES = ['constant'] as const;

export const LoadRequestSchema = z
  .strictObject({
    model: LoadModelSchema,
    profile: z.enum(LOAD_PROFILES),
    vus: z.number().int().min(1).nullable(),
    rate: z.number().positive().nullable(),
    preAllocatedVUs: z.number().int().min(1).nullable(),
    maxVUs: z.number().int().min(1).nullable(),
    duration: K6DurationSchema,
    warmup: K6DurationSchema,
    thinkTimeMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
    requestTimeout: K6DurationSchema,
  })
  .superRefine((l, ctx) => {
    const need = (key: 'vus' | 'rate' | 'preAllocatedVUs' | 'maxVUs', present: boolean) => {
      const has = l[key] !== null;
      if (has !== present) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: present ? `${l.model} 모델에는 ${key} 가 필요하다` : `${l.model} 모델에서 ${key} 는 null 이어야 한다`,
        });
      }
    };
    const open = l.model === 'open';
    need('vus', !open);
    need('rate', open);
    need('preAllocatedVUs', open);
    need('maxVUs', open);
    if (open && l.preAllocatedVUs !== null && l.maxVUs !== null && l.preAllocatedVUs > l.maxVUs) {
      ctx.addIssue({ code: 'custom', path: ['preAllocatedVUs'], message: 'preAllocatedVUs 가 maxVUs 보다 크다' });
    }
    if (l.thinkTimeMs[0] > l.thinkTimeMs[1]) {
      ctx.addIssue({ code: 'custom', path: ['thinkTimeMs'], message: 'thinkTimeMs 는 [min, max] 이다' });
    }
  });
export type LoadRequest = z.infer<typeof LoadRequestSchema>;

export const DistributionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('uniform') }),
  z.strictObject({ kind: z.literal('zipf'), s: z.number().positive() }),
]);
export type Distribution = z.infer<typeof DistributionSchema>;

export const PgProbeSchema = z
  .strictObject({ enabled: z.boolean(), intervalMs: z.number().int().min(1).nullable() })
  .refine((p) => !p.enabled || p.intervalMs !== null, { message: 'enabled 이면 intervalMs 가 필요하다', path: ['intervalMs'] });

export const REPS_MIN = 1;
export const REPS_MAX = 20;

/** `POST /runs` 본문. 모르는 키는 400. `pgProbe` 만 생략할 수 있다(생략하면 수준 기본값, C6 defaultPgProbe). */
export const RunRequestSchema = z
  .strictObject({
    scenario: nonEmpty,
    /** 순차 배치 */
    strategies: z.array(nonEmpty).min(1),
    strategyParams: z.record(z.string(), bag),
    /** 케이스 = strategies × appInstances */
    appInstances: z.array(z.number().int().min(1)).min(1),
    /** run.mjs 동작 보존 */
    includeMemoryLockSingle: z.boolean(),
    reps: z.number().int().min(REPS_MIN).max(REPS_MAX),
    load: LoadRequestSchema,
    data: z.strictObject({
      seed: z.number().int(),
      seedOptions: bag,
      distribution: DistributionSchema,
    }),
    /** k6 시나리오 전용 값 */
    scenarioParams: bag,
    instrumentation: InstrumentationLevelSchema,
    pgProbe: PgProbeSchema.optional(),
    injectDelay: z.array(InjectDelaySchema),
    /** 필수, 공백 아닌 1자 이상 */
    prediction: z.string().refine((s) => s.trim().length >= 1, { message: 'prediction 은 1자 이상' }),
    label: z.string().nullable(),
  })
  .superRefine((r, ctx) => {
    const dup = (list: readonly unknown[]) => list.some((x, i) => list.indexOf(x) !== i);
    if (dup(r.strategies)) ctx.addIssue({ code: 'custom', path: ['strategies'], message: 'strategies 가 중복된다' });
    if (dup(r.appInstances)) ctx.addIssue({ code: 'custom', path: ['appInstances'], message: 'appInstances 가 중복된다' });
    for (const key of Object.keys(r.strategyParams)) {
      if (!r.strategies.includes(key)) {
        ctx.addIssue({ code: 'custom', path: ['strategyParams', key], message: 'strategies 에 없는 strategy 의 파라미터' });
      }
    }
  });
export type RunRequest = z.infer<typeof RunRequestSchema>;

// ─────────────────────────────── 공개 응답 ───────────────────────────────

export const HealthResponseSchema = z.object({ ok: z.boolean(), version: z.string(), gitSha: z.string() });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const STRATEGY_KINDS = ['broken', 'fixed', 'tradeoff'] as const;

export const ScenarioInfoSchema = z.object({
  id: nonEmpty,
  pack: nonEmpty,
  title: nonEmpty,
  minAppInstances: z.number().int().min(1),
  strategies: z.array(
    z.object({
      id: nonEmpty,
      label: nonEmpty,
      kind: z.enum(STRATEGY_KINDS),
      bypassesOrm: z.boolean(),
      requires: z.array(z.string()),
      /** manifest params 정의 그대로(예: { lockTimeoutMs: { type, default } }) */
      params: bag,
    }),
  ),
  load: z.object({ models: z.array(LoadModelSchema), defaults: bag }),
  seedDefaults: bag,
  situations: z.array(bag).optional(),
});
export type ScenarioInfo = z.infer<typeof ScenarioInfoSchema>;

export const K6RenderRequestSchema = z.strictObject({ request: RunRequestSchema, strategy: nonEmpty });
export const K6RenderResponseSchema = z.object({
  templatePath: nonEmpty,
  env: z.record(z.string(), z.string()),
  scriptHash: nonEmpty,
});

export const RunsAcceptedSchema = z.object({
  sessionId: nonEmpty,
  batches: z.array(
    z.object({ batchId: nonEmpty, strategy: nonEmpty, appInstances: z.number().int().min(1), runIds: z.array(nonEmpty) }),
  ),
});
export type RunsAccepted = z.infer<typeof RunsAcceptedSchema>;
/** 400 본문. */
export const ValidationErrorResponseSchema = z.object({
  errors: z.array(z.object({ path: z.string(), message: z.string() })),
});
/** 409 본문. */
export const BusyResponseSchema = z.object({ reason: z.literal('busy'), sessionId: nonEmpty });

export const SESSION_STATES = ['queued', 'running', 'done', 'aborted', 'failed'] as const;
export const SessionStateSchema = z.enum(SESSION_STATES);
export const RUN_STATUSES = ['running', 'done', 'failed', 'aborted'] as const;

export const RunRowSchema = z.object({
  runId: nonEmpty,
  batchId: nonEmpty,
  sessionId: nonEmpty,
  repetition: z.number().int().min(1),
  scenario: nonEmpty,
  strategy: nonEmpty,
  appInstances: z.number().int().min(1),
  model: LoadModelSchema,
  instrumentation: InstrumentationLevelSchema,
  status: z.enum(RUN_STATUSES),
  valid: z.boolean().nullable(),
  invariantsPassed: z.boolean().nullable(),
  violationsTotal: count.nullable(),
  startedAt: nonEmpty,
  endedAt: z.string().nullable(),
});
export type RunRow = z.infer<typeof RunRowSchema>;

export const RunListResponseSchema = z.object({ items: z.array(RunRowSchema), next: z.string().nullable() });

export const StepSchema = z.object({ name: z.string(), at: z.string() });

export const RunDetailResponseSchema = z.object({
  row: RunRowSchema,
  metadata: RunMetadataAnySchema.nullable(),
  steps: z.array(StepSchema),
});

/** `GET /runs/:id/artifacts/:name` 의 name. */
export const ARTIFACT_NAMES = [
  'metadata.json',
  'summary.json',
  'report.html',
  'events.ndjson',
  'agg.ndjson',
  'prom.json',
  'probe.ndjson',
] as const;

// ─────────────────────────────── BatchSummary ───────────────────────────────

/** 반복 n회의 중앙값·범위. 값이 없으면 null. */
export const SpreadSchema = z.object({ median: z.number(), min: z.number(), max: z.number() }).nullable();
export type Spread = z.infer<typeof SpreadSchema>;

export const BATCH_BADGES = ['closed-latency-caution', 'injected', 'unstable'] as const;

/** 배열 필드는 반복 순서(r1, r2, …)이고 길이 = runIds 길이. */
export const BatchSummarySchema = z
  .object({
    batchId: nonEmpty,
    scenario: nonEmpty,
    strategy: nonEmpty,
    appInstances: z.number().int().min(1),
    loadModel: LoadModelSchema,
    reps: z.number().int().min(1),
    runIds: z.array(nonEmpty),
    invariants: z.array(
      z.object({
        id: nonEmpty,
        severity: z.enum(INVARIANT_SEVERITIES),
        violations: z.array(count.nullable()),
        passed: z.array(z.boolean().nullable()),
      }),
    ),
    validity: z.object({ validReps: count, invalidReasons: z.array(z.array(z.string())) }),
    throughputRps: SpreadSchema,
    latencyMs: z.object({
      /** k6 expected_response:true 서브메트릭 */
      success: z.object({ p50: SpreadSchema, p95: SpreadSchema, p99: SpreadSchema, n: z.array(count) }),
      /** k6 expected_response:false 서브메트릭 */
      failed: z.object({ p95: SpreadSchema, n: z.array(count) }),
    }),
    failures: z.object({
      http: z.array(count),
      dropped: z.array(count),
      droppedCountedAsFailure: z.array(z.boolean()),
      total: z.array(count),
    }),
    interventions: z.array(InterventionSchema),
    badges: z.array(z.enum(BATCH_BADGES)),
  })
  .superRefine((b, ctx) => {
    const n = b.runIds.length;
    const arrays: [string[], readonly unknown[]][] = [
      [['validity', 'invalidReasons'], b.validity.invalidReasons],
      [['latencyMs', 'success', 'n'], b.latencyMs.success.n],
      [['latencyMs', 'failed', 'n'], b.latencyMs.failed.n],
      [['failures', 'http'], b.failures.http],
      [['failures', 'dropped'], b.failures.dropped],
      [['failures', 'droppedCountedAsFailure'], b.failures.droppedCountedAsFailure],
      [['failures', 'total'], b.failures.total],
      ...b.invariants.flatMap((inv, i): [string[], readonly unknown[]][] => [
        [['invariants', String(i), 'violations'], inv.violations],
        [['invariants', String(i), 'passed'], inv.passed],
      ]),
    ];
    for (const [path, arr] of arrays) {
      if (arr.length !== n) ctx.addIssue({ code: 'custom', path, message: `길이 ${arr.length} ≠ runIds 길이 ${n}` });
    }
  });
export type BatchSummary = z.infer<typeof BatchSummarySchema>;

export const SessionResponseSchema = z.object({
  sessionId: nonEmpty,
  state: SessionStateSchema,
  request: RunRequestSchema,
  current: z.object({ runId: nonEmpty, step: z.string() }).nullable(),
  batches: z.array(BatchSummarySchema),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

// ─────────────────────────────── CompareResult ───────────────────────────────

export const DIFF_KINDS = ['axis', 'blocking', 'warning'] as const;

export const CompareDiffSchema = z.object({
  path: nonEmpty,
  /** 배치 순서대로 */
  values: z.array(z.unknown()),
  kind: z.enum(DIFF_KINDS),
});

export const CompareResultSchema = z
  .object({
    comparable: z.boolean(),
    /** axis 를 지정하지 않으면 null */
    axis: AxisPathSchema.nullable(),
    diffs: z.array(CompareDiffSchema),
    codeVersionDiffers: z.boolean(),
    batches: z.array(BatchSummarySchema),
    honestyNote: z.string(),
  })
  .superRefine((c, ctx) => {
    const blocking = c.diffs.some((d) => d.kind === 'blocking');
    if (c.comparable === blocking) {
      ctx.addIssue({ code: 'custom', path: ['comparable'], message: 'comparable 은 blocking diff 가 없을 때만 true' });
    }
    if (c.diffs.some((d) => d.kind === 'axis') && c.axis === null) {
      ctx.addIssue({ code: 'custom', path: ['axis'], message: 'axis diff 가 있으면 axis 가 지정돼야 한다' });
    }
    c.diffs.forEach((d, i) => {
      if (d.values.length !== c.batches.length) {
        ctx.addIssue({ code: 'custom', path: ['diffs', i, 'values'], message: 'values 길이 ≠ batches 길이' });
      }
    });
  });
export type CompareResult = z.infer<typeof CompareResultSchema>;

export const LearnMeasuredResponseSchema = z.object({
  scenario: nonEmpty,
  cells: z.array(z.object({ strategy: nonEmpty, situation: nonEmpty, measured: z.unknown() })),
});

// ─────────────────────────────── WsMessage ───────────────────────────────

/** `/ws/runs/:runId` 에서 runId 자리에 쓰면 진행 중인 실행을 따라간다. */
export const WS_CURRENT = 'current';

export const ProbeDataSchema = z.object({
  sessions: z.array(
    z.object({
      pid: z.number().int(),
      appName: z.string().nullable(),
      state: z.string().nullable(),
      waitEventType: z.string().nullable(),
      waitEvent: z.string().nullable(),
      xactAgeMs: z.number().min(0).nullable(),
      /** ≤200자, 리터럴 마스킹 */
      query: z.string().max(200).nullable(),
    }),
  ),
  blocking: z.array(z.object({ pid: z.number().int(), blockedBy: z.array(z.number().int()) })),
  lockWaiters: count,
});

const envelope = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ type: z.literal(type), runId: nonEmpty, /** epoch ms */ at: z.number().int().min(0), data });

export const WS_MESSAGE_TYPES = ['status', 'events', 'agg', 'pool', 'probe', 'invariants', 'end'] as const;

export const WsMessageSchema = z.discriminatedUnion('type', [
  envelope(
    'status',
    z.object({
      sessionId: nonEmpty,
      step: z.string(),
      state: SessionStateSchema,
      repetition: z.number().int().min(1),
      progress: z.object({ done: count, total: count }),
    }),
  ),
  envelope('events', z.array(WireEventV0Schema)),
  envelope('agg', AggWindowSchema),
  envelope('pool', PoolStatsSchema.extend({ instance: nonEmpty })),
  envelope('probe', ProbeDataSchema),
  envelope('invariants', z.array(InvariantResultSchema)),
  envelope('end', z.object({ valid: z.boolean(), reasons: z.array(z.string()) })),
]);
export type WsMessage = z.infer<typeof WsMessageSchema>;

// ─────────────────────────────── C7 k6 실행기 ───────────────────────────────

export const K6_RUNNER_PORT = 7070;
export const K6_PHASES = ['warmup', 'main'] as const;
export const K6_JOB_STATES = ['running', 'done', 'failed', 'aborted'] as const;

export const K6JobRequestSchema = z.strictObject({
  runId: nonEmpty,
  phase: z.enum(K6_PHASES),
  /** 예: /packs/.../k6/template.js */
  script: nonEmpty,
  env: z.record(z.string(), z.string()),
  tags: z.record(z.string(), z.string()),
  prometheusRw: z.boolean(),
  /** 예: /runs/<id>/report.html */
  htmlExport: z.string().min(1).nullable(),
  summaryPath: nonEmpty,
});
export type K6JobRequest = z.infer<typeof K6JobRequestSchema>;
export const K6JobAcceptedSchema = z.object({ jobId: nonEmpty });

/** run.mjs parseCpuStat 결과와 같은 모양(cgroup v2 cpu.stat). */
export const CpuStatSchema = z.object({
  usageUsec: count,
  nrPeriods: count,
  nrThrottled: count,
  throttledUsec: count,
});

export const K6JobStatusSchema = z.object({
  state: z.enum(K6_JOB_STATES),
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  cpu: z.object({
    before: CpuStatSchema.nullable(),
    after: CpuStatSchema.nullable(),
    /** cpu.max 파싱 결과. "max" 면 null */
    cpuMaxCores: z.number().positive().nullable(),
  }),
});
export type K6JobStatus = z.infer<typeof K6JobStatusSchema>;

export const K6InspectRequestSchema = z.strictObject({ script: nonEmpty, env: z.record(z.string(), z.string()) });

/** k6 env 공통 키(C7 순서). */
export const K6_ENV_KEYS = [
  'BASE_URL',
  'PHASE',
  'RUN_ID',
  'MODEL',
  'RATE',
  'VUS',
  'DURATION',
  'PRE_VUS',
  'MAX_VUS',
  'THINK_MIN_MS',
  'THINK_MAX_MS',
  'DIST',
  'ZIPF_S',
  'SEED',
  'REP_ACTORS',
  'REQUEST_TIMEOUT',
  'SUMMARY_PATH',
] as const;
export type K6EnvKey = (typeof K6_ENV_KEYS)[number];
/** 값이 정해진 키. */
export const K6_ENV_VALUES = Object.freeze({ MODEL: ['open', 'closed'], DIST: ['uniform', 'zipf'] } as const);

/** 시나리오 전용 키(시나리오 id → 키). */
export const K6_SCENARIO_ENV_KEYS = Object.freeze({
  'g02-stock-decrement': ['PRODUCT_MIN', 'PRODUCT_MAX', 'QTY'],
  'g01-shared-document': ['DOC_MIN', 'DOC_MAX', 'EDIT_MS', 'STRATEGY', 'LEASE_RETRY_MS'],
} as const);
