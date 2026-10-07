import { type DynamicModule, Global, Module } from '@nestjs/common';
import {
  type EventSink,
  INSTRUMENTATION_LEVELS,
  LAB_EVENT_SINK,
  NOOP_EVENT_SINK,
  type PoolStats,
  type RunConfigV1,
} from '@under-load/contracts';

import { type EventMetrics, LabEventSink } from './lab-event-sink';

export interface EventsModuleOptions {
  runConfig: RunConfigV1;
  instance: string;
  metrics?: EventMetrics;
  pool?: () => PoolStats | undefined;
}

/** RunConfig 로 sink 를 만든다. off 이거나 events 설정이 없으면 noop. */
export function createEventSink(opts: EventsModuleOptions): EventSink {
  const { runConfig: rc } = opts;
  const mode = INSTRUMENTATION_LEVELS[rc.instrumentation].events;
  if (mode === 'off' || !rc.events) return NOOP_EVENT_SINK;
  const sink = new LabEventSink({
    runId: rc.runId,
    instance: opts.instance,
    strategy: rc.strategy,
    mode,
    endpoint: rc.events.endpoint,
    flushMs: rc.events.flushMs,
    batchMax: rc.events.batchMax,
    bufferMax: rc.events.bufferMax,
    metrics: opts.metrics,
    pool: opts.pool,
  });
  sink.start();
  return sink;
}

/**
 * 이벤트 sink 주입점(C9). 기본(`EventsModule` 그대로 import)은 noop 이고,
 * `EventsModule.register(...)` 가 같은 토큰을 실제 sink 로 교체한다. 팩 컨트롤러는 `@Optional()` 로 받는다.
 */
@Global()
@Module({
  providers: [{ provide: LAB_EVENT_SINK, useValue: NOOP_EVENT_SINK }],
  exports: [LAB_EVENT_SINK],
})
export class EventsModule {
  static register(opts: EventsModuleOptions): DynamicModule {
    return {
      module: EventsModule,
      global: true,
      providers: [{ provide: LAB_EVENT_SINK, useFactory: () => createEventSink(opts) }],
      exports: [LAB_EVENT_SINK],
    };
  }
}
