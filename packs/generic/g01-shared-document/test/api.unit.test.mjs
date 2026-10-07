// 컨트롤러 단위 테스트(DB 불필요): C10 응답 계약 428·409·423, 미지원 연산 4xx, 모듈·팩 형태.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { G01Controller } = require('../dist/api/g01.controller.js');
const { G01Module } = require('../dist/module.js');
const { scenarioPack } = require('../dist/index.js');
const { G01_STRATEGIES } = require('../dist/strategy-registry.js');
const { NOOP_EVENT_SINK } = require('@under-load/contracts');

const TOKEN = 'abcdefghijkl';
const FIELDS = { a: [TOKEN], b: [], c: [], d: [] };

const row = (over = {}) => ({
  id: 1,
  version: 7,
  field_a: ['x'],
  field_b: [],
  field_c: [],
  field_d: [],
  field_versions: { a: 7, b: 0, c: 0, d: 0 },
  edit_count: 6,
  locked_by: null,
  lease_until: null,
  fence: '0',
  lease_active: false,
  ...over,
});

function makeController(strategy, { rows = [row()], events } = {}) {
  const seen = { ctx: undefined, queries: [] };
  const em = {
    fork: () => ({
      async execute(sql, params) {
        seen.queries.push({ sql, params });
        return rows;
      },
    }),
  };
  const wrapped = {};
  for (const k of ['id', 'save', 'patch', 'acquire', 'release']) {
    if (!strategy[k]) continue;
    wrapped[k] = typeof strategy[k] === 'function' ? (cmd, ctx) => { seen.ctx = ctx; seen.cmd = cmd; return strategy[k](cmd, ctx); } : strategy[k];
  }
  const runtime = { instance: 'app-1', contentionWindow: async () => {} };
  return { c: new G01Controller(em, wrapped, {}, runtime, events), seen };
}

function makeRes() {
  const res = { code: undefined, headers: {}, status(n) { res.code = n; }, setHeader(k, v) { res.headers[k] = v; } };
  return res;
}

const putBody = (over = {}) => ({ version: 7, fields: FIELDS, editToken: TOKEN, ...over });

describe('PUT /g01/documents/:id', () => {
  it('AC-1 version이 없으면 428 version_required (strategy 호출 없음)', async () => {
    let called = false;
    const { c } = makeController({ id: 'x', save: async () => { called = true; return { ok: true, version: 1 }; } });
    for (const body of [{ fields: FIELDS, editToken: TOKEN }, { version: null, fields: FIELDS, editToken: TOKEN }]) {
      const res = makeRes();
      assert.deepEqual(await c.put(1, randomUUID(), body, res), { reason: 'version_required' });
      assert.equal(res.code, 428);
    }
    assert.equal(called, false);
  });

  it('성공은 200 {version}, strategy에는 number version·NOOP 이벤트 싱크가 간다(숫자 문자열은 변환)', async () => {
    const { c, seen } = makeController({ id: 'x', save: async () => ({ ok: true, version: 8 }) });
    const res = makeRes();
    const out = await c.put(1, randomUUID(), putBody({ version: '7' }), res);
    assert.deepEqual(out, { version: 8 });
    assert.equal(res.code, undefined);
    assert.strictEqual(seen.cmd.version, 7);
    assert.equal(seen.cmd.documentId, 1);
    assert.strictEqual(seen.ctx.events, NOOP_EVENT_SINK);
    assert.equal(seen.ctx.instance, 'app-1');
  });

  it('AC-2 version_mismatch는 409 + currentVersion + current(컨트롤러 재조회)', async () => {
    const { c, seen } = makeController({ id: 'x', save: async () => ({ ok: false, reason: 'version_mismatch', currentVersion: 7 }) });
    const res = makeRes();
    const out = await c.put(1, randomUUID(), putBody({ version: 3 }), res);
    assert.equal(res.code, 409);
    assert.equal(out.reason, 'version_mismatch');
    assert.equal(out.currentVersion, 7);
    assert.equal(out.current.version, 7);
    assert.deepEqual(out.current.fields, { a: ['x'], b: [], c: [], d: [] });
    assert.equal(out.current.lease, null);
    assert.equal(seen.queries.length, 1);
  });

  it('lease_lost·lease_expired는 409 {reason}', async () => {
    for (const reason of ['lease_lost', 'lease_expired']) {
      const { c } = makeController({ id: 'x', save: async () => ({ ok: false, reason }) });
      const res = makeRes();
      assert.deepEqual(await c.put(1, randomUUID(), putBody({ lease: { holder: 'h', fence: 4 } }), res), { reason });
      assert.equal(res.code, 409);
    }
  });

  it('lease는 strategy에 문자열 fence로 간다', async () => {
    const { c, seen } = makeController({ id: 'x', save: async () => ({ ok: true, version: 8 }) });
    await c.put(1, randomUUID(), putBody({ lease: { holder: 'h', fence: 4 } }), makeRes());
    assert.deepEqual(seen.cmd.lease, { holder: 'h', fence: '4' });
  });

  it('잘못된 요청은 400(request id 없음, 토큰 길이, 알 수 없는 키, 본문이 객체 아님)', async () => {
    const { c } = makeController({ id: 'x', save: async () => ({ ok: true, version: 8 }) });
    await assert.rejects(c.put(1, undefined, putBody(), makeRes()), { status: 400 });
    await assert.rejects(c.put(1, randomUUID(), putBody({ editToken: 'short' }), makeRes()), { status: 400 });
    await assert.rejects(c.put(1, randomUUID(), putBody({ extra: 1 }), makeRes()), { status: 400 });
    await assert.rejects(c.put(1, randomUUID(), putBody({ version: 'abc' }), makeRes()), { status: 400 });
    await assert.rejects(c.put(1, randomUUID(), 'x', makeRes()), { status: 400 });
  });

  it('없는 문서(NotFoundError)는 404', async () => {
    const { NotFoundError } = require('@mikro-orm/core');
    const { c } = makeController({ id: 'x', save: async () => { throw new NotFoundError('nope'); } });
    await assert.rejects(c.put(9, randomUUID(), putBody(), makeRes()), { status: 404 });
  });
});

describe('GET /g01/documents/:id', () => {
  it('C10 모양: fields·fieldVersions·editCount·lease(null)', async () => {
    const { c } = makeController({ id: 'x', save: async () => ({ ok: true, version: 1 }) });
    const out = await c.get(1);
    assert.deepEqual(out, {
      id: 1,
      version: 7,
      fields: { a: ['x'], b: [], c: [], d: [] },
      fieldVersions: { a: 7, b: 0, c: 0, d: 0 },
      editCount: 6,
      lease: null,
    });
  });

  it('유효한 lease는 {lockedBy, leaseUntil, fence}로 내보낸다', async () => {
    const until = new Date();
    const { c } = makeController({ id: 'x', save: async () => ({ ok: true, version: 1 }) }, { rows: [row({ lease_active: true, locked_by: 'h1', lease_until: until, fence: '3' })] });
    assert.deepEqual((await c.get(1)).lease, { lockedBy: 'h1', leaseUntil: until, fence: '3' });
  });

  it('없는 문서는 404', async () => {
    const { c } = makeController({ id: 'x', save: async () => ({ ok: true, version: 1 }) }, { rows: [] });
    await assert.rejects(c.get(1), { status: 404 });
  });
});

describe('strategy가 지원하지 않는 연산', () => {
  const plain = { id: 'optimistic-version', save: async () => ({ ok: true, version: 1 }) };

  it('PATCH·lease acquire/release는 405 not_supported', async () => {
    const { c } = makeController(plain);
    const res = makeRes();
    await assert.rejects(c.patch(1, randomUUID(), { version: 1, field: 'a', value: [], editToken: TOKEN }, res), (e) => e.status === 405 && e.getResponse().reason === 'not_supported');
    await assert.rejects(c.acquire(1, { holder: 'h' }, res), { status: 405 });
    await assert.rejects(c.release(1, { holder: 'h', fence: '1' }), { status: 405 });
  });
});

describe('PATCH (field-merge가 지원할 때)', () => {
  const merge = (outcome) => ({ id: 'field-merge', save: async () => outcome, patch: async () => outcome });

  it('성공 200 {version}, version 누락 428', async () => {
    const { c, seen } = makeController(merge({ ok: true, version: 9 }));
    const res = makeRes();
    assert.deepEqual(await c.patch(1, randomUUID(), { version: 8, field: 'b', value: ['y'], editToken: TOKEN }, res), { version: 9 });
    assert.equal(seen.cmd.field, 'b');
    const res2 = makeRes();
    assert.deepEqual(await c.patch(1, randomUUID(), { field: 'b', value: [], editToken: TOKEN }, res2), { reason: 'version_required' });
    assert.equal(res2.code, 428);
  });

  it('충돌은 409', async () => {
    const { c } = makeController(merge({ ok: false, reason: 'version_mismatch', currentVersion: 7 }));
    const res = makeRes();
    const out = await c.patch(1, randomUUID(), { version: 1, field: 'b', value: [], editToken: TOKEN }, res);
    assert.equal(res.code, 409);
    assert.equal(out.currentVersion, 7);
  });
});

describe('lease (edit-lease가 지원할 때)', () => {
  const until = new Date();

  it('acquire 성공은 200 {fence, leaseUntil}', async () => {
    const { c, seen } = makeController({ id: 'edit-lease', save: async () => ({ ok: true, version: 1 }), acquire: async () => ({ ok: true, fence: '5', leaseUntil: until }), release: async () => {} });
    const res = makeRes();
    assert.deepEqual(await c.acquire(1, { holder: 'h1' }, res), { fence: '5', leaseUntil: until });
    assert.equal(res.code, undefined);
    assert.deepEqual(seen.cmd, { documentId: 1, holder: 'h1' });
  });

  it('acquire 거절은 423 {reason:locked, lockedBy} + Retry-After(초, 올림·최소 1)', async () => {
    for (const [ms, header] of [[1500, '2'], [20, '1']]) {
      const { c } = makeController({ id: 'edit-lease', save: async () => ({ ok: true, version: 1 }), acquire: async () => ({ ok: false, reason: 'locked', lockedBy: 'h2', retryAfterMs: ms }) });
      const res = makeRes();
      const out = await c.acquire(1, { holder: 'h1' }, res);
      assert.equal(res.code, 423);
      assert.equal(res.headers['Retry-After'], header);
      assert.deepEqual(out, { reason: 'locked', lockedBy: 'h2', retryAfterMs: ms });
    }
  });

  it('release는 holder·fence를 넘기고 본문 없이 끝난다', async () => {
    const { c, seen } = makeController({ id: 'edit-lease', save: async () => ({ ok: true, version: 1 }), release: async () => {} });
    assert.equal(await c.release(1, { holder: 'h1', fence: '5' }), undefined);
    assert.deepEqual(seen.cmd, { documentId: 1, holder: 'h1', fence: '5' });
    await assert.rejects(c.release(1, { holder: 'h1' }), { status: 400 });
  });
});

describe('모듈·팩', () => {
  it('G01Module.register는 strategy 하나만 provider로 등록하고 모르는 id는 부팅 실패', () => {
    const mod = G01Module.register({ strategy: 'optimistic-version', instance: 'app-1' });
    assert.equal(mod.controllers.length, 1);
    assert.equal(mod.providers.filter((p) => typeof p === 'object' && 'useClass' in p).length, 1);
    assert.throws(() => G01Module.register({ strategy: 'nope', instance: 'app-1' }), /알 수 없는 strategy/);
    assert.throws(() => G01Module.register({ strategy: 'naive-overwrite', strategyParams: { a: 1 }, instance: 'app-1' }), /파라미터/);
  });

  it('scenarioPack 형태', () => {
    assert.equal(scenarioPack.id, 'g01-shared-document');
    assert.equal(scenarioPack.entities.length, 3);
    assert.equal(scenarioPack.migrations[0].name, 'Migration20261007000100_g01_init');
    assert.deepEqual(scenarioPack.strategyIds, Object.keys(G01_STRATEGIES), '레지스트리와 같은 목록·순서');
    assert.equal(scenarioPack.createModule({ strategy: 'naive-overwrite', instance: 'a' }).module, G01Module);
  });
});
