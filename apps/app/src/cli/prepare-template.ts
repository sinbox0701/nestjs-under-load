/* eslint-disable @typescript-eslint/no-require-imports */
require('reflect-metadata');

import { parseArgs } from 'node:util';

import { loadEnv } from '../config/env';
import { loadPack } from '../packs/registry';
import { prepareTemplate } from '../prepare/prepare-template';

/**
 * 템플릿 DB 준비: 팩 마이그레이션 실행 + 결정적 시드.
 * run.mjs가 `docker compose run --rm app node apps/app/dist/cli/prepare-template.js ...`로
 * POSTGRES_DB=<템플릿 DB 이름>을 넘겨 호출한다(DESIGN §6.4: 마이그레이션은 템플릿 생성 시 실행).
 * 실제 작업은 task=prepare-template 과 같은 prepareTemplate(prepare/)이 한다. 이 파일은 인자 해석만 한다.
 *
 *   --scenario g02-stock-decrement --seed-opt products=5 --seed-opt warmupProducts=5 --seed-opt stockPerProduct=100
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string' },
      'seed-opt': { type: 'string', multiple: true, default: [] },
    },
  });
  if (!values.scenario) throw new Error('--scenario 필요');

  const seedOpts: Record<string, number> = {};
  for (const kv of values['seed-opt'] ?? []) {
    const [k, v] = kv.split('=');
    const n = Number(v);
    if (!k || !Number.isInteger(n)) throw new Error(`--seed-opt 형식 오류: ${kv} (key=정수)`);
    seedOpts[k] = n;
  }

  const env = loadEnv();
  const pack = await loadPack(values.scenario);
  const done = await prepareTemplate(env, pack, { database: env.POSTGRES_DB, seedOptions: seedOpts });
  console.log(`[prepare-template] ${done.database}: migrations + seed done ${JSON.stringify(seedOpts)} (${done.durationMs}ms)`);
}

main().catch((err: unknown) => {
  console.error('[prepare-template] failed:', err);
  process.exitCode = 1;
});
