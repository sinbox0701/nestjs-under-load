import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { Controller, Get, type INestApplication, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { InstrumentationLevel } from '@under-load/contracts';
import { METRIC_DEFAULT_LABELS, METRIC_NAMES } from '@under-load/contracts';

import { ormHooks, poolHooks } from './hooks';
import { getLabMetrics, resetLabMetrics } from './lab-metrics';
import { MetricsModule } from './metrics.module';

@Controller('items')
class ItemsController {
  @Get(':id')
  get(): { ok: true } {
    return { ok: true };
  }

  @Post()
  create(): { ok: true } {
    return { ok: true };
  }
}

const LABELS = { run_id: 'r1', scenario: 'g02', strategy: 'naive', instrumentation: 'x' };
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

let app: INestApplication | null = null;

async function boot(level: InstrumentationLevel): Promise<string> {
  resetLabMetrics();
  const labels = { ...LABELS, instrumentation: level };
  @Module({ imports: [MetricsModule.register(level, labels)], controllers: [ItemsController] })
  class TestAppModule {}
  app = await NestFactory.create(TestAppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  return await app.getUrl();
}

const scrape = async (base: string): Promise<{ text: string; type: string | null }> => {
  const res = await fetch(`${base}/metrics`);
  return { text: await res.text(), type: res.headers.get('content-type') };
};

afterEach(async () => {
  await app?.close();
  app = null;
  resetLabMetrics();
});

describe('C5/C6 지표 수준 스위치', () => {
  it('AC-1 off: RED 와 info 는 있고 런타임·풀·ORM 지표는 없다', async () => {
    const base = await boot('off');
    await fetch(`${base}/items/1`);
    const { text, type } = await scrape(base);
    assert.match(type ?? '', /application\/openmetrics-text/);
    assert.match(text, /^lab_http_request_duration_seconds_count\{/m);
    assert.match(text, /^lab_instrumentation_info\{.*level="off".*\} 1$/m);
    assert.doesNotMatch(text, /nodejs_heap_size_used_bytes/);
    assert.doesNotMatch(text, /lab_eventloop_utilization/);
    assert.doesNotMatch(text, /lab_db_pool_connections/);
    assert.deepEqual(poolHooks('off'), {});
    assert.deepEqual(ormHooks('off'), { subscribers: [] });
  });

  it('AC-2 metrics: 풀 게이지 3개와 flush 지표가 있고 쿼리 시간은 없다', async () => {
    const base = await boot('metrics');
    const pool = { totalCount: 4, idleCount: 1, waitingCount: 2, connect: async () => ({}) };
    poolHooks('metrics').onPoolCreated!(pool);
    const uow = { getChangeSets: () => [{}, {}], getIdentityMap: () => ({ values: () => [] }) };
    const sub = ormHooks('metrics').subscribers[0]!;
    sub.beforeFlush!({ uow } as never);
    sub.onFlush!({ uow } as never);
    sub.afterFlush!({ uow } as never);

    const { text } = await scrape(base);
    for (const state of ['total', 'idle', 'waiting']) assert.match(text, new RegExp(`^lab_db_pool_connections\\{[^}]*state="${state}"`, 'm'));
    assert.match(text, /^lab_db_pool_connections\{[^}]*state="waiting"[^}]*\} 2$/m);
    assert.match(text, /^lab_orm_flush_duration_seconds_count(?:\{[^}]*\})? 1$/m);
    assert.match(text, /^lab_orm_flush_changesets_sum(?:\{[^}]*\})? 2$/m);
    assert.match(text, /nodejs_heap_size_used_bytes/);
    assert.match(text, /^lab_eventloop_utilization\{/m);
    assert.match(text, /^lab_uv_threadpool_size\{/m);
    assert.doesNotMatch(text, /lab_orm_query_duration_seconds/);
    assert.doesNotMatch(text, /lab_orm_identity_map_size/);
    assert.equal(ormHooks('metrics').loggerFactory, undefined);
  });

  it('AC-3 full + traceparent: 히스토그램 exemplar 에 trace_id', async () => {
    const base = await boot('full');
    await fetch(`${base}/items/1`, { headers: { traceparent: TRACEPARENT } });
    const { text } = await scrape(base);
    const bucket = text.split('\n').find((l) => l.startsWith('lab_http_request_duration_seconds_bucket') && l.includes(' # {'));
    assert.ok(bucket, 'exemplar 가 붙은 버킷 줄이 있어야 한다');
    assert.match(bucket, /# \{trace_id="0af7651916cd43dd8448eb211c80319c",span_id="b7ad6b7169203331"\}/);
  });

  it('full 이라도 traceparent 가 없으면 exemplar 없이 기록되고, off/metrics 는 exemplar 를 쓰지 않는다', async () => {
    let base = await boot('full');
    await fetch(`${base}/items/1`);
    assert.doesNotMatch((await scrape(base)).text, / # \{trace_id/);
    assert.match((await scrape(base)).text, /^lab_http_request_duration_seconds_count(?:\{[^}]*\})? 1$/m);
    await app!.close();
    base = await boot('metrics');
    await fetch(`${base}/items/1`, { headers: { traceparent: TRACEPARENT } });
    assert.doesNotMatch((await scrape(base)).text, / # \{trace_id/);
  });

  it('AC-4 기본 라벨이 모든 lab_* 시계열에 붙는다', async () => {
    const base = await boot('full');
    await fetch(`${base}/items/1`);
    const { text } = await scrape(base);
    const series = text.split('\n').filter((l) => /^lab_/.test(l));
    assert.ok(series.length > 0);
    for (const line of series) {
      for (const name of METRIC_DEFAULT_LABELS) assert.match(line, new RegExp(`[{,]${name}="`), line);
    }
    assert.match(text, /^lab_http_request_duration_seconds_count\{[^}]*run_id="r1"/m);
  });

  it('RED: route 는 패턴, status 는 최종 응답 코드, /metrics 자신은 세지 않는다', async () => {
    const base = await boot('metrics');
    await fetch(`${base}/items/7`);
    await fetch(`${base}/items`, { method: 'POST' });
    const { text } = await scrape(base);
    assert.match(text, /^lab_http_request_duration_seconds_count\{[^}]*method="GET"[^}]*route="\/items\/:id"[^}]*status="200"[^}]*\} 1$/m);
    assert.match(text, /^lab_http_request_duration_seconds_count\{[^}]*method="POST"[^}]*status="201"[^}]*\} 1$/m);
    assert.doesNotMatch(text, /route="\/metrics"/);
    assert.match(text, /^lab_http_requests_in_flight\{[^}]*route="\/items\/:id"[^}]*\} 0$/m);
  });

  it('contracts 의 지표 이름만 노출한다(lab_ 접두사 계열)', async () => {
    const base = await boot('full');
    await fetch(`${base}/items/1`);
    const { text } = await scrape(base);
    const families = [...text.matchAll(/^# TYPE (lab_\w+) /gm)].map((m) => m[1]!);
    assert.ok(families.length > 0);
    for (const f of families) assert.ok(METRIC_NAMES.includes(f) || METRIC_NAMES.includes(`${f}_total`), `${f} 는 C5 에 없다`);
  });
});

describe('poolHooks', () => {
  it('acquire 시간·타임아웃을 센다(promise·callback 둘 다)', async () => {
    resetLabMetrics();
    const m = getLabMetrics('metrics');
    const err = new Error('timeout exceeded when trying to connect');
    const pool = {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      fail: false,
      connect(cb?: (e: unknown, c?: unknown) => void): unknown {
        if (cb) return cb(this.fail ? err : null, {});
        return this.fail ? Promise.reject(err) : Promise.resolve({});
      },
    };
    poolHooks('metrics').onPoolCreated!(pool as never);
    await pool.connect();
    pool.connect(() => undefined);
    pool.fail = true;
    await assert.rejects(pool.connect() as Promise<unknown>);
    pool.connect(() => undefined);
    const text = await m.registry.metrics();
    assert.match(text, /^lab_db_pool_acquire_duration_seconds_count(?:\{[^}]*\})? 4$/m);
    assert.match(text, /^lab_db_pool_acquire_timeouts_total(?:\{[^}]*\})? 2$/m);
  });
});

describe('ormHooks', () => {
  it('트랜잭션 commit/rollback 수·시간(savepoint 제외)', async () => {
    resetLabMetrics();
    const m = getLabMetrics('metrics');
    const sub = ormHooks('metrics').subscribers[0]!;
    const em = {};
    sub.beforeTransactionStart!({ em } as never);
    sub.afterTransactionCommit!({ em, transaction: {} } as never);
    sub.beforeTransactionStart!({ em } as never);
    sub.afterTransactionRollback!({ em, transaction: {} } as never);
    sub.afterTransactionCommit!({ em, transaction: { savepointName: 'trx1' } } as never);
    const text = await m.registry.metrics();
    assert.match(text, /^lab_orm_transactions_total\{[^}]*result="commit"[^}]*\} 1$/m);
    assert.match(text, /^lab_orm_transactions_total\{[^}]*result="rollback"[^}]*\} 1$/m);
    assert.match(text, /^lab_orm_transaction_duration_seconds_count\{[^}]*result="commit"[^}]*\} 1$/m);
  });

  it('full: loggerFactory 가 쿼리 시간을 type 별로 기록하고 로그는 켜지 않는다', async () => {
    resetLabMetrics();
    const m = getLabMetrics('full');
    const lines: string[] = [];
    const logger = ormHooks('full').loggerFactory!({ writer: (s) => lines.push(s) });
    logger.logQuery({ query: 'select 1', took: 12 });
    logger.logQuery({ query: 'UPDATE t set a=1', took: 3 });
    logger.logQuery({ query: 'begin' }); // took 없음 → 집계 안 함
    logger.logQuery({ query: 'select 1', took: 900, namespace: 'slow-query' }); // 이중 집계 방지
    const text = await m.registry.metrics();
    assert.match(text, /^lab_orm_query_duration_seconds_count\{[^}]*type="select"[^}]*\} 1$/m);
    assert.match(text, /^lab_orm_query_duration_seconds_count\{[^}]*type="update"[^}]*\} 1$/m);
    assert.doesNotMatch(text, /type="other"/);
    assert.deepEqual(lines, []);
  });

  it('full: afterFlush 가 identity map 크기를 기록', async () => {
    resetLabMetrics();
    const m = getLabMetrics('full');
    const sub = ormHooks('full').subscribers[0]!;
    const uow = { getChangeSets: () => [], getIdentityMap: () => ({ values: () => [1, 2, 3] }) };
    sub.afterFlush!({ uow } as never);
    assert.match(await m.registry.metrics(), /^lab_orm_identity_map_size_sum(?:\{[^}]*\})? 3$/m);
  });
});
