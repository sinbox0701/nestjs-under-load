import type { Phase, Recording } from './types';

/** 상태 색(DESIGN_SYSTEM §1.2). 색 하나로 상태를 전하지 않으므로 label·icon과 함께 쓴다. */
export type Tone = 'ok' | 'wait' | 'bad' | 'retry' | 'info' | 'neutral';

/** 타임라인 종류 필터 묶음(DESIGN_SYSTEM §4.9). */
export type PhaseGroup =
  | 'arrive'
  | 'io'
  | 'lock'
  | 'conflict'
  | 'retry'
  | 'commit'
  | 'lost'
  | 'other'
  // 2026-10-07 추가(G01 시안): 읽기·버전, 사람 편집 시간
  | 'read'
  | 'edit';

/** 타임라인 종류 필터 목록(시안 순서). key = "핵심만" 보기의 기본 묶음. */
export const PHASE_GROUPS: readonly { id: PhaseGroup; label: string; tone: Tone }[] = [
  { id: 'arrive', label: '요청·응답', tone: 'info' },
  { id: 'read', label: '읽기·버전', tone: 'neutral' },
  { id: 'edit', label: '편집', tone: 'neutral' },
  { id: 'io', label: '쓰기', tone: 'neutral' },
  { id: 'lock', label: '락·잠금', tone: 'wait' },
  { id: 'conflict', label: '409', tone: 'bad' },
  { id: 'retry', label: '재시도', tone: 'retry' },
  { id: 'commit', label: '커밋', tone: 'ok' },
  { id: 'lost', label: '잃어버린 수정', tone: 'bad' },
  { id: 'other', label: '기타', tone: 'neutral' },
];

export interface PhaseInfo {
  label: string;
  tone: Tone;
  group: PhaseGroup;
  /** "핵심만" 보기에 포함. */
  key: boolean;
  /** 자동 멈춤 대상(충돌·잃어버린 수정·락 대기 시작). */
  autoStop: boolean;
}

const P = (
  label: string,
  tone: Tone,
  group: PhaseGroup,
  key = false,
  autoStop = false,
): PhaseInfo => ({ label, tone, group, key, autoStop });

const TABLE: Partial<Record<Phase, PhaseInfo>> = {
  arrived: P('도착', 'info', 'arrive'),
  responded: P('응답', 'neutral', 'arrive'),
  rejected: P('즉시 거절', 'bad', 'conflict', true),
  db_read: P('읽기', 'neutral', 'io'),
  db_write: P('쓰기', 'neutral', 'io'),
  sql: P('SQL', 'neutral', 'io'),
  lock_wait: P('락 대기', 'wait', 'lock', true, true),
  lock_acquired: P('락 획득', 'info', 'lock', true),
  lock_released: P('락 해제', 'neutral', 'lock', true),
  lock_timeout: P('락 타임아웃', 'bad', 'lock', true),
  conflict: P('충돌 409', 'bad', 'conflict', true, true),
  failed: P('실패', 'bad', 'conflict', true),
  rolled_back: P('롤백', 'bad', 'conflict', true),
  retry: P('재시도', 'retry', 'retry', true),
  committed: P('커밋', 'ok', 'commit', true),
  'custom:lost_update': P('잃어버린 수정', 'bad', 'lost', true, true),
  injected_delay: P('주입됨', 'info', 'other'),
  // 2026-10-07 추가(G01 edit-lease·편집, DESIGN §10.3.1 자동 멈춤 목록)
  lease_expired: P('TTL 만료', 'wait', 'lock', true, true),
  'custom:editing': P('편집(사람)', 'neutral', 'edit'),
  'custom:lease_rejected': P('423 거절', 'wait', 'lock', true),
  'custom:holder_left': P('보유자 이탈', 'bad', 'lock', true, true),
  'custom:holder_paused': P('보유자 멈춤', 'bad', 'lock', true, true),
  // G02 재고 차감: 원장 성공 수량이 시작 재고를 넘은 순간(판정은 원장, 표시용)
  'custom:oversold': P('초과 판매', 'bad', 'lost', true),
  // G02 품절: 정상 거절(재고 0, 409). 충돌·실패로 세지 않는다.
  'custom:sold_out': P('품절', 'wait', 'conflict', true),
};

export function phaseInfo(phase: Phase): PhaseInfo {
  return TABLE[phase] ?? P(phase, 'neutral', 'other');
}

/** 기록의 phase 덮어쓰기(Recording.phases)를 반영한 phaseInfo. */
export function phaseInfoFor(rec: Pick<Recording, 'phases'> | null | undefined) {
  const over = rec?.phases;
  if (!over) return phaseInfo;
  return (phase: Phase): PhaseInfo => {
    const o = over[phase];
    return o ? { ...phaseInfo(phase), ...o } : phaseInfo(phase);
  };
}

/** 정합성 위반으로 세는 phase(표시용 누적값. 판정은 DB 원장 기준, DESIGN §3-1). */
export const VIOLATION_PHASES: ReadonlySet<Phase> = new Set<Phase>(['custom:lost_update']);
