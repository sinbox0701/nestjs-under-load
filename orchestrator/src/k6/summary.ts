// k6 handleSummary JSON → K6Summary. 구버전(`values` 중첩)과 신버전(평탄) 모양을 모두 읽는다.
import type { K6Summary } from '../ports.js';

type Metric = Record<string, unknown> & { values?: Record<string, unknown> };

const field = (m: Metric | undefined, key: string): number | null => {
  const v = m?.values?.[key] ?? m?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

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
  const failedTrend = m['http_req_duration{expected_response:false}'];
  // http_req_failed 는 Rate: passes = 실패(true) 횟수
  const httpFailures = field(m.http_req_failed, 'passes') ?? field(failedTrend, 'count') ?? Math.round((field(m.http_req_failed, 'rate') ?? 0) * requests);
  return {
    requests,
    throughputRps: requests / mainDurationSec,
    httpFailures,
    dropped: field(m.dropped_iterations, 'count') ?? 0,
    latencyMs: {
      success: trend(m['http_req_duration{expected_response:true}'], Math.max(requests - httpFailures, 0)),
      failed: trend(failedTrend, httpFailures),
    },
  };
}
