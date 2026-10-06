import { describe, expect, it } from 'vitest';
import { buildRecording, type ScenarioRequest } from '../scenarios';
import { SPEEDS } from './constants';
import { advance, buildCompressionMap } from './compression';
import { prepare } from './prepare';
import { createPlaybackStore } from './store';

/**
 * 자동 멈춤 뒤 `계속`(Space·▶ 계속) 회귀.
 * 브라우저 rAF의 첫 프레임 시각은 효과에서 잰 performance.now()보다 앞설 수 있어
 * tick이 음수 벽시계 ms를 받는다. 그때 P가 멈춤 지점 앞으로 물러나면 같은 지점에 다시 멈췄다.
 */

const CASES: [string, ScenarioRequest][] = [
  ['G01 덮어쓰기', { scenario: 'g01-shared-document', strategy: 'naive-overwrite', seed: 1 }],
  ['G01 버전 감지', { scenario: 'g01-shared-document', strategy: 'optimistic-version', seed: 1 }],
  ['G01 편집 잠금', { scenario: 'g01-shared-document', strategy: 'edit-lease', seed: 1 }],
  ['G02 행 잠금', { scenario: 'g02-stock-decrement', strategy: 'row-lock' }],
];

/** 실제 브라우저처럼: 재생 직후 첫 프레임은 음수, 이후는 들쭉날쭉한 양수. */
const FRAMES = [-32, -2.5, 0, 16.7, 8, 33, 16.7, 64];

describe('자동 멈춤에서 계속', () => {
  it('advance는 음수·0 벽시계 ms에서 P를 뒤로 옮기지 않는다', () => {
    const p = prepare(buildRecording(CASES[0]![1]));
    for (const speed of SPEEDS)
      for (const ff of [true, false]) {
        const map = buildCompressionMap(p.gaps, p.total, speed, ff);
        for (const s of p.stops) {
          for (const w of [-64, -32, -2.5, -1e-9, 0]) expect(advance(map, s.at, w)).toBe(s.at);
          expect(advance(map, s.at, 16.7)).toBeGreaterThan(s.at);
        }
      }
  });

  for (const [name, req] of CASES)
    for (const speed of SPEEDS)
      for (const ff of [true, false])
        for (const cause of [true, false])
          it(`${name} · ${speed}× · 빨리 감기 ${ff ? '켬' : '끔'} · 원인 멈춤 ${cause ? '켬' : '끔'}: 멈춤마다 계속하면 다음 멈춤으로 나아가 끝까지 간다`, () => {
            const store = createPlaybackStore(buildRecording(req));
            const st = store.getState();
            st.setSpeed(speed);
            if (!ff) st.toggleFF();
            if (!cause) st.toggleCause();
            const { stops, total } = store.getState().prepared;
            expect(stops.length).toBeGreaterThan(0);

            const visited: number[] = [];
            store.getState().play();
            let prevP = store.getState().P;
            let f = 0;
            for (let guard = 0; guard < 1e6; guard++) {
              const s = store.getState();
              if (!s.playing) {
                if (s.P >= total) break;
                // 자동 멈춤에 섰다: 설명이 떠 있고, 같은 지점을 두 번 방문하지 않는다.
                expect(s.callout?.at).toBe(s.P);
                expect(visited).not.toContain(s.P);
                visited.push(s.P);
                s.play(); // Space / ▶ 계속
                f = 0;
              }
              store.getState().tick(FRAMES[f++ % FRAMES.length]!);
              const P = store.getState().P;
              expect(P).toBeGreaterThanOrEqual(prevP);
              prevP = P;
            }
            expect(store.getState().P).toBe(total);
            expect(visited).toEqual(stops.map((s) => s.at));
          });
});
