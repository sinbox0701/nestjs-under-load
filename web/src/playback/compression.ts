import { FF_MAX_WALL_MS, FF_POST, FF_PRE, realPerWall } from './constants';

/** 실제 ms 구간 [a, b). */
export interface Gap {
  a: number;
  b: number;
}

/**
 * 빈 구간 = 이벤트마다 [t - FF_PRE, t + FF_POST] 창을 합친 것의 여집합(0..total 안).
 * 이벤트 시각은 오름차순이어야 한다.
 */
export function computeGaps(times: readonly number[], total: number): Gap[] {
  const gaps: Gap[] = [];
  let cur = 0;
  for (const t of times) {
    const a = Math.max(0, t - FF_PRE);
    if (a > cur) gaps.push({ a: cur, b: Math.min(a, total) });
    cur = Math.max(cur, t + FF_POST);
    if (cur >= total) break;
  }
  if (cur < total) gaps.push({ a: cur, b: total });
  return gaps.filter((g) => g.b > g.a);
}

/** 재생 위치 축을 덮는 구간 하나. rate = 벽시계 ms당 실제 ms. */
export interface Segment {
  a: number;
  b: number;
  rate: number;
  folded: boolean;
  /** 이 구간 시작까지의 누적 벽시계 ms. */
  wall0: number;
}

export interface CompressionMap {
  total: number;
  segments: Segment[];
  /** 전체 재생에 걸리는 벽시계 ms. */
  totalWall: number;
}

/**
 * 압축 맵: 선택 속도로 재생했을 때 FF_MAX_WALL_MS를 넘는 빈 구간만 접는다(그 구간 전체를
 * FF_MAX_WALL_MS에 지나가도록 속도를 높인다). ff가 꺼져 있으면 전체가 선택 속도다.
 * 압축은 P가 흐르는 속도만 바꾼다. 장면·이벤트 시각은 그대로다.
 */
export function buildCompressionMap(
  gaps: readonly Gap[],
  total: number,
  speed: number,
  ff: boolean,
): CompressionMap {
  const base = realPerWall(speed);
  const segments: Segment[] = [];
  let p = 0;
  let wall = 0;
  const push = (a: number, b: number, rate: number, folded: boolean) => {
    if (b <= a) return;
    segments.push({ a, b, rate, folded, wall0: wall });
    wall += (b - a) / rate;
  };
  if (ff) {
    for (const g of gaps) {
      if ((g.b - g.a) / base <= FF_MAX_WALL_MS) continue;
      push(p, g.a, base, false);
      push(g.a, g.b, (g.b - g.a) / FF_MAX_WALL_MS, true);
      p = g.b;
    }
  }
  push(p, total, base, false);
  return { total, segments, totalWall: wall };
}

/** 실제로 접히는 구간 목록(스크러버 빗금용). */
export function foldedGaps(map: CompressionMap): Gap[] {
  return map.segments.filter((s) => s.folded).map(({ a, b }) => ({ a, b }));
}

function segmentAt(map: CompressionMap, P: number): Segment | undefined {
  const s = map.segments;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (s[m]!.a <= P) lo = m;
    else hi = m - 1;
  }
  return s[lo];
}

/** P(실제 ms)까지 재생하는 데 걸리는 벽시계 ms. */
export function wallAt(map: CompressionMap, P: number): number {
  const p = Math.min(Math.max(P, 0), map.total);
  const s = segmentAt(map, p);
  if (!s) return 0;
  return s.wall0 + (p - s.a) / s.rate;
}

/** 벽시계 ms → P. wallAt의 역함수. */
export function positionAtWall(map: CompressionMap, wall: number): number {
  if (wall <= 0) return 0;
  if (wall >= map.totalWall) return map.total;
  const s = map.segments;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (s[m]!.wall0 <= wall) lo = m;
    else hi = m - 1;
  }
  const seg = s[lo]!;
  return Math.min(seg.b, seg.a + (wall - seg.wall0) * seg.rate);
}

/**
 * 벽시계 wallMs만큼 재생 위치를 옮긴다. 재생은 앞으로만 간다: wallMs ≤ 0(rAF 첫 프레임 시각이
 * 효과에서 잰 시각보다 앞서는 경우 등)이면 그대로, 왕복 변환 오차로도 P 아래로 내려가지 않는다.
 * 그래야 자동 멈춤 지점에서 `계속`했을 때 그 지점(at === P)에 다시 걸리지 않는다.
 */
export function advance(map: CompressionMap, P: number, wallMs: number): number {
  if (!(wallMs > 0)) return P;
  return Math.max(P, positionAtWall(map, wallAt(map, P) + wallMs));
}

/** P가 접히는 빈 구간 안이면 그 구간. */
export function foldedGapAt(map: CompressionMap, P: number): Gap | null {
  const s = segmentAt(map, P);
  return s && s.folded && P >= s.a && P < s.b ? { a: s.a, b: s.b } : null;
}
