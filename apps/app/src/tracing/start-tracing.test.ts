import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { startTracing, tracingEnabled } from './start-tracing';

const base = { runId: 'r1', scenario: 's', strategy: 'x' };
const tracing = { endpoint: 'http://127.0.0.1:4318', rootSampleRatio: 0.1 };

test('off·metrics 는 SDK 를 켜지 않고 OTel 모듈도 로드하지 않는다(AC-4)', () => {
  for (const instrumentation of ['off', 'metrics'] as const) {
    assert.equal(tracingEnabled({ ...base, instrumentation, tracing }), false);
    assert.equal(startTracing({ runConfig: { ...base, instrumentation, tracing }, instance: 'i' }), false);
  }
  const otel = Object.keys(require.cache).filter((k) => k.includes('@opentelemetry/sdk-node'));
  assert.deepEqual(otel, []);
});

test('full 이어도 tracing 설정이 null 이면 켜지 않는다', () => {
  assert.equal(tracingEnabled({ ...base, instrumentation: 'full', tracing: null }), false);
});

test('full + tracing 이면 SDK 가 시작되고 종료된다', () => {
  // 별도 프로세스: 전역 OTel 상태를 이 테스트 프로세스에 남기지 않는다.
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      `const t=require(${JSON.stringify(require.resolve('./index'))});
       const on=t.startTracing({runConfig:{runId:'r',scenario:'s',strategy:'x',instrumentation:'full',tracing:{endpoint:'http://127.0.0.1:1',rootSampleRatio:0.1}},instance:'i'});
       const again=t.startTracing({runConfig:{runId:'r',scenario:'s',strategy:'x',instrumentation:'full',tracing:{endpoint:'http://127.0.0.1:1',rootSampleRatio:0.1}},instance:'i'});
       const loaded=Object.keys(require.cache).some(k=>k.includes('sdk-node'));
       t.shutdownTracing().then(()=>console.log(JSON.stringify({on,again,loaded})));`,
    ],
    { encoding: 'utf8', timeout: 20000 },
  );
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop() as string), { on: true, again: false, loaded: true });
});
