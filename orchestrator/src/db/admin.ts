// 관리자 권한 PG 작업(DbAdmin). 순서·SQL 은 scripts/run.mjs 의 초기화 단계를 이식했다.
import { createHash } from 'node:crypto';

import type { RunRequest } from '@under-load/contracts';

import type { DbAdmin } from '../ports.js';
import { type PgConnect, quoteIdent, quoteLiteral, withSession } from './pg.js';

export type DbAdminOptions = {
  connect: PgConnect;
  /** 실행 DB 이름(기본 lab_run) */
  runDb: string;
  /** 실행·템플릿 DB 소유자(lab_app) */
  appUser: string;
  observerUser: string;
  observerPassword: string;
  /** 기본 exporter */
  exporterUser?: string;
  /** 기본 exporter_local(compose 의 EXPORTER_PASSWORD 와 같게 배선이 넘긴다) */
  exporterPassword?: string;
};

/** pg_stat_reset_shared 인자 7종(PG17). */
export const PG_SHARED_STATS = ['archiver', 'bgwriter', 'checkpointer', 'io', 'recovery_prefetch', 'slru', 'wal'] as const;

/** 키 순서에 상관없는 JSON(해시용). */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function createDbAdmin(opts: DbAdminOptions): DbAdmin {
  const { connect, runDb, appUser } = opts;
  const exporterUser = opts.exporterUser ?? 'exporter';
  const exporterPassword = opts.exporterPassword ?? 'exporter_local';

  async function ensureRole(user: string, password: string, connLimit: number): Promise<void> {
    await withSession(connect, 'postgres', async (s) => {
      const exists = (await s.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user])).rows.length > 0;
      const attrs = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT ${connLimit} PASSWORD ${quoteLiteral(password)}`;
      await s.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${quoteIdent(user)} ${attrs}`);
      await s.query(`GRANT pg_monitor TO ${quoteIdent(user)}`);
    });
  }

  return {
    templateName(scenarioId, data: RunRequest['data']) {
      const hash = createHash('sha256')
        .update(stableJson({ scenario: scenarioId, seed: data.seed, seedOptions: data.seedOptions }))
        .digest('hex');
      return `tpl_${scenarioId.split('-')[0]}_${hash.slice(0, 12)}`;
    },

    async templateStatus(name) {
      return withSession(connect, 'postgres', async (s) => {
        const r = await s.query('SELECT datistemplate FROM pg_database WHERE datname = $1', [name]);
        return r.rows.length === 0 ? { exists: false, isTemplate: false } : { exists: true, isTemplate: r.rows[0]!.datistemplate === true };
      });
    },

    async markTemplate(name) {
      await withSession(connect, 'postgres', (s) => s.query(`ALTER DATABASE ${quoteIdent(name)} WITH is_template true allow_connections false`));
    },

    async resetRunDb(templateDb) {
      const run = quoteIdent(runDb);
      await withSession(connect, 'postgres', async (s) => {
        await s.query(`DROP DATABASE IF EXISTS ${run} WITH (FORCE)`);
        await s.query(`CREATE DATABASE ${run} OWNER ${quoteIdent(appUser)} TEMPLATE ${quoteIdent(templateDb)}`);
      });
      await withSession(connect, runDb, (s) => s.query('VACUUM ANALYZE'));
      await withSession(connect, 'postgres', async (s) => {
        await s.query('CHECKPOINT');
        await s.query('SELECT pg_stat_statements_reset()');
      });
      await withSession(connect, runDb, (s) => s.query('SELECT pg_stat_reset()'));
      await withSession(connect, 'postgres', async (s) => {
        for (const t of PG_SHARED_STATS) await s.query(`SELECT pg_stat_reset_shared('${t}')`);
      });
    },

    async execInRunDb(sql) {
      await withSession(connect, runDb, (s) => s.query(sql));
    },

    async ensureRoles() {
      await ensureRole(opts.observerUser, opts.observerPassword, 2);
      await ensureRole(exporterUser, exporterPassword, 3);
    },

    async configHash() {
      return withSession(connect, 'postgres', async (s) => {
        const r = await s.query('SELECT name, setting FROM pg_settings ORDER BY name');
        const settings: Record<string, string> = {};
        for (const row of r.rows) settings[String(row.name)] = String(row.setting);
        return { hash: `sha256:${createHash('sha256').update(stableJson(settings)).digest('hex')}`, settings };
      });
    },
  };
}
