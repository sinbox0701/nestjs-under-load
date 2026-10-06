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
}

/** 무대에 붙는 코드 원문(웹 빌드 때 번들되는 strategy 소스, DESIGN §10.3.2). */
export interface CodeSource {
  path: string;
  lang: 'ts';
  source: string;
  /** 예시 코드면 화면에 "예시" 표기. */
  example: boolean;
}

export interface Recording {
  meta: RecordingMeta;
  /** t 오름차순. */
  events: RunEvent[];
  code?: CodeSource;
}

export function parseCodeRef(ref: CodeRef): { path: string; line: number } {
  const i = ref.lastIndexOf(':');
  return { path: ref.slice(0, i), line: Number(ref.slice(i + 1)) };
}
