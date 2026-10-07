import { MikroORM } from '@mikro-orm/postgresql';

import type { Env } from '../config/env';
import { buildOrmOptions } from '../database/orm-options';
import type { ScenarioPack } from '../packs/registry';

export interface PreparedResult {
  database: string;
  durationMs: number;
}

/** seedOptions(unknown 레코드) → 팩 seed 가 받는 정수 맵. cli/prepare-template.ts 의 --seed-opt 와 같은 규칙. */
export function toSeedOptions(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new Error(`prepareTemplate.seedOptions.${k} 는 정수여야 한다: ${JSON.stringify(v)}`);
    }
    out[k] = v;
  }
  return out;
}

/**
 * task=prepare-template: 템플릿 DB(database)에 팩 마이그레이션을 적용하고 결정적 시드를 넣는다(DESIGN §6.4).
 * DB 자체는 오케스트레이터가 미리 만들어 둔다. 전용 ORM 을 잠깐 열고 닫으므로 서비스용 ORM 과 섞이지 않는다.
 */
export async function prepareTemplate(
  env: Env,
  pack: ScenarioPack,
  prepare: { database: string; seedOptions: Record<string, unknown> },
): Promise<PreparedResult> {
  const started = performance.now();
  const seedOptions = toSeedOptions(prepare.seedOptions);
  const options = buildOrmOptions({ ...env, POSTGRES_DB: prepare.database }, pack, { min: 1, max: 2 });
  const orm = await MikroORM.init({
    ...options,
    allowGlobalContext: true,
    // 기본값(snapshotOnMigrate)이면 up() 때마다 작업 폴더에 .snapshot-<db>.json 이 생긴다.
    migrations: { ...options.migrations, snapshot: false },
  });
  try {
    await orm.migrator.up();
    await pack.seed(orm.em.fork(), seedOptions);
  } finally {
    await orm.close(true);
  }
  return { database: prepare.database, durationMs: Math.round(performance.now() - started) };
}
