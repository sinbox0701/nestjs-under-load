/**
 * 서버 속 라이브(화면 4)의 상태. WS 메시지를 접어서(reduce) 만든다.
 * `current` 구독은 실행이 바뀔 때 별도 알림이 없고 새 runId 를 실은 첫 메시지로 바뀐다(T-112).
 * 그래서 메시지의 runId 가 지금 보던 것과 다르면 타임라인·풀·프로브를 모두 비우고 새로 시작한다.
 */
import type { InvariantResult, ProbeData, SessionState, WireEventV0, WsMessage } from '../../api';

/** 타임라인에 쌓아 두는 최대 이벤트 수(오래된 것부터 버린다). */
export const MAX_EVENTS = 5000;

export interface PoolSnapshot {
  total: number;
  idle: number;
  waiting: number;
}

export interface LiveStatus {
  step: string;
  state: SessionState;
  repetition: number;
  progress: { done: number; total: number };
}

export interface LiveState {
  runId: string | null;
  /** 이미 지나간 runId 들. 이들의 늦은 메시지는 버린다. */
  past: string[];
  events: WireEventV0[];
  /** 인스턴스별 최신 풀 상태. */
  pools: Record<string, PoolSnapshot>;
  probe: ProbeData | null;
  status: LiveStatus | null;
  invariants: InvariantResult[];
  end: { valid: boolean; reasons: string[] } | null;
}

export const initialLive: LiveState = {
  runId: null,
  past: [],
  events: [],
  pools: {},
  probe: null,
  status: null,
  invariants: [],
  end: null,
};

export function liveReduce(prev: LiveState, msg: WsMessage): LiveState {
  // 새 runId 의 첫 메시지: 이전 실행의 화면 상태를 모두 버린다.
  if (prev.past.includes(msg.runId)) return prev;
  const s: LiveState =
    prev.runId !== null && prev.runId !== msg.runId
      ? { ...initialLive, runId: msg.runId, past: [...prev.past, prev.runId] }
      : { ...prev, runId: msg.runId };
  switch (msg.type) {
    case 'events': {
      const events = s.events.concat(msg.data);
      return { ...s, events: events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events };
    }
    case 'pool': {
      const { instance, total, idle, waiting } = msg.data;
      return { ...s, pools: { ...s.pools, [instance]: { total, idle, waiting } } };
    }
    case 'probe':
      return { ...s, probe: msg.data };
    case 'status':
      return {
        ...s,
        status: {
          step: msg.data.step,
          state: msg.data.state,
          repetition: msg.data.repetition,
          progress: msg.data.progress,
        },
      };
    case 'invariants':
      return { ...s, invariants: msg.data };
    case 'end':
      return { ...s, end: msg.data };
    default:
      return s;
  }
}

/** actor 는 `<VU>-<반복>` 이다(loadtest/lib/headers.mjs). "대표 N명"의 N = 서로 다른 VU 수. */
export function sampleCount(events: readonly WireEventV0[]): number {
  return new Set(events.map((e) => e.actor.split('-')[0])).size;
}

/** 풀 게이지 값. 활성 = 전체 - 유휴. */
export function poolView(p: PoolSnapshot) {
  const active = Math.max(0, p.total - p.idle);
  return { active, idle: p.idle, waiting: p.waiting, total: p.total };
}

export interface BlockNode {
  pid: number;
  depth: number;
  /** 이 세션이 막고 있는 것의 뿌리인지(자신은 막히지 않음). */
  root: boolean;
}

/**
 * 락 차단 트리를 들여쓰기 깊이가 붙은 평면 목록(깊이 우선)으로 만든다.
 * blocking 항목 {pid, blockedBy} 는 "pid 가 blockedBy 에게 막혀 있다"이다.
 * 뿌리 = 남을 막지만 자신은 막히지 않은 세션. 교착(순환)은 경로 안에서 한 번만 방문한다.
 */
export function blockTree(probe: ProbeData): BlockNode[] {
  const blockedBy = new Map<number, number[]>();
  for (const b of probe.blocking) blockedBy.set(b.pid, b.blockedBy);
  const children = new Map<number, number[]>();
  for (const [pid, by] of blockedBy)
    for (const blocker of by) children.set(blocker, [...(children.get(blocker) ?? []), pid]);
  const roots = [...children.keys()].filter((p) => !blockedBy.has(p)).sort((a, b) => a - b);
  // 순환만 있는 교착이면 뿌리가 없다. 막는 쪽 하나를 뿌리처럼 잡아 보여 준다.
  if (roots.length === 0 && children.size > 0) roots.push(Math.min(...children.keys()));
  const out: BlockNode[] = [];
  const walk = (pid: number, depth: number, path: ReadonlySet<number>) => {
    out.push({ pid, depth, root: depth === 0 });
    for (const c of (children.get(pid) ?? []).slice().sort((a, b) => a - b))
      if (!path.has(c)) walk(c, depth + 1, new Set(path).add(c));
  };
  for (const r of roots) walk(r, 0, new Set([r]));
  return out;
}
