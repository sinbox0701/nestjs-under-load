import { ConsoleLogger, type DynamicModule, type LogLevel, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { isSpanContextValid, trace } from '@opentelemetry/api';

import type { Env } from './config/env';
import type { RunConfig } from './config/run-config';
import { buildOrmOptions } from './database/orm-options';
import { type EventMetrics, EventsModule } from './events';
import { LAB_STATE, LabController, type LabState } from './lab/lab.controller';
import { type DefaultLabels, getLabMetrics, type LabMetrics, MetricsModule, type PoolLike } from './metrics';
import type { ScenarioPack } from './packs/registry';
import { getRequestContext, RequestContextModule } from './request-context';
import { shutdownTracing } from './tracing';

/** 지금 요청의 trace-id: 요청 컨텍스트(traceparent 헤더) → 없으면 OTel 활성 span(full 의 루트 샘플). */
function currentTraceId(): string | undefined {
  const fromHeader = getRequestContext()?.traceId;
  if (fromHeader) return fromHeader;
  const sc = trace.getActiveSpan()?.spanContext();
  return sc && isSpanContextValid(sc) ? sc.traceId : undefined;
}

/**
 * Nest 로그를 한 줄 JSON 으로 내고, 요청 안이면 `trace_id` 를 붙인다.
 * Alloy(infra/alloy/config.alloy)가 app 로그를 `stage.json` 으로 읽어 trace_id 를 structured metadata 로 보낸다.
 */
export class LabJsonLogger extends ConsoleLogger {
  constructor() {
    super({ json: true });
  }

  protected override getJsonLogObject(
    message: unknown,
    options: { context: string; logLevel: LogLevel; writeStreamType?: 'stdout' | 'stderr'; errorStack?: unknown },
  ) {
    const obj = super.getJsonLogObject(message, options);
    const traceId = currentTraceId();
    return traceId ? { ...obj, trace_id: traceId } : obj;
  }
}

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
    Logger.overrideLogger(new LabJsonLogger());
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
