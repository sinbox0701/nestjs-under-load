import { VIOLATION_PHASES, phaseInfoFor, type PhaseInfo } from '../events/phases';
import type { Phase, Recording, RoundInfo, RunEvent, ServerSnapshot } from '../events/types';
import { computeGaps, type Gap } from './compression';
import { AUTO_STOP_DELAY } from './constants';
import { computeAutoStops, isAutoEvent, type AutoStop } from './stops';

export interface Counters {
  violations: number;
  conflicts: number;
  retries: number;
  /** 즉시 거절(423·429·503) 수. prepare가 늘 채운다(선택 필드는 하위 호환용). */
  rejects?: number;
  /** 품절 응답(custom:sold_out) 수. 충돌·실패와 따로 센다. prepare가 늘 채운다. */
  soldOut?: number;
}

const REJECT_PHASES: ReadonlySet<Phase> = new Set<Phase>(['rejected', 'custom:lease_rejected']);

export interface PrepareOptions {
  /** 원인 장면 멈춤(이벤트 cause)을 켤지. 기본 켬. */
  cause?: boolean;
}

/** 재생용으로 한 번 계산해 두는 기록. 이후 모든 화면 상태는 P의 함수다. */
export interface Prepared {
  recording: Recording;
  /** t 오름차순(같은 t는 원래 순서 유지). */
  events: RunEvent[];
  /** events[i]까지 포함한 누적값. */
  cumulative: Counters[];
  total: number;
  gaps: Gap[];
  stops: AutoStop[];
  /** 기록의 phase 덮어쓰기를 반영한 phaseInfo. */
  info: (phase: Phase) => PhaseInfo;
  /** 자동 멈춤이 이벤트 뒤 몇 ms에 서는가. */
  delay: number;
  /** 원인 멈춤 켬 여부(stops 계산에 쓴 값). */
  cause: boolean;
  /** 라운드 경계. 기록에 없으면 전체가 한 라운드. */
  rounds: RoundInfo[];
}

/** 자동 멈춤 판정 함수(기록 설정 + 원인 토글). */
export function autoTest(p: Pick<Prepared, 'info' | 'cause'>) {
  return (_phase: Phase, e: RunEvent) => isAutoEvent(e, p.info, p.cause);
}

/** 원인 토글만 바꿔 멈춤 지점을 다시 계산한다(나머지는 그대로). */
export function withCause(p: Prepared, cause: boolean): Prepared {
  if (p.cause === cause) return p;
  const next = { ...p, cause };
  return { ...next, stops: computeAutoStops(p.events, autoTest(next), p.delay) };
}

export function prepare(recording: Recording, opts: PrepareOptions = {}): Prepared {
  const events = recording.events
    .map((e, i) => ({ e, i }))
    .sort((x, y) => x.e.t - y.e.t || x.i - y.i)
    .map((x) => x.e);
  const last = events[events.length - 1];
  const total = Math.max(recording.meta.durationMs, last ? last.t : 0);
  const c: Counters = { violations: 0, conflicts: 0, retries: 0, rejects: 0, soldOut: 0 };
  const cumulative = events.map((e) => {
    if (e.phase === 'custom:sold_out') c.soldOut = (c.soldOut ?? 0) + 1;
    if (VIOLATION_PHASES.has(e.phase)) c.violations++;
    if (e.phase === 'conflict') c.conflicts++;
    if (e.phase === 'retry') c.retries++;
    if (REJECT_PHASES.has(e.phase)) c.rejects = (c.rejects ?? 0) + 1;
    return { ...c };
  });
  const info = phaseInfoFor(recording);
  const cause = opts.cause ?? true;
  const delay = recording.meta.autoStopDelayMs ?? AUTO_STOP_DELAY;
  const rounds = recording.rounds?.length
    ? recording.rounds
    : [{ index: 0, start: 0, end: total, baseVersion: 0, endVersion: 0 }];
  return {
    recording,
    events,
    cumulative,
    total,
    gaps: computeGaps(
      events.map((e) => e.t),
      total,
    ),
    stops: computeAutoStops(events, autoTest({ info, cause }), delay),
    info,
    delay,
    cause,
    rounds,
  };
}

/** P가 속한 라운드(라운드 시작 ≤ P인 마지막 라운드). */
export function roundAt(p: Pick<Prepared, 'rounds'>, P: number): RoundInfo {
  const rs = p.rounds;
  for (let i = rs.length - 1; i >= 0; i--) if (P >= rs[i]!.start) return rs[i]!;
  return rs[0]!;
}

/**
 * 서버 속 상태 = f(P): 같은 라운드에서 P 이하 마지막 스냅샷. 세션은 P에 살아 있는 것만 남긴다.
 * 스냅샷이 없는 기록이면 null.
 */
export function serverAt(p: Prepared, P: number): ServerSnapshot | null {
  const rd = roundAt(p, P);
  for (let i = upperBound(p.events, P) - 1; i >= 0; i--) {
    const e = p.events[i]!;
    if (e.t < rd.start) break;
    if (e.server) {
      return {
        ...e.server,
        sessions: e.server.sessions.filter((s) => s.until === null || s.until > P),
      };
    }
  }
  if (!p.recording.events.some((e) => e.server)) return null;
  return {
    version: rd.baseVersion,
    content: null,
    rowLock: null,
    sessions: [],
    pool: { size: 10, crowd: 0 },
  };
}

/** P 이하 이벤트 수(이진 탐색). */
export function upperBound(events: readonly RunEvent[], P: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (events[m]!.t <= P) lo = m + 1;
    else hi = m;
  }
  return lo;
}

const ZERO: Counters = { violations: 0, conflicts: 0, retries: 0, rejects: 0, soldOut: 0 };

export interface PlaybackSnapshot {
  P: number;
  /** P 이하 마지막 이벤트. */
  last: RunEvent | null;
  counters: Counters;
  /** P 이하 마지막 SQL 샘플. */
  lastSql: RunEvent | null;
}

/** 화면 공통 상태 = f(P). 되감아도 같은 값이 나온다. */
export function snapshotAt(p: Prepared, P: number): PlaybackSnapshot {
  const n = upperBound(p.events, P);
  let lastSql: RunEvent | null = null;
  for (let i = n - 1; i >= 0; i--) {
    if (p.events[i]!.sql) {
      lastSql = p.events[i]!;
      break;
    }
  }
  return {
    P,
    last: n > 0 ? p.events[n - 1]! : null,
    counters: n > 0 ? p.cumulative[n - 1]! : ZERO,
    lastSql,
  };
}
