// 도커 없이 도는 strategy 테스트: MikroORM이 실제로 만드는 SQL 형태와 결과 분기를 가짜 DB로 확인한다.
// 동시성 정합성(행 잠금·EvalPlanQual)은 가짜 DB가 흉내 내지 않으므로 strategies.pg.test.mjs에서 실제 PostgreSQL로 본다.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { cmd, createFakeOrm, makeCtx, makeStrategy } from './helpers.mjs';

let fake;
before(async () => {
  fake = await createFakeOrm();
});
after(async () => {
  await fake.orm.close(true);
});

async function runOne(id, { stock, qty = 1, params } = {}) {
  fake.db.products.clear();
  fake.db.ledger.length = 0;
  fake.db.sql.length = 0;
  fake.seed(stock);
  const { strategy, params: defaults } = makeStrategy(id);
  const result = await strategy.execute(cmd(1, qty), makeCtx(fake.orm.em, { params: params ?? defaults }));
  return { result, sql: [...fake.db.sql], ledger: [...fake.db.ledger], stock: fake.db.products.get(1).stock };
}

describe('SQL 형태(MikroORM이 실제로 만드는 문장)', () => {
  it('no-lock: 락 없는 SELECT → SET stock = 앱이 계산한 상수', async () => {
    const r = await runOne('no-lock', { stock: 5 });
    assert.equal(r.result, 'success');
    assert.ok(!r.sql[0].includes('for update'), r.sql[0]);
    assert.match(r.sql[1], /^update "g02_product" set "stock" = 4 where "id" = 1$/);
    assert.match(r.sql[2], /^insert into "g02_order_ledger"/);
    assert.equal(r.stock, 4);
  });

  it('row-lock: SET LOCAL lock_timeout → SELECT ... FOR UPDATE → UPDATE → 원장', async () => {
    const r = await runOne('row-lock', { stock: 5 });
    assert.equal(r.result, 'success');
    assert.equal(r.sql[0], "set local lock_timeout = '1000ms'");
    assert.match(r.sql[1], /for update$/);
    assert.match(r.sql[2], /^update "g02_product" set "stock" = 4 where "id" = 1$/);
    assert.match(r.sql[3], /^insert into "g02_order_ledger"/);
  });

  it('conditional-update: SET stock = stock - qty WHERE stock >= qty 한 문장', async () => {
    const r = await runOne('conditional-update', { stock: 5, qty: 2 });
    assert.equal(r.result, 'success');
    assert.match(r.sql[0], /^update "g02_product" set "stock" = stock - 2 where "id" = 1 and "stock" >= 2/);
    assert.match(r.sql[1], /^insert into "g02_order_ledger"/);
    assert.equal(r.sql.length, 2, '별도 SELECT가 없어야 한다');
    assert.equal(r.stock, 3);
  });

  it('app-memory-lock: mutex 안쪽 SQL은 no-lock과 같다', async () => {
    const a = await runOne('app-memory-lock', { stock: 5 });
    const b = await runOne('no-lock', { stock: 5 });
    assert.deepEqual(
      a.sql.map((s) => s.replace(/'[0-9a-f-]{36}'/, "'?'")),
      b.sql.map((s) => s.replace(/'[0-9a-f-]{36}'/, "'?'")),
    );
  });
});

describe('품절 분기: 재고는 그대로, 원장에 sold_out', () => {
  for (const id of ['no-lock', 'row-lock', 'conditional-update', 'app-memory-lock']) {
    it(id, async () => {
      const r = await runOne(id, { stock: 1, qty: 2 });
      assert.equal(r.result, 'sold_out');
      assert.equal(r.stock, 1);
      assert.equal(r.ledger.length, 1);
      assert.equal(r.ledger[0].result, 'sold_out');
      assert.ok(!r.sql.some((s) => /^update .* set "stock" = \d+ /.test(s)), '품절이면 재고 UPDATE가 없어야 한다');
    });
  }

  it('conditional-update: 영향 행 0인데 상품이 없으면 404(품절과 구분)', async () => {
    fake.db.products.clear();
    fake.db.ledger.length = 0;
    const { strategy } = makeStrategy('conditional-update');
    await assert.rejects(strategy.execute(cmd(99, 1), makeCtx(fake.orm.em)), (e) => e.getStatus?.() === 404);
    assert.equal(fake.db.ledger.length, 0);
  });
});

describe('row-lock: lock_timeout(55P03) → 503, 원장에 남지 않음', () => {
  it('FOR UPDATE에서 55P03이 나면 ServiceUnavailableException', async () => {
    fake.db.products.clear();
    fake.db.ledger.length = 0;
    fake.seed(5);
    fake.db.failOn = /for update$/;
    fake.db.failError = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    try {
      const { strategy, params } = makeStrategy('row-lock');
      await assert.rejects(strategy.execute(cmd(), makeCtx(fake.orm.em, { params })), (e) => e.getStatus?.() === 503);
      assert.equal(fake.db.ledger.length, 0);
      assert.equal(fake.db.products.get(1).stock, 5);
    } finally {
      fake.db.failOn = null;
    }
  });

  it('55P03이 아닌 에러는 그대로 올린다', async () => {
    fake.db.products.clear();
    fake.seed(5);
    fake.db.failOn = /for update$/;
    fake.db.failError = Object.assign(new Error('boom'), { code: '57014' });
    try {
      const { strategy, params } = makeStrategy('row-lock');
      await assert.rejects(strategy.execute(cmd(), makeCtx(fake.orm.em, { params })), /boom/);
    } finally {
      fake.db.failOn = null;
    }
  });
});

describe('app-memory-lock mutex (가짜 DB엔 행 잠금이 없어서 mutex만이 보호 장치다)', () => {
  const delays = [{ point: 'after-read', ms: 5 }];

  async function burst(instances, n, stock) {
    fake.db.products.clear();
    fake.db.ledger.length = 0;
    fake.seed(stock);
    const strategies = Array.from({ length: instances }, () => makeStrategy('app-memory-lock').strategy);
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        strategies[i % instances].execute(cmd(), makeCtx(fake.orm.em, { instance: `app-${(i % instances) + 1}`, delays })),
      ),
    );
    return { results, ...fake.violations() };
  }

  it('인스턴스 1개: 같은 상품 요청이 줄을 서서 위반 0, Map 항목 정리', async () => {
    const strategy = makeStrategy('app-memory-lock').strategy;
    fake.db.products.clear();
    fake.db.ledger.length = 0;
    fake.seed(5);
    const results = await Promise.all(Array.from({ length: 10 }, () => strategy.execute(cmd(), makeCtx(fake.orm.em, { delays }))));
    const v = fake.violations();
    assert.equal(results.filter((r) => r === 'success').length, 5);
    assert.equal(v.soldEqualsDecrement + v.oversell, 0);
    assert.equal(strategy.tails.size, 0, '마지막 해제 뒤 Map 항목이 남으면 누수');
  });

  it('인스턴스 2개(별도 mutex): 잃어버린 갱신 발생', async () => {
    const v = await burst(2, 10, 5);
    assert.ok(v.soldEqualsDecrement + v.oversell > 0, JSON.stringify(v));
  });

  it('예외가 나도 finally에서 해제되어 다음 요청이 진행된다', async () => {
    const strategy = makeStrategy('app-memory-lock').strategy;
    fake.db.products.clear();
    fake.db.ledger.length = 0;
    fake.seed(5);
    // 상품 404 → findOneOrFail 예외
    await assert.rejects(strategy.execute(cmd(42), makeCtx(fake.orm.em)));
    assert.equal(strategy.tails.size, 0);
    assert.equal(await strategy.execute(cmd(1), makeCtx(fake.orm.em)), 'success');
  });

  it('no-lock은 인스턴스 1개에서도 잃어버린 갱신', async () => {
    fake.db.products.clear();
    fake.db.ledger.length = 0;
    fake.seed(5);
    const { strategy } = makeStrategy('no-lock');
    await Promise.all(Array.from({ length: 10 }, () => strategy.execute(cmd(), makeCtx(fake.orm.em, { delays }))));
    const v = fake.violations();
    assert.ok(v.soldEqualsDecrement + v.oversell > 0, JSON.stringify(v));
  });
});

describe('경합 창 주입 지점(after-read)은 모든 strategy에 같은 조건으로 걸린다', () => {
  for (const id of ['no-lock', 'app-memory-lock', 'row-lock', 'conditional-update']) {
    for (const stock of [5, 0]) {
      it(`${id} · 재고 ${stock}: after-read가 요청당 정확히 1번, 첫 쓰기 문장(UPDATE·원장 INSERT)보다 먼저`, async () => {
        fake.db.products.clear();
        fake.db.ledger.length = 0;
        fake.db.sql.length = 0;
        fake.seed(stock);
        const calls = [];
        const { strategy, params } = makeStrategy(id);
        const ctx = makeCtx(fake.orm.em, { params });
        ctx.contentionWindow = async (point) => {
          calls.push({ point, sqlBefore: fake.db.sql.length });
        };
        await strategy.execute(cmd(), ctx);
        const reads = calls.filter((c) => c.point === 'after-read');
        assert.equal(reads.length, 1, JSON.stringify(calls));
        const firstWrite = fake.db.sql.findIndex((s) => /^(update|insert)/.test(s));
        assert.ok(firstWrite >= 0 && reads[0].sqlBefore <= firstWrite, `${id}: 주입이 쓰기 뒤에 있음 ${JSON.stringify(fake.db.sql)}`);
      });
    }
  }
});
