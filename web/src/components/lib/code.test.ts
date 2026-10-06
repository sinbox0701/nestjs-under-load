import { describe, expect, it } from 'vitest';
import type { CodeSource, RunEvent } from '../../events/types';
import { buildRecording, codeFor } from '../../scenarios';
import {
  codeLines,
  eventLine,
  eventMarkers,
  foldKeyOf,
  foldPlan,
  lcsDiff,
  methodOf,
  resolveHit,
} from './code';

const SRC = [
  'export class Foo {', // 1
  '  async run() { // @event arrived', // 2
  '    const x = await read(); // @event db_read', // 3
  '    await write(x); // @event db_write', // 4
  '  } // @event committed rolled_back', // 5
  '}', // 6
].join('\n');
const code: CodeSource = {
  path: 'packs/x/strategies/foo.strategy.ts',
  lang: 'ts',
  source: SRC,
  example: false,
};
const ev = (o: Partial<RunEvent>): RunEvent => ({
  id: 'e',
  t: 0,
  actor: 'A',
  phase: 'arrived',
  ...o,
});

describe('이벤트 → 코드 줄 매핑', () => {
  it('`// @event` 마커: 한 줄에 여러 phase', () => {
    expect(eventMarkers(codeLines(code))).toEqual({
      arrived: 2,
      db_read: 3,
      db_write: 4,
      committed: 5,
      rolled_back: 5,
    });
  });

  it('marker → codeRef(같은 파일) → phase 마커 순서로 찾는다', () => {
    expect(eventLine(code, ev({ phase: 'db_read' }))).toBe(3);
    expect(eventLine(code, ev({ phase: 'db_read', marker: 'committed' }))).toBe(5);
    expect(eventLine(code, ev({ phase: 'db_read', codeRef: `${code.path}:6` }))).toBe(6);
    // 다른 파일의 codeRef는 무시하고 phase 마커로
    expect(eventLine(code, ev({ phase: 'db_write', codeRef: 'other.ts:1' }))).toBe(4);
    // 범위 밖·모르는 phase는 null
    expect(eventLine(code, ev({ phase: 'retry' }))).toBeNull();
    expect(eventLine(code, ev({ phase: 'db_read', codeRef: `${code.path}:99` }))).toBe(3);
  });

  it('SQL 상자: sqlLines가 있으면 그대로, 없으면 sql + 영향 행 수', () => {
    const tone = () => 'neutral' as const;
    const a = resolveHit(
      code,
      ev({ phase: 'db_write', sql: 'update t set a = $1', rows: 0 }),
      tone,
    )!;
    expect(a.sql).toEqual(['update t set a = $1', '→ 0 rows']);
    expect(a.tone).toBe('info');
    const b = resolveHit(
      code,
      ev({ phase: 'db_write', sqlLines: ['begin', 'x'], codeNote: '**n**', codeTone: 'bad' }),
      tone,
    )!;
    expect(b).toMatchObject({ line: 4, sql: ['begin', 'x'], note: '**n**', tone: 'bad' });
  });

  it('메서드 이름: 클래스.메서드()', () => {
    expect(methodOf(code, codeLines(code), 4)).toBe('Foo.run()');
  });

  it('G01 기록: 모든 이벤트가 시안 코드의 줄을 가리키고, 같이 실행된 줄도 찾는다', () => {
    const rec = buildRecording({ scenario: 'g01-shared-document', strategy: 'optimistic-version' });
    const c = rec.code!;
    for (const e of rec.events) {
      const hit = resolveHit(c, e, () => 'neutral');
      expect(hit, `${e.phase} ${e.marker}`).not.toBeNull();
    }
    const conflict = rec.events.find((e) => e.phase === 'conflict')!;
    const hit = resolveHit(c, conflict, () => 'neutral')!;
    expect(codeLines(c)[hit.line - 1]).toContain('ConflictException');
    expect(hit.also.length).toBeGreaterThan(0);
    expect(hit.tone).toBe('bad');
  });

  it('G02 기록: 팩 원문 줄(@event 마커)과 이어진다', () => {
    const rec = buildRecording({ scenario: 'g02-stock-decrement', strategy: 'row-lock' });
    const c = rec.code!;
    expect(c.source).toContain('LockMode.PESSIMISTIC_WRITE');
    const wait = rec.events.find((e) => e.phase === 'lock_wait')!;
    expect(codeLines(c)[eventLine(c, wait)! - 1]).toContain('@event lock_wait');
  });
});

describe('나란히 비교', () => {
  it('LCS diff: 바뀐 줄만 표시', () => {
    const d = lcsDiff(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
    expect(d.a).toEqual([false, true, false, false]);
    expect(d.b).toEqual([false, true, false, false, true]);
  });

  it('공통 줄 4줄 이상은 접고 앞뒤 1줄을 남긴다, 펼치면 다 보인다', () => {
    const changed = [true, false, false, false, false, false, true];
    const plan = foldPlan('cur', changed, new Set());
    expect(plan.map((x) => (x.type === 'fold' ? `fold${x.from}-${x.to}` : x.n))).toEqual([
      1,
      2,
      'fold3-5',
      6,
      7,
    ]);
    expect(foldKeyOf(plan, 4)).toBe('cur:1');
    expect(foldKeyOf(plan, 2)).toBeNull();
    const open = foldPlan('cur', changed, new Set(['cur:1']));
    expect(open.every((x) => x.type === 'line')).toBe(true);
    // 3줄 이하는 접지 않는다
    expect(foldPlan('cur', [true, false, false, false, true], new Set()).length).toBe(5);
  });

  it('맹목 재시도는 서버가 버전 감지와 같고 클라이언트 줄만 다르다', () => {
    const a = codeLines(codeFor('g01-shared-document', 'optimistic-version'));
    const b = codeLines(codeFor('g01-shared-document', 'blind-retry'));
    const d = lcsDiff(a, b);
    const clientFrom = b.findIndex((l) => l.startsWith('// ── 클라이언트'));
    expect(d.b.slice(0, clientFrom).some(Boolean)).toBe(false);
    expect(d.b.slice(clientFrom).some(Boolean)).toBe(true);
  });
});
