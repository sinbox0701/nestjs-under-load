// C7 k6 실행기 클라이언트 + env 변환 + summary 해석 + 유효성 판정(K6Runner 구현).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { K6JobStatusSchema } from '@under-load/contracts';
import type { K6JobRequest, K6JobStatus } from '@under-load/contracts';

import type { CallOptions, Clock, K6EnvInput, K6Runner, ScenarioDef } from '../ports.js';
import { judgeValidity } from '../validity/index.js';
import { buildEnv, hashScript } from './env.js';
import { parseSummary } from './summary.js';

export type K6RunnerDeps = {
  /** 실행기 주소(설정 K6_RUNNER_URL) */
  runnerUrl: string;
  /** k6 가 때리는 주소(설정 TARGET_BASE_URL) */
  baseUrl: string;
  clock: Clock;
  /** 레포 읽기 전용 마운트(설정 REPO_DIR). 스크립트 해시용 */
  repoDir: string;
  repActors?: number;
  /** 테스트용 교체 지점 */
  fetch?: typeof fetch;
  /** 완료 대기 조회 간격 기본값(ms) */
  pollMs?: number;
  /** 중단을 요청한 뒤 최종 상태를 기다리는 상한(ms). 넘으면 waitDone 이 throw 한다. 기본 30000 */
  abortGraceMs?: number;
};

const SCRIPT_PREFIX = '/packs/';
const RUNS_PREFIX = '/runs/';

/** 실행기는 경로를 검증하지 않으므로(T-119 리뷰) 여기서 prefix·`..` 를 막는다. */
function assertPath(label: string, value: string, prefix: string): void {
  if (!value.startsWith(prefix) || value.split('/').includes('..')) throw new Error(`${label} 경로가 ${prefix} 아래가 아님: ${value}`);
}

export function createK6Runner(deps: K6RunnerDeps): K6Runner {
  const doFetch = deps.fetch ?? fetch;
  const base = deps.runnerUrl.replace(/\/+$/, '');

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  }

  const errorOf = (json: unknown): string => (json as { error?: string } | null)?.error ?? JSON.stringify(json);

  const runner: K6Runner = {
    buildEnv: (input: K6EnvInput) => buildEnv(input, { baseUrl: deps.baseUrl, repActors: deps.repActors }),

    async scriptHash(scenario: ScenarioDef, env: Record<string, string>) {
      const text = await readFile(join(deps.repoDir, scenario.k6Script.replace(/^\/+/, '')), 'utf8');
      return hashScript(text, env);
    },

    async submit(job: K6JobRequest) {
      assertPath('script', job.script, SCRIPT_PREFIX);
      assertPath('summaryPath', job.summaryPath, RUNS_PREFIX);
      if (job.htmlExport !== null) assertPath('htmlExport', job.htmlExport, RUNS_PREFIX);
      const r = await call('POST', '/jobs', job);
      if (r.status === 409) throw new Error(`k6 실행기가 이미 실행 중: ${errorOf(r.json)}`);
      const jobId = (r.json as { jobId?: unknown } | null)?.jobId;
      if (r.status !== 202 || typeof jobId !== 'string') throw new Error(`k6 job 제출 실패(${r.status}): ${errorOf(r.json)}`);
      return { jobId };
    },

    async status(jobId: string): Promise<K6JobStatus> {
      const r = await call('GET', `/jobs/${encodeURIComponent(jobId)}`);
      if (r.status !== 200) throw new Error(`k6 job 조회 실패(${r.status}): ${errorOf(r.json)}`);
      return K6JobStatusSchema.parse(r.json);
    },

    async waitDone(jobId: string, opts: CallOptions & { pollMs?: number } = {}) {
      const pollMs = opts.pollMs ?? deps.pollMs ?? 500;
      const graceMs = deps.abortGraceMs ?? 30_000;
      /** 중단을 요청한 시각(요청 전이면 null) */
      let abortedAt: number | null = null;
      const aborted = () => abortedAt !== null;
      for (;;) {
        const s = await runner.status(jobId);
        if (s.state !== 'running') return s;
        if (opts.signal?.aborted && !aborted()) {
          abortedAt = deps.clock.now();
          await runner.abort(jobId);
          continue;
        }
        // 실행기가 중단 요청 뒤에도 running 이면 상한까지만 기다린다(대기가 세션 종료를 막지 않게)
        if (abortedAt !== null && deps.clock.now() - abortedAt >= graceMs) {
          throw new Error(`k6 job ${jobId} 이 중단 요청 뒤 ${graceMs}ms 안에 끝나지 않았다`);
        }
        // 중단을 요청한 뒤에는 signal 없이 최종 상태가 될 때까지 조회한다
        await deps.clock.sleep(pollMs, aborted() ? undefined : { signal: opts.signal }).catch((e: unknown) => {
          if (!opts.signal?.aborted) throw e;
        });
      }
    },

    async abort(jobId: string) {
      const r = await call('POST', `/jobs/${encodeURIComponent(jobId)}/abort`);
      // 409 = 이미 끝남(멱등)
      if (r.status !== 202 && r.status !== 409) throw new Error(`k6 job 중단 실패(${r.status}): ${errorOf(r.json)}`);
    },

    async inspect(script: string, env: Record<string, string>) {
      assertPath('script', script, SCRIPT_PREFIX);
      const r = await call('POST', '/inspect', { script, env });
      if (r.status !== 200) throw new Error(`k6 inspect 실패(${r.status}): ${errorOf(r.json)}`);
      return r.json;
    },

    async readSummary(summaryFile: string, mainDurationSec: number) {
      return parseSummary(JSON.parse(await readFile(summaryFile, 'utf8')), mainDurationSec);
    },

    judgeValidity,
  };
  return runner;
}

export { buildEnv, hashScript } from './env.js';
export { parseSummary } from './summary.js';
