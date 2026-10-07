// 오케스트레이터 env 설정(zod). 기본값은 compose lab-net/ctl-net 안의 서비스 이름이다.
// 사용: const config = loadConfig(); 모듈 티켓은 필요한 필드만 생성자 인자로 받는다(전역 import 금지).
import { ALLOWED_HOSTS, ALLOWED_ORIGINS, INTERNAL_PORT, K6_RUNNER_PORT, PUBLIC_PORT, STACK_PROFILES } from '@under-load/contracts';
import { z } from 'zod';

const csv = (fallback: readonly string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? [...fallback]
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);

const EnvSchema = z.object({
  // 리스너
  PUBLIC_PORT: port(PUBLIC_PORT),
  INTERNAL_PORT: port(INTERNAL_PORT),
  BIND_HOST: z.string().min(1).default('0.0.0.0'),
  /** 공개 포트 Host 허용 목록(쉼표). 기본 = 계약 C2 */
  PUBLIC_ALLOWED_HOSTS: csv(ALLOWED_HOSTS),
  /** 공개 포트 Origin 허용 목록(쉼표). 기본 = 계약 C2 */
  PUBLIC_ALLOWED_ORIGINS: csv(ALLOWED_ORIGINS),

  // 파일 경로
  RUNS_DIR: z.string().min(1).default('/runs'),
  /** 레포 읽기 전용 마운트(D2): 팩·manifest·git 정보 */
  REPO_DIR: z.string().min(1).default('/repo'),

  // 버전 표시(/health)
  ORCH_VERSION: z.string().default('0.0.0'),
  GIT_SHA: z.string().default('unknown'),

  // Postgres
  PG_HOST: z.string().min(1).default('postgres'),
  PG_PORT: port(5432),
  PG_ADMIN_USER: z.string().min(1).default('postgres'),
  PG_ADMIN_PASSWORD: z.string().default('postgres_local'),
  PG_APP_USER: z.string().min(1).default('lab_app'),
  PG_OBSERVER_USER: z.string().min(1).default('lab_observer'),
  PG_OBSERVER_PASSWORD: z.string().default('lab_observer_local'),
  PG_RUN_DB: z.string().min(1).default('lab_run'),

  // Docker (socket-proxy, D10)
  DOCKER_URL: z.url().default('http://socket-proxy:2375'),
  COMPOSE_PROJECT: z.string().min(1).default('nestjs-under-load'),
  APP_SERVICE: z.string().min(1).default('app'),

  // 부하 생성·대상
  K6_RUNNER_URL: z.url().default(`http://k6:${K6_RUNNER_PORT}`),
  /** k6 가 때리는 주소(nginx 경유) */
  TARGET_BASE_URL: z.url().default('http://nginx'),

  // 관측(obs 프로필이 없으면 모듈이 no-op)
  STACK_PROFILES: csv([]),
  GRAFANA_URL: z.url().default('http://grafana:3000'),
  GRAFANA_ADMIN_USER: z.string().default('admin'),
  GRAFANA_ADMIN_PASSWORD: z.string().default('admin'),
  /** 비우면 `<RUNS_DIR>/_meta/grafana-token` */
  GRAFANA_TOKEN_FILE: z.string().optional(),
  PROMETHEUS_URL: z.url().default('http://prometheus:9090'),
});

export interface OrchestratorConfig {
  readonly publicPort: number;
  readonly internalPort: number;
  readonly bindHost: string;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly runsDir: string;
  readonly repoDir: string;
  readonly version: string;
  readonly gitSha: string;
  readonly pg: {
    readonly host: string;
    readonly port: number;
    readonly adminUser: string;
    readonly adminPassword: string;
    readonly appUser: string;
    readonly observerUser: string;
    readonly observerPassword: string;
    readonly runDb: string;
  };
  readonly docker: { readonly url: string; readonly composeProject: string; readonly appService: string };
  readonly k6: { readonly runnerUrl: string; readonly targetBaseUrl: string };
  readonly obs: {
    /** 켜진 스택 프로필(STACK_PROFILES 의 부분집합) */
    readonly profiles: readonly string[];
    readonly grafanaUrl: string;
    readonly grafanaAdminUser: string;
    readonly grafanaAdminPassword: string;
    readonly grafanaTokenFile: string;
    readonly prometheusUrl: string;
  };
}

/** env → 설정. 잘못된 값이면 ZodError(메시지에 변수 이름 포함). 테스트는 env 를 직접 넘긴다. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const e = EnvSchema.parse(env);
  const known = new Set<string>(STACK_PROFILES);
  return {
    publicPort: e.PUBLIC_PORT,
    internalPort: e.INTERNAL_PORT,
    bindHost: e.BIND_HOST,
    allowedHosts: e.PUBLIC_ALLOWED_HOSTS,
    allowedOrigins: e.PUBLIC_ALLOWED_ORIGINS,
    runsDir: e.RUNS_DIR,
    repoDir: e.REPO_DIR,
    version: e.ORCH_VERSION,
    gitSha: e.GIT_SHA,
    pg: {
      host: e.PG_HOST,
      port: e.PG_PORT,
      adminUser: e.PG_ADMIN_USER,
      adminPassword: e.PG_ADMIN_PASSWORD,
      appUser: e.PG_APP_USER,
      observerUser: e.PG_OBSERVER_USER,
      observerPassword: e.PG_OBSERVER_PASSWORD,
      runDb: e.PG_RUN_DB,
    },
    docker: { url: e.DOCKER_URL, composeProject: e.COMPOSE_PROJECT, appService: e.APP_SERVICE },
    k6: { runnerUrl: e.K6_RUNNER_URL, targetBaseUrl: e.TARGET_BASE_URL },
    obs: {
      profiles: e.STACK_PROFILES.filter((p) => known.has(p)),
      grafanaUrl: e.GRAFANA_URL,
      grafanaAdminUser: e.GRAFANA_ADMIN_USER,
      grafanaAdminPassword: e.GRAFANA_ADMIN_PASSWORD,
      grafanaTokenFile: e.GRAFANA_TOKEN_FILE ?? `${e.RUNS_DIR}/_meta/grafana-token`,
      prometheusUrl: e.PROMETHEUS_URL,
    },
  };
}
