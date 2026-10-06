import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { prepare } from '../../playback';
import { G02_MEASURED, buildG02Recording, situationOf, type G02StrategyCode } from './index';

const LEARN = Object.values(
  import.meta.glob<string>('../../../../packs/generic/g02-stock-decrement/learn.yaml', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
)[0]!;
const STRATS: G02StrategyCode[] = ['no-lock', 'row-lock', 'conditional-update', 'app-memory-lock'];
const COMBOS = STRATS.flatMap((s) =>
  ([1, 2] as const).flatMap((i) => [false, true].map((inj) => [s, i, inj] as const)),
);

interface Outcome {
  strategy: string;
  situation: string;
  verdict: string;
  measured: null | {
    run: string;
    summary: string;
    throughputRps: { median: number };
    p95Ms: { median: number };
    failRatePct: { median: number };
    violations: Record<string, number[]>;
    ledgerSuccess: number[];
  };
}

describe('G02 실측 표 = learn.yaml', () => {
  const doc = parse(LEARN) as { outcomes: Outcome[]; situations: { id: string; label: string }[] };
  it('16개 조합의 판정·run·요약·중앙값이 learn.yaml과 같다', () => {
    expect(G02_MEASURED).toHaveLength(16);
    for (const m of G02_MEASURED) {
      const o = doc.outcomes.find((x) => x.strategy === m.strategy && x.situation === m.situation)!;
      expect(o, `${m.strategy} × ${m.situation}`).toBeTruthy();
      expect(m.verdict).toBe(o.verdict);
      expect(m.run).toBe(o.measured!.run);
      expect(m.summary).toBe(o.measured!.summary);
      expect(m.throughputRps).toBe(o.measured!.throughputRps.median);
      expect(m.p95Ms).toBe(o.measured!.p95Ms.median);
      expect(m.failRatePct).toBe(o.measured!.failRatePct.median);
      expect(m.violations).toEqual(o.measured!.violations);
      expect(m.ledgerSuccess).toEqual(o.measured!.ledgerSuccess);
      expect(m.situationLabel).toBe(doc.situations.find((s) => s.id === m.situation)!.label);
    }
  });
});

describe('G02 대표 시뮬레이션: 원장 판정이 learn.yaml 판정과 같은 방향', () => {
  it.each(COMBOS)('%s · 서버 %i대 · 주입 %s', (strategy, instances, injected) => {
    const r = buildG02Recording({ strategy, instances, injected });
    const m = G02_MEASURED.find(
      (x) => x.strategy === strategy && x.situation === situationOf(instances, injected),
    )!;
    const waits = r.events.filter((e) => e.phase === 'lock_acquired').map((e) => e.durMs ?? 0);
    const maxWait = Math.max(0, ...waits);
    const lost = r.events.filter((e) => e.phase === 'custom:lost_update').length;
    // 잃어버린 갱신 이벤트 수 = 원장 판정(성공 수량 − 실제 차감)
    expect(lost).toBe(r.verdict!.checks['sold-equals-decrement']);
    expect(prepare(r).cumulative.at(-1)!.violations).toBe(r.verdict!.violations);
    if (m.verdict === 'broken') {
      expect(r.verdict!.violations).toBeGreaterThan(0);
      expect(r.verdict!.ok).toBe(false);
    } else {
      expect(r.verdict!.violations).toBe(0);
      expect(r.verdict!.ok).toBe(true);
      if (m.verdict === 'slow') expect(maxWait).toBeGreaterThanOrEqual(30);
      else expect(maxWait).toBeLessThan(5);
    }
    // 원장: 대표 요청 4개 모두 한 행씩, 요청 ID 중복 없음
    expect(r.ledger).toHaveLength(4);
    expect(r.verdict!.checks['no-duplicate-request-id']).toBe(0);
    expect(r.notice).toMatchObject({ kind: 'simulated', label: '시뮬레이션 기록(실측 아님)' });
    expect(r.notice!.reference).toMatchObject({ run: m.run, verdict: m.verdict });
    expect(r.summary!.measured).toMatchObject({
      p95Ms: m.p95Ms,
      throughputRps: m.throughputRps,
      failPct: m.failRatePct,
      run: m.run,
      condition: m.situationLabel,
    });
    // 품절은 custom:sold_out으로만, 충돌·실패 카운트에 섞이지 않는다
    const soldOut = r.ledger!.filter((x) => x.result === 'sold_out').length;
    expect(r.events.filter((e) => e.phase === 'custom:sold_out')).toHaveLength(soldOut);
    expect(r.events.some((e) => e.phase === 'conflict')).toBe(false);
    expect(r.summary!.soldOut).toBe(soldOut);
    expect(r.summary!.conflicts).toBe(0);
    const end = prepare(r).cumulative.at(-1)!;
    expect(end.conflicts).toBe(0);
    expect(end.soldOut).toBe(soldOut);
    // 실측·시뮬레이션 판정 방향이 다를 때만 differs
    const measuredBad = m.violations['sold-equals-decrement']!.some((x) => x > 0);
    expect(!!r.notice!.differs).toBe(measuredBad !== !r.verdict!.ok);
    expect(r.events.some((e) => e.injected)).toBe(injected);
  });

  it('메모리 mutex는 1대에서 직렬, 2대에서 인스턴스끼리 서로를 모른다', () => {
    const one = buildG02Recording({ strategy: 'app-memory-lock', instances: 1 });
    const two = buildG02Recording({ strategy: 'app-memory-lock', instances: 2 });
    expect(one.verdict!.ok).toBe(true);
    expect(two.verdict!.ok).toBe(false);
    expect(two.meta.actorInstances).toEqual({ A: 'app-1', B: 'app-2', C: 'app-1', D: 'app-2' });
    const lost = two.events.find((e) => e.phase === 'custom:lost_update')!;
    expect(two.meta.actorInstances![lost.actor]).not.toBe(
      two.meta.actorInstances![lost.attrs!.by as string],
    );
    expect(two.notice!.differs).toMatch(
      /^실측 3회 위반 0 — 이 장면은 드물게 나는 겹침을 고른 시뮬레이션이다/,
    );
    expect(two.notice!.text).toContain(two.notice!.differs!);
  });

  it('락 없음: 같은 재고를 두 번째로 읽은 장면이 원인 멈춤이다', () => {
    const r = buildG02Recording({ strategy: 'no-lock' });
    const stops = prepare(r).stops;
    expect(stops[0]!.phase).toBe('db_read');
    expect(stops[0]!.events[0]!.cause).toBe(true);
    expect(stops.some((s) => s.phase === 'custom:lost_update')).toBe(true);
    for (const s of stops) expect(s.at).toBe(s.events.at(-1)!.t);
  });

  it('codeRef는 팩 소스의 `// @event` 마커 줄을 가리킨다', () => {
    for (const s of STRATS) {
      const r = buildG02Recording({ strategy: s, instances: 2, injected: true });
      const lines = r.code!.source.split('\n');
      expect(r.code!.example).toBe(false);
      for (const e of r.events) {
        if (!e.codeRef) continue;
        const [path, n] = [
          e.codeRef.slice(0, e.codeRef.lastIndexOf(':')),
          Number(e.codeRef.split(':').pop()),
        ];
        expect(path).toBe(`packs/generic/g02-stock-decrement/strategies/${s}.strategy.ts`);
        const line = lines[n - 1]!;
        expect(line).toMatch(new RegExp(`// @event .*\\b${e.marker!.replace(':', '\\:')}\\b`));
        if (e.phase === 'injected_delay') expect(line).toContain("'after-read'");
      }
    }
  });

  it('phase 라벨 덮어쓰기: 품절 409(wait), 잃어버린 갱신', () => {
    const r = buildG02Recording({ strategy: 'conditional-update' });
    const p = prepare(r);
    expect(p.info('custom:sold_out')).toMatchObject({ label: '품절 409', tone: 'wait' });
    expect(p.info('custom:lost_update').label).toBe('잃어버린 갱신');
    expect(p.info('custom:lost_update').tone).toBe('bad');
  });
});

describe('G02 실패율 설명 = learn.yaml why', () => {
  const doc = parse(LEARN) as { outcomes: (Outcome & { why: string })[] };
  it('실패율이 0이 아니면 failWhy가 있고 learn.yaml why도 k6 드롭이라고 한다', () => {
    for (const m of G02_MEASURED) {
      const o = doc.outcomes.find((x) => x.strategy === m.strategy && x.situation === m.situation)!;
      if (m.failRatePct > 0) {
        expect(m.failWhy, `${m.strategy} × ${m.situation}`).toMatch(/k6 dropped_iterations/);
        expect(o.why).toMatch(/k6 (dropped_iterations|드롭)/);
      } else expect(m.failWhy).toBeUndefined();
    }
  });
});
