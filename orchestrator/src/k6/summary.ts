// k6 handleSummary JSON → K6Summary. 구버전(`values` 중첩)과 신버전(평탄) 모양을 모두 읽는다.
import type { K6Summary } from '../ports.js';

type Metric = Record<string, unknown> & { values?: Record<string, unknown> };

const field = (m: Metric | undefined, key: string): number | null => {
  const v = m?.values?.[key] ?? m?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/**
 * 서브메트릭 찾기. k6 는 threshold 에 쓴 키 그대로 summary 에 내므로 태그가 더 붙을 수 있다
 * (loadtest/lib/options.mjs 는 `http_req_duration{phase:main,expected_response:false}`). 정확한 키가 없으면 태그 집합에 tag 가 든 키.
 */
function submetric(m: Record<string, Metric>, base: string, tag: string): Metric | undefined {
  const exact = m[`${base}{${tag}}`];
  if (exact) return exact;
  const key = Object.keys(m).find((k) => k.startsWith(`${base}{`) && k.endsWith('}') && k.slice(base.length + 1, -1).split(',').includes(tag));
  return key === undefined ? undefined : m[key];
}

function trend(m: Metric | undefined, fallbackN: number): K6Summary['latencyMs']['success'] {
  return {
    p50: field(m, 'med') ?? field(m, 'p(50)'),
    p95: field(m, 'p(95)'),
    p99: field(m, 'p(99)'),
    // 신버전 trend 에는 count 가 없어, 없으면 요청 수에서 뺀 값으로 대신한다
    n: field(m, 'count') ?? fallbackN,
  };
}

/**
 * mainDurationSec: 요청한 본 실행 길이(초). throughputRps = http_reqs.count / 이 값(0단계 measured.mjs 정의).
 * k6 의 http_reqs.rate 는 gracefulStop 포함 전체 구간 기준이라 포화 시 낮게 나오므로 쓰지 않는다.
 */
export function parseSummary(summary: unknown, mainDurationSec: number): K6Summary {
  if (!(mainDurationSec > 0)) throw new Error(`본 실행 길이(초)가 필요하다: ${mainDurationSec}`);
  const m = ((summary as { metrics?: Record<string, Metric> } | null)?.metrics ?? {}) as Record<string, Metric>;
  const requests = field(m.http_reqs, 'count') ?? 0;
  const failedTrend = submetric(m, 'http_req_duration', 'expected_response:false');
  // http_req_failed 는 Rate: passes = 실패(true) 횟수
  const httpFailures = field(m.http_req_failed, 'passes') ?? field(failedTrend, 'count') ?? Math.round((field(m.http_req_failed, 'rate') ?? 0) * requests);
  return {
    requests,
    throughputRps: requests / mainDurationSec,
    httpFailures,
    dropped: field(m.dropped_iterations, 'count') ?? 0,
    latencyMs: {
      success: trend(submetric(m, 'http_req_duration', 'expected_response:true'), Math.max(requests - httpFailures, 0)),
      failed: trend(failedTrend, httpFailures),
    },
  };
}
