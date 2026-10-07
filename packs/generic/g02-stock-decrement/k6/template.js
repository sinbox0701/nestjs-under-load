// G02 k6 스크립트 (1단계: loadtest/lib 사용. 파라미터 목록은 params.schema.json)
// MODEL=open(기본, constant-arrival-rate) | closed(constant-vus). 0단계 env만 넘겨도 open 으로 동작한다.
// dropped_iterations는 실패로 집계한다(DESIGN §7.2, §8).
// 웜업은 같은 스크립트를 PHASE=warmup + 웜업 전용 상품 범위로 **별도 실행**한다(DESIGN §7.1 3).
// import 경로: 레포 루트 기준 packs/generic/g02-stock-decrement/k6 → ../../../../loadtest/lib.
// 컨테이너에서는 /packs 와 /loadtest 를 같은 부모(/)에 마운트해야 풀린다.
import http from 'k6/http';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { buildOptions, readEnv, createRng, makePicker, buildHeaders, thinkTimeSeconds } from '../../../../loadtest/lib/index.mjs';

const env = (k, d) => (__ENV[k] !== undefined && __ENV[k] !== '' ? __ENV[k] : d);

const E = readEnv(__ENV);
const PRODUCT_MIN = Number(env('PRODUCT_MIN', '1'));
const PRODUCT_MAX = Number(env('PRODUCT_MAX', '5'));
const QTY = Number(env('QTY', '1'));

const ordersSuccess = new Counter('g02_orders_success');
const ordersSoldOut = new Counter('g02_orders_sold_out');
const ordersFailed = new Counter('g02_orders_failed');

export const options = buildOptions(__ENV);

// VU 별 시드 고정 PRNG(init 컨텍스트는 VU 마다 한 번 실행된다).
const rng = createRng(E.SEED, __VU);
const pickProduct = makePicker(rng, E, PRODUCT_MIN, PRODUCT_MAX);

export default function () {
  const productId = pickProduct();
  const res = http.post(`${E.BASE_URL}/g02/orders`, JSON.stringify({ productId, qty: QTY }), {
    headers: buildHeaders(rng, __VU, __ITER, E.REP_ACTORS, crypto.randomUUID()),
    timeout: E.REQUEST_TIMEOUT,
    // 409(품절)은 정상 응답으로 본다. http_req_failed에서 빼기 위함.
    responseCallback: http.expectedStatuses(201, 409),
    tags: { phase: E.PHASE },
  });
  if (res.status === 201) ordersSuccess.add(1);
  else if (res.status === 409) ordersSoldOut.add(1);
  else ordersFailed.add(1);
  const think = thinkTimeSeconds(rng, E.THINK_MIN_MS, E.THINK_MAX_MS);
  if (think > 0) sleep(think);
}

export function handleSummary(data) {
  const out = { stdout: `phase=${E.PHASE} done\n` };
  if (E.SUMMARY_PATH) out[E.SUMMARY_PATH] = JSON.stringify(data, null, 2);
  return out;
}
