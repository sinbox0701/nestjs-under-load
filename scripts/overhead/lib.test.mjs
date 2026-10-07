// scripts/overhead/lib.mjs: 요청 모양, 무효 판정, 셀 집계, 표 렌더
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { aggregate, fmtSpread, mainWindow, openLoad, overheadRequest, renderInvalid, renderTable, runFacts, spread } from './lib.mjs';

/** 오케스트레이터 /runs/:id 응답 모양의 최소 메타데이터 */
function md({ throughputRps = 400, p50 = 3, p99 = 9, n = 12000, dropped = 0, httpFailures = 0, valid = true, reasons = [] } = {}) {
  return {
    batchId: 'B',
    sessionId: 'S',
    limits: { app: { cpus: 1, cpuset: '2-5' } },
    topology: { appInstances: 2 },
    validity: { valid, reasons, k6CpuAvgRatio: 0.2 },
    k6: { throughputRps, dropped, httpFailures, latencyMs: { success: { p50, p99, n } } },
    pgProbe: { enabled: false, intervalMs: 5000 },
  };
}
const row = (over = {}) => ({ status: 'done', violationsTotal: 0, ...over });
const base = { level: 'off', contention: 'low', rep: 1, rate: 400 };

describe('요청', () => {
  it('open 고정 도착률: maxVUs = rate × 요청 타임아웃', () => {
    const l = openLoad(400, { duration: '30s', warmup: '10s' });
    assert.equal(l.model, 'open');
    assert.equal(l.maxVUs, 800);
    assert.equal(l.requestTimeout, '2s');
    assert.ok(l.preAllocatedVUs <= l.maxVUs);
  });
  it('G02 row-lock · reps 1 · 기준별 상품 수 · 수준', () => {
    const r = overheadRequest({ level: 'full', contention: 'high', rate: 300, duration: '30s', warmup: '10s', label: 'x', prediction: 'p' });
    assert.deepEqual(r.strategies, ['row-lock']);
    assert.equal(r.reps, 1);
    assert.equal(r.instrumentation, 'full');
    assert.equal(r.data.seedOptions.products, 1);
    assert.equal(overheadRequest({ ...r, level: 'off', contention: 'low', rate: 300 }).data.seedOptions.products, 1000);
  });
});

describe('본 실행 구간', () => {
  it('k6 본 실행 → 불변식 검사', () => {
    const w = mainWindow([
      { name: 'k6 웜업', at: '2026-10-07T00:00:00.000Z' },
      { name: 'k6 본 실행', at: '2026-10-07T00:00:10.000Z' },
      { name: '불변식 검사', at: '2026-10-07T00:00:40.000Z' },
    ]);
    assert.equal(w.toMs - w.fromMs, 30000);
    assert.equal(mainWindow([]), null);
  });
});

describe('무효 판정', () => {
  it('정상 실행은 유효', () => {
    const f = runFacts({ runId: 'r', row: row(), md: md(), appCpu: { cores: 0.8 }, ...base });
    assert.equal(f.valid, true);
    assert.equal(f.p99, 9);
  });
  it('dropped·HTTP 실패·처리량 미달·app CPU 포화·위반·오케 무효는 각각 사유', () => {
    const cases = [
      [{ md: md({ dropped: 5 }) }, /dropped/],
      [{ md: md({ httpFailures: 1 }) }, /HTTP 실패/],
      [{ md: md({ throughputRps: 300 }) }, /97%/],
      [{ appCpu: { cores: 1.9 } }, /포화/],
      [{ row: row({ violationsTotal: 2 }) }, /위반/],
      [{ md: md({ valid: false, reasons: ['k6 CPU 포화'] }) }, /k6 CPU/],
      [{ md: null }, /메타데이터 없음/],
    ];
    for (const [over, re] of cases) {
      const f = runFacts({ runId: 'r', row: row(), md: md(), appCpu: { cores: 0.5 }, ...base, ...over });
      assert.equal(f.valid, false);
      assert.match(f.reasons.join(';'), re);
    }
  });
});

describe('집계·렌더', () => {
  it('spread: 중앙값(최소~최대), 짝수 개는 가운데 둘 평균', () => {
    assert.deepEqual(spread([3, 1, 2]), { median: 2, min: 1, max: 3 });
    assert.deepEqual(spread([1, 4]), { median: 2.5, min: 1, max: 4 });
    assert.equal(spread([null]), null);
    assert.equal(fmtSpread({ median: 2, min: 1, max: 3 }, 1), '2.0 (1.0~3.0)');
  });
  it('무효 반복은 셀 값에서 빠지고 링크는 취소선, 사유가 남는다', () => {
    const runs = [1, 2, 3].map((rep) =>
      runFacts({ runId: `low-off-${rep}`, row: row(), md: md({ p99: rep * 10, dropped: rep === 3 ? 7 : 0 }), appCpu: { cores: 0.5 }, ...base, rep }),
    );
    const [cell] = aggregate(runs);
    assert.equal(cell.validCount, 2);
    assert.deepEqual(cell.p99, { median: 15, min: 10, max: 20 });
    const table = renderTable([cell]);
    assert.match(table, /15\.00 \(10\.00~20\.00\)/);
    assert.match(table, /\[r1\]\(\.\.\/runs\/low-off-1\/\)/);
    assert.match(table, /~~\[r3\]/);
    assert.match(renderInvalid(runs), /low-off-3.*dropped 7/);
  });
});
