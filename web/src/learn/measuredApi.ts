/** 코드 실험실 실측 덧씌우기: `/learn/:scenario/measured`(C2) 응답을 learn.yaml 판정의 measured 에 얹는다. */
import { useEffect, useMemo, useState } from 'react';
import type { Api, LearnMeasured } from '../api';
import { normalizeMeasured } from './loader';
import type { Scenario } from './types';

/** 시나리오별 출처. api = 응답에 셀이 있어 덧씌움, file = 파일 값(응답이 비었거나 실패). */
export type MeasuredSource = { origin: 'api'; cells: number } | { origin: 'file'; failed: boolean };

/** 순수 함수. 응답의 셀을 같은 (strategy, situation) 판정의 measured 로 바꾼다. 맞는 판정이 없는 셀은 버린다. */
export function overlayMeasured(
  scenario: Scenario,
  res: LearnMeasured,
): { scenario: Scenario; cells: number } {
  let cells = 0;
  const outcomes = scenario.doc.outcomes.map((o) => {
    const cell = res.cells.find((c) => c.strategy === o.strategy && c.situation === o.situation);
    const measured = cell ? normalizeMeasured(cell.measured) : null;
    if (!measured) return o;
    cells += 1;
    return { ...o, measured };
  });
  if (cells === 0) return { scenario, cells: 0 };
  return { scenario: { ...scenario, doc: { ...scenario.doc, outcomes } }, cells };
}

/**
 * api 가 있으면 각 시나리오의 measured 를 불러와 덧씌운다. 없거나 실패하면 파일 값 그대로다.
 * 반환 scenarios 는 입력과 같은 순서·같은 dir 이다.
 */
export function useMeasuredOverlay(
  api: Api | undefined,
  base: Scenario[],
): { scenarios: Scenario[]; sources: Record<string, MeasuredSource> } {
  const [fetched, setFetched] = useState<Record<string, LearnMeasured | 'failed'>>({});

  useEffect(() => {
    if (!api) return;
    let alive = true;
    for (const s of base) {
      const id = s.doc.scenario;
      api.learnMeasured(id).then(
        (r) => alive && setFetched((m) => ({ ...m, [id]: r })),
        () => alive && setFetched((m) => ({ ...m, [id]: 'failed' })),
      );
    }
    return () => {
      alive = false;
    };
  }, [api, base]);

  return useMemo(() => {
    const sources: Record<string, MeasuredSource> = {};
    const scenarios = base.map((s) => {
      const r = fetched[s.doc.scenario];
      if (!r || r === 'failed') {
        sources[s.dir] = { origin: 'file', failed: r === 'failed' };
        return s;
      }
      const o = overlayMeasured(s, r);
      sources[s.dir] =
        o.cells > 0 ? { origin: 'api', cells: o.cells } : { origin: 'file', failed: false };
      return o.scenario;
    });
    return { scenarios, sources };
  }, [base, fetched]);
}
