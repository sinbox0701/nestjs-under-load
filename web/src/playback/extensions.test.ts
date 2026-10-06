import { describe, expect, it } from 'vitest';
import type { Phase, Recording, RunEvent } from '../events/types';
import {
  AUTO_STOP_DELAY,
  STEP_EPS,
  buildRows,
  computeAutoStops,
  prepare,
  roundAt,
  rowTarget,
  withCause,
} from './index';

const ev = (t: number, phase: Phase, x: Partial<RunEvent> = {}): RunEvent => ({
  id: `${phase}@${t}`,
  t,
  actor: 'a',
  phase,
  ...x,
});

const rec = (events: RunEvent[], extra: Partial<Recording> = {}, delay?: number): Recording => ({
  meta: {
    runId: 'x',
    pack: 'p',
    scenario: 's',
    scenarioTitle: 's',
    strategy: { id: 'x', label: 'x', kind: 'broken' },
    sceneType: 'generic-timeline',
    actors: ['a', 'b'],
    totalActors: 2,
    isolation: 'READ COMMITTED',
    route: '/',
    durationMs: 200,
    ...(delay !== undefined ? { autoStopDelayMs: delay } : {}),
  },
  events,
  ...extra,
});

describe('재생 엔진 확장(선택 필드)', () => {
  it('stopKey가 다르면 같은 phase라도 따로 선다', () => {
    const stops = computeAutoStops([
      ev(10, 'conflict', { stopKey: 'x' }),
      ev(12, 'conflict', { stopKey: 'y' }),
      ev(14, 'conflict', { stopKey: 'y' }),
    ]);
    expect(stops.map((s) => s.events.length)).toEqual([1, 2]);
  });

  it('이벤트 autoStop이 phase 기본값보다 우선하고, 기록의 지연(0)을 쓴다', () => {
    const p = prepare(
      rec(
        [
          ev(10, 'committed', { autoStop: true }),
          ev(20, 'conflict', { autoStop: false }),
          ev(30, 'lock_wait'),
        ],
        {},
        0,
      ),
    );
    expect(p.stops.map((s) => [s.phase, s.at])).toEqual([
      ['committed', 10],
      ['lock_wait', 30],
    ]);
    // 지연이 없으면 기본값
    expect(prepare(rec([ev(30, 'lock_wait')])).stops[0]!.at).toBe(30 + AUTO_STOP_DELAY);
  });

  it('원인(cause) 멈춤은 토글로 끈다', () => {
    const p = prepare(
      rec([ev(5, 'db_read', { autoStop: true, cause: true }), ev(9, 'conflict')], {}, 0),
    );
    expect(p.stops.map((s) => s.phase)).toEqual(['db_read', 'conflict']);
    expect(withCause(p, false).stops.map((s) => s.phase)).toEqual(['conflict']);
    expect(prepare(rec(p.recording.events, {}, 0), { cause: false }).stops).toHaveLength(1);
  });

  it('mergeKey가 다르면 행을 묶지 않고, 착지점은 기록 규칙을 따른다', () => {
    const events = [
      ev(1, 'committed', { mergeKey: 'a' }),
      ev(2, 'committed', { mergeKey: 'b' }),
      ev(3, 'committed', { mergeKey: 'b' }),
    ];
    const rows = buildRows(
      events,
      { view: 'all', off: new Set() },
      { isAuto: (_p, e) => e.t === 3, delay: 0 },
    );
    expect(rows.map((r) => r.events.length)).toEqual([1, 2]);
    expect(rowTarget(rows[0]!)).toBe(1 + STEP_EPS);
    expect(rowTarget(rows[1]!)).toBe(3);
  });

  it('phase 덮어쓰기(Recording.phases)가 핵심 보기에 반영된다', () => {
    const r = rec([ev(1, 'db_read')], { phases: { db_read: { key: true, group: 'read' } } });
    const p = prepare(r);
    expect(p.info('db_read')).toMatchObject({ key: true, group: 'read', label: '읽기' });
    expect(buildRows(p.events, { view: 'key', off: new Set() }, { info: p.info })).toHaveLength(1);
    expect(buildRows(p.events, { view: 'key', off: new Set() })).toHaveLength(0);
  });

  it('라운드 경계: 기록에 없으면 전체가 한 라운드', () => {
    const p = prepare(rec([ev(1, 'arrived')]));
    expect(roundAt(p, 150)).toMatchObject({ index: 0, start: 0, end: 200 });
    const q = prepare(
      rec([ev(1, 'arrived')], {
        rounds: [
          { index: 0, start: 0, end: 100, baseVersion: 7, endVersion: 9 },
          { index: 1, start: 100, end: 200, baseVersion: 9, endVersion: 11 },
        ],
      }),
    );
    expect(roundAt(q, 99.9).index).toBe(0);
    expect(roundAt(q, 100).index).toBe(1);
  });
});
