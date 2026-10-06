import { describe, expect, it } from 'vitest';
import { phaseInfo } from '../../events/phases';
import type { Recording, RunEvent } from '../../events/types';
import { prepare } from '../../playback/prepare';
import { buildRows } from '../../playback/rows';
import { buildRecording } from '../../scenarios';
import {
  bandsOf,
  causeRow,
  currentRow,
  lastPerActor,
  legendOf,
  rowRound,
  sessionState,
  tickTone,
} from './model';

const ev = (
  t: number,
  actor: string,
  phase: RunEvent['phase'],
  o: Partial<RunEvent> = {},
): RunEvent => ({
  id: `${actor}${t}${phase}`,
  t,
  actor,
  phase,
  ...o,
});

describe('스크러버 눈금 색', () => {
  it('위반·409=빨강, 행 락 대기·첫 423=노랑, 재시도(노크 제외)=주황, 원인=파랑', () => {
    expect(tickTone(ev(1, 'A', 'custom:lost_update'))).toBe('bad');
    expect(tickTone(ev(1, 'A', 'conflict'))).toBe('bad');
    expect(tickTone(ev(1, 'A', 'lock_wait'))).toBe('wait');
    expect(tickTone(ev(1, 'A', 'custom:lease_rejected', { attrs: { first: true } }))).toBe('wait');
    expect(tickTone(ev(1, 'A', 'custom:lease_rejected'))).toBeNull();
    expect(tickTone(ev(1, 'A', 'retry'))).toBe('retry');
    expect(tickTone(ev(1, 'A', 'retry', { attrs: { knock: true } }))).toBeNull();
    expect(tickTone(ev(1, 'A', 'db_read', { cause: true }))).toBe('read');
    expect(tickTone(ev(1, 'A', 'committed'))).toBeNull();
  });
});

describe('타임라인 행', () => {
  const rec = buildRecording({ scenario: 'g01-shared-document', strategy: 'naive-overwrite' });
  const p = prepare(rec);
  const rows = buildRows(p.events, { view: 'key', off: new Set() }, { info: p.info });

  it('핵심 행은 같은 사람끼리만 묶는다(A 커밋 / B 커밋이 따로)', () => {
    const r0 = rows.filter((r) => rowRound(p.rounds, r) === 0);
    const commits = r0.filter((r) => r.phase === 'committed');
    expect(commits.length).toBeGreaterThanOrEqual(2);
    for (const r of commits) expect(new Set(r.events.map((e) => e.actor)).size).toBe(1);
  });

  it('잃어버린 수정 설명 중이면 덮어쓴 사람의 화면 열기 읽기가 원인 행', () => {
    const r0 = rows.filter((r) => rowRound(p.rounds, r) === 0);
    const stop = p.stops.find((s) => s.phase === 'custom:lost_update')!;
    const i = causeRow(r0, rec.meta, stop);
    expect(i).toBeGreaterThanOrEqual(0);
    const by = stop.events[0]!.attrs!.by;
    expect(r0[i]!.events.some((e) => e.phase === 'db_read' && e.actor === by)).toBe(true);
    expect(causeRow(r0, rec.meta, null)).toBe(-1);
  });

  it('현재 행 = P 이하에 도착한 마지막 행', () => {
    expect(currentRow(rows, -1)).toBe(-1);
    expect(currentRow(rows, rows[2]!.t)).toBe(2);
  });
});

describe('트랜잭션 띠', () => {
  it('기록의 txBands를 라운드 기준 시각·클래스로 옮긴다', () => {
    const rec = buildRecording({ scenario: 'g01-shared-document', strategy: 'optimistic-version' });
    const p = prepare(rec);
    const rd = p.rounds[1]!;
    const bands = bandsOf(rec, p.events, p.rounds, rd, 'A', p.info);
    expect(bands.length).toBeGreaterThan(0);
    for (const b of bands) {
      if (b.kind === 'band') {
        expect(b.cls).toMatch(/^bd-/);
        expect(b.start).toBeGreaterThanOrEqual(-5);
        expect(b.start).toBeLessThan(rd.end - rd.start);
      }
    }
    expect(bands.some((b) => b.kind === 'band' && b.cls === 'bd-tx')).toBe(true);
  });

  it('띠가 없는 기록은 커밋·실패 표시만 이벤트에서', () => {
    const rec: Recording = {
      meta: {
        runId: 'r',
        pack: 'g',
        scenario: 'g01',
        scenarioTitle: 't',
        strategy: { id: 'naive-overwrite', label: 'n', kind: 'broken' },
        sceneType: 's',
        actors: ['A', 'B'],
        totalActors: 2,
        isolation: 'READ COMMITTED',
        route: '/',
        durationMs: 10,
      },
      events: [ev(1, 'A', 'committed'), ev(2, 'A', 'conflict'), ev(3, 'B', 'committed')],
    };
    const p = prepare(rec);
    const bands = bandsOf(rec, p.events, p.rounds, p.rounds[0]!, 'A', phaseInfo);
    expect(bands).toEqual([
      { kind: 'mark', mark: 'ok', t: 1, tip: '커밋' },
      { kind: 'mark', mark: 'bad', t: 2, tip: '충돌 409' },
    ]);
  });

  it('범례: 편집 잠금은 자동 커밋 UPDATE·잠금 보유·423, 그 밖은 행 락 대기', () => {
    const lease = legendOf(null, 'g01-shared-document', 'edit-lease').map((x) => x.cls);
    expect(lease).toEqual(expect.arrayContaining(['bd-ac', 'bd-ls', 'mark wait']));
    expect(lease).not.toContain('bd-wt');
    const opt = legendOf(null, 'g01-shared-document', 'optimistic-version').map((x) => x.cls);
    expect(opt).toContain('bd-wt');
  });
});

describe('서버 속 · 거터 커서', () => {
  it('세션 상태: 행 락 대기 / 문장 실행 중 / 트랜잭션 연 채 문장 없음', () => {
    expect(sessionState({ state: 'lock_wait' })).toBe('active · Lock');
    expect(sessionState({ state: 'active', sql: 'select 1' })).toBe('active');
    expect(sessionState({ state: 'active' })).toBe('idle in transaction');
  });

  it('각자 이 라운드 마지막 이벤트, 응답하고 나간 사람은 뺀다', () => {
    const events = [
      ev(0, 'A', 'arrived'),
      ev(1, 'B', 'arrived'),
      ev(2, 'A', 'responded'),
      ev(3, 'B', 'db_read'),
    ];
    const rd = { index: 0, start: 0, end: 10, baseVersion: 0, endVersion: 0 };
    const m = lastPerActor(events, rd, 3);
    expect([...m.keys()]).toEqual(['B']);
    expect(m.get('B')!.phase).toBe('db_read');
    expect([...lastPerActor(events, rd, 1).keys()]).toEqual(['A', 'B']);
  });
});
