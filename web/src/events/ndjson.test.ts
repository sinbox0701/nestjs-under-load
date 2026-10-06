import { describe, expect, it } from 'vitest';
import { prepare } from '../playback';
import { loadNdjson } from './ndjson';

const line = (o: Record<string, unknown>) =>
  JSON.stringify({ v: 1, runId: 'run_x', instance: 'app-1', sampled: true, injected: false, ...o });

describe('NDJSON 로더(DESIGN §9.1)', () => {
  const text = [
    line({ ts: 1_000_500, seq: 2, actor: '2-1', phase: 'arrived', reqId: 'r2' }),
    line({ ts: 1_000_000, seq: 1, actor: '1-1', phase: 'arrived', reqId: 'r1' }),
    line({ ts: 1_000_500, seq: 1, actor: '1-1', phase: 'db_read', instance: 'app-2', durMs: 0.4 }),
    '',
    'not json',
    line({
      ts: 1_003_000,
      seq: 3,
      actor: '1-1',
      phase: 'custom:lost_update',
      attrs: { by: '2-1' },
      codeRef: 'packs/a.ts:12',
    }),
    line({ ts: 1_004_000, seq: 4, actor: '9-9', phase: 'committed', sampled: false }),
    line({ ts: 1_004_000, seq: 5, actor: '1-1', phase: 'teleported' }),
    JSON.stringify({
      v: 9,
      runId: 'x',
      ts: 1,
      seq: 1,
      instance: 'a',
      actor: 'a',
      phase: 'arrived',
    }),
  ].join('\n');

  it('µs를 기록 시작부터의 ms로 바꾸고 ts → seq 순으로 정렬한다', () => {
    const { recording, errors } = loadNdjson(text, { meta: { scenario: 'g02-stock-decrement' } });
    expect(recording.events.map((e) => [e.t, e.actor, e.phase])).toEqual([
      [0, '1-1', 'arrived'],
      [0.5, '1-1', 'db_read'],
      [0.5, '2-1', 'arrived'],
      [3, '1-1', 'custom:lost_update'],
    ]);
    expect(recording.events[1]!.durMs).toBe(0.4);
    expect(recording.events[1]!.attrs?.instance).toBe('app-2');
    expect(recording.events[3]!.codeRef).toBe('packs/a.ts:12');
    expect(recording.meta.actors).toEqual(['1-1', '2-1']);
    expect(recording.meta.runId).toBe('run_x');
    expect(recording.notice?.kind).toBe('measured');
    expect(errors.map((e) => e.line)).toEqual([5, 8, 9]);
    expect(prepare(recording).cumulative.at(-1)!.violations).toBe(1);
  });

  it('onlySampled=false면 표본 밖 이벤트도 싣는다', () => {
    const { recording } = loadNdjson(text, { onlySampled: false });
    expect(recording.events.some((e) => e.actor === '9-9')).toBe(true);
  });

  it('정렬은 입력 순서와 무관한 전순서: ts → seq → instance → 원래 줄', () => {
    const ev = [
      line({ ts: 10, seq: 7, actor: 'x', phase: 'arrived', instance: 'app-2' }),
      line({ ts: 10, seq: 7, actor: 'y', phase: 'arrived', instance: 'app-1' }),
      line({ ts: 10, seq: 3, actor: 'z', phase: 'arrived', instance: 'app-3' }),
      line({ ts: 10, seq: 7, actor: 'w', phase: 'db_read', instance: 'app-1' }),
    ];
    const order = (lines: string[]) =>
      loadNdjson(lines.join('\n')).recording.events.map((e) => e.actor);
    expect(order(ev)).toEqual(['z', 'y', 'w', 'x']);
    // 같은 키(ts·seq·instance)끼리만 원래 줄 순이 남고, 나머지는 입력 순서와 무관
    expect(order([ev[3]!, ev[2]!, ev[1]!, ev[0]!])).toEqual(['z', 'w', 'y', 'x']);
    expect(order([ev[0]!, ev[2]!, ev[1]!, ev[3]!])).toEqual(['z', 'y', 'w', 'x']);
  });

  it('프로토콜 버전은 v=1만 받는다(v=0 거부)', () => {
    const { recording, errors } = loadNdjson(
      [line({ ts: 1, seq: 1, actor: 'a', phase: 'arrived', v: 0 })].join('\n'),
    );
    expect(recording.events).toHaveLength(0);
    expect(errors).toEqual([{ line: 1, reason: '모르는 프로토콜 버전 v=0' }]);
  });
});
