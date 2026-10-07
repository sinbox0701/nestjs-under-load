// task=prepare-template 부팅 통합 테스트(AC-3). PG 에 접속할 수 없으면 skip.
// 실행은 `tsc && node --test "dist/**/*.test.js"`(g02 팩 dist 가 있어야 부팅된다). 접속 대상: APP_TEST_DATABASE_URL(기본 compose postgres 127.0.0.1:55432, CREATE DATABASE 권한 필요).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { MikroORM } from '@mikro-orm/postgresql';

import { toSeedOptions } from './prepare-template';

const APP_DIR = path.resolve(__dirname, '../..');
const FIXTURES = path.join(path.dirname(require.resolve('@under-load/contracts/package.json')), 'fixtures');

const PG_URL = new URL(process.env.APP_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres_local@127.0.0.1:55432/postgres');

/** 엔티티 없이 SQL 만 보내는 ORM. dbName 을 바꿔 관리용·확인용으로 쓴다. */
function open(dbName: string) {
  return MikroORM.init({
    clientUrl: PG_URL.href,
    dbName,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    metadataProvider: ReflectMetadataProvider,
    allowGlobalContext: true,
    pool: { min: 0, max: 1 },
  });
}
const ADMIN_DB = PG_URL.pathname.slice(1) || 'postgres';

/** 접속 가능하면 null, 아니면 skip 사유. */
async function probe(): Promise<string | null> {
  try {
    const a = await open(ADMIN_DB);
    try {
      await Promise.race([
        a.em.getConnection().execute('select 1'),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('3초 안에 응답 없음')), 3000)),
      ]);
    } finally {
      await a.close(true);
    }
    return null;
  } catch (e) {
    return `PostgreSQL 접속 불가(${PG_URL.host}): ${e instanceof Error ? e.message : String(e)}`;
  }
}

describe('toSeedOptions', () => {
  it('정수만 통과', () => {
    assert.deepEqual(toSeedOptions({ products: 5 }), { products: 5 });
    assert.throws(() => toSeedOptions({ products: 'x' }), /정수/);
    assert.throws(() => toSeedOptions({ products: 1.5 }), /정수/);
  });
});

describe('task=prepare-template 부팅 × 실제 PostgreSQL (AC-3)', () => {
  let skip: string | null = null;
  const dbName = `tpl_g02_t121_${process.pid}`;
  let admin: MikroORM | undefined;
  before(async () => {
    skip = await probe();
    if (skip) return;
    admin = await open(ADMIN_DB);
    await admin.em.execute(`create database "${dbName}"`);
  });
  after(async () => {
    await admin?.em.execute(`drop database if exists "${dbName}" with (force)`).catch(() => {});
    await admin?.close(true);
  });

  it('ready 가 prepared 를 싣고, 그 DB 에 g02 테이블이 있다', async (t) => {
    if (skip) return t.skip(skip);
    const base = JSON.parse(readFileSync(path.join(FIXTURES, 'run-config.v1.prepare-template.json'), 'utf8')) as object;
    const rc = { ...base, prepareTemplate: { database: dbName, seedOptions: { products: 3, warmupProducts: 2, stockPerProduct: 100 } }, redis: null };
    const orch = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rc));
    });
    orch.listen(0, '127.0.0.1');
    await once(orch, 'listening');
    const port = 39500 + (process.pid % 400);
    const child = spawn(process.execPath, [path.join(APP_DIR, 'dist/main.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        ORCHESTRATOR_URL: `http://127.0.0.1:${(orch.address() as AddressInfo).port}`,
        INSTANCE_NAME: 'app-t121',
        POSTGRES_HOST: PG_URL.hostname,
        POSTGRES_PORT: PG_URL.port || '5432',
        POSTGRES_USER: decodeURIComponent(PG_URL.username),
        POSTGRES_PASSWORD: decodeURIComponent(PG_URL.password),
      },
      stdio: 'pipe',
    });
    let log = '';
    child.stdout.on('data', (d: Buffer) => (log += d));
    child.stderr.on('data', (d: Buffer) => (log += d));
    try {
      let res: Response | null | undefined;
      for (let i = 0; i < 150; i++) {
        res = await fetch(`http://127.0.0.1:${port}/_lab/ready`).catch(() => null);
        if (res?.status === 200) break;
        await new Promise<void>((r) => setTimeout(r, 200));
      }
      assert.equal(res?.status, 200, `ready 200 아님\n${log}`);
      const body = (await res.json()) as { task: string; prepared: { database: string; durationMs: number } };
      assert.equal(body.task, 'prepare-template');
      assert.equal(body.prepared.database, dbName);
      assert.ok(body.prepared.durationMs >= 0);

      const check = await open(dbName);
      try {
        const tables = await check.em.execute<{ table_name: string }[]>(
          `select table_name from information_schema.tables where table_schema = 'public' and table_name like '%product%'`,
        );
        assert.ok(tables.length > 0, `g02 테이블 없음: ${JSON.stringify(tables)}`);
        const rows = await check.em.execute<{ n: number }[]>(`select count(*)::int as n from ${tables[0]!.table_name}`);
        assert.equal(rows[0]?.n, 5, '시드 상품 수(본 3 + 웜업 2)');
      } finally {
        await check.close(true);
      }
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      await new Promise<void>((r) => orch.close(() => r()));
    }
  });
});
