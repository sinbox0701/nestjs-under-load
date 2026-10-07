// G01 테스트 공용 도우미. 빌드 산출물(dist)을 불러 쓴다(`pnpm test`가 tsc 후 실행).
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);

const { MikroORM } = require('@mikro-orm/postgresql');
const { Migrator } = require('@mikro-orm/migrations');
const { Document } = require('../dist/entities/document.entity.js');
const { DocumentRevision } = require('../dist/entities/document-revision.entity.js');
const { EditLedger } = require('../dist/entities/edit-ledger.entity.js');
const { Migration20261007000100_g01_init } = require('../dist/migrations/Migration20261007000100_g01_init.js');
const { G01_STRATEGIES, resolveStrategy } = require('../dist/strategy-registry.js');
const { LedgerWriter } = require('../dist/support/ledger.writer.js');
const { NOOP_EVENT_SINK } = require('@under-load/contracts');

export { G01_STRATEGIES, resolveStrategy };

/** 지정 지점에서 ms만큼 기다리는 경합 창 훅(앱 쪽 구현의 테스트 대역). */
export function contentionWindow(delays = []) {
  const byPoint = new Map(delays.map((d) => [d.point, d.ms]));
  return async (point) => {
    const ms = byPoint.get(point);
    if (ms && ms > 0) await sleep(ms);
  };
}

/** emit 을 순서대로 적어 두는 EventSink */
export function recordingSink() {
  const events = [];
  return { enabled: true, events, emit: (phase, fields = {}) => events.push({ phase, ...fields }) };
}

/** 요청 하나의 StrategyContext. 실제 컨트롤러처럼 요청마다 em을 fork 한다. */
export function makeCtx(em, { params = {}, instance = 'app-1', delays = [], events = NOOP_EVENT_SINK } = {}) {
  return {
    em: em.fork(),
    params,
    instance,
    contentionWindow: contentionWindow(delays),
    ledger: new LedgerWriter(instance),
    events,
  };
}

export function makeStrategy(id) {
  const { cls, params } = resolveStrategy(id, undefined);
  return { strategy: new cls(), params };
}

/** 12자 수정 토큰 */
export const newToken = () => randomBytes(9).toString('base64url');

/**
 * C10 편집 모델의 저장 명령: 클라이언트가 읽은 필드 배열(`seen`) 중 `field` 뒤에 자기 토큰을 붙인다.
 * `seen` 은 GET 응답처럼 {version, fields} 모양.
 */
export function saveCmd(seen, { documentId = 1, field = 'a', version = seen.version, token = newToken() } = {}) {
  const fields = { a: [...seen.fields.a], b: [...seen.fields.b], c: [...seen.fields.c], d: [...seen.fields.d] };
  fields[field].push(token);
  return { requestId: randomUUID(), documentId, version, fields, editToken: token };
}

// ─────────────────────────────────────────────────────────────────────────────
// 실제 PostgreSQL(도커). 없으면 probe 가 실패하고 테스트는 skip 한다.
// 접속: G01_TEST_DATABASE_URL (기본: compose의 127.0.0.1:55432 superuser — 테스트 DB를 만들고 지운다)
// ─────────────────────────────────────────────────────────────────────────────
export const PG_URL = process.env.G01_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres_local@127.0.0.1:55432/postgres';

function baseOptions(dbName, poolMax) {
  return {
    clientUrl: PG_URL,
    dbName,
    entities: [Document, DocumentRevision, EditLedger],
    allowGlobalContext: true,
    pool: { min: 0, max: poolMax },
  };
}

/** 접속 가능하면 { ok: true }, 아니면 { ok: false, reason } */
export async function probePostgres(timeoutMs = 3000) {
  let orm;
  try {
    orm = await MikroORM.init({ ...baseOptions(new URL(PG_URL).pathname.slice(1) || 'postgres', 1), connect: false });
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

/** 테스트 전용 DB를 만들고 마이그레이션을 돌린다. `sql` 배열에 실행된 SQL(쿼리 로그)이 쌓인다. */
export async function createTestDatabase() {
  const adminDb = new URL(PG_URL).pathname.slice(1) || 'postgres';
  const name = `g01_it_${process.pid}_${Date.now()}`;
  const admin = await MikroORM.init(baseOptions(adminDb, 1));
  await admin.em.execute(`create database "${name}"`);
  const sql = [];
  const main = await MikroORM.init({
    ...baseOptions(name, 20),
    debug: ['query', 'query-params'],
    logger: (msg) => sql.push(msg),
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations_g01_test',
      snapshot: false,
      snapshotOnMigrate: false,
      migrationsList: [{ name: 'Migration20261007000100_g01_init', class: Migration20261007000100_g01_init }],
    },
  });
  await main.migrator.up();
  const q = (text, params = []) => main.em.fork().execute(text, params);
  return {
    name,
    main,
    sql,
    q,
    /** 표를 비우고 빈 문서 하나(version 1)를 만든다. */
    async reset(id = 1) {
      await q('truncate g01_edit_ledger, g01_document_revision restart identity');
      await q('delete from g01_document');
      await q('insert into g01_document (id) values (?)', [id]);
      sql.length = 0;
    },
    /** GET 응답처럼 {version, fields, editCount} */
    async read(id = 1) {
      const [r] = await q('select version, field_a, field_b, field_c, field_d, edit_count from g01_document where id = ?', [id]);
      return { version: r.version, fields: { a: r.field_a, b: r.field_b, c: r.field_c, d: r.field_d }, editCount: r.edit_count };
    },
    /** C10 no_lost_update: 원장 success 토큰 중 최종 문서 필드에 없는 수 */
    async lostUpdates() {
      const [r] = await q(`select count(*)::int as violations
        from g01_edit_ledger l join g01_document d on d.id = l.document_id
        where l.result = 'success'
          and not (l.edit_token = any(d.field_a || d.field_b || d.field_c || d.field_d))`);
      return r.violations;
    },
    async ledger() {
      return q('select request_id, edit_token, instance, txid::text as txid from g01_edit_ledger order by id');
    },
    async revisions() {
      return q('select request_id, edit_token, base_version, version, txid::text as txid from g01_document_revision order by id');
    },
    async drop() {
      await main.close(true).catch(() => {});
      await admin.em.execute(`drop database if exists "${name}" with (force)`).catch(() => {});
      await admin.close(true);
    },
  };
}
