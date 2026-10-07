// SqliteMetadataStore 테스트(임시 runs 디렉터리).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { RunRequestSchema } from '@under-load/contracts';
import type { RunRow } from '@under-load/contracts';

import { buildMetadata } from '../dist/metadata/index.js';
import { createMetadataStore } from '../dist/store/index.js';
import type { SqliteMetadataStore } from '../dist/store/index.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../engine/contracts/fixtures/${name}`, import.meta.url), 'utf8'));
const request = RunRequestSchema.parse(fixture('run-request.json'));

const row = (n: number, over: Partial<RunRow> = {}): RunRow => ({
  runId: `run-${n}`,
  batchId: 'b1',
  sessionId: 's1',
  repetition: n,
  scenario: 'g02',
  strategy: 'row-lock',
  appInstances: 2,
  model: 'closed',
  instrumentation: 'metrics',
  status: 'running',
  valid: null,
  invariantsPassed: null,
  violationsTotal: null,
  startedAt: `2026-10-07T09:00:0${n}.000Z`,
  endedAt: null,
  ...over,
});

describe('SqliteMetadataStore', () => {
  const roots: string[] = [];
  let runsDir: string;
  let store: SqliteMetadataStore;

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'lab-store-'));
    roots.push(runsDir);
    store = createMetadataStore({ runsDir });
  });
  afterEach(() => store.close());
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  it('DB 를 runs/_meta/lab.sqlite 에 만든다', () => {
    assert.ok(existsSync(join(runsDir, '_meta', 'lab.sqlite')));
  });

  it('세션: 생성·갱신·조회', async () => {
    await store.createSession({ sessionId: 's1', request, state: 'queued', startedAt: null, endedAt: null });
    await store.updateSession('s1', { state: 'running', startedAt: '2026-10-07T09:00:00.000Z' });
    const s = await store.getSession('s1');
    assert.equal(s?.state, 'running');
    assert.equal(s?.startedAt, '2026-10-07T09:00:00.000Z');
    assert.equal(s?.endedAt, null);
    assert.deepEqual(s?.request, request);
    assert.equal(await store.getSession('none'), null);
    await assert.rejects(store.updateSession('none', { state: 'done' }));
  });

  it('AC-1: 실행 insert → update → 조회', async () => {
    await store.insertRun(row(1));
    assert.deepEqual(await store.getRun('run-1'), row(1));
    await store.updateRun('run-1', { status: 'done', valid: true, invariantsPassed: false, violationsTotal: 3, endedAt: '2026-10-07T09:00:30.000Z' });
    const got = await store.getRun('run-1');
    assert.equal(got?.status, 'done');
    assert.equal(got?.valid, true);
    assert.equal(got?.invariantsPassed, false);
    assert.equal(got?.violationsTotal, 3);
    assert.equal(got?.endedAt, '2026-10-07T09:00:30.000Z');
    await store.updateRun('run-1', { valid: null });
    assert.equal((await store.getRun('run-1'))?.valid, null);
    assert.equal(await store.getRun('nope'), null);
    await assert.rejects(store.updateRun('nope', { status: 'failed' }));
  });

  it('AC-1: 목록 필터(scenario·strategy·batchId)', async () => {
    await store.insertRun(row(1));
    await store.insertRun(row(2, { strategy: 'no-lock' }));
    await store.insertRun(row(3, { scenario: 'g03', batchId: 'b2' }));
    assert.deepEqual((await store.listRuns()).items.map((r) => r.runId), ['run-3', 'run-2', 'run-1']);
    assert.deepEqual((await store.listRuns({ scenario: 'g02' })).items.map((r) => r.runId), ['run-2', 'run-1']);
    assert.deepEqual((await store.listRuns({ strategy: 'no-lock' })).items.map((r) => r.runId), ['run-2']);
    assert.deepEqual((await store.listRuns({ batchId: 'b2' })).items.map((r) => r.runId), ['run-3']);
    assert.deepEqual((await store.listRuns({ scenario: 'g02', strategy: 'row-lock', batchId: 'b1' })).items.map((r) => r.runId), ['run-1']);
  });

  it('AC-1: before 커서 페이지(같은 startedAt 은 runId 로 가른다)', async () => {
    for (let n = 1; n <= 5; n++) await store.insertRun(row(n, n >= 4 ? { startedAt: '2026-10-07T09:00:09.000Z' } : {}));
    const p1 = await store.listRuns({ limit: 2 });
    assert.deepEqual(p1.items.map((r) => r.runId), ['run-5', 'run-4']);
    assert.ok(p1.next);
    const p2 = await store.listRuns({ limit: 2, before: p1.next });
    assert.deepEqual(p2.items.map((r) => r.runId), ['run-3', 'run-2']);
    const p3 = await store.listRuns({ limit: 2, before: p2.next! });
    assert.deepEqual(p3.items.map((r) => r.runId), ['run-1']);
    assert.equal(p3.next, null);
    await assert.rejects(store.listRuns({ before: 'garbage' }));
  });

  it('단계는 기록 순서대로', async () => {
    await store.addStep('run-1', { name: 'app 정지', at: 'a' });
    await store.addStep('run-1', { name: 'k6 본 실행', at: 'b' });
    await store.addStep('run-2', { name: '다른 실행', at: 'c' });
    assert.deepEqual(await store.getSteps('run-1'), [
      { name: 'app 정지', at: 'a' },
      { name: 'k6 본 실행', at: 'b' },
    ]);
  });

  it('AC-2: saveMetadata 는 tmp+rename 으로 쓰고 getMetadata 로 읽힌다', async () => {
    await store.insertRun(row(1));
    const md = buildMetadata({ runId: 'run-1', batchId: 'b1', sessionId: 's1', repetition: 1, request, strategy: 'row-lock', appInstances: 2 });
    await store.saveMetadata('run-1', md);
    assert.deepEqual(readdirSync(join(runsDir, 'run-1')), ['metadata.json']);
    assert.deepEqual(await store.getMetadata('run-1'), md);
    // 덮어쓰기
    const md2 = { ...md, prediction: '바뀐 예측' };
    await store.saveMetadata('run-1', md2);
    assert.equal((await store.getMetadata('run-1'))?.prediction, '바뀐 예측');
    assert.deepEqual(readdirSync(join(runsDir, 'run-1')), ['metadata.json']);
    assert.equal(await store.getMetadata('run-9'), null);
    await assert.rejects(store.saveMetadata('run-9', md));
    await assert.rejects(store.getMetadata('../etc'));
  });

  it('AC-4: 0단계 metadata.json 으로 BatchSummary 를 만든다', async () => {
    const v0 = fixture('metadata.v0.json') as { runId: string; batchId: string; sessionId: string };
    await store.createBatch({ batchId: v0.batchId, sessionId: v0.sessionId, scenario: 'g02-stock-decrement', strategy: 'app-memory-lock', appInstances: 2, loadModel: 'open', reps: 3 });
    await store.insertRun(row(1, { runId: v0.runId, batchId: v0.batchId, sessionId: v0.sessionId, status: 'done' }));
    mkdirSync(join(runsDir, v0.runId));
    writeFileSync(join(runsDir, v0.runId, 'metadata.json'), JSON.stringify(v0));
    const summary = await store.getBatchSummary(v0.batchId);
    assert.deepEqual(summary?.runIds, [v0.runId]);
    assert.equal(summary?.reps, 3);
    assert.equal(summary?.validity.validReps, 1);
    assert.equal(summary?.throughputRps?.median, 4001 / 20);
    assert.deepEqual((await store.getSessionBatches(v0.sessionId)).map((b) => b.batchId), [v0.batchId]);
  });

  it('진행 중 배치는 결과가 있는 실행만 runIds 에 담는다', async () => {
    await store.createBatch({ batchId: 'b1', sessionId: 's1', scenario: 'g02', strategy: 'row-lock', appInstances: 2, loadModel: 'closed', reps: 3 });
    for (const n of [1, 2, 3]) await store.insertRun(row(n));
    assert.deepEqual((await store.getBatchSummary('b1'))?.runIds, []);
    await store.updateRun('run-1', { status: 'done' });
    await store.saveMetadata('run-1', buildMetadata({ runId: 'run-1', batchId: 'b1', sessionId: 's1', repetition: 1, request, strategy: 'row-lock', appInstances: 2 }));
    const s = await store.getBatchSummary('b1');
    assert.deepEqual(s?.runIds, ['run-1']);
    assert.equal(s?.failures.total.length, 1);
    assert.deepEqual((await store.getBatchRuns('b1')).map((r) => r.repetition), [1, 2, 3]);
    assert.equal(await store.getBatchSummary('none'), null);
  });
});
