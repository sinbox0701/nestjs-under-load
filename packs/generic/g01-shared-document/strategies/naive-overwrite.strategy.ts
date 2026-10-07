import { raw } from '@mikro-orm/postgresql';

import { Document } from '../entities/document.entity';
import type { G01Strategy, SaveCommand, SaveOutcome, StrategyContext } from '../support/strategy.types';

/**
 * naive-overwrite — 버전 조건 없는 덮어쓰기 (kind: broken, 일부러 깨지는 기준선)
 *
 * 이 코드가 하는 일
 * - 클라이언트는 화면을 열 때(GET) 받은 version을 본문에 실어 PUT 한다. 이 strategy는 그 값을 **보지 않는다**.
 * - 트랜잭션을 열고 `em.nativeUpdate`로 `UPDATE g01_document SET field_a.. = ?, edit_count = edit_count + 1
 *   WHERE id = ?`를 바로 보낸다. Unit of Work를 거치지 않으므로 낙관 락 검사도 없다.
 * - 같은 트랜잭션에서 원장(요청 ID·수정 토큰·txid)과 문서 이력(document_revision)을 INSERT 하고 커밋한다.
 *
 * 왜 이렇게 두나
 * - "읽고 → 고치고 → 저장"을 가장 짧게 짠 코드다. 혼자 쓰면 맞고, 둘이 같은 버전을 읽고 저장하면
 *   어떻게 틀리는지 보이는 기준선으로 쓴다.
 * - 엔티티에 `version: true`가 있어도 소용없다. 그 보호는 flush가 만드는 `UPDATE … WHERE version = ?`에만 있고,
 *   nativeUpdate의 WHERE에는 version이 없다. 버전 값은 올라가지만 아무도 비교하지 않는다.
 *
 * 언제 깨지나
 * - 두 사람이 같은 version을 읽고 각자 저장하면 둘 다 200이다. 뒤에 온 UPDATE는 앞 트랜잭션의 행 잠금을 기다렸다가
 *   최신 행으로 `WHERE id = ?`를 다시 평가(EvalPlanQual)하는데, 조건이 id뿐이라 그대로 통과해 앞사람 배열을 통째로 덮는다.
 * - 결과: 원장엔 두 수정 토큰이 다 커밋됐는데 최종 문서엔 한쪽 토큰이 없다(no_lost_update 위반). 응답은 전부 200이라
 *   클라이언트는 덮어쓰였는지 알 수 없다.
 * - 트랜잭션 격리 수준을 올려도(SERIALIZABLE) 못 막는다. 읽기(GET)와 저장이 다른 트랜잭션이고 그 사이에 사람의 편집 시간이 있다.
 */
export class NaiveOverwriteStrategy implements G01Strategy {
  readonly id = 'naive-overwrite';

  async save(cmd: SaveCommand, ctx: StrategyContext): Promise<SaveOutcome> { // @event arrived
    const entity = { type: 'Document', id: String(cmd.documentId) };
    ctx.events.emit('arrived', { entity });
    try {
      const outcome = await ctx.em.transactional(async (em) => { // @learn tx-boundary — UPDATE와 원장·이력 INSERT를 한 트랜잭션에 묶는다. 트랜잭션만으로는 덮어쓰기를 막지 못한다
        const afterRead = await ctx.contentionWindow('after-read'); // @event injected_delay
        if (afterRead?.injected) ctx.events.emit('injected_delay', { entity, injected: true, durMs: afterRead.durMs });
        const beforeWrite = await ctx.contentionWindow('before-write'); // @event injected_delay
        if (beforeWrite?.injected) ctx.events.emit('injected_delay', { entity, injected: true, durMs: beforeWrite.durMs });
        const rows = await em.nativeUpdate( // @event db_write
          Document,
          { id: cmd.documentId }, // @learn where-id-only — WHERE에 version이 없다. cmd.version을 보지 않으므로 늦게 쓴 쪽이 이긴다(last-write-wins)
          { ...cmd.fields, editCount: raw('edit_count + 1') }, // @learn native-bypasses-version — nativeUpdate는 Unit of Work를 거치지 않는다. SET version = version + 1로 올리기만 하고 비교하지 않으니 낙관 락이 무력하다
        );
        ctx.events.emit('db_write', { entity, rows });
        const doc = await em.findOneOrFail(Document, cmd.documentId, { refresh: true }); // 저장 후 version(응답·이력용). nativeUpdate는 영향 행 수만 돌려준다. 없는 문서면 NotFoundError
        await ctx.ledger.recordSuccess(em, { // @learn ledger-same-tx — 원장·이력 INSERT는 모든 strategy가 같은 비용으로 같은 트랜잭션에서 한다
          requestId: cmd.requestId,
          documentId: cmd.documentId,
          editToken: cmd.editToken,
          baseVersion: cmd.version,
          version: doc.version,
        });
        return { ok: true as const, version: doc.version };
      }); // @event committed rolled_back
      ctx.events.emit('committed', { entity });
      return outcome;
    } catch (err) {
      ctx.events.emit('rolled_back', { entity });
      throw err;
    }
  }
}
