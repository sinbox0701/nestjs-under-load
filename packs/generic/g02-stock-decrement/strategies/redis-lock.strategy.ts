import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { Product } from '../entities/product.entity';
import type { G02Strategy, OrderCommand, OrderResult, StrategyContext } from '../support/strategy.types';

/** module.ts가 Redis 클라이언트를 이 토큰으로 제공한다(requires: [redis]일 때만). */
export const G02_REDIS = Symbol('G02_REDIS');

export interface RedisLockParams {
  /** 락 키의 만료(PX, ms). 소유자가 죽어도 이 시간이 지나면 풀린다. 락을 기다리는 최대 시간도 같은 값을 쓴다. */
  ttlMs: number;
}

/**
 * 소유자 확인 해제. 키 값이 내 토큰일 때만 지운다(조회와 삭제가 Lua 한 번에 원자적으로 실행된다).
 * GET 뒤 DEL을 따로 보내면 그 사이에 TTL이 끝나 남이 새로 잡은 락을 내가 지울 수 있다.
 */
export const RELEASE_LOCK_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

const RETRY_MS = 5;

/** 토큰이 내 것일 때만 키를 지운다. 지웠으면 true, 이미 만료됐거나 남의 락이면 false. */
export async function releaseLock(redis: Pick<Redis, 'eval'>, key: string, token: string): Promise<boolean> {
  return (await redis.eval(RELEASE_LOCK_LUA, 1, key, token)) === 1;
}

/**
 * redis-lock — Redis 분산 락 + 트랜잭션 안 읽기-계산-쓰기 (kind: tradeoff)
 *
 * 이 코드가 하는 일
 * - `SET lock:product:<id> <토큰> NX PX <ttlMs>`로 락을 잡는다. 이미 있으면 5ms마다 다시 시도하고, ttlMs 안에 못 잡으면 503.
 * - 락을 잡은 **뒤에** DB 트랜잭션을 연다. 트랜잭션 안은 no-lock과 똑같은 읽기-계산-쓰기고, 원장 INSERT까지 하고 커밋한다.
 * - 커밋(또는 롤백)이 끝난 뒤 finally에서 Lua로 소유자를 확인하고 해제한다.
 *
 * 왜 이렇게 하나
 * - 락은 DB 밖에 있어서 트랜잭션 **밖에서 먼저** 잡는다. 트랜잭션을 먼저 열면 락을 기다리는 동안 낡은 시점에서 시작한
 *   트랜잭션이 남는다. 락 → 트랜잭션 → 읽기-계산-쓰기 → 커밋 → 해제 순서여야 안에서 읽는 값이 직전 커밋을 반영한다.
 * - 커밋 전에 해제하면 다음 요청이 아직 커밋되지 않은 차감을 못 보고 옛 값을 읽는다(app-memory-lock과 같은 이유).
 * - 락이 Redis에 있어서 앱이 몇 대든 같은 키를 본다. app-memory-lock과 달리 앱 2대에서도 맞다.
 *
 * 언제 깨지나 / 대가
 * - TTL이 작업 시간보다 짧으면 락이 풀린 채 트랜잭션이 계속되어 상호 배제가 깨진다(GC·DB 지연·지연 주입으로 쉽게 생긴다).
 *   그 뒤 늦게 끝난 쪽의 해제는 토큰이 달라 키를 지우지 않으므로 남의 락을 지우는 사고만은 막는다. 이 시연은 G05가 맡는다.
 * - Redis가 죽으면 요청은 fail-closed로 503이다. 락 없이 DB로 진행하면 정합성이 깨지므로 일부러 거절한다.
 * - 락과 데이터가 서로 다른 시스템이라 둘의 원자성은 없다. 같은 DB 안에서 해결하는 advisory-xact-lock과 비교하는 지점이다.
 */
@Injectable()
export class RedisLockStrategy implements G02Strategy<RedisLockParams> {
  readonly id = 'redis-lock';

  constructor(@Inject(G02_REDIS) private readonly redis: Redis) {}

  async execute(cmd: OrderCommand, ctx: StrategyContext<RedisLockParams>): Promise<OrderResult> {
    const ttlMs = ctx.params.ttlMs;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error(`redis-lock: ttlMs는 양의 정수여야 합니다(받은 값: ${String(ttlMs)})`);
    }
    const entity = { type: 'Product', id: String(cmd.productId) };
    ctx.events.emit('arrived', { entity }); // @event arrived
    const key = `g02:lock:product:${cmd.productId}`;
    const token = randomUUID(); // @learn owner-token — 락마다 고유한 토큰. 해제할 때 내 락인지 확인하는 근거가 된다
    ctx.events.emit('lock_wait', { entity }); // @event lock_wait
    const waitStart = performance.now();
    await this.acquire(key, token, ttlMs, cmd, ctx, entity);
    ctx.events.emit('lock_acquired', { entity, durMs: performance.now() - waitStart }); // @event lock_acquired
    try {
      // @learn lock-outside-tx — 락은 트랜잭션 밖에서 먼저 잡는다. 트랜잭션 안에서 읽는 값이 '락을 얻은 뒤의 최신 커밋'이어야 하기 때문이다
      const result = await ctx.em.transactional(async (em) => {
        const product = await em.findOneOrFail(Product, cmd.productId);
        ctx.events.emit('db_read', { entity }); // @event db_read
        const seen = product.stock; // @learn rmw-inside-lock — 락 안이라 no-lock과 같은 읽기-계산-쓰기가 안전하다. DB는 아무것도 잠그지 않고 Redis 락만 믿는다
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
        await ctx.ledger.record(em, cmd, 'success');
        return 'success' as const;
      });
      ctx.events.emit('committed', { entity }); // @event committed
      return result;
    } catch (err) {
      ctx.events.emit('rolled_back', { entity }); // @event rolled_back
      throw err;
    } finally { // @learn release-after-commit — 커밋·롤백이 끝난 뒤에 푼다. 예외가 나도 finally에서 반드시 푼다
      await this.release(key, token, entity, ctx);
    }
  }

  /** SET NX PX를 ttlMs 동안 재시도한다. Redis 오류·대기 초과는 DB를 건드리기 전에 503으로 끝난다(fail-closed). */
  private async acquire(
    key: string,
    token: string,
    ttlMs: number,
    cmd: OrderCommand,
    ctx: StrategyContext<RedisLockParams>,
    entity: { type: string; id: string },
  ): Promise<void> {
    const deadline = performance.now() + ttlMs;
    for (;;) {
      let ok: string | null;
      try {
        ok = await this.redis.set(key, token, 'PX', ttlMs, 'NX'); // @learn set-nx-px — NX는 없을 때만, PX는 만료 시간. 한 명령이라 '확인 후 설정' 경합이 없고, 죽은 소유자의 락은 TTL로 풀린다
      } catch {
        throw new ServiceUnavailableException({ result: 'redis_unavailable', requestId: cmd.requestId }); // @learn fail-closed — Redis를 못 쓰면 락 없이 진행하지 않고 거절한다. 원장에도 남지 않는다
      }
      if (ok === 'OK') return;
      if (performance.now() >= deadline) {
        ctx.events.emit('lock_timeout', { entity }); // @event lock_timeout
        throw new ServiceUnavailableException({ result: 'lock_timeout', requestId: cmd.requestId });
      }
      await sleep(RETRY_MS);
    }
  }

  private async release(
    key: string,
    token: string,
    entity: { type: string; id: string },
    ctx: StrategyContext<RedisLockParams>,
  ): Promise<void> {
    try {
      await releaseLock(this.redis, key, token); // @learn lua-owner-release — 내 토큰일 때만 DEL. TTL이 끝나 남이 잡은 락을 지우지 않는다
    } catch {
      // 해제 실패는 이미 커밋된 결과를 뒤집지 않는다. 키는 TTL로 만료된다.
    }
    ctx.events.emit('lock_released', { entity }); // @event lock_released
  }
}
