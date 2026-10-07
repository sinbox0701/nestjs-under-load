import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';

import { Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  IngestBatchSchema,
  LAB_EVENT_SINK,
  type EventSink,
  type IngestBatch,
  type RunConfigV1,
  parseRunConfig,
} from '@under-load/contracts';

import { runWithRequestContext, type RequestContext } from '../request-context';
import { EventsModule } from './events.module';
import { LabEventSink, type EventMetrics, type LabEventSinkOptions } from './lab-event-sink';

interface Collector {
  url: string;
  batches: IngestBatch[];
  /** 다음 응답 상태를 정한다(함수면 호출마다) */
  respond: (n: number) => number;
  close(): Promise<void>;
}

async function collector(): Promise<Collector> {
  const batches: IngestBatch[] = [];
  let n = 0;
  const c: Collector = {
    url: '',
    batches,
    respond: () => 204,
    close: () => new Promise((r) => server.close(() => r())),
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const status = c.respond(n++);
      if (status >= 200 && status < 300) batches.push(JSON.parse(Buffer.concat(chunks).toString()) as IngestBatch);
      res.statusCode = status;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  c.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return c;
}

const rep: RequestContext = { actor: '1-1', reqId: 'r_1', traceId: '4bf92f3577b34da6a3ce929d0e0e4736', sampled: true };
const crowd: RequestContext = { actor: '99-1', reqId: 'r_2', sampled: false };

function counters(): EventMetrics & { dropped_: number; failed_: number; emitted_: Record<string, number> } {
  const m = {
    dropped_: 0,
    failed_: 0,
    emitted_: {} as Record<string, number>,
    emitted(k: string) {
      m.emitted_[k] = (m.emitted_[k] ?? 0) + 1;
    },
    dropped(n: number) {
      m.dropped_ += n;
    },
    batchFailed() {
      m.failed_++;
    },
  };
  return m;
}

const opts = (url: string, extra: Partial<LabEventSinkOptions> = {}): LabEventSinkOptions => ({
  runId: 'run-1',
  instance: 'app-1',
  strategy: 'row-lock',
  mode: 'representative+agg',
  endpoint: url,
  flushMs: 20,
  batchMax: 100,
  bufferMax: 1000,
  ...extra,
});

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const open: Collector[] = [];
after(async () => {
  for (const c of open) await c.close().catch(() => {});
});
const mk = async (): Promise<Collector> => {
  const c = await collector();
  open.push(c);
  return c;
};

test('AC-1 대표 요청 emit 3회 → v:0 이벤트 3개, seq 단조 증가, attrs.strategy 병합', async () => {
  const c = await mk();
  const sink = new LabEventSink(opts(c.url, { pool: () => ({ total: 10, idle: 4, waiting: 0 }) }));
  sink.start();
  runWithRequestContext(rep, () => {
    sink.emit('arrived');
    sink.emit('lock_wait', { entity: { type: 'Stock', id: '1' }, attrs: { attempt: 1 }, durMs: 3 });
    sink.emit('responded', { attrs: { strategy: '무시됨' } });
  });
  await until(() => c.batches.flatMap((b) => b.events).length >= 3);
  await sink.stop();

  const events = c.batches.flatMap((b) => b.events);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.seq), [0, 1, 2]);
  assert.deepEqual(events.map((e) => e.phase), ['arrived', 'lock_wait', 'responded']);
  for (const e of events) {
    assert.equal(e.v, 0);
    assert.equal(e.runId, 'run-1');
    assert.equal(e.instance, 'app-1');
    assert.equal(e.actor, '1-1');
    assert.equal(e.reqId, 'r_1');
    assert.equal(e.traceId, rep.traceId);
    assert.equal(e.sampled, true);
    assert.ok(Number.isInteger(e.ts) && e.ts > 1e15, 'epoch µs');
    assert.equal(e.attrs?.strategy, 'row-lock');
  }
  assert.deepEqual(events[1].entity, { type: 'Stock', id: '1' });
  assert.equal(events[1].attrs?.attempt, 1);
  // 계약 스키마(strict)로 배치 전체를 검증
  for (const b of c.batches) IngestBatchSchema.parse(b);
  assert.deepEqual(c.batches[0].pool, { total: 10, idle: 4, waiting: 0 });
});

test('AC-2 비대표 emit 은 events 에 없고 agg.counts 에 합산된다', async () => {
  const c = await mk();
  const m = counters();
  const sink = new LabEventSink(opts(c.url, { metrics: m }));
  sink.start();
  runWithRequestContext(crowd, () => {
    sink.emit('lock_wait');
    sink.emit('lock_wait');
    sink.emit('arrived');
  });
  await sink.stop();
  const all = c.batches;
  assert.equal(all.flatMap((b) => b.events).length, 0);
  const counts: Record<string, number> = {};
  for (const w of all.flatMap((b) => b.agg)) for (const [p, n] of Object.entries(w.counts)) counts[p] = (counts[p] ?? 0) + (n ?? 0);
  assert.deepEqual(counts, { lock_wait: 2, arrived: 1 });
  assert.equal(m.emitted_.agg, 3);
  for (const b of all) IngestBatchSchema.parse(b);
});

test('metrics 수준(mode=agg)은 대표 요청도 이벤트를 보내지 않는다', async () => {
  const c = await mk();
  const sink = new LabEventSink(opts(c.url, { mode: 'agg' }));
  sink.start();
  runWithRequestContext(rep, () => sink.emit('arrived'));
  await sink.stop();
  assert.equal(c.batches.flatMap((b) => b.events).length, 0);
  assert.equal(c.batches.flatMap((b) => b.agg).length, 1);
});

test('AC-3 수집기가 계속 실패하면 bufferMax 이후 dropped 가 늘고 emit 은 지연되지 않는다', async () => {
  const c = await mk();
  c.respond = () => 503;
  const m = counters();
  const sink = new LabEventSink(opts(c.url, { metrics: m, bufferMax: 50, batchMax: 10 }));
  sink.start();
  const N = 2000;
  const lat: number[] = [];
  runWithRequestContext(rep, () => {
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      sink.emit('db_read');
      lat.push(performance.now() - t);
    }
  });
  assert.ok(m.dropped_ >= N - 50, `dropped=${m.dropped_}`);
  await until(() => m.failed_ > 0);
  assert.ok(sink.droppedCount >= N - 50);

  // 단위 벤치: 실패 중인 sink 의 emit p99 − 기준(noop 루프) p99 < 5ms
  const p99 = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.99)];
  const base: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    void i;
    base.push(performance.now() - t);
  }
  assert.ok(p99(lat) - p99(base) < 5, `p99 diff=${p99(lat) - p99(base)}ms`);
  await sink.stop();
});

test('실패한 배치는 되돌려 재전송한다(순서·seq 보존)', async () => {
  const c = await mk();
  c.respond = (n) => (n < 2 ? 500 : 204);
  const m = counters();
  const sink = new LabEventSink(opts(c.url, { metrics: m }));
  sink.start();
  runWithRequestContext(rep, () => {
    sink.emit('arrived');
    sink.emit('responded');
  });
  await until(() => c.batches.flatMap((b) => b.events).length >= 2);
  await sink.stop();
  assert.deepEqual(c.batches.flatMap((b) => b.events).map((e) => e.seq), [0, 1]);
  assert.ok(m.failed_ >= 2);
  assert.equal(m.dropped_, 0);
});

test('AC-5 수집기가 409 를 주면 그 배치를 버리고 dropped 에 센다', async () => {
  const c = await mk();
  c.respond = () => 409;
  const m = counters();
  const sink = new LabEventSink(opts(c.url, { metrics: m }));
  sink.start();
  runWithRequestContext(rep, () => {
    sink.emit('arrived');
    sink.emit('responded');
  });
  await until(() => m.dropped_ === 2);
  assert.equal(sink.droppedCount, 2);
  assert.equal(m.failed_, 0);
  // 재전송하지 않는다
  c.respond = () => 204;
  await sink.stop();
  assert.equal(c.batches.flatMap((b) => b.events).length, 0);
});

test('EventsModule.register 가 LAB_EVENT_SINK 를 실제 sink 로 교체한다(off 면 noop)', async () => {
  const c = await mk();
  const rc: RunConfigV1 = parseRunConfig({
    schemaVersion: 1,
    task: 'serve',
    runId: 'run-9',
    batchId: 'b',
    repetition: 1,
    scenario: 's',
    strategy: 'no-lock',
    strategyParams: {},
    instrumentation: 'full',
    injectDelay: [],
    pool: { min: 1, max: 2, acquireTimeoutMs: null },
    timeouts: { serverRequestMs: null, statementMs: null, idleInTxMs: null },
    events: { endpoint: c.url, representativeActors: 8, flushMs: 20, batchMax: 100, bufferMax: 100 },
    tracing: null,
    redis: null,
  });

  @Injectable()
  class User {
    constructor(@Inject(LAB_EVENT_SINK) readonly sink: EventSink) {}
  }
  const build = async (config: RunConfigV1): Promise<{ sink: EventSink; close: () => Promise<void> }> => {
    @Module({ imports: [EventsModule.register({ runConfig: config, instance: 'app-9' })], providers: [User] })
    class M {}
    const app = await NestFactory.createApplicationContext(M, { logger: false });
    return { sink: app.get(User).sink, close: () => app.close() };
  };

  const on = await build(rc);
  assert.equal(on.sink.enabled, true);
  runWithRequestContext(rep, () => on.sink.emit('arrived'));
  await on.close(); // onModuleDestroy 가 남은 배치를 비운다
  const ev = c.batches.flatMap((b) => b.events);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].attrs?.strategy, 'no-lock');
  assert.equal(ev[0].runId, 'run-9');

  const off = await build({ ...rc, instrumentation: 'off' });
  assert.equal(off.sink.enabled, false);
  await off.close();
});
