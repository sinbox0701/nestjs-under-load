import type { DynamicModule } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';

import { DocumentRevision } from './entities/document-revision.entity';
import { Document } from './entities/document.entity';
import { EditLedger } from './entities/edit-ledger.entity';
import { Migration20261007000100_g01_init } from './migrations/Migration20261007000100_g01_init';
import { G01Module, type G01ModuleOptions } from './module';
import { type G01SeedOptions, seedG01 } from './seed';
import { G01_STRATEGIES } from './strategy-registry';

export { G01Module, G01_STRATEGIES };
export type { G01ModuleOptions, G01SeedOptions };

/**
 * 팩 진입점. app(호스트)은 RunConfig의 scenario에 해당하는 팩만 동적 import한다(DESIGN §6.4).
 * 형태는 app의 `ScenarioPack` 인터페이스와 구조적으로 맞춘다(팩이 app을 import하지 않게).
 * `seed`·`createModule`은 메서드 문법이다: 옵션 타입이 팩마다 달라 인터페이스의 `Record<string, number>`와 매개변수 양변성으로만 맞는다.
 */
export const scenarioPack = {
  id: 'g01-shared-document',
  entities: [Document, DocumentRevision, EditLedger],
  migrations: [{ name: 'Migration20261007000100_g01_init', class: Migration20261007000100_g01_init }],
  strategyIds: Object.keys(G01_STRATEGIES),
  createModule(opts: G01ModuleOptions): DynamicModule {
    return G01Module.register(opts);
  },
  seed(em: EntityManager, opts: G01SeedOptions): Promise<void> {
    return seedG01(em, opts);
  },
};
