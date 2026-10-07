import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { isSpanContextValid, trace } from '@opentelemetry/api';

import { getRequestContext } from '../request-context';

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
 * bootstrap 이 맨 앞에서 `Logger.overrideLogger(new LabJsonLogger())` 로 건다.
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
