import type { Env } from '../config/env';
import { type FetchRunConfigOptions, resolveRunConfig, type RunConfig } from '../config/run-config';
import { startTracing } from './start-tracing';

/** main.ts 가 bootstrap 에 넘기는 부팅 입력. bootstrap 은 RunConfig 를 다시 조회하지 않는다. */
export interface PreBoot {
  env: Env;
  /** null = 대기 모드(파일 없음 또는 HTTP 204) */
  runConfig: RunConfig | null;
  /** OTel SDK 를 켰는가 */
  tracing: boolean;
}

export interface PreBootOptions extends FetchRunConfigOptions {
  /** 테스트용: SDK 대신 부를 함수 */
  start?: typeof startTracing;
}

/**
 * RunConfig 를 먼저 얻고(파일 또는 ORCHESTRATOR_URL HTTP) 그 계측 수준으로 tracing 을 켠다.
 * http·express·pg 를 불러오기 전에 불러야 한다. RunConfig 조회는 전역 fetch(undici)라 http 모듈을 쓰지 않는다.
 */
export async function preBoot(env: Env, options: PreBootOptions = {}): Promise<PreBoot> {
  const { start = startTracing, ...fetchOptions } = options;
  const runConfig = await resolveRunConfig(env, fetchOptions);
  const tracing = runConfig ? start({ runConfig, instance: env.INSTANCE_NAME }) : false;
  return { env, runConfig, tracing };
}
