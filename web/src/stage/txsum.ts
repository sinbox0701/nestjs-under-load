import type { AutoStop } from '../playback/stops';
import type { RunEvent, TxBandKind } from '../events/types';
import {
  actorRef,
  fmtReal,
  labelOf,
  num,
  roundOfEvent,
  roundsOf,
  sm,
  stagePhase,
  str,
  type Round,
  type StageInput,
} from './events';

/**
 * 요청별 트랜잭션 경계 띠(DESIGN_SYSTEM §4.7). mockup.html `bandsFor`를 옮겼다.
 * 타임라인 레인(B)과 같은 규칙이다 — 같은 기록에서 같은 띠가 나온다.
 */
export type BandClass = 'rd' | 'ed' | 'tx' | 'tx-rb' | 'wt' | 'mw' | 'ac' | 'ls' | 'inj';

const KIND_CLASS: Record<TxBandKind, BandClass> = {
  read: 'rd',
  edit: 'ed',
  tx: 'tx',
  'tx-rollback': 'tx-rb',
  wait: 'wt',
  autocommit: 'ac',
  lease: 'ls',
  'mem-wait': 'mw',
  injected: 'inj',
};

/**
 * 기록이 실은 띠(Recording.txBands·txMarks — 타임라인 레인과 같은 데이터)에서 이 라운드·actor 몫을 꺼낸다.
 * 없으면 null(이벤트로 계산).
 */
export function recordedBands(input: StageInput, rd: Round, i: number): Band[] | null {
  if (!input.txBands?.length && !input.txMarks?.length) return null;
  const id = input.meta.actors[i];
  const inRound = (x: { round?: number; t?: number; start?: number }) =>
    x.round !== undefined
      ? x.round === rd.index
      : (x.t ?? x.start ?? 0) >= rd.start && (x.t ?? x.start ?? 0) < rd.end;
  const out: Band[] = [];
  for (const b of input.txBands ?? [])
    if (b.actor === id && inRound(b))
      out.push({
        kind: 'band',
        cls: KIND_CLASS[b.kind] ?? 'tx',
        start: b.start - rd.start,
        end: b.end - rd.start,
        tip: b.tip,
      });
  for (const m of input.txMarks ?? [])
    if (m.actor === id && inRound(m))
      out.push({ kind: 'mark', mark: m.kind, t: m.t - rd.start, tip: m.tip });
  return out;
}

export type Band =
  | { kind: 'band'; cls: BandClass; start: number; end: number; tip: string }
  | { kind: 'mark'; mark: 'ok' | 'bad' | 'wait'; t: number; tip: string };

/** 띠 이름(머리줄 문장). */
const WORD: Partial<Record<BandClass, string>> = {
  rd: '읽기(자동 커밋)',
  ed: '편집(사람 시간)',
  wt: '행 락 대기',
  mw: '메모리 락 대기',
  ac: '자동 커밋 UPDATE',
  inj: '주입 지연',
};

/** 라운드 안에서 actor i의 띠. 시각은 라운드 시작부터의 실제 ms. */
export function bandsFor(input: StageInput, rd: Round, i: number): Band[] {
  const ids = input.meta.actors;
  const id = ids[i];
  const counter = input.meta.sceneType === 'queue-at-counter';
  const span = rd.end - rd.start;
  const memoryStrategy = /memory/.test(input.meta.strategy.id);
  const memLock = (e: RunEvent) => {
    const k = str(e, 'lock');
    return k ? k === 'memory' : memoryStrategy;
  };
  const out: Band[] = [];
  type Open = { cls: BandClass; start: number; tip: string } | null;
  let tx: Open = null;
  let ed: Open = null;
  let wt: Open = null;
  let ls: Open = null;
  const close = (b: Open, t: number, cls?: BandClass) => {
    if (b) out.push({ kind: 'band', cls: cls ?? b.cls, start: b.start, end: t, tip: b.tip });
  };
  for (const e of rd.events) {
    if (e.actor !== id) continue;
    const t = e.t - rd.start;
    const ph = stagePhase(e);
    if (ed && ph !== 'editing') {
      close(ed, t);
      ed = null;
    }
    switch (ph) {
      case 'db_read': {
        if (counter && tx) break; // 트랜잭션 안의 SELECT(FOR UPDATE)는 상자 안에
        const v = num(e, 'version', 'v');
        const q = num(e, 'qty', 'stock');
        out.push({
          kind: 'band',
          cls: 'rd',
          start: t - sm(50),
          end: t + sm(70),
          tip: `읽기 · 자동 커밋 SELECT${v !== null ? ` (v${v})` : q !== null ? ` (재고 ${q})` : ''}`,
        });
        break;
      }
      case 'editing':
        ed = {
          cls: 'ed',
          start: t,
          tip: e.attrs?.merge
            ? '최신본에 다시 적용 · 사람 시간(압축)'
            : '편집 · 사람 시간(압축) · DB 세션 없음',
        };
        break;
      case 'db_write': {
        if (tx) break;
        const w = str(e, 'write', 'w');
        tx = {
          cls: 'tx',
          start: t,
          tip:
            w === 'opt'
              ? 'begin … SELECT · UPDATE(WHERE version) · 원장·이력 INSERT … commit'
              : w === 'naive'
                ? 'begin … UPDATE(WHERE id만) · 원장·이력 INSERT … commit'
                : w === 'lease' || w === 'leaseFail'
                  ? 'begin … 조건부 UPDATE(locked_by·fence·lease) · 원장·이력 INSERT … commit'
                  : 'begin … UPDATE … commit',
        };
        break;
      }
      case 'lock_wait':
        if (counter && memLock(e)) {
          wt = { cls: 'mw', start: t, tip: '앱 메모리 락 대기 (DB 트랜잭션·커넥션 없음)' };
          break;
        }
        if (counter && !tx)
          tx = { cls: 'tx', start: t, tip: 'begin … SELECT … FOR UPDATE … commit' };
        wt = { cls: 'wt', start: t, tip: '행 락 대기 (트랜잭션 안)' };
        break;
      case 'committed':
        close(wt, t);
        wt = null;
        close(tx, t);
        tx = null;
        out.push({
          kind: 'mark',
          mark: 'ok',
          t,
          tip: `commit${num(e, 'version', 'v') !== null ? ` v${num(e, 'version', 'v')}` : ''}`,
        });
        break;
      case 'conflict':
      case 'failed':
      case 'rolled_back':
      case 'lock_timeout':
      case 'sold_out':
        close(wt, t);
        wt = null;
        if (tx) {
          close(tx, t, 'tx-rb');
          tx = null;
        } else if (ph === 'conflict')
          out.push({
            kind: 'band',
            cls: 'tx-rb',
            start: t - sm(120),
            end: t,
            tip: 'begin … SELECT · lockVersion 메모리 비교 실패 … rollback (UPDATE 없음)',
          });
        out.push({
          kind: 'mark',
          mark: 'bad',
          t,
          tip: `${ph === 'conflict' ? '409 ' : ''}${str(e, 'reason') ?? ph}`,
        });
        break;
      case 'lost':
      case 'oversold':
        out.push({
          kind: 'mark',
          mark: 'bad',
          t,
          tip: ph === 'lost' ? '잃어버린 수정' : '초과 판매',
        });
        break;
      case 'lock_acquired':
        if (counter) {
          close(wt, t);
          wt = null;
          if (!tx && !memLock(e))
            tx = { cls: 'tx', start: t, tip: 'begin … SELECT … FOR UPDATE … commit' };
        } else {
          ls = { cls: 'ls', start: t, tip: '편집 잠금 보유' };
          out.push({
            kind: 'band',
            cls: 'ac',
            start: t - sm(40),
            end: t + sm(60),
            tip: 'acquire 조건부 UPDATE (자동 커밋 한 문장)',
          });
        }
        break;
      case 'lock_released':
        if (!counter)
          out.push({
            kind: 'band',
            cls: 'ac',
            start: t - sm(40),
            end: t + sm(60),
            tip: 'release 조건부 UPDATE (자동 커밋 한 문장)',
          });
        close(ls, t);
        ls = null;
        break;
      case 'lease_expired':
        close(ls, t);
        ls = null;
        break;
      case 'holder_left':
        close(ed, t);
        ed = null;
        out.push({ kind: 'mark', mark: 'bad', t, tip: '보유자 이탈 · release 없음' });
        break;
      case 'holder_paused':
        close(ed, t);
        ed = null;
        out.push({ kind: 'mark', mark: 'bad', t, tip: '보유자 멈춤 (GC·네트워크 단절)' });
        break;
      case 'lease_rejected':
        out.push({ kind: 'mark', mark: 'wait', t, tip: '423 거절' });
        break;
    }
  }
  for (const b of [ed, tx, wt, ls]) close(b, span);
  return out;
}

export interface TxLane {
  actor: number;
  label: string;
  isWho: boolean;
  /** 0..100 % 위치로 바꾼 띠. */
  items: (
    | { kind: 'band'; cls: BandClass; left: number; width: number; tip: string }
    | { kind: 'mark'; mark: 'ok' | 'bad' | 'wait'; left: number; tip: string }
  )[];
}

export interface TxSummary {
  round: number;
  /** 라운드 시작 → 지금(실제 ms). */
  sinceStart: string;
  whoLabel: string;
  /** 멈춘 사람의 띠 이름 순서(읽기 → 편집 → begin…commit). */
  words: string[];
  lanes: TxLane[];
}

/**
 * 자동 멈춤 때 무대 바로 아래 띠 요약(높이 58px 고정): 멈춘 사람 + 관련된 사람(행 락·잠금 보유자,
 * 덮어쓴 사람)의 레인을 라운드 시작부터 지금까지로 늘려 그린다.
 */
export function txSummary(
  input: StageInput,
  stop: AutoStop,
  P: number,
  labels: readonly string[],
): TxSummary | null {
  const ids = input.meta.actors;
  const ce = stop.events[stop.events.length - 1];
  if (!ce) return null;
  const rd = roundOfEvent(roundsOf(input), ce);
  const who = ids.indexOf(ce.actor);
  if (who < 0) return null;
  const relRef = actorRef(ce, input.meta, 'owner', 'holder', 'by');
  const rel = relRef ?? (ids.length > 1 ? (who === 0 ? 1 : 0) : who);
  const pick = [...new Set([who, rel])].sort((a, b) => a - b);
  const lt = Math.max(1 / 40, P - rd.start);
  const pct = (x: number) => Math.max(0, Math.min(100, (x / lt) * 100));
  const words: string[] = [];
  const lanes: TxLane[] = pick.map((i) => {
    const bands = (recordedBands(input, rd, i) ?? bandsFor(input, rd, i)).filter(
      (b) => (b.kind === 'mark' ? b.t : Math.max(0, b.start)) <= lt,
    );
    if (i === who)
      bands
        .filter((b): b is Extract<Band, { kind: 'band' }> => b.kind === 'band' && b.cls !== 'ls')
        .sort((p, q) => p.start - q.start)
        .forEach((b) =>
          words.push(
            b.cls === 'tx-rb'
              ? 'begin…rollback'
              : b.cls === 'tx'
                ? b.end > lt
                  ? 'begin…(진행 중)'
                  : 'begin…commit'
                : (WORD[b.cls] ?? b.cls),
          ),
        );
    return {
      actor: i,
      label: labelOf(labels, i),
      isWho: i === who,
      items: bands.map((b) =>
        b.kind === 'mark'
          ? { kind: 'mark' as const, mark: b.mark, left: pct(b.t), tip: b.tip }
          : {
              kind: 'band' as const,
              cls: b.cls,
              left: pct(Math.max(0, b.start)),
              width: Math.max(0.6, pct(Math.min(b.end, lt)) - pct(Math.max(0, b.start))),
              tip: b.tip,
            },
      ),
    };
  });
  return {
    round: Math.max(0, roundsOf(input).indexOf(rd)) + 1,
    sinceStart: fmtReal(lt),
    whoLabel: labelOf(labels, who),
    words,
    lanes,
  };
}
