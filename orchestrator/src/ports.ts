// C8 오케스트레이터 내부 포트. 모듈 티켓(T-107~T-114)이 구현하고, RunEngine(T-110)·API(T-111)는
// 이 인터페이스로만 서로를 쓴다. 테스트는 가짜 구현으로 한다. 배선은 T-138.
//
// 규칙
// - `export interface` 는 정확히 C8 의 11개(Clock, DockerControl, DbAdmin, InvariantRunner, K6Runner,
//   MetadataStore, RunConfigBoard, EventHub, ProbeSource, ObsClient, RunEngine)다. 인자·결과 모양은 `type` 별칭.
// - I/O 가 있는 메서드는 Promise 를 돌려준다(구현이 동기여도 포트는 비동기).
// - 계약 타입은 `@under-load/contracts` 에서 가져오고 여기서 복제하지 않는다.
// - 모듈 티켓은 이 시그니처를 바꾸지 말고, 부족하면 반환의 「계약 메모」에 적는다.
import type {
  AggWindow,
  BatchSummary,
  IngestBatch,
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
  WsMessage,
} from '@under-load/contracts';

import type { Routers } from './http/router.js';

// ───────────────────────────── 공용 별칭 ─────────────────────────────

/** `not-measured`(obs 프로필 없음·연결 거부) 를 값과 구분해 돌려주는 결과. 예외로 알리지 않는다. */
export type Measured<T> = ({ status: 'ok' } & T) | { status: 'not-measured'; reason?: string };

/** 중단 신호를 받는 장기 호출의 공통 옵션. */
export type CallOptions = { signal?: AbortSignal };

/** 시나리오 정의(팩 manifest 를 읽어 T-111 이 만든다). RunEngine·InvariantRunner·API 가 같이 쓴다. */
export type ScenarioDef = {
  id: string;
  pack: string;
  title: string;
  minAppInstances: number;
  /** k6 컨테이너 안 스크립트 경로(C7 `script`) */
  k6Script: string;
  /** 불변식 SQL 파일(invariants.sql) 레포 경로 */
  invariantsSqlPath: string;
  /** manifest invariants. `sql` 은 `invariants.sql#<name>` */
  invariants: { id: string; severity: 'critical' | 'info'; sql: string }[];
  /** 웜업 뒤 실행 DB 에서 지울 SQL(웜업 전용 데이터). 없으면 null */
  discardSql: string | null;
  /** manifest strategies. 기본 파라미터 포함 */
  strategies: { id: string; params: Record<string, unknown> }[];
  /** seed 기본값(RunRequest.data.seedOptions 와 같은 모양) */
  seedDefaults: Record<string, unknown>;
};

/** 시나리오 조회. T-111 이 구현, T-110 은 가짜로 테스트. */
export type ScenarioCatalog = {
  list(): ScenarioDef[];
  get(id: string): ScenarioDef | undefined;
};

/** app 인스턴스의 `GET /_lab/ready` 응답을 얻는 함수(연결 실패·비 200 은 null). RunEngine 이 생성자로 받는다. */
export type ReadyProbe = (instance: string, opts?: CallOptions) => Promise<ReadyResponse | null>;

// ───────────────────────────── Clock ─────────────────────────────

/** 시간·대기. 테스트가 가짜로 갈아 끼워 타임아웃·웜업을 즉시 진행한다. 모든 모듈은 Date.now/setTimeout 대신 이것을 쓴다. */
export interface Clock {
  /** epoch ms */
  now(): number;
  /** ISO 8601(UTC) */
  nowIso(): string;
  /** ms 만큼 대기. signal 이 abort 되면 즉시 reject(AbortError). */
  sleep(ms: number, opts?: CallOptions): Promise<void>;
}

// ───────────────────────────── DockerControl (T-108) ─────────────────────────────

export type ContainerInfo = {
  id: string;
  name: string;
  /** compose 라벨 `com.docker.compose.service` */
  service: string;
  /** compose 라벨 `com.docker.compose.container-number`(없으면 1) */
  number: number;
  /** created|running|paused|restarting|exited|dead … Docker Engine 의 State */
  state: string;
  image: string;
  imageId: string;
  /** HostConfig: cpus=NanoCpus/1e9, memBytes=Memory(0 이면 null), cpuset=CpusetCpus('' 이면 null) */
  limits: { cpus: number | null; memBytes: number | null; cpuset: string | null };
};

export type DockerInfo = {
  ncpu: number;
  memTotalBytes: number;
  serverVersion: string;
  operatingSystem: string;
  apiVersion: string;
};

/** socket-proxy 경유 Docker Engine API(D10: create 금지, start/stop/restart/inspect 허용). */
export interface DockerControl {
  /** compose 서비스 라벨(`com.docker.compose.service=<service>`)과 프로젝트로 컨테이너 목록(정지 포함), number 오름차순. */
  list(service: string): Promise<ContainerInfo[]>;
  inspect(idOrName: string): Promise<ContainerInfo>;
  /** 이미 그 상태면 성공(멱등). */
  stop(idOrName: string, opts?: { timeoutSec?: number }): Promise<void>;
  start(idOrName: string): Promise<void>;
  restart(idOrName: string, opts?: { timeoutSec?: number }): Promise<void>;
  info(): Promise<DockerInfo>;
}

// ───────────────────────────── DbAdmin (T-108) ─────────────────────────────

export type TemplateStatus = { exists: boolean; isTemplate: boolean };

/** 관리자 권한 PG 작업. 실행 DB 이름(`lab_run`)은 설정에서 온다. */
export interface DbAdmin {
  /** 템플릿 DB 이름 규칙(`tpl_<시나리오 짧은 이름>_<해시>`)을 한 곳에서 정한다: 시나리오·seed·seedOptions 가 같으면 같은 이름. */
  templateName(scenarioId: string, data: RunRequest['data']): string;
  templateStatus(name: string): Promise<TemplateStatus>;
  /** prepare-template 이 끝난 DB 를 `is_template=true` 로 표시. */
  markTemplate(name: string): Promise<void>;
  /**
   * 실행 DB 리셋(순서 고정): DROP DATABASE … WITH (FORCE) → CREATE DATABASE … TEMPLATE → VACUUM ANALYZE →
   * CHECKPOINT → pg_stat_statements_reset → pg_stat_reset → pg_stat_reset_shared 7종.
   */
  resetRunDb(templateDb: string): Promise<void>;
  /** 실행 DB 에서 SQL 실행(웜업 데이터 폐기 `discardSql` 등). */
  execInRunDb(sql: string): Promise<void>;
  /** lab_observer·exporter 역할 멱등 보장(D11). 두 번 불러도 오류 없음. */
  ensureRoles(): Promise<void>;
  /** pg_settings 전체 해시와 값(메타데이터 postgres.configHash·비교용). */
  configHash(): Promise<{ hash: string; settings: Record<string, string> }>;
}

// ───────────────────────────── InvariantRunner (T-108) ─────────────────────────────

/** 시나리오 불변식 SQL 을 실행 DB 에 돌리고 판정(run.mjs parseInvariantsSql·judgeInvariants 이식). 결과는 manifest 순서. */
export interface InvariantRunner {
  run(scenario: ScenarioDef): Promise<InvariantResult[]>;
}

// ───────────────────────────── K6Runner (T-109) ─────────────────────────────

export type K6EnvInput = {
  scenario: ScenarioDef;
  request: RunRequest;
  runId: string;
  /** 웜업이면 짧은 지속·웜업 상품 범위를 쓴다 */
  phase: K6JobRequest['phase'];
  /** 이 배치의 strategy(시나리오 전용 env 의 STRATEGY 등) */
  strategy: string;
  /** 결과 summary 를 쓸 컨테이너 안 경로 → env SUMMARY_PATH */
  summaryPath: string;
};

/** summary.json 해석 결과. 지연 단위 ms. */
export type K6Summary = {
  requests: number;
  throughputRps: number;
  httpFailures: number;
  /** open 모델의 dropped_iterations. closed 면 0 */
  dropped: number;
  latencyMs: {
    success: { p50: number | null; p95: number | null; p99: number | null; n: number };
    failed: { p50: number | null; p95: number | null; p99: number | null; n: number };
  };
};

export type ValidityInput = {
  request: RunRequest;
  summary: K6Summary;
  k6: K6JobStatus;
  /** 스크레이프 누락 수. obs 없음이면 null */
  scrapeGaps: number | null;
};

export type ValidityVerdict = {
  valid: boolean;
  /** 무효 사유(한국어 문장). valid 면 빈 배열 */
  reasons: string[];
  k6CpuAvgRatio: number | null;
  /** open 에서 dropped 를 failures.total 에 더했는지. closed 면 null */
  droppedCountedAsFailure: boolean | null;
  /** http 실패 + (droppedCountedAsFailure ? dropped : 0) */
  failuresTotal: number;
  /** metadata.validity.checks.k6Cpu 에 넣는 근거 */
  k6Cpu: Record<string, unknown> | null;
};

/** C7 k6 실행기 클라이언트 + RunRequest→env 변환 + summary 해석 + 유효성 판정. */
export interface K6Runner {
  /** RunRequest → k6 env(C7 공통·시나리오 키). closed 면 MODEL=closed·VUS 만(RATE·MAX_VUS 없음). */
  buildEnv(input: K6EnvInput): Record<string, string>;
  /** 스크립트 해시. SUMMARY_PATH·PHASE 를 뺀 env 와 스크립트 내용으로 계산(run.mjs k6ScriptHash 규칙). */
  scriptHash(scenario: ScenarioDef, env: Record<string, string>): Promise<string>;
  /** `POST /jobs`. 실행 중(409)이면 throw. */
  submit(job: K6JobRequest): Promise<{ jobId: string }>;
  status(jobId: string): Promise<K6JobStatus>;
  /** running 이 아닐 때까지 짧은 간격으로 조회(알림 없음). signal 이 abort 되면 job 을 abort 하고 최종 status 를 돌려준다. */
  waitDone(jobId: string, opts?: CallOptions & { pollMs?: number }): Promise<K6JobStatus>;
  abort(jobId: string): Promise<void>;
  /** `POST /inspect` — `k6 inspect --execution-requirements` JSON. */
  inspect(script: string, env: Record<string, string>): Promise<unknown>;
  /**
   * summary.json 파일을 읽어 K6Summary 로(성공·실패 지연은 expected_response 서브메트릭 기준).
   * mainDurationSec = 본 실행 길이(초). throughputRps = http_reqs.count / mainDurationSec. 0 이하면 throw.
   */
  readSummary(summaryFile: string, mainDurationSec: number): Promise<K6Summary>;
  judgeValidity(input: ValidityInput): ValidityVerdict;
}

// ───────────────────────────── MetadataStore (T-107) ─────────────────────────────

export type SessionRecord = {
  sessionId: string;
  request: RunRequest;
  state: SessionResponse['state'];
  startedAt: string | null;
  endedAt: string | null;
};

export type BatchRecord = {
  batchId: string;
  sessionId: string;
  scenario: string;
  strategy: string;
  appInstances: number;
  loadModel: RunRow['model'];
  reps: number;
};

export type RunRowPatch = Partial<Pick<RunRow, 'status' | 'valid' | 'invariantsPassed' | 'violationsTotal' | 'endedAt'>>;

export type RunListFilter = {
  scenario?: string;
  strategy?: string;
  batchId?: string;
  /** 1..200, 기본 50 */
  limit?: number;
  /** 커서 = 이전 응답의 next. 이 값보다 오래된(startedAt, runId 내림차순) 행만 */
  before?: string;
};

/** node:sqlite(`runs/_meta/lab.sqlite`) + `runs/<runId>/metadata.json`. 실행 행은 실행 시작 시점에 insert 한다(status=running). */
export interface MetadataStore {
  createSession(s: SessionRecord): Promise<void>;
  updateSession(sessionId: string, patch: Partial<Pick<SessionRecord, 'state' | 'startedAt' | 'endedAt'>>): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  createBatch(b: BatchRecord): Promise<void>;
  insertRun(row: RunRow): Promise<void>;
  updateRun(runId: string, patch: RunRowPatch): Promise<void>;
  getRun(runId: string): Promise<RunRow | null>;
  /** startedAt 내림차순. next 는 다음 페이지 커서(없으면 null). */
  listRuns(filter?: RunListFilter): Promise<{ items: RunRow[]; next: string | null }>;
  /** 단계 기록(메타데이터 steps 와 `/runs/:id` 의 steps). */
  addStep(runId: string, step: { name: string; at: string }): Promise<void>;
  getSteps(runId: string): Promise<{ name: string; at: string }[]>;
  /** metadata.json 원자적 쓰기(tmp+rename) 후 DB 의 metadata_json 갱신. */
  saveMetadata(runId: string, metadata: RunMetadata): Promise<void>;
  /** 0단계(v0) 파일도 읽는다. 없으면 null. */
  getMetadata(runId: string): Promise<RunMetadata | null>;
  /** 진행 중이면 결과가 있는 실행만 runIds 에 담는다. 없으면 null. */
  getBatchSummary(batchId: string): Promise<BatchSummary | null>;
  getSessionBatches(sessionId: string): Promise<BatchSummary[]>;
  /** 배치의 실행 행(repetition 오름차순). */
  getBatchRuns(batchId: string): Promise<RunRow[]>;
}

// ───────────────────────────── RunConfigBoard (T-111 서빙, T-110 게시) ─────────────────────────────

/** 현재 RunConfig 를 모든 app 인스턴스에 같은 값으로 게시한다. `GET /internal/run-config?instance=` 는 get() 으로 응답. */
export interface RunConfigBoard {
  /** 이전 게시를 교체. */
  publish(config: RunConfigV1): void;
  /** 게시된 것이 없으면 null(→ 204 대기 모드). instance 는 가져간 기록용(같은 값을 준다). */
  get(instance: string): RunConfigV1 | null;
  /** 게시 취소(→ 204). */
  clear(): void;
  /** 게시된 것이 있으면 그 값, 없으면 null(가져간 기록을 남기지 않는다). */
  current(): RunConfigV1 | null;
  /** 현재 게시를 가져간 인스턴스 이름(디버그·로그용). */
  fetchedBy(): string[];
}

// ───────────────────────────── EventHub (T-112) ─────────────────────────────

export type EventHubRunContext = {
  runId: string;
  batchId: string;
  sessionId: string;
  /** `runs/<runId>` 디렉터리(events.ndjson·agg.ndjson 을 추가 쓰기) */
  dir: string;
};

export type IngestResult = { ok: true; events: number } | { ok: false; reason: 'run_mismatch' | 'invalid' };

/** 이벤트 수신·링버퍼·파일 기록·WS 팬아웃. 현재 실행은 beginRun 으로 정한다. */
export interface EventHub {
  /** 새 실행 시작: 링버퍼·파일 열기, 'current' 구독자에게 새 runId 알림. */
  beginRun(ctx: EventHubRunContext): Promise<void>;
  /** 실행 종료: 파일 flush·닫기. 구독자 소켓은 유지(다음 실행 대기). */
  endRun(runId: string): Promise<void>;
  /** C4 IngestBatch 처리. run_mismatch 면 `lab_orch_ingest_rejected_total{reason="run_mismatch"}` +1 하고 라우트가 409 로 응답. */
  ingest(batch: IngestBatch): Promise<IngestResult>;
  /** WS 구독자에게 보내고 필요한 것은 기록한다(status·probe·invariants·end 는 엔진·프로브 배선이 부른다; events·agg 는 ingest 가 내부에서 부른다). */
  publish(message: WsMessage): void;
  /** 최근 이벤트·집계(링버퍼). WS 접속 직후 재생과 테스트용. */
  snapshot(runId: string): { events: IngestBatch['events']; agg: AggWindow[] };
  /** `POST /ingest/events`(internal), `/ws/runs/:runId`(public upgrade), `/metrics`(internal)를 등록한다. 한 번만 호출. */
  registerRoutes(routers: Routers): void;
  /** Prometheus 텍스트(lab_orch_ingest_events_total, lab_orch_ingest_rejected_total{reason}, lab_orch_ws_clients). */
  renderMetrics(): string;
  close(): Promise<void>;
}

// ───────────────────────────── ProbeSource (T-113) ─────────────────────────────

export type ProbeData = Extract<WsMessage, { type: 'probe' }>['data'];

export type ProbeStart = {
  runId: string;
  intervalMs: number;
  /** probe.ndjson 경로(`runs/<runId>/probe.ndjson`) */
  outFile: string;
  /** 표본마다 호출(배선이 EventHub.publish 로 'probe' 팬아웃) */
  onSample: (data: ProbeData) => void;
};

/** lab_observer 전용 커넥션 1개로 주기 표본(pg_stat_activity·pg_blocking_pids). 꺼진 실행에서는 start 를 부르지 않는다(쿼리 0건). */
export interface ProbeSource {
  /** 이미 돌고 있으면 throw. */
  start(opts: ProbeStart): Promise<void>;
  /** 마지막 표본까지 기록하고 멈춘다. 돌고 있지 않으면 no-op. */
  stop(): Promise<{ samples: number }>;
}

// ───────────────────────────── ObsClient (T-114) ─────────────────────────────

export type AnnotatePhase = 'reset' | 'warmup' | 'main' | 'invariants';

/** Grafana·Prometheus. obs 프로필이 없거나 연결이 거부되면 예외 없이 `not-measured`. */
export interface ObsClient {
  /** 태그 `["nul","run:<id>","batch:<id>","phase:<phase>"]`. 구간이면 timeEndMs 도. */
  annotate(a: { runId: string; batchId: string; phase: AnnotatePhase; text: string; timeMs: number; timeEndMs?: number }): Promise<Measured<Record<never, never>>>;
  /** 구간 주요 지표 범위 질의를 `outFile`(prom.json) 로 동결. */
  snapshot(a: { runId: string; fromMs: number; toMs: number; outFile: string }): Promise<Measured<{ file: string }>>;
  /** `up` 시계열의 스크레이프 누락 수(15초 이상 공백을 1구간). */
  scrapeGaps(a: { fromMs: number; toMs: number }): Promise<Measured<{ gaps: number; details?: Record<string, unknown> }>>;
}

// ───────────────────────────── RunEngine (T-110) ─────────────────────────────

export type StartResult =
  | { kind: 'accepted'; accepted: RunsAccepted }
  | { kind: 'busy'; sessionId: string }
  /** 요청이 시나리오 정의와 맞지 않을 때(미지 전략·appInstances < minAppInstances 등). path 는 점 경로 */
  | { kind: 'invalid'; errors: { path: string; message: string }[] };

/** 세션(요청 1건)의 수명주기. 의존 모듈은 전부 생성자 인자로 받은 포트로만 쓴다. */
export interface RunEngine {
  /** RunRequest 는 이미 zod 검증을 통과한 값. 진행 중 세션이 있으면 busy. 실행은 백그라운드로 돌고 즉시 돌아온다. */
  start(request: RunRequest): Promise<StartResult>;
  /** runId 가 속한 세션 전체 중단. 알 수 없으면 false. */
  abort(runId: string): Promise<boolean>;
  /** 세션 상태(`GET /sessions/:id`). 없으면 null. */
  status(sessionId: string): Promise<SessionResponse | null>;
  /** 진행 중 실행 id(`/ws/runs/current`·헬스용). 없으면 null. */
  currentRunId(): string | null;
  /** 진행 중 세션이 끝날 때까지 대기(테스트·종료 처리). */
  idle(): Promise<void>;
}
