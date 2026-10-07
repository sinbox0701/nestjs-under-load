// 비교 판정(compare)·BatchSummary 정리 테스트. 계약 fixture 로 한다.
// 실행: tsc -p tsconfig.json && node --test "test/*.test.ts"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { CompareResultSchema, type BatchSummary } from '@under-load/contracts';

import { compareBatches, HONESTY_NOTE, orderBatchSummary } from '../dist/compare/index.js';

const fx = (name: string) => JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../engine/contracts/fixtures', name), 'utf8'));
const clone = <T>(v: T): T => structuredClone(v);

const md1 = fx('metadata.v1.json');
const batch: BatchSummary = fx('batch-summary.json');
const two = [batch, { ...batch, batchId: 'other' }];

/** 메타데이터 한 벌을 고쳐서 둘째 배치용으로. */
const variant = (edit: (m: any) => void) => {
  const m = clone(md1);
  edit(m);
  return [md1, m];
};

describe('compareBatches', () => {
  it('AC-2: load.vus 만 다르면 comparable=false, load.vus blocking', () => {
    const r = compareBatches(two, variant((m) => (m.load.vus = 20)), null);
    assert.equal(r.comparable, false);
    assert.deepEqual(r.diffs, [{ path: 'load.vus', values: [50, 20], kind: 'blocking' }]);
    assert.equal(CompareResultSchema.safeParse(r).success, true);
  });

  it('AC-3: appInstances 만 다르고 axis 지정이면 comparable=true, kind=axis', () => {
    const md = variant((m) => (m.topology.appInstances = 1));
    const r = compareBatches(two, md, 'topology.appInstances');
    assert.equal(r.comparable, true);
    assert.deepEqual(r.diffs, [{ path: 'topology.appInstances', values: [2, 1], kind: 'axis' }]);
    assert.equal(r.axis, 'topology.appInstances');
    assert.equal(CompareResultSchema.safeParse(r).success, true);
  });

  it('AC-3: axis 없이는 같은 차이가 blocking', () => {
    const r = compareBatches(two, variant((m) => (m.topology.appInstances = 1)), null);
    assert.equal(r.comparable, false);
    assert.equal(r.diffs[0]!.kind, 'blocking');
  });

  it('axis 가 아닌 경로의 차이는 axis 가 있어도 blocking', () => {
    const r = compareBatches(
      two,
      variant((m) => {
        m.topology.appInstances = 1;
        m.load.vus = 20;
      }),
      'topology.appInstances',
    );
    assert.equal(r.comparable, false);
    assert.deepEqual(r.diffs.map((d) => [d.path, d.kind]), [
      ['topology.appInstances', 'axis'],
      ['load.vus', 'blocking'],
    ]);
  });

  it('axis=interventions 는 배열 전체를 그 축으로 본다', () => {
    const r = compareBatches(two, variant((m) => (m.interventions = [])), 'interventions');
    assert.equal(r.comparable, true);
    assert.deepEqual(r.diffs.map((d) => [d.path, d.kind]), [['interventions', 'axis']]);
  });

  it('AC-4: git.sha 만 다르면 comparable=true, codeVersionDiffers=true, warning', () => {
    const r = compareBatches(two, variant((m) => (m.git.sha = 'deadbee')), null);
    assert.equal(r.comparable, true);
    assert.equal(r.codeVersionDiffers, true);
    assert.deepEqual(r.diffs, [{ path: 'git.sha', values: [md1.git.sha, 'deadbee'], kind: 'warning' }]);
  });

  it('strategy·runId 등 비교 조건 밖 차이는 무시한다', () => {
    const r = compareBatches(
      two,
      variant((m) => {
        m.strategy.id = 'other';
        m.runId = 'x';
        m.startedAt = 'later';
      }),
      null,
    );
    assert.equal(r.comparable, true);
    assert.deepEqual(r.diffs, []);
    assert.equal(r.codeVersionDiffers, false);
    assert.equal(r.honestyNote, HONESTY_NOTE);
  });

  it('stack.profiles 차이는 blocking(배열 잎)', () => {
    const r = compareBatches(two, variant((m) => (m.stack.profiles = [])), null);
    assert.deepEqual(r.diffs.map((d) => [d.path, d.kind]), [['stack.profiles', 'blocking']]);
  });

  it('값이 한쪽에만 있으면 null 로 보고한다', () => {
    const r = compareBatches(
      two,
      variant((m) => {
        delete m.limits.app.cpuset;
      }),
      null,
    );
    assert.deepEqual(r.diffs, [{ path: 'limits.app.cpuset', values: [md1.limits.app.cpuset, null], kind: 'blocking' }]);
  });

  it('허용하지 않는 axis 는 거부한다', () => {
    assert.throws(() => compareBatches(two, [md1, md1], 'load.vus' as never));
  });
});

describe('orderBatchSummary', () => {
  it('AC-5: invariants 가 throughputRps 보다 앞 키', () => {
    // 저장소가 키 순서를 뒤집어 줘도 응답은 정합성이 먼저다.
    const shuffled = Object.fromEntries(Object.entries(batch).reverse()) as unknown as BatchSummary;
    const keys = Object.keys(orderBatchSummary(shuffled));
    assert.ok(keys.indexOf('invariants') < keys.indexOf('throughputRps'));
    const r = compareBatches([shuffled, shuffled], [md1, md1], null);
    const rk = Object.keys(r.batches[0]!);
    assert.ok(rk.indexOf('invariants') < rk.indexOf('throughputRps'));
    assert.ok(JSON.stringify(r.batches[0]).indexOf('"invariants"') < JSON.stringify(r.batches[0]).indexOf('"throughputRps"'));
  });

  it('AC-5: open 배치의 failures.total 에 dropped 를 합산한다(counted 인 반복만)', () => {
    const open: BatchSummary = {
      ...clone(batch),
      loadModel: 'open',
      failures: { http: [1, 2, 3], dropped: [10, 20, 5], droppedCountedAsFailure: [true, false, true], total: [1, 2, 3] },
    };
    assert.deepEqual(orderBatchSummary(open).failures.total, [11, 2, 8]);
    assert.deepEqual(orderBatchSummary(open).failures.http, [1, 2, 3]);
  });

  it('T-153 AC-1: strategy 가 다르면 lockMs·strategy.params 차이는 비교 조건이 아니다', () => {
    const noLock = clone(md1);
    noLock.strategy = { id: 'no-lock', params: {} };
    noLock.timeouts.lockMs = null;
    const rowLock = clone(md1);
    rowLock.strategy = { id: 'row-lock', params: { lockTimeoutMs: 1000 } };
    rowLock.timeouts.lockMs = 1000;
    const condUpd = clone(md1);
    condUpd.strategy = { id: 'conditional-update', params: {} };
    condUpd.timeouts.lockMs = null;
    const r = compareBatches([batch, { ...batch, batchId: 'b' }, { ...batch, batchId: 'c' }], [noLock, rowLock, condUpd], null);
    assert.equal(r.comparable, true);
    assert.deepEqual(r.diffs, []);
  });

  it('T-153 AC-2: 같은 strategy(row-lock)에서 lockTimeoutMs 만 다르면 blocking', () => {
    const a = clone(md1);
    a.strategy = { id: 'row-lock', params: { lockTimeoutMs: 1000 } };
    a.timeouts.lockMs = 1000;
    const b = clone(a);
    b.strategy.params.lockTimeoutMs = 3000;
    b.timeouts.lockMs = 3000;
    const r = compareBatches(two, [a, b], null);
    assert.equal(r.comparable, false);
    assert.deepEqual(r.diffs, [{ path: 'timeouts.lockMs', values: [1000, 3000], kind: 'blocking' }]);
  });

  it('T-153: 3배치 혼합(row-lock 1000 + row-lock 3000 + no-lock)은 같은 strategy 끼리 달라서 blocking', () => {
    const mk = (id: string, lock: number | null) => {
      const m = clone(md1);
      m.strategy = { id, params: lock === null ? {} : { lockTimeoutMs: lock } };
      m.timeouts.lockMs = lock;
      return m;
    };
    const three = [batch, { ...batch, batchId: 'b' }, { ...batch, batchId: 'c' }];
    const r = compareBatches(three, [mk('row-lock', 1000), mk('row-lock', 3000), mk('no-lock', null)], null);
    assert.equal(r.comparable, false);
    assert.deepEqual(r.diffs, [{ path: 'timeouts.lockMs', values: [1000, 3000, null], kind: 'blocking' }]);
  });

  it('T-153: 2·3배치 모두 strategy 가 다르면 lockMs 차이는 제외', () => {
    const mk = (id: string, lock: number | null) => {
      const m = clone(md1);
      m.strategy = { id, params: {} };
      m.timeouts.lockMs = lock;
      return m;
    };
    const r2 = compareBatches(two, [mk('row-lock', 1000), mk('no-lock', null)], null);
    assert.equal(r2.comparable, true);
    const three = [batch, { ...batch, batchId: 'b' }, { ...batch, batchId: 'c' }];
    const r3 = compareBatches(three, [mk('row-lock', 1000), mk('no-lock', null), mk('conditional-update', 5)], null);
    assert.equal(r3.comparable, true);
    assert.deepEqual(r3.diffs, []);
  });

  it('closed 배치의 total 은 그대로 둔다', () => {
    const closed: BatchSummary = { ...clone(batch), failures: { http: [1, 1, 1], dropped: [0, 0, 0], droppedCountedAsFailure: [true, true, true], total: [1, 1, 1] } };
    assert.deepEqual(orderBatchSummary(closed).failures.total, [1, 1, 1]);
  });

  it('계약 fixture compare-result 와 같은 결과를 낸다', () => {
    const f = fx('compare-result.json');
    const mds = f.batches.map((_: unknown, i: number) => {
      const m = clone(md1);
      m.topology.appInstances = i + 1;
      m.git.sha = f.diffs.find((d: any) => d.path === 'git.sha').values[i];
      return m;
    });
    const r = compareBatches(f.batches, mds, 'topology.appInstances');
    assert.deepEqual(r.diffs, f.diffs);
    assert.equal(r.comparable, f.comparable);
    assert.equal(r.codeVersionDiffers, f.codeVersionDiffers);
    assert.equal(r.honestyNote, f.honestyNote);
    assert.deepEqual(r.batches, f.batches);
  });
});
