// 시드 고정 PRNG. 같은 (seed, vu) 면 항상 같은 수열. k6 전역 의존 없음.
export function hashSeed(seed, vu) {
  // FNV-1a 로 (seed, vu) 를 32비트 정수 하나로 섞는다.
  let h = 0x811c9dc5;
  for (const n of [Number(seed) | 0, Number(vu) | 0]) {
    for (let i = 0; i < 4; i++) {
      h ^= (n >>> (i * 8)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

// mulberry32: [0,1) 균등 난수를 돌려주는 함수를 만든다.
export function createRng(seed, vu = 0) {
  let a = hashSeed(seed, vu);
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
