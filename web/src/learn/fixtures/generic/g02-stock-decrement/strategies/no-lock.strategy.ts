// 학습 화면용 예시(fixture). 실제 구현은 packs/generic/g02-stock-decrement/strategies 에 있다.
import { Injectable } from '@nestjs/common';

import { Product } from '../entities/product.entity';
import type { G02Strategy, OrderCommand, OrderResult, StrategyContext } from '../support/strategy.types';

/** no-lock — 읽고, 앱에서 계산하고, 쓴다. 락이 없다. */
@Injectable()
export class NoLockStrategy implements G02Strategy {
  readonly id = 'no-lock';

  async execute(cmd: OrderCommand, ctx: StrategyContext): Promise<OrderResult> {
    return ctx.em.transactional(async (em) => {
      // @event db_read
      // @learn read-without-lock — 평범한 SELECT. 다른 요청도 같은 값을 동시에 읽을 수 있다
      const product = await em.findOneOrFail(Product, cmd.productId);

      // @event injected_delay
      // @learn contention-window — 읽기와 쓰기 사이 틈. 여기가 길어질수록 겹치는 요청이 늘어난다
      await ctx.contentionWindow('after-read');

      if (product.stock < cmd.qty) {
        await ctx.ledger.record(em, cmd, 'sold_out');
        return 'sold_out';
      }

      // @learn read-then-write — 앱이 계산한 값(읽은 값 - qty)을 그대로 쓴다. 사이에 끼어든 차감은 덮인다
      product.stock = product.stock - cmd.qty;

      // @event db_write
      // @learn flush-constant — UPDATE ... SET stock = $1 (상수). DB가 재검사해도 막을 근거가 없다
      await em.flush();

      await ctx.ledger.record(em, cmd, 'success');
      return 'success';
    });
  }
}
