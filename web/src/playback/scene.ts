import { phaseInfo, type Tone } from '../events/phases';
import type { Phase } from '../events/types';
import { STAGE_PER_REAL } from './constants';
import { upperBound, type Prepared } from './prepare';

/** 무대 논리 해상도(DESIGN_SYSTEM §3.2). */
export const STAGE_W = 256;
export const STAGE_H = 192;

/** 기기 픽셀 기준 정수 배율(DESIGN_SYSTEM §3.2): n = floor(w × DPR / 256), K = n / DPR. */
export function integerScale(availCssWidth: number, dpr: number): number {
  const n = Math.max(1, Math.min(4 * dpr, Math.floor((availCssWidth * dpr) / STAGE_W)));
  return n / dpr;
}

/** 걷는 속도: 무대 ms당 0.09 논리 px → 실제 ms당. */
const PX_PER_REAL_MS = 0.09 * STAGE_PER_REAL;
const DOOR_Y = 150;
const DESK_Y = 136;

export interface ActorPose {
  id: string;
  index: number;
  visible: boolean;
  x: number;
  y: number;
  walking: boolean;
  /** 마지막 phase와 그 상태 색(이름표 색과 섞지 않는다). */
  phase: Phase | null;
  tone: Tone;
}

export interface Scene {
  actors: ActorPose[];
}

interface Motion {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  t0: number;
  dur: number;
}

function doorX(i: number): number {
  return i % 2 === 0 ? -8 : STAGE_W + 8;
}

function deskX(i: number, n: number): number {
  const span = Math.min(56, (n - 1) * 28);
  return Math.round(128 - span / 2 + (n > 1 ? (span * i) / (n - 1) : 0));
}

function posAt(m: Motion, t: number): { x: number; y: number } {
  if (m.dur <= 0) return { x: m.tx, y: m.ty };
  const f = Math.min(1, Math.max(0, (t - m.t0) / m.dur));
  return { x: m.fx + (m.tx - m.fx) * f, y: m.fy + (m.ty - m.fy) * f };
}

function moveTo(m: Motion, x: number, y: number, t: number): void {
  const p = posAt(m, t);
  Object.assign(m, { fx: p.x, fy: p.y, tx: x, ty: y, t0: t });
  m.dur = Math.hypot(x - p.x, y - p.y) / PX_PER_REAL_MS;
}

/**
 * shared-document 장면의 최소판: actor 점이 이벤트대로 움직인다.
 * 움직임은 "이벤트 시각으로부터 지난 시간"의 함수다(프레임 누적 상태 없음 → 되감기 안전).
 */
export function sceneAt(p: Prepared, P: number): Scene {
  const ids = p.recording.meta.actors;
  const n = ids.length;
  const motions = ids.map((_, i): Motion => {
    const x = doorX(i);
    return { fx: x, fy: DOOR_Y, tx: x, ty: DOOR_Y, t0: 0, dur: 0 };
  });
  const state = ids.map(() => ({ visible: false, leaving: false, phase: null as Phase | null }));
  const count = upperBound(p.events, P);
  for (let k = 0; k < count; k++) {
    const e = p.events[k]!;
    const i = ids.indexOf(e.actor);
    if (i < 0) continue;
    const m = motions[i]!;
    const s = state[i]!;
    s.phase = e.phase;
    if (e.phase === 'arrived') {
      s.visible = true;
      s.leaving = false;
      Object.assign(m, { fx: doorX(i), fy: DOOR_Y, tx: doorX(i), ty: DOOR_Y, t0: e.t, dur: 0 });
      moveTo(m, deskX(i, n), DESK_Y, e.t);
    } else if (e.phase === 'responded') {
      s.leaving = true;
      moveTo(m, doorX(i), DOOR_Y, e.t);
    }
  }
  return {
    actors: ids.map((id, i) => {
      const m = motions[i]!;
      const s = state[i]!;
      const pos = posAt(m, P);
      const walking = m.dur > 0 && P < m.t0 + m.dur;
      return {
        id,
        index: i,
        visible: s.visible && !(s.leaving && !walking),
        x: Math.round(pos.x),
        y: Math.round(pos.y),
        walking,
        phase: s.phase,
        tone: s.phase ? phaseInfo(s.phase).tone : 'neutral',
      };
    }),
  };
}
