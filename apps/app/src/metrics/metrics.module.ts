import {
  type CallHandler,
  Controller,
  type DynamicModule,
  type ExecutionContext,
  Get,
  Inject,
  Injectable,
  type NestInterceptor,
  Module,
  Res,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import type { InstrumentationLevel } from '@under-load/contracts';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

import { type DefaultLabels, getLabMetrics, type LabMetrics } from './lab-metrics';

export const LAB_METRICS = Symbol('LAB_METRICS');

const METRICS_PATH = '/metrics';
/** W3C traceparent: version-traceid-spanid-flags. 헤더만 직접 파싱한다(OTel 이 꺼져 있어도 동작, C4). */
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

function exemplarOf(req: Request): { trace_id: string; span_id: string } | undefined {
  const header = req.headers['traceparent'];
  const m = typeof header === 'string' ? TRACEPARENT.exec(header.trim().toLowerCase()) : null;
  if (!m || /^0+$/.test(m[1]!)) return undefined;
  return { trace_id: m[1]!, span_id: m[2]! };
}

@Controller()
export class MetricsController {
  constructor(@Inject(LAB_METRICS) private readonly metrics: LabMetrics) {}

  @Get(METRICS_PATH)
  async scrape(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }
}

/** 전역 RED 인터셉터: 요청 시간 히스토그램 + 진행 중 게이지. 상태 코드는 응답이 끝난 뒤(예외 필터 이후) 읽는다. */
@Injectable()
export class RedInterceptor implements NestInterceptor {
  constructor(@Inject(LAB_METRICS) private readonly metrics: LabMetrics) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const route: string = req.route?.path ?? 'unmatched';
    const { httpDuration, httpInFlight } = this.metrics;
    if (route === METRICS_PATH || !httpDuration) return next.handle();

    const start = process.hrtime.bigint();
    const exemplarLabels = this.metrics.level === 'full' ? exemplarOf(req) : undefined;
    httpInFlight?.inc({ route });
    res.once('close', () => {
      httpInFlight?.dec({ route });
      const labels = { method: req.method, route, status: String(res.statusCode) };
      const value = Number(process.hrtime.bigint() - start) / 1e9;
      if (this.metrics.level === 'full') {
        // exemplar 가 켜진 히스토그램은 {labels, value, exemplarLabels} 형식만 받는다.
        httpDuration.observe({ labels, value, ...(exemplarLabels ? { exemplarLabels } : {}) } as never);
      } else {
        httpDuration.observe(labels, value);
      }
    });
    return next.handle();
  }
}

@Module({})
export class MetricsModule {
  /** `/metrics`(OpenMetrics) + 전역 RED 인터셉터. labels 는 C5 기본 라벨(run_id·scenario·strategy·instrumentation). */
  static register(level: InstrumentationLevel, labels: DefaultLabels): DynamicModule {
    const metrics = getLabMetrics(level);
    metrics.registry.setDefaultLabels(labels);
    return {
      module: MetricsModule,
      controllers: [MetricsController],
      providers: [
        { provide: LAB_METRICS, useValue: metrics },
        { provide: APP_INTERCEPTOR, useClass: RedInterceptor },
      ],
      exports: [LAB_METRICS],
    };
  }
}
