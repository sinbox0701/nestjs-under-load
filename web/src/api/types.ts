/**
 * 오케스트레이터 REST/WS(C2) 타입 미러.
 * 정본은 engine/contracts/src(api.ts·events.ts·metadata.ts)와 docs/CONTRACTS-phase1.md 다.
 * 웹은 contracts 패키지를 의존성으로 두지 않으므로 필요한 만큼만 손으로 옮겨 둔다.
 * 어긋남은 types.test.ts 가 contracts fixture 로 잡는다.
 */

export type LoadModel = 'open' | 'closed';
export type InstrumentationLevel = 'off' | 'metrics' | 'full';
export type StrategyKind = 'broken' | 'fixed' | 'tradeoff';
export type SessionState = 'queued' | 'running' | 'done' | 'aborted' | 'failed';
export type RunStatus = 'running' | 'done' | 'failed' | 'aborted';
export type AxisPath =
  'topology.appInstances' | 'instrumentation' | 'pgProbe.enabled' | 'interventions';
export type DiffKind = 'axis' | 'blocking' | 'warning';
export type BatchBadge = 'closed-latency-caution' | 'injected' | 'unstable' | 'no-trace-sink';
export type StackProfile = 'obs' | 'trace';

/** 경고 배지 문구(기록·비교 화면 공통). 순위·유효성에는 영향 없는 경고다. */
export const NO_TRACE_SINK_TEXT =
  '경고: 추적 저장소 없음(trace 프로필 꺼짐 — full 계측의 추적이 버려짐)';

/** GET /health */
export interface Health {
  ok: true;
  version: string;
  gitSha: string;
  stack: { profiles: StackProfile[] };
}

/** `/ws/runs/:runId` 에서 runId 자리에 쓰면 진행 중인 실행을 따라간다. */
export const WS_CURRENT = 'current';

// ───────────── 요청 ─────────────

export interface LoadRequest {
  model: LoadModel;
  profile: 'constant';
  vus: number | null;
  rate: number | null;
  preAllocatedVUs: number | null;
  maxVUs: number | null;
  duration: string;
  warmup: string;
  thinkTimeMs: [number, number];
  requestTimeout: string;
}

export type Distribution = { kind: 'uniform' } | { kind: 'zipf'; s: number };

export interface InjectDelay {
  point: string;
  ms: number;
}

export interface RunRequest {
  scenario: string;
  strategies: string[];
  strategyParams: Record<string, Record<string, unknown>>;
  appInstances: number[];
  includeMemoryLockSingle: boolean;
  reps: number;
  load: LoadRequest;
  data: { seed: number; seedOptions: Record<string, unknown>; distribution: Distribution };
  scenarioParams: Record<string, unknown>;
  instrumentation: InstrumentationLevel;
  pgProbe?: { enabled: boolean; intervalMs: number | null };
  injectDelay: InjectDelay[];
  prediction: string;
  label: string | null;
}

// ───────────── 응답 ─────────────

export interface ScenarioInfo {
  id: string;
  pack: string;
  title: string;
  minAppInstances: number;
  strategies: {
    id: string;
    label: string;
    kind: StrategyKind;
    bypassesOrm: boolean;
    requires: string[];
    params: Record<string, unknown>;
  }[];
  load: { models: LoadModel[]; defaults: Record<string, unknown> };
  seedDefaults: Record<string, unknown>;
  situations?: Record<string, unknown>[];
}

export interface RunsAccepted {
  sessionId: string;
  /** 계획 전체 runIds. 진행 중 세션의 BatchSummary.runIds 는 결과가 있는 실행만이다. */
  batches: { batchId: string; strategy: string; appInstances: number; runIds: string[] }[];
}

export interface RunRow {
  runId: string;
  batchId: string;
  sessionId: string;
  repetition: number;
  scenario: string;
  strategy: string;
  appInstances: number;
  model: LoadModel;
  instrumentation: InstrumentationLevel;
  status: RunStatus;
  valid: boolean | null;
  invariantsPassed: boolean | null;
  violationsTotal: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface RunList {
  items: RunRow[];
  next: string | null;
}

export interface ListRunsQuery {
  scenario?: string;
  strategy?: string;
  batchId?: string;
  limit?: number;
  before?: string;
}

export interface InvariantResult {
  id: string;
  severity: 'critical' | 'info';
  violations: number | null;
  passed: boolean | null;
  value?: unknown;
}

/** 메타데이터 전체 스키마는 계약 정본이 갖고, 웹은 화면에 쓰는 키만 타입으로 둔다(나머지는 느슨하게 통과). */
export interface RunMetadata {
  schemaVersion?: number;
  runId: string;
  batchId: string;
  sessionId: string;
  repetition: number;
  scenario: string;
  invariants: InvariantResult[];
  [key: string]: unknown;
}

export interface RunDetail {
  row: RunRow;
  metadata: RunMetadata | null;
  steps: { name: string; at: string }[];
}

/** 반복 n회의 중앙값·범위. 값이 없으면 null. */
export type Spread = { median: number; min: number; max: number } | null;

export interface BatchSummary {
  batchId: string;
  scenario: string;
  strategy: string;
  appInstances: number;
  loadModel: LoadModel;
  reps: number;
  runIds: string[];
  /** 배열 필드는 반복 순서이고 길이 = runIds 길이. */
  invariants: {
    id: string;
    severity: 'critical' | 'info';
    violations: (number | null)[];
    passed: (boolean | null)[];
  }[];
  validity: { validReps: number; invalidReasons: string[][] };
  throughputRps: Spread;
  latencyMs: {
    success: { p50: Spread; p95: Spread; p99: Spread; n: number[] };
    failed: { p95: Spread; n: number[] };
  };
  failures: {
    http: number[];
    dropped: number[];
    droppedCountedAsFailure: boolean[];
    total: number[];
  };
  interventions: (InjectDelay & { type: 'inject-delay' })[];
  badges: BatchBadge[];
}

export interface Session {
  sessionId: string;
  state: SessionState;
  request: RunRequest;
  current: { runId: string; step: string } | null;
  batches: BatchSummary[];
  startedAt: string | null;
  endedAt: string | null;
}

export interface CompareResult {
  comparable: boolean;
  axis: AxisPath | null;
  diffs: { path: string; values: unknown[]; kind: DiffKind }[];
  codeVersionDiffers: boolean;
  batches: BatchSummary[];
  honestyNote: string;
}

export interface LearnMeasured {
  scenario: string;
  cells: { strategy: string; situation: string; measured: unknown }[];
}

/** 400 본문. */
export interface ValidationErrors {
  errors: { path: string; message: string }[];
}

// ───────────── WS ─────────────

/** C4 이벤트 한 줄(v0). ndjson.ts 의 WireEvent 와 호환된다. */
export interface WireEventV0 {
  v: 0;
  runId: string;
  /** epoch µs */
  ts: number;
  seq: number;
  instance: string;
  actor: string;
  phase: string;
  reqId?: string;
  traceId?: string;
  entity?: { type: string; id: string };
  durMs?: number | null;
  attrs?: Record<string, string | number | boolean | null>;
  sampled?: boolean;
  injected?: boolean;
  sql?: string;
  rows?: number;
  note?: string;
}

export interface AggWindow {
  v: 0;
  runId: string;
  instance: string;
  /** epoch ms */
  windowStart: number;
  windowMs: 1000;
  counts: Record<string, number>;
  dropped: number;
}

export interface ProbeData {
  sessions: {
    pid: number;
    appName: string | null;
    state: string | null;
    waitEventType: string | null;
    waitEvent: string | null;
    xactAgeMs: number | null;
    query: string | null;
  }[];
  blocking: { pid: number; blockedBy: number[] }[];
  lockWaiters: number;
}

interface Envelope<T extends string, D> {
  type: T;
  runId: string;
  /** epoch ms */
  at: number;
  data: D;
}

export type WsMessage =
  | Envelope<
      'status',
      {
        sessionId: string;
        step: string;
        state: SessionState;
        repetition: number;
        progress: { done: number; total: number };
      }
    >
  | Envelope<'events', WireEventV0[]>
  | Envelope<'agg', AggWindow>
  | Envelope<'pool', { total: number; idle: number; waiting: number; instance: string }>
  | Envelope<'probe', ProbeData>
  | Envelope<'invariants', InvariantResult[]>
  | Envelope<'end', { valid: boolean; reasons: string[] }>;

export type WsMessageType = WsMessage['type'];
