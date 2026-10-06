import type { EntityManager } from '@mikro-orm/postgresql';
import type { DynamicModule } from '@nestjs/common';

import { OrderLedger } from './entities/order-ledger.entity';
import { Product } from './entities/product.entity';
import { Migration20261007000000_g02_init } from './migrations/Migration20261007000000_g02_init';
import { G02Module, type G02ModuleOptions } from './module';
import { type G02SeedOptions, seedG02 } from './seed';
import { G02_STRATEGIES } from './strategy-registry';

export { G02Module, G02_STRATEGIES };
export type { G02ModuleOptions, G02SeedOptions };

/**
 * 팩 진입점. app(호스트)은 RunConfig의 scenario에 해당하는 팩만 동적 import한다(DESIGN §6.4).
 * 형태는 app의 `ScenarioPack` 인터페이스와 구조적으로 맞춘다(팩이 app을 import하지 않게).
 */
export const scenarioPack = {
  id: 'g02-stock-decrement',
  entities: [Product, OrderLedger],
  migrations: [{ name: 'Migration20261007000000_g02_init', class: Migration20261007000000_g02_init }],
  strategyIds: Object.keys(G02_STRATEGIES),
  createModule: (opts: G02ModuleOptions): DynamicModule => G02Module.register(opts),
  seed: (em: EntityManager, opts: G02SeedOptions): Promise<void> => seedG02(em, opts),
};
