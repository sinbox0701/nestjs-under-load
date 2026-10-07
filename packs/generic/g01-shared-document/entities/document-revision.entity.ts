import { BigIntType, type Opt } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * 문서 이력. append-only(UPDATE·DELETE 하지 않는다).
 *
 * 성공한 수정 1건 = 행 1개. "재적용"과 lost update 판정은 이 이력의 `editToken`으로 정의한다.
 * 문서 저장과 같은 트랜잭션에서 INSERT 해야 하며, `txid`로 그 사실을 사후에 확인한다.
 */
@Entity({ tableName: 'g01_document_revision' })
export class DocumentRevision {
  @PrimaryKey({ type: new BigIntType('string') })
  id!: string;

  @Property({ type: 'integer', fieldName: 'document_id' })
  documentId!: number;

  /** 이 수정이 배열 뒤에 붙인 토큰(12자) */
  @Property({ type: 'text', fieldName: 'edit_token' })
  editToken!: string;

  @Property({ type: 'uuid', fieldName: 'request_id' })
  requestId!: string;

  /** 클라이언트가 읽고 온 버전 */
  @Property({ type: 'integer', fieldName: 'base_version' })
  baseVersion!: number;

  /** 저장 후 문서 버전 */
  @Property({ type: 'integer' })
  version!: number;

  @Property({ type: new BigIntType('string'), defaultRaw: 'pg_current_xact_id()::text::bigint' })
  txid!: string & Opt;

  @Property({ type: 'timestamptz', fieldName: 'created_at', defaultRaw: 'clock_timestamp()' })
  createdAt!: Date & Opt;
}
