// 관리자 권한 PG 작업(DbAdmin). 순서·SQL 은 scripts/run.mjs 의 초기화 단계를 이식했다.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunRequest } from '@under-load/contracts';

import type { DbAdmin, ScenarioDef } from '../ports.js';
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
  /** ScenarioDef.invariantsSqlPath 가 상대 경로일 때의 기준 디렉터리(레포 루트). 기본 process.cwd() */
  repoDir?: string;
  /** true 면 이미 있는 역할의 비밀번호도 덮어쓴다. 기본 false(없을 때만 비밀번호를 넣어 실행 중인 스택을 건드리지 않는다) */
  syncPasswords?: boolean;
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

/**
 * 팩 마이그레이션 폴더 해시(run.mjs hashDir 규칙: `.ts` 파일을 이름순으로 이름+내용). 폴더가 없으면 null.
 * 마이그레이션이 바뀌면 템플릿 이름이 바뀌어 새 템플릿을 만든다.
 */
export async function hashMigrationsDir(dir: string): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return null;
    throw e;
  }
  const h = createHash('sha256');
  for (const f of files.filter((x) => x.endsWith('.ts')).sort()) {
    h.update(f).update(await readFile(path.join(dir, f)));
  }
  return `sha256:${h.digest('hex')}`;
}

export function createDbAdmin(opts: DbAdminOptions): DbAdmin {
  const { connect, runDb, appUser } = opts;
  const exporterUser = opts.exporterUser ?? 'exporter';
  const exporterPassword = opts.exporterPassword ?? 'exporter_local';

  async function ensureRole(user: string, password: string, connLimit: number): Promise<void> {
    await withSession(connect, 'postgres', async (s) => {
      const exists = (await s.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user])).rows.length > 0;
      const base = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT ${connLimit}`;
      const attrs = !exists || opts.syncPasswords ? `${base} PASSWORD ${quoteLiteral(password)}` : base;
      await s.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${quoteIdent(user)} ${attrs}`);
      await s.query(`GRANT pg_monitor TO ${quoteIdent(user)}`);
    });
  }

  return {
    async templateName(scenario: ScenarioDef, data: RunRequest['data']) {
      const packDir = path.dirname(path.resolve(opts.repoDir ?? process.cwd(), scenario.invariantsSqlPath));
      const migrations = await hashMigrationsDir(path.join(packDir, 'migrations'));
      const hash = createHash('sha256')
        .update(stableJson({ scenario: scenario.id, seed: data.seed, seedOptions: data.seedOptions, migrations }))
        .digest('hex');
      return `tpl_${scenario.id.split('-')[0]}_${hash.slice(0, 12)}`;
    },

    async templateStatus(name) {
      return withSession(connect, 'postgres', async (s) => {
        const r = await s.query('SELECT datistemplate FROM pg_database WHERE datname = $1', [name]);
        return r.rows.length === 0 ? { exists: false, isTemplate: false } : { exists: true, isTemplate: r.rows[0]!.datistemplate === true };
      });
    },

    async createTemplateDb(name) {
      await withSession(connect, 'postgres', (s) => s.query(`CREATE DATABASE ${quoteIdent(name)} OWNER ${quoteIdent(appUser)}`));
    },

    async dropTemplateDb(name) {
      await withSession(connect, 'postgres', async (s) => {
        const r = await s.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
        if (r.rows.length === 0) return;
        // is_template=true 인 DB 는 지울 수 없으므로 표시를 먼저 푼다.
        await s.query(`ALTER DATABASE ${quoteIdent(name)} WITH is_template false`);
        await s.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
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
