/**
 * 시나리오 기록 레지스트리: (scenario, strategy, 옵션) → Recording.
 * 같은 입력이면 같은 기록(결정적)이다. 기록은 만들 때마다 새 객체라 화면은 필요하면 memo한다.
 */
import type { CodeSource, Recording, StrategyKind } from '../events/types';
import {
  EDITS,
  G01_STRATEGIES,
  PEOPLE,
  SHAPES,
  buildG01Recording,
  g01Code,
  type G01Options,
} from './g01';
import { G02_STRATEGIES, buildG02Recording, g02Code, type G02Options } from './g02';

export { parseRich, richToPlain, TERMS, type RichSeg } from './rich';
export { buildG01Recording, type G01Options, type G01StrategyCode } from './g01';
export { buildG02Recording, type G02Options } from './g02';

export type ScenarioId = 'g01-shared-document' | 'g02-stock-decrement';

export type ScenarioRequest =
  | ({ scenario: 'g01-shared-document' } & G01Options)
  | ({ scenario: 'g02-stock-decrement' } & G02Options);

/** 화면 설정 패널이 그릴 옵션 정의. */
export interface OptionDef {
  key: string;
  label: string;
  values: { value: string | number | boolean; label: string }[];
  default: string | number | boolean;
  /** 이 strategy에서만 의미가 있음(없으면 전부). */
  onlyFor?: string[];
}

export interface ScenarioDef {
  id: ScenarioId;
  title: string;
  sceneType: string;
  strategies: { id: string; label: string; kind: StrategyKind; disabled?: boolean }[];
  options: OptionDef[];
  /** 기록이 실측인지(지금은 둘 다 시뮬레이션). */
  simulated: boolean;
}

export const SCENARIOS: readonly ScenarioDef[] = [
  {
    id: 'g01-shared-document',
    title: '같은 문서 동시 수정',
    sceneType: 'shared-document',
    strategies: [
      ...G01_STRATEGIES.map((s) => ({ id: s.code, label: s.name, kind: s.kind })),
      { id: 'field-merge', label: '필드 병합', kind: 'tradeoff' as const, disabled: true },
    ],
    options: [
      {
        key: 'people',
        label: '사람 수',
        values: PEOPLE.map((n) => ({ value: n, label: `${n}명` })),
        default: 2,
      },
      {
        key: 'shape',
        label: '도착 모양',
        values: SHAPES.map((s) => ({ value: s.id, label: s.name })),
        default: 'const',
      },
      {
        key: 'edit',
        label: '편집 시간',
        values: EDITS.map((e, i) => ({ value: i, label: e.name })),
        default: 0,
        onlyFor: ['edit-lease'],
      },
    ],
    simulated: true,
  },
  {
    id: 'g02-stock-decrement',
    title: '재고 차감 경합',
    sceneType: 'queue-at-counter',
    strategies: G02_STRATEGIES.map((s) => ({ id: s.code, label: s.label, kind: s.kind })),
    options: [
      {
        key: 'instances',
        label: '서버 대수',
        values: [
          { value: 1, label: '1대' },
          { value: 2, label: '2대' },
        ],
        default: 1,
      },
      {
        key: 'injected',
        label: '경합 창 30ms 주입',
        values: [
          { value: false, label: '없음' },
          { value: true, label: '있음' },
        ],
        default: false,
      },
    ],
    simulated: true,
  },
];

export function scenarioDef(id: ScenarioId): ScenarioDef {
  const d = SCENARIOS.find((s) => s.id === id);
  if (!d) throw new Error(`모르는 시나리오 ${id}`);
  return d;
}

/** 기록 만들기. */
export function buildRecording(req: ScenarioRequest): Recording {
  switch (req.scenario) {
    case 'g01-shared-document':
      return buildG01Recording(req);
    case 'g02-stock-decrement':
      return buildG02Recording(req);
  }
}

/** 나란히 비교용: 다른 처리 방식의 코드만. */
export function codeFor(scenario: ScenarioId, strategy: string): CodeSource {
  if (scenario === 'g01-shared-document') {
    const s = G01_STRATEGIES.find((x) => x.code === strategy);
    if (!s) throw new Error(`G01: 모르는 처리 방식 ${strategy}`);
    return g01Code(s.id);
  }
  const s = G02_STRATEGIES.find((x) => x.code === strategy);
  if (!s) throw new Error(`G02: 모르는 처리 방식 ${strategy}`);
  return g02Code(s.code);
}
