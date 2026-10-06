import { phaseInfo } from '../events/phases';
import type { Phase, RunEvent } from '../events/types';
import { AUTO_STOP_DELAY, MERGE_WINDOW } from './constants';

export interface AutoStop {
  phase: Phase;
  /** 멈추는 재생 위치(실제 ms). */
  at: number;
  /** 묶음의 첫 이벤트 시각. */
  first: number;
  events: RunEvent[];
}

/**
 * 자동 멈춤 지점. 충돌·잃어버린 수정·락 대기 시작에서 멈추고, 같은 종류가 MERGE_WINDOW 안에
 * 이어지면 한 번만 멈춘다(마지막 이벤트 뒤 AUTO_STOP_DELAY에 선다).
 */
export function computeAutoStops(
  events: readonly RunEvent[],
  isAuto: (phase: Phase) => boolean = (p) => phaseInfo(p).autoStop,
): AutoStop[] {
  const stops: AutoStop[] = [];
  for (const e of events) {
    if (!isAuto(e.phase)) continue;
    const last = stops[stops.length - 1];
    if (last && last.phase === e.phase && e.t - last.first <= MERGE_WINDOW) {
      last.events.push(e);
      last.at = e.t + AUTO_STOP_DELAY;
    } else {
      stops.push({ phase: e.phase, first: e.t, at: e.t + AUTO_STOP_DELAY, events: [e] });
    }
  }
  return stops;
}

/** (from, to] 안의 첫 멈춤 지점. 이미 멈춘 위치(at === from)에서는 다시 멈추지 않는다. */
export function firstStopBetween(
  stops: readonly AutoStop[],
  from: number,
  to: number,
): AutoStop | null {
  for (const s of stops) {
    if (s.at > from && s.at <= to) return s;
    if (s.at > to) break;
  }
  return null;
}
