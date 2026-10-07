// C2 공개 라우트·내부 run-config·카탈로그·learn measured 테스트. RunEngine·MetadataStore·K6Runner 는 가짜.
// 실행: tsc -p tsconfig.json && node --test "test/*.test.ts"
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ScenarioInfoSchema, type BatchSummary, type RunConfigV1, type RunRow } from '@under-load/contracts';

import { loadPackCatalog, registerApiRoutes, createRunConfigBoard } from '../dist/api/index.js';
import { createRouters, startHttpServers } from '../dist/http/index.js';
import { computeMeasuredCells, runFacts } from '../dist/learn/index.js';
import type { K6Runner, MetadataStore, RunEngine, StartResult } from '../dist/ports.js';

const repoDir = path.resolve(import.meta.dirname, '../..');
const fx = (name: string) => JSON.parse(readFileSync(path.join(repoDir, 'engine/contracts/fixtures', name), 'utf8'));
const clone = <T>(v: T): T => structuredClone(v);

const HOST = 'localhost:4000';
const guard = { allowedHosts: [HOST], allowedOrigins: [] };

function call(port: number, method: string, url: string, body?: unknown) {
  return new Promise<{ status: number; text: string; json: any }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: url, method, headers: { host: HOST, 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* JSON 아님 */
        }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// ───────── 가짜 ─────────

const runRequest = fx('run-request.json');
const batchFx: BatchSummary = fx('batch-summary.json');
const runRow: RunRow = fx('run-row.json');
const md1 = fx('metadata.v1.json');

class FakeEngine implements RunEngine {
  next: StartResult = { kind: 'accepted', accepted: { sessionId: 's1', batches: [{ batchId: 'b1', strategy: 'no-lock', appInstances: 2, runIds: ['r1', 'r2', 'r3'] }] } };
  started: unknown[] = [];
  aborted: string[] = [];
  async start(r: any) {
    this.started.push(r);
    return this.next;
  }
  async abort(id: string) {
    this.aborted.push(id);
    return id !== 'unknown';
  }
  async status(id: string): Promise<any> {
    return id === 's1' ? { sessionId: 's1', state: 'running' } : null;
  }
  currentRunId() {
    return null;
  }
  async idle() {}
}

type FakeStore = Partial<MetadataStore> & { runs: RunRow[]; metadata: Map<string, unknown>; batches: Map<string, BatchSummary> };

function makeStore(): FakeStore {
  const s: FakeStore = {
    runs: [],
    metadata: new Map(),
    batches: new Map(),
    async getRun(id: string) {
      return s.runs.find((r) => r.runId === id) ?? null;
    },
    async getSteps() {
      return [{ name: 'reset', at: '2026-10-07T09:00:00Z' }];
    },
    async getMetadata(id: string) {
      return (s.metadata.get(id) as any) ?? null;
    },
    async getBatchSummary(id: string) {
      return s.batches.get(id) ?? null;
    },
    async listRuns(filter: any = {}) {
      const items = s.runs.filter((r) => (!filter.scenario || r.scenario === filter.scenario) && (!filter.batchId || r.batchId === filter.batchId));
      return { items, next: null };
    },
  };
  return s;
}

const fakeK6 = {
  buildEnv: (i: any) => ({ MODEL: i.request.load.model, VUS: String(i.request.load.vus), RUN_ID: i.runId, PHASE: i.phase }),
  scriptHash: async () => 'sha256:abc',
} as unknown as K6Runner;

describe('C2 API', () => {
  const engine = new FakeEngine();
  const store = makeStore();
  const board = createRunConfigBoard();
  const catalog = loadPackCatalog(repoDir);
  const runsDir = mkdtempSync(path.join(tmpdir(), 'nul-api-'));
  let servers: Awaited<ReturnType<typeof startHttpServers>>;
  let pub = 0;
  let int = 0;

  before(async () => {
    const routers = createRouters();
    registerApiRoutes(routers, { engine, store: store as MetadataStore, catalog, board, k6: fakeK6, runsDir, version: '1.2.3', gitSha: 'abc1234' });
    servers = await startHttpServers({ routers, guard, publicPort: 0, internalPort: 0, bindHost: '127.0.0.1', onError: () => {} });
    pub = servers.ports.public;
    int = servers.ports.internal;
  });
  after(async () => {
    await servers.close();
    rmSync(runsDir, { recursive: true, force: true });
  });

  it('GET /health', async () => {
    const r = await call(pub, 'GET', '/health');
    assert.deepEqual(r.json, { ok: true, version: '1.2.3', gitSha: 'abc1234' });
  });

  it('GET /scenarios: manifest 를 읽어 ScenarioInfo 를 만든다', async () => {
    const r = await call(pub, 'GET', '/scenarios');
    assert.equal(r.status, 200);
    const list = r.json as any[];
    for (const s of list) assert.equal(ScenarioInfoSchema.safeParse(s).success, true, JSON.stringify(ScenarioInfoSchema.safeParse(s).error?.issues));
    const g02 = list.find((s) => s.id === 'g02-stock-decrement');
    assert.ok(g02);
    assert.equal(g02.pack, 'generic');
    assert.equal(g02.minAppInstances, 2);
    assert.deepEqual(g02.strategies.map((s: any) => s.id), ['no-lock', 'app-memory-lock', 'row-lock', 'conditional-update']);
    assert.deepEqual(g02.load.models, ['open', 'closed']);
    assert.equal(g02.load.defaults.rate, 100);
    assert.equal(g02.seedDefaults.stockPerProduct, 100);
    assert.ok(Array.isArray(g02.situations) && g02.situations.length > 0);
  });

  it('카탈로그: ScenarioDef(엔진용)에 기본 파라미터·SQL·스크립트 경로가 담긴다', () => {
    const d = catalog.get('g02-stock-decrement')!;
    assert.equal(d.k6Script, '/packs/generic/g02-stock-decrement/k6/template.js');
    assert.equal(d.strategies.find((s) => s.id === 'row-lock')!.params.lockTimeoutMs, 1000);
    assert.deepEqual(d.strategies.find((s) => s.id === 'no-lock')!.params, {});
    assert.equal(d.invariants.find((i) => i.id === 'ledger-matches-k6')!.severity, 'info');
    assert.ok(d.invariantsSqlPath.endsWith('g02-stock-decrement/invariants.sql'));
    assert.match(d.discardSql ?? '', /delete from g02_order_ledger/);
    assert.equal(catalog.get('nope'), undefined);
  });

  it('AC-1: prediction 이 빈 문자열이면 400 + errors 에 경로, 엔진은 부르지 않는다', async () => {
    const before = engine.started.length;
    const r = await call(pub, 'POST', '/runs', { ...clone(runRequest), prediction: '' });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.some((e: any) => e.path === 'prediction'), r.text);
    assert.equal(engine.started.length, before);
  });

  it('AC-1: 모르는 키·잘못된 load 는 400, 경로는 점 표기', async () => {
    const bad = clone(runRequest);
    bad.load.vus = null;
    const r = await call(pub, 'POST', '/runs', bad);
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.some((e: any) => e.path === 'load.vus'));
    const extra = await call(pub, 'POST', '/runs', { ...clone(runRequest), foo: 1 });
    assert.equal(extra.status, 400);
  });

  it('AC-1: 정상 요청은 202 + batches', async () => {
    const r = await call(pub, 'POST', '/runs', runRequest);
    assert.equal(r.status, 202);
    assert.equal(r.json.sessionId, 's1');
    assert.equal(r.json.batches[0].runIds.length, 3);
    assert.deepEqual(engine.started.at(-1), runRequest);
  });

  it('POST /runs: 알 수 없는 시나리오 400, busy 409, 엔진 invalid 400', async () => {
    const unknown = await call(pub, 'POST', '/runs', { ...clone(runRequest), scenario: 'nope' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.errors[0].path, 'scenario');

    engine.next = { kind: 'busy', sessionId: 'sx' };
    const busy = await call(pub, 'POST', '/runs', runRequest);
    assert.equal(busy.status, 409);
    assert.deepEqual(busy.json, { reason: 'busy', sessionId: 'sx' });

    engine.next = { kind: 'invalid', errors: [{ path: 'strategies.0', message: '미지 전략' }] };
    const inv = await call(pub, 'POST', '/runs', runRequest);
    assert.equal(inv.status, 400);
    assert.deepEqual(inv.json, { errors: [{ path: 'strategies.0', message: '미지 전략' }] });
  });

  it('POST /k6/render: env·templatePath·scriptHash', async () => {
    const r = await call(pub, 'POST', '/k6/render', { request: runRequest, strategy: 'no-lock' });
    assert.equal(r.status, 200);
    assert.equal(r.json.templatePath, '/packs/generic/g02-stock-decrement/k6/template.js');
    assert.equal(r.json.env.MODEL, 'closed');
    assert.equal(r.json.scriptHash, 'sha256:abc');
    const bad = await call(pub, 'POST', '/k6/render', { request: runRequest, strategy: 'row-lock-x' });
    assert.equal(bad.status, 400);
  });

  it('GET /sessions/:id', async () => {
    assert.equal((await call(pub, 'GET', '/sessions/s1')).status, 200);
    assert.equal((await call(pub, 'GET', '/sessions/zz')).status, 404);
  });

  it('GET /runs, /runs/:id', async () => {
    store.runs.push(runRow);
    const list = await call(pub, 'GET', '/runs?scenario=g02-stock-decrement&limit=10');
    assert.equal(list.status, 200);
    assert.equal(list.json.items.length, 1);
    assert.equal((await call(pub, 'GET', '/runs?limit=0')).status, 400);
    assert.equal((await call(pub, 'GET', '/runs?limit=201')).status, 400);

    store.metadata.set(runRow.runId, md1);
    const d = await call(pub, 'GET', `/runs/${runRow.runId}`);
    assert.equal(d.status, 200);
    assert.equal(d.json.row.runId, runRow.runId);
    assert.equal(d.json.metadata.schemaVersion, 1);
    assert.equal(d.json.steps.length, 1);
    assert.equal((await call(pub, 'GET', '/runs/none')).status, 404);
  });

  it('GET /runs/:id/artifacts/:name: 허용 이름만, 파일 없으면 404', async () => {
    mkdirSync(path.join(runsDir, runRow.runId), { recursive: true });
    writeFileSync(path.join(runsDir, runRow.runId, 'summary.json'), '{"a":1}');
    const ok = await call(pub, 'GET', `/runs/${runRow.runId}/artifacts/summary.json`);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { a: 1 });
    assert.equal((await call(pub, 'GET', `/runs/${runRow.runId}/artifacts/report.html`)).status, 404);
    assert.equal((await call(pub, 'GET', `/runs/${runRow.runId}/artifacts/secret.txt`)).status, 404);
    assert.equal((await call(pub, 'GET', `/runs/${runRow.runId}/artifacts/..%2F..%2Fx`)).status, 404);
    assert.equal((await call(pub, 'GET', '/runs/none/artifacts/summary.json')).status, 404);
  });

  it('GET /batches/:id, abort, chaos', async () => {
    store.batches.set(batchFx.batchId, batchFx);
    const b = await call(pub, 'GET', `/batches/${batchFx.batchId}`);
    assert.equal(b.status, 200);
    assert.equal(b.json.batchId, batchFx.batchId);
    assert.equal((await call(pub, 'GET', '/batches/none')).status, 404);

    assert.equal((await call(pub, 'POST', '/runs/r1/abort')).status, 202);
    assert.equal((await call(pub, 'POST', '/runs/unknown/abort')).status, 404);
    assert.equal((await call(pub, 'POST', '/runs/r1/chaos', {})).status, 501);
  });

  it('GET /compare: AC-2·AC-3·AC-4·AC-5 를 HTTP 로', async () => {
    const mk = (id: string, edit: (m: any) => void, edit2?: (b: BatchSummary) => void) => {
      const b = clone(batchFx);
      b.batchId = id;
      b.runIds = batchFx.runIds.map((r) => `${id}_${r}`);
      edit2?.(b);
      const m = clone(md1);
      edit(m);
      store.batches.set(id, b);
      b.runIds.forEach((r) => store.metadata.set(r, { ...m, runId: r }));
    };
    mk('A', () => {});
    mk('B', (m) => (m.load.vus = 20));
    mk('C', (m) => (m.topology.appInstances = 1));
    mk('D', (m) => (m.git.sha = 'deadbee'));
    mk('E', () => {}, (b) => {
      b.loadModel = 'open';
      b.failures = { http: [1, 1, 1], dropped: [4, 4, 4], droppedCountedAsFailure: [true, true, true], total: [1, 1, 1] };
    });

    const vus = await call(pub, 'GET', '/compare?batches=A,B');
    assert.equal(vus.status, 200);
    assert.equal(vus.json.comparable, false);
    assert.deepEqual(vus.json.diffs, [{ path: 'load.vus', values: [50, 20], kind: 'blocking' }]);

    const axis = await call(pub, 'GET', '/compare?batches=A,C&axis=topology.appInstances');
    assert.equal(axis.json.comparable, true);
    assert.equal(axis.json.diffs[0].kind, 'axis');
    assert.equal((await call(pub, 'GET', '/compare?batches=A,C')).json.comparable, false);

    const git = await call(pub, 'GET', '/compare?batches=A,D');
    assert.equal(git.json.comparable, true);
    assert.equal(git.json.codeVersionDiffers, true);

    const open = await call(pub, 'GET', '/compare?batches=A,E');
    const keys = Object.keys(open.json.batches[1]);
    assert.ok(keys.indexOf('invariants') < keys.indexOf('throughputRps'));
    assert.ok(open.text.indexOf('"invariants"') < open.text.indexOf('"throughputRps"'));
    assert.deepEqual(open.json.batches[1].failures.total, [5, 5, 5]);

    assert.equal((await call(pub, 'GET', '/compare?batches=A')).status, 400);
    assert.equal((await call(pub, 'GET', '/compare?batches=A,B&axis=load.vus')).status, 400);
    assert.equal((await call(pub, 'GET', '/compare?batches=A,nope')).status, 404);
  });

  it('GET /learn/:scenario/measured: 상황에 맞는 batch 만 셀로 만든다', async () => {
    const situations = catalog.learnSituations('g02-stock-decrement')!;
    const target = situations.find((s: any) => s.id === 'two-users-one-instance')!;
    const mkRun = (n: number, valid: boolean, violations: number) => {
      const m = clone(md1);
      m.runId = `L_r${n}`;
      m.batchId = 'L';
      m.repetition = n;
      m.strategy = { id: 'no-lock', params: {} };
      m.topology.appInstances = 1;
      m.load.model = 'closed';
      m.load.vus = 2;
      m.load.duration = '30s';
      m.interventions = [];
      m.data.rows = { products: 5 };
      m.data.seedOptions = { products: 5, stockPerProduct: 100 };
      m.data.distribution = 'uniform';
      m.invariants = [{ id: 'sold-equals-decrement', severity: 'critical', violations, passed: violations === 0 }];
      m.validity = { ...m.validity, valid, droppedCountedAsFailure: false };
      // v1 모양(ports K6Summary)
      m.k6 = { requests: 3000 + n * 30, throughputRps: 100 + n, httpFailures: 0, dropped: 0, latencyMs: { success: { p50: 1, p95: 2 + n, p99: 9, n: 3000 }, failed: { p50: null, p95: null, p99: null, n: 0 } } };
      m.ledgerVsClient = { ledger: { success: 500 } };
      store.metadata.set(m.runId, m);
      store.runs.push({ ...runRow, runId: m.runId, batchId: 'L', repetition: n, strategy: 'no-lock', appInstances: 1, model: 'closed', status: 'done' });
    };
    mkRun(1, true, 0);
    mkRun(2, true, 2);
    mkRun(3, false, 9); // 무효는 제외

    const r = await call(pub, 'GET', '/learn/g02-stock-decrement/measured');
    assert.equal(r.status, 200);
    assert.equal(r.json.scenario, 'g02-stock-decrement');
    // 다른 batch(fixture 의 closed vus 50 · 앱 2대)는 situation 과 안 맞아 빠진다
    assert.equal(r.json.cells.length, 1);
    const cell = r.json.cells[0];
    assert.equal(cell.strategy, 'no-lock');
    assert.equal(cell.situation, target.id);
    assert.deepEqual(cell.measured.runs, ['L_r1', 'L_r2']);
    assert.equal(cell.measured.run, 'L');
    assert.deepEqual(cell.measured.violations, { 'sold-equals-decrement': [0, 2] });
    assert.deepEqual(cell.measured.throughputRps, { median: 101.5, min: 101, max: 102 }); // v1 k6.throughputRps 그대로
    assert.deepEqual(cell.measured.p95Ms, { median: 3.5, min: 3, max: 4 });
    assert.match(cell.measured.summary, /위반 1\/2회 발생/);
    assert.match(cell.measured.summary, /무효 1회 제외/);

    assert.equal((await call(pub, 'GET', '/learn/nope/measured')).status, 404);
  });

  it('내부 /internal/run-config: 게시 전 204, 게시 후 200 과 가져간 인스턴스 기록', async () => {
    assert.equal((await call(int, 'GET', '/internal/run-config?instance=app-1')).status, 204);
    assert.deepEqual(board.fetchedBy(), []);
    assert.equal((await call(int, 'GET', '/internal/run-config')).status, 400);

    const cfg: RunConfigV1 = fx('run-config.v1.json');
    board.publish(cfg);
    const r = await call(int, 'GET', '/internal/run-config?instance=app-1');
    assert.equal(r.status, 200);
    assert.equal(r.json.runId, cfg.runId);
    await call(int, 'GET', '/internal/run-config?instance=app-2');
    assert.deepEqual(board.fetchedBy(), ['app-1', 'app-2']);
    assert.equal(board.current()?.runId, cfg.runId);

    board.clear();
    assert.equal((await call(int, 'GET', '/internal/run-config?instance=app-1')).status, 204);
    assert.equal(board.current(), null);
  });

  it('공개 리스너에는 /internal 라우트가 없다', async () => {
    assert.equal((await call(pub, 'GET', '/internal/run-config?instance=a')).status, 404);
  });
});

describe('learn measured 계산', () => {
  const mk = (batchId: string, reps: number, validity: boolean[], model = 'v1') => {
    const mds = [];
    for (let n = 1; n <= reps; n++) {
      const m = clone(md1);
      Object.assign(m, { runId: `${batchId}_r${n}`, batchId, repetition: n, strategy: { id: 'no-lock', params: {} } });
      m.topology.appInstances = 1;
      m.load = { ...m.load, model: 'closed', vus: 2, duration: '30s' };
      m.interventions = [];
      m.data.rows = { products: 5 };
      m.data.seedOptions = { products: 5, stockPerProduct: 100 };
      m.validity = { ...m.validity, valid: validity[n - 1] ?? true };
      m.k6 = model === 'v1' ? { requests: 3000, throughputRps: 100, httpFailures: 0, dropped: 0, latencyMs: { success: { p95: 3 } } } : { httpReqs: 3000, failed: 0, droppedIterations: 0, latencyMs: { p95: 3 } };
      mds.push(m);
    }
    return mds;
  };
  const situations = loadPackCatalog(repoDir).learnSituations('g02-stock-decrement')!;

  it('v1 k6 모양과 v0 k6 모양에서 같은 수치를 읽는다(v0 처리량 = httpReqs / duration)', () => {
    const a = runFacts(mk('a', 1, [], 'v1')[0]);
    const b = runFacts(mk('b', 1, [], 'v0')[0]);
    assert.equal(a.throughputRps, 100);
    assert.equal(b.throughputRps, 100); // 3000 / 30s
    assert.equal(a.p95Ms, 3);
    assert.equal(b.p95Ms, 3);
    assert.equal(a.failRatePct, 0);
  });

  it('실패율은 http 실패 + (counted 일 때) dropped 를 시도 수로 나눈다', () => {
    const m = mk('a', 1, [])[0];
    m.k6 = { requests: 900, throughputRps: 30, httpFailures: 50, dropped: 100, latencyMs: { success: { p95: 1 } } };
    m.validity.droppedCountedAsFailure = true;
    assert.equal(runFacts(m).failRatePct, 15); // (50+100)/(900+100)
    m.validity.droppedCountedAsFailure = false;
    assert.equal(runFacts(m).failRatePct, 5);
  });

  it('같은 셀에 batch 가 여럿이면 유효 반복이 가장 많은 것, 동률이면 최신', () => {
    const three = mk('three', 3, []);
    const tmpNewer = mk('tmp', 1, []); // 더 최신이지만 1회
    const cells = computeMeasuredCells(situations, [tmpNewer, three]);
    assert.equal(cells.length, 1);
    assert.equal(cells[0]!.measured.run, 'three');

    // 3회 중 2회가 무효면 유효 반복은 1 → 최신 1회 배치와 동률이라 최신이 이긴다
    const threeBad = mk('bad', 3, [true, false, false]);
    assert.equal(computeMeasuredCells(situations, [tmpNewer, threeBad])[0]!.measured.run, 'tmp');
    // 동률 3 vs 3 → 앞(최신)
    assert.equal(computeMeasuredCells(situations, [mk('new', 3, []), three])[0]!.measured.run, 'new');
  });
});
