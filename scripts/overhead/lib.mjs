// 오버헤드 측정(DESIGN §9.1) 순수 함수: 실행 요청, 반복 모음, 셀 집계, 표(markdown) 렌더.
// 오케스트레이터·Docker 를 부르지 않는다(run.mjs 가 부른다). 테스트: lib.test.mjs.

export const LEVELS = ['off', 'metrics', 'full'];
export const CONTENTIONS = ['low', 'high'];

/** 기준별 데이터: 저경합 = 상품 다수·균등, 고경합 = 상품 1개. 재고는 실행 중 소진되지 않게 크게 둔다. */
export const CONTENTION_DATA = Object.freeze({
  low: { label: '저경합(상품 1000개, 균등)', seedOptions: { products: 1000, warmupProducts: 100, stockPerProduct: 100000 } },
  high: { label: '고경합(상품 1개)', seedOptions: { products: 1, warmupProducts: 1, stockPerProduct: 1000000 } },
});

/** open 고정 도착률 부하. maxVUs ≥ rate × 요청 타임아웃(§7.2)이라 dropped 가 생기면 실패로 집계된다. */
export function openLoad(rate, { duration, warmup, requestTimeoutSec = 2 }) {
  return {
    model: 'open',
    profile: 'constant',
    vus: null,
    rate,
    preAllocatedVUs: Math.max(20, Math.ceil(rate / 10)),
    maxVUs: Math.ceil(rate * requestTimeoutSec),
    duration,
    warmup,
    thinkTimeMs: [0, 0],
    requestTimeout: `${requestTimeoutSec}s`,
  };
}

/** G02 row-lock 한 번(reps 1). 반복은 수준·기준을 번갈아 돌려 시간에 따른 드리프트가 한 수준에 몰리지 않게 한다. */
export function overheadRequest({ level, contention, rate, duration, warmup, label, prediction }) {
  return {
    scenario: 'g02-stock-decrement',
    strategies: ['row-lock'],
    strategyParams: {},
    appInstances: [2],
    includeMemoryLockSingle: false,
    reps: 1,
    load: openLoad(rate, { duration, warmup }),
    data: { seed: 42, seedOptions: { ...CONTENTION_DATA[contention].seedOptions }, distribution: { kind: 'uniform' } },
    scenarioParams: { qty: 1 },
    instrumentation: level,
    injectDelay: [],
    prediction,
    label,
  };
}

/** steps 에서 본 실행 구간(k6 본 실행 → 불변식 검사). 없으면 null. */
export function mainWindow(steps) {
  const at = (name) => steps?.find((s) => s.name === name)?.at;
  const from = at('k6 본 실행');
  const to = at('불변식 검사');
  if (!from || !to) return null;
  return { fromMs: Date.parse(from), toMs: Date.parse(to) };
}

/**
 * 반복 하나의 사실. 무효 사유는 오케스트레이터 판정(validity) + 이 측정의 추가 조건(포화·실패·불변식).
 * 포화 기준: dropped > 0, HTTP 실패 > 0, 실제 처리량 < 목표의 97%, app CPU 평균 > limit 의 85%.
 */
export function runFacts({ runId, row, md, appCpu, level, contention, rep, rate }) {
  const k6 = md?.k6 ?? null;
  const reasons = [...(md?.validity?.reasons ?? [])];
  if (!md) reasons.push('메타데이터 없음');
  if (row && row.status !== 'done') reasons.push(`실행 상태 ${row.status}`);
  if (md && md.validity?.valid === false && reasons.length === 0) reasons.push('오케스트레이터 무효 판정');
  if (k6) {
    if (k6.dropped > 0) reasons.push(`dropped ${k6.dropped}건(도착률을 못 따라감)`);
    if (k6.httpFailures > 0) reasons.push(`HTTP 실패 ${k6.httpFailures}건`);
    if (k6.throughputRps < rate * 0.97) reasons.push(`실제 처리량 ${k6.throughputRps} < 목표 ${rate}의 97%`);
  }
  if (row && row.violationsTotal) reasons.push(`불변식 위반 ${row.violationsTotal}`);
  const limitCores = (md?.limits?.app?.cpus ?? 1) * (md?.topology?.appInstances ?? 2);
  if (appCpu?.cores != null && appCpu.cores > limitCores * 0.85) reasons.push(`app CPU ${appCpu.cores.toFixed(2)}코어 > limit 합 ${limitCores}의 85%(포화)`);
  return {
    runId,
    batchId: md?.batchId ?? row?.batchId ?? null,
    sessionId: md?.sessionId ?? row?.sessionId ?? null,
    level,
    contention,
    rep,
    rate,
    valid: reasons.length === 0,
    reasons,
    throughputRps: k6?.throughputRps ?? null,
    p50: k6?.latencyMs?.success?.p50 ?? null,
    p99: k6?.latencyMs?.success?.p99 ?? null,
    n: k6?.latencyMs?.success?.n ?? null,
    dropped: k6?.dropped ?? null,
    httpFailures: k6?.httpFailures ?? null,
    appCpuCores: appCpu?.cores ?? null,
    appCpuPerInstance: appCpu?.perInstance ?? null,
    processCpuCores: appCpu?.processCores ?? null,
    appLimitCores: limitCores,
    k6CpuAvgRatio: md?.validity?.k6CpuAvgRatio ?? null,
    pgProbe: md?.pgProbe ?? null,
    window: appCpu?.window ?? null,
  };
}

/** 중앙값·최솟값·최댓값. 값이 없으면 null. */
export function spread(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { median, min: v[0], max: v[v.length - 1] };
}

/** 셀(기준 × 수준) 집계. 무효 반복은 빼고, 빠진 반복과 사유를 따로 남긴다. */
export function aggregate(runs) {
  const cells = [];
  for (const contention of CONTENTIONS) {
    for (const level of LEVELS) {
      const all = runs.filter((r) => r.contention === contention && r.level === level);
      if (all.length === 0) continue;
      const valid = all.filter((r) => r.valid);
      cells.push({
        contention,
        level,
        rate: all[0].rate,
        runs: all.map((r) => ({ runId: r.runId, rep: r.rep, valid: r.valid })),
        invalid: all.filter((r) => !r.valid).map((r) => ({ runId: r.runId, rep: r.rep, reasons: r.reasons })),
        validCount: valid.length,
        p50: spread(valid.map((r) => r.p50)),
        p99: spread(valid.map((r) => r.p99)),
        n: valid.map((r) => r.n),
        throughputRps: spread(valid.map((r) => r.throughputRps)),
        appCpuCores: spread(valid.map((r) => r.appCpuCores)),
        k6CpuAvgRatio: spread(valid.map((r) => r.k6CpuAvgRatio)),
      });
    }
  }
  return cells;
}

const fmt = (x, digits) => (x == null ? '–' : x.toFixed(digits));
/** "중앙값(최소~최대)" */
export function fmtSpread(s, digits = 1) {
  if (!s) return '–';
  return `${fmt(s.median, digits)} (${fmt(s.min, digits)}~${fmt(s.max, digits)})`;
}

/** run id 링크. docs/overhead.md 기준 레포 상대 경로(runs/ 는 gitignore 라 로컬 전용). */
export const runLink = (runId, text = runId) => `[${text}](../runs/${runId}/)`;

/** 2기준 × 3수준 표(셀 = 중앙값(최소~최대)). */
export function renderTable(cells) {
  const lines = [
    '| 기준 | 수준 | p50 ms | p99 ms | n (반복별) | 처리량 req/s @ 목표 | app CPU 코어(2대 합) | 유효 | run id |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const c of cells) {
    const links = c.runs.map((r) => (r.valid ? runLink(r.runId, `r${r.rep}`) : `~~${runLink(r.runId, `r${r.rep}`)}~~`)).join(' ');
    lines.push(
      `| ${CONTENTION_DATA[c.contention].label} | \`${c.level}\` | ${fmtSpread(c.p50, 2)} | ${fmtSpread(c.p99, 2)} | ${c.n.join(' / ') || '–'} | ${fmtSpread(c.throughputRps, 1)} @ ${c.rate} | ${fmtSpread(c.appCpuCores, 2)} | ${c.validCount}/${c.runs.length} | ${links} |`,
    );
  }
  return lines.join('\n');
}

/** 반복별 개별 값(§7.2: 3회 개별 값을 숨기지 않는다). */
export function renderRuns(runs) {
  const lines = [
    '| 기준 | 수준 | 반복 | p50 ms | p99 ms | n | 처리량 req/s | app CPU 코어 | k6 CPU 비율 | 유효 | run |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  const order = (r) => CONTENTIONS.indexOf(r.contention) * 100 + LEVELS.indexOf(r.level) * 10 + r.rep;
  for (const r of [...runs].sort((a, b) => order(a) - order(b))) {
    lines.push(
      `| ${r.contention === 'low' ? '저경합' : '고경합'} | \`${r.level}\` | ${r.rep} | ${fmt(r.p50, 2)} | ${fmt(r.p99, 2)} | ${r.n ?? '–'} | ${fmt(r.throughputRps, 1)} | ${fmt(r.appCpuCores, 2)} | ${fmt(r.k6CpuAvgRatio, 2)} | ${r.valid ? '예' : '아니오'} | ${runLink(r.runId, `runs/${r.runId}/`)} |`,
    );
  }
  return lines.join('\n');
}

/** 무효 실행과 사유. 없으면 그렇다고 적는다. */
export function renderInvalid(runs) {
  const bad = runs.filter((r) => !r.valid);
  if (bad.length === 0) return '무효 실행 없음.';
  return bad.map((r) => `- ${runLink(r.runId, `runs/${r.runId}/`)} (${r.contention === 'low' ? '저경합' : '고경합'} \`${r.level}\` r${r.rep}): ${r.reasons.join('; ')}`).join('\n');
}

/** 탐색 실행 표. */
export function renderExplore(runs) {
  const lines = [
    '| 목표 req/s | 기준 | 수준 | p50 ms | p99 ms | 처리량 req/s | dropped | app CPU 코어 | 판정 | run |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of runs) {
    lines.push(
      `| ${r.rate} | ${r.contention === 'low' ? '저경합' : '고경합'} | \`${r.level}\` | ${fmt(r.p50, 2)} | ${fmt(r.p99, 2)} | ${fmt(r.throughputRps, 1)} | ${r.dropped ?? '–'} | ${fmt(r.appCpuCores, 2)} | ${r.valid ? '유효' : r.reasons.join('; ')} | ${runLink(r.runId, `runs/${r.runId}/`)} |`,
    );
  }
  return lines.join('\n');
}
