import { performance } from 'node:perf_hooks';

import {
  type InstrumentationLevel,
  INSTRUMENTATION_LEVEL_VALUES,
  INSTRUMENTATION_LEVELS,
  METRICS,
  type MetricSpec,
} from '@under-load/contracts';
import { collectDefaultMetrics, Counter, Gauge, Histogram, type OpenMetricsContentType, Registry } from 'prom-client';

/** C5: app 이 부팅할 때 붙이는 기본 라벨(run_id·scenario·strategy·instrumentation). */
export type DefaultLabels = Record<string, string>;

/** pg 풀에서 지표가 읽는 부분(pg 타입을 앱이 직접 의존하지 않도록 구조 타입만 둔다). */
export interface PoolLike {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

/** 시간(초) 히스토그램 버킷: 1ms–10s(C5). */
const DURATION_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
/** 개수 히스토그램 버킷(changeset 수·identity map 크기). */
const COUNT_BUCKETS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 5000];

const levelRank = (level: InstrumentationLevel): number => INSTRUMENTATION_LEVEL_VALUES.indexOf(level);

function specOf(name: string): MetricSpec {
  const spec = METRICS.find((m) => m.name === name);
  if (!spec) throw new Error(`C5 에 없는 지표: ${name}`);
  return spec;
}

/**
 * 계측 수준별 지표 묶음. 수준이 켜지 않는 지표는 undefined 라 호출 쪽은 `m.x?.observe(...)` 로 쓴다.
 * 레지스트리는 OpenMetrics 형식(exemplar 출력에 필요, prom-client README "Exemplars").
 */
export class LabMetrics {
  readonly registry = new Registry<OpenMetricsContentType>();

  readonly httpDuration?: Histogram<string>;
  readonly httpInFlight?: Gauge<string>;
  readonly poolAcquireDuration?: Histogram<string>;
  readonly poolAcquireTimeouts?: Counter<string>;
  readonly ormFlushDuration?: Histogram<string>;
  readonly ormFlushChangesets?: Histogram<string>;
  readonly ormTransactions?: Counter<string>;
  readonly ormTransactionDuration?: Histogram<string>;
  readonly ormQueryDuration?: Histogram<string>;
  readonly ormIdentityMapSize?: Histogram<string>;
  /** 이벤트 파이프라인(다른 티켓)이 증가시키는 카운터. 이름·수준은 C5 그대로. */
  readonly eventsEmitted?: Counter<string>;
  readonly eventsDropped?: Counter<string>;
  readonly eventsBatchesFailed?: Counter<string>;
  /** 지연 주입 카운터(off+). */
  readonly injectedDelay?: Counter<string>;
  readonly injectedDelaySeconds?: Counter<string>;

  #pool: PoolLike | null = null;

  constructor(readonly level: InstrumentationLevel) {
    this.registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
    const registers = [this.registry];
    const enabled = (name: string): MetricSpec | null => {
      const spec = specOf(name);
      if (spec.level === 'always') return null;
      return levelRank(spec.level) <= levelRank(INSTRUMENTATION_LEVELS[level].metricsUpTo) ? spec : null;
    };
    const hist = (name: string, help: string, buckets: number[], exemplars = false): Histogram<string> | undefined => {
      const spec = enabled(name);
      return spec
        ? new Histogram({ name, help, labelNames: [...spec.labels], buckets, registers, enableExemplars: exemplars })
        : undefined;
    };
    const counter = (name: string, help: string): Counter<string> | undefined => {
      const spec = enabled(name);
      return spec ? new Counter({ name, help, labelNames: [...spec.labels], registers }) : undefined;
    };
    const gauge = (name: string, help: string, collect?: (g: Gauge<string>) => void): Gauge<string> | undefined => {
      const spec = enabled(name);
      if (!spec) return undefined;
      return new Gauge({
        name,
        help,
        labelNames: [...spec.labels],
        registers,
        ...(collect ? { collect() { collect(this); } } : {}),
      });
    };

    // off+ : RED, 주입 카운터, info
    this.httpDuration = hist('lab_http_request_duration_seconds', 'HTTP 요청 처리 시간(초)', DURATION_BUCKETS, level === 'full');
    this.httpInFlight = gauge('lab_http_requests_in_flight', '처리 중인 HTTP 요청 수');
    this.injectedDelay = counter('lab_injected_delay_total', '지연 주입 횟수');
    this.injectedDelaySeconds = counter('lab_injected_delay_seconds_total', '지연 주입 누적 시간(초)');
    gauge('lab_instrumentation_info', '계측 수준 정보')?.set({ level }, 1);

    // metrics+ : 런타임
    if (enabled('lab_eventloop_utilization')) {
      let prev = performance.eventLoopUtilization();
      gauge('lab_eventloop_utilization', '이벤트 루프 사용률(직전 스크레이프 이후, 0..1)', (g) => {
        const cur = performance.eventLoopUtilization();
        g.set(performance.eventLoopUtilization(cur, prev).utilization);
        prev = cur;
      });
    }
    gauge('lab_uv_threadpool_size', 'libuv 스레드풀 크기')?.set(Number(process.env.UV_THREADPOOL_SIZE) || 4);
    if (enabled('nodejs_heap_size_used_bytes')) {
      // C5 의 prom-client 기본 지표(promClientDefault)는 이 호출 하나로 모두 나온다.
      collectDefaultMetrics({ register: this.registry });
    }

    // metrics+ : 풀·ORM
    gauge('lab_db_pool_connections', 'pg 풀 연결 수(state=total|idle|waiting)', (g) => {
      g.set({ state: 'total' }, this.#pool?.totalCount ?? 0);
      g.set({ state: 'idle' }, this.#pool?.idleCount ?? 0);
      g.set({ state: 'waiting' }, this.#pool?.waitingCount ?? 0);
    });
    this.poolAcquireDuration = hist('lab_db_pool_acquire_duration_seconds', '풀 acquire 대기 시간(초)', DURATION_BUCKETS);
    this.poolAcquireTimeouts = counter('lab_db_pool_acquire_timeouts_total', '풀 acquire 타임아웃 횟수');
    this.ormFlushDuration = hist('lab_orm_flush_duration_seconds', 'ORM flush 시간(초)', DURATION_BUCKETS);
    this.ormFlushChangesets = hist('lab_orm_flush_changesets', 'flush 한 번의 changeset 수', COUNT_BUCKETS);
    this.ormTransactions = counter('lab_orm_transactions_total', 'ORM 트랜잭션 수(result=commit|rollback)');
    this.ormTransactionDuration = hist('lab_orm_transaction_duration_seconds', 'ORM 트랜잭션 시간(초)', DURATION_BUCKETS);
    this.eventsEmitted = counter('lab_events_emitted_total', '발행한 이벤트 수');
    this.eventsDropped = counter('lab_events_dropped_total', '버린 이벤트 수');
    this.eventsBatchesFailed = counter('lab_events_batches_failed_total', '전송 실패한 이벤트 배치 수');

    // full
    this.ormQueryDuration = hist('lab_orm_query_duration_seconds', 'ORM 쿼리 시간(초)', DURATION_BUCKETS);
    this.ormIdentityMapSize = hist('lab_orm_identity_map_size', 'flush 시점 identity map 크기', COUNT_BUCKETS);
  }

  /** onPoolCreated 훅이 풀을 연결한다(풀 게이지가 스크레이프 때 읽는다). */
  attachPool(pool: PoolLike): void {
    this.#pool = pool;
  }
}

let current: LabMetrics | null = null;

/**
 * 프로세스당 하나. poolHooks/ormHooks 는 Nest DI 이전(ORM 설정 시점)에 불리므로 모듈 싱글턴으로 공유한다.
 * 수준이 다르게 다시 요청되면 설정 오류이므로 던진다.
 */
export function getLabMetrics(level: InstrumentationLevel): LabMetrics {
  if (current && current.level !== level) {
    throw new Error(`LabMetrics 는 이미 level=${current.level} 로 만들어졌다(요청: ${level})`);
  }
  return (current ??= new LabMetrics(level));
}

/** 테스트용: 싱글턴을 버린다. */
export function resetLabMetrics(): void {
  current?.registry.clear();
  current = null;
}
