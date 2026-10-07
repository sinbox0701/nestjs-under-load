import type { EntityManager } from '@mikro-orm/postgresql';

import { DocumentRevision } from '../entities/document-revision.entity';
import { EditLedger } from '../entities/edit-ledger.entity';
import type { EditLedgerWriter, SuccessRecord } from './strategy.types';

/**
 * 수정 원장·문서 이력 기록기. 모든 strategy가 같은 방식(INSERT 2회)으로 쓰므로 기록 비용이 strategy 간에 같다.
 *
 * `em`은 strategy가 연 트랜잭션의 em을 넘겨야 한다. 트랜잭션 밖 em을 넘기면 문서 UPDATE와
 * 원장·이력이 따로 커밋되어 불변식 판정 근거가 깨진다. 같은 트랜잭션이면 두 행의 `txid`
 * (DB 기본값 `pg_current_xact_id()`)가 같고, 문서 UPDATE가 남긴 행의 `xmin`과도 같다.
 */
export class LedgerWriter implements EditLedgerWriter {
  constructor(private readonly instance: string) {}

  async recordSuccess(em: EntityManager, rec: SuccessRecord): Promise<void> {
    // Unit of Work를 거치지 않는 단건 INSERT(identity map에 쌓지 않음). id·txid·created_at은 DB 기본값.
    await em.insert(EditLedger, {
      requestId: rec.requestId,
      documentId: rec.documentId,
      editToken: rec.editToken,
      result: 'success',
      instance: this.instance,
    });
    await em.insert(DocumentRevision, {
      documentId: rec.documentId,
      editToken: rec.editToken,
      requestId: rec.requestId,
      baseVersion: rec.baseVersion,
      version: rec.version,
    });
  }
}
