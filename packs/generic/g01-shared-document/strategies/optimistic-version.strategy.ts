import { LockMode, OptimisticLockError } from '@mikro-orm/postgresql';

import { Document } from '../entities/document.entity';
import type { G01Strategy, SaveCommand, SaveOutcome, StrategyContext } from '../support/strategy.types';

/**
 * optimistic-version — 버전 감지(낙관 락) (kind: fixed)
 *
 * 이 코드가 하는 일
 * - 클라이언트는 화면을 열 때(GET) 받은 version을 본문에 실어 PUT 한다. 컨트롤러가 누락은 428로 거절하고 number로 바꿔 넘긴다.
 * - 트랜잭션 안에서 `findOneOrFail(..., { lockMode: LockMode.OPTIMISTIC, lockVersion })`으로 문서를 읽는다.
 *   **실패 지점 ①**: 읽어 온 엔티티의 version과 lockVersion을 메모리에서 `!==`로 비교한다. 다르면 OptimisticLockError.
 *   락 SQL이 아니다(SELECT 한 번뿐). 동시에 도착한 두 저장은 둘 다 이 비교를 통과할 수 있다.
 * - 필드를 바꾸고 flush 하면 `UPDATE g01_document SET …, version = version + 1 WHERE id = ? AND version = ?`가 나간다.
 *   **실패 지점 ②**(진짜 동시성 보장): 영향 행이 0이면 MikroORM이 OptimisticLockError로 바꾼다.
 * - 같은 트랜잭션에서 원장·문서 이력을 INSERT 하고 커밋한다. 실패하면 롤백되어 원장에 아무것도 남지 않는다.
 * - ①②는 모두 `version_mismatch`(409)다. 트랜잭션 밖에서 현재 version을 다시 읽어 `currentVersion`으로 돌려준다.
 *
 * 왜 맞나
 * - PostgreSQL READ COMMITTED의 UPDATE는 대상 행이 다른 트랜잭션에 잠겨 있으면 기다렸다가, 그쪽이 커밋하면
 *   **최신 행으로 WHERE를 다시 평가**(EvalPlanQual)한다. 앞사람이 version을 올렸으므로 `version = ?`가 거짓 → 0행.
 *   그래서 같은 버전을 읽은 저장 중 정확히 하나만 성공한다.
 * - 이 보호는 flush 경로에만 있다. 같은 문서를 nativeUpdate 같은 다른 경로로 쓰면 그 경로는 version을 보지 않는다(naive-overwrite).
 *
 * 언제 깨지나(정합성은 지키지만 거절이 늘어난다)
 * - 같은 문서를 다투는 사람이 많을수록 409가 늘고 성공 처리량은 줄어든다. 409를 받은 쪽은 다시 GET → 내 변경을 최신본에
 *   다시 적용 → 새 버전으로 PUT 해야 한다. 버전만 바꿔 같은 본문을 다시 보내면 앞사람 수정이 사라진다(blind-retry).
 * - lockVersion이 undefined면 검사가 생략되고, 문자열 '3'은 숫자 3과 `!==`라서 늘 불일치다. 그래서 SaveCommand.version은
 *   number로만 받고, 변환·검증은 호출 측(컨트롤러) 몫이다.
 */
export class OptimisticVersionStrategy implements G01Strategy {
  readonly id: string = 'optimistic-version';

  async save(cmd: SaveCommand, ctx: StrategyContext): Promise<SaveOutcome> { // @event arrived
    const entity = { type: 'Document', id: String(cmd.documentId) };
    ctx.events.emit('arrived', { entity });
    let at: 'lockVersion' | 'flush' = 'lockVersion'; // OptimisticLockError가 난 지점(①/②). 이벤트·학습용
    try {
      const outcome = await ctx.em.transactional(async (em) => { // @learn tx-boundary — UPDATE와 원장·이력 INSERT를 한 트랜잭션에 묶는다. 실패하면 함께 롤백되어 원장에 남지 않는다
        const doc = await em.findOneOrFail(Document, cmd.documentId, { // @event db_read
          lockMode: LockMode.OPTIMISTIC, // @learn lock-optimistic — 락 SQL이 아니다. 읽어 온 엔티티 version과 lockVersion을 메모리에서 비교만 한다(실패 지점 ①)
          lockVersion: cmd.version, // @learn lock-version-strict — `!==` 엄격 비교. undefined면 검사 생략, 문자열 '3'은 3과 불일치. 그래서 number만 받는다
        });
        ctx.events.emit('db_read', { entity });
        const afterRead = await ctx.contentionWindow('after-read'); // @event injected_delay
        if (afterRead?.injected) ctx.events.emit('injected_delay', { entity, injected: true, durMs: afterRead.durMs });
        em.assign(doc, { ...cmd.fields, editCount: doc.editCount + 1 });
        const beforeWrite = await ctx.contentionWindow('before-write'); // @event injected_delay
        if (beforeWrite?.injected) ctx.events.emit('injected_delay', { entity, injected: true, durMs: beforeWrite.durMs });
        at = 'flush';
        // @learn flush-where-version — UPDATE … SET version = version + 1 WHERE id = ? AND version = ?. 0행이면 OptimisticLockError(실패 지점 ②, 진짜 동시성 보장)
        await em.flush(); // @event db_write
        ctx.events.emit('db_write', { entity });
        await ctx.ledger.recordSuccess(em, { // @learn ledger-same-tx — 원장·이력 INSERT는 flush 뒤, 같은 트랜잭션에서. 409면 여기까지 오지 않는다
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
      if (!(err instanceof OptimisticLockError)) throw err;
      // @learn two-failure-points — ①(메모리 비교)·②(flush 0행) 모두 409 version_mismatch. currentVersion은 트랜잭션 밖에서 다시 읽는다
      const current = await ctx.em.fork().findOneOrFail(Document, cmd.documentId); // @event conflict
      ctx.events.emit('conflict', { entity, attrs: { reason: 'version_mismatch', at, sentVersion: cmd.version, currentVersion: current.version } });
      return { ok: false, reason: 'version_mismatch', currentVersion: current.version };
    }
  }
}
