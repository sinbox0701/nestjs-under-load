// 컨트롤러가 LAB_EVENT_SINK 없이 만들어져도 NOOP_EVENT_SINK 를 strategy 에 넘기는지 확인한다(DB 불필요).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { PACK_DIR, cmd, createFakeOrm, makeCtx, makeStrategy } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { G02Controller } = require('../dist/api/g02.controller.js');
const { NOOP_EVENT_SINK } = require('@under-load/contracts');

function makeController(events) {
  let seen;
  const strategy = {
    id: 'fake',
    async execute(_cmd, ctx) {
      seen = ctx;
      return 'success';
    },
  };
  const em = { fork: () => ({}) };
  const runtime = { instance: 'app-1', contentionWindow: async () => {} };
  const controller = new G02Controller(em, strategy, {}, runtime, events);
  return { controller, ctx: () => seen };
}

const res = { status() {} };

test('LAB_EVENT_SINK 가 없으면 NOOP_EVENT_SINK 를 넘긴다', async () => {
  const { controller, ctx } = makeController(undefined);
  await controller.createOrder(randomUUID(), { productId: 1, qty: 1 }, res);
  assert.equal(ctx().events, NOOP_EVENT_SINK);
});

test('주입된 sink 가 있으면 그대로 넘긴다', async () => {
  const fake = { enabled: true, emit() {} };
  const { controller, ctx } = makeController(fake);
  await controller.createOrder(randomUUID(), { productId: 1, qty: 1 }, res);
  assert.equal(ctx().events, fake);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-125: strategy 4종이 소스의 `// @event` 마커 위치에서 ctx.events.emit 을 부르는지 확인한다(가짜 DB, 도커 불필요).
// ─────────────────────────────────────────────────────────────────────────────
const STRATEGY_FILES = {
  'no-lock': 'no-lock.strategy.ts',
  'app-memory-lock': 'app-memory-lock.strategy.ts',
  'row-lock': 'row-lock.strategy.ts',
  'conditional-update': 'conditional-update.strategy.ts',
};

/** 마커 주석에는 있지만 emit 호출이 없는 phase. 마커 줄을 못 고치는 제약 때문에 생긴 알려진 빈틈이다. */
const KNOWN_GAPS = {
  // 트랜잭션이 `return ctx.em.transactional(...)` 한 문장이라 예외 경로(롤백)를 잡을 자리가 없다.
  'no-lock': ['rolled_back'],
};

function recorder() {
  const events = [];
  return { events, sink: { enabled: true, emit: (phase, fields) => events.push({ phase, ...fields }) } };
}

describe('G02 strategy 이벤트 방출(가짜 DB)', () => {
  let fake;
  before(async () => {
    fake = await createFakeOrm();
  });
  after(async () => {
    await fake.orm.close(true);
  });

  async function run(id, { stock = 5, qty = 1, delays = [], params } = {}) {
    fake.db.products.clear();
    fake.db.ledger.length = 0;
    fake.seed(stock);
    const { strategy, params: defaults } = makeStrategy(id);
    const { events, sink } = recorder();
    const result = await strategy.execute(cmd(1, qty), makeCtx(fake.orm.em, { params: params ?? defaults, delays, events: sink }));
    return { result, events };
  }

  const isSubsequence = (needle, hay) => {
    let i = 0;
    for (const h of hay) if (h === needle[i]) i += 1;
    return i === needle.length;
  };

  test('AC-1 row-lock: arrived → lock_wait → lock_acquired → db_write → committed 순서', async () => {
    const { result, events } = await run('row-lock');
    assert.equal(result, 'success');
    const phases = events.map((e) => e.phase);
    assert.ok(isSubsequence(['arrived', 'lock_wait', 'lock_acquired', 'db_write', 'committed'], phases), phases.join(','));
    const wait = events.find((e) => e.phase === 'lock_wait');
    assert.equal(typeof wait.durMs, 'number');
    assert.deepEqual(wait.entity, { type: 'Product', id: '1' });
  });

  test('모든 strategy 가 arrived 로 시작해 committed 로 끝나고 entity 를 단다', async () => {
    for (const id of Object.keys(STRATEGY_FILES)) {
      const { events } = await run(id);
      const phases = events.map((e) => e.phase);
      assert.equal(phases[0], 'arrived', id);
      assert.ok(phases.includes('committed'), id);
      for (const e of events) assert.deepEqual(e.entity, { type: 'Product', id: '1' }, `${id}/${e.phase}`);
    }
  });

  test('품절도 커밋(원장 기록)으로 끝난다', async () => {
    for (const id of Object.keys(STRATEGY_FILES)) {
      const { result, events } = await run(id, { stock: 0 });
      assert.equal(result, 'sold_out', id);
      assert.ok(events.some((e) => e.phase === 'committed'), id);
    }
  });

  test('app-memory-lock: 예외면 rolled_back 과 lock_released, committed 는 없다', async () => {
    fake.db.products.clear(); // 상품이 없으면 findOneOrFail 이 던진다
    const { strategy } = makeStrategy('app-memory-lock');
    const { events, sink } = recorder();
    await assert.rejects(strategy.execute(cmd(1, 1), makeCtx(fake.orm.em, { events: sink })));
    const phases = events.map((e) => e.phase);
    assert.ok(phases.includes('rolled_back'));
    assert.ok(phases.includes('lock_released'));
    assert.ok(!phases.includes('committed'));
  });

  test('row-lock: lock_timeout 이면 lock_timeout·rolled_back 을 낸다', async () => {
    fake.db.products.clear();
    fake.seed(5);
    fake.db.failOn = /for update/;
    fake.db.failError = Object.assign(new Error('lock timeout'), { code: '55P03' });
    try {
      const { strategy, params } = makeStrategy('row-lock');
      const { events, sink } = recorder();
      await assert.rejects(strategy.execute(cmd(1, 1), makeCtx(fake.orm.em, { params, events: sink })));
      const phases = events.map((e) => e.phase);
      assert.ok(phases.includes('lock_timeout'));
      assert.ok(phases.includes('rolled_back'));
      assert.ok(!phases.includes('committed'));
    } finally {
      fake.db.failOn = null;
    }
  });

  test('AC-4 주입 지연이 걸리면 injected_delay 가 injected=true 로 나온다', async () => {
    for (const id of Object.keys(STRATEGY_FILES)) {
      const { events } = await run(id, { delays: [{ point: 'after-read', ms: 15 }] });
      const hits = events.filter((e) => e.phase === 'injected_delay');
      assert.ok(hits.length >= 1, id);
      for (const h of hits) {
        assert.equal(h.injected, true, id);
        assert.ok(h.durMs >= 10, `${id} durMs=${h.durMs}`);
      }
    }
  });

  test('주입 지연이 없으면 injected_delay 를 내지 않는다', async () => {
    for (const id of Object.keys(STRATEGY_FILES)) {
      const { events } = await run(id);
      assert.ok(!events.some((e) => e.phase === 'injected_delay'), id);
    }
  });
});

describe('AC-2 마커 phase 집합 = emit phase 집합(소스 스캔)', () => {
  for (const [id, file] of Object.entries(STRATEGY_FILES)) {
    test(id, () => {
      const src = readFileSync(path.join(PACK_DIR, 'strategies', file), 'utf8');
      const marked = new Set();
      for (const m of src.matchAll(/\/\/ @event ([^—\n]+)/g)) for (const p of m[1].trim().split(/\s+/)) marked.add(p);
      const emitted = new Set([...src.matchAll(/events\.emit\('([^']+)'/g)].map((m) => m[1]));
      const missing = [...marked].filter((p) => !emitted.has(p)).sort();
      const extra = [...emitted].filter((p) => !marked.has(p)).sort();
      assert.deepEqual(extra, [], `${id}: 마커에 없는 phase 를 emit`);
      assert.deepEqual(missing, KNOWN_GAPS[id] ?? [], `${id}: emit 없는 마커 phase`);
    });
  }
});
