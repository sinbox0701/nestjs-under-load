import { LockMode } from '@mikro-orm/core';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import { Product } from '../entities/product.entity';
import type { G02Strategy, OrderCommand, OrderResult, StrategyContext } from '../support/strategy.types';

export interface RowLockParams {
  /** SET LOCAL lock_timeout 값(ms). 기다리다 넘으면 55P03 에러 → 503 */
  lockTimeoutMs: number;
}

/** PostgreSQL `lock_not_available`. lock_timeout 초과나 NOWAIT 실패 때 나온다. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * row-lock — SELECT ... FOR UPDATE (kind: fixed)
 *
 * 이 코드가 하는 일
 * - 트랜잭션 첫 문장으로 `SET LOCAL lock_timeout`을 건다(트랜잭션이 끝나면 자동 원복).
 * - `LockMode.PESSIMISTIC_WRITE`로 상품을 읽는다 → `SELECT ... FOR UPDATE`. 다른 트랜잭션이 행을 잡고 있으면 여기서 기다린다.
 * - 경합 창 주입 지점(after-read)은 FOR UPDATE로 읽은 직후다. 다른 strategy와 같은 위치지만 여기서는 잠금을 쥔 채 기다린다.
 * - 잠근 행으로 재고를 판정하고 차감(flush) 또는 품절 처리, 원장 INSERT 후 커밋. 커밋/롤백 때 행 잠금이 풀린다.
 * - lock_timeout을 넘기면 PostgreSQL이 55P03을 던진다 → 트랜잭션 롤백(원장에 남지 않음) → 503.
 *
 * 왜 이렇게 하나
 * - READ COMMITTED에서 FOR UPDATE는 잠금을 기다린 뒤 **최신 커밋 버전을 다시 읽어** 돌려준다. 그래서 판정·계산에 쓰는
 *   값이 stale하지 않다. 같은 상품을 차감하는 트랜잭션들이 행 단위로 줄을 선다.
 * - lock_timeout이 없으면 대기가 끝없이 길어질 수 있다. SET LOCAL을 쓰는 이유는 풀 커넥션에 설정이 남지 않게 하려는 것이다.
 *
 * 언제 깨지나(정합성은 지키지만 느려지거나 거절한다)
 * - 락 보유 구간 = SELECT FOR UPDATE ~ COMMIT. 이 사이의 앱 왕복(판정·flush·원장 INSERT)이 전부 보유 시간이다.
 *   핫 상품 하나에 몰리면 처리량 천장 ≈ 1 / 보유 시간. DB 지연이 생기면 보유 시간이 왕복 수만큼 늘어난다.
 * - 대기가 lock_timeout을 넘으면 실패(503)가 늘어난다. 대기는 pg_locks(granted=false),
 *   pg_stat_activity(wait_event_type='Lock')에서 보인다.
 */
@Injectable()
export class RowLockStrategy implements G02Strategy<RowLockParams> {
  readonly id = 'row-lock';

  async execute(cmd: OrderCommand, ctx: StrategyContext<RowLockParams>): Promise<OrderResult> { // @event arrived
    const entity = { type: 'Product', id: String(cmd.productId) };
    ctx.events.emit('arrived', { entity });
    const timeoutMs = ctx.params.lockTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`row-lock: lockTimeoutMs는 양의 정수여야 합니다(받은 값: ${String(timeoutMs)})`);
    }
    let locked = false; // 행 잠금을 얻었는가. 못 얻었으면 lock_released 를 내지 않는다
    try {
      const result = await ctx.em.transactional(async (em) => {
        await em.execute(`set local lock_timeout = '${timeoutMs}ms'`); // @learn set-local-lock-timeout — SET LOCAL은 이 트랜잭션에만 적용되고 끝나면 원복된다. 그냥 SET이면 풀 커넥션에 남는다
        const waitStart = performance.now();
        const product = await em.findOneOrFail(Product, cmd.productId, { // @event lock_wait
          lockMode: LockMode.PESSIMISTIC_WRITE, // @learn for-update — SELECT ... FOR UPDATE. 잠금을 기다린 뒤 최신 커밋 버전을 읽어 온다
        }); // @event lock_acquired
        locked = true;
        ctx.events.emit('lock_wait', { entity, durMs: performance.now() - waitStart });
        ctx.events.emit('lock_acquired', { entity });
        const afterLock = await ctx.contentionWindow('after-lock'); // @event injected_delay
        if (afterLock?.injected) ctx.events.emit('injected_delay', { entity, injected: true, durMs: afterLock.durMs });
        const afterRead = await ctx.contentionWindow('after-read'); // @event injected_delay
        if (afterRead?.injected) ctx.events.emit('injected_delay', { entity, injected: true, durMs: afterRead.durMs });
        if (product.stock < cmd.qty) { // @learn fresh-read-check — 잠근 행의 최신 값으로 판정한다. 다른 트랜잭션은 이 행을 바꿀 수 없다
          await ctx.ledger.record(em, cmd, 'sold_out');
          return 'sold_out' as const;
        }
        product.stock -= cmd.qty;
        await em.flush(); // @event db_write
        ctx.events.emit('db_write', { entity });
        await ctx.ledger.record(em, cmd, 'success'); // @learn lock-held-span — 원장 INSERT까지 끝나고 커밋해야 잠금이 풀린다. FOR UPDATE부터 여기까지가 전부 보유 시간이다
        return 'success' as const;
      }); // @event committed rolled_back lock_released
      ctx.events.emit('committed', { entity });
      ctx.events.emit('lock_released', { entity });
      return result;
    } catch (err) {
      const timedOut = (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE; // @event lock_timeout
      if (timedOut) ctx.events.emit('lock_timeout', { entity });
      ctx.events.emit('rolled_back', { entity });
      if (locked) ctx.events.emit('lock_released', { entity });
      if (timedOut) {
        throw new ServiceUnavailableException({ result: 'lock_timeout', requestId: cmd.requestId }); // @learn lock-timeout-55p03 — 55P03은 롤백되고 원장에 남지 않는다. 품절(409)과 구분해 503으로 돌려준다
      }
      throw err;
    }
  }
}
