// 실행 계획·식별자·작은 변환(scripts/run.mjs buildPlan·stamp·makeBatchId·makeRunId·warmupDiscardSql 이식).
// 순수 함수만 둔다. I/O 는 engine.ts 가 포트로 한다.
import type { RunRequest } from '@under-load/contracts';

import type { ScenarioDef } from '../ports.js';

/** 실행 1회 = (strategy, appInstances) 케이스의 repetition 번째. 같은 케이스의 반복이 한 batch. */
export type PlanItem = { strategy: string; appInstances: number; repetition: number };

export type PlanError = { path: string; message: string };

/** run.mjs 와 같은 규칙: app-memory-lock 은 요청에 1대가 없으면 1대 대조 케이스를 추가한다. */
export const MEMORY_LOCK_STRATEGY = 'app-memory-lock';

/** 요청이 시나리오 정의와 맞는지 본다(zod 검증은 이미 통과한 값). 문제가 없으면 빈 배열. */
export function validateRequest(request: RunRequest, scenario: ScenarioDef | undefined): PlanError[] {
  if (!scenario) return [{ path: 'scenario', message: `알 수 없는 시나리오 '${request.scenario}'` }];
  const known = scenario.strategies.map((s) => s.id);
  const errors: PlanError[] = [];
  request.strategies.forEach((s, i) => {
    if (!known.includes(s)) errors.push({ path: `strategies.${i}`, message: `manifest 에 없는 strategy '${s}' (가능: ${known.join(', ')})` });
  });
  request.appInstances.forEach((n, i) => {
    if (n < scenario.minAppInstances) {
      errors.push({ path: `appInstances.${i}`, message: `이 시나리오는 app ${scenario.minAppInstances}대 이상이 필요하다 (받은 값: ${n})` });
    }
  });
  return errors;
}

/** 케이스 = strategies × appInstances(+ memory-lock 1대), 케이스마다 reps 회. 순서는 run.mjs buildPlan 과 같다. */
export function buildPlan(request: RunRequest, minAppInstances = 1): PlanItem[] {
  const cases: { strategy: string; appInstances: number }[] = [];
  for (const strategy of request.strategies) {
    for (const n of request.appInstances) cases.push({ strategy, appInstances: n });
    if (
      strategy === MEMORY_LOCK_STRATEGY &&
      request.includeMemoryLockSingle &&
      !request.appInstances.includes(1) &&
      minAppInstances <= 1
    ) {
      cases.push({ strategy, appInstances: 1 });
    }
  }
  const plan: PlanItem[] = [];
  for (const c of cases) {
    for (let r = 1; r <= request.reps; r++) plan.push({ ...c, repetition: r });
  }
  return plan;
}

const scenarioShort = (scenario: string) => scenario.split('-')[0];

/** epoch ms → `2026-10-07T01-02-03Z` */
export function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

export function makeBatchId(sessionStamp: string, scenario: string, strategy: string, appInstances: number): string {
  return `${sessionStamp}_${scenarioShort(scenario)}_${strategy}_i${appInstances}`;
}

export function makeRunId(batchId: string, repetition: number): string {
  return `${batchId}_r${repetition}`;
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** k6 기간 문자열(`30s`, `1m30s`, `500ms`) → ms. 형식이 틀리면 throw. */
export function k6DurationMs(d: string): number {
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let consumed = 0;
  for (const m of d.matchAll(re)) {
    if (m.index !== consumed) break;
    total += Number(m[1]) * UNIT_MS[m[2]!]!;
    consumed += m[0].length;
  }
  if (consumed === 0 || consumed !== d.length) throw new Error(`기간 형식 오류: ${d}`);
  return total;
}

/** 시나리오 seed 기본값 위에 요청 seedOptions 를 덮는다(템플릿 이름·prepare-template 이 같은 값을 쓴다). */
export function mergedSeedOptions(request: RunRequest, scenario: ScenarioDef): Record<string, unknown> {
  return { ...scenario.seedDefaults, ...request.data.seedOptions };
}

/** strategy 기본 파라미터 위에 요청 strategyParams[strategy] 를 덮는다. */
export function strategyParams(request: RunRequest, scenario: ScenarioDef, strategy: string): Record<string, unknown> {
  const def = scenario.strategies.find((s) => s.id === strategy);
  return { ...(def?.params ?? {}), ...(request.strategyParams[strategy] ?? {}) };
}

/** discardSql 의 `{{key}}` 를 seedOptions 값으로 채운다(run.mjs 는 `{{products}}` 만 썼다). 없는 키면 throw. */
export function renderDiscardSql(sql: string, seedOptions: Record<string, unknown>): string {
  return sql
    .replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key: string) => {
      const v = seedOptions[key];
      if (typeof v !== 'number' && typeof v !== 'string') throw new Error(`discardSql: seedOptions.${key} 가 없다`);
      // SQL 에 그대로 들어가므로 숫자만 허용한다.
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`discardSql: seedOptions.${key} 가 숫자가 아니다`);
      return String(n);
    })
    .trim();
}
