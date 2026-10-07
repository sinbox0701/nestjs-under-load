// invariants.sql 구간이 모두 `violations` 1열 1행인지(AC-3), 위반을 실제로 잡는지 확인한다. PG 없으면 skip.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PG_URL, createTestDatabase, makeCtx, makeStrategy, probePostgres, saveCmd } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { seedG01 } = require('../dist/seed/index.js');
const PACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const probe = await probePostgres();
const skip = probe.ok ? false : `PostgreSQL 접속 불가(${new URL(PG_URL).host}): ${probe.reason}`;
if (skip) console.log(`[g01 invariants pg] SKIP — ${skip}.`);

/** invariants.sql → { name: sql } (scripts/run.mjs parseInvariantsSql와 같은 규약) */
function loadInvariants() {
  const out = {};
  let cur = null;
  for (const line of readFileSync(path.join(PACK_DIR, 'invariants.sql'), 'utf8').split('\n')) {
    const m = /^--\s*name:\s*([a-z0-9_]+)\s*$/.exec(line);
    if (m) {
      cur = m[1];
      out[cur] = [];
    } else if (cur) out[cur].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]));
}

describe('invariants.sql 구조(DB 불필요)', () => {
  it('C10 불변식 5개가 규약 이름으로 있다', () => {
    assert.deepEqual(Object.keys(loadInvariants()), [
      'no_lost_update',
      'edit_count_matches_ledger',
      'revision_matches_ledger',
      'no_duplicate_request_id',
      'ledger_counts',
    ]);
  });
});

describe('G01 invariants.sql × 실제 PostgreSQL', { skip }, () => {
  let t;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  async function run() {
    const out = {};
    for (const [name, sql] of Object.entries(loadInvariants())) out[name] = await t.main.em.fork().execute(sql);
    return out;
  }
  const violations = (res) => Object.fromEntries(Object.entries(res).filter(([k]) => k !== 'ledger_counts').map(([k, v]) => [k, v[0].violations]));

  it('AC-3 각 구간이 violations 1열 1행(ledger_counts는 info 열)', async () => {
    await t.reset();
    const res = await run();
    for (const [name, rows] of Object.entries(res)) {
      assert.equal(rows.length, 1, `${name}: 행 ${rows.length}`);
      if (name === 'ledger_counts') assert.deepEqual(Object.keys(rows[0]), ['success', 'total']);
      else assert.deepEqual(Object.keys(rows[0]), ['violations'], name);
    }
    assert.deepEqual(violations(res), { no_lost_update: 0, edit_count_matches_ledger: 0, revision_matches_ledger: 0, no_duplicate_request_id: 0 });
  });

  it('optimistic-version 정상 저장 뒤에도 전부 0, ledger_counts는 success 1', async () => {
    await t.reset();
    const seen = await t.read();
    const { strategy } = makeStrategy('optimistic-version');
    await strategy.save(saveCmd(seen), makeCtx(t.main.em));
    const res = await run();
    assert.deepEqual(violations(res), { no_lost_update: 0, edit_count_matches_ledger: 0, revision_matches_ledger: 0, no_duplicate_request_id: 0 });
    assert.deepEqual(res.ledger_counts[0], { success: 1, total: 1 });
  });

  it('naive 덮어쓰기는 no_lost_update 1, 원장 없는 변경은 edit_count·revision 위반으로 잡힌다', async () => {
    await t.reset();
    const seen = await t.read();
    const { strategy } = makeStrategy('naive-overwrite');
    await strategy.save(saveCmd(seen), makeCtx(t.main.em));
    await strategy.save(saveCmd(seen), makeCtx(t.main.em));
    assert.equal(violations(await run()).no_lost_update, 1);

    await t.reset();
    await t.q('update g01_document set edit_count = 3 where id = 1');
    await t.q(`insert into g01_edit_ledger (request_id, document_id, edit_token, result, instance) values (?, 1, 'zzzzzzzzzzzz', 'success', 'app-1')`, [randomUUID()]);
    const v = violations(await run());
    assert.equal(v.edit_count_matches_ledger, 1, '문서 edit_count 3 ≠ 원장 1');
    assert.equal(v.revision_matches_ledger, 1, '이력 0 ≠ 원장 1');
    assert.equal(v.no_lost_update, 1, '원장 토큰이 문서에 없다');
  });
});

describe('G01 seed × 실제 PostgreSQL', { skip }, () => {
  let t;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  it('documents=100 → id 1..100, 빈 필드·version 1, 다시 돌려도 같다(결정적·멱등)', async () => {
    await t.q('delete from g01_document');
    await seedG01(t.main.em.fork(), { documents: 100 });
    await seedG01(t.main.em.fork(), { documents: 100 });
    const [r] = await t.q('select count(*)::int n, min(id) lo, max(id) hi, (count(*) filter (where version = 1 and edit_count = 0 and cardinality(field_a) = 0 and fence = 0 and locked_by is null))::int ok from g01_document');
    assert.deepEqual({ ...r }, { n: 100, lo: 1, hi: 100, ok: 100 });
  });

  it('범위 밖 documents는 거절', async () => {
    await assert.rejects(seedG01(t.main.em.fork(), { documents: 0 }), /1~100/);
    await assert.rejects(seedG01(t.main.em.fork(), { documents: 101 }), /1~100/);
  });
});

describe('G01 컨트롤러 × 실제 PostgreSQL', { skip }, () => {
  let t;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  it('AC-2 같은 version으로 두 번 PUT → 두 번째 409에 currentVersion·current(실제 DB 재조회)', async () => {
    await t.reset();
    const { G01Controller } = require('../dist/api/g01.controller.js');
    const { resolveStrategy } = require('../dist/strategy-registry.js');
    const { cls } = resolveStrategy('optimistic-version', undefined);
    const c = new G01Controller(t.main.em, new cls(), {}, { instance: 'app-1', contentionWindow: async () => {} });
    const res = () => ({ code: undefined, status(n) { this.code = n; }, setHeader() {} });
    const body = (token) => ({ version: 1, fields: { a: [token], b: [], c: [], d: [] }, editToken: token });

    const r1 = res();
    assert.deepEqual(await c.put(1, randomUUID(), body('aaaaaaaaaaaa'), r1), { version: 2 });
    const r2 = res();
    const out = await c.put(1, randomUUID(), body('bbbbbbbbbbbb'), r2);
    assert.equal(r2.code, 409);
    assert.equal(out.reason, 'version_mismatch');
    assert.equal(out.currentVersion, 2);
    assert.deepEqual(out.current.fields.a, ['aaaaaaaaaaaa']);
    assert.equal(out.current.editCount, 1);
    assert.equal(out.current.lease, null);
    assert.deepEqual(await c.get(1), out.current);
    await assert.rejects(c.get(999), { status: 404 });
    await assert.rejects(c.put(999, randomUUID(), body('cccccccccccc'), res()), { status: 404 });
  });
});
