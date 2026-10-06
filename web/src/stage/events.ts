import type { RecordingMeta, RoundInfo, RunEvent, TxBand, TxMark } from '../events/types';
import { STAGE_PER_REAL } from '../playback/constants';

/**
 * 무대가 읽는 이벤트 입력. `Prepared`(playback)가 그대로 맞는다:
 * `{ meta: prepared.recording.meta, events: prepared.events, total: prepared.total }`.
 */
export interface StageInput {
  meta: RecordingMeta;
  /** t 오름차순. */
  events: readonly RunEvent[];
  /** 기록 길이(실제 ms). */
  total: number;
  /** 라운드 경계(Recording.rounds). 없으면 이벤트의 round 필드, 그것도 없으면 전체가 한 라운드. */
  rounds?: readonly RoundInfo[];
  /** 트랜잭션 띠(Recording.txBands·txMarks) — 타임라인과 같은 데이터. 없으면 이벤트로 계산한다. */
  txBands?: readonly TxBand[];
  txMarks?: readonly TxMark[];
}

/** Prepared(재생 엔진) → 무대 입력. */
export function stageInputOf(p: {
  recording: {
    meta: RecordingMeta;
    rounds?: readonly RoundInfo[];
    txBands?: readonly TxBand[];
    txMarks?: readonly TxMark[];
  };
  events: readonly RunEvent[];
  total: number;
}): StageInput {
  const r = p.recording;
  return {
    meta: r.meta,
    events: p.events,
    total: p.total,
    ...(r.rounds?.length ? { rounds: r.rounds } : {}),
    ...(r.txBands?.length ? { txBands: r.txBands } : {}),
    ...(r.txMarks?.length ? { txMarks: r.txMarks } : {}),
  };
}

/** 무대 ms → 실제 ms. 시안(mockup.html)의 상수는 무대 ms로 적혀 있다. */
export const sm = (stageMs: number): number => stageMs / STAGE_PER_REAL;

/**
 * 무대가 아는 장면 동작 이름. `custom:` 접두사는 떼고, 같은 뜻의 이름은 하나로 모은다.
 * (예: `custom:lost_update`·`lost` → `lost`)
 */
export type StagePhase =
  | 'arrived'
  | 'db_read'
  | 'editing'
  | 'db_write'
  | 'lock_wait'
  | 'committed'
  | 'lost'
  | 'conflict'
  | 'retry'
  | 'lock_acquired'
  | 'lease_rejected'
  | 'lock_released'
  | 'holder_left'
  | 'holder_paused'
  | 'lease_expired'
  | 'responded'
  | 'lock_timeout'
  | 'failed'
  | 'rolled_back'
  | 'oversold'
  | 'sold_out'
  | 'other';

const ALIAS: Record<string, StagePhase> = {
  arrived: 'arrived',
  db_read: 'db_read',
  editing: 'editing',
  db_write: 'db_write',
  lock_wait: 'lock_wait',
  committed: 'committed',
  lost_update: 'lost',
  lost: 'lost',
  conflict: 'conflict',
  retry: 'retry',
  lock_acquired: 'lock_acquired',
  lease_rejected: 'lease_rejected',
  lock_released: 'lock_released',
  holder_left: 'holder_left',
  holder_paused: 'holder_paused',
  lease_expired: 'lease_expired',
  responded: 'responded',
  lock_timeout: 'lock_timeout',
  failed: 'failed',
  rolled_back: 'rolled_back',
  oversold: 'oversold',
  oversell: 'oversold',
  sold_out: 'sold_out',
};

export function stagePhase(e: RunEvent): StagePhase {
  const name = e.phase.startsWith('custom:') ? e.phase.slice(7) : e.phase;
  return ALIAS[name] ?? 'other';
}

type AttrValue = string | number | boolean | null | undefined;

function attr(e: RunEvent, keys: readonly string[]): AttrValue {
  const a = e.attrs;
  if (!a) return undefined;
  for (const k of keys) if (a[k] !== undefined && a[k] !== null) return a[k];
  return undefined;
}

/** 숫자 attrs(여러 이름 허용). 숫자 문자열도 받는다. */
export function num(e: RunEvent, ...keys: string[]): number | null {
  const v = attr(e, keys);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function str(e: RunEvent, ...keys: string[]): string | null {
  const v = attr(e, keys);
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
}

export function flag(e: RunEvent, ...keys: string[]): boolean {
  const v = attr(e, keys);
  return v === true || v === 'true' || v === 1;
}

type ActorMeta = Pick<RecordingMeta, 'actors' | 'actorLabels'>;

/**
 * actor를 가리키는 attrs → 대표 순번. 값은 actor id, 화면 이름표(meta.actorLabels 또는 A·B…),
 * 대표 순번 숫자 중 무엇이든 받는다.
 */
export function actorRef(e: RunEvent, meta: ActorMeta, ...keys: string[]): number | null {
  const v = attr(e, keys);
  const ids = meta.actors;
  if (typeof v === 'string') {
    const i = ids.indexOf(v);
    if (i >= 0) return i;
    const byLabel = actorLabels(meta).indexOf(v);
    return byLabel >= 0 ? byLabel : null;
  }
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < ids.length) return v;
  return null;
}

/** 대표 actor 이름표: meta.actorLabels가 있으면 그것, 없으면 A, B, C … */
export function actorLabels(meta: ActorMeta): string[] {
  const d = defaultLabels(meta.actors.length);
  return meta.actors.map((id, i) => meta.actorLabels?.[id] ?? d[i]!);
}

/** 라운드 하나: 같은 라운드의 이벤트만 접어서 장면을 만든다(라운드마다 무대가 새로 시작). */
export interface Round {
  index: number;
  /** 라운드 시작(실제 ms) = 그 라운드 첫 이벤트 시각. */
  start: number;
  /** 다음 라운드 시작 또는 기록 끝. */
  end: number;
  events: RunEvent[];
  /** 라운드 시작 버전(Recording.rounds가 주면). */
  baseVersion: number | null;
}

/** 이벤트의 라운드 번호: RunEvent.round > attrs.round. */
export function roundNo(e: RunEvent): number | null {
  return typeof e.round === 'number' ? e.round : num(e, 'round');
}

const roundCache = new WeakMap<readonly RunEvent[], Round[]>();

/**
 * `attrs.round`(0부터)로 라운드를 나눈다. 없으면 기록 전체가 한 라운드다.
 * 라운드 번호가 없는 이벤트는 앞 이벤트의 라운드를 따른다.
 */
export function roundsOf(input: StageInput): Round[] {
  const cached = roundCache.get(input.events);
  if (cached && cached.length && cached[cached.length - 1]!.end === input.total) return cached;
  if (input.rounds?.length) {
    const rs = [...input.rounds].sort((a, b) => a.start - b.start);
    const tagged = input.events.some((e) => roundNo(e) !== null);
    const out: Round[] = rs.map((ri, k) => ({
      index: ri.index,
      start: ri.start,
      end: k + 1 < rs.length ? rs[k + 1]!.start : Math.max(ri.end, input.total),
      baseVersion: ri.baseVersion,
      events: [],
    }));
    for (const e of input.events) {
      const no = tagged ? roundNo(e) : null;
      const r = (no !== null ? out.find((x) => x.index === no) : undefined) ?? roundAt(out, e.t);
      r.events.push(e);
    }
    roundCache.set(input.events, out);
    return out;
  }
  const byIdx = new Map<number, RunEvent[]>();
  let cur = 0;
  for (const e of input.events) {
    const r = roundNo(e);
    if (r !== null) cur = r;
    let list = byIdx.get(cur);
    if (!list) byIdx.set(cur, (list = []));
    list.push(e);
  }
  const idx = [...byIdx.keys()].sort((a, b) => a - b);
  const rounds: Round[] = idx.map((i) => {
    const events = byIdx.get(i)!;
    return { index: i, start: events[0]!.t, end: input.total, events, baseVersion: null };
  });
  if (rounds.length === 0)
    rounds.push({ index: 0, start: 0, end: input.total, events: [], baseVersion: null });
  rounds[0]!.start = Math.min(0, rounds[0]!.start);
  for (let k = 0; k + 1 < rounds.length; k++) rounds[k]!.end = rounds[k + 1]!.start;
  roundCache.set(input.events, rounds);
  return rounds;
}

/** P가 속한 라운드(P 이하에서 시작한 마지막 라운드). */
export function roundAt(rounds: readonly Round[], P: number): Round {
  for (let i = rounds.length - 1; i >= 0; i--) if (P >= rounds[i]!.start) return rounds[i]!;
  return rounds[0]!;
}

/** 이 이벤트가 속한 라운드. */
export function roundOfEvent(rounds: readonly Round[], e: RunEvent): Round {
  for (const r of rounds) if (r.events.includes(e)) return r;
  return roundAt(rounds, e.t);
}

/** 대표 actor 이름표. 기본 A, B, C … */
export function defaultLabels(n: number): string[] {
  return Array.from({ length: n }, (_, i) => String.fromCharCode(65 + (i % 26)));
}

export function labelOf(labels: readonly string[], i: number | null | undefined): string {
  if (i === null || i === undefined || i < 0) return '?';
  return labels[i] ?? String.fromCharCode(65 + (i % 26));
}

/** 실제 ms 표기(소수 한 자리). */
export function fmtReal(ms: number): string {
  return (Math.round(ms * 10) / 10).toFixed(1);
}
