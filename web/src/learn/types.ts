/** learn.yaml 규약(2026-10-07) 타입. 줄 번호는 데이터에 쓰지 않고 코드 마커로 찾는다. */

export type Verdict = 'ok' | 'broken' | 'slow' | 'rejects' | 'n/a';
export const VERDICTS: readonly Verdict[] = ['ok', 'broken', 'slow', 'rejects', 'n/a'];

export interface Concept {
  id: string;
  label: string;
  body: string;
}

export interface LoadSpec {
  model?: 'open' | 'closed' | string;
  vus?: number;
  rate?: number;
  shape?: string;
}

export interface Situation {
  id: string;
  label: string;
  load?: LoadSpec;
  instances?: number;
  /** 'none' 또는 { toxiproxy: { latencyMs } } 같은 주입 설정 */
  chaos?: 'none' | Record<string, unknown>;
  /** 모든 strategy의 같은 경합 창 지점(after-read)에 넣는 인위 지연(DESIGN §6.5). 화면에 "주입됨"으로 표시 */
  injected?: { contentionWindowMs?: number };
  note?: string;
}

export interface FocusRef {
  file: string;
  marker: string;
}

/** 실측. 원본은 문자열이거나 { run, ...수치 } 객체일 수 있어 하나로 맞춘다. */
export interface Measured {
  run: string | null;
  text: string;
  /** 경합 창 지연을 주입하고 잰 실측이면 그 ms(measured.injected.contentionWindowMs) */
  injectedMs?: number;
}

export interface Outcome {
  strategy: string;
  situation: string;
  verdict: Verdict;
  expected: string;
  measured: Measured | null;
  why: string;
  focus: FocusRef[];
  sql: string[];
  /** 규약 확장(선택): 이 판정과 관련된 concept id. 없으면 시나리오 concepts 전체를 보인다. */
  concepts?: string[];
}

export interface Choice {
  when: string;
  pick: string;
  because: string;
  avoid: string[];
}

export interface LearnDoc {
  scenario: string;
  title: string;
  concepts: Concept[];
  situations: Situation[];
  outcomes: Outcome[];
  choose: Choice[];
}

export type FileOrigin = 'packs' | 'fixture';

export interface LabFile {
  /** 시나리오 폴더 기준 경로. 예: strategies/no-lock.strategy.ts */
  path: string;
  source: string;
  origin: FileOrigin;
}

export interface StrategyInfo {
  id: string;
  label: string;
  /** manifest.yaml의 kind(broken/fixed/tradeoff). 없으면 null */
  kind: string | null;
  /** strategies/<id>.strategy.ts 경로. 파일이 없으면 null */
  file: string | null;
}

export interface Scenario {
  /** packs/ 기준 폴더. 예: generic/g02-stock-decrement */
  dir: string;
  pack: string;
  doc: LearnDoc;
  /** learn.yaml과 strategies를 어디서 가져왔나 */
  learnOrigin: FileOrigin;
  strategies: StrategyInfo[];
  files: LabFile[];
  /** 데이터를 읽으며 생긴 경고(파싱 실패 → fixture 대체, 마커 없음 등) */
  warnings: string[];
}
