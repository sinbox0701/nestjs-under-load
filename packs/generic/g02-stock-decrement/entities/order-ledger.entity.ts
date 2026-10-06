import type { Opt } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

export type OrderResult = 'success' | 'sold_out';

/**
 * 주문 원장. 불변식 판정의 유일한 근거다(DESIGN §3 원칙 1).
 *
 * - 요청 1건 = 행 1개(`request_id` 유니크). 성공·품절 모두 남기고, 실패(예외·롤백)는 남지 않는다.
 * - `txid`는 행을 쓴 트랜잭션 ID(DB 기본값 `pg_current_xact_id()`). 같은 트랜잭션에서 재고 차감과
 *   원장 기록이 함께 커밋됐는지 사후에 확인하는 단서다.
 * - 원장 쓰기 비용은 모든 strategy에 똑같이 붙는다.
 */
@Entity({ tableName: 'g02_order_ledger' })
export class OrderLedger {
  @PrimaryKey({ type: 'bigint' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'request_id', unique: true })
  requestId!: string;

  @Property({ type: 'integer', fieldName: 'product_id' })
  productId!: number;

  @Property({ type: 'integer' })
  qty!: number;

  @Property({ type: 'text' })
  result!: OrderResult;

  @Property({ type: 'text' })
  instance!: string;

  @Property({ type: 'bigint', defaultRaw: 'pg_current_xact_id()::text::bigint' })
  txid!: string & Opt;

  @Property({ type: 'timestamptz', fieldName: 'created_at', defaultRaw: 'clock_timestamp()' })
  createdAt!: Date & Opt;
}
