// scripts/measured.mjs: 세션 메타데이터 → learn.yaml measured
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import YAML from 'yaml';

import { batchKey, buildMeasured, matchSituation, planMeasured, replaceMeasured, runFacts, spread } from './measured.mjs';
import { REPO_ROOT } from './run.mjs';

const LEARN_PATH = path.join(REPO_ROOT, 'packs/generic/g02-stock-decrement/learn.yaml');
const LEARN_TEXT = readFileSync(LEARN_PATH, 'utf8');
const LEARN = YAML.parse(LEARN_TEXT);

/** run.mjs buildMetadata 모양의 최소 메타데이터 */
function md({ rep = 1, strategy = 'no-lock', instances = 2, valid = true, oversell = 0, p95 = 2, httpReqs = 4000, failed = 0, success = 500, interventions = [] } = {}) {
  const batchId = `S_g02_${strategy}_i${instances}`;
  return {
    runId: `${batchId}_r${rep}`,
    batchId,
    strategy: { id: strategy, params: {} },
    profile: 'minimal',
    host: { cpu: 'Test CPU', dockerNcpu: 8, dockerMemBytes: 8 * 2 ** 30 },
    limits: { app: { cpus: 1, cpuset: 'none' }, postgres: { cpus: 2 } },
    topology: { appInstances: instances },
    timeouts: { k6RequestMs: 10000 },
    data: { rows: { products: 5 }, stockPerProduct: 100, distribution: 'uniform', qtyPerOrder: 1 },
    load: { model: 'open', rate: 200, duration: '20s', warmup: '5s(별도 실행, 웜업 전용 상품)', maxVUs: 2000 },
    interventions,
    chaos: [],
    validity: { valid, reasons: valid ? [] : ['k6 CPU 포화'], droppedCountedAsFailure: true, k6CpuAvgRatio: 0.05 },
    invariants: [
      { id: 'no-oversell', severity: 'critical', violations: oversell },
      { id: 'sold-equals-decrement', severity: 'critical', violations: oversell },
      { id: 'ledger-matches-k6', severity: 'info', value: { success, sold_out: httpReqs - success, total: httpReqs } },
    ],
    k6: { httpReqs, droppedIterations: 0, failed, latencyMs: { p95 } },
  };
}

describe('measured 집계', () => {
  it('spread: 중앙값·범위', () => {
    assert.deepEqual(spread([3, 1, 2]), { median: 2, min: 1, max: 3 });
    assert.deepEqual(spread([1, 4]), { median: 2.5, min: 1, max: 4 });
    assert.equal(spread([null]), null);
  });

  it('runFacts: 처리량 = 응답 수 / 본 실행 길이, 실패율 %', () => {
    const f = runFacts(md({ httpReqs: 4000, failed: 40 }));
    assert.equal(f.throughputRps, 200);
    assert.equal(f.failRatePct, 1);
    assert.equal(f.violationTotal, 0);
  });

  it('situation 대응: 앱 대수·도착률·데이터가 같고 chaos·params 없는 것 하나', () => {
    const key = { appInstances: 2, model: 'open', rate: 200, products: 5, stockPerProduct: 100, distribution: 'uniform', chaos: 'none' };
    assert.equal(matchSituation(LEARN.situations, key)?.id, 'spike-200-two-instances');
    assert.equal(matchSituation(LEARN.situations, { ...key, appInstances: 1 })?.id, 'spike-200-one-instance');
    assert.equal(matchSituation(LEARN.situations, { ...key, rate: 150 }), null);
    assert.equal(matchSituation(LEARN.situations, { ...key, chaos: 'some' }), null);
  });

  it('경합 창 주입(after-read): situation injected.contentionWindowMs와 ms가 같아야 대응, 다른 개입이 섞이면 대응 없음', () => {
    const win = (ms) => [{ type: 'inject-delay', point: 'after-read', ms }];
    assert.equal(matchSituation(LEARN.situations, batchKey(md({ instances: 1, interventions: win(30) })))?.id, 'contention-window-30-one-instance');
    assert.equal(matchSituation(LEARN.situations, batchKey(md({ instances: 2, interventions: win(30) })))?.id, 'contention-window-30-two-instances');
    assert.equal(matchSituation(LEARN.situations, batchKey(md({ instances: 2, interventions: win(50) }))), null);
    assert.equal(matchSituation(LEARN.situations, batchKey(md({ instances: 2 })))?.id, 'spike-200-two-instances');
    const mixed = [...win(30), { type: 'inject-delay', point: 'after-lock', ms: 5 }];
    assert.equal(matchSituation(LEARN.situations, batchKey(md({ instances: 2, interventions: mixed }))), null);
  });

  it('buildMeasured: 주입된 실행은 measured.injected·summary·conditions에 "주입됨"이 남는다', () => {
    const s = LEARN.situations.find((x) => x.id === 'contention-window-30-two-instances');
    const interventions = [{ type: 'inject-delay', point: 'after-read', ms: 30 }];
    const m = buildMeasured([md({ rep: 1, interventions }), md({ rep: 2, interventions })], s);
    assert.deepEqual(m.injected, { contentionWindowMs: 30 });
    assert.match(m.summary, /^경합 창 30ms 주입됨 · /);
    assert.match(m.conditions, /경합 창 지연 30ms 주입됨\(after-read/);
    assert.equal(buildMeasured([md()], LEARN.situations.find((x) => x.id === 'spike-200-two-instances')).injected, undefined);
  });

  it('buildMeasured: 무효 실행 제외, 위반 횟수·수치·조건 문구', () => {
    const s = LEARN.situations.find((x) => x.id === 'spike-200-two-instances');
    const m = buildMeasured([md({ rep: 1, oversell: 2, success: 503 }), md({ rep: 2 }), md({ rep: 3, valid: false })], s);
    assert.equal(m.run, 'S_g02_no-lock_i2');
    assert.deepEqual(m.runs, ['S_g02_no-lock_i2_r1', 'S_g02_no-lock_i2_r2']);
    assert.deepEqual(m.violations['no-oversell'], [2, 0]);
    assert.match(m.summary, /위반 1\/2회 발생/);
    assert.match(m.summary, /원장 성공 503·500건 \/ 총재고 500/);
    assert.match(m.summary, /무효 1회 제외/);
    assert.match(m.conditions, /profile minimal/);
    assert.match(m.conditions, /shape=spike/);
    assert.equal(buildMeasured([md({ valid: false })], s), null);
  });
});

describe('learn.yaml measured 블록 교체', () => {
  it('해당 outcome의 measured만 바뀌고 나머지 텍스트는 그대로', () => {
    // 기준 텍스트: 대상 outcome의 measured를 null로 되돌린 learn.yaml(이미 실측이 채워져 있어도 같은 조건에서 검사)
    const BASE = replaceMeasured(LEARN_TEXT, 'row-lock', 'spike-200-two-instances', null);
    const BASE_DOC = YAML.parse(BASE);
    const plan = planMeasured({ runs: [{ runId: 'a' }, { runId: 'b' }] }, BASE_DOC, (id) => md({ rep: id === 'a' ? 1 : 2, strategy: 'row-lock' }));
    assert.equal(plan.length, 1);
    const { strategy, situation, measured } = plan[0];
    const out = replaceMeasured(BASE, strategy, situation, measured);
    const parsed = YAML.parse(out);
    const o = parsed.outcomes.find((x) => x.strategy === 'row-lock' && x.situation === 'spike-200-two-instances');
    assert.deepEqual(o.measured, measured);
    // 다른 outcome·개념 문구는 그대로
    const others = (doc) => doc.outcomes.filter((x) => x !== o && !(x.strategy === 'row-lock' && x.situation === 'spike-200-two-instances'));
    assert.deepEqual(others(parsed).map((x) => x.measured), others(BASE_DOC).map((x) => x.measured));
    assert.deepEqual(parsed.concepts, BASE_DOC.concepts);
    // 다시 바꿔도(기존 measured 블록 덮어쓰기) 결과가 같다
    assert.equal(replaceMeasured(out, strategy, situation, measured), out);
    // 바뀐 것은 `measured: null` 한 줄뿐: 그 앞뒤 텍스트가 그대로
    const count = (t) => t.split('\n').filter((l) => l === '    measured: null').length;
    assert.equal(count(out), count(BASE) - 1);
    const at = BASE.split('\n').findIndex((l, i, a) => l === '    measured: null' && a[i - 4] === '  - strategy: row-lock' && a[i - 3] === '    situation: spike-200-two-instances');
    const [head, tail] = [BASE.split('\n').slice(0, at), BASE.split('\n').slice(at + 1)];
    assert.ok(at > 0);
    assert.ok(out.startsWith(head.join('\n') + '\n    measured:\n'));
    assert.ok(out.endsWith('\n' + tail.join('\n')));
  });

  it('없는 outcome이면 에러', () => {
    assert.throws(() => replaceMeasured(LEARN_TEXT, 'nope', 'x', {}), /measured 키가 없습니다/);
  });
});
