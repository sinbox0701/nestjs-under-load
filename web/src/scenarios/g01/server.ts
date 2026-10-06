/**
 * G01 서버 속 스냅샷·트랜잭션 띠 — design/mockup.html sceneAt()·updateServerPanel()·bandsFor()의 서버 쪽 상태를
 * 이벤트마다 계산해 둔다(재생은 P 이하 마지막 스냅샷만 고른다 → 되감기 안전).
 */
import type { ServerSession, ServerSnapshot, TxBand, TxMark } from '../../events/types';
import { LABELS as L } from './constants';
import type { MEvent } from './rounds';

interface Sess {
  t0: number;
  until: number;
  sql?: string;
}

/**
 * 라운드 하나의 이벤트(무대 ms, 정렬됨)에 스냅샷을 붙인다.
 * toReal: 라운드 무대 ms → 기록 실제 ms. sqlOf: 이벤트의 대표 SQL.
 */
export function serverSnapshots(
  evs: MEvent[],
  opts: {
    lease: boolean;
    baseVersion: number;
    crowd: number;
    toReal: (t: number) => number;
    sqlOf: (e: MEvent) => string | undefined;
  },
): ServerSnapshot[] {
  const { lease, toReal } = opts;
  let version = opts.baseVersion;
  let content: string | null = null;
  let rowLock: number | null = null;
  const waitRow = new Set<number>();
  let lock: number | null = null;
  let fence = 0;
  let expired = false;
  const paused = new Set<number>();
  const left = new Set<number>();
  const outside = new Set<number>();
  const sess = new Map<number, Sess>();
  return evs.map((e) => {
    const a = e.a;
    switch (e.phase) {
      case 'arrived':
        if (e.late) paused.delete(a);
        break;
      case 'db_read':
        sess.set(a, { t0: e.t, until: e.t + 160, sql: opts.sqlOf(e) });
        break;
      case 'db_write':
        sess.set(a, { t0: e.t, until: Infinity, sql: opts.sqlOf(e) });
        if (e.w !== 'leaseFail' && rowLock === null) rowLock = a; // UPDATE가 잡은 행 락은 commit까지(원장 INSERT 포함)
        break;
      case 'lock_wait':
        waitRow.add(a);
        break;
      case 'committed':
        sess.delete(a);
        content = L[a]!;
        version = e.v ?? version;
        if (rowLock === a) rowLock = null;
        break;
      case 'conflict':
        waitRow.delete(a);
        sess.delete(a);
        break;
      case 'lock_acquired':
        lock = a;
        fence = e.fence ?? fence;
        expired = false;
        version = e.v ?? version;
        outside.delete(a);
        left.delete(a);
        sess.set(a, { t0: e.t, until: e.t + 160, sql: opts.sqlOf(e) });
        break;
      case 'lease_rejected':
        outside.add(a);
        sess.set(a, { t0: e.t, until: e.t + 120, sql: opts.sqlOf(e) });
        break;
      case 'lock_released':
        lock = null;
        version = e.v ?? version;
        sess.set(a, { t0: e.t, until: e.t + 140, sql: opts.sqlOf(e) });
        break;
      case 'holder_left':
        left.add(a);
        break;
      case 'holder_paused':
        paused.add(a);
        break;
      case 'lease_expired':
        expired = true;
        break;
      default:
        break;
    }
    const sessions: ServerSession[] = [...sess.entries()]
      .filter(([, s]) => s.until > e.t)
      .sort(([p], [q]) => p - q)
      .map(([i, s]) => ({
        actor: L[i]!,
        pid: 4100 + i,
        // 저장 트랜잭션(commit까지 열림)은 자기 문장 이벤트가 지난 뒤 문장 사이 = idle in transaction
        state: waitRow.has(i)
          ? 'lock_wait'
          : s.until === Infinity && s.t0 < e.t
            ? 'idle_in_transaction'
            : 'active',
        ...(s.sql ? { sql: s.sql } : {}),
        since: toReal(s.t0),
        until: Number.isFinite(s.until) ? toReal(s.until) : null,
      }));
    const snap: ServerSnapshot = {
      version,
      content,
      rowLock:
        rowLock !== null
          ? {
              holder: L[rowLock]!,
              waiters: [...waitRow].filter((i) => i !== rowLock).map((i) => L[i]!),
            }
          : null,
      sessions,
      pool: { size: 10, crowd: opts.crowd },
    };
    if (lease) {
      snap.lease =
        lock !== null
          ? {
              holder: L[lock]!,
              fence,
              expired,
              holderState: paused.has(lock) ? 'paused' : left.has(lock) ? 'left' : 'ok',
            }
          : null;
      snap.outside = [...outside].sort((p, q) => p - q).map((i) => L[i]!);
      const stale = [...paused].find((i) => i !== lock);
      snap.stale = stale !== undefined ? L[stale]! : null;
    }
    return snap;
  });
}

/** 요청별 트랜잭션 경계 띠(시안 bandsFor). 시각은 라운드 무대 ms → toReal로 바꾼다. */
export function txBands(
  evs: MEvent[],
  n: number,
  round: number,
  span: number,
  toReal: (t: number) => number,
): { bands: TxBand[]; marks: TxMark[] } {
  const bands: TxBand[] = [];
  const marks: TxMark[] = [];
  for (let i = 0; i < n; i++) {
    const actor = L[i]!;
    type Open = { kind: TxBand['kind']; start: number; tip: string } | null;
    let tx: Open = null;
    let ed: Open = null;
    let wt: Open = null;
    let ls: Open = null;
    const band = (kind: TxBand['kind'], start: number, end: number, tip: string) =>
      bands.push({ round, actor, kind, start: toReal(Math.max(0, start)), end: toReal(end), tip });
    const close = (b: Open, t: number, kind?: TxBand['kind']) => {
      if (b) band(kind ?? b.kind, b.start, t, b.tip);
    };
    const mark = (kind: TxMark['kind'], t: number, tip: string) =>
      marks.push({ round, actor, kind, t: toReal(t), tip });
    for (const e of evs) {
      if (e.a !== i) continue;
      if (ed && e.phase !== 'editing') {
        close(ed, e.t);
        ed = null;
      }
      switch (e.phase) {
        case 'db_read':
          band('read', e.t - 50, e.t + 70, `읽기 · 자동 커밋 SELECT (v${e.v})`);
          break;
        case 'editing':
          ed = {
            kind: 'edit',
            start: e.t,
            tip: e.merge
              ? '최신본에 다시 적용 · 사람 시간(압축)'
              : '편집 · 사람 시간(압축) · DB 세션 없음',
          };
          break;
        case 'db_write': // 모든 저장 경로는 em.transactional: begin → UPDATE → 원장·이력 INSERT → commit
          tx = {
            kind: 'tx',
            start: e.t,
            tip:
              e.w === 'opt'
                ? 'begin … SELECT · UPDATE(WHERE version) · 원장·이력 INSERT … commit'
                : e.w === 'naive'
                  ? 'begin … UPDATE(WHERE id만) · 원장·이력 INSERT … commit'
                  : 'begin … 조건부 UPDATE(locked_by·fence·lease) · 원장·이력 INSERT … commit',
          };
          break;
        case 'lock_wait':
          wt = { kind: 'wait', start: e.t, tip: '행 락 대기 (트랜잭션 안)' };
          break;
        case 'committed':
          close(tx, e.t);
          tx = null;
          mark('ok', e.t, `commit v${e.v} (원장·이력 포함)`);
          break;
        case 'conflict':
          close(wt, e.t);
          wt = null;
          if (tx) {
            close(tx, e.t, 'tx-rollback');
            tx = null;
          } else
            band(
              'tx-rollback',
              e.t - 120,
              e.t,
              'begin … SELECT · lockVersion 메모리 비교 실패 … rollback (UPDATE 없음)',
            );
          mark('bad', e.t, `409 ${e.reason}`);
          break;
        case 'lost':
          mark('bad', e.t, '잃어버린 수정');
          break;
        case 'lock_acquired':
          ls = { kind: 'lease', start: e.t, tip: '편집 잠금 보유' };
          band('autocommit', e.t - 40, e.t + 60, 'acquire 조건부 UPDATE (자동 커밋 한 문장)');
          break;
        case 'lock_released':
          band('autocommit', e.t - 40, e.t + 60, 'release 조건부 UPDATE (자동 커밋 한 문장)');
          close(ls, e.t);
          ls = null;
          break;
        case 'lease_expired':
          close(ls, e.t);
          ls = null;
          break;
        case 'holder_left':
          close(ed, e.t);
          ed = null;
          mark('bad', e.t, '보유자 이탈 · release 없음');
          break;
        case 'holder_paused':
          close(ed, e.t);
          ed = null;
          mark('bad', e.t, '보유자 멈춤 (GC·네트워크 단절)');
          break;
        case 'lease_rejected':
          mark('wait', e.t, '423 거절');
          break;
        default:
          break;
      }
    }
    for (const b of [ed, tx, wt, ls]) if (b) band(b.kind, b.start, span, b.tip);
  }
  return { bands, marks };
}
