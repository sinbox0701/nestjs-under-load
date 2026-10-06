import { type DynamicModule, Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import type { Env } from './config/env';
import type { RunConfig } from './config/run-config';
import { buildOrmOptions } from './database/orm-options';
import { LAB_STATE, LabController, type LabState } from './lab/lab.controller';
import type { ScenarioPack } from './packs/registry';

@Module({})
export class AppModule {
  /**
   * RunConfig가 있으면 ORM + 선택된 시나리오 모듈을 붙이고, 없으면 /_lab만 뜨는 대기 모드.
   */
  static register(env: Env, runConfig: RunConfig | null, pack: ScenarioPack | null): DynamicModule {
    const state: LabState = { instance: env.INSTANCE_NAME, runConfig, bootedAt: new Date().toISOString() };
    const imports: DynamicModule['imports'] = [];
    if (runConfig && pack) {
      imports.push(
        MikroOrmModule.forRoot(buildOrmOptions(env, pack, runConfig.pool)),
        pack.createModule({
          strategy: runConfig.strategy,
          strategyParams: runConfig.strategyParams,
          instance: env.INSTANCE_NAME,
          injectDelay: runConfig.injectDelay,
        }),
      );
    }
    return {
      module: AppModule,
      imports,
      controllers: [LabController],
      providers: [{ provide: LAB_STATE, useValue: state }],
    };
  }
}
