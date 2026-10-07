// buildMetadata·completeness·summarizeBatch 테스트.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BatchSummarySchema, RunMetadataV1Schema, RunRequestSchema } from '@under-load/contracts';
import type { RunMetadataV1 } from '@under-load/contracts';

import { buildMetadata, completeness, durationToMs, summarizeBatch } from '../dist/metadata/index.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../engine/contracts/fixtures/${name}`, import.meta.url), 'utf8'));
const request = RunRequestSchema.parse(fixture('run-request.json'));
const base = { runId: 'r1', batchId: 'b1', sessionId: 's1', repetition: 1, request, strategy: 'row-lock', appInstances: 2 };

describe('buildMetadata', () => {
  it('RunMetadata v1 zod 를 통과하고 요청 값을 옮긴다', () => {
    const md = buildMetadata({ ...base, startedAt: '2026-10-07T09:00:00.000Z' });
    RunMetadataV1Schema.parse(md);
    assert.equal(md.schemaVersion, 1);
    assert.deepEqual(md.strategy, { id: 'row-lock', params: { lockTimeoutMs: 1000 } });
    assert.equal(md.timeouts.lockMs, 1000);
    assert.equal(md.timeouts.k6RequestMs, 10000);
    assert.equal(md.load.executor, 'constant-vus');
    assert.equal(md.load.warmup, '10s(별도 실행)');
    assert.equal(md.topology.appInstances, 2);
    assert.equal(md.data.distribution, 'uniform');
    assert.equal(md.artifacts.metadata, 'runs/r1/metadata.json');
  });

  it('open 모델·zipf·지연 주입을 반영한다', () => {
    const open = RunRequestSchema.parse({
      ...request,
      load: { ...request.load, model: 'open', vus: null, rate: 200, preAllocatedVUs: 50, maxVUs: 500, warmup: '0s' },
      data: { ...request.data, distribution: { kind: 'zipf', s: 1.1 } },
      injectDelay: [{ point: 'after-read', ms: 30 }],
    });
    const md = buildMetadata({ ...base, request: open, strategy: 'no-lock' });
    assert.equal(md.load.executor, 'constant-arrival-rate');
    assert.equal(md.load.timeUnit, '1s');
    assert.equal(md.load.warmup, 'none');
    assert.equal(md.data.distribution, 'zipf(1.1)');
    assert.deepEqual(md.interventions, [{ type: 'inject-delay', point: 'after-read', ms: 30 }]);
    assert.equal(md.timeouts.lockMs, null);
  });
});

describe('completeness', () => {
  const full = () => structuredClone(fixture('metadata.v1.json')) as RunMetadataV1;

  it('모두 채워진 v1 fixture 는 완전하다', () => {
    const report = completeness(RunMetadataV1Schema.parse(full()));
    assert.deepEqual(report.missing, []);
    assert.equal(report.complete, true);
  });

  it('open 실행의 load.vus=null 은 허용한다', () => {
    const md = full();
    md.load = { ...md.load, model: 'open', vus: null, rate: 200, timeUnit: '1s', preAllocatedVUs: 50, maxVUs: 500 };
    const report = completeness(md);
    assert.ok(report.allowedNull.includes('load.vus'));
    assert.ok(!report.missing.includes('load.vus'));
  });

  it('closed 실행의 load.vus=null 은 미채움으로 보고한다', () => {
    const md = full();
    md.load.vus = null;
    assert.ok(completeness(md).missing.includes('load.vus'));
  });

  it('postgres.configHash=null 은 미채움으로 보고한다', () => {
    const md = full();
    md.postgres.configHash = null;
    const report = completeness(md);
    assert.deepEqual(report.missing, ['postgres.configHash']);
    assert.equal(report.complete, false);
  });

  it('조립 직후(실측 없음)는 미채움 경로를 알려 준다', () => {
    const report = completeness(buildMetadata(base));
    assert.ok(report.missing.includes('postgres.configHash'));
    assert.ok(report.missing.includes('images.app'));
    assert.ok(report.allowedNull.includes('redis.maxmemoryPolicy'));
  });
});

describe('summarizeBatch', () => {
  const rec = { batchId: 'b1', sessionId: 's1', scenario: 'g02-stock-decrement', strategy: 'app-memory-lock', appInstances: 2, loadModel: 'open' as const, reps: 3 };

  it('0단계 v0 metadata 로 BatchSummary 를 만든다', () => {
    const v0 = fixture('metadata.v0.json') as RunMetadataV1;
    const summary = summarizeBatch(rec, [v0]);
    BatchSummarySchema.parse(summary);
    assert.deepEqual(summary.runIds, [v0.runId]);
    assert.equal(summary.validity.validReps, 1);
    // 처리량 = httpReqs(4001) / 본 실행 20s. k6 http_reqs.rate(200.02...)가 아니다.
    assert.equal(summary.throughputRps?.median, 4001 / 20);
    assert.deepEqual(summary.latencyMs.success.n, [4001]);
    assert.deepEqual(summary.failures.total, [0]);
    assert.equal(summary.invariants.length, 5);
    assert.deepEqual(summary.badges, []);
  });

  it('결과가 없으면 빈 배열·null 로 요약한다', () => {
    const summary = summarizeBatch({ ...rec, loadModel: 'closed' }, []);
    assert.deepEqual(summary.runIds, []);
    assert.equal(summary.throughputRps, null);
    assert.deepEqual(summary.badges, ['closed-latency-caution']);
  });
});

describe('처리량 정의(0단계 measured.mjs 와 동일)', () => {
  const rec = { batchId: 'b', sessionId: 's', scenario: 'g02-stock-decrement', strategy: 'x', appInstances: 1, loadModel: 'open' as const, reps: 1 };

  it('v1 은 k6.throughputRps 를 그대로 쓴다', () => {
    const md = RunMetadataV1Schema.parse({ ...(fixture('metadata.v1.json') as object), k6: { throughputRps: 123.4, httpFailures: 0, dropped: 0 } });
    assert.equal(summarizeBatch(rec, [md]).throughputRps?.median, 123.4);
  });

  describe('unstable 배지는 반복 2회 이상일 때만', () => {
    const withTp = (tp: number) => RunMetadataV1Schema.parse({ ...(fixture('metadata.v1.json') as object), k6: { throughputRps: tp, httpFailures: 0, dropped: 0 } });
    it('1회 배치는 편차를 판정하지 않는다', () => {
      assert.ok(!summarizeBatch(rec, [withTp(100)]).badges.includes('unstable'));
    });
    it('2회 이상이고 편차가 크면 붙는다', () => {
      assert.ok(summarizeBatch({ ...rec, reps: 2 }, [withTp(100), withTp(200)]).badges.includes('unstable'));
      assert.ok(!summarizeBatch({ ...rec, reps: 2 }, [withTp(100), withTp(101)]).badges.includes('unstable'));
    });
  });

  // 0단계 실제 runs/ 가 있을 때만(공개 레포에는 없다). learn.yaml measured 의 throughputRps 와 같은 규칙으로 대조한다.
  const runsDir = process.env.LAB_PHASE0_RUNS ?? new URL('../../runs/', import.meta.url).pathname;
  // runs/ 가 있어도 1단계 실측(schemaVersion 있음)뿐이면 0단계 결과가 아니므로 skip 한다.
  const isPhase0 = (file: string) => {
    try {
      return (JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion?: unknown }).schemaVersion === undefined;
    } catch {
      return false;
    }
  };
  const have =
    existsSync(runsDir) &&
    readdirSync(runsDir).some((d) => {
      const file = join(runsDir, d, 'metadata.json');
      return existsSync(file) && isPhase0(file);
    });
  it('0단계 실제 metadata.json 의 처리량이 measured.mjs 규칙(httpReqs / 길이)과 일치한다', { skip: !have && '0단계 runs/ 없음' }, () => {
    let checked = 0;
    for (const dir of readdirSync(runsDir)) {
      const file = join(runsDir, dir, 'metadata.json');
      if (!existsSync(file) || !isPhase0(file)) continue;
      const md = JSON.parse(readFileSync(file, 'utf8')) as { k6?: { httpReqs?: number }; load: { duration: string; model: 'open' | 'closed' } };
      if (md.k6?.httpReqs == null) continue;
      const sec = durationToMs(md.load.duration)! / 1000;
      const got = summarizeBatch({ ...rec, loadModel: md.load.model }, [md as never]).throughputRps?.median;
      assert.equal(got, md.k6.httpReqs / sec, dir);
      checked++;
    }
    assert.ok(checked > 0);
  });
});

describe('추적 저장소(trace 프로필) 경고 — T-157', () => {
  const rec = { batchId: 'b1', sessionId: 's1', scenario: 'g02-stock-decrement', strategy: 'row-lock', appInstances: 2, loadModel: 'open' as const, reps: 1 };
  const build = (instrumentation: 'off' | 'metrics' | 'full', stackProfiles: ('obs' | 'trace')[]) =>
    buildMetadata({ ...base, request: RunRequestSchema.parse({ ...request, instrumentation }), stackProfiles, validity: { valid: true } });

  it('AC-1 full + trace 없음: sink absent, valid 는 그대로, 배지에 경고', () => {
    const md = build('full', ['obs']);
    RunMetadataV1Schema.parse(md);
    assert.deepEqual(md.validity.checks.tracing, { sink: 'absent' });
    assert.equal(md.validity.valid, true);
    const summary = summarizeBatch(rec, [md]);
    BatchSummarySchema.parse(summary);
    assert.ok(summary.badges.includes('no-trace-sink'));
    assert.equal(summary.validity.validReps, 1);
    assert.ok(!summary.badges.includes('unstable'));
  });

  it('AC-2 full + trace 있음, metrics·off 는 경고 없음', () => {
    const present = build('full', ['obs', 'trace']);
    assert.deepEqual(present.validity.checks.tracing, { sink: 'present' });
    assert.ok(!summarizeBatch(rec, [present]).badges.includes('no-trace-sink'));
    for (const level of ['metrics', 'off'] as const) {
      const md = build(level, []);
      assert.deepEqual(md.validity.checks.tracing, { sink: 'not-applicable' });
      assert.ok(!summarizeBatch(rec, [md]).badges.includes('no-trace-sink'));
    }
  });

  it('AC-4 checks.tracing 이 없는 이전 v1·v0 메타데이터도 요약된다', () => {
    const md = build('full', ['obs']);
    const { tracing: _t, ...checks } = md.validity.checks;
    const old = { ...md, validity: { ...md.validity, checks } } as RunMetadataV1;
    assert.deepEqual(summarizeBatch(rec, [old]).badges, []);
    assert.deepEqual(summarizeBatch(rec, [fixture('metadata.v0.json') as RunMetadataV1]).badges, []);
  });
});
