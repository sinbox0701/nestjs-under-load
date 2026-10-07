// 유효성 판정 테스트(순수 함수).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { K6JobStatus, RunRequest } from '@under-load/contracts';

import type { K6Summary } from '../dist/ports.js';
import { durationToSeconds, judgeValidity } from '../dist/validity/index.js';

const openLoad = (maxVUs: number): RunRequest['load'] => ({
  model: 'open',
  profile: 'constant',
  vus: null,
  rate: 100,
  preAllocatedVUs: 50,
  maxVUs,
  duration: '30s',
  warmup: '10s',
  thinkTimeMs: [0, 0],
  requestTimeout: '10s',
});
const closedLoad: RunRequest['load'] = { ...openLoad(1), model: 'closed', vus: 50, rate: null, preAllocatedVUs: null, maxVUs: null };

const req = (load: RunRequest['load']) => ({ load }) as unknown as RunRequest;

const summary = (over: Partial<K6Summary> = {}): K6Summary => ({
  requests: 3000,
  throughputRps: 100,
  httpFailures: 5,
  dropped: 0,
  latencyMs: { success: { p50: 1, p95: 2, p99: 3, n: 2995 }, failed: { p50: null, p95: null, p99: null, n: 5 } },
  ...over,
});

/** 30초 동안 usageSec 만큼 CPU 를 쓴 job(limit 2코어). */
const k6 = (usageSec: number, nrThrottled = 0): K6JobStatus => ({
  state: 'done',
  exitCode: 0,
  startedAt: '2026-10-07T09:00:00.000Z',
  endedAt: '2026-10-07T09:00:30.000Z',
  cpu: {
    before: { usageUsec: 0, nrPeriods: 0, nrThrottled: 0, throttledUsec: 0 },
    after: { usageUsec: usageSec * 1e6, nrPeriods: 300, nrThrottled, throttledUsec: 0 },
    cpuMaxCores: 2,
  },
});

describe('judgeValidity', () => {
  it('AC-1: 평균 사용률 ≥0.8×limit 이면 무효, 사유가 있다', () => {
    const v = judgeValidity({ request: req(closedLoad), summary: summary(), k6: k6(50), scrapeGaps: 0 }); // 50/30/2=0.833
    assert.equal(v.valid, false);
    assert.equal(v.k6CpuAvgRatio, 0.833);
    assert.match(v.reasons[0] ?? '', /k6 CPU 포화/);
    assert.ok(v.k6Cpu);
  });

  it('AC-1: 스로틀 주기 비율 ≥0.2 면 평균이 낮아도 무효', () => {
    const v = judgeValidity({ request: req(closedLoad), summary: summary(), k6: k6(10, 60), scrapeGaps: null }); // 60/300=0.2
    assert.equal(v.valid, false);
    assert.match(v.reasons.join(' '), /스로틀/);
  });

  it('CPU 여유가 있으면 유효, reasons 는 빈 배열', () => {
    const v = judgeValidity({ request: req(closedLoad), summary: summary(), k6: k6(10), scrapeGaps: 0 });
    assert.equal(v.valid, true);
    assert.deepEqual(v.reasons, []);
    assert.equal(v.droppedCountedAsFailure, null);
    assert.equal(v.failuresTotal, 5);
  });

  it('AC-2: maxVUs ≥ rate×timeout(1000) 이면 dropped 를 실패에 더한다', () => {
    const v = judgeValidity({ request: req(openLoad(1000)), summary: summary({ dropped: 40 }), k6: k6(10), scrapeGaps: 0 });
    assert.equal(v.valid, true);
    assert.equal(v.droppedCountedAsFailure, true);
    assert.equal(v.failuresTotal, 45);
  });

  it('AC-2: maxVUs 가 부족하면 dropped>0 은 무효 "설정 부족"', () => {
    const v = judgeValidity({ request: req(openLoad(200)), summary: summary({ dropped: 40 }), k6: k6(10), scrapeGaps: 0 });
    assert.equal(v.valid, false);
    assert.equal(v.droppedCountedAsFailure, false);
    assert.equal(v.failuresTotal, 5);
    assert.match(v.reasons.join(' '), /설정 부족/);
  });

  it('maxVUs 가 부족해도 dropped 가 0 이면 유효', () => {
    const v = judgeValidity({ request: req(openLoad(200)), summary: summary(), k6: k6(10), scrapeGaps: 0 });
    assert.equal(v.valid, true);
    assert.equal(v.droppedCountedAsFailure, false);
  });

  it('요청 0건·스크레이프 누락은 무효, 누락 null(미측정)은 영향 없음', () => {
    const none = judgeValidity({ request: req(closedLoad), summary: summary({ requests: 0 }), k6: k6(10), scrapeGaps: null });
    assert.deepEqual(none.reasons, ['k6 요청 0건']);
    const gap = judgeValidity({ request: req(closedLoad), summary: summary(), k6: k6(10), scrapeGaps: 2 });
    assert.equal(gap.valid, false);
    assert.match(gap.reasons.join(' '), /스크레이프 누락 2/);
  });

  it('cpu 전후 값이 없으면 포화 판정을 건너뛰고 k6Cpu 는 null', () => {
    const s = k6(10);
    s.cpu = { before: null, after: null, cpuMaxCores: null };
    const v = judgeValidity({ request: req(closedLoad), summary: summary(), k6: s, scrapeGaps: 0 });
    assert.equal(v.valid, true);
    assert.equal(v.k6Cpu, null);
    assert.equal(v.k6CpuAvgRatio, null);
  });

  it('durationToSeconds: 복합 형식, 잘못된 형식은 throw', () => {
    assert.equal(durationToSeconds('1m30s'), 90);
    assert.equal(durationToSeconds('500ms'), 0.5);
    assert.throws(() => durationToSeconds('abc'));
    assert.throws(() => durationToSeconds('10s?'));
  });
});
