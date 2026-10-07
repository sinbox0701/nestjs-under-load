import { INSTRUMENTATION_LEVELS, type RunConfigV1 } from '@under-load/contracts';

/**
 * OTel SDK 는 off·metrics 에서 로드조차 하지 않도록 켜질 때만 require 한다(C6, 모듈 로드 검사).
 * 반드시 http·express·pg 등을 불러오기 전에 호출해야 한다(main.ts: reflect-metadata → tracing → bootstrap).
 */
interface Shutdownable {
  shutdown(): Promise<void>;
}

let sdk: Shutdownable | null = null;

export interface StartTracingOptions {
  runConfig: Pick<RunConfigV1, 'instrumentation' | 'tracing' | 'runId' | 'scenario' | 'strategy'>;
  instance: string;
}

/** 이 단계에서 SDK 를 켜야 하는가: full(otel.enabled)이고 tracing 설정이 있을 때만. */
export function tracingEnabled(rc: StartTracingOptions['runConfig']): boolean {
  return INSTRUMENTATION_LEVELS[rc.instrumentation].otel.enabled && rc.tracing !== null;
}

const TRACES_PATH = '/v1/traces';
function tracesUrl(endpoint: string): string {
  const u = new URL(endpoint);
  if (u.pathname === '/' || u.pathname === '') u.pathname = TRACES_PATH;
  return u.toString();
}

/** 켰으면 true. 이미 켜져 있거나 꺼야 하는 수준이면 false. */
export function startTracing(opts: StartTracingOptions): boolean {
  const { runConfig: rc } = opts;
  if (sdk || !tracingEnabled(rc) || !rc.tracing) return false;

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { NodeSDK } = require('@opentelemetry/sdk-node') as typeof import('@opentelemetry/sdk-node');
  const { resourceFromAttributes } = require('@opentelemetry/resources') as typeof import('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions') as typeof import('@opentelemetry/semantic-conventions');
  const { ParentBasedSampler, TraceIdRatioBasedSampler } =
    require('@opentelemetry/sdk-trace-node') as typeof import('@opentelemetry/sdk-trace-node');
  const { OTLPTraceExporter } =
    require('@opentelemetry/exporter-trace-otlp-proto') as typeof import('@opentelemetry/exporter-trace-otlp-proto');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http') as typeof import('@opentelemetry/instrumentation-http');
  const { ExpressInstrumentation } =
    require('@opentelemetry/instrumentation-express') as typeof import('@opentelemetry/instrumentation-express');
  const { NestInstrumentation } =
    require('@opentelemetry/instrumentation-nestjs-core') as typeof import('@opentelemetry/instrumentation-nestjs-core');
  const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg') as typeof import('@opentelemetry/instrumentation-pg');
  const { IORedisInstrumentation } =
    require('@opentelemetry/instrumentation-ioredis') as typeof import('@opentelemetry/instrumentation-ioredis');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const started = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'nul-app',
      'service.instance.id': opts.instance,
      'lab.run_id': rc.runId,
      'lab.scenario': rc.scenario,
      'lab.strategy': rc.strategy,
    }),
    // parentbased_traceidratio: 부모가 있으면 그 플래그를 따르고(대표 = 01 → 항상 기록), 루트는 비율 샘플
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(rc.tracing.rootSampleRatio) }),
    traceExporter: new OTLPTraceExporter({ url: tracesUrl(rc.tracing.endpoint) }),
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new NestInstrumentation(),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });
  started.start();
  sdk = started;
  return true;
}

/** 남은 span 을 내보내고 끈다. */
export async function shutdownTracing(): Promise<void> {
  const s = sdk;
  sdk = null;
  await s?.shutdown();
}
