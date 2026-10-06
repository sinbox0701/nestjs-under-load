// 학습 화면용 예시(fixture). 실제 구현은 packs/generic/g02-stock-decrement/strategies 에 있다.
import { Injectable } from '@nestjs/common';

import { Product } from '../entities/product.entity';
import type { G02Strategy, OrderCommand, OrderResult, StrategyContext } from '../support/strategy.types';

// @learn per-instance-map — 이 Map은 프로세스 메모리에 있다. 서버가 2대면 Map도 2개다
const tails = new Map<number, Promise<void>>();

/** 상품별로 앞 요청이 끝나야 다음 요청이 들어가게 하는 아주 작은 mutex. */
async function withProductLock<T>(productId: number, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(productId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  tails.set(productId, prev.then(() => mine));
  // @learn wait-in-process — 같은 프로세스 안의 앞 요청만 기다린다. 줄이 길어지면 여기서 지연이 쌓인다
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** app-memory-lock — 인스턴스 메모리 mutex로 감싼 no-lock. 1대에서는 맞고 2대에서 깨진다. */
@Injectable()
export class AppMemoryLockStrategy implements G02Strategy {
  readonly id = 'app-memory-lock';

  async execute(cmd: OrderCommand, ctx: StrategyContext): Promise<OrderResult> {
    // @learn memory-mutex — 락 범위 = 이 프로세스. DB는 이 락을 모른다
    return withProductLock(cmd.productId, () =>
      ctx.em.transactional(async (em) => {
        // @learn read-inside-mutex — 같은 인스턴스끼리는 순서대로 읽지만, 다른 인스턴스는 동시에 읽는다
        const product = await em.findOneOrFail(Product, cmd.productId);
        await ctx.contentionWindow('after-read');

        if (product.stock < cmd.qty) {
          await ctx.ledger.record(em, cmd, 'sold_out');
          return 'sold_out';
        }

        // @learn write-computed — no-lock과 같은 상수 쓰기. 다른 서버의 차감을 덮을 수 있다
        product.stock = product.stock - cmd.qty;
        await em.flush();

        await ctx.ledger.record(em, cmd, 'success');
        return 'success' as const;
      }),
    );
  }
}
