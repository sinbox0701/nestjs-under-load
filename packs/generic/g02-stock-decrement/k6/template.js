// G02 k6 스크립트 (0단계: 렌더링 없이 __ENV로 파라미터를 받는다. 파라미터 목록은 params.schema.json)
// open model: constant-arrival-rate. dropped_iterations는 실패로 집계한다(DESIGN §7.2, §8).
// 웜업은 같은 스크립트를 PHASE=warmup + 웜업 전용 상품 범위로 **별도 실행**한다(DESIGN §7.1 3).
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const env = (k, d) => (__ENV[k] !== undefined && __ENV[k] !== '' ? __ENV[k] : d);

const BASE_URL = env('BASE_URL', 'http://nginx');
const PHASE = env('PHASE', 'main');
const RATE = Number(env('RATE', '100'));
const DURATION = env('DURATION', '30s');
const PRE_VUS = Number(env('PRE_VUS', '50'));
const MAX_VUS = Number(env('MAX_VUS', '200'));
const PRODUCT_MIN = Number(env('PRODUCT_MIN', '1'));
const PRODUCT_MAX = Number(env('PRODUCT_MAX', '5'));
const QTY = Number(env('QTY', '1'));
const TIMEOUT = env('REQUEST_TIMEOUT', '10s');
const SUMMARY_PATH = env('SUMMARY_PATH', '');

const ordersSuccess = new Counter('g02_orders_success');
const ordersSoldOut = new Counter('g02_orders_sold_out');
const ordersFailed = new Counter('g02_orders_failed');

export const options = {
  discardResponseBodies: false,
  scenarios: {
    [PHASE]: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
      tags: { phase: PHASE },
    },
  },
  // 서브메트릭을 강제로 만들어 phase별 값을 분리한다(웜업은 별도 실행이지만 표기를 통일).
  thresholds: {
    [`http_req_duration{phase:${PHASE}}`]: [],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

export default function () {
  // 0단계는 균등 분포. Zipf는 1단계 loadtest/lib.
  const productId = PRODUCT_MIN + Math.floor(Math.random() * (PRODUCT_MAX - PRODUCT_MIN + 1));
  const res = http.post(`${BASE_URL}/g02/orders`, JSON.stringify({ productId, qty: QTY }), {
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': crypto.randomUUID(),
      'X-Lab-Actor': `${__VU}-${__ITER}`,
    },
    timeout: TIMEOUT,
    // 409(품절)은 정상 응답으로 본다. http_req_failed에서 빼기 위함.
    responseCallback: http.expectedStatuses(201, 409),
    tags: { phase: PHASE },
  });
  if (res.status === 201) ordersSuccess.add(1);
  else if (res.status === 409) ordersSoldOut.add(1);
  else ordersFailed.add(1);
}

export function handleSummary(data) {
  const out = { stdout: `phase=${PHASE} done\n` };
  if (SUMMARY_PATH) out[SUMMARY_PATH] = JSON.stringify(data, null, 2);
  return out;
}
