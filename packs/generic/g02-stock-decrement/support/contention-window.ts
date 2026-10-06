import { setTimeout as sleep } from 'node:timers/promises';

import type { ContentionPoint } from './strategy.types';

export interface InjectDelay {
  point: string;
  ms: number;
}

/**
 * 경합 창 지연 주입 훅(DESIGN §6.3). 로컬은 네트워크 왕복이 거의 0이라 경합 창이 실제보다 좁다.
 * RunConfig `injectDelay`에 지정된 지점에서만 지정 ms만큼 기다린다. 기본은 주입 없음.
 */
export function createContentionWindow(delays: InjectDelay[]): (point: ContentionPoint) => Promise<void> {
  const byPoint = new Map(delays.map((d) => [d.point, d.ms] as const));
  return async (point) => {
    const ms = byPoint.get(point);
    if (ms && ms > 0) {
      // @event injected_delay
      await sleep(ms);
    }
  };
}
