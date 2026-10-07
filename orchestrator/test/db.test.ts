// DbAdmin·InvariantRunner. SQL 기록 가짜로 순서를 확인하고, PG 통합은 대상이 없으면 skip 한다.
// 통합 대상: NUL_TEST_PG_PORT(기본 55432) 의 127.0.0.1 PG(superuser postgres / postgres_local, shared_preload_libraries=pg_stat_statements).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { createDbAdmin, createInvariantRunner, createPgConnect, judgeInvariants, parseInvariantsSql } from '../dist/db/index.js';
import type { PgConnect } from '../dist/db/index.js';
import type { ScenarioDef } from '../dist/ports.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const G02_REL = 'packs/generic/g02-stock-decrement';

const recorder = () => {
  const log: { db: string; sql: string }[] = [];
  const connect: PgConnect = async (db) => ({
    query: async (sql) => {
      log.push({ db, sql });
      return { rows: [] };
    },
    end: async () => {},
  });
  return { log, connect };
};

const base = { runDb: 'lab_run', appUser: 'lab_app', observerUser: 'lab_observer', observerPassword: 'obs_pw' };

const manifest = YAML.parse(readFileSync(path.join(REPO_ROOT, G02_REL, 'manifest.yaml'), 'utf8')) as { invariants: ScenarioDef['invariants'] };
const g02 = { id: 'g02-stock-decrement', invariantsSqlPath: `${G02_REL}/invariants.sql`, invariants: manifest.invariants } as ScenarioDef;

describe('DbAdmin (SQL 기록)', () => {
  it('AC-2: resetRunDb 가 7단계를 순서대로 보낸다', async () => {
    const { log, connect } = recorder();
    await createDbAdmin({ ...base, connect }).resetRunDb('tpl_g02_abc');
    assert.deepEqual(log, [
      { db: 'postgres', sql: 'DROP DATABASE IF EXISTS "lab_run" WITH (FORCE)' },
      { db: 'postgres', sql: 'CREATE DATABASE "lab_run" OWNER "lab_app" TEMPLATE "tpl_g02_abc"' },
      { db: 'lab_run', sql: 'VACUUM ANALYZE' },
      { db: 'postgres', sql: 'CHECKPOINT' },
      { db: 'postgres', sql: 'SELECT pg_stat_statements_reset()' },
      { db: 'lab_run', sql: 'SELECT pg_stat_reset()' },
      ...['archiver', 'bgwriter', 'checkpointer', 'io', 'recovery_prefetch', 'slru', 'wal'].map((t) => ({ db: 'postgres', sql: `SELECT pg_stat_reset_shared('${t}')` })),
    ]);
  });

  it('templateName: 같은 입력이면 같고 seedOptions 키 순서와 무관하며 값이 다르면 달라진다', () => {
    const a = createDbAdmin({ ...base, connect: recorder().connect });
    const d = (seedOptions: Record<string, unknown>, seed = 1) => ({ seed, seedOptions, distribution: { kind: 'uniform' } }) as never;
    const n1 = a.templateName('g02-stock-decrement', d({ products: 5, stockPerProduct: 100 }));
    assert.match(n1, /^tpl_g02_[0-9a-f]{12}$/);
    assert.equal(n1, a.templateName('g02-stock-decrement', d({ stockPerProduct: 100, products: 5 })));
    assert.notEqual(n1, a.templateName('g02-stock-decrement', d({ products: 6, stockPerProduct: 100 })));
    assert.notEqual(n1, a.templateName('g02-stock-decrement', d({ products: 5, stockPerProduct: 100 }, 2)));
  });

  it('markTemplate·execInRunDb·ensureRoles 가 올바른 DB 로 SQL 을 보낸다', async () => {
    const { log, connect } = recorder();
    const a = createDbAdmin({ ...base, connect, exporterPassword: "p'w" });
    await a.markTemplate('tpl_x');
    await a.execInRunDb('delete from t');
    await a.ensureRoles();
    assert.deepEqual(log[0], { db: 'postgres', sql: 'ALTER DATABASE "tpl_x" WITH is_template true allow_connections false' });
    assert.deepEqual(log[1], { db: 'lab_run', sql: 'delete from t' });
    const sqls = log.slice(2).map((l) => l.sql);
    assert.ok(sqls.some((s) => s.startsWith('CREATE ROLE "lab_observer"') && s.includes('CONNECTION LIMIT 2')));
    assert.ok(sqls.some((s) => s.startsWith('CREATE ROLE "exporter"') && s.includes("PASSWORD 'p''w'") && s.includes('CONNECTION LIMIT 3')));
    assert.equal(sqls.filter((s) => s.startsWith('GRANT pg_monitor')).length, 2);
  });
});

describe('InvariantRunner', () => {
  it('AC-4: G02 invariants.sql 파싱 결과가 run.mjs 와 같고 manifest 구간이 모두 있다', async () => {
    const text = readFileSync(path.join(REPO_ROOT, G02_REL, 'invariants.sql'), 'utf8');
    const sections = parseInvariantsSql(text);
    assert.deepEqual(
      sections.map((s) => s.name),
      ['no_oversell', 'no_negative_stock', 'sold_equals_decrement', 'no_duplicate_request_id', 'ledger_counts'],
    );
    for (const inv of g02.invariants) assert.ok(sections.some((s) => s.name === inv.sql.split('#')[1]));
    assert.throws(() => parseInvariantsSql('-- name: a\nselect 1;\n-- name: a\nselect 2;'), /중복/);
    assert.throws(() => parseInvariantsSql('-- name: a\n-- 주석만\n'), /비어/);

    // 원본 구현과 동일한 출력(원본을 불러올 수 있을 때)
    const legacy = (await import(path.join(REPO_ROOT, 'scripts/run.mjs')).catch(() => null)) as { parseInvariantsSql(t: string): unknown } | null;
    if (legacy) assert.deepEqual(sections, legacy.parseInvariantsSql(text));
  });

  it('judgeInvariants: 위반 수 판정, info 는 값만, 결과 없음은 통과가 아님(run.test.mjs 기대값)', () => {
    const r = judgeInvariants(g02.invariants, {
      no_negative_stock: { violations: 0 },
      sold_equals_decrement: { violations: 2 },
      no_oversell: null,
      ledger_counts: { success: 1, sold_out: 0, total: 1 },
    });
    const byId = Object.fromEntries(r.map((x) => [x.id, x]));
    assert.equal(byId['no-negative-stock']!.passed, true);
    assert.equal(byId['sold-equals-decrement']!.passed, false);
    assert.equal(byId['sold-equals-decrement']!.violations, 2);
    assert.equal(byId['no-oversell']!.passed, false);
    assert.equal(byId['no-oversell']!.violations, null);
    assert.deepEqual(byId['ledger-matches-k6']!.value, { success: 1, sold_out: 0, total: 1 });
    assert.deepEqual(
      r.map((x) => x.id),
      g02.invariants.map((x) => x.id),
    );
  });

  it('run: 구간 SQL 을 실행 DB 에 보내고 문자열 숫자를 Number 로 바꾼다', async () => {
    const sent: { db: string; sql: string }[] = [];
    const connect: PgConnect = async (db) => ({
      query: async (sql) => {
        sent.push({ db, sql });
        return { rows: sql.includes('filter (where') ? [{ success: '3', sold_out: '4', total: '7' }] : [{ violations: 0 }] };
      },
      end: async () => {},
    });
    const res = await createInvariantRunner({ connect, runDb: 'lab_run', repoDir: REPO_ROOT }).run(g02);
    assert.equal(sent.length, 5);
    assert.ok(sent.every((s) => s.db === 'lab_run'));
    assert.deepEqual(
      res.map((x) => [x.id, x.passed]),
      [
        ['no-negative-stock', true],
        ['sold-equals-decrement', true],
        ['no-oversell', true],
        ['no-duplicate-request-id', true],
        ['ledger-matches-k6', null],
      ],
    );
    assert.deepEqual(res[4]!.value, { success: 3, sold_out: 4, total: 7 });
  });
});

// ───────────────────────── PG 통합(대상 없으면 skip) ─────────────────────────

const PG_PORT = Number(process.env.NUL_TEST_PG_PORT ?? 55432);
const cfg = { host: '127.0.0.1', port: PG_PORT, adminUser: 'postgres', adminPassword: 'postgres_local', appUser: 'lab_app', observerUser: 'lab_observer', observerPassword: 'x', runDb: 'lab_run_t108' };

describe('PG 통합', async () => {
  const connect = createPgConnect(cfg);
  const reachable = await connect('postgres').then(
    (s) => s.end().then(() => true),
    () => false,
  );

  before(async () => {
    if (!reachable) return;
    const s = await connect('postgres');
    try {
      if ((await s.query("SELECT 1 FROM pg_roles WHERE rolname = 'lab_app'")).rows.length === 0) await s.query('CREATE ROLE lab_app LOGIN');
    } finally {
      await s.end();
    }
  });

  after(async () => {
    if (!reachable) return;
    const s = await connect('postgres');
    try {
      await s.query('ALTER DATABASE postgres RESET work_mem');
    } finally {
      await s.end();
    }
  });

  it('AC-3: ensureRoles 를 두 번 불러도 오류가 없고 역할 속성이 맞다', { skip: !reachable && 'PG 없음' }, async () => {
    const admin = createDbAdmin({ ...cfg, connect, exporterPassword: 'e' });
    await admin.ensureRoles();
    await admin.ensureRoles();
    const s = await connect('postgres');
    try {
      const r = await s.query(
        "SELECT rolname, rolconnlimit, rolsuper, pg_has_role(rolname, 'pg_monitor', 'member') AS mon FROM pg_roles WHERE rolname IN ('lab_observer','exporter') ORDER BY rolname",
      );
      assert.deepEqual(
        r.rows.map((x) => [x.rolname, x.rolconnlimit, x.rolsuper, x.mon]),
        [
          ['exporter', 3, false, true],
          ['lab_observer', 2, false, true],
        ],
      );
    } finally {
      await s.end();
    }
  });

  it('템플릿 표시·상태·resetRunDb·execInRunDb·InvariantRunner 가 실제 PG 에서 돈다', { skip: !reachable && 'PG 없음' }, async () => {
    const admin = createDbAdmin({ ...cfg, connect });
    const tpl = 'tpl_t108_it';
    const s = await connect('postgres');
    try {
      await s.query(`ALTER DATABASE "${tpl}" WITH is_template false allow_connections true`).catch(() => {});
      await s.query(`DROP DATABASE IF EXISTS "${tpl}" WITH (FORCE)`);
      assert.deepEqual(await admin.templateStatus(tpl), { exists: false, isTemplate: false });
      await s.query(`CREATE DATABASE "${tpl}" OWNER lab_app`);
    } finally {
      await s.end();
    }
    const t = await connect(tpl);
    try {
      await t.query('CREATE TABLE g02_product (id int primary key, initial_stock int, stock int); CREATE TABLE g02_order_ledger (product_id int, request_id text, qty int, result text)');
      await t.query("INSERT INTO g02_product VALUES (1, 10, 8); INSERT INTO g02_order_ledger VALUES (1, 'r1', 2, 'success')");
    } finally {
      await t.end();
    }
    assert.deepEqual(await admin.templateStatus(tpl), { exists: true, isTemplate: false });
    await admin.markTemplate(tpl);
    assert.deepEqual(await admin.templateStatus(tpl), { exists: true, isTemplate: true });

    try {
      await admin.resetRunDb(tpl);
      await admin.resetRunDb(tpl); // 이미 있는 실행 DB 를 FORCE 로 지우고 다시 만든다
      await admin.execInRunDb("INSERT INTO g02_order_ledger VALUES (1, 'r2', 1, 'success'); UPDATE g02_product SET stock = 7");
      const res = await createInvariantRunner({ connect, runDb: cfg.runDb, repoDir: REPO_ROOT }).run(g02);
      assert.ok(res.every((x) => x.severity === 'info' || x.passed === true), JSON.stringify(res));
      assert.deepEqual(res.at(-1)!.value, { success: 2, sold_out: 0, total: 2 });
    } finally {
      const c = await connect('postgres');
      try {
        await c.query(`DROP DATABASE IF EXISTS "${cfg.runDb}" WITH (FORCE)`);
        await c.query(`ALTER DATABASE "${tpl}" WITH is_template false`);
        await c.query(`DROP DATABASE IF EXISTS "${tpl}" WITH (FORCE)`);
      } finally {
        await c.end();
      }
    }
  });

  it('AC-5: configHash 는 같은 설정에서 같고 work_mem 이 바뀌면 달라진다', { skip: !reachable && 'PG 없음' }, async () => {
    const admin = createDbAdmin({ ...cfg, connect });
    const a = await admin.configHash();
    const b = await admin.configHash();
    assert.equal(a.hash, b.hash);
    assert.match(a.hash, /^sha256:[0-9a-f]{64}$/);
    assert.ok('work_mem' in a.settings && 'max_connections' in a.settings);
    const s = await connect('postgres');
    try {
      await s.query("ALTER DATABASE postgres SET work_mem = '7MB'");
    } finally {
      await s.end();
    }
    const c = await admin.configHash();
    assert.notEqual(a.hash, c.hash);
    assert.equal(c.settings.work_mem, '7168');
  });
});
