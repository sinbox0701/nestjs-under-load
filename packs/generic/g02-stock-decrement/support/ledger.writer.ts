import type { EntityManager } from '@mikro-orm/postgresql';

import { OrderLedger, type OrderResult } from '../entities/order-ledger.entity';
import type { OrderCommand } from './strategy.types';

/**
 * 원장 기록기. 모든 strategy가 같은 방식(INSERT 1회)으로 쓰므로 원장 비용이 strategy 간에 같다.
 *
 * `em`은 strategy가 연 트랜잭션의 em을 넘겨야 한다. 트랜잭션 밖 em을 넘기면 재고 변경과
 * 원장 기록이 따로 커밋되어 불변식 판정 근거가 깨진다.
 */
export class LedgerWriter {
  constructor(private readonly instance: string) {}

  async record(em: EntityManager, cmd: OrderCommand, result: OrderResult): Promise<void> {
    // Unit of Work를 거치지 않는 단건 INSERT(identity map에 쌓지 않음). txid·created_at은 DB 기본값.
    await em.insert(OrderLedger, {
      requestId: cmd.requestId,
      productId: cmd.productId,
      qty: cmd.qty,
      result,
      instance: this.instance,
    });
  }
}
