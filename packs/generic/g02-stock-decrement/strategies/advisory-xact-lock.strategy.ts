import { Injectable } from '@nestjs/common';

import { Product } from '../entities/product.entity';
import type { G02Strategy, OrderCommand, OrderResult, StrategyContext } from '../support/strategy.types';

/**
 * advisory-xact-lock — pg_advisory_xact_lock(상품 ID) 후 읽기-계산-쓰기 (kind: fixed)
 *
 * 이 코드가 하는 일
 * - 트랜잭션 **첫 문장**으로 `SELECT pg_advisory_xact_lock(<상품 ID>)`를 보낸다. 같은 ID를 잡은 트랜잭션이 있으면 여기서 기다린다.
 * - 락을 얻은 뒤 no-lock과 똑같이 읽고, 앱에서 계산하고, 쓰고, 원장 INSERT 후 커밋한다.
 * - 락은 커밋이나 롤백 때 PostgreSQL이 자동으로 푼다. 해제 코드가 없다.
 *
 * 왜 이렇게 하나
 * - 첫 문장이어야 하는 이유: READ COMMITTED에서 스냅샷은 문장마다 새로 잡힌다. 락을 얻은 **뒤에** 보내는 SELECT가
 *   직전 커밋을 보려면 락 문장이 읽기보다 앞서야 한다. 읽기를 먼저 하고 락을 잡으면, 기다리는 동안 낡아 버린 값으로 계산한다.
 * - 락과 데이터가 같은 DB 트랜잭션에 묶인다. redis-lock과 달리 TTL이 없고, 해제 순서(커밋 전/후)나 소유자 확인 문제가 없으며,
 *   연결이 끊기면 트랜잭션이 중단되면서 락도 같이 사라진다.
 * - 행을 잠그지 않고 **숫자 키**를 잠근다. 상품 행의 UPDATE·SELECT FOR UPDATE는 이 락과 무관하다.
 *   같은 방식으로 락을 거는 코드끼리만 서로를 기다린다.
 *
 * 언제 깨지나 / 대가
 * - 잠그는 쪽이 모두 이 규약을 지킬 때만 보호된다. 다른 경로(관리 도구 등)가 락 없이 같은 행을 바꾸면 막지 못한다.
 * - 키 공간은 DB 전체에서 공유된다. 다른 기능이 같은 숫자로 advisory lock을 잡으면 이유 없이 서로 기다린다.
 * - 락 보유 구간 = 첫 문장 ~ COMMIT. 핫 상품 하나에 몰리면 처리량 천장은 row-lock과 비슷하다.
 *   대기는 pg_locks(locktype='advisory', granted=false)에서 보인다. 세션 단위 advisory lock(pg_advisory_lock)과의 차이는 G12에서 다룬다.
 */
@Injectable()
export class AdvisoryXactLockStrategy implements G02Strategy {
  readonly id = 'advisory-xact-lock';

  async execute(cmd: OrderCommand, ctx: StrategyContext): Promise<OrderResult> {
    const entity = { type: 'Product', id: String(cmd.productId) };
    ctx.events.emit('arrived', { entity }); // @event arrived
    try {
      const result = await ctx.em.transactional(async (em) => { // @learn xact-scoped — xact 버전은 이 트랜잭션에 묶인다. 세션형 pg_advisory_lock과 달리 풀기를 잊거나 커넥션 풀에 락이 새어 남는 일이 없다
        const waitStart = performance.now();
        ctx.events.emit('lock_wait', { entity }); // @event lock_wait
        await em.execute('select pg_advisory_xact_lock(?)', [cmd.productId]); // @learn advisory-first-statement — 트랜잭션의 첫 문장이어야 한다. 락을 얻은 뒤에 읽어야 직전 커밋을 본다(READ COMMITTED는 문장마다 스냅샷)
        ctx.events.emit('lock_acquired', { entity, durMs: performance.now() - waitStart }); // @event lock_acquired
        const product = await em.findOneOrFail(Product, cmd.productId);
        ctx.events.emit('db_read', { entity }); // @event db_read
        const seen = product.stock; // @learn rmw-under-advisory — 행은 잠그지 않았지만 같은 키를 잡은 트랜잭션끼리 직렬화되어 no-lock의 읽기-계산-쓰기가 안전해진다
        const delayStart = performance.now();
        await ctx.contentionWindow('after-read');
        const delayMs = performance.now() - delayStart;
        if (delayMs >= 1) ctx.events.emit('injected_delay', { entity, injected: true, durMs: delayMs }); // @event injected_delay
        if (seen < cmd.qty) {
          await ctx.ledger.record(em, cmd, 'sold_out');
          return 'sold_out' as const;
        }
        product.stock = seen - cmd.qty;
        await em.flush();
        ctx.events.emit('db_write', { entity }); // @event db_write
        await ctx.ledger.record(em, cmd, 'success'); // @learn auto-release-at-end — 락은 COMMIT/ROLLBACK 때 자동으로 풀린다. 원장 INSERT까지가 보유 시간이다
        return 'success' as const;
      });
      ctx.events.emit('committed', { entity }); // @event committed
      ctx.events.emit('lock_released', { entity }); // @event lock_released
      return result;
    } catch (err) {
      ctx.events.emit('rolled_back', { entity }); // @event rolled_back
      throw err;
    }
  }
}
