import { describe, expect, it } from 'vitest';
import { prepare } from '../playback/prepare';
import { buildG01Recording, type G01StrategyCode } from '../scenarios/g01';
import { buildG02Recording, type G02StrategyCode } from '../scenarios/g02';
import { explainStop, calloutTarget } from './callout';
import { sceneOps } from './drawList';
import { stageInputOf } from './events';
import { buildLabels } from './labels';
import { stageSceneAt } from './scene';
import { txSummary } from './txsum';

/** 시나리오 생성기(C)의 G01 기록을 처음부터 끝까지 훑어도 무대 계산이 깨지지 않는지. */
const STRATS: G01StrategyCode[] = [
  'naive-overwrite',
  'blind-retry',
  'optimistic-version',
  'edit-lease',
];

describe('G01 시뮬레이션 기록 × 무대', () => {
  for (const strategy of STRATS)
    for (const people of [2, 4] as const)
      it(`${strategy} · ${people}명: 모든 이벤트 시각에서 장면·그릴 목록·글자·멈춤 설명이 나온다`, () => {
        const p = prepare(buildG01Recording({ strategy, people }));
        const input = stageInputOf(p);
        const labels = input.meta.actors;
        for (const e of p.events) {
          const s = stageSceneAt(input, e.t + 0.01, labels);
          expect(s.kind).toBe('shared-document');
          for (const o of sceneOps(s)) {
            expect(Number.isInteger(o.x) && Number.isInteger(o.y)).toBe(true);
          }
          buildLabels(s, 1, labels);
        }
        for (const st of p.stops) {
          const s = stageSceneAt(input, st.at, labels);
          const c = explainStop(input, st, labels);
          expect(c.rich ?? c.title).toBeTruthy();
          const t = calloutTarget(s, st, input.meta.actors);
          expect(t.x).toBeGreaterThanOrEqual(0);
          expect(txSummary(input, st, st.at, labels)?.lanes.length).toBeGreaterThan(0);
        }
      });

  it('덮어쓰기: 잃어버린 수정 멈춤에서 종이가 날아가고 DB 버전이 라운드마다 이어진다', () => {
    const p = prepare(buildG01Recording({ strategy: 'naive-overwrite', people: 2 }));
    const input = stageInputOf(p);
    const lost = p.stops.find((s) => s.phase === 'custom:lost_update')!;
    const s = stageSceneAt(input, lost.at, input.meta.actors);
    expect(s.kind === 'shared-document' && s.papers.length).toBeGreaterThan(0);
    const rounds = p.recording.rounds ?? [];
    expect(rounds.length).toBeGreaterThan(1);
    const r2 = stageSceneAt(input, rounds[1]!.start, input.meta.actors);
    expect(r2.kind === 'shared-document' && r2.doc.version).toBe(rounds[1]!.baseVersion);
  });
});

/** 시나리오 생성기(C)의 G02 기록이 무대(queue-at-counter)가 읽는 형식과 맞는지. */
const G02S: G02StrategyCode[] = ['no-lock', 'app-memory-lock', 'row-lock', 'conditional-update'];

describe('G02 시뮬레이션 기록 × 무대', () => {
  const sceneOf = (strategy: G02StrategyCode, instances: 1 | 2, injected: boolean) => {
    const p = prepare(buildG02Recording({ strategy, instances, injected }));
    const input = stageInputOf(p);
    const at = (P: number) => {
      const s = stageSceneAt(input, P, input.meta.actors);
      if (s.kind !== 'queue-at-counter') throw new Error(s.kind);
      return s;
    };
    return { p, input, at };
  };

  for (const strategy of G02S)
    for (const instances of [1, 2] as const)
      for (const injected of [false, true])
        it(`${strategy} · 서버 ${instances}대 · 주입 ${injected}: 처음 재고 3, 끝 재고 = 원장, 그릴 목록이 정수`, () => {
          const { p, at } = sceneOf(strategy, instances, injected);
          const first = at(p.events[0]!.t + 0.001);
          expect(first.stock.initial).toBe(3);
          expect(first.stock.qty).toBe(3);
          expect(first.perServer).toBe(instances === 2);
          expect(first.windows).toHaveLength(instances);
          for (const e of p.events) {
            const s = at(e.t + 0.001);
            for (const o of sceneOps(s))
              expect(Number.isInteger(o.x) && Number.isInteger(o.y)).toBe(true);
          }
          const end = at(p.total);
          const success = (p.recording.ledger ?? []).filter((x) => x.result === 'success').length;
          const finalStock = Number(
            p.events.filter((e) => e.phase === 'committed').at(-1)!.attrs!.qty,
          );
          expect(end.stock.qty).toBe(finalStock);
          expect(end.stock.oversold).toBe(success > 3);
          expect(end.stock.lockHolder).toBeNull();
          expect(end.windows.every((w) => w.lockHolder === null)).toBe(true);
          // 응답 이벤트도 코드 마커를 가진다
          for (const e of p.events.filter((x) => x.phase === 'responded'))
            expect(e.codeRef).toBeTruthy();
        });

  it('락 없음: 초과 판매 이벤트에서 상자가 초과 판매 표시', () => {
    const { p, at } = sceneOf('no-lock', 1, false);
    const o = p.events.find((e) => e.phase === 'custom:oversold')!;
    expect(o).toBeTruthy();
    const s = at(o.t + 0.001);
    expect(s.stock.oversold).toBe(true);
    expect(s.pops.some((x) => x.text.includes('초과 판매'))).toBe(true);
  });

  it('행 락: 대기자는 줄에 서고 상자 자물쇠는 보유자, 품절은 0행 말풍선', () => {
    const { p, input, at } = sceneOf('row-lock', 1, true);
    const w = p.events.find((e) => e.phase === 'lock_wait')!;
    const s = at(w.t + 0.001);
    expect(s.queued).toBeGreaterThan(0);
    expect(s.bubbles.some((b) => b.text.includes('행 락'))).toBe(true);
    // 보유자의 FOR UPDATE 결과(lock_acquired)가 오면 상자 자물쇠 = 보유자, 대기자는 아직 줄에
    const held = p.events.find(
      (e) => e.phase === 'lock_acquired' && e.actor === w.attrs!.owner && e.t >= w.t,
    )!;
    const s2 = at(held.t + 0.001);
    expect(s2.stock.lockHolder).toBe(input.meta.actors.indexOf(held.actor));
    expect(s2.queued).toBeGreaterThan(0);
    const so = p.events.find((e) => e.phase === 'custom:sold_out')!;
    expect(so.attrs!.reason).toBe('sold_out');
    expect(at(so.t + 0.001).bubbles.some((b) => b.text === '품절 · 0행')).toBe(true);
  });

  it('메모리 락 2대: 창구마다 자물쇠, 행 락 대기는 행 락으로 표시', () => {
    const { p, at } = sceneOf('app-memory-lock', 2, true);
    const acq = p.events.filter((e) => e.phase === 'lock_acquired' && e.attrs?.lock === 'memory');
    const s = at(acq[1]!.t + 0.001);
    expect(s.windows.filter((x) => x.lockHolder !== null).length).toBe(2);
    // 창구 mutex를 쥔 B가 A의 행 락을 기다리면 줄로 가지 않고 창구에서 "행 락 대기"
    const rw = p.events.find((e) => e.phase === 'lock_wait' && e.attrs?.lock === 'row')!;
    const s2 = at(rw.t + 0.001);
    const bi = p.recording.meta.actors.indexOf(rw.actor);
    expect(s2.bubbles.some((b) => b.actor === bi && b.text === 'A의 행 락 대기')).toBe(true);
    expect(s2.windows[1]!.lockHolder).toBe(bi);
  });
});
