import { Injectable } from '@nestjs/common';

import { Product } from '../entities/product.entity';
import type { G02Strategy, OrderCommand, OrderResult, StrategyContext } from '../support/strategy.types';

interface MemoryLockTicket {
  /** 앞 사람이 해제하면 resolve 된다 */
  ready: Promise<void>;
  release(): void;
}

/**
 * app-memory-lock — 인스턴스 메모리 mutex (kind: broken; 1대에선 통과, 2대에선 위반을 보이는 용도)
 *
 * 이 코드가 하는 일
 * - 상품 ID마다 Promise 체인으로 만든 mutex를 이 프로세스 메모리(Map)에 둔다. Nest 싱글턴 provider라 프로세스 수명 동안 유지된다.
 * - mutex를 얻은 뒤 no-lock과 똑같은 읽기-계산-쓰기 트랜잭션을 돌리고, **커밋이 끝난 뒤** finally에서 해제한다.
 * - 마지막 대기자가 해제하면 Map 항목을 지운다(상품 수만큼 항목이 쌓이지 않게).
 *
 * 왜 이렇게 하나
 * - 같은 프로세스 안에서는 같은 상품 요청이 한 줄로 서므로 경합 창이 겹치지 않는다. 앱 1대에서는 불변식이 지켜진다.
 * - 커밋 전에 풀면 1대에서도 깨진다. 다음 요청이 아직 커밋되지 않은 차감을 보지 못하고 옛 값을 읽기 때문이다.
 *
 * 언제 깨지나
 * - 앱 2대 이상(nginx round-robin). mutex는 **프로세스마다 따로** 있어서 app-1과 app-2가 같은 상품을 동시에 처리하면
 *   서로를 모른다 → no-lock과 같은 잃어버린 갱신. 락의 범위가 공유 자원(DB 행)의 범위보다 좁기 때문이다.
 * - 1대에서도 대기 요청이 이벤트 루프 안 Promise로 쌓인다. 이 대기는 pg_locks에 보이지 않고 앱 지연·ELU로만 보인다.
 *   핫 상품에 몰리면 꼬리 지연이 커지고, 대기열 상한이 없어서 메모리도 늘어난다.
 */
@Injectable()
export class AppMemoryLockStrategy implements G02Strategy {
  readonly id = 'app-memory-lock';

  /** productId → 그 상품 대기열의 꼬리(마지막 대기자가 해제될 때 resolve). */
  private readonly tails = new Map<number, Promise<void>>(); // @learn process-local-map — 이 Map은 이 프로세스에만 있다. 다른 인스턴스는 이 락을 볼 수 없다

  async execute(cmd: OrderCommand, ctx: StrategyContext): Promise<OrderResult> { // @event arrived
    const entity = { type: 'Product', id: String(cmd.productId) };
    ctx.events.emit('arrived', { entity });
    const waitStart = performance.now();
    const ticket = this.enqueue(cmd.productId); // @event lock_wait
    await ticket.ready; // @event lock_acquired
    ctx.events.emit('lock_wait', { entity, durMs: performance.now() - waitStart });
    ctx.events.emit('lock_acquired', { entity });
    let done = false; // 콜백이 끝까지 가면 true. finally 에서 커밋/롤백을 가른다
    try {
      return await ctx.em.transactional(async (em) => {
        const product = await em.findOneOrFail(Product, cmd.productId); // @event db_read
        ctx.events.emit('db_read', { entity });
        const seen = product.stock; // @learn same-read-then-write — mutex 안쪽은 no-lock과 똑같다. DB는 아무것도 잠그지 않는다
        const delayStart = performance.now();
        await ctx.contentionWindow('after-read'); // @event injected_delay
        const delayed = performance.now() - delayStart;
        if (delayed >= 0.5) ctx.events.emit('injected_delay', { entity, injected: true, durMs: delayed });
        if (seen < cmd.qty) {
          await ctx.ledger.record(em, cmd, 'sold_out');
          done = true;
          return 'sold_out' as const;
        }
        product.stock = seen - cmd.qty;
        await em.flush(); // @event db_write
        ctx.events.emit('db_write', { entity });
        await ctx.ledger.record(em, cmd, 'success');
        done = true;
        return 'success' as const;
      }); // @event committed rolled_back
    } finally { // @learn release-after-commit — 커밋이 끝난 뒤에 푼다. 예외가 나도 finally에서 반드시 푼다
      if (done) ctx.events.emit('committed', { entity });
      else ctx.events.emit('rolled_back', { entity });
      ticket.release(); // @event lock_released
      ctx.events.emit('lock_released', { entity });
    }
  }

  /** Promise 체인 mutex: 앞 사람의 해제 Promise 뒤에 내 해제 Promise를 이어 붙인다. */
  private enqueue(productId: number): MemoryLockTicket {
    const prev = this.tails.get(productId) ?? Promise.resolve();
    let resolveMine!: () => void;
    const mine = new Promise<void>((resolve) => {
      resolveMine = resolve;
    });
    const tail = prev.then(() => mine);
    this.tails.set(productId, tail); // @learn promise-chain-mutex — 대기열의 꼬리에 나를 붙인다. 앞 사람이 풀어야 내 차례가 온다
    return {
      ready: prev,
      release: () => {
        resolveMine();
        if (this.tails.get(productId) === tail) this.tails.delete(productId); // @learn map-cleanup — 내가 마지막 대기자면 항목을 지운다(누수 방지)
      },
    };
  }
}
