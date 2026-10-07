// think time(초). min..max ms 균등. 둘 다 0 이면 0. k6 의 sleep() 에 그대로 넘긴다.
export function thinkTimeSeconds(rng, minMs = 0, maxMs = 0) {
  if (!(maxMs > minMs)) return Math.max(0, minMs) / 1000;
  return (minMs + rng() * (maxMs - minMs)) / 1000;
}
