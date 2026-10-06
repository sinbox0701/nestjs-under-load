import { phaseInfo, type PhaseGroup, type PhaseInfo } from '../events/phases';
import type { Phase, RunEvent } from '../events/types';
import { AUTO_STOP_DELAY, MERGE_WINDOW, STEP_EPS } from './constants';
import type { AutoStop } from './stops';

export type RowView = 'key' | 'all';

export interface RowFilter {
  view: RowView;
  /** 꺼진 종류. */
  off: ReadonlySet<PhaseGroup>;
}

/** 타임라인 한 행 = 같은 phase가 MERGE_WINDOW 안에 이어진 묶음(×N). */
export interface Row {
  phase: Phase;
  t: number;
  tEnd: number;
  events: RunEvent[];
  /** 단계 이동 착지점(기록 설정을 반영해 buildRows가 정한 값). 없으면 rowTarget의 기본 규칙. */
  target?: number;
}

export function isVisible(
  e: RunEvent,
  f: RowFilter,
  info: (p: Phase) => PhaseInfo = phaseInfo,
): boolean {
  const i = info(e.phase);
  return !f.off.has(i.group) && (f.view === 'all' || i.key);
}

export interface RowOptions {
  info?: (p: Phase) => PhaseInfo;
  /** 자동 멈춤 대상 판정(있으면 행 착지점을 이 기준으로 정한다). */
  isAuto?: (phase: Phase, e: RunEvent) => boolean;
  /** 자동 멈춤 지연(isAuto와 함께). */
  delay?: number;
}

/** 같은 phase·같은 mergeKey가 MERGE_WINDOW 안에 이어지면 한 행(×N)으로 묶는다. */
export function buildRows(events: readonly RunEvent[], f: RowFilter, o: RowOptions = {}): Row[] {
  const info = o.info ?? phaseInfo;
  const rows: Row[] = [];
  for (const e of events) {
    if (!isVisible(e, f, info)) continue;
    const last = rows[rows.length - 1];
    if (
      last &&
      last.phase === e.phase &&
      (last.events[0]!.mergeKey ?? '') === (e.mergeKey ?? '') &&
      e.t - last.t <= MERGE_WINDOW
    ) {
      last.events.push(e);
      last.tEnd = e.t;
    } else {
      rows.push({ phase: e.phase, t: e.t, tEnd: e.t, events: [e] });
    }
  }
  if (o.isAuto) {
    const isAuto = o.isAuto;
    const delay = o.delay ?? AUTO_STOP_DELAY;
    for (const r of rows) {
      r.target = r.events.some((e) => isAuto(e.phase, e)) ? r.tEnd + delay : r.tEnd + STEP_EPS;
    }
  }
  return rows;
}

/** 행에 도착하는 재생 위치. 자동 멈춤 종류면 자동 멈춤과 같은 지점에 선다. */
export function rowTarget(row: Row): number {
  if (row.target !== undefined) return row.target;
  return phaseInfo(row.phase).autoStop ? row.tEnd + AUTO_STOP_DELAY : row.tEnd + STEP_EPS;
}

/** P 이하에 도착한 마지막 행(현재 행). */
export function currentRowIndex(rows: readonly Row[], P: number): number {
  let idx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.t <= P) idx = i;
    else break;
  }
  return idx;
}

export interface StepResult {
  P: number;
  row: Row | null;
}

const NUDGE = 1e-6;

/** 다음 단계: 보이는 행 단위. ×N 묶음은 한 번에 건너뛴다. 없으면 끝으로. */
export function stepNext(rows: readonly Row[], P: number, total: number): StepResult {
  let row: Row | null = null;
  for (const r of rows) {
    const t = rowTarget(r);
    if (t > P + NUDGE && (!row || t < rowTarget(row))) row = r;
  }
  return row ? { P: Math.min(total, rowTarget(row)), row } : { P: total, row: null };
}

/** 이전 단계: 지금 위치보다 앞에 착지하는 마지막 행. 없으면 처음으로. */
export function stepPrev(rows: readonly Row[], P: number): StepResult {
  let row: Row | null = null;
  for (const r of rows) {
    const t = rowTarget(r);
    if (t < P - NUDGE && (!row || t >= rowTarget(row))) row = r;
  }
  return row ? { P: rowTarget(row), row } : { P: 0, row: null };
}

/** 행이 자동 멈춤 묶음에 속하면 그 멈춤(도착 시 같은 설명을 띄우기 위해). */
export function stopForRow(stops: readonly AutoStop[], row: Row | null): AutoStop | null {
  if (!row) return null;
  return stops.find((s) => s.events.some((e) => row.events.includes(e))) ?? null;
}
