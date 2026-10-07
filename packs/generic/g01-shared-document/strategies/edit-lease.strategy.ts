import { NotFoundError, raw } from '@mikro-orm/postgresql';

import { Document } from '../entities/document.entity';
import type {
  AcquireOutcome,
  G01Strategy,
  LeaseCommand,
  SaveCommand,
  SaveOutcome,
  StrategyContext,
} from '../support/strategy.types';

/** manifest params(레지스트리가 부팅 시 검증). */
export interface EditLeaseParams {
  /** 잠금 유지 시간. 만료 시각은 DB 시계로 계산한다(`clock_timestamp() + ttlMs`). */
  ttlMs: number;
  /** 423 응답의 Retry-After 상한. 남은 lease 가 더 짧으면 그만큼만 기다리라고 알려 준다. */
  retryAfterMs: number;
}

type LeaseFailure = Extract<SaveOutcome, { ok: false; reason: 'lease_lost' | 'lease_expired' }>;

/** save 의 조건부 UPDATE 가 0행일 때 트랜잭션을 롤백시키려고 던진다. 바깥 catch 가 값(SaveOutcome)으로 바꾼다. */
class LeaseSaveRejected extends Error {
  readonly outcome: LeaseFailure;
  readonly attrs: Record<string, string | number | boolean | null>;
  constructor(outcome: LeaseFailure, attrs: Record<string, string | number | boolean | null>) {
    super(outcome.reason);
    this.outcome = outcome;
    this.attrs = attrs;
  }
}

/**
 * edit-lease — 편집 잠금(lease) + fencing (kind: tradeoff)
 *
 * 이 코드가 하는 일
 * - acquire(POST /lease): 조건부 UPDATE 한 문장(자동 커밋). 잠금이 비었거나 · 내 것이거나 · 만료됐을 때만
 *   `locked_by = 나, lease_until = clock_timestamp() + ttl, fence = fence + 1`로 바꾼다. 0행이면 남이 쥐고 있다 → 423.
 *   서버는 줄을 세우지 않는다. 기다리는 사람은 Retry-After 뒤 다시 노크(폴링)한다. 순서 보장 없음, 굶주림·몰림 가능.
 * - save(PUT): 트랜잭션 안에서 `WHERE id = ? AND locked_by = ? AND fence = ? AND lease_until > clock_timestamp()`
 *   조건부 UPDATE. 0행이면 같은 트랜잭션에서 재조회해 locked_by·fence 가 다르면 `lease_lost`, 같은데 시간이 지났으면
 *   `lease_expired`로 거절(둘 다 409)하고 롤백한다. 1행이면 원장·이력을 같은 트랜잭션에 INSERT 하고 커밋한다.
 * - release(DELETE /lease): `WHERE locked_by = ? AND fence = ?` 조건부 UPDATE(자동 커밋)로 내 잠금만 푼다.
 *
 * 왜 맞나
 * - 확인(잠금이 비었나)과 기록(내 이름을 쓴다)이 UPDATE 한 문장이다. 두 사람이 동시에 acquire 하면 뒤 UPDATE 는
 *   행 락을 기다렸다가 최신 행으로 WHERE 를 다시 평가(EvalPlanQual)하고, 앞사람 잠금이 유효하니 0행이 된다.
 * - 잠금을 쥔 사람만 저장하므로 같은 버전을 두 번 읽는 장면 자체가 없다(lost update 0).
 *
 * 대가와 깨지는 곳
 * - 편집 시간 내내 잠금을 쥔다. 사람이 오래 고칠수록 나머지는 423 만 받고 처리량이 떨어진다.
 * - 쥔 채 사라지면(탭 닫기) release 가 오지 않는다. lease_until 이 지나야 다음 acquire 가 회수한다(TTL 회수).
 * - 멈췄다 깨어난 클라이언트(GC·네트워크 단절)는 아직 잠금을 쥐었다고 믿는다. 그 사이 남이 회수했으면 fence 가 올라
 *   늦은 저장이 0행 → lease_lost 로 걸러진다(fencing). 같은 사람이 다시 acquire 해도 fence 가 올라 옛 세션은 걸러진다.
 * - Document 엔티티는 version 컬럼이 매핑돼 있어 acquire·save·release UPDATE 가 각각 version 을 +1 한다
 *   (MikroORM 이 UPDATE 마다 붙인다). 같은 문서를 낙관 락으로 고치는 다른 클라이언트는 잠금 조작만으로 409 를 받을 수 있다.
 */
export class EditLeaseStrategy implements G01Strategy<EditLeaseParams> {
  readonly id = 'edit-lease';

  async acquire(cmd: LeaseCommand, ctx: StrategyContext<EditLeaseParams>): Promise<AcquireOutcome> { // @event arrived
    const entity = { type: 'Document', id: String(cmd.documentId) };
    ctx.events.emit('arrived', { entity, attrs: { op: 'acquire', holder: cmd.holder } });
    // @learn db-clock — 시각은 전부 DB 시계 clock_timestamp()로 잰다. 앱 서버 시계는 인스턴스마다 어긋나므로 쓰지 않는다.
    //   PostgreSQL 의 now 계열(transaction_timestamp)은 "트랜잭션 시작 시각"이라 한 트랜잭션 안에서 멈춰 있다.
    //   트랜잭션이 오래 열려 있었다면 그만큼 과거 시각으로 만료를 계산·비교하게 된다. clock_timestamp()는 호출한 순간의 실제 시각이다
    const rows = await ctx.em // @learn acquire-autocommit — 트랜잭션 없이 UPDATE 한 문장(자동 커밋). 확인과 기록이 한 문장이라 '읽고 비었으면 쓰기' 경합이 없다
      .createQueryBuilder(Document)
      .update({
        lockedBy: cmd.holder,
        leaseUntil: raw(`clock_timestamp() + ? * interval '1 millisecond'`, [ctx.params.ttlMs]), // @learn lease-until-db-clock — 만료 시각 = DB 시계 + TTL
        fence: raw('fence + 1'), // @learn fence-increment — acquire 마다 +1. 이 번호를 save·release 가 들고 와야 통한다(fencing 토큰)
      })
      .where({
        id: cmd.documentId,
        // @learn acquire-where — 비었거나 · 내 것이거나(갱신) · 만료된(lease_until <= clock_timestamp()) 잠금만 가져간다. 만료된 잠금 회수(TTL)는 이 조건이 한다
        $or: [{ lockedBy: null }, { lockedBy: cmd.holder }, { leaseUntil: { $lte: raw('clock_timestamp()') } }],
      })
      .returning(['fence', 'leaseUntil'])
      .execute('all'); // @event db_write
    ctx.events.emit('db_write', { entity, rows: rows.length, attrs: { op: 'acquire' } });

    if (rows.length === 1) {
      const { fence, leaseUntil } = rows[0] as { fence: string; leaseUntil: Date };
      ctx.events.emit('lock_acquired', { entity, attrs: { holder: cmd.holder, fence: String(fence) } }); // @event lock_acquired
      return { ok: true, fence: String(fence), leaseUntil };
    }

    // @learn held-423 — 0행 = 남이 유효한 잠금을 쥐고 있다. 서버는 줄을 세우지 않고 바로 거절한다(423 + Retry-After). 기다리는 동안 커넥션·트랜잭션을 쥐지 않는다
    const [cur] = await ctx.em.execute<{ locked_by: string | null; remaining_ms: number }[]>( // 남은 시간도 DB 시계로 잰다
      `select locked_by, greatest(0, ceil(extract(epoch from (lease_until - clock_timestamp())) * 1000))::int as remaining_ms
         from g01_document where id = ?`,
      [cmd.documentId],
    );
    if (!cur) throw NotFoundError.findOneFailed('Document', { id: cmd.documentId });
    // 재조회 사이에 풀렸거나 만료됐으면 remaining_ms 가 0 이다 → 곧바로 다시 노크해도 된다
    const retryAfterMs = cur.locked_by === null ? 0 : Math.min(ctx.params.retryAfterMs, cur.remaining_ms ?? 0);
    const lockedBy = cur.locked_by ?? '';
    ctx.events.emit('custom:lease_rejected', { entity, attrs: { holder: cmd.holder, lockedBy, retryAfterMs } }); // @event custom:lease_rejected
    return { ok: false, reason: 'locked', lockedBy, retryAfterMs };
  }

  async save(cmd: SaveCommand, ctx: StrategyContext<EditLeaseParams>): Promise<SaveOutcome> { // @event arrived
    const entity = { type: 'Document', id: String(cmd.documentId) };
    ctx.events.emit('arrived', { entity });
    const lease = cmd.lease;
    if (!lease) {
      // 잠금 없이 온 저장. 남이 쥐었을 수 있는 문서를 덮어쓰지 않도록 DB 에 가지 않고 거절한다
      ctx.events.emit('conflict', { entity, attrs: { reason: 'lease_lost', cause: 'no_lease' } }); // @event conflict
      return { ok: false, reason: 'lease_lost' };
    }
    try {
      const outcome = await ctx.em.transactional(async (em) => { // @learn tx-boundary — 조건부 UPDATE 와 원장·이력 INSERT 를 한 트랜잭션에 묶는다. 0행이면 던져서 롤백한다
        const afterRead = await ctx.contentionWindow('after-read'); // @event injected_delay
        if (afterRead?.injected) ctx.events.emit('injected_delay', { entity, injected: true, durMs: afterRead.durMs });
        const beforeWrite = await ctx.contentionWindow('before-write'); // @event injected_delay
        if (beforeWrite?.injected) ctx.events.emit('injected_delay', { entity, injected: true, durMs: beforeWrite.durMs });
        const rows = await em.nativeUpdate( // @event db_write
          Document,
          // @learn save-where-fence — 보유자이고 · fence 가 같고 · lease 가 아직 유효할 때만 1행. 잠금을 잃은 옛 세션(멈췄다 깨어난 같은 클라이언트 포함)의 늦은 저장을 fence 가 거른다
          { id: cmd.documentId, lockedBy: lease.holder, fence: lease.fence, leaseUntil: { $gt: raw('clock_timestamp()') } },
          { ...cmd.fields, editCount: raw('edit_count + 1') },
        );
        ctx.events.emit('db_write', { entity, rows });
        if (rows === 0) {
          // @learn reread-reason — 0행의 이유는 같은 트랜잭션에서 다시 읽어 가린다. locked_by·fence 가 다르면 lease_lost(남이 회수·내가 재획득), 같은데 시간이 지났으면 lease_expired
          const [cur] = await em.execute<{ locked_by: string | null; fence: string; live: boolean | null; version: number }[]>(
            `select locked_by, fence::text as fence, lease_until > clock_timestamp() as live, version from g01_document where id = ?`,
            [cmd.documentId],
          );
          if (!cur) throw NotFoundError.findOneFailed('Document', { id: cmd.documentId });
          const lost = cur.locked_by !== lease.holder || cur.fence !== lease.fence;
          throw new LeaseSaveRejected(
            { ok: false, reason: lost ? 'lease_lost' : 'lease_expired' },
            { lockedBy: cur.locked_by, fence: cur.fence, sentFence: lease.fence, currentVersion: cur.version },
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
      if (!(err instanceof LeaseSaveRejected)) throw err;
      if (err.outcome.reason === 'lease_expired') ctx.events.emit('lease_expired', { entity, attrs: { holder: lease.holder } }); // @event lease_expired
      ctx.events.emit('conflict', { entity, attrs: { reason: err.outcome.reason, ...err.attrs } }); // @event conflict
      return err.outcome;
    }
  }

  async release(cmd: LeaseCommand, ctx: StrategyContext<EditLeaseParams>): Promise<void> {
    const entity = { type: 'Document', id: String(cmd.documentId) };
    if (cmd.fence === undefined) return; // fence 없이는 내 잠금인지 증명할 수 없다 → 아무것도 풀지 않는다
    // @learn release-fence — 내 잠금 · 내 fence 일 때만 푼다(자동 커밋 한 문장). 잠금을 잃은 옛 세션이 새 보유자의 잠금을 풀지 못한다
    const rows = await ctx.em.nativeUpdate( // @event lock_released
      Document,
      { id: cmd.documentId, lockedBy: cmd.holder, fence: cmd.fence },
      { lockedBy: null, leaseUntil: null },
    );
    if (rows > 0) ctx.events.emit('lock_released', { entity, attrs: { holder: cmd.holder, fence: cmd.fence } });
  }
}
