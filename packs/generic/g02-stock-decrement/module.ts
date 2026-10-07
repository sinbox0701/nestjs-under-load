import { type DynamicModule, Inject, Module, type OnModuleDestroy, Optional, type Provider } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Redis } from 'ioredis';

import { G02Controller, type G02Runtime } from './api/g02.controller';
import { OrderLedger } from './entities/order-ledger.entity';
import { Product } from './entities/product.entity';
import { G02_REDIS } from './strategies/redis-lock.strategy';
import { resolveStrategy } from './strategy-registry';
import { createContentionWindow, type InjectDelay } from './support/contention-window';
import { G02_RUNTIME, G02_STRATEGY, G02_STRATEGY_PARAMS } from './support/tokens';

export interface G02ModuleOptions {
  strategy: string;
  strategyParams?: unknown;
  instance: string;
  injectDelay?: InjectDelay[];
  /** RunConfig `redis`(C1). strategy가 requires: [redis]일 때만 쓰고, 그때 없으면 부팅 실패한다. */
  redis?: { host: string; port: number } | null;
}

/**
 * 락 클라이언트. Redis가 죽었을 때 요청이 오래 매달리지 않고 빨리 실패해야 fail-closed(503)가 된다:
 * 재시도는 요청당 1번, 명령·접속 타임아웃 2초.
 */
function createRedis(conn: { host: string; port: number }): Redis {
  const redis = new Redis({
    host: conn.host,
    port: conn.port,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 2000,
  });
  redis.on('error', () => {}); // 연결 오류는 각 명령의 reject로 전달된다. 리스너가 없으면 ioredis가 stderr에 같은 오류를 반복 출력한다
  return redis;
}

/**
 * G02 동적 모듈: 엔티티 등록 + strategy provider 팩토리(DESIGN §6.1 module.ts, §6.3).
 * 부팅 시 RunConfig의 strategy 하나만 provider로 등록한다. 실행 중 교체는 하지 않는다(§5.3).
 */
@Module({})
export class G02Module implements OnModuleDestroy {
  constructor(@Optional() @Inject(G02_REDIS) private readonly redis?: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => this.redis?.disconnect());
  }

  static register(opts: G02ModuleOptions): DynamicModule {
    const resolved = resolveStrategy(opts.strategy, opts.strategyParams);
    const runtime: G02Runtime = {
      instance: opts.instance,
      contentionWindow: createContentionWindow(opts.injectDelay ?? []),
    };
    const providers: Provider[] = [
      { provide: G02_STRATEGY, useClass: resolved.cls },
      { provide: G02_STRATEGY_PARAMS, useValue: resolved.params },
      { provide: G02_RUNTIME, useValue: runtime },
    ];
    if (resolved.requires.includes('redis')) {
      const conn = opts.redis;
      if (!conn) throw new Error(`g02: strategy '${resolved.id}'는 Redis가 필요하지만 RunConfig.redis가 없습니다`);
      providers.push({ provide: G02_REDIS, useFactory: () => createRedis(conn) });
    }
    return {
      module: G02Module,
      imports: [MikroOrmModule.forFeature([Product, OrderLedger])],
      controllers: [G02Controller],
      providers,
    };
  }
}
