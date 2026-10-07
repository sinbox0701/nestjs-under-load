import { describe, expect, it } from 'vitest';
import { fixtures } from './mock-fixtures';
import type { BatchSummary, RunRequest, WsMessage } from './types';
import runRequest from '../../../engine/contracts/fixtures/run-request.json';
import compareBlocking from '../../../engine/contracts/fixtures/compare-result.blocking.json';

const keys = (o: object) => Object.keys(o).sort();

/** 타입 미러가 필수 키를 빠뜨리지 않았는지: 타입이 요구하는 키 목록을 fixture 가 모두 갖는다. */
describe('C2 타입 미러 ← contracts fixture', () => {
  it('RunRequest', () => {
    const r: RunRequest = runRequest as unknown as RunRequest;
    for (const k of [
      'scenario',
      'strategies',
      'strategyParams',
      'appInstances',
      'includeMemoryLockSingle',
      'reps',
      'load',
      'data',
      'scenarioParams',
      'instrumentation',
      'injectDelay',
      'prediction',
      'label',
    ])
      expect(r).toHaveProperty(k);
    expect(keys(r.load)).toEqual([
      'duration',
      'maxVUs',
      'model',
      'preAllocatedVUs',
      'profile',
      'rate',
      'requestTimeout',
      'thinkTimeMs',
      'vus',
      'warmup',
    ]);
  });

  it('ScenarioInfo', () => {
    for (const s of fixtures.scenarios) {
      for (const k of [
        'id',
        'pack',
        'title',
        'minAppInstances',
        'strategies',
        'load',
        'seedDefaults',
      ])
        expect(s).toHaveProperty(k);
      for (const st of s.strategies)
        for (const k of ['id', 'label', 'kind', 'bypassesOrm', 'requires', 'params'])
          expect(st).toHaveProperty(k);
    }
  });

  it('Session·BatchSummary·RunRow', () => {
    for (const k of ['sessionId', 'state', 'request', 'current', 'batches', 'startedAt', 'endedAt'])
      expect(fixtures.session).toHaveProperty(k);
    const b: BatchSummary = fixtures.batch;
    for (const k of [
      'batchId',
      'scenario',
      'strategy',
      'appInstances',
      'loadModel',
      'reps',
      'runIds',
      'invariants',
      'validity',
      'throughputRps',
      'latencyMs',
      'failures',
      'interventions',
      'badges',
    ])
      expect(b).toHaveProperty(k);
    for (const k of [
      'runId',
      'batchId',
      'sessionId',
      'repetition',
      'scenario',
      'strategy',
      'appInstances',
      'model',
      'instrumentation',
      'status',
      'valid',
      'invariantsPassed',
      'violationsTotal',
      'startedAt',
      'endedAt',
    ])
      expect(fixtures.runRow).toHaveProperty(k);
    for (const k of ['runId', 'batchId', 'sessionId', 'repetition', 'scenario', 'invariants'])
      expect(fixtures.metadata).toHaveProperty(k);
  });

  it('CompareResult(비교 가능·불가)', () => {
    for (const c of [fixtures.compare, compareBlocking as unknown as typeof fixtures.compare]) {
      for (const k of [
        'comparable',
        'axis',
        'diffs',
        'codeVersionDiffers',
        'batches',
        'honestyNote',
      ])
        expect(c).toHaveProperty(k);
      for (const d of c.diffs)
        for (const k of ['path', 'values', 'kind']) expect(d).toHaveProperty(k);
    }
    expect(compareBlocking.comparable).toBe(false);
  });

  it('WsMessage 7종 모두 type·runId·at·data', () => {
    const types = fixtures.wsMessages.map((m: WsMessage) => m.type);
    expect(types).toEqual(['status', 'events', 'agg', 'pool', 'probe', 'invariants', 'end']);
    for (const m of fixtures.wsMessages)
      for (const k of ['type', 'runId', 'at', 'data']) expect(m).toHaveProperty(k);
  });
});
