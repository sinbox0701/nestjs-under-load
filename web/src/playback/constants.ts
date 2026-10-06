/**
 * 재생 상수. 재생 위치 P는 **실제 ms**(이벤트의 t와 같은 축)다.
 * 시안(DESIGN_SYSTEM §4.8)은 무대 ms(= 실제 ms × 40)로 적혀 있어 여기서 나눠 옮긴다.
 */

/** 무대 시간 40ms = 실제 1ms. 재생 1× = 실제의 1/40 슬로모션. */
export const STAGE_PER_REAL = 40;

export const SPEEDS = [0.1, 0.25, 0.5, 1] as const;
export type Speed = (typeof SPEEDS)[number];
export const DEFAULT_SPEED: Speed = 0.25;

/** 빈 구간 압축: 이벤트 앞 100 · 뒤 480 무대 ms 창은 선택 속도로 재생. */
export const FF_PRE = 100 / STAGE_PER_REAL;
export const FF_POST = 480 / STAGE_PER_REAL;
/** 접히는 빈 구간은 벽시계 최대 0.3초에 지나간다. */
export const FF_MAX_WALL_MS = 300;

/** 자동 멈춤은 이벤트 뒤 무대 450ms(장면이 반응한 뒤)에 선다. */
export const AUTO_STOP_DELAY = 450 / STAGE_PER_REAL;
/** 같은 종류가 무대 1.4초 안에 이어지면 한 번만 멈추고, 타임라인에서도 ×N으로 묶는다. */
export const MERGE_WINDOW = 1400 / STAGE_PER_REAL;
/** 단계 이동 착지점: 행의 마지막 이벤트 바로 뒤(무대 1ms). */
export const STEP_EPS = 1 / STAGE_PER_REAL;

/** 선택 속도에서 실제 ms가 벽시계 ms당 얼마나 흐르는가. */
export function realPerWall(speed: number): number {
  return speed / STAGE_PER_REAL;
}
