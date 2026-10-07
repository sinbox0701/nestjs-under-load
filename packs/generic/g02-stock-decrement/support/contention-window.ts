import { setTimeout as sleep } from 'node:timers/promises';

import type { ContentionPoint } from './strategy.types';

export interface InjectDelay {
  point: string;
  ms: number;
}

/** 주입 결과. 반환값을 무시하는 호출부도 그대로 동작한다. */
export interface ContentionResult {
  injected: boolean;
  durMs: number;
}

/**
 * 경합 창 지연 주입 훅(DESIGN §6.3). 로컬은 네트워크 왕복이 거의 0이라 경합 창이 실제보다 좁다.
 * RunConfig `injectDelay`에 지정된 지점에서만 지정 ms만큼 기다린다. 기본은 주입 없음.
 */
export function createContentionWindow(delays: InjectDelay[]): (point: ContentionPoint) => Promise<ContentionResult> {
  const byPoint = new Map(delays.map((d) => [d.point, d.ms] as const));
  return async (point) => {
    const ms = byPoint.get(point);
    if (ms && ms > 0) {
      // @event injected_delay
      const start = performance.now();
      await sleep(ms);
      return { injected: true, durMs: performance.now() - start };
    }
    return { injected: false, durMs: 0 };
  };
}
