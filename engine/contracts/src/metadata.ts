import { z } from 'zod';

import { InjectDelaySchema, InstrumentationLevelSchema } from './run-config.js';

/**
 * C3 실행 메타데이터 스키마 v1(DESIGN §7.3 전체 + 0단계 확장).
 * 스키마는 구조(키·타입)를 고정하고 값 칸은 null 을 받는다. 어느 null 이 정상인지는 NULLABLE_WHEN 이 정하고,
 * 그 밖의 null 은 completeness 검사가 "미채움"으로 보고한다(스키마가 거절하지 않는다).
 */

const str = z.string().nullable();
const int = z.number().int().nullable();
const num = z.number().nullable();
const bool = z.boolean().nullable();
const bag = z.record(z.string(), z.unknown());

export const LOAD_MODELS = ['open', 'closed'] as const;
export const LoadModelSchema = z.enum(LOAD_MODELS);
export type LoadModel = z.infer<typeof LoadModelSchema>;

/** 관측 프로필(D1). 기본 프로필은 목록에 넣지 않는다. */
export const STACK_PROFILES = ['obs', 'trace'] as const;
export const METADATA_PROFILES = ['default', 'minimal'] as const;
export const INVARIANT_SEVERITIES = ['critical', 'info'] as const;
/** obs 프로필이 없을 때 validity.checks.scrapeGaps 에 넣는 값. */
export const NOT_MEASURED = 'not-measured' as const;
/** 추적 저장소(trace 프로필) 상태. full 계측이 아니면 not-applicable, full 이면 trace 프로필 유무로 present·absent. */
export const TRACE_SINKS = ['present', 'absent', 'not-applicable'] as const;
export const TraceSinkSchema = z.enum(TRACE_SINKS);
export type TraceSink = z.infer<typeof TraceSinkSchema>;

export const InterventionSchema = InjectDelaySchema.extend({ type: z.literal('inject-delay') });
export type Intervention = z.infer<typeof InterventionSchema>;

/**
 * 불변식 결과 하나. critical 은 violations·passed 를 채우고, info 는 둘 다 null 이고 value 에 대조용 값을 둔다.
 */
export const InvariantResultSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(INVARIANT_SEVERITIES),
  violations: z.number().int().min(0).nullable(),
  passed: z.boolean().nullable(),
  value: z.unknown().optional(),
});
export type InvariantResult = z.infer<typeof InvariantResultSchema>;

export const ContainerLimitSchema = z.object({ cpus: num, mem: str, cpuset: str });

export const RunMetadataV1Schema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  batchId: z.string().min(1),
  sessionId: z.string().min(1),
  repetition: z.number().int().min(1),
  scenario: z.string().min(1),
  strategy: z.object({ id: z.string().min(1), params: bag }),
  git: z.object({ sha: str, dirty: bool }),
  /** Docker inspect ImageID */
  images: z.object({ app: str, postgres: str, k6: str, nginx: str, redis: str }),
  profile: z.enum(METADATA_PROFILES),
  /** 함께 뜬 관측 프로필(비교 조건) */
  stack: z.object({ profiles: z.array(z.enum(STACK_PROFILES)) }),
  host: z.object({
    dockerNcpu: int,
    dockerMemBytes: int,
    os: str,
    arch: str,
    cpu: str,
    dockerDesktopVersion: str,
  }),
  /** inspect 실측값. app·nginx·postgres·k6 는 필수, 그 밖의 컨테이너는 같은 모양으로 더 둘 수 있다. */
  limits: z
    .object({ app: ContainerLimitSchema, nginx: ContainerLimitSchema, postgres: ContainerLimitSchema, k6: ContainerLimitSchema })
    .catchall(ContainerLimitSchema),
  topology: z.object({
    appInstances: z.number().int().min(1),
    lb: str,
    dbPath: str,
    proxy: str,
    replica: bool,
  }),
  pool: z.object({ min: int, max: int, acquireTimeoutMs: int }),
  postgres: z.object({
    configHash: str,
    maxConnections: int,
    sharedBuffers: str,
    observerConnections: int,
    appRoleConnectionLimit: int,
  }),
  timeouts: z.object({
    k6RequestMs: int,
    serverRequestMs: int,
    poolAcquireMs: int,
    statementMs: int,
    lockMs: int,
    idleInTxMs: int,
  }),
  redis: z.object({ used: z.boolean(), maxmemoryPolicy: str }),
  data: z.object({
    seed: int,
    seedHash: str,
    templateDb: str,
    seedOptions: bag,
    rows: bag,
    /** 예: "uniform", "zipf(1.1)" */
    distribution: str,
    scenarioParams: bag,
  }),
  load: z.object({
    model: LoadModelSchema,
    executor: str,
    profile: str,
    vus: int,
    rate: num,
    timeUnit: str,
    preAllocatedVUs: int,
    maxVUs: int,
    duration: str,
    warmup: str,
    thinkTimeMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).nullable(),
  }),
  k6Script: z.object({ hash: str, edited: bool }),
  instrumentation: InstrumentationLevelSchema,
  pgProbe: z.object({ enabled: z.boolean(), intervalMs: int }),
  interventions: z.array(InterventionSchema),
  /** 3단계 */
  chaos: z.array(bag),
  coldStart: bool,
  osCacheControlled: bool,
  validity: z.object({
    valid: bool,
    reasons: z.array(z.string()),
    k6CpuAvgRatio: num,
    droppedCountedAsFailure: bool,
    checks: z.object({
      k6Cpu: bag.nullable(),
      scrapeGaps: z.union([z.object({ gaps: z.number().int().min(0) }).catchall(z.unknown()), z.literal(NOT_MEASURED)]).nullable(),
      /** full 인데 sink 가 absent 면 경고(valid 는 그대로). 이전 v1 메타데이터엔 없다. */
      tracing: z.object({ sink: TraceSinkSchema }).optional(),
    }),
  }),
  invariants: z.array(InvariantResultSchema),
  ledgerVsClient: bag.nullable(),
  k6: bag.nullable(),
  prediction: str,
  steps: z.array(z.object({ name: z.string(), at: z.string() })),
  artifacts: z.object({
    runConfig: str,
    k6Summary: str,
    k6Html: str,
    events: str,
    agg: str,
    probe: str,
    promSnapshot: str,
    metadata: str,
  }),
  startedAt: str,
  endedAt: str,
});
export type RunMetadataV1 = z.infer<typeof RunMetadataV1Schema>;
export type RunMetadata = RunMetadataV1;

/**
 * 0단계 metadata.json(`scripts/run.mjs buildMetadata`, `schemaVersion` 없음).
 * 식별 필드만 검사하고 나머지는 그대로 둔다(0단계 확장 필드 `dryRun`, `data.stockPerProduct` 등 보존).
 */
export const RunMetadataV0Schema = z.looseObject({
  runId: z.string().min(1),
  batchId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  repetition: z.number().int().min(1),
  scenario: z.string().min(1),
  strategy: z.looseObject({ id: z.string().min(1), params: bag }),
  instrumentation: InstrumentationLevelSchema.optional(),
});
export type RunMetadataV0 = z.infer<typeof RunMetadataV0Schema>;

export type AnyVersionMetadata = { version: 0; metadata: RunMetadataV0 } | { version: 1; metadata: RunMetadataV1 };

/** `schemaVersion` 키가 없으면 v0, 있으면 v1 로 parse 한다(값이 1 이 아니면 실패). 실패하면 ZodError 를 던진다. */
export function parseMetadataAnyVersion(raw: unknown): AnyVersionMetadata {
  const versioned = typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'schemaVersion' in raw;
  if (versioned) return { version: 1, metadata: RunMetadataV1Schema.parse(raw) };
  return { version: 0, metadata: RunMetadataV0Schema.parse(raw) };
}

/** GET /runs/:id 등에서 버전과 무관하게 받는 메타데이터. */
export const RunMetadataAnySchema = z.union([RunMetadataV1Schema, RunMetadataV0Schema.refine((m) => !('schemaVersion' in m))]);

// ─────────────────────────────── C3 null 허용 조건 ───────────────────────────────

export interface NullableRule {
  /** 점으로 이은 경로 */
  readonly path: string;
  /** 조건(문서 문구) */
  readonly when: string;
  /** 조건이 맞을 때 허용하는 값. scrapeGaps 만 null 대신 "not-measured" 문자열이다. */
  readonly allowed: null | typeof NOT_MEASURED;
  /** 조건 판정 */
  readonly applies: (m: RunMetadataV1) => boolean;
}

const isOpen = (m: RunMetadataV1) => m.load.model === 'open';
const isClosed = (m: RunMetadataV1) => m.load.model === 'closed';
/** strategy 에 lock 파라미터가 없을 때. lock 파라미터 = `lockTimeoutMs`(run.mjs 가 timeouts.lockMs 로 옮기는 키). */
const noLockParam = (m: RunMetadataV1) => !Object.prototype.hasOwnProperty.call(m.strategy.params, 'lockTimeoutMs');

/** C3 「null 을 허용하는 경우」 표(문서 순서, 한 경로에 한 줄). */
export const NULLABLE_WHEN: readonly NullableRule[] = Object.freeze([
  { path: 'load.vus', when: 'open 일 때', allowed: null, applies: isOpen },
  { path: 'load.rate', when: 'closed 일 때', allowed: null, applies: isClosed },
  { path: 'load.timeUnit', when: 'closed 일 때', allowed: null, applies: isClosed },
  { path: 'load.preAllocatedVUs', when: 'closed 일 때', allowed: null, applies: isClosed },
  { path: 'load.maxVUs', when: 'closed 일 때', allowed: null, applies: isClosed },
  { path: 'timeouts.lockMs', when: 'strategy 에 lock 파라미터가 없을 때', allowed: null, applies: noLockParam },
  { path: 'redis.maxmemoryPolicy', when: 'used: false 일 때', allowed: null, applies: (m) => m.redis.used === false },
  {
    path: 'validity.checks.scrapeGaps',
    when: 'obs 프로필이 없을 때 → "not-measured" 문자열',
    allowed: NOT_MEASURED,
    applies: (m) => !m.stack.profiles.includes('obs'),
  },
  // Prometheus 가 없으면 구간 지표를 동결할 곳이 없다
  { path: 'artifacts.promSnapshot', when: 'obs 프로필이 없을 때', allowed: null, applies: (m) => !m.stack.profiles.includes('obs') },
  // Engine API 에서 Docker Desktop 버전은 /version 의 Platform.Name("Docker Desktop x.y.z")으로만 얻는다. 그 밖의 엔진엔 없다.
  {
    path: 'host.dockerDesktopVersion',
    when: 'Docker Desktop 이 아닐 때(host.os 가 Docker Desktop 이 아님)',
    allowed: null,
    applies: (m) => !/docker desktop/i.test(m.host.os ?? ''),
  },
  // 원장 대조는 원장 행 수를 내는 info 불변식(ledger-matches-k6)과 k6 결과를 맞대는 것이다
  {
    path: 'ledgerVsClient',
    when: '시나리오에 원장 대조 불변식(ledger-matches-k6)이 없을 때',
    allowed: null,
    applies: (m) => !m.invariants.some((i) => i.id === 'ledger-matches-k6'),
  },
]);
