/**
 * 화면 2(실행 설정) 폼 상태 ↔ RunRequest(C2) 변환. 화면과 무관한 순수 함수만 둔다.
 */
import type {
  Distribution,
  InjectDelay,
  InstrumentationLevel,
  LoadModel,
  RunRequest,
  ScenarioInfo,
} from '../../api';

/** 경합 창을 늘릴 수 있는 지점(G02 strategy 의 contentionWindow). 폼 하드코딩 허용. */
export const INJECT_POINTS = [
  { id: 'after-read', label: '읽은 직후 (after-read)' },
  { id: 'after-lock', label: '잠금 잡은 직후 (after-lock)' },
] as const;

/** 계측 수준별 PG 프로브 기본(contracts INSTRUMENTATION_LEVELS 의 pgProbeIntervalMs 와 같은 값). */
export const PROBE_DEFAULT: Record<InstrumentationLevel, { enabled: boolean; intervalMs: number }> =
  {
    off: { enabled: false, intervalMs: 5000 },
    metrics: { enabled: true, intervalMs: 5000 },
    full: { enabled: true, intervalMs: 1000 },
  };

export interface FormState {
  scenario: string;
  strategies: string[];
  strategyParams: Record<string, Record<string, unknown>>;
  /** 쉼표로 구분한 앱 대수 목록 (예: "1,2") */
  appInstances: string;
  includeMemoryLockSingle: boolean;
  reps: string;
  model: LoadModel;
  rate: string;
  preAllocatedVUs: string;
  maxVUs: string;
  vus: string;
  thinkMin: string;
  thinkMax: string;
  duration: string;
  warmup: string;
  seed: string;
  products: string;
  warmupProducts: string;
  stockPerProduct: string;
  distKind: Distribution['kind'];
  zipfS: string;
  instrumentation: InstrumentationLevel;
  probeEnabled: boolean;
  probeIntervalMs: string;
  injectDelay: { point: string; ms: string }[];
  prediction: string;
  label: string;
}

const num = (v: unknown, d: number): string => (typeof v === 'number' ? String(v) : String(d));
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);

/** 시나리오가 알려 준 기본값으로 채운 초기 폼. */
export function initialForm(sc: ScenarioInfo | undefined): FormState {
  const d = sc?.load.defaults ?? {};
  const s = sc?.seedDefaults ?? {};
  const first = sc?.strategies[0];
  const form: FormState = {
    scenario: sc?.id ?? '',
    strategies: first ? [first.id] : [],
    strategyParams: {},
    appInstances: String(Math.max(2, sc?.minAppInstances ?? 2)),
    includeMemoryLockSingle: true,
    reps: '3',
    model: sc && !sc.load.models.includes('closed') ? 'open' : 'closed',
    rate: num(d.rate, 100),
    preAllocatedVUs: num(d.preAllocatedVUs, 50),
    maxVUs: num(d.maxVUs, 200),
    vus: '50',
    thinkMin: '0',
    thinkMax: '0',
    duration: str(d.duration, '30s'),
    warmup: '10s',
    seed: '42',
    products: num(s.products, 5),
    warmupProducts: num(s.warmupProducts, 5),
    stockPerProduct: num(s.stockPerProduct, 100),
    distKind: 'uniform',
    zipfS: '1.1',
    instrumentation: 'metrics',
    probeEnabled: PROBE_DEFAULT.metrics.enabled,
    probeIntervalMs: String(PROBE_DEFAULT.metrics.intervalMs),
    injectDelay: [],
    prediction: '',
    label: '',
  };
  return form;
}

/** 선택된 strategy 들의 파라미터 기본값(스키마 `default`)을 모은다. */
export function paramDefaults(
  sc: ScenarioInfo | undefined,
  strategies: string[],
  prev: FormState['strategyParams'],
): FormState['strategyParams'] {
  const out: FormState['strategyParams'] = {};
  for (const id of strategies) {
    const spec = sc?.strategies.find((s) => s.id === id)?.params ?? {};
    const bag: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(spec)) {
      const def = (v as { default?: unknown } | null)?.default;
      if (def !== undefined) bag[k] = prev[id]?.[k] ?? def;
    }
    if (Object.keys(bag).length > 0) out[id] = bag;
  }
  return out;
}

/**
 * URL 쿼리(`?scenario&situation`)로 초기값을 채운다(코드 실험실 "이 상황으로 실행").
 * situation 은 ScenarioInfo.situations 의 id 로 찾고, 못 찾으면 시나리오만 적용한다.
 */
export function formFromQuery(
  scenarios: ScenarioInfo[],
  search: string,
): { form: FormState; situationLabel: string | null; situationMissing: string | null } {
  const q = new URLSearchParams(search);
  const sc = scenarios.find((s) => s.id === q.get('scenario')) ?? scenarios[0];
  let form = initialForm(sc);
  const sid = q.get('situation');
  if (!sid) return { form, situationLabel: null, situationMissing: null };
  const sit = sc?.situations?.find((s) => s.id === sid);
  if (!sit) return { form, situationLabel: null, situationMissing: sid };
  const load = (sit.load ?? {}) as Record<string, unknown>;
  const data = (sit.data ?? {}) as Record<string, unknown>;
  if (load.model === 'open' || load.model === 'closed') form = { ...form, model: load.model };
  if (typeof load.vus === 'number') form = { ...form, vus: String(load.vus) };
  if (typeof load.rate === 'number') form = { ...form, rate: String(load.rate) };
  if (typeof load.duration === 'string') form = { ...form, duration: load.duration };
  if (typeof sit.instances === 'number') form = { ...form, appInstances: String(sit.instances) };
  if (typeof data.products === 'number') form = { ...form, products: String(data.products) };
  if (typeof data.stockPerProduct === 'number')
    form = { ...form, stockPerProduct: String(data.stockPerProduct) };
  const dist = data.distribution as { kind?: string; s?: number } | undefined;
  if (dist?.kind === 'zipf') form = { ...form, distKind: 'zipf', zipfS: String(dist.s ?? 1.1) };
  return {
    form,
    situationLabel: typeof sit.label === 'string' ? sit.label : sid,
    situationMissing: null,
  };
}

const DURATION = /^\d+(ms|s|m|h)$/;
const int = (v: string): number | null => (/^-?\d+$/.test(v.trim()) ? Number(v.trim()) : null);

export function parseInstances(v: string): number[] | null {
  const parts = v.split(',').map((x) => x.trim());
  const nums = parts.map(int);
  if (nums.some((n) => n === null || n < 1) || new Set(nums).size !== nums.length) return null;
  return nums as number[];
}

/** 입력 오류(필드 이름 → 한국어 메시지). 비어 있으면 요청을 만들 수 있다. */
export function validate(f: FormState): Record<string, string> {
  const e: Record<string, string> = {};
  if (f.prediction.trim() === '') e.prediction = '실행 전에 예측을 한 줄 적어야 한다';
  if (f.strategies.length === 0) e.strategies = 'strategy 를 하나 이상 고른다';
  if (!parseInstances(f.appInstances)) e.appInstances = '1 이상의 정수를 쉼표로 (예: 1,2)';
  const reps = int(f.reps);
  if (reps === null || reps < 1 || reps > 20) e.reps = '1~20';
  if (!DURATION.test(f.duration)) e.duration = '예: 30s, 2m';
  if (!DURATION.test(f.warmup)) e.warmup = '예: 10s';
  const pos = (k: keyof FormState) => {
    const n = int(String(f[k]));
    if (n === null || n < 1) e[k] = '1 이상의 정수';
  };
  if (f.model === 'closed') {
    pos('vus');
    const a = int(f.thinkMin);
    const b = int(f.thinkMax);
    if (a === null || b === null || a < 0 || a > b) e.think = '0 이상, 최소 ≤ 최대';
  } else {
    pos('rate');
    pos('preAllocatedVUs');
    pos('maxVUs');
    const p = int(f.preAllocatedVUs);
    const m = int(f.maxVUs);
    if (p !== null && m !== null && p > m) e.maxVUs = '최대 VU 가 미리 띄울 VU 보다 작다';
  }
  pos('products');
  pos('stockPerProduct');
  const wp = int(f.warmupProducts);
  if (wp === null || wp < 0) e.warmupProducts = '0 이상의 정수';
  if (f.distKind === 'zipf' && !(Number(f.zipfS) > 0)) e.zipfS = '0 보다 큰 수';
  if (f.probeEnabled) {
    const n = int(f.probeIntervalMs);
    if (n === null || n < 1) e.probeIntervalMs = '1 이상의 정수(ms)';
  }
  f.injectDelay.forEach((d, i) => {
    const n = int(d.ms);
    if (n === null || n < 0) e[`inject${i}`] = '0 이상의 정수(ms)';
  });
  return e;
}

/** 폼 → RunRequest. validate 가 비어 있을 때만 부른다. */
export function buildRequest(f: FormState): RunRequest {
  const closed = f.model === 'closed';
  const injectDelay: InjectDelay[] = f.injectDelay.map((d) => ({
    point: d.point,
    ms: Number(d.ms),
  }));
  return {
    scenario: f.scenario,
    strategies: f.strategies,
    strategyParams: f.strategyParams,
    appInstances: parseInstances(f.appInstances) ?? [],
    includeMemoryLockSingle: f.includeMemoryLockSingle,
    reps: Number(f.reps),
    load: {
      model: f.model,
      profile: 'constant',
      vus: closed ? Number(f.vus) : null,
      rate: closed ? null : Number(f.rate),
      preAllocatedVUs: closed ? null : Number(f.preAllocatedVUs),
      maxVUs: closed ? null : Number(f.maxVUs),
      duration: f.duration,
      warmup: f.warmup,
      // open 모델은 도착률이 간격을 정하므로 생각 시간이 없다.
      thinkTimeMs: closed ? [Number(f.thinkMin), Number(f.thinkMax)] : [0, 0],
      requestTimeout: '10s',
    },
    data: {
      seed: Number(f.seed) || 0,
      seedOptions: {
        products: Number(f.products),
        warmupProducts: Number(f.warmupProducts),
        stockPerProduct: Number(f.stockPerProduct),
      },
      distribution:
        f.distKind === 'zipf' ? { kind: 'zipf', s: Number(f.zipfS) } : { kind: 'uniform' },
    },
    scenarioParams: { qty: 1 },
    instrumentation: f.instrumentation,
    pgProbe: f.probeEnabled
      ? { enabled: true, intervalMs: Number(f.probeIntervalMs) }
      : { enabled: false, intervalMs: null },
    injectDelay,
    prediction: f.prediction.trim(),
    label: f.label.trim() === '' ? null : f.label.trim(),
  };
}

/** 실행될 케이스 수 = strategies × appInstances (+ 메모리 락 1대 대조). */
export function caseCount(f: FormState): number {
  const apps = parseInstances(f.appInstances)?.length ?? 0;
  return f.strategies.length * apps;
}

/** 주입 지연이 실제로 걸리는가(ms>0 인 항목이 있다). */
export function hasInjection(f: FormState): boolean {
  return f.injectDelay.some((d) => Number(d.ms) > 0);
}
