import { VIOLATION_PHASES } from '../events/phases';
import type { Recording, RunEvent } from '../events/types';
import { computeGaps, type Gap } from './compression';
import { computeAutoStops, type AutoStop } from './stops';

export interface Counters {
  violations: number;
  conflicts: number;
  retries: number;
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
}

export function prepare(recording: Recording): Prepared {
  const events = recording.events
    .map((e, i) => ({ e, i }))
    .sort((x, y) => x.e.t - y.e.t || x.i - y.i)
    .map((x) => x.e);
  const last = events[events.length - 1];
  const total = Math.max(recording.meta.durationMs, last ? last.t : 0);
  const c: Counters = { violations: 0, conflicts: 0, retries: 0 };
  const cumulative = events.map((e) => {
    if (VIOLATION_PHASES.has(e.phase)) c.violations++;
    if (e.phase === 'conflict') c.conflicts++;
    if (e.phase === 'retry') c.retries++;
    return { ...c };
  });
  return {
    recording,
    events,
    cumulative,
    total,
    gaps: computeGaps(
      events.map((e) => e.t),
      total,
    ),
    stops: computeAutoStops(events),
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

const ZERO: Counters = { violations: 0, conflicts: 0, retries: 0 };

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
