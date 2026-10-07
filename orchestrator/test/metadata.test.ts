// buildMetadata·completeness·summarizeBatch 테스트.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { BatchSummarySchema, RunMetadataV1Schema, RunRequestSchema } from '@under-load/contracts';
import type { RunMetadataV1 } from '@under-load/contracts';

import { buildMetadata, completeness, summarizeBatch } from '../dist/metadata/index.js';

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
    assert.equal(summary.throughputRps?.median, 200.0211124108886);
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
