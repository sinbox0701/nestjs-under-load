// env(C7) → k6 options. open: constant-arrival-rate / closed: constant-vus.
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const str = (v, d) => (v === undefined || v === '' ? d : String(v));

export function readEnv(env = {}) {
  return {
    BASE_URL: str(env.BASE_URL, 'http://nginx'),
    PHASE: str(env.PHASE, 'main'),
    RUN_ID: str(env.RUN_ID, ''),
    MODEL: str(env.MODEL, 'open'),
    RATE: num(env.RATE, 100),
    VUS: num(env.VUS, 50),
    DURATION: str(env.DURATION, '30s'),
    PRE_VUS: num(env.PRE_VUS, 50),
    MAX_VUS: num(env.MAX_VUS, 200),
    THINK_MIN_MS: num(env.THINK_MIN_MS, 0),
    THINK_MAX_MS: num(env.THINK_MAX_MS, 0),
    DIST: str(env.DIST, 'uniform'),
    ZIPF_S: num(env.ZIPF_S, 1.1),
    SEED: num(env.SEED, 42),
    REP_ACTORS: num(env.REP_ACTORS, 8),
    REQUEST_TIMEOUT: str(env.REQUEST_TIMEOUT, '10s'),
    SUMMARY_PATH: str(env.SUMMARY_PATH, ''),
  };
}

export function buildOptions(rawEnv = {}) {
  const e = readEnv(rawEnv);
  if (e.MODEL !== 'open' && e.MODEL !== 'closed') {
    throw new Error(`MODEL must be open|closed, got "${e.MODEL}"`);
  }
  const scenario =
    e.MODEL === 'open'
      ? {
          executor: 'constant-arrival-rate',
          rate: e.RATE,
          timeUnit: '1s',
          duration: e.DURATION,
          preAllocatedVUs: e.PRE_VUS,
          maxVUs: e.MAX_VUS,
          tags: { phase: e.PHASE },
        }
      : {
          executor: 'constant-vus',
          vus: e.VUS,
          duration: e.DURATION,
          tags: { phase: e.PHASE },
        };
  return {
    discardResponseBodies: false,
    scenarios: { [e.PHASE]: scenario },
    // 빈 threshold 로 phase 별 서브메트릭을 강제로 만든다.
    thresholds: { [`http_req_duration{phase:${e.PHASE}}`]: [] },
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  };
}
