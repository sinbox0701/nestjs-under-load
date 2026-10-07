// 도커 없이 도는 strategy 테스트: MikroORM이 실제로 만드는 SQL 형태와 결과 분기를 가짜 DB로 확인한다.
// 동시성 정합성(행 잠금·EvalPlanQual)은 가짜 DB가 흉내 내지 않으므로 strategies.pg.test.mjs에서 실제 PostgreSQL로 본다.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';

import { G02_STRATEGIES, PACK_DIR, cmd, createFakeOrm, createFakeRedis, makeCtx, makeStrategy } from './helpers.mjs';

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
  for (const id of ['no-lock', 'row-lock', 'conditional-update', 'app-memory-lock', 'redis-lock', 'advisory-xact-lock']) {
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


describe('manifest·registry·마커 정합', () => {
  const manifest = parse(readFileSync(path.join(PACK_DIR, 'manifest.yaml'), 'utf8'));

  it('G02_STRATEGIES와 manifest strategies의 id가 같다(6개)', () => {
    assert.deepEqual(Object.keys(G02_STRATEGIES).sort(), manifest.strategies.map((s) => s.id).sort());
    assert.equal(manifest.strategies.length, 6);
  });

  it('redis-lock만 requires: [redis]이고, load.models에 open·closed가 있다', () => {
    for (const s of manifest.strategies) assert.deepEqual(s.requires ?? [], s.id === 'redis-lock' ? ['redis'] : [], s.id);
    assert.deepEqual(manifest.load.models, ['open', 'closed']);
  });

  for (const file of ['redis-lock', 'advisory-xact-lock']) {
    const src = readFileSync(path.join(PACK_DIR, 'strategies', `${file}.strategy.ts`), 'utf8');

    it(`${file}: // @learn id가 파일 안에서 유일하다`, () => {
      const ids = [...src.matchAll(/\/\/ @learn ([a-z0-9-]+) — \S/g)].map((m) => m[1]);
      assert.ok(ids.length >= 4, `마커 ${ids.length}개`);
      assert.equal(new Set(ids).size, ids.length, ids.join(','));
    });

    it(`${file}: // @event phase 집합 = ctx.events.emit phase 집합`, () => {
      const marked = new Set([...src.matchAll(/\/\/ @event ([^—\n]+)/g)].flatMap((m) => m[1].trim().split(/\s+/)));
      const emitted = new Set([...src.matchAll(/events\.emit\('([a-z_]+)'/g)].map((m) => m[1]));
      assert.deepEqual([...marked].sort(), [...emitted].sort());
    });
  }
});

function recordingSink() {
  const events = [];
  return { events, sink: { enabled: true, emit: (phase, fields) => events.push({ phase, ...fields }) } };
}

describe('advisory-xact-lock: 트랜잭션 첫 문장이 잠금', () => {
  it('첫 SQL이 pg_advisory_xact_lock(상품 ID), 그 뒤 SELECT → UPDATE → 원장', async () => {
    const r = await runOne('advisory-xact-lock', { stock: 5 });
    assert.equal(r.result, 'success');
    assert.equal(r.sql[0], 'select pg_advisory_xact_lock(1)');
    assert.match(r.sql[1], /^select .* from "g02_product"/);
    assert.ok(!r.sql[1].includes('for update'));
    assert.match(r.sql[2], /^update "g02_product" set "stock" = 4 where "id" = 1$/);
    assert.match(r.sql[3], /^insert into "g02_order_ledger"/);
  });

  it('이벤트: arrived → lock_wait → lock_acquired → db_read → db_write → committed → lock_released', async () => {
    fake.db.products.clear();
    fake.db.ledger.length = 0;
    fake.seed(5);
    const { events, sink } = recordingSink();
    const { strategy } = makeStrategy('advisory-xact-lock');
    await strategy.execute(cmd(), makeCtx(fake.orm.em, { events: sink }));
    assert.deepEqual(events.map((e) => e.phase), ['arrived', 'lock_wait', 'lock_acquired', 'db_read', 'db_write', 'committed', 'lock_released']);
    assert.deepEqual(events[0].entity, { type: 'Product', id: '1' });
  });

  it('실패하면 rolled_back을 내고 예외를 그대로 올린다', async () => {
    fake.db.products.clear();
    const { events, sink } = recordingSink();
    const { strategy } = makeStrategy('advisory-xact-lock');
    await assert.rejects(strategy.execute(cmd(42), makeCtx(fake.orm.em, { events: sink })));
    assert.ok(events.some((e) => e.phase === 'rolled_back'));
    assert.ok(!events.some((e) => e.phase === 'committed'));
  });
});

describe('redis-lock (가짜 Redis)', () => {
  async function run(redis, { stock = 5, qty = 1, params, events } = {}) {
    fake.db.products.clear();
    fake.db.ledger.length = 0;
    fake.db.sql.length = 0;
    fake.seed(stock);
    const { strategy, params: defaults } = makeStrategy('redis-lock', { redis });
    return strategy.execute(cmd(1, qty), makeCtx(fake.orm.em, { params: params ?? defaults, events }));
  }

  it('락은 트랜잭션 밖: SET NX PX → DB(SELECT·UPDATE·원장) → Lua 해제 순서, DB에는 락 문장이 없다', async () => {
    const redis = createFakeRedis();
    assert.equal(await run(redis), 'success');
    assert.deepEqual(redis.log.map((l) => l[0]), ['set', 'eval']);
    const [, key, token, px, ms, nx] = redis.log[0];
    assert.deepEqual([key, px, ms, nx], ['g02:lock:product:1', 'PX', 3000, 'NX']);
    assert.equal(redis.log[1][2], 1);
    assert.equal(redis.log[1][3], key);
    assert.equal(redis.log[1][4], token);
    assert.ok(!fake.db.sql.some((s) => /advisory|for update/.test(s)));
    assert.equal(fake.db.ledger.length, 1);
    assert.equal(redis.keys.size, 0, '해제 뒤 키가 남으면 안 된다');
  });

  it('ttlMs 파라미터가 PX로 전달된다', async () => {
    const redis = createFakeRedis();
    await run(redis, { params: { ttlMs: 777 } });
    assert.equal(redis.log[0][4], 777);
  });

  it('이미 다른 토큰이 잡고 있으면 ttlMs 안에 못 얻어 503(lock_timeout), DB·원장에 흔적 없음', async () => {
    const redis = createFakeRedis();
    redis.keys.set('g02:lock:product:1', { token: 'other', expiresAt: Date.now() + 10_000 });
    const { events, sink } = recordingSink();
    await assert.rejects(run(redis, { params: { ttlMs: 30 }, events: sink }), (e) => e.getStatus?.() === 503 && e.getResponse().result === 'lock_timeout');
    assert.equal(fake.db.ledger.length, 0);
    assert.equal(fake.db.sql.length, 0);
    assert.equal(redis.keys.get('g02:lock:product:1').token, 'other', '남의 락은 건드리지 않는다');
    assert.ok(events.some((e) => e.phase === 'lock_timeout'));
  });

  it('fail-closed: Redis 오류면 503(redis_unavailable), DB를 건드리지 않고 원장에도 남지 않는다', async () => {
    const redis = createFakeRedis();
    redis.failWith = new Error('ECONNREFUSED');
    await assert.rejects(run(redis), (e) => e.getStatus?.() === 503 && e.getResponse().result === 'redis_unavailable');
    assert.equal(fake.db.sql.length, 0);
    assert.equal(fake.db.ledger.length, 0);
    assert.equal(fake.db.products.get(1).stock, 5);
  });

  it('트랜잭션이 실패해도 락은 해제된다(rolled_back 이벤트, 예외 전달)', async () => {
    const redis = createFakeRedis();
    fake.db.failOn = /^insert into "g02_order_ledger"/;
    fake.db.failError = new Error('ledger down');
    const { events, sink } = recordingSink();
    try {
      await assert.rejects(run(redis, { events: sink }), /ledger down/);
    } finally {
      fake.db.failOn = null;
    }
    assert.equal(redis.keys.size, 0);
    assert.deepEqual(events.map((e) => e.phase).filter((p) => ['rolled_back', 'lock_released', 'committed'].includes(p)), ['rolled_back', 'lock_released']);
  });

  it('해제 중 Redis 오류는 커밋된 결과를 뒤집지 않는다', async () => {
    const redis = createFakeRedis();
    redis.eval = async () => {
      throw new Error('ECONNRESET');
    };
    assert.equal(await run(redis), 'success');
    assert.equal(fake.db.ledger.length, 1);
  });

  it('이벤트: arrived → lock_wait → lock_acquired → db_read → db_write → committed → lock_released', async () => {
    const { events, sink } = recordingSink();
    await run(createFakeRedis(), { events: sink });
    assert.deepEqual(events.map((e) => e.phase), ['arrived', 'lock_wait', 'lock_acquired', 'db_read', 'db_write', 'committed', 'lock_released']);
  });

  it('같은 상품 동시 요청은 가짜 Redis 락으로 직렬화된다(가짜 DB엔 행 잠금이 없다)', async () => {
    const redis = createFakeRedis();
    fake.db.products.clear();
    fake.db.ledger.length = 0;
    fake.seed(5);
    const { strategy, params } = makeStrategy('redis-lock', { redis });
    const delays = [{ point: 'after-read', ms: 5 }];
    const results = await Promise.all(Array.from({ length: 10 }, () => strategy.execute(cmd(), makeCtx(fake.orm.em, { params, delays }))));
    const v = fake.violations();
    assert.equal(results.filter((r) => r === 'success').length, 5);
    assert.equal(v.soldEqualsDecrement + v.oversell, 0, JSON.stringify(v));
  });
});
