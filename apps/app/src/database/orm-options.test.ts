// orm-options 단위 테스트 + PG 통합(AC-2·AC-3). 통합은 APP_TEST_DATABASE_URL(기본 compose postgres 127.0.0.1:55432)에
// 접속할 수 없으면 skip. 통합은 SHOW·SELECT 만 보낸다(대상 DB 에 쓰지 않는다).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { MikroORM } from '@mikro-orm/postgresql';

import { loadEnv } from '../config/env';
import { getLabMetrics, resetLabMetrics } from '../metrics';
import { loadPack, type ScenarioPack } from '../packs/registry';
import { buildDriverOptions, buildOrmOptions } from './orm-options';

describe('buildDriverOptions', () => {
  it('null·생략이면 pg 옵션을 넣지 않는다(0단계 동작)', () => {
    assert.deepEqual(buildDriverOptions({ min: 1, max: 2 }), {});
    assert.deepEqual(
      buildDriverOptions({ min: 1, max: 2, acquireTimeoutMs: null }, { timeouts: { statementMs: null, idleInTxMs: null } }),
      {},
    );
  });

  it('acquireTimeoutMs·statementMs·idleInTxMs 를 pg Pool/Client 옵션으로 옮긴다', () => {
    const o = buildDriverOptions(
      { min: 1, max: 2, acquireTimeoutMs: 2000 },
      { timeouts: { statementMs: 3000, idleInTxMs: 10000 } },
    );
    assert.equal(o.connectionTimeoutMillis, 2000);
    assert.equal(o.statement_timeout, 3000);
    assert.equal(o.idle_in_transaction_session_timeout, 10000);
    assert.equal(o.onPoolCreated, undefined);
  });

  it('off 는 풀 훅이 없고, onPoolCreated 콜백만 있으면 그것만 부른다', () => {
    let seen: unknown = null;
    const o = buildDriverOptions({ min: 1, max: 2 }, { instrumentation: 'off', onPoolCreated: (p) => (seen = p) });
    const fakePool = { totalCount: 0, idleCount: 0, waitingCount: 0, connect: () => Promise.resolve() };
    (o.onPoolCreated as (p: unknown) => void)(fakePool);
    assert.equal(seen, fakePool);
    assert.equal(typeof fakePool.connect, 'function');
  });
});

const PG_URL = new URL(process.env.APP_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres_local@127.0.0.1:55432/postgres');
const pgEnv = loadEnv({
  POSTGRES_HOST: PG_URL.hostname,
  POSTGRES_PORT: PG_URL.port || '5432',
  POSTGRES_DB: PG_URL.pathname.slice(1) || 'postgres',
  POSTGRES_USER: decodeURIComponent(PG_URL.username),
  POSTGRES_PASSWORD: decodeURIComponent(PG_URL.password),
  INSTANCE_NAME: 'orm-options-test',
});

describe('buildOrmOptions + PG', () => {
  let pack: ScenarioPack;
  let orm: MikroORM | null = null;
  let skip: string | false = false;

  before(async () => {
    resetLabMetrics();
    pack = await loadPack('g01-shared-document');
    try {
      orm = await MikroORM.init(
        buildOrmOptions(pgEnv, pack, { min: 1, max: 2, acquireTimeoutMs: 2000 }, {
          instrumentation: 'metrics',
          timeouts: { statementMs: 3210, idleInTxMs: 12345 },
        }),
      );
      await orm.connect();
      if (!(await orm.checkConnection()).ok) throw new Error('checkConnection 실패');
    } catch (err) {
      skip = `PG 접속 불가(${PG_URL.host}): ${err instanceof Error ? err.message : String(err)}`;
      await orm?.close(true).catch(() => {});
      orm = null;
    }
  });

  after(async () => {
    await orm?.close(true);
    resetLabMetrics();
  });

  it('AC-3: 앱 커넥션의 statement_timeout·idle_in_transaction_session_timeout 이 RunConfig 값이다', async (t) => {
    if (skip || !orm) return t.skip(skip || 'ORM 없음');
    const em = orm.em.fork();
    const [st] = await em.getConnection().execute<{ statement_timeout: string }[]>('show statement_timeout');
    const [idle] = await em
      .getConnection()
      .execute<{ idle_in_transaction_session_timeout: string }[]>('show idle_in_transaction_session_timeout');
    assert.equal(st!.statement_timeout, '3210ms');
    assert.equal(idle!.idle_in_transaction_session_timeout, '12345ms');
  });

  it('AC-2: 풀이 붙은 뒤 lab_db_pool_connections{state="total"} 이 0 보다 크고 acquire 가 집계된다', async (t) => {
    if (skip || !orm) return t.skip(skip || 'ORM 없음');
    await orm.em.fork().getConnection().execute('select 1');
    const text = await getLabMetrics('metrics').registry.metrics();
    const total = /^lab_db_pool_connections\{state="total"\} (\d+)/m.exec(text);
    assert.ok(total && Number(total[1]) > 0, `total 게이지가 0: ${total?.[0]}`);
    const count = /^lab_db_pool_acquire_duration_seconds_count (\d+)/m.exec(text);
    assert.ok(count && Number(count[1]) > 0, 'acquire 히스토그램이 비어 있다');
  });
});
