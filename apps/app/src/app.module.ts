import { type DynamicModule, Module, type OnApplicationShutdown } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import type { Env } from './config/env';
import type { RunConfig } from './config/run-config';
import { buildOrmOptions } from './database/orm-options';
import { type EventMetrics, EventsModule } from './events';
import { LAB_STATE, LabController, type LabState } from './lab/lab.controller';
import { type DefaultLabels, getLabMetrics, type LabMetrics, MetricsModule, type PoolLike } from './metrics';
import type { ScenarioPack } from './packs/registry';
import { RequestContextModule } from './request-context';
import { shutdownTracing } from './tracing';

/** C5 기본 라벨(METRIC_DEFAULT_LABELS 순서). */
function defaultLabels(rc: RunConfig): DefaultLabels {
  return { run_id: rc.runId, scenario: rc.scenario, strategy: rc.strategy, instrumentation: rc.instrumentation };
}

/** EventsModule 이 세는 값을 C5 이벤트 카운터로 옮긴다(수준이 끄면 카운터가 없어 아무것도 안 한다). */
function eventMetricsOf(m: LabMetrics): EventMetrics {
  return {
    emitted: (kind) => m.eventsEmitted?.inc({ kind }),
    dropped: (count) => m.eventsDropped?.inc(count),
    batchFailed: () => m.eventsBatchesFailed?.inc(),
  };
}

@Module({})
export class AppModule implements OnApplicationShutdown {
  /**
   * RunConfig가 있으면 지표·이벤트·ORM + 선택된 시나리오 모듈을 붙이고, 없으면 /_lab만 뜨는 대기 모드.
   * 계측 수준 하나(RunConfig.instrumentation)를 MetricsModule·풀/ORM 훅·이벤트 카운터가 같이 쓴다(getLabMetrics 공유).
   */
  static register(env: Env, runConfig: RunConfig | null, pack: ScenarioPack | null): DynamicModule {
    const state: LabState = { instance: env.INSTANCE_NAME, runConfig, bootedAt: new Date().toISOString() };
    const imports: DynamicModule['imports'] = [RequestContextModule];
    if (runConfig && pack) {
      const level = runConfig.instrumentation;
      let pool: PoolLike | null = null;
      imports.push(
        MetricsModule.register(level, defaultLabels(runConfig)),
        EventsModule.register({
          runConfig,
          instance: env.INSTANCE_NAME,
          metrics: eventMetricsOf(getLabMetrics(level)),
          pool: () => (pool ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } : undefined),
        }),
        MikroOrmModule.forRoot(
          buildOrmOptions(env, pack, runConfig.pool, {
            instrumentation: level,
            timeouts: runConfig.timeouts,
            onPoolCreated: (p) => {
              pool = p;
            },
          }),
        ),
        pack.createModule({
          strategy: runConfig.strategy,
          strategyParams: runConfig.strategyParams,
          instance: env.INSTANCE_NAME,
          injectDelay: runConfig.injectDelay,
          redis: runConfig.redis,
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

  /** enableShutdownHooks(SIGTERM) 경로: 남은 span 을 내보내고 OTel SDK 를 끈다(켜져 있지 않으면 아무것도 안 함). */
  async onApplicationShutdown(): Promise<void> {
    await shutdownTracing();
  }
}
