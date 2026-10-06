// 학습 화면용 예시(fixture). 실제 구현은 packs/generic/g02-stock-decrement/strategies 에 있다.
import { LockMode } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';

import { Product } from '../entities/product.entity';
import type { G02Strategy, OrderCommand, OrderResult, StrategyContext } from '../support/strategy.types';

interface RowLockParams {
  lockTimeoutMs: number;
}

/** row-lock — SELECT ... FOR UPDATE로 행을 잠그고 읽는다. 커밋까지 다른 요청은 기다린다. */
@Injectable()
export class RowLockStrategy implements G02Strategy<RowLockParams> {
  readonly id = 'row-lock';

  async execute(cmd: OrderCommand, ctx: StrategyContext<RowLockParams>): Promise<OrderResult> {
    return ctx.em.transactional(async (em) => {
      // @learn lock-timeout — 기다릴 상한. 넘으면 55P03으로 실패하고 요청은 5xx가 된다
      await em.execute(`set local lock_timeout = '${ctx.params.lockTimeoutMs}ms'`);

      // @event lock_wait
      // @learn for-update — 행 잠금을 잡고 읽는다. 앞 트랜잭션이 커밋할 때까지 여기서 줄을 선다
      const product = await em.findOneOrFail(Product, cmd.productId, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });

      // @learn hold-while-thinking — 잠금을 쥔 채로 앱 계산·지연·원장 기록까지 한다. 보유 시간이 길다
      await ctx.contentionWindow('after-lock');

      if (product.stock < cmd.qty) {
        await ctx.ledger.record(em, cmd, 'sold_out');
        return 'sold_out';
      }

      product.stock = product.stock - cmd.qty;
      await em.flush();

      // @event committed
      // @learn release-at-commit — 잠금은 COMMIT에서야 풀린다. DB 왕복이 느리면 줄 전체가 느려진다
      await ctx.ledger.record(em, cmd, 'success');
      return 'success';
    });
  }
}
