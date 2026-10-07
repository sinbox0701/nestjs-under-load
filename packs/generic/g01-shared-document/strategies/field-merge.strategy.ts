import { NotFoundError, raw } from '@mikro-orm/postgresql';

import { Document } from '../entities/document.entity';
import type {
  FieldName,
  G01Strategy,
  PatchCommand,
  SaveCommand,
  SaveOutcome,
  StrategyContext,
} from '../support/strategy.types';

const FIELDS: readonly FieldName[] = ['a', 'b', 'c', 'd'];

type Mismatch = Extract<SaveOutcome, { reason: 'version_mismatch' }>;

/** 조건부 UPDATE 가 0행일 때 트랜잭션을 롤백시키려고 던진다. 바깥 catch 가 값(SaveOutcome)으로 바꾼다. */
class FieldConflict extends Error {
  readonly outcome: Mismatch;
  readonly attrs: Record<string, string | number | boolean | null>;
  constructor(outcome: Mismatch, attrs: Record<string, string | number | boolean | null>) {
    super(outcome.reason);
    this.outcome = outcome;
    this.attrs = attrs;
  }
}

/**
 * field-merge — 필드별 조건부 UPDATE (kind: tradeoff)
 *
 * 이 코드가 하는 일
 * - 클라이언트는 화면을 열 때(GET) 받은 version 과 함께 **바뀐 필드 하나만** PATCH 한다(`{version, field, value}`).
 * - 문서에는 필드마다 "마지막으로 바뀐 문서 버전"(`field_versions` jsonb)이 있다. 트랜잭션 안에서
 *   `UPDATE … SET field_x = ?, field_versions = jsonb_set(…, '{x}', version + 1), version = version + 1
 *    WHERE id = ? AND (field_versions ->> 'x')::int <= ?(클라이언트가 본 version)` 조건부 UPDATE 를 보낸다.
 *   "내가 본 뒤로 이 필드를 아무도 안 고쳤다"일 때만 1행이다.
 * - 0행이면 같은 필드를 남이 먼저 고친 것 → 409 `version_mismatch`(currentVersion 재조회). 다른 필드는 막지 않는다.
 * - 1행이면 원장·이력을 같은 트랜잭션에 INSERT 하고 커밋한다.
 *
 * 왜 맞나
 * - SET 은 x 필드만 바꾸고 다른 필드는 건드리지 않는다. 동시에 다른 필드를 고친 UPDATE 는 행 락을 기다렸다가 최신 행으로
 *   WHERE 를 다시 평가(EvalPlanQual)하는데, 그 필드의 field_versions 는 그대로라 통과하고, 앞사람 필드는 최신 행 값으로 남는다.
 * - 같은 필드라면 앞사람이 field_versions.x 를 올렸으므로 재평가에서 거짓 → 0행. 같은 필드 충돌만 409 다.
 *
 * 대가
 * - 필드 단위로만 병합한다. 같은 필드(배열) 안에서 서로 다른 위치를 고쳐도 충돌로 본다.
 * - 필드 경계가 의미 경계와 맞아야 한다. 서로 의존하는 두 필드를 따로 병합하면 각각은 맞아도 합치면 틀린 문서가 될 수 있다.
 * - PUT(문서 전체)은 모든 필드를 바꾸므로 optimistic-version 처럼 문서 version 전체로 검사하고 모든 필드 버전을 올린다.
 */
export class FieldMergeStrategy implements G01Strategy {
  readonly id = 'field-merge';

  async patch(cmd: PatchCommand, ctx: StrategyContext): Promise<SaveOutcome> { // @event arrived
    const entity = { type: 'Document', id: String(cmd.documentId) };
    // 필드 이름은 SQL 경로('{x}', ->> 'x')에 들어간다. 컨트롤러가 검증하지만 여기서도 목록 밖은 거절한다
    if (!FIELDS.includes(cmd.field)) throw new Error(`field-merge: 알 수 없는 필드 '${String(cmd.field)}'`);
    ctx.events.emit('arrived', { entity, attrs: { field: cmd.field } });
    try {
      const outcome = await ctx.em.transactional(async (em) => { // @learn tx-boundary — 조건부 UPDATE 와 원장·이력 INSERT 를 한 트랜잭션에 묶는다. 0행이면 던져서 롤백한다
        const afterRead = await ctx.contentionWindow('after-read'); // @event injected_delay
        if (afterRead?.injected) ctx.events.emit('injected_delay', { entity, injected: true, durMs: afterRead.durMs });
        const beforeWrite = await ctx.contentionWindow('before-write'); // @event injected_delay
        if (beforeWrite?.injected) ctx.events.emit('injected_delay', { entity, injected: true, durMs: beforeWrite.durMs });
        const rows = await em.nativeUpdate( // @event db_write
          Document,
          {
            id: cmd.documentId,
            // @learn field-version-where — 이 필드가 마지막으로 바뀐 버전 <= 내가 본 버전. 다른 필드가 바뀐 것은 보지 않는다(문서 version 전체가 아니라 필드 단위 비교)
            [raw(`(field_versions ->> ?)::int`, [cmd.field])]: { $lte: cmd.version },
          },
          {
            [cmd.field]: cmd.value, // @learn set-one-field — 바뀐 필드만 SET. 다른 필드는 SET 에 없으므로 동시에 커밋된 남의 값이 그대로 남는다
            // @learn field-version-bump — 이 필드의 버전을 새 문서 버전(version + 1; SET 의 우변은 UPDATE 전 값)으로 기록. 같은 필드를 늦게 고치려는 쪽이 이걸 보고 0행이 된다
            fieldVersions: raw(`jsonb_set(field_versions, ?::text[], to_jsonb(version + 1))`, [`{${cmd.field}}`]),
            editCount: raw('edit_count + 1'),
          },
        );
        ctx.events.emit('db_write', { entity, rows });
        if (rows === 0) {
          // @learn same-field-409 — 0행 = 내가 본 뒤로 같은 필드를 남이 고쳤다(또는 문서가 없다). 같은 트랜잭션에서 재조회해 currentVersion 을 돌려준다
          const [cur] = await em.execute<{ version: number; field_version: number }[]>(
            `select version, (field_versions ->> ?)::int as field_version from g01_document where id = ?`,
            [cmd.field, cmd.documentId],
          );
          if (!cur) throw NotFoundError.findOneFailed('Document', { id: cmd.documentId });
          throw new FieldConflict(
            { ok: false, reason: 'version_mismatch', currentVersion: cur.version },
            { field: cmd.field, sentVersion: cmd.version, fieldVersion: cur.field_version, currentVersion: cur.version },
          );
        }
        const doc = await em.findOneOrFail(Document, cmd.documentId, { refresh: true }); // 저장 후 version(응답·이력용)
        await ctx.ledger.recordSuccess(em, { // @learn ledger-same-tx — 원장·이력 INSERT 는 모든 strategy 가 같은 비용으로 같은 트랜잭션에서 한다
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
      if (!(err instanceof FieldConflict)) throw err;
      ctx.events.emit('conflict', { entity, attrs: { reason: 'version_mismatch', cause: 'same_field', ...err.attrs } }); // @event conflict
      return err.outcome;
    }
  }

  /** PUT(문서 전체). 모든 필드를 바꾸므로 문서 version 전체로 검사하고 모든 필드 버전을 새 버전으로 올린다. */
  async save(cmd: SaveCommand, ctx: StrategyContext): Promise<SaveOutcome> { // @event arrived
    const entity = { type: 'Document', id: String(cmd.documentId) };
    ctx.events.emit('arrived', { entity });
    try {
      const outcome = await ctx.em.transactional(async (em) => {
        const afterRead = await ctx.contentionWindow('after-read'); // @event injected_delay
        if (afterRead?.injected) ctx.events.emit('injected_delay', { entity, injected: true, durMs: afterRead.durMs });
        const beforeWrite = await ctx.contentionWindow('before-write'); // @event injected_delay
        if (beforeWrite?.injected) ctx.events.emit('injected_delay', { entity, injected: true, durMs: beforeWrite.durMs });
        const rows = await em.nativeUpdate( // @event db_write
          Document,
          { id: cmd.documentId, version: cmd.version },
          {
            ...cmd.fields,
            // @learn put-bumps-all — 전체 교체는 모든 필드를 바꾼 것으로 기록한다. 안 그러면 이 PUT 이전 버전을 본 PATCH 가 필드 검사를 통과해 PUT 의 내용을 덮는다
            fieldVersions: raw(`jsonb_build_object('a', version + 1, 'b', version + 1, 'c', version + 1, 'd', version + 1)`),
            editCount: raw('edit_count + 1'),
          },
        );
        ctx.events.emit('db_write', { entity, rows });
        if (rows === 0) {
          const [cur] = await em.execute<{ version: number }[]>(`select version from g01_document where id = ?`, [cmd.documentId]);
          if (!cur) throw NotFoundError.findOneFailed('Document', { id: cmd.documentId });
          throw new FieldConflict(
            { ok: false, reason: 'version_mismatch', currentVersion: cur.version },
            { sentVersion: cmd.version, currentVersion: cur.version },
          );
        }
        const doc = await em.findOneOrFail(Document, cmd.documentId, { refresh: true });
        await ctx.ledger.recordSuccess(em, {
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
      if (!(err instanceof FieldConflict)) throw err;
      ctx.events.emit('conflict', { entity, attrs: { reason: 'version_mismatch', cause: 'whole_document', ...err.attrs } }); // @event conflict
      return err.outcome;
    }
  }
}
