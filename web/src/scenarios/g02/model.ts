/** G02 재고 차감 — 옵션·상수. */
import type { StrategyKind } from '../../events/types';

export type G02StrategyCode = 'no-lock' | 'row-lock' | 'conditional-update' | 'app-memory-lock';

export type G02Situation =
  | 'spike-200-one-instance'
  | 'spike-200-two-instances'
  | 'contention-window-30-one-instance'
  | 'contention-window-30-two-instances';

export interface G02Options {
  strategy: G02StrategyCode;
  /** 앱 서버 대수. 기본 1. */
  instances?: 1 | 2;
  /** 경합 창 30ms 주입(after-read). 기본 false. */
  injected?: boolean;
}

export const G02_STRATEGIES: readonly {
  code: G02StrategyCode;
  label: string;
  kind: StrategyKind;
}[] = [
  { code: 'no-lock', label: '락 없음 (읽고-계산하고-쓰기)', kind: 'broken' },
  { code: 'app-memory-lock', label: '인스턴스 메모리 mutex', kind: 'broken' },
  { code: 'row-lock', label: '행 잠금 SELECT … FOR UPDATE', kind: 'fixed' },
  { code: 'conditional-update', label: '조건부 UPDATE (stock >= qty)', kind: 'fixed' },
];

/** 옵션 → learn.yaml 상황 id. */
export function situationOf(instances: 1 | 2, injected: boolean): G02Situation {
  const n = instances === 1 ? 'one-instance' : 'two-instances';
  return injected ? `contention-window-30-${n}` : `spike-200-${n}`;
}

/** 대표 요청 4개(같은 상품 1번, 각 1개 주문). */
export const G02_ACTORS = ['A', 'B', 'C', 'D'] as const;
/** 도착 시각(실제 ms): A·B가 거의 동시, C·D는 상품당 초당 약 40건 간격. */
export const G02_ARRIVALS = [0, 0.4, 12, 24] as const;
/** 대표 상품의 시작 재고(대표 요청 수보다 1 적게 → 품절 경로와 초과 판매가 보인다). */
export const G02_STOCK0 = 3;
/** DB 왕복(실제 ms, 로컬 컨테이너 망). */
export const RT = 0.5;
/** 읽은 뒤 앱 계산 시간(주입 없을 때 경합 창). */
export const APP_MS = 0.3;
/** 주입 경합 창(learn.yaml injected.contentionWindowMs). */
export const WINDOW_MS = 30;
export const PRODUCT_ID = 1;
export const PACK_DIR = 'packs/generic/g02-stock-decrement';
