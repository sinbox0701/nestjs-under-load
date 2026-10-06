import { raw } from '@mikro-orm/postgresql';
import { Injectable, NotFoundException } from '@nestjs/common';

import { Product } from '../entities/product.entity';
import type { G02Strategy, OrderCommand, OrderResult, StrategyContext } from '../support/strategy.types';

/**
 * conditional-update — 조건부 UPDATE 한 문장 (kind: fixed, bypassesOrm: true)
 *
 * 이 코드가 하는 일
 * - `UPDATE g02_product SET stock = stock - ? WHERE id = ? AND stock >= ?` 한 문장으로 판정과 차감을 같이 한다.
 *   `em.nativeUpdate`는 Unit of Work를 거치지 않고 SQL을 바로 보낸다(manifest bypassesOrm: true).
 * - 반환된 **영향 행 수**로 결과를 정한다. 1이면 성공, 0이면 품절(상품이 아예 없으면 404).
 * - 같은 트랜잭션에서 원장 INSERT 후 커밋.
 *
 * 왜 맞나
 * - 별도 SELECT도, 앱 쪽 락도 없다. 대신 READ COMMITTED의 UPDATE는 대상 행이 다른 트랜잭션에 잠겨 있으면 기다렸다가,
 *   그 트랜잭션이 커밋하면 **최신 행 버전으로 WHERE(stock >= qty)를 다시 평가**한다(EvalPlanQual).
 *   재고가 모자라게 된 뒤에 온 요청은 조건이 거짓이 되어 영향 행 0으로 끝난다.
 * - SET이 `stock - qty`(DB가 최신 값으로 계산)라서 앞의 차감을 덮어쓰지 않는다. no-lock과의 핵심 차이다.
 * - 락 보유 구간 = UPDATE ~ COMMIT. SELECT 왕복과 앱 계산이 락 안에 없어서 row-lock보다 짧다.
 *
 * 언제 깨지나(정합성은 지키지만)
 * - 판정 조건이 한 행 안에서 끝날 때만 쓸 수 있다. 여러 행·외부 시스템에 걸친 판정이 필요하면 이 방식으로는 부족하다.
 * - 핫 상품 하나에 몰리면 여전히 행 잠금으로 줄을 선다. 원장 INSERT가 UPDATE 뒤에 있어서 그 시간도 보유 시간에 들어간다.
 */
@Injectable()
export class ConditionalUpdateStrategy implements G02Strategy {
  readonly id = 'conditional-update';

  async execute(cmd: OrderCommand, ctx: StrategyContext): Promise<OrderResult> { // @event arrived
    return ctx.em.transactional(async (em) => {
      const affected = await em.nativeUpdate( // @event db_write
        Product,
        { id: cmd.productId, stock: { $gte: cmd.qty } }, // @learn where-stock-gte — 판정을 WHERE에 넣는다. 잠금 대기 뒤 최신 행으로 다시 평가된다(EvalPlanQual)
        { stock: raw('stock - ?', [cmd.qty]) }, // @learn db-computed-set — SET stock = stock - qty. DB가 최신 값으로 계산하므로 덮어쓰기가 없다
      ); // @event lock_acquired
      if (affected === 0) { // @learn affected-rows — 영향 행 수가 곧 판정 결과다. 0이면 조건(재고 충분)이 거짓이었다는 뜻
        const exists = await em.count(Product, { id: cmd.productId });
        if (exists === 0) throw new NotFoundException(`product ${cmd.productId} not found`);
        await ctx.ledger.record(em, cmd, 'sold_out');
        return 'sold_out' as const;
      }
      await ctx.ledger.record(em, cmd, 'success'); // @learn ledger-after-update — UPDATE가 잡은 행 잠금은 커밋까지 유지된다. 이 INSERT 시간도 보유 시간에 더해진다
      return 'success' as const;
    }); // @event committed rolled_back lock_released
  }
}
