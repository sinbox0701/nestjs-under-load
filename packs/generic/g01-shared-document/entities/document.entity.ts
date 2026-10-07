import { BigIntType, type Opt } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** 필드 a~d 각각이 마지막으로 바뀐 문서 버전. field-merge가 "같은 필드 충돌"을 판정하는 근거다. */
export type FieldVersions = { a: number; b: number; c: number; d: number };

/**
 * 공유 문서. 경합 대상 행이다. 이 테이블을 가리키는 엔티티 클래스는 이것 하나뿐이다
 * (같은 테이블에 클래스를 여러 개 두면 MikroORM `checkDuplicateTableNames`에 걸린다).
 *
 * - `version`은 낙관 락 컬럼이다(`@Property({ version: true })`). flush의 `UPDATE ... WHERE version = ?`가
 *   0행이면 `OptimisticLockError`가 난다. `naive-overwrite`가 쓰는 `nativeUpdate`는 WHERE에 version을
 *   걸지 않으므로 이 컬럼이 있어도 보호받지 못한다.
 * - `a`~`d`는 사용자가 편집하는 텍스트 배열이다. 편집 모델은 배열 뒤에 자기 수정 토큰을 붙이는 것이다.
 * - `lockedBy`·`leaseUntil`·`fence`는 `edit-lease` 전용이다. 다른 strategy는 건드리지 않는다.
 *   `leaseUntil`은 DB 시계(`clock_timestamp()`)로만 계산한다.
 */
@Entity({ tableName: 'g01_document' })
export class Document {
  @PrimaryKey({ type: 'integer', autoincrement: false })
  id!: number;

  @Property({ type: 'integer', version: true })
  version!: number & Opt;

  @Property({ type: 'text[]', columnType: 'text[]', fieldName: 'field_a', defaultRaw: `'{}'` })
  a!: string[] & Opt;

  @Property({ type: 'text[]', columnType: 'text[]', fieldName: 'field_b', defaultRaw: `'{}'` })
  b!: string[] & Opt;

  @Property({ type: 'text[]', columnType: 'text[]', fieldName: 'field_c', defaultRaw: `'{}'` })
  c!: string[] & Opt;

  @Property({ type: 'text[]', columnType: 'text[]', fieldName: 'field_d', defaultRaw: `'{}'` })
  d!: string[] & Opt;

  @Property({
    type: 'jsonb',
    fieldName: 'field_versions',
    defaultRaw: `'{"a":0,"b":0,"c":0,"d":0}'::jsonb`,
  })
  fieldVersions!: FieldVersions & Opt;

  /** 서버가 성공 처리한 수정 수. 불변식 `edit_count = 원장 success 행 수`의 한쪽. */
  @Property({ type: 'integer', fieldName: 'edit_count', default: 0 })
  editCount!: number & Opt;

  @Property({ type: 'text', fieldName: 'locked_by', nullable: true })
  lockedBy?: string | null;

  @Property({ type: 'timestamptz', fieldName: 'lease_until', nullable: true })
  leaseUntil?: Date | null;

  /** acquire마다 +1. 만료된 보유자의 늦은 save를 막는 fencing 토큰. BigIntType 기본 모드는 JS bigint 라 JSON 직렬화가 깨지므로 'string' 모드를 명시한다. */
  @Property({ type: new BigIntType('string'), default: 0 })
  fence!: string & Opt;
}
