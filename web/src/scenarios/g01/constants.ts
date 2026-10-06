/**
 * G01 같은 문서 동시 수정 — 설정 값(design/mockup.html 2절 그대로).
 * 생성기는 무대 ms(= 실제 ms × STAGE_PER_REAL)로 시각을 만들고 마지막에 실제 ms로 나눈다.
 */
import type { StrategyKind } from '../../events/types';

/** 내부 짧은 id(시안 코드 표와 seed 계산이 이 순서를 쓴다). */
export type G01StrategyId = 'naive' | 'blind' | 'opt' | 'lease';

export interface G01Strategy {
  id: G01StrategyId;
  /** 팩 strategy id. */
  code: 'naive-overwrite' | 'blind-retry' | 'optimistic-version' | 'field-merge' | 'edit-lease';
  name: string;
  kind: StrategyKind;
  tag: '고장' | '고침' | '절충';
  /** seed 계산용 시안 인덱스(field-merge 포함 순서). */
  seedIndex: number;
}

export const G01_STRATEGIES: readonly G01Strategy[] = [
  {
    id: 'naive',
    code: 'naive-overwrite',
    name: '덮어쓰기',
    kind: 'broken',
    tag: '고장',
    seedIndex: 0,
  },
  {
    id: 'blind',
    code: 'blind-retry',
    name: '맹목 재시도',
    kind: 'broken',
    tag: '고장',
    seedIndex: 1,
  },
  {
    id: 'opt',
    code: 'optimistic-version',
    name: '버전 감지',
    kind: 'fixed',
    tag: '고침',
    seedIndex: 2,
  },
  {
    id: 'lease',
    code: 'edit-lease',
    name: '편집 잠금',
    kind: 'tradeoff',
    tag: '절충',
    seedIndex: 4,
  },
];

/** 준비 중(시안에서 비활성). */
export const G01_SOON = [
  { code: 'field-merge', name: '필드 병합', kind: 'tradeoff', tag: '절충' },
] as const;

export const PEOPLE = [2, 3, 4] as const;
export type People = (typeof PEOPLE)[number];

export const SHAPES = [
  { id: 'const', name: '일정', bars: [4, 4, 4, 4, 4, 4] },
  { id: 'ramp', name: '램프', bars: [1, 2, 3, 4, 5, 6] },
  { id: 'spike', name: '스파이크', bars: [2, 2, 7, 2, 2, 2] },
] as const;
export type ShapeId = (typeof SHAPES)[number]['id'];

export const EDITS = [
  { name: '압축', real: 0.035, long: '압축(실험실 think time 35ms)' },
  { name: '2초', real: 2, long: '2초' },
  { name: '30초', real: 30, long: '30초' },
  { name: '5분', real: 300, long: '5분' },
] as const;

export const ROUNDS = 4;
/** 편집 구간은 길이와 상관없이 같은 길이로 압축해 그린다(무대 ms). */
export const EDIT_STAGE = 1400;
/** 잠금 TTL(실험실은 줄여서 재현, 무대 ms). */
export const TTL_STAGE = 4200;
/** 라운드 끝 여유(무대 ms). */
export const ROUND_TAIL = 1600;
/** 시작 문서 버전·fence. */
export const START_VERSION = 7;
export const START_FENCE = 11;

export const LABELS = ['A', 'B', 'C', 'D'] as const;
export const ROUTE = '/documents/7';
