import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';

import type { Env } from '../config/env';
import type { ScenarioPack } from '../packs/registry';

/**
 * MikroORM 옵션. 엔티티는 선택된 팩 것만 등록한다.
 * 스키마는 템플릿 DB를 만들 때 마이그레이션으로 생성하고, app 부팅 시에는 동기화하지 않는다.
 */
export function buildOrmOptions(
  env: Env,
  pack: ScenarioPack,
  pool: { min: number; max: number },
) {
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
    // 풀 acquire 타임아웃·계측(onPoolCreated)은 1단계(DESIGN §14 #5).
    pool: { min: pool.min, max: pool.max },
    migrations: {
      tableName: `mikro_orm_migrations_${pack.id.replace(/[^a-z0-9]/gi, '_')}`,
      migrationsList: pack.migrations,
      disableForeignKeys: false,
    },
    extensions: [Migrator],
  });
}
