// scripts/measured.mjs: 세션 메타데이터 → learn.yaml measured
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import YAML from 'yaml';

import { batchKey, buildMeasured, loadSession, matchSituation, planMeasured, replaceMeasured, runFacts, spread } from './measured.mjs';
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

// ── 1단계: v1 메타데이터(closed·G01·params)·SQLite 세션 ─────────────────────────────
const G01_TEXT = readFileSync(path.join(REPO_ROOT, 'packs/generic/g01-shared-document/learn.yaml'), 'utf8');
const G01 = YAML.parse(G01_TEXT);

/** 1단계 v1 메타데이터 모양의 최소 G01 실행 */
function mdV1G01({ strategy = 'naive-overwrite', params = {}, instances = 2, vus = 20, documents = 1, editMs = 50, dist = 'uniform', rep = 1, interventions = [] } = {}) {
  const batchId = `S_g01_${strategy}_i${instances}`;
  return {
    schemaVersion: 1,
    runId: `${batchId}_r${rep}`,
    batchId,
    strategy: { id: strategy, params },
    profile: 'default',
    host: { cpu: 'Test CPU', dockerNcpu: 8, dockerMemBytes: 8 * 2 ** 30 },
    limits: { app: { cpus: 1, cpuset: '2-5' }, postgres: { cpus: 2 } },
    topology: { appInstances: instances },
    timeouts: { k6RequestMs: 10000 },
    data: { rows: {}, seedOptions: documents == null ? {} : { documents }, distribution: dist, scenarioParams: editMs == null ? {} : { editMs } },
    load: { model: 'closed', vus, rate: null, maxVUs: null, duration: '30s', warmup: '5s(별도 실행)' },
    interventions,
    chaos: [],
    validity: { valid: true, reasons: [], droppedCountedAsFailure: false, k6CpuAvgRatio: 0.1 },
    invariants: [
      { id: 'no-lost-update', severity: 'critical', violations: 3 },
      { id: 'ledger-matches-k6', severity: 'info', violations: null, value: { success: 700, total: 757 } },
    ],
    k6: { requests: 3000, throughputRps: 100, httpFailures: 0, dropped: 0, latencyMs: { success: { p95: 3 }, failed: { p95: 0 } } },
  };
}

describe('v1 closed·G01 대응', () => {
  const idOf = (opts, defaults) => matchSituation(G01.situations, batchKey(mdV1G01(opts)), defaults)?.id ?? null;

  it('closed 는 vus·문서 수·분포·편집 시간으로 situation 에 대응한다', () => {
    assert.equal(idOf({ instances: 1, vus: 2 }), 'two-people-one-doc');
    assert.equal(idOf({ instances: 2, vus: 20 }), 'twenty-people-one-doc');
    assert.equal(idOf({ instances: 2, vus: 20, documents: 100, dist: 'zipf(1.1)' }), 'zipf-100-docs');
    assert.equal(idOf({ instances: 2, vus: 20, documents: 100, dist: 'zipf(1.5)' }), null);
    assert.equal(idOf({ instances: 2, vus: 20, editMs: 80 }), null);
    assert.equal(idOf({ instances: 2, vus: 7 }), null);
    const win = [{ type: 'inject-delay', point: 'after-read', ms: 30 }];
    assert.equal(idOf({ instances: 1, vus: 10, editMs: 0, interventions: win }), 'contention-window-30');
  });

  it('정직성: 문서 수·편집 시간 기록이 없으면(seedOptions {}) 채우지 않는다', () => {
    assert.equal(idOf({ instances: 2, vus: 20, documents: null, editMs: null }), null);
    assert.equal(idOf({ instances: 2, vus: 20, documents: null }), null);
  });

  it('lease-short-ttl: edit-lease 는 params 가 ttlMs=100 일 때만, 다른 strategy 는 기본 파라미터면 같은 부하 조건으로 대응', () => {
    const base = { instances: 1, vus: 5, editMs: 150 };
    assert.equal(idOf({ ...base, strategy: 'edit-lease', params: { ttlMs: 100 } }), 'lease-short-ttl');
    assert.equal(idOf({ ...base, strategy: 'edit-lease', params: {} }), null);
    assert.equal(idOf({ ...base, strategy: 'edit-lease', params: { ttlMs: 500 } }), null);
    assert.equal(idOf({ ...base, strategy: 'optimistic-version' }), 'lease-short-ttl');
    assert.equal(idOf({ ...base, strategy: 'optimistic-version', params: { x: 1 } }), null);
  });

  it('manifest 기본값을 덧씌워 비교한다(기록에 기본값이 들어 있든 없든 같다)', () => {
    const defaults = { 'edit-lease': { ttlMs: 30000, retryAfterMs: 1000 } };
    const base = { instances: 1, vus: 5, editMs: 150, strategy: 'edit-lease' };
    assert.equal(idOf({ ...base, params: { ttlMs: 100 } }, defaults), 'lease-short-ttl');
    assert.equal(idOf({ ...base, params: { ttlMs: 100, retryAfterMs: 1000 } }, defaults), 'lease-short-ttl');
    assert.equal(idOf({ ...base, params: { ttlMs: 30000 } }, defaults), null);
    // 기본 파라미터 edit-lease 는 ttlMs 를 기본값으로 쓰는 일반 situation 에 대응(여기서는 부하가 맞는 것이 없어 null)
    assert.equal(idOf({ instances: 2, vus: 20, strategy: 'edit-lease', params: { ttlMs: 30000 } }, defaults), 'twenty-people-one-doc');
    const g02 = { appInstances: 2, model: 'open', rate: 200, products: 5, stockPerProduct: 100, distribution: 'uniform', chaos: 'none', strategy: 'row-lock' };
    assert.equal(matchSituation(LEARN.situations, { ...g02, params: { lockTimeoutMs: 1000 } }, { 'row-lock': { lockTimeoutMs: 1000 } })?.id, 'spike-200-two-instances');
    assert.equal(matchSituation(LEARN.situations, { ...g02, params: { lockTimeoutMs: 50 } }, { 'row-lock': { lockTimeoutMs: 1000 } }), null);
  });

  it('buildMeasured: G01 은 총재고 없이 원장 성공·closed 부하·문서 조건을 적는다', () => {
    const s = G01.situations.find((x) => x.id === 'twenty-people-one-doc');
    const m = buildMeasured([mdV1G01({ rep: 1 }), mdV1G01({ rep: 2 })], s);
    assert.deepEqual(m.throughputRps, { median: 100, min: 100, max: 100 }); // v1 k6.throughputRps 그대로
    assert.match(m.summary, /위반 2\/2회 발생\(no-lost-update 3·3건\)/);
    assert.match(m.summary, /원장 성공 700·700건 · /);
    assert.doesNotMatch(m.summary, /총재고|NaN/);
    assert.match(m.conditions, /closed constant-vus 20 × 30s/);
    assert.match(m.conditions, /문서 1개, 균등 분포, 편집 50ms/);
  });
});

describe('세션 읽기: lab.sqlite', () => {
  it('_sessions JSON 이 없으면 runs/_meta/lab.sqlite 의 세션 실행 행을 읽는다', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'measured-'));
    try {
      mkdirSync(path.join(dir, '_meta'));
      const db = new DatabaseSync(path.join(dir, '_meta', 'lab.sqlite'));
      db.exec('CREATE TABLE runs (run_id TEXT PRIMARY KEY, batch_id TEXT, session_id TEXT, repetition INTEGER, scenario TEXT, metadata_json TEXT)');
      const ins = db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)');
      const mds = [mdV1G01({ rep: 1, instances: 2, vus: 20 }), mdV1G01({ rep: 2, instances: 2, vus: 20 })];
      for (const [i, m] of mds.entries()) ins.run(m.runId, m.batchId, 'SESS', i + 1, 'g01-shared-document', JSON.stringify(m));
      ins.run('S_g01_x_i2_r3', mds[0].batchId, 'SESS', 3, 'g01-shared-document', null); // 메타데이터 없는 실행은 건너뜀
      db.close();
      const { scenario, session, readMetadata } = loadSession(dir, 'SESS');
      assert.equal(scenario, 'g01-shared-document');
      assert.equal(session.runs.length, 2);
      const plan = planMeasured(session, G01, readMetadata);
      assert.equal(plan.length, 1);
      assert.equal(plan[0].situation, 'twenty-people-one-doc');
      assert.deepEqual(plan[0].measured.runs, mds.map((m) => m.runId));
      assert.throws(() => loadSession(dir, 'NOPE'), /lab\.sqlite 에 없습니다/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// AC-1: 0단계 세션(v0 metadata)으로 다시 계산하면 현재 learn.yaml 의 measured 와 바이트 단위로 같다.
// 0단계 실제 runs/ 가 있을 때만(공개 레포에는 없다). LAB_PHASE0_RUNS 로 위치를 바꾼다. 3회 반복 실측 세션만 대상(1회짜리 시험 세션은 learn.yaml 에 반영된 적 없다).
const PHASE0_RUNS = process.env.LAB_PHASE0_RUNS ?? path.join(REPO_ROOT, 'runs');
const phase0Sessions = (() => {
  try {
    return readdirSync(path.join(PHASE0_RUNS, '_sessions')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
})();

describe('0단계 실측 회귀', { skip: phase0Sessions.length === 0 && 'runs/_sessions 없음(0단계 실측이 없는 체크아웃)' }, () => {
  it('0단계 세션으로 계산한 measured 가 현재 learn.yaml 과 바이트 단위로 같다', () => {
    let checked = 0;
    for (const id of phase0Sessions) {
      const { session, readMetadata } = loadSession(PHASE0_RUNS, id);
      if (session.runs.length < 6 || readMetadata(session.runs[0].runId).schemaVersion != null) continue;
      const plan = planMeasured(session, LEARN, readMetadata).filter((p) => !p.skip);
      let text = LEARN_TEXT;
      for (const p of plan) text = replaceMeasured(text, p.strategy, p.situation, p.measured);
      assert.equal(text, LEARN_TEXT, `세션 ${id}`);
      checked += plan.length;
    }
    assert.ok(checked > 0, '대응된 셀이 하나도 없다');
  });
});
