import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { InstrumentationLevel, RunConfigV1 } from '@under-load/contracts';

import type { Env } from '../config/env';
import { ormHooks, type PoolLike, poolHooks } from '../metrics';
import type { ScenarioPack } from '../packs/registry';

/** RunConfig.pool(C1). acquireTimeoutMs 가 없거나 null 이면 pg 기본값(무한 대기). */
export type OrmPoolOptions = Pick<RunConfigV1['pool'], 'min' | 'max'> & { acquireTimeoutMs?: number | null };

export interface OrmRuntimeOptions {
  /** RunConfig.timeouts(C1). null 이면 PG 서버 기본값 그대로 둔다. */
  timeouts?: Pick<RunConfigV1['timeouts'], 'statementMs' | 'idleInTxMs'>;
  /** 계측 수준(C6). 있으면 풀·ORM 훅을 붙인다. MetricsModule 과 같은 수준이어야 한다(getLabMetrics 공유). */
  instrumentation?: InstrumentationLevel;
  /** pg 풀이 만들어지면 호출(이벤트 배치의 pool 필드용). 계측 수준과 무관하게 불린다. */
  onPoolCreated?: (pool: PoolLike) => void;
}

/**
 * pg Pool 설정에 그대로 합쳐지는 driverOptions(MikroORM 7: PostgreSqlConnection.createKyselyDialect 가
 * onPoolCreated 를 떼고 나머지를 Pool 옵션에 병합한다).
 * - connectionTimeoutMillis: pg-pool 의 acquire 타임아웃(빈 연결을 기다리는 시간 포함)
 * - statement_timeout·idle_in_transaction_session_timeout: pg Client 가 접속할 때 세션 파라미터로 보낸다
 */
export function buildDriverOptions(pool: OrmPoolOptions, runtime: OrmRuntimeOptions = {}): Record<string, unknown> {
  const hooks = runtime.instrumentation ? poolHooks(runtime.instrumentation) : {};
  const onPoolCreated =
    hooks.onPoolCreated || runtime.onPoolCreated
      ? (p: Parameters<NonNullable<typeof hooks.onPoolCreated>>[0]) => {
          hooks.onPoolCreated?.(p);
          runtime.onPoolCreated?.(p);
        }
      : undefined;
  const out: Record<string, unknown> = {};
  if (onPoolCreated) out.onPoolCreated = onPoolCreated;
  if (pool.acquireTimeoutMs != null) out.connectionTimeoutMillis = pool.acquireTimeoutMs;
  if (runtime.timeouts?.statementMs != null) out.statement_timeout = runtime.timeouts.statementMs;
  if (runtime.timeouts?.idleInTxMs != null) out.idle_in_transaction_session_timeout = runtime.timeouts.idleInTxMs;
  return out;
}

/**
 * MikroORM 옵션. 엔티티는 선택된 팩 것만 등록한다.
 * 스키마는 템플릿 DB를 만들 때 마이그레이션으로 생성하고, app 부팅 시에는 동기화하지 않는다.
 * runtime 을 생략하면(템플릿 준비 CLI·task) 타임아웃·계측 없이 0단계와 같은 옵션이 나온다.
 */
export function buildOrmOptions(env: Env, pack: ScenarioPack, pool: OrmPoolOptions, runtime: OrmRuntimeOptions = {}) {
  const orm = runtime.instrumentation ? ormHooks(runtime.instrumentation) : { subscribers: [] };
  return defineConfig({
    driver: PostgreSqlDriver,
    metadataProvider: ReflectMetadataProvider,
    entities: pack.entities,
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    dbName: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    forceUtcTimezone: true,
    // 요청 컨텍스트 밖 전역 em 사용을 막는다. 요청마다 fork를 쓴다(DESIGN §6.3).
    allowGlobalContext: false,
    pool: { min: pool.min, max: pool.max },
    driverOptions: buildDriverOptions(pool, runtime),
    subscribers: orm.subscribers,
    ...(orm.loggerFactory ? { loggerFactory: orm.loggerFactory } : {}),
    migrations: {
      tableName: `mikro_orm_migrations_${pack.id.replace(/[^a-z0-9]/gi, '_')}`,
      migrationsList: pack.migrations,
      disableForeignKeys: false,
    },
    extensions: [Migrator],
  });
}
