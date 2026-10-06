import type { Phase } from './types';

/** 상태 색(DESIGN_SYSTEM §1.2). 색 하나로 상태를 전하지 않으므로 label·icon과 함께 쓴다. */
export type Tone = 'ok' | 'wait' | 'bad' | 'retry' | 'info' | 'neutral';

/** 타임라인 종류 필터 묶음(DESIGN_SYSTEM §4.9). */
export type PhaseGroup =
  'arrive' | 'io' | 'lock' | 'conflict' | 'retry' | 'commit' | 'lost' | 'other';

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
};

export function phaseInfo(phase: Phase): PhaseInfo {
  return TABLE[phase] ?? P(phase, 'neutral', 'other');
}

/** 정합성 위반으로 세는 phase(표시용 누적값. 판정은 DB 원장 기준, DESIGN §3-1). */
export const VIOLATION_PHASES: ReadonlySet<Phase> = new Set<Phase>(['custom:lost_update']);
