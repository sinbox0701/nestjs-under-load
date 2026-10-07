// field-merge·edit-lease 단위 테스트(도커 없음): 레지스트리 파라미터, DB 시계 소스 스캔(AC-3), 학습·계측 마커.
// 끝의 PG 구간(AC-4: 다른 필드 동시 PATCH)은 접속 대상이 없으면 skip 한다(G01_TEST_DATABASE_URL).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PG_URL,
  createTestDatabase,
  makeCtx,
  makeStrategy,
  newToken,
  probePostgres,
  recordingSink,
  resolveStrategy,
  saveCmd,
} from './helpers.mjs';

const require = createRequire(import.meta.url);
const PACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { COMMON_PHASES, isPhase } = require('@under-load/contracts');
const src = (f) => readFileSync(path.join(PACK_DIR, 'strategies', f), 'utf8');

describe('레지스트리: field-merge·edit-lease', () => {
  it('id 가 클래스 id 와 같고, field-merge 는 patch·edit-lease 는 acquire/release 를 가진다', () => {
    const fm = new (resolveStrategy('field-merge', undefined).cls)();
    assert.equal(fm.id, 'field-merge');
    assert.equal(typeof fm.patch, 'function');
    const el = new (resolveStrategy('edit-lease', undefined).cls)();
    assert.equal(el.id, 'edit-lease');
    assert.equal(typeof el.acquire, 'function');
    assert.equal(typeof el.release, 'function');
  });

  it('edit-lease 파라미터: 기본값 ttlMs 30000 · retryAfterMs 1000, 잘못된 값·모르는 키는 부팅 실패', () => {
    assert.deepEqual(resolveStrategy('edit-lease', undefined).params, { ttlMs: 30000, retryAfterMs: 1000 });
    assert.deepEqual(resolveStrategy('edit-lease', { ttlMs: 500 }).params, { ttlMs: 500, retryAfterMs: 1000 });
    assert.throws(() => resolveStrategy('edit-lease', { ttlMs: 0 }), /파라미터 검증 실패/);
    assert.throws(() => resolveStrategy('edit-lease', { ttlMs: '30s' }), /파라미터 검증 실패/);
    assert.throws(() => resolveStrategy('edit-lease', { ttl: 1 }), /파라미터 검증 실패/);
    assert.throws(() => resolveStrategy('field-merge', { x: 1 }), /파라미터를 받지 않습니다/);
  });

  it('목록 밖 필드 이름은 DB 에 가기 전에 거절한다(필드 이름이 SQL 경로에 들어가므로)', async () => {
    const { strategy } = makeStrategy('field-merge');
    const ctx = { em: { transactional: () => assert.fail('DB 에 가면 안 된다') }, events: recordingSink() };
    await assert.rejects(
      strategy.patch({ requestId: 'r', documentId: 1, version: 1, field: "a}'; drop table x; --", value: [], editToken: 't' }, ctx),
      /알 수 없는 필드/,
    );
  });
});

describe('AC-3: lease 시각 계산은 DB 시계만(소스 스캔)', () => {
  const lease = src('edit-lease.strategy.ts');

  it('edit-lease 소스에 now()·new Date()·Date.now 가 없다(주석 포함)', () => {
    assert.doesNotMatch(lease, /\bnow\s*\(\s*\)/);
    assert.doesNotMatch(lease, /new\s+Date\s*\(/);
    assert.doesNotMatch(lease, /Date\.now/);
    assert.doesNotMatch(lease, /performance\.now/);
  });

  it('만료 계산·만료 판정·유효 판정·남은 시간이 모두 clock_timestamp()', () => {
    assert.match(lease, /clock_timestamp\(\) \+ \? \* interval '1 millisecond'/, 'acquire: lease_until = DB 시계 + TTL');
    assert.match(lease, /\$lte: raw\('clock_timestamp\(\)'\)/, 'acquire: 만료된 잠금 회수');
    assert.match(lease, /\$gt: raw\('clock_timestamp\(\)'\)/, 'save: lease 가 아직 유효');
    assert.match(lease, /lease_until - clock_timestamp\(\)/, '423: 남은 시간');
  });

  it('now 계열이 왜 틀린지 @learn 주석으로 설명한다', () => {
    const i = lease.indexOf('@learn db-clock');
    assert.ok(i > 0);
    const note = lease.slice(i, lease.indexOf('const rows', i));
    assert.match(note, /트랜잭션 시작 시각/);
    assert.match(note, /clock_timestamp\(\)/);
  });
});

describe('학습·계측 마커', () => {
  it('edit-lease 마커', () => {
    const s = src('edit-lease.strategy.ts');
    for (const m of [
      '@learn db-clock',
      '@learn acquire-autocommit',
      '@learn acquire-where',
      '@learn lease-until-db-clock',
      '@learn fence-increment',
      '@learn held-423',
      '@learn save-where-fence',
      '@learn reread-reason',
      '@learn release-fence',
      '@learn ledger-same-tx',
      '@event lock_acquired',
      '@event custom:lease_rejected',
      '@event lease_expired',
      '@event lock_released',
      '@event conflict',
      '@event committed rolled_back',
    ]) {
      assert.ok(s.includes(m), m);
    }
  });

  it('field-merge 마커', () => {
    const s = src('field-merge.strategy.ts');
    for (const m of [
      '@learn field-version-where',
      '@learn set-one-field',
      '@learn field-version-bump',
      '@learn same-field-409',
      '@learn put-bumps-all',
      '@learn ledger-same-tx',
      '@event db_write',
      '@event conflict',
      '@event committed rolled_back',
    ]) {
      assert.ok(s.includes(m), m);
    }
  });

  it('emit 하는 phase 는 모두 COMMON_PHASES 또는 custom:', () => {
    for (const f of ['edit-lease.strategy.ts', 'field-merge.strategy.ts']) {
      const phases = [...src(f).matchAll(/emit\('([^']+)'/g)].map((m) => m[1]);
      assert.ok(phases.length > 0);
      for (const p of phases) assert.ok(isPhase(p), `${f}: ${p}`);
    }
    assert.ok(!COMMON_PHASES.includes('lease_rejected'), '423 거절은 공통 phase 가 아니라 custom:lease_rejected');
  });

  it('committed 는 transactional 반환 뒤, rolled_back 은 catch 에서 낸다', () => {
    for (const f of ['edit-lease.strategy.ts', 'field-merge.strategy.ts']) {
      const s = src(f);
      let from = 0;
      for (;;) {
        const txEnd = s.indexOf('}); // @event committed rolled_back', from);
        if (txEnd < 0) break;
        const committed = s.indexOf("emit('committed'", txEnd);
        const catchAt = s.indexOf('} catch (err) {', txEnd);
        assert.ok(committed > txEnd && committed < catchAt, `${f}: committed`);
        assert.ok(s.indexOf("emit('rolled_back'", catchAt) > catchAt, `${f}: rolled_back`);
        from = catchAt + 1;
      }
      assert.ok(from > 0, `${f}: 트랜잭션 경계 표시가 있다`);
    }
  });
});

// ─────────────────────────────── 실제 PostgreSQL ───────────────────────────────
const probe = await probePostgres();
const skip = probe.ok ? false : `PostgreSQL 접속 불가(${new URL(PG_URL).host}): ${probe.reason}`;
if (skip) console.log(`[g01 field-merge pg] SKIP — ${skip}.`);

// eslint-disable-next-line no-control-regex
const cleanSql = (line) => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\[query\]\s*/, '').replace(/\s*\[took .*$/, '');

describe('G01 field-merge × 실제 PostgreSQL', { skip }, () => {
  let t;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  const { strategy } = makeStrategy('field-merge');
  /** 읽은 화면(seen)의 field 배열 뒤에 토큰을 붙여 PATCH 명령을 만든다(C10 편집 모델). */
  const patchCmd = (seen, field, token = newToken()) => ({
    requestId: crypto.randomUUID(),
    documentId: 1,
    version: seen.version,
    field,
    value: [...seen.fields[field], token],
    editToken: token,
  });
  const patch = (cmd, opts = {}) => strategy.patch(cmd, makeCtx(t.main.em, opts));
  const fieldVersions = async () => (await t.q('select field_versions from g01_document where id = 1'))[0].field_versions;

  it('AC-4: 같은 version 을 읽고 다른 필드를 동시에 PATCH 2건 → 둘 다 성공, lost update 0', async () => {
    await t.reset();
    const seen = await t.read();
    const delays = [{ point: 'after-read', ms: 50 }]; // 두 UPDATE 가 겹치게(뒤 UPDATE 는 행 락을 기다렸다 재평가)
    const res = await Promise.all([patch(patchCmd(seen, 'a'), { delays }), patch(patchCmd(seen, 'b'), { delays })]);
    assert.ok(res.every((r) => r.ok), JSON.stringify(res));
    assert.deepEqual(res.map((r) => r.version).sort(), [2, 3]);
    assert.equal(await t.lostUpdates(), 0);
    assert.equal((await t.ledger()).length, 2);
    const doc = await t.read();
    assert.equal(doc.fields.a.length, 1);
    assert.equal(doc.fields.b.length, 1);
    assert.equal(doc.editCount, 2);
    const fv = await fieldVersions();
    assert.deepEqual([fv.a, fv.b].sort(), [2, 3]);
    assert.equal(fv.c, 0);
  });

  it('같은 필드 동시 PATCH 2건 → 하나만 성공, 다른 하나는 version_mismatch(같은 필드 충돌만 409)', async () => {
    await t.reset();
    const seen = await t.read();
    const sinks = [recordingSink(), recordingSink()];
    const delays = [{ point: 'after-read', ms: 50 }];
    const res = await Promise.all(sinks.map((events) => patch(patchCmd(seen, 'a'), { events, delays })));
    assert.equal(res.filter((r) => r.ok).length, 1, JSON.stringify(res));
    assert.deepEqual(res.find((r) => !r.ok), { ok: false, reason: 'version_mismatch', currentVersion: 2 });
    const conflict = sinks.flatMap((s) => s.events).find((e) => e.phase === 'conflict');
    assert.deepEqual(conflict.attrs, {
      reason: 'version_mismatch',
      cause: 'same_field',
      field: 'a',
      sentVersion: 1,
      fieldVersion: 2,
      currentVersion: 2,
    });
    assert.equal(await t.lostUpdates(), 0);
    assert.equal((await t.ledger()).length, 1);
  });

  it('순차: 옛 version 으로 와도 다른 필드면 통과, 같은 필드면 409', async () => {
    await t.reset();
    const seen = await t.read(); // version 1
    assert.deepEqual(await patch(patchCmd(seen, 'a')), { ok: true, version: 2 });
    assert.deepEqual(await patch(patchCmd(seen, 'c')), { ok: true, version: 3 }, 'c 는 v1 이후 아무도 안 고쳤다');
    const events = recordingSink();
    assert.deepEqual(await patch(patchCmd(seen, 'a'), { events }), { ok: false, reason: 'version_mismatch', currentVersion: 3 });
    assert.deepEqual(events.events.map((e) => e.phase), ['arrived', 'db_write', 'rolled_back', 'conflict']);
    assert.equal(await t.lostUpdates(), 0);
  });

  it('성공 이벤트 순서와 실제 SQL: SET 은 그 필드만, WHERE 는 필드 버전 <= 본 버전', async () => {
    await t.reset();
    const events = recordingSink();
    await patch(patchCmd(await t.read(), 'b'), { events });
    assert.deepEqual(events.events.map((e) => e.phase), ['arrived', 'db_write', 'committed']);
    const [upd] = t.sql.map(cleanSql).filter((s) => s.startsWith('update "g01_document"'));
    assert.match(upd, /^update "g01_document" set "field_b" = /, upd);
    assert.doesNotMatch(upd, /"field_a"|"field_c"|"field_d"/, '다른 필드는 SET 에 없다');
    assert.match(upd, /"field_versions" = jsonb_set\(field_versions, '\{b\}'::text\[\], to_jsonb\(version \+ 1\)\)/, upd);
    assert.match(upd, /where "id" = 1 and \(field_versions ->> 'b'\)::int <= 1/, upd);
  });

  it('PUT 은 문서 version 전체로 검사하고 모든 필드 버전을 올린다 → 그 전 버전을 본 PATCH 는 409', async () => {
    await t.reset();
    const seen = await t.read();
    const put = await strategy.save(saveCmd(seen, { field: 'd' }), makeCtx(t.main.em));
    assert.deepEqual(put, { ok: true, version: 2 });
    assert.deepEqual(await fieldVersions(), { a: 2, b: 2, c: 2, d: 2 });
    assert.deepEqual(await patch(patchCmd(seen, 'a')), { ok: false, reason: 'version_mismatch', currentVersion: 2 });
    assert.deepEqual(await strategy.save(saveCmd(seen), makeCtx(t.main.em)), { ok: false, reason: 'version_mismatch', currentVersion: 2 });
    assert.equal(await t.lostUpdates(), 0);
  });
});
