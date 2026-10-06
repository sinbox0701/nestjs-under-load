import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * 재고를 가진 상품. 경합 대상 행이다.
 *
 * `initialStock`은 시드 시점 재고를 그대로 보존한다. 불변식
 * `initial_stock - stock = 원장 성공 수량 합`의 기준값이므로 실행 중에는 바꾸지 않는다.
 */
@Entity({ tableName: 'g02_product' })
export class Product {
  @PrimaryKey({ type: 'integer', autoincrement: false })
  id!: number;

  @Property({ type: 'integer', fieldName: 'initial_stock' })
  initialStock!: number;

  @Property({ type: 'integer' })
  stock!: number;
}
