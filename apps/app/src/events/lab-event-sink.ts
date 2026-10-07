import {
  AGG_WINDOW_MS,
  type AggWindow,
  type EventFields,
  type EventSink,
  type IngestBatch,
  type Phase,
  type PoolStats,
  type WireEventV0,
} from '@under-load/contracts';

import { getRequestContext } from '../request-context';

/** 이벤트 카운터 주입점(C5 lab_events_*). prom-client 배선은 metrics 쪽(T-137)이 한다. */
export interface EventMetrics {
  /** kind = 'event'(대표 전체 이벤트) | 'agg'(집계에만 합산) */
  emitted(kind: 'event' | 'agg'): void;
  dropped(count: number): void;
  batchFailed(): void;
}

export const NOOP_EVENT_METRICS: EventMetrics = { emitted() {}, dropped() {}, batchFailed() {} };

export interface LabEventSinkOptions {
  runId: string;
  instance: string;
  /** 모든 이벤트 attrs 에 항상 병합한다(WireEventV0: attrs 가 있으면 attrs.strategy 필수) */
  strategy: string;
  /** agg = 집계만(metrics), representative+agg = 대표 전체 + 집계(full) */
  mode: 'agg' | 'representative+agg';
  /** 수집기 URL. 경로가 없으면 `/ingest/events` 를 붙인다 */
  endpoint: string;
  flushMs: number;
  batchMax: number;
  bufferMax: number;
  metrics?: EventMetrics;
  /** 배치에 동봉할 DB 풀 스냅샷 */
  pool?: () => PoolStats | undefined;
  fetchImpl?: typeof fetch;
  postTimeoutMs?: number;
  now?: () => number;
}

const INGEST_PATH = '/ingest/events';

/**
 * C4/C9 EventSink 구현. emit 은 동기·메모리 연산만 하고(요청을 막지 않는다),
 * 전송은 타이머가 배치로 한다. 버퍼가 차면 버리고 센다.
 */
export class LabEventSink implements EventSink {
  readonly enabled = true;

  private readonly o: LabEventSinkOptions;
  private readonly metrics: EventMetrics;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private seq = 0;
  private droppedTotal = 0;
  private events: WireEventV0[] = [];
  /** windowStart(ms) → phase 카운트 */
  private windows = new Map<number, Record<string, number>>();
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(options: LabEventSinkOptions) {
    this.o = options;
    this.metrics = options.metrics ?? NOOP_EVENT_METRICS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    const u = new URL(options.endpoint);
    if (u.pathname === '/' || u.pathname === '') u.pathname = INGEST_PATH;
    this.url = u.toString();
  }

  get droppedCount(): number {
    return this.droppedTotal;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.o.flushMs);
    this.timer.unref();
  }

  /** 남은 것을 한 번 비우고 멈춘다. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush(true);
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  emit(phase: Phase, fields?: EventFields): void {
    const ctx = getRequestContext();
    const nowMs = this.now();
    const sampled = ctx?.sampled ?? false;

    const ws = Math.floor(nowMs / AGG_WINDOW_MS) * AGG_WINDOW_MS;
    let counts = this.windows.get(ws);
    if (!counts) this.windows.set(ws, (counts = {}));
    counts[phase] = (counts[phase] ?? 0) + 1;

    if (!(sampled && this.o.mode === 'representative+agg')) {
      this.metrics.emitted('agg');
      return;
    }
    this.metrics.emitted('event');
    if (this.events.length >= this.o.bufferMax) {
      this.drop(1);
      return;
    }
    const ev: WireEventV0 = {
      v: 0,
      runId: this.o.runId,
      ts: nowMs * 1000,
      seq: this.seq++,
      instance: this.o.instance,
      actor: ctx?.actor ?? '-',
      phase,
      ...(ctx?.reqId ? { reqId: ctx.reqId } : {}),
      ...(ctx?.traceId ? { traceId: ctx.traceId } : {}),
      ...(fields?.entity ? { entity: fields.entity } : {}),
      ...(fields?.durMs !== undefined ? { durMs: fields.durMs } : {}),
      // strategy 는 호출자 값보다 RunConfig 값이 우선한다(항상 병합)
      attrs: { ...fields?.attrs, strategy: this.o.strategy },
      sampled: true,
      ...(fields?.injected !== undefined ? { injected: fields.injected } : {}),
      ...(fields?.sql !== undefined ? { sql: fields.sql } : {}),
      ...(fields?.rows !== undefined ? { rows: fields.rows } : {}),
      ...(fields?.note !== undefined ? { note: fields.note } : {}),
    };
    this.events.push(ev);
  }

  private drop(n: number): void {
    if (n <= 0) return;
    this.droppedTotal += n;
    this.metrics.dropped(n);
  }

  /** 닫힌 창(현재 창 제외, final 이면 전부)을 꺼낸다. */
  private takeWindows(final: boolean): AggWindow[] {
    const cur = Math.floor(this.now() / AGG_WINDOW_MS) * AGG_WINDOW_MS;
    const out: AggWindow[] = [];
    for (const [ws, counts] of [...this.windows.entries()].sort((a, b) => a[0] - b[0])) {
      if (!final && ws >= cur) continue;
      this.windows.delete(ws);
      out.push({
        v: 0,
        runId: this.o.runId,
        instance: this.o.instance,
        windowStart: ws,
        windowMs: AGG_WINDOW_MS,
        counts: counts as AggWindow['counts'],
        dropped: this.droppedTotal,
      });
    }
    return out;
  }

  async flush(final = false): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      // 이벤트가 batchMax 를 넘으면 여러 번 보낸다(한 번 실패하면 다음 틱에 다시).
      do {
        const batchEvents = this.events.splice(0, this.o.batchMax);
        const batchAgg = this.takeWindows(final);
        if (batchEvents.length === 0 && batchAgg.length === 0) return;
        const ok = await this.post(batchEvents, batchAgg);
        if (!ok) return;
      } while (this.events.length > 0);
    } finally {
      this.flushing = false;
    }
  }

  /** true = 처리 끝(성공 또는 버림), false = 실패해서 되돌림. */
  private async post(events: WireEventV0[], agg: AggWindow[]): Promise<boolean> {
    const body: IngestBatch = {
      v: 0,
      runId: this.o.runId,
      instance: this.o.instance,
      sentAt: this.now(),
      dropped: this.droppedTotal,
      events,
      agg,
      ...this.poolField(),
    };
    let status = 0;
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.postTimeoutMs ?? 2000),
      });
      status = res.status;
      void res.body?.cancel().catch(() => {});
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) return true;
    if (status === 409) {
      // 다른 실행의 배치: 버리고 센다(C4)
      this.drop(events.length);
      return true;
    }
    this.metrics.batchFailed();
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      // 재전송해도 같은 결과(400 등): 계속 쌓이지 않게 버린다
      this.drop(events.length);
      return true;
    }
    // 네트워크 오류·5xx·408·429: 앞쪽으로 되돌리고 bufferMax 를 넘는 최신분은 버린다
    this.events.unshift(...events);
    for (const w of agg) this.requeueWindow(w);
    const over = this.events.length - this.o.bufferMax;
    if (over > 0) {
      this.events.length = this.o.bufferMax;
      this.drop(over);
    }
    return false;
  }

  private requeueWindow(w: AggWindow): void {
    const cur = this.windows.get(w.windowStart) ?? {};
    for (const [p, n] of Object.entries(w.counts)) cur[p] = (cur[p] ?? 0) + (n ?? 0);
    this.windows.set(w.windowStart, cur);
    // 창이 끝없이 쌓이지 않게 bufferMax 개까지만 유지(오래된 것부터 버림, 이벤트 드롭 수에는 넣지 않는다)
    while (this.windows.size > this.o.bufferMax) {
      const oldest = Math.min(...this.windows.keys());
      this.windows.delete(oldest);
    }
  }

  private poolField(): { pool?: PoolStats } {
    try {
      const p = this.o.pool?.();
      return p ? { pool: p } : {};
    } catch {
      return {};
    }
  }
}
