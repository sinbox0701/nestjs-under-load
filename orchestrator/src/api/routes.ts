// C2 오케스트레이터 REST 라우트(공개 4000)와 `/internal/run-config`(내부 4001).
// WS(`/ws/runs/:runId`)·`/ingest/events`·`/metrics` 는 EventHub(T-112)가 등록한다.
// RunEngine·MetadataStore 등은 ports 로만 쓴다. 요청 검증은 contracts RunRequestSchema 그대로.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ARTIFACT_NAMES,
  AxisPathSchema,
  K6RenderRequestSchema,
  RunRequestSchema,
  type BatchSummary,
  type RunMetadata,
} from '@under-load/contracts';
import type { z } from 'zod';

import { compareBatches, orderBatchSummary } from '../compare/index.js';
import { HttpError, type Routers } from '../http/index.js';
import { computeMeasuredCells } from '../learn/index.js';
import type { K6Runner, MetadataStore, RunConfigBoard, RunEngine } from '../ports.js';
import type { PackCatalog } from './catalog.js';

export interface ApiDeps {
  readonly engine: RunEngine;
  readonly store: MetadataStore;
  readonly catalog: PackCatalog;
  readonly board: RunConfigBoard;
  readonly k6: K6Runner;
  /** `runs/<runId>/<artifact>` 의 상위 폴더 */
  readonly runsDir: string;
  readonly version: string;
  readonly gitSha: string;
}

const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json; charset=utf-8',
  html: 'text/html; charset=utf-8',
  ndjson: 'application/x-ndjson; charset=utf-8',
};

const MAX_LEARN_RUN_PAGES = 25;
const MAX_COMPARE_BATCHES = 10;

/** zod 이슈 → `{path, message}`. 경로는 점 표기(`load.vus`, `strategies.0`), 최상위는 빈 문자열. */
export const toErrors = (issues: readonly z.core.$ZodIssue[]) => issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));

const bad = (path: string, message: string) => new HttpError(400, { errors: [{ path, message }] });

export function registerApiRoutes(routers: Routers, deps: ApiDeps): void {
  const { engine, store, catalog, board, k6 } = deps;
  const pub = routers.public;

  pub.add('GET', '/health', (ctx) => ctx.json(200, { ok: true, version: deps.version, gitSha: deps.gitSha }));

  pub.add('GET', '/scenarios', (ctx) => ctx.json(200, catalog.infos()));

  pub.add('POST', '/k6/render', async (ctx) => {
    const parsed = K6RenderRequestSchema.safeParse(await ctx.readJson());
    if (!parsed.success) throw new HttpError(400, { errors: toErrors(parsed.error.issues) });
    const { request, strategy } = parsed.data;
    const scenario = catalog.get(request.scenario);
    if (!scenario) throw bad('request.scenario', `알 수 없는 시나리오: ${request.scenario}`);
    if (!request.strategies.includes(strategy)) throw bad('strategy', 'request.strategies 에 없는 strategy');
    const env = k6.buildEnv({ scenario, request, runId: 'preview', phase: 'main', strategy, summaryPath: '/runs/preview/summary.json' });
    ctx.json(200, { templatePath: scenario.k6Script, env, scriptHash: await k6.scriptHash(scenario, env) });
  });

  pub.add('POST', '/runs', async (ctx) => {
    const parsed = RunRequestSchema.safeParse(await ctx.readJson());
    if (!parsed.success) throw new HttpError(400, { errors: toErrors(parsed.error.issues) });
    if (!catalog.get(parsed.data.scenario)) throw bad('scenario', `알 수 없는 시나리오: ${parsed.data.scenario}`);
    const result = await engine.start(parsed.data);
    if (result.kind === 'accepted') return ctx.json(202, result.accepted);
    if (result.kind === 'busy') return ctx.json(409, { reason: 'busy', sessionId: result.sessionId });
    ctx.json(400, { errors: result.errors });
  });

  pub.add('GET', '/sessions/:id', async (ctx) => {
    const s = await engine.status(ctx.params.id!);
    if (!s) throw new HttpError(404, { error: 'not found' });
    ctx.json(200, s);
  });

  pub.add('GET', '/runs', async (ctx) => {
    const q = ctx.query;
    let limit: number | undefined;
    if (q.has('limit')) {
      limit = Number(q.get('limit'));
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('limit', 'limit 은 1..200 의 정수');
    }
    ctx.json(
      200,
      await store.listRuns({
        ...(q.get('scenario') ? { scenario: q.get('scenario')! } : {}),
        ...(q.get('strategy') ? { strategy: q.get('strategy')! } : {}),
        ...(q.get('batchId') ? { batchId: q.get('batchId')! } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(q.get('before') ? { before: q.get('before')! } : {}),
      }),
    );
  });

  pub.add('GET', '/runs/:id', async (ctx) => {
    const runId = ctx.params.id!;
    const row = await store.getRun(runId);
    if (!row) throw new HttpError(404, { error: 'not found' });
    ctx.json(200, { row, metadata: await store.getMetadata(runId), steps: await store.getSteps(runId) });
  });

  pub.add('GET', '/runs/:id/artifacts/:name', async (ctx) => {
    const { id, name } = ctx.params as { id: string; name: string };
    if (!(ARTIFACT_NAMES as readonly string[]).includes(name)) throw new HttpError(404, { error: 'unknown artifact' });
    // 저장소가 아는 실행만 허용한다(경로 조작 방지).
    if (!(await store.getRun(id))) throw new HttpError(404, { error: 'not found' });
    let data: Buffer;
    try {
      data = await readFile(path.join(deps.runsDir, id, name));
    } catch {
      throw new HttpError(404, { error: 'artifact not found' });
    }
    ctx.send(200, data, CONTENT_TYPES[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream');
  });

  pub.add('GET', '/batches/:id', async (ctx) => {
    const b = await store.getBatchSummary(ctx.params.id!);
    if (!b) throw new HttpError(404, { error: 'not found' });
    ctx.json(200, orderBatchSummary(b));
  });

  pub.add('POST', '/runs/:id/abort', async (ctx) => {
    if (!(await engine.abort(ctx.params.id!))) throw new HttpError(404, { error: 'not found' });
    ctx.empty(202);
  });

  // 카오스는 3단계.
  pub.add('POST', '/runs/:id/chaos', (ctx) => ctx.json(501, { error: 'not implemented', stage: 3 }));

  pub.add('GET', '/compare', async (ctx) => {
    const ids = (ctx.query.get('batches') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length < 2 || ids.length > MAX_COMPARE_BATCHES) throw bad('batches', `batches 는 2..${MAX_COMPARE_BATCHES}개의 배치 id(쉼표 구분)`);
    let axis = null;
    if (ctx.query.has('axis')) {
      const a = AxisPathSchema.safeParse(ctx.query.get('axis'));
      if (!a.success) throw bad('axis', 'axis 는 topology.appInstances | instrumentation | pgProbe.enabled | interventions');
      axis = a.data;
    }
    const batches: BatchSummary[] = [];
    const metadata: RunMetadata[] = [];
    for (const id of ids) {
      const b = await store.getBatchSummary(id);
      if (!b) throw new HttpError(404, { error: 'not found', batchId: id });
      // 배치의 비교 조건은 첫 실행 메타데이터로 대표한다(같은 배치 안 조건은 같다).
      let md: RunMetadata | null = null;
      for (const runId of b.runIds) if ((md = await store.getMetadata(runId))) break;
      if (!md) throw new HttpError(422, { error: 'no metadata', batchId: id });
      batches.push(b);
      metadata.push(md);
    }
    ctx.json(200, compareBatches(batches, metadata, axis));
  });

  pub.add('GET', '/learn/:scenario/measured', async (ctx) => {
    const scenario = ctx.params.scenario!;
    if (!catalog.get(scenario)) throw new HttpError(404, { error: 'not found' });
    const situations = catalog.learnSituations(scenario);
    if (!situations) return ctx.json(200, { scenario, cells: [] });

    // 최신 실행부터 읽어 batch 별로 묶는다(done 만). 메타데이터는 batch 가 정해진 뒤 읽는다.
    const byBatch = new Map<string, string[]>();
    let before: string | undefined;
    for (let page = 0; page < MAX_LEARN_RUN_PAGES; page++) {
      const { items, next } = await store.listRuns({ scenario, limit: 200, ...(before ? { before } : {}) });
      for (const r of items) if (r.status === 'done') byBatch.set(r.batchId, [...(byBatch.get(r.batchId) ?? []), r.runId]);
      if (!next) break;
      before = next;
    }
    const batches: RunMetadata[][] = [];
    for (const runIds of byBatch.values()) {
      const mds: RunMetadata[] = [];
      for (const runId of runIds) {
        const md = await store.getMetadata(runId);
        if (md) mds.push(md);
      }
      batches.push(mds);
    }
    ctx.json(200, { scenario, cells: computeMeasuredCells(situations, batches) });
  });

  // ── 내부 포트: app 이 부팅할 때 가져가는 RunConfig(C1) ──
  routers.internal.add('GET', '/internal/run-config', (ctx) => {
    const instance = ctx.query.get('instance');
    if (!instance) throw bad('instance', 'instance 쿼리가 필요하다');
    const config = board.get(instance);
    if (!config) return ctx.empty(204);
    ctx.json(200, config);
  });
}
