// G02 테스트 공용 도우미. 빌드 산출물(dist)을 불러 쓴다(`pnpm test`가 tsc 후 실행).
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const PACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { MikroORM } = require('@mikro-orm/postgresql');
const { ReflectMetadataProvider } = require('@mikro-orm/decorators/legacy');
const { Migrator } = require('@mikro-orm/migrations');
const { Product } = require('../dist/entities/product.entity.js');
const { OrderLedger } = require('../dist/entities/order-ledger.entity.js');
const { Migration20261007000000_g02_init } = require('../dist/migrations/Migration20261007000000_g02_init.js');
const { G02_STRATEGIES, resolveStrategy } = require('../dist/strategy-registry.js');
const { LedgerWriter } = require('../dist/support/ledger.writer.js');
const { createContentionWindow } = require('../dist/support/contention-window.js');
const { seedG02 } = require('../dist/seed/index.js');
const { NOOP_EVENT_SINK } = require('@under-load/contracts');

export { G02_STRATEGIES, resolveStrategy };

/** 요청 하나의 StrategyContext. 실제 컨트롤러처럼 요청마다 em을 fork 한다. */
export function makeCtx(em, { params = {}, instance = 'app-1', delays = [], events = NOOP_EVENT_SINK } = {}) {
  return {
    em: em.fork(),
    params,
    instance,
    contentionWindow: createContentionWindow(delays),
    ledger: new LedgerWriter(instance),
    events,
  };
}

/** redis: redis-lock의 Redis 클라이언트(생성자 주입). redis-lock인데 안 주면 가짜 Redis를 쓴다. 나머지 strategy는 의존성이 없다. */
export function makeStrategy(id, { redis, params: rawParams } = {}) {
  const { cls, params, requires } = resolveStrategy(id, rawParams);
  const dep = requires.includes('redis') ? (redis ?? createFakeRedis()) : undefined;
  return { strategy: dep ? new cls(dep) : new cls(), params };
}

export function cmd(productId = 1, qty = 1) {
  return { requestId: randomUUID(), productId, qty };
}

/** invariants.sql → { name: sql } (scripts/run.mjs parseInvariantsSql와 같은 규약) */
export function loadInvariants() {
  const text = readFileSync(path.join(PACK_DIR, 'invariants.sql'), 'utf8');
  const out = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const m = /^--\s*name:\s*([a-z0-9_]+)\s*$/.exec(line);
    if (m) {
      cur = m[1];
      out[cur] = [];
    } else if (cur) {
      out[cur].push(line);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]));
}

/** SQL 리터럴을 지워 형태만 비교한다: 'x' → '?', 숫자 → ?, 공백 정리, 끝 세미콜론 제거. */
export function normalizeSql(sql) {
  return sql
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/\b\d+\b/g, '?')
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim()
    .toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// 가짜 DB(도커 불필요): MikroORM이 만든 최종 SQL을 가로채 메모리 표에 적용한다.
// 행 잠금·EvalPlanQual은 흉내 내지 않는다. 그래서 SQL 형태 확인, 결과 분기, 그리고
// "DB 락에 기대지 않는" app-memory-lock mutex 동작 확인에만 쓴다.
// ─────────────────────────────────────────────────────────────────────────────
export async function createFakeOrm({ latencyMs = 1 } = {}) {
  const orm = await MikroORM.init({
    entities: [Product, OrderLedger],
    metadataProvider: ReflectMetadataProvider,
    dbName: 'g02_fake',
    connect: false,
    allowGlobalContext: true,
  });
  const conn = orm.em.getConnection();
  const db = { products: new Map(), ledger: [], sql: [], failOn: null };
  const row = (p) => ({ id: p.id, initial_stock: p.initialStock, stock: p.stock });
  conn.begin = async () => ({ fake: true });
  conn.commit = async () => {};
  conn.rollback = async () => {};
  conn.execute = async (query, params = [], method = 'all') => {
    const sql = conn.prepareQuery(query, params).formatted;
    db.sql.push(sql);
    await sleep(latencyMs);
    if (db.failOn && db.failOn.test(sql)) throw db.failError;
    let m;
    if ((m = /^select "p0"\.\* from "g02_product" as "p0" where "p0"\."id" = (\d+)/.exec(sql))) {
      const p = db.products.get(Number(m[1]));
      if (method === 'get') return p ? row(p) : undefined;
      return p ? [row(p)] : [];
    }
    if ((m = /^select count\(\*\) as "count" from "g02_product" as "p0" where "p0"\."id" = (\d+)/.exec(sql))) {
      const r = { count: db.products.has(Number(m[1])) ? 1 : 0 };
      return method === 'get' ? r : [r];
    }
    if ((m = /^update "g02_product" set "stock" = (\d+) where "id" = (\d+)$/.exec(sql))) {
      const p = db.products.get(Number(m[2]));
      if (p) p.stock = Number(m[1]);
      return { affectedRows: p ? 1 : 0, rows: [], insertId: 0 };
    }
    if ((m = /^update "g02_product" set "stock" = stock - (\d+) where "id" = (\d+) and "stock" >= (\d+)/.exec(sql))) {
      const p = db.products.get(Number(m[2]));
      if (p && p.stock >= Number(m[3])) {
        p.stock -= Number(m[1]);
        return { affectedRows: 1, rows: [{ stock: p.stock }], row: { stock: p.stock }, insertId: 0 };
      }
      return { affectedRows: 0, rows: [], insertId: 0 };
    }
    if ((m = /^insert into "g02_order_ledger" .* values \('([^']+)', (\d+), (\d+), '([a-z_]+)', '([^']+)'\)/.exec(sql))) {
      db.ledger.push({ requestId: m[1], productId: Number(m[2]), qty: Number(m[3]), result: m[4], instance: m[5] });
      const id = String(db.ledger.length);
      return { affectedRows: 1, rows: [{ id }], row: { id }, insertId: id };
    }
    if (/^select pg_advisory_xact_lock\(\d+\)$/.test(sql)) return [{ pg_advisory_xact_lock: '' }];
    if (/^set local lock_timeout = '\d+ms'$/.test(sql)) return [];
    throw new Error(`fake db: 모르는 SQL: ${sql}`);
  };
  return {
    orm,
    db,
    seed(stock, id = 1) {
      db.products.set(id, { id, initialStock: stock, stock });
    },
    /** 가짜 표에서 sold_equals_decrement·no_oversell을 계산한다 */
    violations(id = 1) {
      const p = db.products.get(id);
      const sold = db.ledger.filter((l) => l.productId === id && l.result === 'success').reduce((a, l) => a + l.qty, 0);
      return { soldEqualsDecrement: p.initialStock - p.stock !== sold ? 1 : 0, oversell: sold > p.initialStock ? 1 : 0, sold, stock: p.stock };
    },
  };
}

/**
 * 가짜 Redis(도커 불필요): redis-lock이 쓰는 SET key token PX ms NX 와 Lua 소유자 확인 해제만 흉내 낸다.
 * eval은 RELEASE_LOCK_LUA 그대로의 동작(내 토큰이면 삭제)을 JS로 구현한다.
 */
export function createFakeRedis() {
  const keys = new Map();
  const log = [];
  const fake = {
    keys,
    log,
    failWith: null,
    async set(key, token, px, ms, nx) {
      if (fake.failWith) throw fake.failWith;
      log.push(['set', key, token, px, ms, nx]);
      await sleep(0);
      const cur = keys.get(key);
      if (cur && cur.expiresAt > Date.now()) return null;
      keys.set(key, { token, expiresAt: Date.now() + ms });
      return 'OK';
    },
    async eval(script, numKeys, key, token) {
      if (fake.failWith) throw fake.failWith;
      log.push(['eval', script, numKeys, key, token]);
      const cur = keys.get(key);
      if (cur && cur.token === token) {
        keys.delete(key);
        return 1;
      }
      return 0;
    },
  };
  return fake;
}

// ─────────────────────────────────────────────────────────────────────────────
// 실제 Redis(도커). 없으면 null을 돌려주고 테스트는 skip 한다.
// 접속: G02_TEST_REDIS_URL (기본 redis://127.0.0.1:6379). 키는 g02:lock:* 만 쓴다.
// ─────────────────────────────────────────────────────────────────────────────
export const REDIS_URL = process.env.G02_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

export function openRedis(url = REDIS_URL, options = {}) {
  const Redis = require('ioredis');
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null, ...options });
  redis.on('error', () => {});
  return redis;
}

/** 접속 가능하면 { ok: true }, 아니면 { ok: false, reason } */
export async function probeRedis(timeoutMs = 3000) {
  const redis = openRedis(REDIS_URL, { connectTimeout: timeoutMs });
  try {
    await redis.connect();
    await redis.ping();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    redis.disconnect();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 실제 PostgreSQL(도커). 없으면 null을 돌려주고 테스트는 skip 한다.
// 접속: G02_TEST_DATABASE_URL (기본: compose의 127.0.0.1:55432 superuser — 테스트 DB를 만들고 지운다)
// ─────────────────────────────────────────────────────────────────────────────
export const PG_URL = process.env.G02_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres_local@127.0.0.1:55432/postgres';

function baseOptions(dbName, poolMax) {
  return {
    clientUrl: PG_URL,
    dbName,
    entities: [Product, OrderLedger],
    metadataProvider: ReflectMetadataProvider,
    allowGlobalContext: true,
    pool: { min: 0, max: poolMax },
  };
}

/** 접속 가능하면 { ok: true }, 아니면 { ok: false, reason } */
export async function probePostgres(timeoutMs = 3000) {
  let orm;
  try {
    orm = await MikroORM.init({ ...baseOptions(new URL(PG_URL).pathname.slice(1) || 'postgres', 1), connect: false });
    // connect: false로 만든 뒤 실제 쿼리를 보내 접속을 시도한다(checkConnection은 미접속이면 시도 없이 false를 돌려준다).
    await Promise.race([
      orm.em.getConnection().execute('select 1'),
      sleep(timeoutMs, undefined, { ref: false }).then(() => {
        throw new Error(`${timeoutMs}ms 안에 응답 없음`);
      }),
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    await orm?.close(true).catch(() => {});
  }
}

/** 테스트 전용 DB를 만들고 마이그레이션을 돌린다. */
export async function createTestDatabase() {
  const adminDb = new URL(PG_URL).pathname.slice(1) || 'postgres';
  const name = `g02_it_${process.pid}_${Date.now()}`;
  const admin = await MikroORM.init(baseOptions(adminDb, 1));
  await admin.em.execute(`create database "${name}"`);
  const orms = [];
  const open = async (poolMax = 30) => {
    const orm = await MikroORM.init({
      ...baseOptions(name, poolMax),
      extensions: [Migrator],
      migrations: {
        tableName: 'mikro_orm_migrations_g02_test',
        // 기본값(snapshotOnMigrate)이면 up() 때마다 팩 폴더에 .snapshot-<db>.json을 남긴다. 테스트 DB는 일회용이라 끈다.
        snapshot: false,
        snapshotOnMigrate: false,
        migrationsList: [{ name: 'Migration20261007000000_g02_init', class: Migration20261007000000_g02_init }],
      },
    });
    orms.push(orm);
    return orm;
  };
  const main = await open();
  await main.migrator.up();
  return {
    name,
    open,
    main,
    async reset(stockPerProduct, products = 1) {
      await main.em.execute('truncate g02_order_ledger restart identity');
      await main.em.execute('delete from g02_product');
      await seedG02(main.em.fork(), { products, warmupProducts: 0, stockPerProduct });
    },
    async invariants() {
      const out = {};
      for (const [k, sql] of Object.entries(loadInvariants())) {
        const [r] = await main.em.fork().execute(sql);
        out[k] = r;
      }
      return out;
    },
    async stock(id = 1) {
      const [r] = await main.em.fork().execute('select stock from g02_product where id = ?', [id]);
      return r.stock;
    },
    async drop() {
      for (const o of orms) await o.close(true).catch(() => {});
      await admin.em.execute(`drop database if exists "${name}" with (force)`).catch(() => {});
      await admin.close(true);
    },
  };
}
