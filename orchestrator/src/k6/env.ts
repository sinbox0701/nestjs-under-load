// RunRequest → k6 env(C7)와 스크립트 해시.
import { createHash } from 'node:crypto';

import { K6_SCENARIO_ENV_KEYS } from '@under-load/contracts';

import type { K6EnvInput } from '../ports.js';

export type EnvOptions = {
  /** k6 가 때리는 주소(nginx 경유) */
  baseUrl: string;
  /** 대표 표본 액터 수(헤더 traceparent 플래그) */
  repActors?: number;
};

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** 시나리오 전용 키. 모르는 시나리오는 없음. */
function scenarioEnv({ scenario, request, phase, strategy }: K6EnvInput): Record<string, string> {
  const warm = phase === 'warmup';
  const seed = { ...scenario.seedDefaults, ...request.data.seedOptions };
  const params = request.scenarioParams;
  const id = scenario.id as keyof typeof K6_SCENARIO_ENV_KEYS;
  if (id === 'g02-stock-decrement') {
    // 웜업은 본 실행과 겹치지 않는 상품 범위(웜업 뒤 discardSql 로 지운다)
    const products = num(seed.products, 5);
    const warmupProducts = num(seed.warmupProducts, 5);
    return {
      PRODUCT_MIN: String(warm ? products + 1 : 1),
      PRODUCT_MAX: String(warm ? products + warmupProducts : products),
      QTY: String(num(params.qty, 1)),
    };
  }
  if (id === 'g01-shared-document') {
    const documents = num(seed.documents, 5);
    return {
      DOC_MIN: String(num(seed.docMin, 1)),
      DOC_MAX: String(num(seed.docMax, documents)),
      EDIT_MS: String(num(params.editMs, 50)),
      STRATEGY: strategy,
      LEASE_RETRY_MS: String(num(params.leaseRetryMs, 20)),
    };
  }
  return {};
}

/** closed 면 MODEL=closed·VUS 만(RATE·PRE_VUS·MAX_VUS 없음), open 이면 반대. */
export function buildEnv(input: K6EnvInput, opts: EnvOptions): Record<string, string> {
  const { request, runId, phase, summaryPath } = input;
  const { load, data } = request;
  const env: Record<string, string> = {
    BASE_URL: opts.baseUrl,
    PHASE: phase,
    RUN_ID: runId,
    MODEL: load.model,
  };
  if (load.model === 'closed') {
    env.VUS = String(load.vus);
  } else {
    env.RATE = String(load.rate);
    env.PRE_VUS = String(load.preAllocatedVUs);
    env.MAX_VUS = String(load.maxVUs);
  }
  env.DURATION = phase === 'warmup' ? load.warmup : load.duration;
  env.THINK_MIN_MS = String(load.thinkTimeMs[0]);
  env.THINK_MAX_MS = String(load.thinkTimeMs[1]);
  env.DIST = data.distribution.kind;
  if (data.distribution.kind === 'zipf') env.ZIPF_S = String(data.distribution.s);
  env.SEED = String(data.seed);
  env.REP_ACTORS = String(opts.repActors ?? 8);
  env.REQUEST_TIMEOUT = load.requestTimeout;
  env.SUMMARY_PATH = summaryPath;
  return { ...env, ...scenarioEnv(input) };
}

/**
 * 스크립트 해시: 스크립트 내용 + env(SUMMARY_PATH·PHASE 제외, run.mjs k6ScriptHash 규칙).
 * RUN_ID 도 실행마다 달라 같은 설정이 같은 해시가 되도록 뺀다. 호출자는 본 실행(main) env 를 넘긴다.
 */
export function hashScript(scriptText: string, env: Record<string, string>): string {
  const { SUMMARY_PATH: _s, PHASE: _p, RUN_ID: _r, ...rest } = env;
  return createHash('sha256')
    .update(scriptText + '\n' + JSON.stringify(rest))
    .digest('hex');
}
