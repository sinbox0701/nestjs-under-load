import type { EntityManager } from '@mikro-orm/postgresql';

export interface G02SeedOptions {
  /** 본 실행 대상 상품 수. id 1..products */
  products: number;
  /** 웜업 전용 상품 수. id products+1..products+warmupProducts (본 실행 재고를 건드리지 않게 분리) */
  warmupProducts: number;
  stockPerProduct: number;
}

/**
 * 결정적 시드: 같은 옵션이면 항상 같은 데이터. 난수를 쓰지 않는다.
 * (분포(균등/Zipf)는 데이터가 아니라 k6의 대상 선택 쪽 설정이다.)
 */
export async function seedG02(em: EntityManager, opts: G02SeedOptions): Promise<void> {
  const total = opts.products + opts.warmupProducts;
  await em.execute(
    `insert into "g02_product" ("id", "initial_stock", "stock")
     select g, ?, ? from generate_series(1, ?) as g
     on conflict ("id") do nothing`,
    [opts.stockPerProduct, opts.stockPerProduct, total],
  );
}
