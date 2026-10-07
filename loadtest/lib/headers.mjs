// 요청 헤더 헬퍼 (C4 대표 표본: VU <= REP_ACTORS 면 traceparent 플래그 01).
const HEX = '0123456789abcdef';

function hex(rng, len) {
  let out = '';
  for (let i = 0; i < len; i++) out += HEX[Math.floor(rng() * 16)];
  // W3C: 전부 0 인 id 는 무효
  return /^0+$/.test(out) ? '1'.padEnd(len, '0') : out;
}

export function isRepresentative(vu, repActors = 8) {
  return vu <= repActors;
}

export function traceparent(rng, vu, repActors = 8) {
  return `00-${hex(rng, 32)}-${hex(rng, 16)}-${isRepresentative(vu, repActors) ? '01' : '00'}`;
}

export function actor(vu, iter) {
  return `${vu}-${iter}`;
}

// 요청마다 붙일 헤더 묶음. requestId 는 호출자가 넘기거나 PRNG 로 만든다.
export function buildHeaders(rng, vu, iter, repActors = 8, requestId) {
  const h = (n) => hex(rng, n);
  return {
    'Content-Type': 'application/json',
    'X-Request-Id': requestId ?? `${h(8)}-${h(4)}-${h(4)}-${h(4)}-${h(12)}`,
    'X-Lab-Actor': actor(vu, iter),
    traceparent: traceparent(rng, vu, repActors),
  };
}
