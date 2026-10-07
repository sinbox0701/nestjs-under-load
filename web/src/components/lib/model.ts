/**
 * 패널들이 함께 쓰는 기록 해석(순수 함수). 화면 상태는 모두 재생 위치 P(실제 ms)의 함수다.
 * 판정·자동 멈춤·행 묶기·서버 스냅샷은 기록과 재생 엔진(playback)이 정하고, 여기서는 표시만 정한다.
 */
import type { PhaseGroup, PhaseInfo, Tone } from '../../events/phases';
import type {
  Phase,
  Recording,
  RecordingMeta,
  RoundInfo,
  RunEvent,
  ServerSession,
  TxBandKind,
} from '../../events/types';
import type { Row } from '../../playback/rows';
import type { AutoStop } from '../../playback/stops';
import { LABELS, type ScenarioId } from './config';
import type { IconName } from './icons';

/** 실제 ms 표기(소수 1자리). */
export const fmtMs = (ms: number) => ms.toFixed(1);

export function actorIdx(meta: RecordingMeta, id: string): number {
  return meta.actors.indexOf(id);
}
export function actorLabel(meta: RecordingMeta, id: string): string {
  const i = actorIdx(meta, id);
  return meta.actorLabels?.[id] ?? LABELS[i] ?? id;
}

/** "핵심만"에서 켤 수 있는 종류(DESIGN_SYSTEM §4.9). */
export const KEY_GROUPS: ReadonlySet<PhaseGroup> = new Set<PhaseGroup>([
  'read',
  'lock',
  'conflict',
  'retry',
  'commit',
  'lost',
]);

const GROUP_ICON: Record<PhaseGroup, IconName> = {
  arrive: 'arrive',
  read: 'read',
  edit: 'write',
  io: 'write',
  lock: 'lock',
  conflict: 'bang',
  retry: 'retry',
  commit: 'check',
  lost: 'cross',
  other: 'wait',
};

const PHASE_ICON: Record<string, IconName> = {
  responded: 'out',
  lock_wait: 'wait',
  lock_released: 'unlock',
  lease_expired: 'wait',
  lock_timeout: 'wait',
  holder_left: 'out',
  holder_paused: 'stop',
  rolled_back: 'cross',
  failed: 'cross',
  rejected: 'lock',
};

export const groupIcon = (g: PhaseGroup): IconName => GROUP_ICON[g];
export function phaseIcon(phase: Phase, info: PhaseInfo): IconName {
  return PHASE_ICON[phase.replace(/^custom:/, '')] ?? GROUP_ICON[info.group];
}

/** 이벤트의 라운드 번호. */
export function roundIndexOf(rounds: readonly RoundInfo[], e: RunEvent): number {
  if (e.round !== undefined) return e.round;
  for (let i = rounds.length - 1; i >= 0; i--) if (e.t >= rounds[i]!.start) return rounds[i]!.index;
  return 0;
}

/** 행의 라운드(첫 이벤트 기준). */
export const rowRound = (rounds: readonly RoundInfo[], r: Row) =>
  roundIndexOf(rounds, r.events[0]!);

/** 스크러버 눈금 색(빨강=409·위반·이탈·멈춤, 노랑=행 락 대기·첫 423·만료, 주황=재시도, 파랑=같은 버전 수신). */
export function tickTone(e: RunEvent): 'bad' | 'wait' | 'retry' | 'read' | null {
  const k = e.phase.replace(/^custom:/, '');
  if (['lost_update', 'conflict', 'holder_left', 'holder_paused', 'lock_timeout'].includes(k))
    return 'bad';
  if (
    k === 'lock_wait' ||
    k === 'lease_expired' ||
    k === 'sold_out' ||
    ((k === 'lease_rejected' || k === 'rejected') && e.attrs?.first === true)
  )
    return 'wait';
  if (k === 'retry' && e.attrs?.knock !== true) return 'retry';
  if (e.cause) return 'read';
  return null;
}

/**
 * 원인 행: 잃어버린 수정을 설명 중이면 덮어쓴 사람의 화면 열기 읽기,
 * 원인(같은 버전 수신)에서 멈췄으면 A의 첫 읽기. 행 목록은 같은 라운드만.
 */
export function causeRow(rows: readonly Row[], meta: RecordingMeta, stop: AutoStop | null): number {
  if (!stop) return -1;
  const head = stop.events[0]!;
  const isOpenRead = (e: RunEvent) => e.phase === 'db_read' && e.attrs?.open !== false;
  if (stop.phase === 'custom:lost_update' && head.attrs?.blind !== true) {
    const by = head.attrs?.by;
    if (typeof by !== 'string') return -1;
    return rows.findIndex((r) => r.events.some((e) => isOpenRead(e) && e.actor === by));
  }
  if (head.cause) {
    const a0 = meta.actors[0];
    return rows.findIndex((r) => r.events.some((e) => isOpenRead(e) && e.actor === a0));
  }
  return -1;
}

/** P 이하에 도착한 마지막 행. */
export function currentRow(rows: readonly Row[], P: number): number {
  let idx = -1;
  rows.forEach((r, i) => {
    if (r.t <= P) idx = i;
  });
  return idx;
}

/** 각 actor의 이 라운드 마지막 이벤트(코드 거터 A▶ B▶). 응답하고 나간 사람은 뺀다. */
export function lastPerActor(
  events: readonly RunEvent[],
  rd: RoundInfo,
  P: number,
): Map<string, RunEvent> {
  const out = new Map<string, RunEvent>();
  for (const e of events) {
    if (e.t < rd.start) continue;
    if (e.t > P || e.t >= rd.end) break;
    out.set(e.actor, e);
  }
  for (const [a, e] of out) if (e.phase === 'responded') out.delete(a);
  return out;
}

// ---------------------------------------------------------------- 트랜잭션 띠

export type BandCls = 'bd-rd' | 'bd-ed' | 'bd-tx' | 'bd-tx rb' | 'bd-ac' | 'bd-wt' | 'bd-ls';

export const BAND_CLS: Record<TxBandKind, BandCls> = {
  read: 'bd-rd',
  edit: 'bd-ed',
  tx: 'bd-tx',
  'tx-rollback': 'bd-tx rb',
  wait: 'bd-wt',
  autocommit: 'bd-ac',
  lease: 'bd-ls',
  'mem-wait': 'bd-wt',
  injected: 'bd-ed',
};

export type Band =
  | { kind: 'band'; cls: BandCls; start: number; end: number; tip: string }
  | { kind: 'mark'; mark: 'ok' | 'bad' | 'wait'; t: number; tip: string };

/**
 * 한 사람의 라운드 띠(시각은 라운드 시작 기준). 기록의 txBands·txMarks를 쓰고,
 * 띠가 없는 기록이면 커밋·실패 표시만 이벤트에서 만든다.
 */
export function bandsOf(
  rec: Recording,
  events: readonly RunEvent[],
  rounds: readonly RoundInfo[],
  rd: RoundInfo,
  actor: string,
  info: (p: Phase) => PhaseInfo,
): Band[] {
  const inRound = (t: number, round?: number) =>
    round !== undefined ? round === rd.index : t >= rd.start && t < rd.end;
  if (rec.txBands || rec.txMarks) {
    const out: Band[] = [];
    for (const b of rec.txBands ?? [])
      if (b.actor === actor && inRound(b.start, b.round))
        out.push({
          kind: 'band',
          cls: BAND_CLS[b.kind],
          start: b.start - rd.start,
          end: b.end - rd.start,
          tip: b.tip,
        });
    for (const m of rec.txMarks ?? [])
      if (m.actor === actor && inRound(m.t, m.round))
        out.push({ kind: 'mark', mark: m.kind, t: m.t - rd.start, tip: m.tip });
    return out;
  }
  const out: Band[] = [];
  for (const e of events) {
    if (e.actor !== actor || roundIndexOf(rounds, e) !== rd.index) continue;
    const i = info(e.phase);
    if (i.tone === 'ok' && i.group === 'commit')
      out.push({ kind: 'mark', mark: 'ok', t: e.t - rd.start, tip: i.label });
    else if (i.tone === 'bad')
      out.push({ kind: 'mark', mark: 'bad', t: e.t - rd.start, tip: i.label });
    else if (i.tone === 'wait' && i.group === 'lock')
      out.push({ kind: 'mark', mark: 'wait', t: e.t - rd.start, tip: i.label });
  }
  return out;
}

const LEGEND_TEXT: Record<ScenarioId, Partial<Record<TxBandKind, string>>> = {
  'g01-shared-document': {
    read: '읽기 = 자동 커밋 SELECT',
    edit: '편집 = 사람 시간(압축)',
    tx: '저장 = begin…commit (원장·이력 포함, 빨강 = rollback)',
    autocommit: 'acquire·release = 자동 커밋 UPDATE',
    lease: '편집 잠금 보유',
    wait: '행 락 대기',
  },
  'g02-stock-decrement': {
    tx: '저장 = begin…commit (재고 UPDATE·원장 INSERT, 빨강 = rollback)',
    read: '읽기 = SELECT',
    injected: '경합 창 주입 지연',
    wait: '행 락 대기',
    'mem-wait': '앱 메모리 mutex 대기',
    lease: '락 보유',
  },
};

export interface LegendItem {
  cls: BandCls | 'mark ok' | 'mark bad' | 'mark wait';
  text: string;
}

/** 범례: 이 기록에 나오는 띠만, 레인과 같은 이름·색으로. */
export function legendOf(
  rec: Recording | null,
  scenario: ScenarioId,
  strategyId: string,
  info?: (p: Phase) => PhaseInfo,
): LegendItem[] {
  const text = LEGEND_TEXT[scenario];
  const lease = strategyId === 'edit-lease';
  // 띠가 없는 기록(라이브 이벤트만)은 시나리오 기본 목록 대신 실제 이벤트에서 나온 표시만 보인다.
  const live = !!rec && !rec.txBands && !rec.txMarks && !!info;
  const seen = new Set<'ok' | 'bad' | 'wait'>();
  if (live)
    for (const e of rec.events) {
      const i = info(e.phase);
      if (i.tone === 'ok' && i.group === 'commit') seen.add('ok');
      else if (i.tone === 'bad') seen.add('bad');
      else if (i.tone === 'wait' && i.group === 'lock') seen.add('wait');
    }
  const kinds: TxBandKind[] = live
    ? []
    : rec?.txBands
      ? [...new Set(rec.txBands.map((b) => (b.kind === 'tx-rollback' ? 'tx' : b.kind)))]
      : scenario === 'g01-shared-document'
      ? [
          'read',
          'edit',
          'tx',
          ...(lease ? (['autocommit', 'lease'] as const) : (['wait'] as const)),
        ]
      : ['tx', 'wait'];
  const order: TxBandKind[] = [
    'read',
    'edit',
    'tx',
    'autocommit',
    'lease',
    'wait',
    'mem-wait',
    'injected',
  ];
  const items: LegendItem[] = order
    .filter((k) => kinds.includes(k))
    .map((k) => ({ cls: BAND_CLS[k], text: text[k] ?? k }));
  if (live) {
    if (seen.has('ok')) items.push({ cls: 'mark ok', text: '커밋' });
    if (seen.has('bad'))
      items.push({
        cls: 'mark bad',
        text: scenario === 'g01-shared-document' ? '409·위반' : '롤백·위반',
      });
    if (seen.has('wait')) items.push({ cls: 'mark wait', text: lease ? '423' : '락 대기' });
    return items;
  }
  items.push(
    { cls: 'mark ok', text: '커밋' },
    { cls: 'mark bad', text: scenario === 'g01-shared-document' ? '409·위반' : '롤백·위반' },
  );
  if (lease) items.push({ cls: 'mark wait', text: '423' });
  return items;
}

// ---------------------------------------------------------------- 서버 속

export type SessionState = 'active' | 'active · Lock' | 'idle in transaction';

/**
 * pg_stat_activity의 state: 행 락 대기 = active(wait_event_type Lock),
 * 트랜잭션을 연 채 문장이 없으면 idle in transaction.
 */
export function sessionState(s: Pick<ServerSession, 'sql'> & { state: string }): SessionState {
  if (s.state === 'lock_wait') return 'active · Lock';
  if (s.state === 'idle_in_transaction' || s.state === 'idle in transaction')
    return 'idle in transaction';
  return s.sql ? 'active' : 'idle in transaction';
}

export type { Tone };
