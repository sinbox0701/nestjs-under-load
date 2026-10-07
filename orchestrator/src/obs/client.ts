// ObsClient 구현(T-114). Grafana 주석(서비스 계정 토큰)과 Prometheus 범위 질의를 맡는다.
// obs 프로필이 없거나 연결이 거부되면 예외 없이 `not-measured` 를 돌려준다(ports.ts ObsClient).
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { GRAFANA_ANNOTATION_TAG } from '@under-load/contracts';

import type { OrchestratorConfig } from '../config.js';
import type { Clock, Measured, ObsClient } from '../ports.js';

export type ObsClientDeps = {
  obs: OrchestratorConfig['obs'];
  clock: Clock;
  /** 테스트용 주입. 기본 전역 fetch */
  fetch?: typeof fetch;
  /** 요청 하나의 제한 시간(ms). 기본 5000 */
  timeoutMs?: number;
};

const SERVICE_ACCOUNT_NAME = 'nul-orchestrator';
/** 스크레이프 누락으로 치는 최소 공백(ms). 간격이 5초이므로 표본 3개 분량. */
const GAP_MS = 15_000;
/** 범위 질의 최대 점 수(Prometheus 한도 11000 아래) */
const MAX_POINTS = 1000;
/** 원시 표본 질의 한 번이 덮는 구간(ms). 긴 실행은 나눠 질의한다. */
const GAP_CHUNK_MS = 10 * 60_000;

/** prom.json 에 동결하는 주요 지표. 이름은 C5. */
export const SNAPSHOT_QUERIES: Readonly<Record<string, string>> = Object.freeze({
  up: 'up',
  httpRps: 'sum(rate(lab_http_request_duration_seconds_count[15s]))',
  httpP99Seconds: 'histogram_quantile(0.99, sum by (le) (rate(lab_http_request_duration_seconds_bucket[15s])))',
  httpInFlight: 'sum(lab_http_requests_in_flight)',
  eventLoopLagP99Seconds: 'max(nodejs_eventloop_lag_p99_seconds)',
  eventLoopUtilization: 'max(lab_eventloop_utilization)',
  heapUsedBytes: 'sum(nodejs_heap_size_used_bytes)',
  residentMemoryBytes: 'sum(process_resident_memory_bytes)',
  cpuCores: 'sum(rate(process_cpu_seconds_total[15s]))',
  dbPoolConnections: 'sum by (state) (lab_db_pool_connections)',
  dbPoolAcquireTimeoutsPerSec: 'sum(rate(lab_db_pool_acquire_timeouts_total[15s]))',
});

type PromMatrix = { metric: Record<string, string>; values: [number, string][] };

class HttpStatusError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}`);
  }
}

const notMeasured = (reason: string): { status: 'not-measured'; reason: string } => ({ status: 'not-measured', reason });
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createObsClient(deps: ObsClientDeps): ObsClient {
  const { obs, clock } = deps;
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const enabled = obs.profiles.includes('obs');
  const grafana = obs.grafanaUrl.replace(/\/+$/, '');
  const prom = obs.prometheusUrl.replace(/\/+$/, '');

  async function call(url: string, init: RequestInit): Promise<unknown> {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new HttpStatusError(res.status, text);
    return text === '' ? null : (JSON.parse(text) as unknown);
  }

  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // ── Grafana 토큰: 파일에 있으면 재사용, 없을 때만 서비스 계정·토큰 생성 ──
  let tokenPromise: Promise<string> | null = null;

  async function provisionToken(): Promise<string> {
    const basic = `Basic ${Buffer.from(`${obs.grafanaAdminUser}:${obs.grafanaAdminPassword}`).toString('base64')}`;
    const auth = (init: RequestInit): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: basic } });
    // 같은 이름의 서비스 계정이 이미 있으면 재사용(토큰 파일만 사라진 경우)
    const found = (await call(`${grafana}/api/serviceaccounts/search?query=${encodeURIComponent(SERVICE_ACCOUNT_NAME)}`, auth({ method: 'GET' }))) as {
      serviceAccounts?: { id: number; name: string }[];
    } | null;
    let id = found?.serviceAccounts?.find((s) => s.name === SERVICE_ACCOUNT_NAME)?.id;
    if (id === undefined) {
      const created = (await call(`${grafana}/api/serviceaccounts`, auth(json({ name: SERVICE_ACCOUNT_NAME, role: 'Editor', isDisabled: false })))) as { id: number };
      id = created.id;
    }
    const tok = (await call(`${grafana}/api/serviceaccounts/${id}/tokens`, auth(json({ name: `${SERVICE_ACCOUNT_NAME}-${clock.now()}` })))) as { key: string };
    await mkdir(dirname(obs.grafanaTokenFile), { recursive: true });
    await writeFile(obs.grafanaTokenFile, tok.key, { mode: 0o600 });
    return tok.key;
  }

  function getToken(): Promise<string> {
    tokenPromise ??= (async () => {
      try {
        const existing = (await readFile(obs.grafanaTokenFile, 'utf8')).trim();
        if (existing !== '') {
          await chmod(obs.grafanaTokenFile, 0o600);
          return existing;
        }
      } catch {
        // 파일 없음 → 생성
      }
      return provisionToken();
    })();
    // 실패는 캐시하지 않는다(다음 호출에서 다시 시도)
    tokenPromise.catch(() => {
      tokenPromise = null;
    });
    return tokenPromise;
  }

  async function postAnnotation(body: unknown): Promise<void> {
    const token = await getToken();
    const init = json(body);
    await call(`${grafana}/api/annotations`, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });
  }

  async function promRange(query: string, fromMs: number, toMs: number, stepSec: number): Promise<PromMatrix[]> {
    const qs = new URLSearchParams({ query, start: String(fromMs / 1000), end: String(toMs / 1000), step: `${stepSec}s` });
    const res = (await call(`${prom}/api/v1/query_range?${qs.toString()}`, { method: 'GET' })) as {
      status: string;
      error?: string;
      data?: { result: PromMatrix[] };
    };
    if (res.status !== 'success') throw new Error(res.error ?? 'prometheus error');
    return res.data?.result ?? [];
  }

  /** `<selector>[<구간>]` 범위 벡터를 time=끝시각 으로 질의한다. query_range 는 5분 staleness lookback 이 공백을 메우므로 원시 표본은 이 방식으로만 얻는다. */
  async function promRawSamples(selector: string, fromMs: number, toMs: number): Promise<PromMatrix[]> {
    const merged = new Map<string, { metric: Record<string, string>; values: Map<number, string> }>();
    for (let end = toMs; end > fromMs; end -= GAP_CHUNK_MS) {
      const spanSec = Math.max(1, Math.ceil((end - Math.max(fromMs, end - GAP_CHUNK_MS)) / 1000));
      const qs = new URLSearchParams({ query: `${selector}[${spanSec}s]`, time: String(end / 1000) });
      const res = (await call(`${prom}/api/v1/query?${qs.toString()}`, { method: 'GET' })) as {
        status: string;
        error?: string;
        data?: { result: PromMatrix[] };
      };
      if (res.status !== 'success') throw new Error(res.error ?? 'prometheus error');
      for (const s of res.data?.result ?? []) {
        const key = JSON.stringify(Object.entries(s.metric).sort());
        const acc = merged.get(key) ?? { metric: s.metric, values: new Map<number, string>() };
        for (const [t, v] of s.values) acc.values.set(t, v);
        merged.set(key, acc);
      }
    }
    return [...merged.values()].map((m) => ({ metric: m.metric, values: [...m.values.entries()].sort((x, y) => x[0] - y[0]) }));
  }

  return {
    async prepareToken() {
      if (!enabled) return notMeasured('obs 프로필 꺼짐');
      try {
        await getToken();
        return { status: 'ok' };
      } catch (e) {
        return notMeasured(errMsg(e));
      }
    },

    async annotate(a) {
      if (!enabled) return notMeasured('obs 프로필 꺼짐');
      const body: Record<string, unknown> = {
        time: a.timeMs,
        tags: [GRAFANA_ANNOTATION_TAG, `run:${a.runId}`, `batch:${a.batchId}`, `phase:${a.phase}`],
        text: a.text,
      };
      if (a.timeEndMs !== undefined) body.timeEnd = a.timeEndMs;
      try {
        try {
          await postAnnotation(body);
        } catch (e) {
          if (!(e instanceof HttpStatusError) || e.status !== 401) throw e;
          // 토큰이 폐기됐다: 파일을 지우고 한 번만 다시 만든다
          tokenPromise = null;
          await rm(obs.grafanaTokenFile, { force: true });
          await postAnnotation(body);
        }
        return { status: 'ok' };
      } catch (e) {
        return notMeasured(errMsg(e));
      }
    },

    async snapshot(a) {
      if (!enabled) return notMeasured('obs 프로필 꺼짐');
      const stepSec = Math.max(1, Math.ceil((a.toMs - a.fromMs) / 1000 / MAX_POINTS));
      try {
        const entries = await Promise.all(
          Object.entries(SNAPSHOT_QUERIES).map(async ([name, query]) => {
            try {
              return [name, { query, result: await promRange(query, a.fromMs, a.toMs, stepSec) }] as const;
            } catch (e) {
              // Prometheus 가 응답한 오류(질의 실패)는 그 지표만 기록하고, 연결 실패는 전체를 not-measured 로
              if (e instanceof HttpStatusError) return [name, { query, error: errMsg(e) }] as const;
              throw e;
            }
          }),
        );
        const doc = { runId: a.runId, fromMs: a.fromMs, toMs: a.toMs, stepSec, queries: Object.fromEntries(entries) };
        await mkdir(dirname(a.outFile), { recursive: true });
        const tmp = `${a.outFile}.tmp`;
        await writeFile(tmp, `${JSON.stringify(doc)}\n`);
        await rename(tmp, a.outFile);
        return { status: 'ok', file: a.outFile };
      } catch (e) {
        return notMeasured(errMsg(e));
      }
    },

    async scrapeGaps(a): Promise<Measured<{ gaps: number; details?: Record<string, unknown> }>> {
      if (!enabled) return notMeasured('obs 프로필 꺼짐');
      try {
        const series = await promRawSamples('up', a.fromMs, a.toMs);
        const perSeries: Record<string, { gaps: number; down: number }> = {};
        let gaps = 0;
        series.forEach((s, idx) => {
          let timeGaps = 0;
          let down = 0;
          for (let i = 0; i < s.values.length; i++) {
            const [t, v] = s.values[i]!;
            if (i > 0 && (t - s.values[i - 1]![0]) * 1000 >= GAP_MS) timeGaps++;
            // up==0 은 스크레이프 실패이므로 연속된 0 한 덩어리를 누락 1구간으로 센다
            if (v === '0' && (i === 0 || s.values[i - 1]![1] !== '0')) down++;
          }
          if (timeGaps + down > 0) {
            const label = [s.metric.job, s.metric.instance].filter(Boolean).join('/');
            perSeries[label === '' ? `series-${idx}` : label] = { gaps: timeGaps, down };
          }
          gaps += timeGaps + down;
        });
        return { status: 'ok', gaps, details: { series: series.length, perSeries, gapMs: GAP_MS } };
      } catch (e) {
        return notMeasured(errMsg(e));
      }
    },
  };
}
