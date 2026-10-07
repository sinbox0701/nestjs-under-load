import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRng, makePicker, zipfPicker, zipfTopProbability, traceparent, buildHeaders,
  thinkTimeSeconds, buildOptions,
} from './index.mjs';

test('AC-1: 같은 SEED·VU 면 첫 1000개 선택이 같다', () => {
  for (const DIST of ['uniform', 'zipf']) {
    const run = (seed, vu) => {
      const p = makePicker(createRng(seed, vu), { DIST, ZIPF_S: 1.1 }, 1, 100);
      return Array.from({ length: 1000 }, p);
    };
    assert.deepEqual(run(42, 3), run(42, 3));
    assert.notDeepEqual(run(42, 3), run(42, 4));
    assert.notDeepEqual(run(42, 3), run(43, 3));
  }
});

test('AC-2: Zipf(s=1.1, n=100) 10만 표본에서 순위 1 비율이 이론값 ±10%', () => {
  const pick = zipfPicker(createRng(7, 1), 1, 100, 1.1);
  let top = 0;
  const N = 100000;
  for (let i = 0; i < N; i++) if (pick() === 1) top++;
  const theory = zipfTopProbability(100, 1.1);
  assert.ok(Math.abs(top / N - theory) / theory <= 0.1, `${top / N} vs ${theory}`);
});

test('uniform 은 범위 안에서 양끝을 포함한다', () => {
  const pick = makePicker(createRng(1, 1), { DIST: 'uniform' }, 3, 5);
  const seen = new Set(Array.from({ length: 500 }, pick));
  assert.deepEqual([...seen].sort(), [3, 4, 5]);
});

test('AC-3: traceparent W3C 형식, VU<=REP_ACTORS 일 때만 -01', () => {
  const rng = createRng(1, 1);
  const re = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;
  for (let vu = 1; vu <= 20; vu++) {
    const tp = traceparent(rng, vu, 8);
    assert.match(tp, re);
    assert.equal(tp.endsWith('-01'), vu <= 8, `vu=${vu}`);
  }
  assert.ok(traceparent(rng, 9, 8).endsWith('-00'));
});

test('buildHeaders 는 actor·request id·traceparent 를 담는다', () => {
  const h = buildHeaders(createRng(1, 2), 2, 5, 8);
  assert.equal(h['X-Lab-Actor'], '2-5');
  assert.match(h['X-Request-Id'], /^[0-9a-f-]{36}$/);
  assert.match(h.traceparent, /-01$/);
});

test('thinkTimeSeconds', () => {
  const rng = createRng(1, 1);
  assert.equal(thinkTimeSeconds(rng, 0, 0), 0);
  assert.equal(thinkTimeSeconds(rng, 100, 100), 0.1);
  for (let i = 0; i < 100; i++) {
    const t = thinkTimeSeconds(rng, 100, 200);
    assert.ok(t >= 0.1 && t <= 0.2);
  }
});

test('AC-4: buildOptions open 스냅샷', () => {
  assert.deepEqual(
    buildOptions({ MODEL: 'open', PHASE: 'main', RATE: '200', DURATION: '30s', PRE_VUS: '50', MAX_VUS: '300' }),
    {
      discardResponseBodies: false,
      scenarios: {
        main: {
          executor: 'constant-arrival-rate', rate: 200, timeUnit: '1s', duration: '30s',
          preAllocatedVUs: 50, maxVUs: 300, tags: { phase: 'main' },
        },
      },
      thresholds: { 'http_req_duration{phase:main}': [] },
      summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
    },
  );
});

test('AC-4: buildOptions closed 스냅샷', () => {
  assert.deepEqual(
    buildOptions({ MODEL: 'closed', PHASE: 'warmup', VUS: '20', DURATION: '10s' }),
    {
      discardResponseBodies: false,
      scenarios: { warmup: { executor: 'constant-vus', vus: 20, duration: '10s', tags: { phase: 'warmup' } } },
      thresholds: { 'http_req_duration{phase:warmup}': [] },
      summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
    },
  );
});

test('buildOptions 는 잘못된 MODEL 을 거부한다', () => {
  assert.throws(() => buildOptions({ MODEL: 'x' }), /MODEL/);
});
