import type { Type } from '@nestjs/common';
import { z } from 'zod';

import { AppMemoryLockStrategy } from './strategies/app-memory-lock.strategy';
import { ConditionalUpdateStrategy } from './strategies/conditional-update.strategy';
import { NoLockStrategy } from './strategies/no-lock.strategy';
import { RowLockStrategy } from './strategies/row-lock.strategy';
import type { G02Strategy } from './support/strategy.types';

interface StrategyEntry {
  cls: Type<G02Strategy<any>>;
  /** manifest.yaml `strategies[].params`와 같은 내용을 zod로. 부팅 시 검증, 실패하면 부팅 실패(DESIGN §6.3) */
  params: z.ZodType<Record<string, unknown>>;
}

/**
 * strategy id → 구현 클래스·파라미터 스키마. 0단계 G02는 4개만(1단계에서 redis-lock, advisory-xact-lock 추가).
 * id는 manifest.yaml의 `strategies[].id`와 같아야 한다(테스트로 대조).
 */
export const G02_STRATEGIES = {
  'no-lock': { cls: NoLockStrategy, params: z.object({}).strict() },
  'app-memory-lock': { cls: AppMemoryLockStrategy, params: z.object({}).strict() },
  'row-lock': {
    cls: RowLockStrategy,
    params: z.object({ lockTimeoutMs: z.number().int().positive().default(1000) }).strict(),
  },
  'conditional-update': { cls: ConditionalUpdateStrategy, params: z.object({}).strict() },
} satisfies Record<string, StrategyEntry>;

export type G02StrategyId = keyof typeof G02_STRATEGIES;

export function resolveStrategy(
  id: string,
  rawParams: unknown,
): { id: G02StrategyId; cls: Type<G02Strategy<any>>; params: Record<string, unknown> } {
  if (!(id in G02_STRATEGIES)) {
    throw new Error(`g02: 알 수 없는 strategy '${id}'. 가능: ${Object.keys(G02_STRATEGIES).join(', ')}`);
  }
  const entry: StrategyEntry = G02_STRATEGIES[id as G02StrategyId];
  const parsed = entry.params.safeParse(rawParams ?? {});
  if (!parsed.success) {
    throw new Error(`g02: strategy '${id}' 파라미터 검증 실패: ${parsed.error.message}`);
  }
  return { id: id as G02StrategyId, cls: entry.cls, params: parsed.data };
}
