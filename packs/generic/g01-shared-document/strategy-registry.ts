import { z } from 'zod';

import { BlindRetryStrategy } from './strategies/blind-retry.strategy';
import { EditLeaseStrategy } from './strategies/edit-lease.strategy';
import { FieldMergeStrategy } from './strategies/field-merge.strategy';
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

/** zod 스키마로 검증한다. 없으면(undefined·null) 기본값만 채운다. */
function zodParams(id: string, schema: z.ZodType<Record<string, unknown>>) {
  return (raw: unknown): Record<string, unknown> => {
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) throw new Error(`g01: strategy '${id}' 파라미터 검증 실패: ${parsed.error.message}`);
    return parsed.data;
  };
}

/**
 * strategy id → 구현 클래스·파라미터 검증. id는 manifest.yaml의 `strategies[].id`와 같아야 한다.
 */
export const G01_STRATEGIES = {
  'naive-overwrite': { cls: NaiveOverwriteStrategy, params: noParams('naive-overwrite') },
  'optimistic-version': { cls: OptimisticVersionStrategy, params: noParams('optimistic-version') },
  // 서버는 optimistic-version과 같다. 클라이언트(k6) 재시도 방식만 다르다(C10).
  'blind-retry': { cls: BlindRetryStrategy, params: noParams('blind-retry') },
  // PATCH(바뀐 필드 하나) 전용 경로가 있다. PUT은 문서 version 전체로 검사한다.
  'field-merge': { cls: FieldMergeStrategy, params: noParams('field-merge') },
  // ttlMs: 잠금 유지 시간(DB 시계로 계산). retryAfterMs: 423의 Retry-After 상한.
  'edit-lease': {
    cls: EditLeaseStrategy,
    params: zodParams(
      'edit-lease',
      z
        .object({
          ttlMs: z.number().int().positive().default(30_000),
          retryAfterMs: z.number().int().positive().default(1_000),
        })
        .strict(),
    ),
  },
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
