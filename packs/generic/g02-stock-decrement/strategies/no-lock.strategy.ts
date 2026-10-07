import { Injectable } from '@nestjs/common';

import { Product } from '../entities/product.entity';
import type { G02Strategy, OrderCommand, OrderResult, StrategyContext } from '../support/strategy.types';

/**
 * no-lock — 읽기-계산-쓰기, 락 없음 (kind: broken, 일부러 깨지는 기준선)
 *
 * 이 코드가 하는 일
 * - 트랜잭션(PostgreSQL 기본 READ COMMITTED)을 열고 상품을 **락 없이** SELECT 한다.
 * - 읽은 재고로 앱 메모리에서 판정·계산한 뒤 `UPDATE g02_product SET stock = <계산한 상수> WHERE id = ?`를
 *   flush로 보낸다. 같은 트랜잭션에서 원장(요청 ID·txid)을 INSERT 하고 커밋한다.
 *
 * 왜 이렇게 두나
 * - ORM으로 가장 자연스럽게 짜는 코드(find → 필드 변경 → flush)다. 동시성이 없으면 맞고,
 *   동시성이 생기면 어떻게 틀리는지 보이는 기준선으로 쓴다.
 *
 * 언제 깨지나
 * - 두 요청의 SELECT~UPDATE 구간(경합 창)이 겹치면. 둘 다 같은 stock을 읽고 각자 같은 값을 계산해 쓴다.
 *   뒤에 온 UPDATE는 앞 트랜잭션이 잡은 행 잠금을 기다렸다가, 커밋 뒤 최신 행 버전으로 `WHERE id = ?`를
 *   다시 검사(EvalPlanQual)한다. 조건이 id뿐이라 그대로 통과하고, SET 값이 상수라 앞의 차감을 덮어쓴다(잃어버린 갱신).
 * - 결과: 원장 성공 수량 합 > 실제 차감량(sold_equals_decrement 위반), 재고보다 많이 팔림(no_oversell 위반).
 * - 서버 대수와 무관하다. 1대에서도 await(DB 왕복) 사이에 다른 요청이 끼어든다. DB 지연·지연 주입으로
 *   경합 창이 넓어지면 거의 매번 깨진다.
 */
@Injectable()
export class NoLockStrategy implements G02Strategy {
  readonly id = 'no-lock';

  async execute(cmd: OrderCommand, ctx: StrategyContext): Promise<OrderResult> { // @event arrived
    const entity = { type: 'Product', id: String(cmd.productId) };
    ctx.events.emit('arrived', { entity });
    return ctx.em.transactional(async (em) => { // @learn tx-boundary — 재고 변경과 원장을 한 트랜잭션(READ COMMITTED)으로 묶는다. 트랜잭션만으로는 동시 차감을 막지 못한다
      const product = await em.findOneOrFail(Product, cmd.productId); // @event db_read
      ctx.events.emit('db_read', { entity });
      const seen = product.stock; // @learn read-then-write — 락 없이 읽은 값. 여기서 UPDATE까지가 경합 창이고, 그 사이 다른 커밋이 끼어도 모른다
      const delayStart = performance.now();
      await ctx.contentionWindow('after-read'); // @event injected_delay
      const delayed = performance.now() - delayStart;
      if (delayed >= 0.5) ctx.events.emit('injected_delay', { entity, injected: true, durMs: delayed });
      if (seen < cmd.qty) { // @learn app-side-check — 판정 근거가 '읽었던 과거 값'이다. 최신 재고가 아니다
        await ctx.ledger.record(em, cmd, 'sold_out');
        ctx.events.emit('committed', { entity });
        return 'sold_out' as const;
      }
      product.stock = seen - cmd.qty; // @learn app-computed-set — 앱이 계산한 상수를 SET 한다. DB의 현재값과 상관없이 덮어쓰므로 잃어버린 갱신이 난다
      await em.flush(); // @event db_write
      ctx.events.emit('db_write', { entity });
      await ctx.ledger.record(em, cmd, 'success'); // @learn ledger-same-tx — 원장 INSERT(요청 ID·txid)는 모든 strategy가 같은 비용으로 같은 트랜잭션에서 한다
      ctx.events.emit('committed', { entity });
      return 'success' as const;
    }); // @event committed rolled_back
  }
}
