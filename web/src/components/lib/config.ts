/**
 * 화면 쪽 설정 보조: 시나리오 레지스트리(web/src/scenarios)에 없는 표시용 값만 둔다.
 * 문구는 design/mockup.html 최종본을 따른다.
 */
import type { StrategyKind } from '../../events/types';
import { SCENARIOS, type ScenarioDef, type ScenarioId } from '../../scenarios';
import type { IconName } from './icons';

export type { ScenarioId };
export type Tone3 = 'bad' | 'ok' | 'info';

export const SCENARIO_UI: Record<
  ScenarioId,
  { code: 'G01' | 'G02'; question: string; tip: string }
> = {
  'g01-shared-document': {
    code: 'G01',
    question: '두 사람이 같은 문서를 동시에 고치면?',
    tip: '범용 팩 G01. 세무 팩 T01(수정 vs 승인 동시 도착)은 같은 무대 타입을 쓰지만 다른 장면이다.',
  },
  'g02-stock-decrement': {
    code: 'G02',
    question: '여러 명이 마지막 재고를 동시에 사면?',
    tip: '범용 팩 G02. 같은 상품 재고를 여럿이 동시에 차감한다(packs/generic/g02-stock-decrement).',
  },
};

export const SCENARIO_IDS = SCENARIOS.map((s) => s.id);

export function scenarioDef(id: ScenarioId): ScenarioDef {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]!;
}

/** meta.scenario('g01-…', 'g02-…')에서 시나리오 id. */
export function scenarioIdOf(metaScenario: string): ScenarioId {
  return /g02/i.test(metaScenario) ? 'g02-stock-decrement' : 'g01-shared-document';
}

/** 처리 방식 태그: 고장 ✕ · 고침 ✓ · 절충 자물쇠(색 = 상태 색). */
export function tagOf(kind: StrategyKind): { tone: Tone3; tag: string; icon: IconName } {
  if (kind === 'broken') return { tone: 'bad', tag: '고장', icon: 'cross' };
  if (kind === 'fixed') return { tone: 'ok', tag: '고침', icon: 'check' };
  return { tone: 'info', tag: '절충', icon: 'lock' };
}

export function strategyOf(scenario: ScenarioId, id: string) {
  const list = scenarioDef(scenario).strategies;
  return list.find((s) => s.id === id) ?? list[0]!;
}

/** 다음 처리 방식(준비 중은 건너뜀). `S` 키 순환. */
export function nextStrategy(scenario: ScenarioId, id: string): string {
  const list = scenarioDef(scenario).strategies;
  let i = list.findIndex((s) => s.id === id);
  for (let k = 0; k < list.length; k++) {
    i = (i + 1) % list.length;
    if (!list[i]!.disabled) break;
  }
  return list[i]!.id;
}

/** 부하 모양 글리프(6칸 막대). */
export const SHAPE_BARS: Record<string, number[]> = {
  const: [4, 4, 4, 4, 4, 4],
  ramp: [1, 2, 3, 4, 5, 6],
  spike: [2, 2, 7, 2, 2, 2],
};

/** 재생 속도 라벨(SPEEDS 순서와 같다: 1/400 · 1/160 · 1/80 · 1/40). */
export const SPEED_LABELS = ['아주 느리게', '느리게', '보통', '빠르게'] as const;

export const LABELS = ['A', 'B', 'C', 'D'] as const;

/** 실행 설정: 시나리오 + 처리 방식 + 시나리오 옵션 값. */
export interface RunConfig {
  scenario: ScenarioId;
  strategy: string;
  options: Record<string, string | number | boolean>;
}

export function defaultConfig(scenario: ScenarioId = 'g01-shared-document'): RunConfig {
  const d = scenarioDef(scenario);
  return {
    scenario,
    strategy: d.strategies.find((s) => !s.disabled)!.id,
    options: Object.fromEntries(d.options.map((o) => [o.key, o.default])),
  };
}
