import { existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';

/**
 * RunConfig — 실행 하나의 설정(팩·시나리오·strategy·파라미터).
 *
 * DESIGN §5.3은 app이 부팅 시 오케스트레이터 `GET /internal/run-config`에서 받아오도록 한다.
 * 0단계에는 오케스트레이터가 없으므로 `scripts/run.mjs`가 이 JSON을 `runs/_active/run-config.json`에 쓰고,
 * app은 그 디렉터리를 읽기 전용으로 마운트해 부팅 시 읽는다. env가 아니라 파일인 이유: app은 restart만
 * 하므로(재생성 없음) env는 실행마다 바꿀 수 없다. 1단계에서 이 로더만 HTTP 조회로 바꾼다.
 */
export const runConfigSchema = z.object({
  runId: z.string().min(1),
  batchId: z.string().min(1),
  repetition: z.number().int().min(1),
  scenario: z.string().min(1),
  strategy: z.string().min(1),
  strategyParams: z.record(z.string(), z.unknown()).default({}),
  /** 계측 수준(DESIGN §9.1). 0단계는 이벤트·지표가 없어 기록만 한다. */
  instrumentation: z.enum(['off', 'metrics', 'full']).default('off'),
  /** 경합 창 지연 주입(DESIGN §6.3). 기본 없음 */
  injectDelay: z.array(z.object({ point: z.string().min(1), ms: z.number().int().min(0) })).default([]),
  pool: z
    .object({
      min: z.number().int().min(0).default(2),
      max: z.number().int().min(1).default(10),
    })
    .default({ min: 2, max: 10 }),
});

export type RunConfig = z.infer<typeof runConfigSchema>;

/**
 * RunConfig 파일이 없으면 null(대기 모드: /_lab 엔드포인트만 뜨고 DB에 붙지 않는다).
 * 파일이 있는데 형식이 틀리면 부팅 실패.
 */
export function loadRunConfig(path: string): RunConfig | null {
  if (!existsSync(path)) return null;
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const parsed = runConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`RunConfig 검증 실패(${path}): ${parsed.error.message}`);
  }
  return parsed.data;
}
