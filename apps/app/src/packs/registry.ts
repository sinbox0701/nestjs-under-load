import type { DynamicModule } from '@nestjs/common';
import type { MigrationObject } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

/** 팩 진입점이 맞춰야 하는 형태. 엔진 추출(2단계) 전까지의 임시 계약이다. */
export interface ScenarioPack {
  id: string;
  entities: Function[];
  migrations: MigrationObject[];
  strategyIds: string[];
  createModule(opts: {
    strategy: string;
    strategyParams?: unknown;
    instance: string;
    injectDelay?: { point: string; ms: number }[];
    /** RunConfig.redis(C1). Redis 를 쓰는 팩만 읽는다(g02 redis-lock). null = 시나리오가 안 씀. */
    redis?: { host: string; port: number } | null;
  }): DynamicModule;
  seed(em: EntityManager, opts: Record<string, number>): Promise<void>;
}

/**
 * 시나리오 id → 팩 로더. 선택된 시나리오의 팩만 동적 import한다(DESIGN §6.4: 다른 시나리오 엔티티는 등록하지 않음).
 */
const loaders: Record<string, () => Promise<ScenarioPack>> = {
  'g01-shared-document': async () =>
    (await import('@under-load/g01-shared-document')).scenarioPack as unknown as ScenarioPack,
  'g02-stock-decrement': async () =>
    (await import('@under-load/g02-stock-decrement')).scenarioPack as unknown as ScenarioPack,
};

export async function loadPack(scenario: string): Promise<ScenarioPack> {
  const loader = loaders[scenario];
  if (!loader) {
    throw new Error(`알 수 없는 scenario '${scenario}'. 가능: ${Object.keys(loaders).join(', ')}`);
  }
  return loader();
}
