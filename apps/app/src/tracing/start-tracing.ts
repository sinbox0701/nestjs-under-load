import type { InstrumentationLevel } from '@under-load/contracts';

/**
 * 트레이싱 부팅 지점. 지금은 noop 이다(SDK 는 아직 붙이지 않는다).
 * 반드시 앱 모듈을 불러오기 전에 호출해야 하는 자리라서 시그니처만 먼저 고정한다.
 */
export function startTracing(level: InstrumentationLevel): void {
  void level;
}
