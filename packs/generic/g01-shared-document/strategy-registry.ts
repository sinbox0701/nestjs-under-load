import { BlindRetryStrategy } from './strategies/blind-retry.strategy';
import { NaiveOverwriteStrategy } from './strategies/naive-overwrite.strategy';
import { OptimisticVersionStrategy } from './strategies/optimistic-version.strategy';
import type { G01Strategy } from './support/strategy.types';

interface StrategyEntry {
  cls: new () => G01Strategy<any>;
  /** manifest.yaml `strategies[].params`와 같은 내용. 부팅 시 검증하고 실패하면 던진다(부팅 실패, DESIGN §6.3). */
  params: (raw: unknown) => Record<string, unknown>;
}

/** 파라미터가 없는 strategy: 비었거나(undefined·{}) 아니면 거절한다. */
function noParams(id: string) {
  return (raw: unknown): Record<string, unknown> => {
    if (raw === undefined || raw === null) return {};
    if (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) return {};
    throw new Error(`g01: strategy '${id}'는 파라미터를 받지 않습니다(받은 값: ${JSON.stringify(raw)})`);
  };
}

/**
 * strategy id → 구현 클래스·파라미터 검증. id는 manifest.yaml의 `strategies[].id`와 같아야 한다.
 * field-merge·edit-lease는 후속 티켓에서 추가한다.
 */
export const G01_STRATEGIES = {
  'naive-overwrite': { cls: NaiveOverwriteStrategy, params: noParams('naive-overwrite') },
  'optimistic-version': { cls: OptimisticVersionStrategy, params: noParams('optimistic-version') },
  // 서버는 optimistic-version과 같다. 클라이언트(k6) 재시도 방식만 다르다(C10).
  'blind-retry': { cls: BlindRetryStrategy, params: noParams('blind-retry') },
} satisfies Record<string, StrategyEntry>;

export type G01StrategyId = keyof typeof G01_STRATEGIES;

export function resolveStrategy(
  id: string,
  rawParams: unknown,
): { id: G01StrategyId; cls: new () => G01Strategy<any>; params: Record<string, unknown> } {
  if (!Object.hasOwn(G01_STRATEGIES, id)) {
    throw new Error(`g01: 알 수 없는 strategy '${id}'. 가능: ${Object.keys(G01_STRATEGIES).join(', ')}`);
  }
  const entry: StrategyEntry = G01_STRATEGIES[id as G01StrategyId];
  return { id: id as G01StrategyId, cls: entry.cls, params: entry.params(rawParams) };
}
