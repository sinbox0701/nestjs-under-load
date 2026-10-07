// 선택기: min..max(정수, 양끝 포함)에서 하나를 고른다.
export function uniformPicker(rng, min, max) {
  const n = max - min + 1;
  return () => min + Math.floor(rng() * n);
}

// 순위 k(1..n) 의 확률이 k^-s 에 비례. CDF 이진 탐색. 순위 1 이 min.
export function zipfPicker(rng, min, max, s = 1.1) {
  const n = max - min + 1;
  const cdf = new Float64Array(n);
  let sum = 0;
  for (let k = 1; k <= n; k++) {
    sum += Math.pow(k, -s);
    cdf[k - 1] = sum;
  }
  return () => {
    const u = rng() * sum;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] >= u) hi = mid;
      else lo = mid + 1;
    }
    return min + lo;
  };
}

// 순위 1 의 이론 확률 (테스트용)
export function zipfTopProbability(n, s) {
  let h = 0;
  for (let k = 1; k <= n; k++) h += Math.pow(k, -s);
  return 1 / h;
}

// env(DIST, ZIPF_S) 로 선택기를 만든다.
export function makePicker(rng, env, min, max) {
  return env.DIST === 'zipf'
    ? zipfPicker(rng, min, max, Number(env.ZIPF_S ?? 1.1))
    : uniformPicker(rng, min, max);
}
