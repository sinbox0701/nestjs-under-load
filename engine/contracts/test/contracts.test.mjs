// 계약 패키지 테스트: fixture 가 스키마를 통과하는지, 상수가 docs/CONTRACTS-phase1.md 와 같은지 본다.
// 실행: tsc -p tsconfig.json && node --test "test/*.test.mjs" (dist 를 import 한다, g02 팩과 같은 방식)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import * as c from '../dist/index.js';

const fx = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(fx(name));

describe('AC-1 fixture parse', () => {
  const cases = [
    ['RunRequest', c.RunRequestSchema, 'run-request.json'],
    ['RunConfig v1', c.RunConfigV1Schema, 'run-config.v1.json'],
    ['RunConfig v1 prepare-template', c.RunConfigV1Schema, 'run-config.v1.prepare-template.json'],
    ['RunMetadata v1', c.RunMetadataV1Schema, 'metadata.v1.json'],
    ['AggWindow', c.AggWindowSchema, 'agg-window.json'],
    ['IngestBatch', c.IngestBatchSchema, 'ingest-batch.json'],
    ['BatchSummary', c.BatchSummarySchema, 'batch-summary.json'],
    ['CompareResult(axis)', c.CompareResultSchema, 'compare-result.json'],
    ['CompareResult(blocking)', c.CompareResultSchema, 'compare-result.blocking.json'],
    ['RunRow', c.RunRowSchema, 'run-row.json'],
    ['Session', c.SessionResponseSchema, 'session.json'],
    ['ReadyResponse', c.ReadyResponseSchema, 'ready.json'],
    ['HealthResponse', c.HealthResponseSchema, 'health.json'],
    ['K6JobRequest', c.K6JobRequestSchema, 'k6-job-request.json'],
    ['K6JobStatus', c.K6JobStatusSchema, 'k6-job-status.json'],
  ];
  for (const [label, schema, file] of cases) {
    it(`${label} ← ${file}`, () => {
      const r = schema.safeParse(json(file));
      assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues, null, 2));
    });
  }

  it('ScenarioInfo[] ← scenarios.json', () => {
    for (const s of json('scenarios.json')) c.ScenarioInfoSchema.parse(s);
  });

  it('WsMessage ← ws-messages.json (7 type 전부)', () => {
    const msgs = json('ws-messages.json');
    for (const m of msgs) c.WsMessageSchema.parse(m);
    assert.deepEqual(msgs.map((m) => m.type), [...c.WS_MESSAGE_TYPES]);
  });

  it('WireEventV0 ← events.v0.ndjson 첫 줄', () => {
    c.WireEventV0Schema.parse(JSON.parse(fx('events.v0.ndjson').split('\n')[0]));
  });

  it('fixture 에 절대경로가 없다', () => {
    const names = [
      'run-request.json', 'run-config.v0.json', 'run-config.v1.json', 'run-config.v1.prepare-template.json',
      'metadata.v0.json', 'metadata.v1.json', 'events.v0.ndjson', 'agg-window.json', 'ingest-batch.json',
      'batch-summary.json', 'compare-result.json', 'compare-result.blocking.json', 'ws-messages.json',
      'run-row.json', 'session.json', 'scenarios.json', 'ready.json', 'health.json', 'k6-job-request.json', 'k6-job-status.json',
    ];
    for (const n of names) assert.doesNotMatch(fx(n), /\/Users\/|\/home\/|[A-Z]:\\\\/, n);
  });
});

describe('AC-1 거절 사례', () => {
  it('RunRequest: 모르는 키·prediction 공백·closed 에 rate·reps 21 은 거절', () => {
    const base = json('run-request.json');
    assert.equal(c.RunRequestSchema.safeParse({ ...base, extra: 1 }).success, false);
    assert.equal(c.RunRequestSchema.safeParse({ ...base, prediction: '  ' }).success, false);
    assert.equal(c.RunRequestSchema.safeParse({ ...base, load: { ...base.load, rate: 100 } }).success, false);
    assert.equal(c.RunRequestSchema.safeParse({ ...base, reps: 21 }).success, false);
    const { pgProbe, ...noProbe } = base;
    assert.ok(pgProbe);
    assert.equal(c.RunRequestSchema.safeParse(noProbe).success, true, 'pgProbe 는 생략 가능');
  });

  it('RunRequest: open 이면 rate·preAllocatedVUs·maxVUs 가 필요하고 vus 는 null', () => {
    const base = json('run-request.json');
    const open = { ...base.load, model: 'open', vus: null, rate: 200, preAllocatedVUs: 50, maxVUs: 2000 };
    assert.equal(c.RunRequestSchema.safeParse({ ...base, load: open }).success, true);
    assert.equal(c.RunRequestSchema.safeParse({ ...base, load: { ...open, maxVUs: null } }).success, false);
    assert.equal(c.RunRequestSchema.safeParse({ ...base, load: { ...open, vus: 10 } }).success, false);
  });

  it('RunConfig v1: prepare-template 인데 prepareTemplate 없음 / serve 인데 있음 → 거절', () => {
    const pt = json('run-config.v1.prepare-template.json');
    const { prepareTemplate, ...noPt } = pt;
    assert.ok(prepareTemplate);
    assert.equal(c.RunConfigV1Schema.safeParse(noPt).success, false);
    assert.equal(c.RunConfigV1Schema.safeParse({ ...pt, task: 'serve' }).success, false);
  });

  it('CompareResult: blocking 이 있는데 comparable=true 면 거절', () => {
    const r = json('compare-result.blocking.json');
    assert.equal(c.CompareResultSchema.safeParse({ ...r, comparable: true }).success, false);
  });

  it('BatchSummary: 반복 배열 길이가 runIds 와 다르면 거절', () => {
    const b = json('batch-summary.json');
    assert.equal(c.BatchSummarySchema.safeParse({ ...b, failures: { ...b.failures, http: [0] } }).success, false);
  });

  it('IngestBatch: 이벤트 runId 가 배치와 다르면 거절', () => {
    const b = json('ingest-batch.json');
    const events = [{ ...b.events[0], runId: 'other' }];
    assert.equal(c.IngestBatchSchema.safeParse({ ...b, events }).success, false);
  });

  it('WireEventV0: codeRef·attrs.strategy 누락·traceId 형식 오류는 거절', () => {
    const e = JSON.parse(fx('events.v0.ndjson').split('\n')[0]);
    assert.equal(c.WireEventV0Schema.safeParse({ ...e, codeRef: 'a.ts:1' }).success, false);
    assert.equal(c.WireEventV0Schema.safeParse({ ...e, attrs: { lockMode: 'x' } }).success, false);
    assert.equal(c.WireEventV0Schema.safeParse({ ...e, traceId: 'xyz' }).success, false);
    const { attrs, ...noAttrs } = e;
    assert.ok(attrs);
    assert.equal(c.WireEventV0Schema.safeParse(noAttrs).success, true, 'attrs 자체는 선택');
  });
});

describe('AC-2 0단계 파일', () => {
  it('parseRunConfig: schemaVersion 없는 0단계 run-config.json → v1 기본값', () => {
    const v1 = c.parseRunConfig(json('run-config.v0.json'));
    assert.equal(v1.schemaVersion, 1);
    assert.equal(v1.task, 'serve');
    assert.equal(v1.strategy, 'app-memory-lock');
    assert.deepEqual(v1.pool, { min: 2, max: 10, acquireTimeoutMs: null });
    assert.deepEqual(v1.timeouts, { serverRequestMs: null, statementMs: null, idleInTxMs: null });
    assert.equal(v1.events, null);
    assert.equal(v1.tracing, null);
    assert.equal(v1.redis, null);
    assert.equal('prepareTemplate' in v1, false);
    c.RunConfigV1Schema.parse(v1);
  });

  it('parseRunConfig: v1 은 그대로, schemaVersion 2 는 거절', () => {
    assert.equal(c.parseRunConfig(json('run-config.v1.json')).strategy, 'row-lock');
    assert.throws(() => c.parseRunConfig({ ...json('run-config.v1.json'), schemaVersion: 2 }));
  });

  it('parseMetadataAnyVersion: 0단계 metadata.json → version 0, 확장 필드 보존', () => {
    const r = c.parseMetadataAnyVersion(json('metadata.v0.json'));
    assert.equal(r.version, 0);
    assert.equal(r.metadata.strategy.id, 'app-memory-lock');
    assert.equal(r.metadata.dryRun, false);
  });

  it('parseMetadataAnyVersion: v1 → version 1', () => {
    const r = c.parseMetadataAnyVersion(json('metadata.v1.json'));
    assert.equal(r.version, 1);
    assert.equal(r.metadata.topology.appInstances, 2);
  });

  it('RunMetadataAnySchema: v0·v1 둘 다 받는다', () => {
    c.RunMetadataAnySchema.parse(json('metadata.v0.json'));
    c.RunMetadataAnySchema.parse(json('metadata.v1.json'));
  });
});

describe('AC-3 events.v0.ndjson', () => {
  it('10줄 이상, 무효 2줄을 빼고 유효 줄만 WireEventV0 로 parse', () => {
    const text = fx('events.v0.ndjson');
    const lines = text.split('\n').filter((l) => l.trim());
    assert.ok(lines.length >= 10);
    const { events, errors } = c.parseEventsNdjson(text);
    assert.equal(errors.length, 2);
    assert.deepEqual(errors.map((e) => e.line), [9, 11]);
    assert.equal(events.length, lines.length - 2);
    for (const e of events) assert.equal(e.v, 0);
    assert.ok(events.some((e) => e.phase.startsWith('custom:')));
  });
});

describe('AC-4 상수', () => {
  it('METRIC_NAMES 는 C5 전체(문서 순서)', () => {
    assert.deepEqual(
      [...c.METRIC_NAMES],
      [
        'lab_http_request_duration_seconds',
        'lab_http_requests_in_flight',
        'nodejs_eventloop_lag_p50_seconds',
        'nodejs_eventloop_lag_p99_seconds',
        'nodejs_gc_duration_seconds',
        'nodejs_heap_size_used_bytes',
        'nodejs_heap_size_total_bytes',
        'process_resident_memory_bytes',
        'nodejs_external_memory_bytes',
        'process_cpu_seconds_total',
        'lab_eventloop_utilization',
        'lab_uv_threadpool_size',
        'lab_db_pool_connections',
        'lab_db_pool_acquire_duration_seconds',
        'lab_db_pool_acquire_timeouts_total',
        'lab_orm_flush_duration_seconds',
        'lab_orm_flush_changesets',
        'lab_orm_transactions_total',
        'lab_orm_transaction_duration_seconds',
        'lab_orm_query_duration_seconds',
        'lab_orm_identity_map_size',
        'lab_events_emitted_total',
        'lab_events_dropped_total',
        'lab_events_batches_failed_total',
        'lab_injected_delay_total',
        'lab_injected_delay_seconds_total',
        'lab_instrumentation_info',
        'lab_orch_ingest_events_total',
        'lab_orch_ingest_rejected_total',
        'lab_orch_ws_clients',
        'lab_orch_file_write_errors_total',
      ],
    );
    assert.equal(new Set(c.METRIC_NAMES).size, c.METRIC_NAMES.length);
  });

  it('C6 off 수준 지표 = RED + 주입 카운터 + info', () => {
    const off = c.METRICS.filter((m) => m.level === 'off').map((m) => m.name);
    assert.deepEqual(off, [
      'lab_http_request_duration_seconds',
      'lab_http_requests_in_flight',
      'lab_injected_delay_total',
      'lab_injected_delay_seconds_total',
      'lab_instrumentation_info',
    ]);
    assert.deepEqual(c.defaultPgProbe('off'), { enabled: false, intervalMs: null });
    assert.deepEqual(c.defaultPgProbe('metrics'), { enabled: true, intervalMs: 5000 });
    assert.deepEqual(c.defaultPgProbe('full'), { enabled: true, intervalMs: 1000 });
  });

  it('C2·C3·C4·C7·C9 고정값', () => {
    assert.equal(c.COMMON_PHASES.length, 23);
    assert.deepEqual([...c.AXIS_PATHS], ['topology.appInstances', 'instrumentation', 'pgProbe.enabled', 'interventions']);
    assert.equal(c.COMPARABLE_PATHS.includes('strategy'), false);
    assert.equal(c.COMPARABLE_PATHS.includes('strategy.id'), false);
    assert.equal(c.COMPARABLE_PATHS.includes('strategy.params'), true);
    assert.deepEqual([...c.STRATEGY_SCOPED_PATHS], ['strategy.params', 'timeouts.lockMs']);
    assert.equal(c.LAB_EVENT_SINK, 'LAB_EVENT_SINK');
    assert.equal(c.NOOP_EVENT_SINK.enabled, false);
    assert.equal(c.NOOP_EVENT_SINK.emit('arrived', { attrs: { strategy: 'x' } }), undefined);
    assert.ok(Object.isFrozen(c.NOOP_EVENT_SINK));
    assert.equal(c.K6_ENV_KEYS.length, 17);
  });

  it('NULLABLE_WHEN 조건 판정(metadata.v1 fixture 기준)', () => {
    const m = c.RunMetadataV1Schema.parse(json('metadata.v1.json'));
    const applies = Object.fromEntries(c.NULLABLE_WHEN.map((r) => [r.path, r.applies(m)]));
    assert.deepEqual(applies, {
      'load.vus': false,
      'load.rate': true,
      'load.timeUnit': true,
      'load.preAllocatedVUs': true,
      'load.maxVUs': true,
      'timeouts.lockMs': false,
      'redis.maxmemoryPolicy': true,
      'validity.checks.scrapeGaps': false,
      'artifacts.promSnapshot': false,
      'host.dockerDesktopVersion': true,
      ledgerVsClient: false,
    });
  });

  it('metadata.v1 fixture 의 null 은 모두 NULLABLE_WHEN 으로 설명된다(invariants[] 제외)', () => {
    const m = c.RunMetadataV1Schema.parse(json('metadata.v1.json'));
    const allowed = new Set(c.NULLABLE_WHEN.filter((r) => r.allowed === null && r.applies(m)).map((r) => r.path));
    const nulls = [];
    const walk = (v, path) => {
      if (path === 'invariants') return;
      if (v === null) nulls.push(path);
      else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    };
    walk(m, '');
    assert.deepEqual(nulls.filter((p) => !allowed.has(p)), []);
  });

  it('AC-4 checks.tracing 은 선택: 없는 v1 메타데이터도 통과, 값이 틀리면 실패', () => {
    const raw = json('metadata.v1.json');
    const { tracing: _t, ...checks } = raw.validity.checks;
    assert.ok(c.RunMetadataV1Schema.safeParse({ ...raw, validity: { ...raw.validity, checks } }).success);
    const bad = { ...raw, validity: { ...raw.validity, checks: { ...checks, tracing: { sink: 'nope' } } } };
    assert.equal(c.RunMetadataV1Schema.safeParse(bad).success, false);
    assert.ok(c.parseMetadataAnyVersion(json('metadata.v0.json')));
  });

  it('스냅샷: 상수 표 전체', (t) => {
    t.assert.snapshot({
      INSTRUMENTATION_LEVELS: c.INSTRUMENTATION_LEVELS,
      METRICS: c.METRICS,
      METRIC_DEFAULT_LABELS: c.METRIC_DEFAULT_LABELS,
      K6_ENV_KEYS: c.K6_ENV_KEYS,
      K6_SCENARIO_ENV_KEYS: c.K6_SCENARIO_ENV_KEYS,
      K6_ENV_VALUES: c.K6_ENV_VALUES,
      COMPARABLE_PATHS: c.COMPARABLE_PATHS,
      AXIS_PATHS: c.AXIS_PATHS,
      WARNING_PATHS: c.WARNING_PATHS,
      NULLABLE_WHEN: c.NULLABLE_WHEN.map(({ path, when, allowed }) => ({ path, when, allowed })),
      COMMON_PHASES: c.COMMON_PHASES,
      LAB_EVENT_SINK: c.LAB_EVENT_SINK,
      NOOP_EVENT_SINK: { enabled: c.NOOP_EVENT_SINK.enabled },
      WS_MESSAGE_TYPES: c.WS_MESSAGE_TYPES,
      ARTIFACT_NAMES: c.ARTIFACT_NAMES,
      DASHBOARD_UIDS: c.DASHBOARD_UIDS,
      TRACE_SINKS: c.TRACE_SINKS,
      BATCH_BADGES: c.BATCH_BADGES,
    });
  });
});
