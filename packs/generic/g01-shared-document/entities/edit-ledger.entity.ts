import type { Opt } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

export type EditResult = 'success' | 'conflict';

/**
 * 수정 원장. 불변식 판정의 유일한 근거다(DESIGN §3 원칙 1).
 *
 * - 요청 1건 = 행 1개(`request_id` 유니크). 실패(예외·롤백)는 남지 않는다.
 * - `txid`는 DB 기본값 `pg_current_xact_id()`. 문서 UPDATE와 같은 트랜잭션에서 기록됐는지 확인하는 단서다.
 * - 원장 쓰기 비용은 모든 strategy에 똑같이 붙는다.
 */
@Entity({ tableName: 'g01_edit_ledger' })
export class EditLedger {
  @PrimaryKey({ type: 'bigint' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'request_id', unique: true })
  requestId!: string;

  @Property({ type: 'integer', fieldName: 'document_id' })
  documentId!: number;

  @Property({ type: 'text', fieldName: 'edit_token' })
  editToken!: string;

  @Property({ type: 'text' })
  result!: EditResult;

  @Property({ type: 'text' })
  instance!: string;

  @Property({ type: 'bigint', defaultRaw: 'pg_current_xact_id()::text::bigint' })
  txid!: string & Opt;

  @Property({ type: 'timestamptz', fieldName: 'created_at', defaultRaw: 'clock_timestamp()' })
  createdAt!: Date & Opt;
}
