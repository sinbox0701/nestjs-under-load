// learn.yaml `measured` 계산(scripts/measured.mjs 이식). 파일은 쓰지 않고 덧씌울 값만 만든다(D13).
// 입력은 메타데이터(v0·v1 둘 다 읽는다). 무효 실행은 집계에서 뺀다. 유효 실행이 없는 batch 는 셀을 만들지 않는다.
type Md = Record<string, any>; // 메타데이터는 v0 확장 필드까지 느슨하게 읽는다
type Situation = Record<string, any>;

export type MeasuredCell = { strategy: string; situation: string; measured: Record<string, unknown> };

const round = (x: number | null, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** 값 목록 → { median, min, max } (숫자 아닌 값 제외). 없으면 null. */
export function spread(values: unknown[], digits = 1) {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length % 2 ? v[(v.length - 1) / 2]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2;
  return { median: round(mid, digits)!, min: round(v[0]!, digits)!, max: round(v[v.length - 1]!, digits)! };
}

/** k6 duration("30s", "1m30s", "500ms") → 초. */
export function durationToSeconds(d: string): number {
  let total = 0;
  for (const [, n, unit] of d.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    total += Number(n) * { ms: 0.001, s: 1, m: 60, h: 3600 }[unit as 'ms' | 's' | 'm' | 'h'];
  }
  return total;
}

/** 모든 strategy 공통 경합 창 지점. situation `injected.contentionWindowMs` 가 이 지점의 지연이다. */
export const CONTENTION_POINT = 'after-read';
const isContentionWindow = (d: Md) => d.type === 'inject-delay' && d.point === CONTENTION_POINT;

const numOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * 실행 하나의 핵심 수치. metadata.k6 모양 둘을 받는다(MetadataStore 의 batch-summary 와 같은 규칙).
 * - v1(ports K6Summary): { requests, throughputRps, httpFailures, dropped, latencyMs: { success: { p95 } } }
 * - 0단계 v0: { httpReqs, failed, droppedIterations, latencyMs: { p95 } }
 * 처리량 = 본 실행 응답 수 / 본 실행 길이(초). v1 은 k6.throughputRps 그대로, v0 는 httpReqs / duration.
 */
export function runFacts(md: Md) {
  const k6 = md.k6 ?? {};
  const durationSec = durationToSeconds(md.load.duration);
  const requests = numOf(k6.requests) ?? numOf(k6.httpReqs);
  const dropped = numOf(k6.dropped) ?? numOf(k6.droppedIterations) ?? 0;
  const attempted = (requests ?? 0) + dropped;
  // dropped 는 maxVUs 가 충분할 때만 실패로 센다(DESIGN §7.2). 부족하면 애초에 무효 실행이다.
  const failed = (numOf(k6.httpFailures) ?? numOf(k6.failed) ?? 0) + (md.validity?.droppedCountedAsFailure ? dropped : 0);
  const lat = k6.latencyMs ?? {};
  const violations: Record<string, number | null> = Object.fromEntries(
    (md.invariants ?? []).filter((i: Md) => i.severity !== 'info').map((i: Md) => [i.id, i.violations]),
  );
  const ledger = (md.invariants ?? []).find((i: Md) => i.id === 'ledger-matches-k6')?.value ?? md.ledgerVsClient?.ledger ?? null;
  return {
    runId: md.runId as string,
    valid: md.validity?.valid !== false,
    violations,
    violationTotal: Object.values(violations).reduce<number>((a, b) => a + (b ?? 0), 0),
    ledgerSuccess: (ledger?.success ?? null) as number | null,
    throughputRps: numOf(k6.throughputRps) ?? (requests != null && durationSec > 0 ? requests / durationSec : null),
    p95Ms: numOf(lat.success?.p95) ?? numOf(lat.p95),
    failRatePct: attempted > 0 ? (failed / attempted) * 100 : null,
    k6CpuAvgRatio: (md.validity?.k6CpuAvgRatio ?? null) as number | null,
  };
}

/** batch(같은 strategy × 앱 대수 반복들) → situation 대응 키. v1(seedOptions·scenarioParams·`zipf(1.1)`)과 v0 를 둘 다 받는다. */
export function batchKey(md: Md) {
  const interventions: Md[] = md.interventions ?? [];
  const dist = String(md.data?.distribution ?? 'uniform');
  const zipf = /^zipf\(([\d.]+)\)$/.exec(dist);
  return {
    strategy: md.strategy.id as string,
    params: (md.strategy.params ?? {}) as Record<string, unknown>,
    appInstances: md.topology.appInstances as number,
    model: md.load.model as string,
    rate: (md.load.rate ?? null) as number | null,
    vus: (md.load.vus ?? null) as number | null,
    products: (md.data?.rows?.products ?? md.data?.seedOptions?.products) as number | undefined,
    stockPerProduct: (md.data?.stockPerProduct ?? md.data?.seedOptions?.stockPerProduct) as number | undefined,
    documents: (md.data?.rows?.documents ?? md.data?.seedOptions?.documents) as number | undefined,
    editMs: md.data?.scenarioParams?.editMs as number | undefined,
    distribution: zipf ? 'zipf' : dist,
    zipfS: zipf ? Number(zipf[1]) : null,
    chaos: interventions.every(isContentionWindow) && (md.chaos ?? []).length === 0 ? 'none' : 'some',
    contentionWindowMs: interventions.filter(isContentionWindow).reduce((a, d) => a + d.ms, 0),
  };
}

const sortedJson = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/** strategy 별 manifest 기본 파라미터. 대응 비교는 기본값을 덧씌운 실효 파라미터로 한다. */
export type StrategyDefaults = Record<string, Record<string, unknown>>;

/**
 * learn.yaml situations 중 batch 조건과 맞는 것. 0개나 2개 이상이면 null(쓰지 않음). 값이 없는 키는 null 로 보고 null 끼리만 같다.
 * strategy 파라미터: situation.params[strategy] 가 있으면 그 값이, 없으면(params 없음 또는 다른 strategy 용) manifest 기본값이 기준이다.
 * scripts/measured.mjs 와 같은 규칙이다(둘을 같이 고친다).
 */
export function matchSituation(situations: Situation[], key: ReturnType<typeof batchKey>, defaults: StrategyDefaults = {}): Situation | null {
  const hits = situations.filter((s) => {
    const kind = s.data?.distribution?.kind ?? 'uniform';
    const sameLoad =
      s.load?.model === key.model && (key.model === 'open' ? s.load?.rate === key.rate : (s.load?.vus ?? null) === key.vus);
    const base = defaults[key.strategy] ?? {};
    const wantParams = { ...base, ...(s.params?.[key.strategy] ?? {}) };
    return (
      s.instances === key.appInstances &&
      sameLoad &&
      (s.data?.products ?? null) === (key.products ?? null) &&
      (s.data?.stockPerProduct ?? null) === (key.stockPerProduct ?? null) &&
      (s.data?.documents ?? null) === (key.documents ?? null) &&
      (s.scenarioParams?.editMs ?? null) === (key.editMs ?? null) &&
      kind === key.distribution &&
      (kind !== 'zipf' || s.data.distribution.s === key.zipfS) &&
      (s.chaos ?? 'none') === 'none' &&
      key.chaos === 'none' &&
      (s.injected?.contentionWindowMs ?? 0) === key.contentionWindowMs &&
      sortedJson({ ...base, ...key.params }) === sortedJson(wantParams)
    );
  });
  return hits.length === 1 ? hits[0]! : null;
}

function conditionsText(md: Md, situation: Situation, reps: number, defaults: StrategyDefaults): string {
  const h = md.host ?? {};
  const memGiB = h.dockerMemBytes ? (h.dockerMemBytes / 2 ** 30).toFixed(1) : '?';
  const key = batchKey(md);
  const base = defaults[key.strategy] ?? {};
  const nonDefault = Object.fromEntries(Object.entries(key.params).filter(([k, v]) => sortedJson(v) !== sortedJson(base[k])));
  const shapeNote = situation.load?.shape && situation.load.shape !== 'constant' ? `(상황 정의 shape=${situation.load.shape}, 실행은 constant)` : '';
  const loadText =
    md.load.model === 'open'
      ? `open constant-arrival-rate ${md.load.rate}/s × ${md.load.duration}${shapeNote} · 웜업 ${md.load.warmup} · ${reps}회 반복 · k6 timeout ${md.timeouts?.k6RequestMs}ms · maxVUs ${md.load.maxVUs}`
      : `closed constant-vus ${md.load.vus} × ${md.load.duration}${shapeNote} · 웜업 ${md.load.warmup} · ${reps}회 반복 · k6 timeout ${md.timeouts?.k6RequestMs}ms`;
  return [
    `로컬 맥(${h.cpu ?? '?'}, Docker ${h.dockerNcpu ?? '?'} vCPU / ${memGiB} GiB, profile ${md.profile}, cpuset ${md.limits?.app?.cpuset ?? 'none'})`,
    `app ${md.topology.appInstances}대(각 cpus ${md.limits?.app?.cpus ?? '?'}) · postgres cpus ${md.limits?.postgres?.cpus ?? '?'} · nginx round-robin`,
    loadText,
    key.documents != null
      ? `문서 ${key.documents}개, ${key.distribution === 'zipf' ? `zipf(${key.zipfS}) 분포` : '균등 분포'}, 편집 ${key.editMs ?? '?'}ms`
      : `상품 ${key.products}개 × 재고 ${key.stockPerProduct}, ${key.distribution === 'zipf' ? `zipf(${key.zipfS}) 분포` : '균등 분포'}, 요청당 ${md.data?.qtyPerOrder ?? md.data?.scenarioParams?.qty ?? '?'}개`,
    ...(key.contentionWindowMs > 0 ? [`경합 창 지연 ${key.contentionWindowMs}ms 주입됨(${CONTENTION_POINT}: 모든 strategy의 읽기 후 쓰기 전 같은 지점, 트랜잭션 안)`] : []),
    ...(Object.keys(nonDefault).length > 0 ? [`기본값과 다른 strategy 파라미터 ${JSON.stringify(nonDefault)}`] : []),
    '절대 수치가 아니라 같은 조건의 strategy 간 상대 비교용',
  ].join(' · ');
}

/** batch 의 실행 메타데이터 목록 → learn.yaml measured 객체. 유효 실행이 없으면 null. */
export function buildMeasured(mds: Md[], situation: Situation, defaults: StrategyDefaults = {}): Record<string, unknown> | null {
  const facts = mds.map(runFacts);
  const valid = facts.filter((f) => f.valid);
  if (valid.length === 0) return null;
  const md = mds[0]!;
  const key = batchKey(md);
  const thr = spread(valid.map((f) => f.throughputRps));
  const p95 = spread(valid.map((f) => f.p95Ms), 2);
  const fail = spread(valid.map((f) => f.failRatePct), 2);
  const withViolation = valid.filter((f) => f.violationTotal > 0).length;
  const invIds = Object.keys(valid[0]!.violations);
  const violatedIds = invIds.filter((id) => valid.some((f) => (f.violations[id] ?? 0) > 0));
  const totalStock = key.products != null && key.stockPerProduct != null ? key.products * key.stockPerProduct : null;
  const fmtRange = (s: ReturnType<typeof spread>, unit: string) => (s ? `${s.median}${unit}(${s.min}~${s.max})` : '?');
  const violationText =
    withViolation === 0
      ? `위반 0 (${valid.length}/${valid.length}회)`
      : `위반 ${withViolation}/${valid.length}회 발생(${violatedIds.map((id) => `${id} ${key.documents != null ? '' : '상품 '}${valid.map((f) => f.violations[id] ?? 0).join('·')}${key.documents != null ? '건' : '개'}`).join(', ')})`;
  const ledgerText = `원장 성공 ${valid.map((f) => f.ledgerSuccess ?? '?').join('·')}건${totalStock != null ? ` / 총재고 ${totalStock}` : ''}`;
  const excluded = facts.length - valid.length;
  return {
    run: md.batchId,
    runs: valid.map((f) => f.runId),
    ...(key.contentionWindowMs > 0 ? { injected: { contentionWindowMs: key.contentionWindowMs } } : {}),
    summary: [
      ...(key.contentionWindowMs > 0 ? [`경합 창 ${key.contentionWindowMs}ms 주입됨`] : []),
      violationText,
      ledgerText,
      `처리량 ${fmtRange(thr, ' req/s')}`,
      `p95 ${fmtRange(p95, 'ms')}`,
      `실패율 ${fmtRange(fail, '%')}`,
      ...(excluded ? [`무효 ${excluded}회 제외`] : []),
      '로컬 맥 상대 비교',
    ].join(' · '),
    violations: Object.fromEntries(invIds.map((id) => [id, valid.map((f) => f.violations[id])])),
    ledgerSuccess: valid.map((f) => f.ledgerSuccess),
    throughputRps: thr,
    p95Ms: p95,
    failRatePct: fail,
    k6CpuAvgRatio: spread(valid.map((f) => f.k6CpuAvgRatio), 3),
    conditions: conditionsText(md, situation, facts.length, defaults),
  };
}

/**
 * batch 들 → 셀 목록. `batchesNewestFirst` 는 최신 batch 가 앞이다.
 * 같은 (strategy, situation) 에 batch 가 여럿 대응하면 **유효 반복 수가 가장 많은 batch**, 동률이면 최신을 쓴다
 * (1회짜리 임시 batch 가 3회 batch 를 덮지 않게 한다).
 */
export function computeMeasuredCells(situations: Situation[], batchesNewestFirst: Md[][], defaults: StrategyDefaults = {}): MeasuredCell[] {
  const cells = new Map<string, MeasuredCell & { validReps: number }>();
  for (const mds of batchesNewestFirst) {
    if (mds.length === 0) continue;
    const key = batchKey(mds[0]!);
    const situation = matchSituation(situations, key, defaults);
    if (!situation) continue;
    const measured = buildMeasured(mds, situation, defaults);
    if (!measured) continue;
    const validReps = (measured.runs as string[]).length;
    const id = `${key.strategy}\u0000${situation.id}`;
    const prev = cells.get(id);
    // 엄격히 더 많을 때만 바꾼다: 동률이면 먼저 본(더 최신) 것이 남는다.
    if (!prev || validReps > prev.validReps) cells.set(id, { strategy: key.strategy, situation: situation.id, measured, validReps });
  }
  return [...cells.values()].map(({ validReps: _v, ...cell }) => cell);
}
