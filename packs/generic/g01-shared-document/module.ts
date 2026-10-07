import { type DynamicModule, Module, type Provider } from '@nestjs/common';

import { G01Controller, type G01Runtime } from './api/g01.controller';
import { G01_RUNTIME, G01_STRATEGY, G01_STRATEGY_PARAMS } from './api/tokens';
import { resolveStrategy } from './strategy-registry';
import { createContentionWindow, type InjectDelay } from './support/contention-window';

export interface G01ModuleOptions {
  strategy: string;
  strategyParams?: unknown;
  instance: string;
  injectDelay?: InjectDelay[];
}

/**
 * G01 동적 모듈: 컨트롤러 + strategy provider 팩토리(DESIGN §6.1 module.ts, §6.3).
 * 부팅 시 RunConfig의 strategy 하나만 provider로 등록한다. 실행 중 교체는 하지 않는다(§5.3).
 * strategy 클래스는 @Injectable이 없고 생성자 의존성도 없다. `useClass`가 그대로 `new`로 만든다.
 * EntityManager는 app의 MikroOrmModule.forRoot(전역)가 제공한다(저장소를 쓰지 않으므로 forFeature 불필요).
 */
@Module({})
export class G01Module {
  static register(opts: G01ModuleOptions): DynamicModule {
    const resolved = resolveStrategy(opts.strategy, opts.strategyParams);
    const runtime: G01Runtime = {
      instance: opts.instance,
      contentionWindow: createContentionWindow(opts.injectDelay ?? []),
    };
    const providers: Provider[] = [
      { provide: G01_STRATEGY, useClass: resolved.cls },
      { provide: G01_STRATEGY_PARAMS, useValue: resolved.params },
      { provide: G01_RUNTIME, useValue: runtime },
    ];
    return { module: G01Module, controllers: [G01Controller], providers };
  }
}
