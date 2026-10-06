import type { Phase, Recording, RunEvent } from '../events/types';
import type { StageInput } from './events';

/** 테스트·미리보기용 작은 기록 빌더(실측 아님). */
export function rec(
  opts: {
    sceneType?: string;
    strategy?: string;
    actors?: string[];
    totalActors?: number;
    durationMs?: number;
    actorInstances?: Record<string, string>;
  },
  events: [t: number, actor: string, phase: Phase, rest?: Partial<RunEvent>][],
): Recording {
  const actors = opts.actors ?? ['A', 'B'];
  const evs: RunEvent[] = events.map(([t, actor, phase, rest], i) => ({
    id: `e${i + 1}`,
    t,
    actor,
    phase,
    ...rest,
  }));
  const last = evs[evs.length - 1]?.t ?? 0;
  return {
    meta: {
      runId: 'test',
      pack: 'generic',
      scenario:
        opts.sceneType === 'queue-at-counter' ? 'g02-stock-decrement' : 'g01-shared-document',
      scenarioTitle:
        opts.sceneType === 'queue-at-counter' ? '재고 차감 경합' : '같은 문서 동시 수정',
      strategy: { id: opts.strategy ?? 'naive-overwrite', label: '테스트', kind: 'broken' },
      sceneType: opts.sceneType ?? 'shared-document',
      actors,
      totalActors: opts.totalActors ?? actors.length,
      isolation: 'READ COMMITTED',
      route: 'PUT /documents/7',
      durationMs: opts.durationMs ?? last + 40,
      ...(opts.actorInstances ? { actorInstances: opts.actorInstances } : {}),
    },
    events: evs,
  };
}

export function inputOf(r: Recording): StageInput {
  const events = [...r.events].sort((a, b) => a.t - b.t);
  return {
    meta: r.meta,
    events,
    total: Math.max(r.meta.durationMs, events[events.length - 1]?.t ?? 0),
    ...(r.rounds ? { rounds: r.rounds } : {}),
    ...(r.txBands ? { txBands: r.txBands } : {}),
    ...(r.txMarks ? { txMarks: r.txMarks } : {}),
  };
}
