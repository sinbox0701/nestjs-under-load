// 실제 PostgreSQL 통합 테스트: 동시 요청을 보내고 invariants.sql로 판정한다.
// 도커(compose postgres, 127.0.0.1:55432)가 꺼져 있으면 skip 하고 그 사실을 출력한다.
// 다른 DB를 쓰려면 G02_TEST_DATABASE_URL=postgresql://user:pass@host:port/db (CREATE DATABASE 권한 필요).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { PG_URL, cmd, createTestDatabase, makeCtx, makeStrategy, probePostgres } from './helpers.mjs';

const probe = await probePostgres();
const skip = probe.ok ? false : `PostgreSQL 접속 불가(${new URL(PG_URL).host}): ${probe.reason}`;
if (skip) console.log(`[g02 pg] SKIP — ${skip}. 도커를 켜고 다시 실행하면 통합 테스트가 돈다.`);

const CRITICAL = ['no_oversell', 'no_negative_stock', 'sold_equals_decrement', 'no_duplicate_request_id'];
const totalViolations = (inv) => CRITICAL.reduce((a, k) => a + inv[k].violations, 0);

/** 같은 상품에 n건을 동시에 보낸다. instances 개수만큼 strategy 객체·ORM(커넥션 풀)을 나눠 쓴다(= 앱 인스턴스 흉내). */
async function burst(apps, n, { params, delays = [] } = {}) {
  return Promise.allSettled(
    Array.from({ length: n }, (_, i) => {
      const app = apps[i % apps.length];
      return app.strategy.execute(cmd(1, 1), makeCtx(app.orm.em, { params: params ?? app.params, instance: app.name, delays }));
    }),
  );
}

describe('G02 strategies × 실제 PostgreSQL', { skip }, () => {
  let t;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  const one = (id) => {
    const { strategy, params } = makeStrategy(id);
    return [{ name: 'app-1', orm: t.main, strategy, params }];
  };

  it('no-lock · 서버 1대 · 동시 20건(경합 창 30ms): 불변식 위반 발생', async () => {
    await t.reset(10);
    const res = await burst(one('no-lock'), 20, { delays: [{ point: 'after-read', ms: 30 }] });
    assert.equal(res.filter((r) => r.status === 'rejected').length, 0);
    const inv = await t.invariants();
    assert.ok(inv.sold_equals_decrement.violations > 0, JSON.stringify(inv));
    assert.ok(inv.no_oversell.violations > 0, '재고 10개에 20건이 모두 같은 값을 읽었으므로 초과 판매');
  });

  for (const id of ['row-lock', 'conditional-update', 'app-memory-lock']) {
    it(`${id} · 서버 1대 · 동시 30건(재고 10): 성공 10 · 품절 20 · 위반 0`, async () => {
      await t.reset(10);
      const res = await burst(one(id), 30, {
        params: id === 'row-lock' ? { lockTimeoutMs: 5000 } : undefined,
        delays: [{ point: 'after-read', ms: 5 }, { point: 'after-lock', ms: 5 }],
      });
      const values = res.map((r) => (r.status === 'fulfilled' ? r.value : `rejected:${r.reason?.message}`));
      assert.equal(values.filter((v) => v === 'success').length, 10, JSON.stringify(values));
      assert.equal(values.filter((v) => v === 'sold_out').length, 20);
      assert.equal(await t.stock(), 0);
      const inv = await t.invariants();
      assert.equal(totalViolations(inv), 0, JSON.stringify(inv));
      assert.deepEqual(inv.ledger_counts, { success: 10, sold_out: 20, total: 30 });
    });
  }

  it('app-memory-lock · 서버 2대 흉내(ORM·mutex 2벌) · 동시 20건: 불변식 위반 발생', async () => {
    await t.reset(10);
    const second = await t.open();
    const apps = [
      { name: 'app-1', orm: t.main, strategy: makeStrategy('app-memory-lock').strategy, params: {} },
      { name: 'app-2', orm: second, strategy: makeStrategy('app-memory-lock').strategy, params: {} },
    ];
    await burst(apps, 20, { delays: [{ point: 'after-read', ms: 30 }] });
    const inv = await t.invariants();
    assert.ok(inv.sold_equals_decrement.violations > 0, JSON.stringify(inv));
  });

  it('row-lock · lock_timeout 50ms · 락 보유 300ms: 한쪽이 55P03 → 503, 원장·재고에 흔적 없음', async () => {
    await t.reset(10);
    const res = await burst(one('row-lock'), 2, {
      params: { lockTimeoutMs: 50 },
      delays: [{ point: 'after-lock', ms: 300 }],
    });
    const rejected = res.filter((r) => r.status === 'rejected');
    assert.equal(rejected.length, 1, JSON.stringify(res));
    assert.equal(rejected[0].reason.getStatus?.(), 503);
    const inv = await t.invariants();
    assert.equal(totalViolations(inv), 0);
    assert.deepEqual(inv.ledger_counts, { success: 1, sold_out: 0, total: 1 });
    assert.equal(await t.stock(), 9);
  });

  it('SET LOCAL은 커밋 뒤 커넥션에 남지 않는다', async () => {
    await t.reset(10);
    const orm = await t.open(1); // 커넥션 1개짜리 풀: 같은 커넥션을 다시 쓰게 한다
    const [before] = await orm.em.fork().execute('show lock_timeout');
    const { strategy } = makeStrategy('row-lock');
    await strategy.execute(cmd(), makeCtx(orm.em, { params: { lockTimeoutMs: 1234 } }));
    const [afterTx] = await orm.em.fork().execute('show lock_timeout');
    assert.notEqual(afterTx.lock_timeout, '1234ms');
    assert.equal(afterTx.lock_timeout, before.lock_timeout);
  });
});
