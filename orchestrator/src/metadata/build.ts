// RunMetadata v1 조립기. scripts/run.mjs buildMetadata(0단계)를 일반화했다: 요청(RunRequest)에서 얻는 값은
// 요청에서, 실측값(이미지·호스트·limit·pg 설정 등)은 ctx 로 받고, 모르는 칸은 null 로 두어 completeness 가 보고하게 한다.
import { RunMetadataV1Schema } from '@under-load/contracts';
import type { RunMetadataV1, RunRequest } from '@under-load/contracts';

type ContainerLimit = RunMetadataV1['limits']['app'];

export type BuildMetadataContext = {
  runId: string;
  batchId: string;
  sessionId: string;
  repetition: number;
  request: RunRequest;
  /** 이 배치의 strategy id */
  strategy: string;
  appInstances: number;
  startedAt?: string | null;
  endedAt?: string | null;
  profile?: RunMetadataV1['profile'];
  stackProfiles?: RunMetadataV1['stack']['profiles'];
  git?: RunMetadataV1['git'];
  images?: Partial<RunMetadataV1['images']>;
  host?: Partial<RunMetadataV1['host']>;
  /** app·nginx·postgres·k6 외 컨테이너도 같은 모양으로 더할 수 있다 */
  limits?: Record<string, ContainerLimit>;
  topology?: Partial<Omit<RunMetadataV1['topology'], 'appInstances'>>;
  pool?: Partial<RunMetadataV1['pool']>;
  postgres?: Partial<RunMetadataV1['postgres']>;
  timeouts?: Partial<RunMetadataV1['timeouts']>;
  redis?: RunMetadataV1['redis'];
  seedHash?: string | null;
  templateDb?: string | null;
  rows?: Record<string, unknown>;
  k6ScriptHash?: string | null;
  k6ScriptEdited?: boolean;
  validity?: Partial<RunMetadataV1['validity']>;
  invariants?: RunMetadataV1['invariants'];
  ledgerVsClient?: Record<string, unknown> | null;
  k6?: Record<string, unknown> | null;
  steps?: RunMetadataV1['steps'];
  artifacts?: Partial<RunMetadataV1['artifacts']>;
};

const NO_LIMIT: ContainerLimit = { cpus: null, mem: null, cpuset: null };

/** 지속 문자열("10s", "1m30s", "500ms") → ms. 모르는 형식은 null. */
export function durationToMs(text: string): number | null {
  if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(text)) return null;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
  let total = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) total += Number(m[1]) * unit[m[2] as keyof typeof unit];
  return Math.round(total);
}

function distributionLabel(d: RunRequest['data']['distribution']): string {
  return d.kind === 'zipf' ? `zipf(${d.s})` : 'uniform';
}

/** 조립 결과는 v1 zod 를 통과해야 한다(아니면 ZodError). */
export function buildMetadata(ctx: BuildMetadataContext): RunMetadataV1 {
  const { request, runId } = ctx;
  const params = request.strategyParams[ctx.strategy] ?? {};
  const load = request.load;
  const lockMs = typeof params.lockTimeoutMs === 'number' ? params.lockTimeoutMs : null;
  const warmup = durationToMs(load.warmup) === 0 ? 'none' : `${load.warmup}(별도 실행)`;
  const limits: Record<string, ContainerLimit> = {
    app: NO_LIMIT,
    nginx: NO_LIMIT,
    postgres: NO_LIMIT,
    k6: NO_LIMIT,
    ...ctx.limits,
  };

  const md: RunMetadataV1 = {
    schemaVersion: 1,
    runId,
    batchId: ctx.batchId,
    sessionId: ctx.sessionId,
    repetition: ctx.repetition,
    scenario: request.scenario,
    strategy: { id: ctx.strategy, params },
    git: ctx.git ?? { sha: null, dirty: null },
    images: { app: null, postgres: null, k6: null, nginx: null, redis: null, ...ctx.images },
    profile: ctx.profile ?? 'default',
    stack: { profiles: ctx.stackProfiles ?? [] },
    host: { dockerNcpu: null, dockerMemBytes: null, os: null, arch: null, cpu: null, dockerDesktopVersion: null, ...ctx.host },
    limits: limits as RunMetadataV1['limits'],
    topology: { lb: 'round-robin', dbPath: 'direct', proxy: 'off', replica: false, ...ctx.topology, appInstances: ctx.appInstances },
    pool: { min: null, max: null, acquireTimeoutMs: null, ...ctx.pool },
    postgres: {
      configHash: null,
      maxConnections: null,
      sharedBuffers: null,
      observerConnections: null,
      appRoleConnectionLimit: null,
      ...ctx.postgres,
    },
    timeouts: {
      k6RequestMs: durationToMs(load.requestTimeout),
      serverRequestMs: null,
      poolAcquireMs: null,
      statementMs: null,
      lockMs,
      idleInTxMs: null,
      ...ctx.timeouts,
    },
    redis: ctx.redis ?? { used: false, maxmemoryPolicy: null },
    data: {
      seed: request.data.seed,
      seedHash: ctx.seedHash ?? null,
      templateDb: ctx.templateDb ?? null,
      seedOptions: request.data.seedOptions,
      rows: ctx.rows ?? {},
      distribution: distributionLabel(request.data.distribution),
      scenarioParams: request.scenarioParams,
    },
    load: {
      model: load.model,
      executor: load.model === 'open' ? 'constant-arrival-rate' : 'constant-vus',
      profile: load.profile,
      vus: load.vus,
      rate: load.rate,
      timeUnit: load.model === 'open' ? '1s' : null,
      preAllocatedVUs: load.preAllocatedVUs,
      maxVUs: load.maxVUs,
      duration: load.duration,
      warmup,
      thinkTimeMs: load.thinkTimeMs,
    },
    k6Script: { hash: ctx.k6ScriptHash ?? null, edited: ctx.k6ScriptEdited ?? false },
    instrumentation: request.instrumentation,
    pgProbe: request.pgProbe ?? { enabled: false, intervalMs: null },
    interventions: request.injectDelay.map((d) => ({ type: 'inject-delay' as const, ...d })),
    chaos: [],
    coldStart: false,
    osCacheControlled: false,
    validity: {
      valid: null,
      reasons: [],
      k6CpuAvgRatio: null,
      droppedCountedAsFailure: null,
      ...ctx.validity,
      checks: { k6Cpu: null, scrapeGaps: null, ...ctx.validity?.checks },
    },
    invariants: ctx.invariants ?? [],
    ledgerVsClient: ctx.ledgerVsClient ?? null,
    k6: ctx.k6 ?? null,
    prediction: request.prediction,
    steps: ctx.steps ?? [],
    artifacts: {
      runConfig: `runs/${runId}/run-config.json`,
      k6Summary: `runs/${runId}/summary.json`,
      k6Html: `runs/${runId}/report.html`,
      events: null,
      agg: null,
      probe: null,
      promSnapshot: null,
      metadata: `runs/${runId}/metadata.json`,
      ...ctx.artifacts,
    },
    startedAt: ctx.startedAt ?? null,
    endedAt: ctx.endedAt ?? null,
  };
  return RunMetadataV1Schema.parse(md);
}
