import { type DynamicModule, Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { G02Controller, type G02Runtime } from './api/g02.controller';
import { OrderLedger } from './entities/order-ledger.entity';
import { Product } from './entities/product.entity';
import { resolveStrategy } from './strategy-registry';
import { createContentionWindow, type InjectDelay } from './support/contention-window';
import { G02_RUNTIME, G02_STRATEGY, G02_STRATEGY_PARAMS } from './support/tokens';

export interface G02ModuleOptions {
  strategy: string;
  strategyParams?: unknown;
  instance: string;
  injectDelay?: InjectDelay[];
}

/**
 * G02 동적 모듈: 엔티티 등록 + strategy provider 팩토리(DESIGN §6.1 module.ts, §6.3).
 * 부팅 시 RunConfig의 strategy 하나만 provider로 등록한다. 실행 중 교체는 하지 않는다(§5.3).
 */
@Module({})
export class G02Module {
  static register(opts: G02ModuleOptions): DynamicModule {
    const resolved = resolveStrategy(opts.strategy, opts.strategyParams);
    const runtime: G02Runtime = {
      instance: opts.instance,
      contentionWindow: createContentionWindow(opts.injectDelay ?? []),
    };
    return {
      module: G02Module,
      imports: [MikroOrmModule.forFeature([Product, OrderLedger])],
      controllers: [G02Controller],
      providers: [
        { provide: G02_STRATEGY, useClass: resolved.cls },
        { provide: G02_STRATEGY_PARAMS, useValue: resolved.params },
        { provide: G02_RUNTIME, useValue: runtime },
      ],
    };
  }
}
