import { describe, expect, it } from 'vitest';
import { g01NaiveOverwrite } from '../events/fixtures/g01-naive-overwrite';
import type { Phase, RunEvent } from '../events/types';
import {
  AUTO_STOP_DELAY,
  FF_MAX_WALL_MS,
  MERGE_WINDOW,
  STEP_EPS,
  advance,
  buildCompressionMap,
  buildRows,
  computeAutoStops,
  computeGaps,
  createPlaybackStore,
  firstStopBetween,
  foldedGaps,
  positionAtWall,
  prepare,
  sceneAt,
  snapshotAt,
  stepNext,
  stepPrev,
  wallAt,
} from './index';

const ev = (t: number, phase: Phase, actor = 'a'): RunEvent => ({
  id: `${phase}@${t}`,
  t,
  actor,
  phase,
});

const prepared = prepare(g01NaiveOverwrite);
const TOTAL = 156.5;

describe('빈 구간 압축 맵', () => {
  it('이벤트 앞뒤 창의 여집합을 빈 구간으로 잡는다', () => {
    expect(prepared.total).toBe(TOTAL);
    expect(prepared.gaps).toEqual([
      { a: 20.5, b: 35 },
      { a: 58, b: 78.5 },
      { a: 128.5, b: TOTAL },
    ]);
  });

  it('선택 속도로 0.3초를 넘는 공백만 접는다', () => {
    // 창: [0,12] [13.5,28] → 공백 1.5ms
    const gaps = computeGaps([0, 16], 28);
    expect(gaps).toEqual([{ a: 12, b: 13.5 }]);
    // 1×: 1.5ms × 40 = 60 벽시계 ms → 접지 않음
    expect(foldedGaps(buildCompressionMap(gaps, 28, 1, true))).toEqual([]);
    // 0.1×: 1.5 × 400 = 600 → 접음
    expect(foldedGaps(buildCompressionMap(gaps, 28, 0.1, true))).toEqual([{ a: 12, b: 13.5 }]);
  });

  it('접힌 구간은 정확히 FF_MAX_WALL_MS에 지나가고, 나머지는 선택 속도 그대로다', () => {
    const map = buildCompressionMap(prepared.gaps, TOTAL, 0.25, true);
    const slow = 160; // 0.25× = 실제 1ms에 벽시계 160ms
    expect(wallAt(map, 35) - wallAt(map, 20.5)).toBeCloseTo(FF_MAX_WALL_MS);
    expect(wallAt(map, 10)).toBeCloseTo(10 * slow);
    const unfolded = TOTAL - 14.5 - 20.5 - 28;
    expect(map.totalWall).toBeCloseTo(unfolded * slow + 3 * FF_MAX_WALL_MS);
  });

  it('끄면 전체가 실제 시간 비율이다', () => {
    const map = buildCompressionMap(prepared.gaps, TOTAL, 0.25, false);
    expect(foldedGaps(map)).toEqual([]);
    expect(map.totalWall).toBeCloseTo(TOTAL * 160);
  });

  it('wallAt과 positionAtWall은 서로 역함수이고 advance는 끝에서 멈춘다', () => {
    const map = buildCompressionMap(prepared.gaps, TOTAL, 0.5, true);
    for (const P of [0, 5, 20.5, 27, 35, 60, 100, 140, TOTAL]) {
      expect(positionAtWall(map, wallAt(map, P))).toBeCloseTo(P);
    }
    expect(advance(map, 150, 1e9)).toBe(TOTAL);
    // 접힌 구간 안에서 150ms(절반) 지나면 구간 가운데
    expect(advance(map, 58, FF_MAX_WALL_MS / 2)).toBeCloseTo(68.25);
  });
});

describe('자동 멈춤 지점', () => {
  it('fixture: 잃어버린 수정 뒤 AUTO_STOP_DELAY에 한 번 선다', () => {
    expect(prepared.stops).toHaveLength(1);
    expect(prepared.stops[0]!.phase).toBe('custom:lost_update');
    expect(prepared.stops[0]!.at).toBeCloseTo(111 + AUTO_STOP_DELAY);
  });

  it('같은 종류가 창 안에 이어지면 묶고, 종류가 다르거나 창 밖이면 따로 선다', () => {
    const stops = computeAutoStops([
      ev(10, 'conflict'),
      ev(10 + MERGE_WINDOW - 1, 'conflict', 'b'),
      ev(60, 'lock_wait'),
      ev(61, 'conflict'),
      ev(61 + MERGE_WINDOW + 1, 'conflict'),
      ev(200, 'committed'),
    ]);
    expect(stops.map((s) => [s.phase, s.events.length])).toEqual([
      ['conflict', 2],
      ['lock_wait', 1],
      ['conflict', 1],
      ['conflict', 1],
    ]);
    expect(stops[0]!.at).toBeCloseTo(10 + MERGE_WINDOW - 1 + AUTO_STOP_DELAY);
  });

  it('(from, to] 안의 첫 지점만 고르고, 이미 선 자리에서는 다시 서지 않는다', () => {
    const at = prepared.stops[0]!.at;
    expect(firstStopBetween(prepared.stops, 0, TOTAL)?.at).toBe(at);
    expect(firstStopBetween(prepared.stops, at, TOTAL)).toBeNull();
    expect(firstStopBetween(prepared.stops, 0, at - 0.01)).toBeNull();
  });
});

describe('단계 이동', () => {
  const keyRows = buildRows(prepared.events, { view: 'key', off: new Set() });
  const allRows = buildRows(prepared.events, { view: 'all', off: new Set() });

  it('핵심만: 커밋 ×2 묶음 → 잃어버린 수정', () => {
    expect(keyRows.map((r) => [r.phase, r.events.length])).toEqual([
      ['committed', 2],
      ['custom:lost_update', 1],
    ]);
    expect(allRows).toHaveLength(9);
  });

  it('다음 단계는 묶음을 한 번에 건너뛰고, 자동 멈춤 종류는 멈춤 지점에 선다', () => {
    let s = stepNext(keyRows, 0, TOTAL);
    expect(s.P).toBeCloseTo(110 + STEP_EPS);
    expect(s.row?.events).toHaveLength(2);
    s = stepNext(keyRows, s.P, TOTAL);
    expect(s.P).toBeCloseTo(prepared.stops[0]!.at);
    s = stepNext(keyRows, s.P, TOTAL);
    expect(s).toEqual({ P: TOTAL, row: null });
  });

  it('이전 단계는 역순으로 같은 지점에 서고 처음으로 돌아간다', () => {
    let s = stepPrev(keyRows, TOTAL);
    expect(s.P).toBeCloseTo(prepared.stops[0]!.at);
    s = stepPrev(keyRows, s.P);
    expect(s.P).toBeCloseTo(110 + STEP_EPS);
    s = stepPrev(keyRows, s.P);
    expect(s).toEqual({ P: 0, row: null });
  });

  it('필터로 끈 종류는 건너뛴다', () => {
    const rows = buildRows(prepared.events, { view: 'key', off: new Set(['commit']) });
    expect(stepNext(rows, 0, TOTAL).P).toBeCloseTo(prepared.stops[0]!.at);
  });
});

describe('되감기 안전(P의 함수)', () => {
  it('같은 P는 어떤 순서로 물어도 같은 상태다', () => {
    const forward = [0, 40, 90, 115, 156.5].map((P) => snapshotAt(prepared, P));
    const backward = [156.5, 115, 90, 40, 0].map((P) => snapshotAt(prepared, P)).reverse();
    expect(backward).toEqual(forward);
    expect(snapshotAt(prepared, 110.9).counters.violations).toBe(0);
    expect(snapshotAt(prepared, 111).counters.violations).toBe(1);
    expect(sceneAt(prepared, 20)).toEqual(sceneAt(prepared, 20));
  });

  it('무대: 도착 전 숨김 → 책상으로 걸어감 → 응답 후 퇴장', () => {
    expect(sceneAt(prepared, 0).actors[1]!.visible).toBe(false);
    const mid = sceneAt(prepared, 10).actors[0]!;
    expect(mid.visible && mid.walking).toBe(true);
    const atDesk = sceneAt(prepared, 60).actors[0]!;
    expect(atDesk.walking).toBe(false);
    expect(sceneAt(prepared, TOTAL).actors.every((a) => !a.visible)).toBe(true);
  });
});

describe('재생 저장소', () => {
  it('재생하면 자동 멈춤에서 서고, 다시 재생하면 끝까지 간다', () => {
    const store = createPlaybackStore(g01NaiveOverwrite);
    store.getState().play();
    store.getState().tick(1e9);
    let s = store.getState();
    expect(s.playing).toBe(false);
    expect(s.P).toBeCloseTo(prepared.stops[0]!.at);
    expect(s.callout?.phase).toBe('custom:lost_update');
    s.play();
    expect(store.getState().callout).toBeNull();
    store.getState().tick(1e9);
    s = store.getState();
    expect(s.P).toBe(TOTAL);
    expect(s.playing).toBe(false);
  });

  it('자동 멈춤을 끄면 서지 않는다', () => {
    const store = createPlaybackStore(g01NaiveOverwrite);
    store.getState().toggleAuto();
    store.getState().play();
    store.getState().tick(1e9);
    expect(store.getState().P).toBe(TOTAL);
  });

  it('단계 이동으로 핵심 이벤트에 도착하면 같은 설명을 띄운다', () => {
    const store = createPlaybackStore(g01NaiveOverwrite);
    store.getState().next();
    expect(store.getState().callout).toBeNull();
    store.getState().next();
    expect(store.getState().callout?.phase).toBe('custom:lost_update');
  });
});
