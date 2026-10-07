// EventHub 구현(T-112): /ingest/events 수신·검증, 실행별 링버퍼, events/agg ndjson 추가 쓰기, WS 팬아웃, lab_orch_* 지표.
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { INGEST_MAX_BYTES, IngestBatchSchema, WS_CURRENT } from '@under-load/contracts';
import type { AggWindow, IngestBatch, WsMessage } from '@under-load/contracts';
import { WebSocketServer, type WebSocket } from 'ws';

import { HttpError } from '../http/index.js';
import type { Routers } from '../http/index.js';
import type { Clock, EventHub, EventHubRunContext, IngestResult } from '../ports.js';

export type EventHubOptions = {
  clock: Clock;
  /** 실행당 이벤트 링버퍼 크기(기본 5000) */
  ringEvents?: number;
  /** 실행당 집계 창 링버퍼 크기(기본 600) */
  ringAgg?: number;
  /** 메모리에 남겨 둘 지난 실행 수(현재 실행 제외, 기본 2) */
  keepRuns?: number;
  /** 소켓 송신 대기량 상한(바이트). 넘으면 끊는다(기본 8MiB) */
  maxBufferedBytes?: number;
};

/** 가득 차면 가장 오래된 것부터 덮어쓰는 고정 크기 버퍼. */
class Ring<T> {
  private buf: T[] = [];
  private start = 0;
  private readonly cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  push(items: readonly T[]): void {
    for (const it of items) {
      if (this.buf.length < this.cap) this.buf.push(it);
      else {
        this.buf[this.start] = it;
        this.start = (this.start + 1) % this.cap;
      }
    }
  }
  toArray(): T[] {
    return this.buf.slice(this.start).concat(this.buf.slice(0, this.start));
  }
}

type RunState = {
  ctx: EventHubRunContext;
  events: Ring<IngestBatch['events'][number]>;
  agg: Ring<AggWindow>;
  /** 재접속 재생용 마지막 status·pool·probe·invariants·end */
  last: Map<string, WsMessage>;
  eventsOut: WriteStream | null;
  aggOut: WriteStream | null;
};

type Client = { ws: WebSocket; target: string };

const closeStream = (s: WriteStream | null) =>
  new Promise<void>((resolve) => {
    if (!s) return resolve();
    s.once('error', () => resolve());
    s.end(() => resolve());
  });

const openAppend = (file: string) => {
  const s = createWriteStream(file, { flags: 'a' });
  s.on('error', () => {});
  return s;
};

export class EventHubImpl implements EventHub {
  private readonly clock: Clock;
  private readonly ringEvents: number;
  private readonly ringAgg: number;
  private readonly keepRuns: number;
  private readonly maxBuffered: number;
  private readonly runs = new Map<string, RunState>();
  private current: string | null = null;
  private readonly clients = new Set<Client>();
  private readonly wss = new WebSocketServer({ noServer: true });
  private registered = false;
  private ingestEvents = 0;
  private readonly rejected = { run_mismatch: 0, invalid: 0 };

  constructor(opts: EventHubOptions) {
    this.clock = opts.clock;
    this.ringEvents = opts.ringEvents ?? 5000;
    this.ringAgg = opts.ringAgg ?? 600;
    this.keepRuns = opts.keepRuns ?? 2;
    this.maxBuffered = opts.maxBufferedBytes ?? 8 * 1024 * 1024;
  }

  async beginRun(ctx: EventHubRunContext): Promise<void> {
    await mkdir(ctx.dir, { recursive: true });
    const old = this.runs.get(ctx.runId);
    if (old) {
      await closeStream(old.eventsOut);
      await closeStream(old.aggOut);
    }
    this.runs.set(ctx.runId, {
      ctx,
      events: new Ring(this.ringEvents),
      agg: new Ring(this.ringAgg),
      last: new Map(),
      eventsOut: openAppend(join(ctx.dir, 'events.ndjson')),
      aggOut: openAppend(join(ctx.dir, 'agg.ndjson')),
    });
    this.current = ctx.runId;
    // 오래된 실행 정리(Map 은 삽입 순서)
    const stale = [...this.runs.keys()].filter((id) => id !== this.current);
    for (const id of stale.slice(0, Math.max(0, stale.length - this.keepRuns))) this.runs.delete(id);
  }

  async endRun(runId: string): Promise<void> {
    const st = this.runs.get(runId);
    if (!st) return;
    const { eventsOut, aggOut } = st;
    st.eventsOut = null;
    st.aggOut = null;
    await Promise.all([closeStream(eventsOut), closeStream(aggOut)]);
    if (this.current === runId) this.current = null;
  }

  /** 구조 검증은 라우트(IngestBatchSchema)가 끝낸 배치를 받는다. */
  async ingest(batch: IngestBatch): Promise<IngestResult> {
    const st = this.runs.get(batch.runId);
    if (!st || this.current !== batch.runId) {
      this.rejected.run_mismatch++;
      return { ok: false, reason: 'run_mismatch' };
    }
    const at = this.clock.now();
    if (batch.events.length) {
      st.events.push(batch.events);
      st.eventsOut?.write(batch.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      this.ingestEvents += batch.events.length;
      this.publish({ type: 'events', runId: batch.runId, at, data: batch.events });
    }
    if (batch.agg.length) {
      st.agg.push(batch.agg);
      st.aggOut?.write(batch.agg.map((a) => JSON.stringify(a)).join('\n') + '\n');
      for (const a of batch.agg) this.publish({ type: 'agg', runId: batch.runId, at, data: a });
    }
    if (batch.pool) this.publish({ type: 'pool', runId: batch.runId, at, data: { ...batch.pool, instance: batch.instance } });
    return { ok: true, events: batch.events.length };
  }

  publish(message: WsMessage): void {
    const st = this.runs.get(message.runId);
    if (st && (message.type === 'status' || message.type === 'probe' || message.type === 'invariants' || message.type === 'end'))
      st.last.set(message.type, message);
    const text = JSON.stringify(message);
    for (const c of this.clients) {
      if (c.target === message.runId || (c.target === WS_CURRENT && this.current === message.runId)) this.send(c, text);
    }
  }

  snapshot(runId: string): { events: IngestBatch['events']; agg: AggWindow[] } {
    const st = this.runs.get(runId);
    return st ? { events: st.events.toArray(), agg: st.agg.toArray() } : { events: [], agg: [] };
  }

  private send(c: Client, text: string): void {
    if (c.ws.readyState !== 1) return;
    if (c.ws.bufferedAmount > this.maxBuffered) {
      c.ws.terminate();
      return;
    }
    c.ws.send(text);
  }

  /** 접속 직후 재생: 마지막 status 등 → 링버퍼 events → agg. */
  private replay(c: Client): void {
    const id = c.target === WS_CURRENT ? this.current : c.target;
    const st = id ? this.runs.get(id) : undefined;
    if (!st) return;
    const at = this.clock.now();
    for (const m of st.last.values()) this.send(c, JSON.stringify(m));
    const events = st.events.toArray();
    if (events.length) this.send(c, JSON.stringify({ type: 'events', runId: st.ctx.runId, at, data: events }));
    for (const a of st.agg.toArray()) this.send(c, JSON.stringify({ type: 'agg', runId: st.ctx.runId, at, data: a }));
  }

  registerRoutes(routers: Routers): void {
    if (this.registered) throw new Error('EventHub.registerRoutes 는 한 번만 부른다');
    this.registered = true;

    routers.internal.add('POST', '/ingest/events', async (ctx) => {
      let raw: unknown;
      try {
        raw = await ctx.readJson(INGEST_MAX_BYTES);
      } catch (err) {
        if (err instanceof HttpError && err.status === 400) this.rejected.invalid++;
        throw err;
      }
      const parsed = IngestBatchSchema.safeParse(raw);
      if (!parsed.success) {
        this.rejected.invalid++;
        throw new HttpError(400, { error: 'invalid batch', issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })) });
      }
      const r = await this.ingest(parsed.data);
      if (r.ok) return ctx.empty(204);
      if (r.reason === 'run_mismatch') throw new HttpError(409, { error: 'run_mismatch', current: this.current });
      throw new HttpError(400, { error: 'invalid batch' });
    });

    routers.internal.add('GET', '/metrics', (ctx) => ctx.send(200, this.renderMetrics(), 'text/plain; version=0.0.4; charset=utf-8'));

    routers.public.addUpgrade('/ws/runs/:runId', (req, socket, head, params) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const c: Client = { ws, target: params.runId! };
        this.clients.add(c);
        ws.on('close', () => this.clients.delete(c));
        ws.on('error', () => this.clients.delete(c));
        this.replay(c);
      });
    });
  }

  renderMetrics(): string {
    return [
      '# HELP lab_orch_ingest_events_total 수신해 받아들인 이벤트 수',
      '# TYPE lab_orch_ingest_events_total counter',
      `lab_orch_ingest_events_total ${this.ingestEvents}`,
      '# HELP lab_orch_ingest_rejected_total 거절한 수신 배치 수(사유별)',
      '# TYPE lab_orch_ingest_rejected_total counter',
      `lab_orch_ingest_rejected_total{reason="run_mismatch"} ${this.rejected.run_mismatch}`,
      `lab_orch_ingest_rejected_total{reason="invalid"} ${this.rejected.invalid}`,
      '# HELP lab_orch_ws_clients 접속 중인 WS 구독자 수',
      '# TYPE lab_orch_ws_clients gauge',
      `lab_orch_ws_clients ${this.clients.size}`,
      '',
    ].join('\n');
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    await Promise.all([...this.runs.values()].flatMap((s) => [closeStream(s.eventsOut), closeStream(s.aggOut)]));
    for (const s of this.runs.values()) {
      s.eventsOut = null;
      s.aggOut = null;
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

export const createEventHub = (opts: EventHubOptions): EventHub => new EventHubImpl(opts);
