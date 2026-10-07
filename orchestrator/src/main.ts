// 오케스트레이터 진입점(T-138): env → 설정 → 모듈을 ports 로 조립 → 공개(4000)·내부(4001) 리스너.
// 시작할 때 PG 역할 보장·Grafana 토큰 준비를 하고(실패는 경고), SIGTERM/SIGINT 에 진행 중 세션을 중단하고 리스너를 닫는다.
// 조립 함수(startOrchestrator)는 포트만 받으므로 테스트는 가짜 포트로 조립·종료를 검증한다.
import { execFile } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { NOT_MEASURED, ReadyResponseSchema, STACK_PROFILES } from '@under-load/contracts';
import type { RunMetadataV1 } from '@under-load/contracts';
import { z } from 'zod';

import { createRunConfigBoard, loadPackCatalog, registerApiRoutes, type PackCatalog } from './api/index.js';
import { loadConfig, type OrchestratorConfig } from './config.js';
import { createDbAdmin, createInvariantRunner, createPgConnect } from './db/index.js';
import { createDockerControl } from './docker/index.js';
import { createEventHub } from './event-hub/index.js';
import { createRouters, startHttpServers } from './http/index.js';
import { createK6Runner } from './k6/index.js';
import { buildMetadata, type BuildMetadataContext } from './metadata/index.js';
import { createObsClient } from './obs/index.js';
import { createPgConnect as createProbeConnect, createPgProbe } from './pg-probe/index.js';
import type {
  Clock,
  ContainerInfo,
  DbAdmin,
  DockerControl,
  EventHub,
  InvariantRunner,
  K6Runner,
  MetadataStore,
  ObsClient,
  ProbeSource,
  ReadyProbe,
  RunConfigBoard,
  RunEngine,
} from './ports.js';
import { createRunEngine, DEFAULT_RUN_CONFIG, type MetadataBuilder, type RunEngineOptions } from './runs/index.js';
import { createMetadataStore } from './store/index.js';

type StackProfile = (typeof STACK_PROFILES)[number];
type Log = (message: string) => void;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ───────────────────────────── Clock ─────────────────────────────

/** 실제 시계. sleep 은 signal 이 abort 되면 AbortError 로 reject 한다. */
export const systemClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
  sleep: (ms, opts) => sleepTimer(ms, undefined, { signal: opts?.signal }),
};

// ───────────────────────────── env ─────────────────────────────

/**
 * compose(infra/compose/docker-compose.yml orchestrator 서비스)가 넘기는 변수 이름을 config.ts 이름으로 옮긴다.
 * config.ts 이름이 이미 있으면 그대로 둔다.
 */
export function resolveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const alias = (to: string, from: string) => {
    if (out[to] === undefined && out[from] !== undefined) out[to] = out[from];
  };
  alias('PG_HOST', 'POSTGRES_HOST');
  alias('PG_PORT', 'POSTGRES_PORT');
  alias('PG_ADMIN_USER', 'POSTGRES_SUPERUSER');
  alias('PG_ADMIN_PASSWORD', 'POSTGRES_SUPERUSER_PASSWORD');
  alias('PG_OBSERVER_PASSWORD', 'LAB_OBSERVER_PASSWORD');
  alias('COMPOSE_PROJECT', 'COMPOSE_PROJECT_NAME');
  // DOCKER_HOST=tcp://socket-proxy:2375 → http://socket-proxy:2375
  if (out.DOCKER_URL === undefined && out.DOCKER_HOST?.startsWith('tcp://')) out.DOCKER_URL = `http://${out.DOCKER_HOST.slice('tcp://'.length)}`;
  // compose 는 이 값을 orchestrator 에 넘기지 않는다: grafana 서비스의 기본값과 맞춘다
  out.GRAFANA_ADMIN_PASSWORD ??= 'grafana_local';
  return out;
}

const positiveInt = (fallback: number) => z.coerce.number().int().min(1).default(fallback);

/** config.ts 밖의 배선 전용 값. */
const WiringEnvSchema = z.object({
  /** 내부 리스너 bind 주소(비우면 BIND_HOST) */
  INTERNAL_BIND_HOST: z.string().min(1).optional(),
  /** exporter 역할 비밀번호(compose 의 EXPORTER_PASSWORD). 비우면 DbAdmin 기본값 */
  EXPORTER_PASSWORD: z.string().min(1).optional(),
  /** app 인스턴스의 /_lab/ready 포트 */
  APP_PORT: positiveInt(3000),
  READY_TIMEOUT_MS: positiveInt(2000),
  /** manifest requires 에 redis 가 있는 strategy 에 게시하는 주소 */
  REDIS_HOST: z.string().min(1).default('redis'),
  REDIS_PORT: positiveInt(6379),
  /** app 이 /ingest/events 로 보낼 내부 주소의 호스트(compose 서비스 이름) */
  ORCH_INTERNAL_HOST: z.string().min(1).default('orchestrator'),
  /** k6 실행기 HTTP 요청 하나의 제한 */
  K6_FETCH_TIMEOUT_MS: positiveInt(10_000),
  /** k6 job 완료 대기 상한(넘으면 job 을 중단한다) */
  K6_WAIT_MAX_MS: positiveInt(2 * 60 * 60_000),
});
export type WiringEnv = z.infer<typeof WiringEnvSchema>;

export const loadWiringEnv = (env: NodeJS.ProcessEnv): WiringEnv => WiringEnvSchema.parse(env);

// ───────────────────────────── git(D2) ─────────────────────────────

export type GitInfo = { sha: string | null; dirty: boolean | null };

/** git 실행(테스트 교체용). 성공하면 stdout, 실패하면 throw. */
export type GitExec = (args: string[]) => Promise<string>;

const execFileP = promisify(execFile);

/** 레포 읽기 전용 마운트에서 git 을 돌린다. 마운트 소유자가 달라도 읽도록 safe.directory 를 풀고, 인덱스 잠금을 잡지 않는다. */
export const execGit =
  (repoDir: string): GitExec =>
  async (args) =>
    (await execFileP('git', ['--no-optional-locks', '-c', 'safe.directory=*', '-C', repoDir, ...args], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })).stdout;

/**
 * HEAD 앞 7자와 작업 트리 변경 여부. git 이 레포를 못 읽으면(예: worktree 의 `.git` 파일이 컨테이너에 없는 경로를 가리킴)
 * sha 는 fallbackSha(env GIT_SHA, 'unknown' 이면 무시), dirty 는 null.
 */
export async function readGitInfo(git: GitExec, fallbackSha: string | null): Promise<GitInfo> {
  const fallback = fallbackSha && fallbackSha !== 'unknown' ? fallbackSha.slice(0, 7) : null;
  let sha: string | null;
  try {
    sha = (await git(['rev-parse', 'HEAD'])).trim().slice(0, 7) || fallback;
  } catch {
    return { sha: fallback, dirty: null };
  }
  try {
    return { sha, dirty: (await git(['status', '--porcelain'])).trim().length > 0 };
  } catch {
    return { sha, dirty: null };
  }
}

// ───────────────────────────── 스택 프로필 ─────────────────────────────

/** 프로필별로 있으면 켜진 것으로 보는 compose 서비스. */
const PROFILE_SERVICES: Record<StackProfile, readonly string[]> = { obs: ['prometheus', 'grafana'], trace: ['tempo'] };

/**
 * 켜진 관측 프로필. env STACK_PROFILES 가 있으면 그 값, 없으면 compose 프로젝트에 그 프로필 서비스 컨테이너가 있는지로 판단한다.
 * Docker 조회가 실패하면 그 프로필은 꺼진 것으로 본다(경고).
 */
export async function detectStackProfiles(docker: Pick<DockerControl, 'list'>, explicit: string | undefined, warn: Log): Promise<StackProfile[]> {
  const known = new Set<string>(STACK_PROFILES);
  if (explicit !== undefined && explicit.trim() !== '')
    return explicit
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is StackProfile => known.has(s));
  const on: StackProfile[] = [];
  for (const p of STACK_PROFILES) {
    try {
      for (const svc of PROFILE_SERVICES[p]) {
        if ((await docker.list(svc)).length > 0) {
          on.push(p);
          break;
        }
      }
    } catch (e) {
      warn(`스택 프로필 ${p} 확인 실패(꺼진 것으로 본다): ${errMsg(e)}`);
    }
  }
  return on;
}

/** infra/redis/redis.conf 의 maxmemory-policy(메타데이터 redis.maxmemoryPolicy). 없으면 null. */
export async function readRedisPolicy(repoDir: string): Promise<string | null> {
  try {
    const text = await readFile(path.join(repoDir, 'infra/redis/redis.conf'), 'utf8');
    return /^\s*maxmemory-policy\s+(\S+)/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

// ───────────────────────────── 어댑터 ─────────────────────────────

/** app 인스턴스(컨테이너 이름 = compose 망 DNS)의 `GET /_lab/ready`. 연결 실패·비 200·모양 불일치는 null, 호출자 signal 중단은 throw. */
export function createReadyProbe(opts: { port: number; timeoutMs: number; fetch?: typeof fetch }): ReadyProbe {
  const doFetch = opts.fetch ?? fetch;
  return async (instance, callOpts) => {
    const signals = [AbortSignal.timeout(opts.timeoutMs), ...(callOpts?.signal ? [callOpts.signal] : [])];
    try {
      const res = await doFetch(`http://${instance}:${opts.port}/_lab/ready`, { signal: AbortSignal.any(signals) });
      if (res.status !== 200) {
        await res.body?.cancel();
        return null;
      }
      const parsed = ReadyResponseSchema.safeParse(await res.json());
      return parsed.success ? parsed.data : null;
    } catch (e) {
      if (callOpts?.signal?.aborted) throw e;
      return null;
    }
  };
}

/** strategy 의 manifest requires 에 redis 가 있는지. */
const needsRedis = (catalog: Pick<PackCatalog, 'info'>, scenario: string, strategy: string) =>
  catalog
    .info(scenario)
    ?.strategies.find((s) => s.id === strategy)
    ?.requires.includes('redis') ?? false;

/**
 * RunConfigBoard 에 배선 규칙을 더한다.
 * - redis: 엔진은 기본값(null)으로 게시하므로, manifest 의 strategy requires 에 redis 가 있으면 주소를 채운다.
 * - serve 게시는 `runs/<runId>/run-config.json` 으로도 남긴다(메타데이터 artifacts.runConfig 가 가리키는 파일).
 */
export function withManifestRedis(
  board: RunConfigBoard,
  opts: { catalog: Pick<PackCatalog, 'info'>; redis: { host: string; port: number }; runsDir: string | null; warn: Log },
): RunConfigBoard & { flushed(): Promise<void> } {
  // 쓰기는 게시 순서대로 한 줄로 세운다(같은 실행을 다시 게시하면 마지막 것이 남게)
  let writes: Promise<void> = Promise.resolve();
  return {
    publish(config) {
      const next = { ...config, redis: needsRedis(opts.catalog, config.scenario, config.strategy) ? opts.redis : null };
      board.publish(next);
      if (opts.runsDir && next.task === 'serve') {
        const file = path.join(opts.runsDir, next.runId, 'run-config.json');
        writes = writes
          .then(async () => {
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
            await rename(`${file}.tmp`, file);
          })
          .catch((e: unknown) => opts.warn(`[${next.runId}] run-config.json 쓰기 실패: ${errMsg(e)}`));
      }
    },
    get: (instance) => board.get(instance),
    clear: () => board.clear(),
    current: () => board.current(),
    fetchedBy: () => board.fetchedBy(),
    /** 지금까지 게시한 run-config.json 쓰기가 끝날 때(테스트·종료용) */
    flushed: () => writes,
  };
}

/** k6 실행기 요청 하나마다 제한 시간을 건다(호출자 signal 이 있으면 같이). */
export function timedFetch(timeoutMs: number, base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const signals = [AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [])];
    return base(input, { ...init, signal: AbortSignal.any(signals) });
  };
}

/** waitDone 에 상한을 건다: maxMs 가 지나면 signal 을 abort 해 job 을 중단하고 최종 상태를 돌려받는다. 대기는 Clock. */
export function boundK6Runner(k6: K6Runner, opts: { clock: Clock; waitMaxMs: number }): K6Runner {
  return {
    ...k6,
    async waitDone(jobId, o = {}) {
      const cap = new AbortController();
      const stop = new AbortController();
      opts.clock.sleep(opts.waitMaxMs, { signal: stop.signal }).then(
        () => cap.abort(new Error(`k6 job 대기 상한(${opts.waitMaxMs}ms) 초과`)),
        () => {},
      );
      try {
        return await k6.waitDone(jobId, { ...o, signal: o.signal ? AbortSignal.any([o.signal, cap.signal]) : cap.signal });
      } finally {
        stop.abort();
      }
    },
  };
}

/** HostConfig.Memory 바이트 → compose 표기("512m", "2g"). */
export function memText(bytes: number | null): string | null {
  if (bytes === null) return null;
  const units: [string, number][] = [
    ['g', 1024 ** 3],
    ['m', 1024 ** 2],
    ['k', 1024],
  ];
  for (const [u, n] of units) if (bytes % n === 0) return `${bytes / n}${u}`;
  return `${bytes}b`;
}

/** pg_settings.shared_buffers(8kB 페이지 수) → "128MB" 같은 표기. */
export function sharedBuffersText(pages: string | undefined): string | null {
  const n = Number(pages);
  if (pages === undefined || !Number.isFinite(n)) return null;
  const kb = n * 8;
  if (kb % (1024 * 1024) === 0) return `${kb / (1024 * 1024)}GB`;
  if (kb % 1024 === 0) return `${kb / 1024}MB`;
  return `${kb}kB`;
}

const limitOf = (c: ContainerInfo | undefined) =>
  c ? { cpus: c.limits.cpus, mem: memText(c.limits.memBytes), cpuset: c.limits.cpuset ?? 'none' } : undefined;

export type MetadataAdapterContext = {
  /** 켜진 관측 프로필 */
  stackProfiles: readonly StackProfile[];
  /** 세션 시작 때 갱신한 git 정보 */
  git: () => GitInfo;
  catalog: Pick<PackCatalog, 'info'>;
  redisMaxmemoryPolicy: string | null;
  /** 오케스트레이터가 도는 Docker VM 의 아키텍처·CPU 모델(테스트 고정용) */
  host?: { arch: string | null; cpu: string | null };
};

/**
 * 엔진의 RunMetadataInput → T-107 buildMetadata 컨텍스트. 포트 밖의 값(git·스택 프로필·redis 정책)은 여기서 채운다.
 * metadata.k6 는 평평한 K6Summary(batch-summary·measured 가 읽는 모양), k6Script.hash 는 엔진이 계산한 scriptHash.
 */
export function createMetadataBuilder(c: MetadataAdapterContext): MetadataBuilder {
  const host = c.host ?? { arch: os.arch(), cpu: os.cpus()[0]?.model || null };
  return (input) => {
    const { facts, runConfig, validity: v } = input;
    const first = (svc: string) => facts.containers[svc]?.[0];
    const images: BuildMetadataContext['images'] = {};
    const limits: NonNullable<BuildMetadataContext['limits']> = {};
    for (const svc of Object.keys(facts.containers)) {
      const lim = limitOf(first(svc));
      if (lim) limits[svc] = lim;
    }
    for (const svc of ['app', 'postgres', 'k6', 'nginx', 'redis'] as const) images[svc] = first(svc)?.imageId || null;
    const settings = facts.pgConfig?.settings ?? {};
    const redisUsed = needsRedis(c.catalog, input.request.scenario, input.strategy.id);
    const sg = input.scrapeGaps;
    const obsOn = c.stackProfiles.includes('obs');
    const scrapeGaps: RunMetadataV1['validity']['checks']['scrapeGaps'] =
      sg?.status === 'ok' ? { gaps: sg.gaps, ...(sg.details ? { details: sg.details } : {}) } : sg || !obsOn ? NOT_MEASURED : null;

    const md = buildMetadata({
      runId: input.runId,
      batchId: input.batchId,
      sessionId: input.sessionId,
      repetition: input.repetition,
      request: input.request,
      strategy: input.strategy.id,
      appInstances: input.appInstances,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      profile: 'default',
      stackProfiles: [...c.stackProfiles],
      git: c.git(),
      images,
      host: {
        dockerNcpu: facts.docker?.ncpu ?? null,
        dockerMemBytes: facts.docker?.memTotalBytes ?? null,
        os: facts.docker?.operatingSystem || null,
        arch: host.arch,
        cpu: host.cpu,
        // Engine API(/info)에 Docker Desktop 버전이 없다
        dockerDesktopVersion: null,
      },
      limits,
      pool: runConfig ? { ...runConfig.pool } : undefined,
      postgres: {
        configHash: facts.pgConfig?.hash ?? null,
        maxConnections: settings.max_connections !== undefined ? Number(settings.max_connections) : null,
        sharedBuffers: sharedBuffersText(settings.shared_buffers),
        observerConnections: input.pgProbe.enabled ? 1 : 0,
        appRoleConnectionLimit: null,
      },
      timeouts: runConfig
        ? {
            serverRequestMs: runConfig.timeouts.serverRequestMs,
            statementMs: runConfig.timeouts.statementMs,
            idleInTxMs: runConfig.timeouts.idleInTxMs,
            poolAcquireMs: runConfig.pool.acquireTimeoutMs,
          }
        : undefined,
      redis: { used: redisUsed, maxmemoryPolicy: redisUsed ? c.redisMaxmemoryPolicy : null },
      templateDb: input.templateDb,
      k6ScriptHash: input.k6.scriptHash,
      validity: {
        valid: v.valid,
        reasons: v.reasons,
        k6CpuAvgRatio: v.k6CpuAvgRatio,
        droppedCountedAsFailure: v.droppedCountedAsFailure,
        checks: { k6Cpu: v.k6Cpu, scrapeGaps },
      },
      invariants: input.invariants,
      k6: input.k6.summary ? { ...input.k6.summary } : null,
      steps: input.steps,
      artifacts: input.artifacts,
    });
    // 요청에 pgProbe 가 없으면 buildMetadata 는 꺼짐으로 적는다. 엔진이 실제로 쓴 값으로 바꾼다.
    return { ...md, pgProbe: { enabled: input.pgProbe.enabled, intervalMs: input.pgProbe.intervalMs } };
  };
}

// ───────────────────────────── 조립 ─────────────────────────────

export type OrchestratorPorts = {
  clock: Clock;
  docker: DockerControl;
  db: DbAdmin;
  invariants: InvariantRunner;
  k6: K6Runner;
  store: MetadataStore;
  board: RunConfigBoard;
  hub: EventHub;
  probe: ProbeSource;
  obs: ObsClient;
  catalog: PackCatalog;
  ready: ReadyProbe;
  buildMetadata: MetadataBuilder;
};

export type StartOptions = {
  ports: OrchestratorPorts;
  listen: Pick<OrchestratorConfig, 'publicPort' | 'internalPort' | 'bindHost' | 'allowedHosts' | 'allowedOrigins'> & { internalBindHost?: string };
  runsDir: string;
  version: string;
  gitSha: string;
  engine: RunEngineOptions;
  /** 세션 시작 직전에 한 번(git 정보 갱신 등). 실패해도 시작은 진행한다(경고). */
  beforeSession?: () => Promise<void>;
  /** Grafana 토큰 준비(obs 프로필이 있을 때만 넘긴다) */
  prepareGrafana?: () => Promise<void>;
  /** 종료 마지막에(저장소 닫기 등) */
  onClose?: () => void | Promise<void>;
  /** 종료 때 진행 중 세션이 끝나기를 기다리는 상한. 기본 5000ms */
  shutdownGraceMs?: number;
  log?: Log;
  warn?: Log;
};

export type OrchestratorHandle = {
  readonly ports: { readonly public: number; readonly internal: number };
  readonly engine: RunEngine;
  /** 시작 작업(역할 보장·Grafana 토큰). 실패는 경고로 끝나므로 reject 하지 않는다. */
  readonly startup: Promise<void>;
  close(): Promise<void>;
};

/** 포트로 엔진·라우트를 조립하고 두 리스너를 연다. 시작 작업은 리스너를 연 뒤 뒤에서 돈다. */
export async function startOrchestrator(o: StartOptions): Promise<OrchestratorHandle> {
  const log = o.log ?? ((m) => console.log(m));
  const warn = o.warn ?? ((m) => console.warn(`[경고] ${m}`));
  const p = o.ports;
  const engine = createRunEngine({ ...p, options: o.engine, log });

  // API 는 시작 전에 git 정보를 갱신하는 엔진을 본다
  const apiEngine: RunEngine = {
    async start(request) {
      if (o.beforeSession) await o.beforeSession().catch((e: unknown) => warn(`세션 준비 실패: ${errMsg(e)}`));
      return engine.start(request);
    },
    abort: (runId) => engine.abort(runId),
    status: (sessionId) => engine.status(sessionId),
    currentRunId: () => engine.currentRunId(),
    idle: () => engine.idle(),
  };

  const routers = createRouters();
  registerApiRoutes(routers, { engine: apiEngine, store: p.store, catalog: p.catalog, board: p.board, k6: p.k6, runsDir: o.runsDir, version: o.version, gitSha: o.gitSha });
  p.hub.registerRoutes(routers);
  const servers = await startHttpServers({
    routers,
    guard: { allowedHosts: o.listen.allowedHosts, allowedOrigins: o.listen.allowedOrigins },
    publicPort: o.listen.publicPort,
    internalPort: o.listen.internalPort,
    bindHost: o.listen.bindHost,
    ...(o.listen.internalBindHost ? { internalBindHost: o.listen.internalBindHost } : {}),
    onError: (e) => warn(`[http] ${errMsg(e)}`),
  });
  log(`오케스트레이터: 공개 ${o.listen.bindHost}:${servers.ports.public}, 내부 ${o.listen.internalBindHost ?? o.listen.bindHost}:${servers.ports.internal}`);

  const startup = (async () => {
    try {
      await p.db.ensureRoles();
      log('PG 역할 보장 완료(lab_observer·exporter)');
    } catch (e) {
      warn(`PG 역할 보장 실패: ${errMsg(e)}`);
    }
    if (o.prepareGrafana) {
      try {
        await o.prepareGrafana();
        log('Grafana 토큰 준비 완료');
      } catch (e) {
        warn(`Grafana 토큰 준비 실패(주석은 not-measured): ${errMsg(e)}`);
      }
    }
  })();

  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      const serversClosed = servers.close();
      const runId = engine.currentRunId();
      if (runId) {
        log(`종료: 진행 중 실행 ${runId} 중단`);
        await engine.abort(runId).catch((e: unknown) => warn(`중단 실패: ${errMsg(e)}`));
        const grace = new AbortController();
        await Promise.race([engine.idle(), p.clock.sleep(o.shutdownGraceMs ?? 5000, { signal: grace.signal }).catch(() => {})]);
        grace.abort();
      }
      // WS 소켓은 업그레이드 뒤 서버 연결 목록에서 빠지므로 허브가 끊어야 서버 close 가 끝난다
      await p.hub.close().catch((e: unknown) => warn(`이벤트 허브 종료 실패: ${errMsg(e)}`));
      await serversClosed;
      await p.probe.stop().catch(() => undefined);
      await startup;
      await o.onClose?.();
    })());

  return { ports: servers.ports, engine: apiEngine, startup, close };
}

/** SIGTERM·SIGINT 를 한 번 받으면 handle.close() 후 종료 코드로 exit 한다. 테스트는 가짜 proc 를 넘긴다. */
export function installShutdown(handle: Pick<OrchestratorHandle, 'close'>, proc: Pick<EventEmitter, 'once'> & { exit(code?: number): void }, log: Log = (m) => console.log(m)) {
  let done = false;
  const onSignal = (signal: string) => {
    if (done) return;
    done = true;
    log(`${signal} 수신: 종료한다`);
    handle.close().then(
      () => proc.exit(0),
      (e: unknown) => {
        log(`종료 중 오류: ${errMsg(e)}`);
        proc.exit(1);
      },
    );
  };
  proc.once('SIGTERM', () => onSignal('SIGTERM'));
  proc.once('SIGINT', () => onSignal('SIGINT'));
}

// ───────────────────────────── 실제 배선 ─────────────────────────────

export async function main(rawEnv: NodeJS.ProcessEnv = process.env): Promise<OrchestratorHandle> {
  const env = resolveEnv(rawEnv);
  const config = loadConfig(env);
  const w = loadWiringEnv(env);
  const log: Log = (m) => console.log(m);
  const warn: Log = (m) => console.warn(`[경고] ${m}`);
  const clock = systemClock;

  const docker = createDockerControl({ baseUrl: config.docker.url, composeProject: config.docker.composeProject });
  const connect = createPgConnect(config.pg);
  const db = createDbAdmin({
    connect,
    runDb: config.pg.runDb,
    appUser: config.pg.appUser,
    observerUser: config.pg.observerUser,
    observerPassword: config.pg.observerPassword,
    ...(w.EXPORTER_PASSWORD ? { exporterPassword: w.EXPORTER_PASSWORD } : {}),
    repoDir: config.repoDir,
  });
  const invariants = createInvariantRunner({ connect, runDb: config.pg.runDb, repoDir: config.repoDir });
  const k6 = boundK6Runner(
    createK6Runner({ runnerUrl: config.k6.runnerUrl, baseUrl: config.k6.targetBaseUrl, clock, repoDir: config.repoDir, fetch: timedFetch(w.K6_FETCH_TIMEOUT_MS) }),
    { clock, waitMaxMs: w.K6_WAIT_MAX_MS },
  );
  const store = createMetadataStore({ runsDir: config.runsDir });
  const catalog = loadPackCatalog(config.repoDir);
  const board = withManifestRedis(createRunConfigBoard(), { catalog, redis: { host: w.REDIS_HOST, port: w.REDIS_PORT }, runsDir: config.runsDir, warn });
  const hub = createEventHub({ clock });
  const probeConnect = createProbeConnect({
    host: config.pg.host,
    port: config.pg.port,
    user: config.pg.observerUser,
    password: config.pg.observerPassword,
    database: config.pg.runDb,
  });
  const probe = createPgProbe({
    clock,
    enabled: true,
    database: config.pg.runDb,
    // pg.Client 의 유휴 연결 오류가 리스너 없이 터지면 프로세스가 죽는다
    connect: async () => {
      const conn = await probeConnect();
      (conn as unknown as EventEmitter).on?.('error', (e: unknown) => warn(`pg-probe 연결 오류: ${errMsg(e)}`));
      return conn;
    },
    onError: (e) => warn(`pg-probe: ${errMsg(e)}`),
  });

  const stackProfiles = await detectStackProfiles(docker, rawEnv.STACK_PROFILES, warn);
  const obs = createObsClient({ obs: { ...config.obs, profiles: stackProfiles }, clock });
  const git = execGit(config.repoDir);
  let gitInfo = await readGitInfo(git, config.gitSha);
  if (gitInfo.dirty === null) warn(`git 으로 ${config.repoDir} 를 읽지 못했다: gitSha=${gitInfo.sha ?? 'unknown'}(GIT_SHA 폴백), dirty=null`);
  const buildMeta = createMetadataBuilder({ stackProfiles, git: () => gitInfo, catalog, redisMaxmemoryPolicy: await readRedisPolicy(config.repoDir) });
  log(`스택 프로필: ${stackProfiles.length ? stackProfiles.join(',') : '(기본)'}; git ${gitInfo.sha ?? 'unknown'}${gitInfo.dirty ? '(dirty)' : ''}`);

  const handle = await startOrchestrator({
    ports: { clock, docker, db, invariants, k6, store, board, hub, probe, obs, catalog, ready: createReadyProbe({ port: w.APP_PORT, timeoutMs: w.READY_TIMEOUT_MS }), buildMetadata: buildMeta },
    listen: { ...config, ...(w.INTERNAL_BIND_HOST ? { internalBindHost: w.INTERNAL_BIND_HOST } : {}) },
    runsDir: config.runsDir,
    version: config.version,
    gitSha: gitInfo.sha ?? config.gitSha,
    engine: {
      runsDir: config.runsDir,
      k6RunsDir: '/runs',
      appService: config.docker.appService,
      prometheusRw: stackProfiles.includes('obs'),
      runConfig: { events: { ...DEFAULT_RUN_CONFIG.events, endpoint: `http://${w.ORCH_INTERNAL_HOST}:${config.internalPort}/ingest/events` } },
    },
    beforeSession: async () => {
      gitInfo = await readGitInfo(git, config.gitSha);
    },
    // ObsClient 는 토큰을 첫 주석 때 만든다: 실행과 무관한 태그(run:orchestrator)로 주석 하나를 남겨 시작 때 토큰을 준비한다.
    ...(stackProfiles.includes('obs')
      ? {
          prepareGrafana: async () => {
            const r = await obs.annotate({ runId: 'orchestrator', batchId: 'startup', phase: 'reset', text: '오케스트레이터 시작', timeMs: clock.now() });
            if (r.status !== 'ok') throw new Error(r.reason ?? 'not-measured');
          },
        }
      : {}),
    onClose: async () => {
      await board.flushed();
      store.close();
    },
    log,
    warn,
  });
  installShutdown(handle, process, log);
  return handle;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error('[오케스트레이터 시작 실패]', e);
    process.exit(1);
  });
}
