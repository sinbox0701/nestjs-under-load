import type { EntityManager } from '@mikro-orm/postgresql';

/** (interface가 아니라 type: 팩 진입점이 `Record<string, number>`와 양변성으로 맞으려면 암묵 인덱스 시그니처가 필요하다) */
export type G01SeedOptions = {
  /** 문서 수(1~100). id 1..documents. 충돌 밀도는 문서 수와 k6의 대상 선택(Zipf) 쪽 설정이 정한다. */
  documents: number;
};

/**
 * 결정적 시드: 같은 옵션이면 항상 같은 데이터. 난수를 쓰지 않는다.
 * 문서는 빈 필드·version 1·수정 0건으로 시작한다(나머지 컬럼은 DB 기본값). 원장·이력은 비어 있다.
 */
export async function seedG01(em: EntityManager, opts: G01SeedOptions): Promise<void> {
  if (!Number.isInteger(opts.documents) || opts.documents < 1 || opts.documents > 100) {
    throw new Error(`g01: seed documents는 1~100 정수여야 합니다(받은 값: ${opts.documents})`);
  }
  await em.execute(
    `insert into "g01_document" ("id") select g from generate_series(1, ?) as g on conflict ("id") do nothing`,
    [opts.documents],
  );
}
