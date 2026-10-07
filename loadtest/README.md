# loadtest/lib

k6 시나리오 스크립트가 import 하는 공용 헬퍼입니다. 순수 함수 위주의 ES 모듈이라 k6 없이 Node 에서 테스트합니다.

```js
import { buildOptions, createRng, makePicker, buildHeaders, thinkTimeSeconds } from '../../../loadtest/lib/index.mjs';
export const options = buildOptions(__ENV);
const rng = createRng(SEED, __VU);   // k6 전역(__VU, __ENV, sleep)은 스크립트 쪽 접착층에서만 쓴다
```

| 모듈 | 내용 |
|---|---|
| `rng.mjs` | 시드 고정 PRNG. `createRng(SEED, VU)` 는 같은 입력이면 같은 수열 |
| `pick.mjs` | 균등·Zipf 선택기(`DIST`, `ZIPF_S`), 순위 1 이 범위의 최솟값 |
| `headers.mjs` | `X-Lab-Actor`(`<VU>-<ITER>`), `X-Request-Id`, `traceparent`. `VU <= REP_ACTORS`(기본 8)이면 플래그 `01`, 아니면 `00` |
| `think.mjs` | `THINK_MIN_MS..THINK_MAX_MS` 균등 think time(초) |
| `options.mjs` | env(C7 키) → k6 `options`. phase 별 `http_req_duration{phase:<PHASE>}` threshold 포함 |

테스트: `node --test "loadtest/**/*.test.mjs"`

## open 과 closed 선택 규칙

- **open** (`MODEL=open`, `constant-arrival-rate`): 응답을 기다리지 않고 정해진 도착률(`RATE`/초)로 요청을 냅니다. 서버가 느려지면 대기 중인 요청이 쌓이고 지연이 그대로 드러납니다. 처리량·지연 한계를 재거나 두 전략을 비교할 때의 기본값입니다. `PRE_VUS`/`MAX_VUS` 가 모자라면 k6 가 반복을 건너뛰고 `dropped_iterations` 로 셉니다. 이것은 실패로 집계합니다.
- **closed** (`MODEL=closed`, `constant-vus`): VU `VUS`개가 요청 하나를 끝낸 뒤 think time 을 쉬고 다음 요청을 냅니다. 동시 사용자 수가 정해진 시스템(내부 도구 등)을 흉내 낼 때, 또는 경합 정합성 시나리오처럼 동시성 수준 자체를 고정하고 싶을 때 씁니다.

고르는 법: 도착률을 알거나 포화점을 찾으려면 open, 동시 접속자 수를 알면 closed. 모르겠으면 open 입니다.

## coordinated omission 과 closed 지연 해석 주의

closed 모델에서는 서버가 멈추면 VU 도 같이 멈춰서, 그동안 보냈어야 할 요청이 아예 만들어지지 않습니다. 느린 구간의 표본이 빠지므로 측정된 지연 분포가 실제 사용자가 겪을 지연보다 좋아 보입니다. 이것이 coordinated omission 입니다.

**closed 지연은 해석 주의**: closed 결과의 p95·p99 는 낙관적이며, 서버가 느려질수록 처리량이 같이 떨어져 부하가 스스로 줄어듭니다. 그래서 closed 실행에는 `closed-latency-caution` 배지를 붙이고, 지연을 open 결과와 같은 축에서 비교하지 않습니다(비교는 같은 모델끼리). open 은 도착 시각이 서버 상태와 무관하므로 이 왜곡이 없습니다.
