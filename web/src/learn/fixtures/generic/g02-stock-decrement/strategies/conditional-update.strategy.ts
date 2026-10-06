// 학습 화면용 예시(fixture). 실제 구현은 packs/generic/g02-stock-decrement/strategies 에 있다.
import { raw } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';

import { Product } from '../entities/product.entity';
import type { G02Strategy, OrderCommand, OrderResult, StrategyContext } from '../support/strategy.types';

/** conditional-update — 검사와 차감을 UPDATE 한 문장에 넣는다. 별도 SELECT도 락도 없다. */
@Injectable()
export class ConditionalUpdateStrategy implements G02Strategy {
  readonly id = 'conditional-update';

  async execute(cmd: OrderCommand, ctx: StrategyContext): Promise<OrderResult> {
    return ctx.em.transactional(async (em) => {
      // @event db_write
      // @learn atomic-decrement — SET stock = stock - $1: DB가 그 순간의 최신 값으로 계산한다
      const affected = await em.nativeUpdate(
        Product,
        // @learn guard-in-where — 조건(stock >= qty)도 같은 문장. 잠금 대기 뒤 최신 행으로 다시 평가된다
        { id: cmd.productId, stock: { $gte: cmd.qty } },
        { stock: raw('stock - ?', [cmd.qty]) },
      );

      // @learn affected-rows — 영향 행 0이면 품절. 앱이 읽은 값을 믿지 않고 DB 결과만 본다
      const result: OrderResult = affected === 1 ? 'success' : 'sold_out';

      // @learn short-hold — 잠금 보유 = UPDATE ~ COMMIT. 사이에 원장 INSERT 하나뿐이라 짧다
      await ctx.ledger.record(em, cmd, result);
      return result;
    });
  }
}
