import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { parseRunConfig, RUN_CONFIG_FETCH, type RunConfig } from '@under-load/contracts';

import type { Env } from './env';

/**
 * RunConfig 로더(C1). 정본 스키마는 `@under-load/contracts`(v1)이고, schemaVersion 이 없는 0단계 파일은
 * 계약의 parseRunConfig 가 기본값으로 채워 v1 으로 올린다.
 *
 * - ORCHESTRATOR_URL 있음 → HTTP 조회(200 = RunConfig, 204 = 대기 모드, 실패는 재시도)
 * - 없음 → 0단계 파일(RUN_CONFIG_PATH). run.mjs 대체 경로라 계속 유지한다.
 */
export type { RunConfig };

/**
 * RunConfig 파일이 없으면 null(대기 모드: /_lab 엔드포인트만 뜨고 DB에 붙지 않는다).
 * 파일이 있는데 형식이 틀리면 부팅 실패.
 */
export function loadRunConfig(path: string): RunConfig | null {
  if (!existsSync(path)) return null;
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  try {
    return parseRunConfig(raw);
  } catch (err) {
    throw new Error(`RunConfig 검증 실패(${path}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface FetchRunConfigOptions {
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  retryIntervalMs?: number;
  /** 시도 실패 때 호출(로깅용) */
  onRetry?: (attempt: number, reason: string) => void;
}

/**
 * 오케스트레이터에서 RunConfig 를 받는다. 200/204 가 아니거나 연결이 실패하면 retryIntervalMs 간격으로
 * 최대 maxAttempts 번 시도하고, 그래도 안 되면 던진다(부팅 실패 → exit 1). 200 인데 본문이 계약과
 * 다르면 재시도해도 소용없으므로 바로 던진다.
 */
export async function fetchRunConfig(
  baseUrl: string,
  instance: string,
  options: FetchRunConfigOptions = {},
): Promise<RunConfig | null> {
  const {
    fetchImpl = fetch,
    maxAttempts = RUN_CONFIG_FETCH.maxAttempts,
    retryIntervalMs = RUN_CONFIG_FETCH.retryIntervalMs,
    onRetry,
  } = options;
  const url = new URL(RUN_CONFIG_FETCH.path, baseUrl);
  url.searchParams.set(RUN_CONFIG_FETCH.instanceQuery, instance);

  let lastReason = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetchImpl(url);
    } catch (err) {
      lastReason = `연결 실패: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (res) {
      if (res.status === RUN_CONFIG_FETCH.standbyStatus) return null;
      if (res.status === 200) {
        try {
          return parseRunConfig(await res.json());
        } catch (err) {
          throw new Error(`RunConfig 검증 실패(${url.origin}${url.pathname}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      lastReason = `HTTP ${res.status}`;
    }
    if (attempt < maxAttempts) {
      onRetry?.(attempt, lastReason);
      await sleep(retryIntervalMs);
    }
  }
  throw new Error(`RunConfig 조회 실패(${url.origin}${url.pathname}): ${maxAttempts}회 시도, 마지막 사유 ${lastReason}`);
}

/** env 에 따라 HTTP 또는 파일에서 RunConfig 를 얻는다. null = 대기 모드. */
export async function resolveRunConfig(env: Env, options: FetchRunConfigOptions = {}): Promise<RunConfig | null> {
  if (env.ORCHESTRATOR_URL) return fetchRunConfig(env.ORCHESTRATOR_URL, env.INSTANCE_NAME, options);
  return loadRunConfig(env.RUN_CONFIG_PATH);
}
