import type { PhaseGroup, Tone } from './phases';

/**
 * 이벤트 기록 타입.
 *
 * 원본 프로토콜은 DESIGN §9.1(LabEvent, epoch µs `ts` + 인스턴스별 `seq`)이다.
 * 화면은 그 스트림을 "기록"(Recording)으로 받아 재생하므로, 여기서는 기록 시작부터의
 * 실제 경과 ms(`t`)로 정규화한 형태만 다룬다. 정규화는 api 계층(나중)의 일이다.
 */

/** DESIGN §9.1 공통 phase 목록. */
export const COMMON_PHASES = [
  'arrived',
  'rejected',
  'lock_wait',
  'lock_acquired',
  'lock_released',
  'lock_timeout',
  'conflict',
  'retry',
  'db_read',
  'db_write',
  'committed',
  'rolled_back',
  'failed',
  'responded',
  'enqueued',
  'dequeued',
  'lease_expired',
  'published',
  'consumed',
  'cache_hit',
  'cache_miss',
  'injected_delay',
  'sql',
] as const;

export type CommonPhase = (typeof COMMON_PHASES)[number];
/** 시나리오 확장 phase(무대 매핑에 선언 필요). 예: `custom:lost_update`. */
export type CustomPhase = `custom:${string}`;
export type Phase = CommonPhase | CustomPhase;

/**
 * 코드 위치: 시나리오 팩 기준 상대 경로 + 줄 번호(DESIGN §10.3.2).
 * 예: `packs/generic/g01-concurrent-edit/strategies/naive-overwrite.strategy.ts:24`
 */
export type CodeRef = `${string}:${number}`;

export interface RunEvent {
  /** 기록 안에서 유일한 id(원본의 instance + seq로 만든다). */
  id: string;
  /** 기록 시작부터의 실제 경과 ms(재생 시간이 아님). */
  t: number;
  /** X-Lab-Actor 값. 화면은 대표 actor만 받는다. */
  actor: string;
  phase: Phase;
  codeRef?: CodeRef;
  /** 그 순간 나간 SQL 샘플(파라미터는 `$n`으로 마스킹). */
  sql?: string;
  /** 영향 행 수(예: UPDATE … AND version = $2 → 0). */
  rows?: number;
  /** 사람이 읽는 한 줄 설명. */
  note?: string;
  /** 요청 단위 id(같은 actor의 재시도를 구분). */
  reqId?: string;
  /** 구간 종료 이벤트의 소요 ms. */
  durMs?: number;
  /** 인위 지연 등 개입이 걸린 이벤트(화면에 "주입됨"). */
  injected?: boolean;
  /** phase별 부가 값(읽은 버전, 덮어쓴 actor 등). */
  attrs?: Record<string, string | number | boolean | null>;

  // ── 이하 선택 필드(무대 이식 2026-10-07 추가). 없으면 화면은 기존 방식으로 동작한다. ──

  /** 라운드 번호(0부터). Recording.rounds와 짝. */
  round?: number;
  /** 자동 멈춤 대상 여부. 주면 phase 기본값(phaseInfo.autoStop)보다 우선한다. */
  autoStop?: boolean;
  /** 원인 장면 멈춤(예: 같은 버전 두 번째 수신). autoStop이어도 "원인 멈춤" 토글이 꺼지면 서지 않는다. */
  cause?: boolean;
  /** 자동 멈춤 묶기 키: 같은 phase라도 키가 다르면 따로 선다(예: 409 경로 recheck/lockVersion/again). */
  stopKey?: string;
  /** 타임라인 행 묶기 키: 같은 phase라도 키가 다르면 따로 묶는다(예: 라운드·사람별). */
  mergeKey?: string;
  /** codeRef 줄의 마커 id(G01 시안 코드의 ⟦tag⟧, G02 소스의 `// @event` phase 등). */
  marker?: string;
  /** 함께 옅게 강조할 줄의 마커 id. */
  markerAlso?: string[];
  /** 코드 줄 강조 색(없으면 phase 색). */
  codeTone?: Tone;
  /**
   * SQL 상자 줄들: 문장, `→ 결과`, `-- 주석`, `⧗ 대기`, `begin`/`commit`/`rollback`.
   * `sql`은 이 중 대표 문장 하나다.
   */
  sqlLines?: string[];
  /** 코드 패널 한 줄 설명(rich text, scenarios/rich.ts 형식). */
  codeNote?: string;
  /** 자동 멈춤 설명(rich text). 멈춤 묶음의 첫 이벤트 것을 쓴다. */
  callout?: string;
  /** 이 이벤트 직후의 서버 속 상태(라운드 안에서 유효). */
  server?: ServerSnapshot;
}

/** 서버 속 패널 스냅샷. 시각은 기록 시작부터의 실제 ms. */
export interface ServerSnapshot {
  /** 문서/행의 DB 버전(또는 재고 값 등 대표 값). */
  version: number;
  /** 지금 DB에 저장된 내용의 주인(예: 'A'), 없으면 원본. */
  content?: string | null;
  /** DB 행 락: 보유자와 대기자. */
  rowLock: { holder: string; waiters: string[] } | null;
  /** 편집 잠금(lease, DB 칼럼). */
  lease?: {
    holder: string;
    fence: number;
    expired: boolean;
    /** 보유자 클라이언트 상태. */
    holderState?: 'ok' | 'left' | 'paused';
  } | null;
  /** 잠금을 잃은 줄 모르고 멈춘 옛 보유자. */
  stale?: string | null;
  /** 423을 받고 문 밖에서 다시 노크하는 사람(서버 큐 아님). */
  outside?: string[];
  /** 앱 메모리 락(G02 app-memory-lock): 인스턴스별 보유자·대기열. */
  memLocks?: { instance: string; holder: string | null; queue: string[] }[];
  /** DB 세션(대표 actor). until이 null이면 다음 스냅샷까지 열려 있다. */
  sessions: ServerSession[];
  /** 커넥션 풀: 대표 외 다른 요청이 쓰는 커넥션 수(crowd). 활성 = 살아 있는 세션 + crowd. */
  pool: { size: number; crowd: number };
}

export interface ServerSession {
  actor: string;
  /** pid 표시용. */
  pid: number;
  /**
   * pg_stat_activity state. idle_in_transaction = 트랜잭션을 연 채 문장 사이(앱이 일하는 중).
   * 없거나 'active'인데 sql이 없으면 화면이 추정한다.
   */
  state: 'active' | 'lock_wait' | 'idle_in_transaction';
  sql?: string;
  since: number;
  until: number | null;
}

/** 라운드 경계(실제 ms). */
export interface RoundInfo {
  index: number;
  start: number;
  end: number;
  baseVersion: number;
  endVersion: number;
}

/** 요청별 트랜잭션 경계 띠(DESIGN §10.3). 시각은 기록 시작부터의 실제 ms. */
export type TxBandKind =
  | 'read' // 자동 커밋 SELECT
  | 'edit' // 사람 시간(압축)
  | 'tx' // begin … commit
  | 'tx-rollback' // begin … rollback
  | 'wait' // 행 락 대기(트랜잭션 안)
  | 'autocommit' // 자동 커밋 UPDATE(lease acquire·release)
  | 'lease' // 편집 잠금 보유
  | 'mem-wait' // 앱 메모리 락 대기(G02)
  | 'injected'; // 주입 지연(G02)

export interface TxBand {
  round?: number;
  actor: string;
  kind: TxBandKind;
  start: number;
  end: number;
  tip: string;
}

export interface TxMark {
  round?: number;
  actor: string;
  kind: 'ok' | 'bad' | 'wait';
  t: number;
  tip: string;
}

/**
 * 실측 지표(처리량·p95·실패율). 결과 카드의 "실측 영역"에만 보인다.
 * 출처는 실제 실행(run) — 시뮬레이션 기록이면 참고한 실측 표(learn.yaml measured 등)다.
 */
export interface MeasuredMetrics {
  throughputRps: number;
  p95Ms: number;
  /** 실패율 %. */
  failPct: number;
  p95Label: string;
  p95Sub: string;
  throughputSub: string;
  /** 실패율이 무엇을 셌는지(예: k6 드롭은 서버 거절이 아님). */
  failSub: string;
  /** 출처 run id. */
  run: string;
  /** 측정 조건(상황 라벨 등). */
  condition: string;
  /** 출처 한 줄(예: "learn.yaml 실측 3회 중앙값"). */
  source: string;
}

/** 결과 카드 요약(기록 전체, 재생 위치와 무관). */
export interface RunSummary {
  /** 실측 지표. 실측이 없으면 null — 화면은 "— (실측 없음)"이고 생성 규칙으로 수치를 지어내지 않는다. */
  measured: MeasuredMetrics | null;
  /** 부하 모델(지연 해석 주의 문구용). closed = VU 고정, open = 도착률 고정. */
  loadModel?: 'open' | 'closed';
  /** 이하 이 기록(시뮬레이션이면 시뮬레이션)에서 센 값. */
  conflicts: number;
  rejected423: number;
  retries: number;
  /** 품절 응답 수(G02, custom:sold_out). 충돌·실패와 따로 센다. */
  soldOut?: number;
  /** 원장 기반 위반 수(Recording.verdict.violations와 같다). */
  violations: number;
  /** 불변식 한 줄 설명. */
  invariant: string;
  /** 기록 끝 판정 한 줄(통과·위반 이유). */
  invariantSub?: string;
}

/** 원장(서버가 성공 처리한 요청마다 같은 트랜잭션에 쓰는 행). */
export interface LedgerEntry {
  t: number;
  actor: string;
  requestId: string;
  /** G01: 수정 토큰. */
  editToken?: string;
  /** G02: 차감 수량·결과. */
  qty?: number;
  result?: 'success' | 'sold_out';
  txid: number;
  instance?: string;
}

/** 원장으로 낸 판정. 재생과 무관한 기록의 사실이다. */
export interface Verdict {
  /** 위반 수(G01: 원장에 있는데 최종 이력에 없는 토큰 수, G02: 잃어버린 차감 수). */
  violations: number;
  ok: boolean;
  /** 불변식 id → 위반 값(예: sold-equals-decrement: 2). */
  checks: Record<string, number>;
  /** 사람이 읽는 근거. */
  detail: string;
}

/** 이 기록이 무엇인지(실측·시뮬레이션·예시) 화면 고지. */
export interface RecordingNotice {
  kind: 'measured' | 'simulated' | 'example';
  /** 화면에 그대로 보이는 짧은 고지. 예: "시뮬레이션 기록(실측 아님)". */
  label: string;
  /** 자세한 설명. */
  text: string;
  /** 참고한 실측(있으면): run id와 요약. */
  reference?: { run: string | null; summary: string | null; verdict?: string };
  /** 실측과 시뮬레이션의 판정 방향이 다를 때 한 문장(결과 카드에 눈에 띄게 보인다). */
  differs?: string;
}

/** 시계열 표본(이벤트 루프 지연 등). */
export interface Sample {
  t: number;
  v: number;
}

export type StrategyKind = 'broken' | 'fixed' | 'tradeoff';

export interface RecordingMeta {
  runId: string;
  pack: string;
  scenario: string;
  scenarioTitle: string;
  strategy: { id: string; label: string; kind: StrategyKind };
  /** DESIGN §10.3 장면 타입. */
  sceneType: string;
  /** 대표 actor(무대에 그리는 사람) 순서. */
  actors: string[];
  /** 전체 동시 인원(대표 외 포함). */
  totalActors: number;
  isolation: string;
  route: string;
  /** 기록 길이(실제 ms). 마지막 이벤트 뒤 여유 포함. */
  durationMs: number;
  /** 자동 멈춤이 이벤트 뒤 몇 ms에 서는가. 없으면 재생 엔진 기본값(AUTO_STOP_DELAY). 0 = 이벤트 시각. */
  autoStopDelayMs?: number;
  /** actor id → 화면 표시 이름(A, B …). 없으면 actors 순서로 A, B …. */
  actorLabels?: Record<string, string>;
  /** actor id → 처리한 서버 인스턴스(app-1 …). */
  actorInstances?: Record<string, string>;
  /** 기록을 만든 옵션(재현용). */
  options?: Record<string, string | number | boolean>;
  /** 결정적 생성의 seed. */
  seed?: number;
}

/** 무대에 붙는 코드 원문(웹 빌드 때 번들되는 strategy 소스, DESIGN §10.3.2). */
export interface CodeSource {
  path: string;
  lang: 'ts';
  source: string;
  /** 예시 코드면 화면에 "예시" 표기. */
  example: boolean;
  /** 화면 머리줄에 보일 이름(없으면 path). */
  label?: string;
  /** 마커 id → 줄 번호(1부터). */
  markers?: Record<string, number>;
  /** 서비스 클래스 이름(코드 상자 머리줄 "Class.method()"용). */
  className?: string;
  /** 같은 파일에 붙은 클라이언트(k6) 구역의 경로와 시작 줄. */
  clientPath?: string;
  clientFrom?: number;
}

export interface Recording {
  meta: RecordingMeta;
  /** t 오름차순. */
  events: RunEvent[];
  code?: CodeSource;

  // ── 이하 선택 필드(무대 이식 2026-10-07 추가) ──

  /** 라운드 경계. 없으면 기록 전체가 한 라운드. */
  rounds?: RoundInfo[];
  /** 함께 볼 다른 코드(엔티티 등). */
  extraCode?: CodeSource[];
  txBands?: TxBand[];
  txMarks?: TxMark[];
  summary?: RunSummary;
  ledger?: LedgerEntry[];
  verdict?: Verdict;
  notice?: RecordingNotice;
  /** 이벤트 루프 지연 표본(ms). */
  eventLoopLag?: Sample[];
  /** 이 기록의 phase 표시 덮어쓰기(scene.yaml의 phase 매핑에 해당). */
  phases?: Partial<Record<Phase, PhaseInfoOverride>>;
}

/** phases.ts PhaseInfo의 부분 덮어쓰기. */
export interface PhaseInfoOverride {
  label?: string;
  tone?: Tone;
  group?: PhaseGroup;
  key?: boolean;
  autoStop?: boolean;
}

export function parseCodeRef(ref: CodeRef): { path: string; line: number } {
  const i = ref.lastIndexOf(':');
  return { path: ref.slice(0, i), line: Number(ref.slice(i + 1)) };
}
