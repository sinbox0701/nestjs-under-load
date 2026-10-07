import { hostname } from 'node:os';

import { z } from 'zod';

/**
 * 정적 env(zod typed config). 컨테이너 재생성 없이 restart만 하므로(DESIGN §5.3) 실행마다 바뀌는 값은
 * 여기 두지 않는다. 실행마다 바뀌는 값은 RunConfig로 받는다.
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  POSTGRES_HOST: z.string().min(1).default('postgres'),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DB: z.string().min(1).default('lab_run'),
  POSTGRES_USER: z.string().min(1).default('lab_app'),
  POSTGRES_PASSWORD: z.string().min(1).default('lab_app_local'),
  /** RunConfig JSON 파일 경로. 0단계 run.mjs가 쓰고 app은 읽기 전용 마운트로 읽는다. */
  RUN_CONFIG_PATH: z.string().min(1).default('/lab/active/run-config.json'),
  /**
   * 오케스트레이터 내부 URL(C1). 값이 있으면 `GET {URL}/internal/run-config`로 RunConfig를 받고,
   * 없으면 RUN_CONFIG_PATH 파일을 읽는다. 값이 없거나 빈 문자열·공백이면(run.mjs 경로의 compose 가 `ORCHESTRATOR_URL=` 로 넘긴다) 파일 모드이고, 기본 URL로 HTTP를 시도하지 않는다.
   */
  ORCHESTRATOR_URL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.url().optional()),
  /** 인스턴스 이름. 기본은 컨테이너 hostname(= 컨테이너 ID 앞부분). 원장·ready 응답에 쓴다. */
  INSTANCE_NAME: z.string().min(1).default(hostname()),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`환경 변수 검증 실패: ${parsed.error.message}`);
  }
  return parsed.data;
}
