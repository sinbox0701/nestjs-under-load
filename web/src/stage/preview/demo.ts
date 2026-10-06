import type { Phase, Recording, RunEvent } from '../../events/types';

/**
 * 무대 미리보기용 G02 데모 기록(실측 아님, 손으로 만든 시각). 시나리오 생성기(C)가 G02 기록을 내면
 * 미리보기는 그것으로 바꾼다. 시각은 G01 시안처럼 걷기·대기가 보이게 늘린 값이다.
 */
export type G02DemoStrategy = 'no-lock' | 'row-lock' | 'conditional-update' | 'app-memory-lock';

type Ev = [t: number, actor: string, phase: Phase, attrs?: RunEvent['attrs'], rows?: number];

const LABEL: Record<G02DemoStrategy, string> = {
  'no-lock': '락 없음 (읽고-계산하고-쓰기)',
  'row-lock': '행 잠금 SELECT … FOR UPDATE',
  'conditional-update': '조건부 UPDATE (stock >= qty)',
  'app-memory-lock': '인스턴스 메모리 mutex',
};

function events(s: G02DemoStrategy, instances: 1 | 2): Ev[] {
  const q0 = { initialQty: 3 };
  switch (s) {
    case 'no-lock':
      return [
        [0, 'A', 'arrived', q0],
        [2, 'B', 'arrived'],
        [24, 'A', 'db_read', { qty: 3 }],
        [26, 'B', 'db_read', { qty: 3 }],
        [32, 'A', 'db_write'],
        [34, 'A', 'committed', { qty: 2 }],
        [36, 'B', 'db_write'],
        [38, 'B', 'committed', { qty: 2 }],
        [38.5, 'A', 'custom:oversold', { by: 'B' }],
        [40, 'A', 'responded'],
        [42, 'B', 'responded'],
        [44, 'C', 'arrived'],
        [52, 'D', 'arrived'],
        [66, 'C', 'db_read', { qty: 2 }],
        [72, 'C', 'committed', { qty: 1 }],
        [74, 'D', 'db_read', { qty: 1 }],
        [76, 'C', 'responded'],
        [80, 'D', 'committed', { qty: 0 }],
        [84, 'D', 'responded'],
      ];
    case 'row-lock':
      return [
        [0, 'A', 'arrived', q0],
        [2, 'B', 'arrived'],
        [8, 'C', 'arrived'],
        [18, 'A', 'lock_acquired', { lock: 'row' }],
        [19, 'A', 'db_read', { qty: 3 }],
        [20, 'B', 'lock_wait', { owner: 'A', lock: 'row' }],
        [24, 'C', 'lock_wait', { owner: 'A', lock: 'row' }],
        [28, 'A', 'db_write'],
        [30, 'A', 'committed', { qty: 2 }],
        [30, 'A', 'lock_released'],
        [30.5, 'B', 'lock_acquired', { lock: 'row' }],
        [31, 'B', 'db_read', { qty: 2 }],
        [32, 'A', 'responded'],
        [38, 'B', 'committed', { qty: 1 }],
        [38, 'B', 'lock_released'],
        [38.5, 'C', 'lock_acquired', { lock: 'row' }],
        [39, 'C', 'db_read', { qty: 1 }],
        [40, 'B', 'responded'],
        [40, 'D', 'arrived'],
        [46, 'C', 'committed', { qty: 0 }],
        [46, 'C', 'lock_released'],
        [48, 'C', 'responded'],
        [56, 'D', 'lock_acquired', { lock: 'row' }],
        [57, 'D', 'db_read', { qty: 0 }],
        [58, 'D', 'custom:sold_out', { reason: 'sold_out' }, 0],
        [58.5, 'D', 'lock_released'],
        [60, 'D', 'responded'],
      ];
    case 'conditional-update':
      return [
        [0, 'A', 'arrived', q0],
        [2, 'B', 'arrived'],
        [8, 'C', 'arrived'],
        [26, 'A', 'db_write'],
        [27, 'B', 'db_write'],
        [27.5, 'B', 'lock_wait', { owner: 'A', lock: 'row' }],
        [28, 'A', 'committed', { qty: 2 }],
        [29, 'B', 'committed', { qty: 1 }],
        [30, 'A', 'responded'],
        [31, 'B', 'responded'],
        [32, 'C', 'db_write'],
        [33, 'C', 'committed', { qty: 0 }],
        [34, 'D', 'arrived'],
        [35, 'C', 'responded'],
        [58, 'D', 'db_write'],
        [59, 'D', 'conflict', { reason: 'sold_out' }, 0],
        [61, 'D', 'responded'],
      ];
    case 'app-memory-lock':
      if (instances === 1)
        return [
          [0, 'A', 'arrived', q0],
          [2, 'B', 'arrived'],
          [18, 'A', 'lock_acquired', { lock: 'memory' }],
          [19, 'A', 'db_read', { qty: 3 }],
          [20, 'B', 'lock_wait', { owner: 'A', lock: 'memory' }],
          [26, 'A', 'committed', { qty: 2 }],
          [26, 'A', 'lock_released'],
          [26.5, 'B', 'lock_acquired', { lock: 'memory' }],
          [27, 'B', 'db_read', { qty: 2 }],
          [28, 'A', 'responded'],
          [34, 'B', 'committed', { qty: 1 }],
          [34, 'B', 'lock_released'],
          [36, 'B', 'responded'],
        ];
      return [
        [0, 'A', 'arrived', { ...q0, instance: 'app-1' }],
        [1, 'B', 'arrived', { instance: 'app-2' }],
        [3, 'C', 'arrived', { instance: 'app-1' }],
        [18, 'A', 'lock_acquired', { lock: 'memory', instance: 'app-1' }],
        [19, 'B', 'lock_acquired', { lock: 'memory', instance: 'app-2' }],
        [20, 'A', 'db_read', { qty: 3 }],
        [21, 'B', 'db_read', { qty: 3 }],
        [22, 'C', 'lock_wait', { owner: 'A', lock: 'memory', instance: 'app-1' }],
        [28, 'A', 'committed', { qty: 2 }],
        [28, 'A', 'lock_released'],
        [29, 'B', 'committed', { qty: 2 }],
        [29.5, 'A', 'custom:oversold', { by: 'B' }],
        [29.5, 'B', 'lock_released'],
        [30, 'C', 'lock_acquired', { lock: 'memory', instance: 'app-1' }],
        [31, 'C', 'db_read', { qty: 2 }],
        [32, 'A', 'responded'],
        [33, 'B', 'responded'],
        [38, 'C', 'committed', { qty: 1 }],
        [38, 'C', 'lock_released'],
        [40, 'C', 'responded'],
      ];
  }
}

export function g02Demo(strategy: G02DemoStrategy, instances: 1 | 2 = 1): Recording {
  const evs = events(strategy, instances);
  const actors = [...new Set(evs.map((e) => e[1]))];
  const two = strategy === 'app-memory-lock' && instances === 2;
  return {
    meta: {
      runId: `demo_g02_${strategy}_i${instances}`,
      pack: 'generic',
      scenario: 'g02-stock-decrement',
      scenarioTitle: '재고 차감 경합',
      strategy: {
        id: strategy,
        label: LABEL[strategy],
        kind: strategy === 'row-lock' || strategy === 'conditional-update' ? 'fixed' : 'broken',
      },
      sceneType: 'queue-at-counter',
      actors,
      totalActors: 200,
      isolation: 'READ COMMITTED',
      route: 'POST /orders',
      durationMs: evs[evs.length - 1]![0] + 30,
      autoStopDelayMs: 0,
      ...(two ? { actorInstances: { A: 'app-1', B: 'app-2', C: 'app-1' } } : {}),
    },
    events: evs.map(([t, actor, phase, attrs, rows], i) => ({
      id: `g02demo#${i + 1}`,
      t,
      actor,
      phase,
      ...(attrs ? { attrs } : {}),
      ...(rows !== undefined ? { rows } : {}),
      ...(phase === 'custom:oversold' || phase === 'custom:sold_out' || phase === 'lock_wait'
        ? { autoStop: true }
        : {}),
    })),
  };
}
