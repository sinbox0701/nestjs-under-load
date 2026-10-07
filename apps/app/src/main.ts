/* eslint-disable @typescript-eslint/no-require-imports */
// 순서: reflect-metadata → RunConfig 조회(파일 또는 ORCHESTRATOR_URL HTTP) → tracing → bootstrap.
// 정적 import 는 호이스팅되므로 CJS require 로 순서를 고정한다(DESIGN §5.1 main.ts). OTel 은 http·express·pg 를
// 불러오기 전에 켜져야 계측이 붙고(full 일 때만 SDK 로드), 수준은 RunConfig 에 있으므로 조회가 먼저다.
// 이 단계에서는 Nest 를 불러오지 않는다(로그는 같은 JSON 형식의 writeJsonLine).
require('reflect-metadata');
const { writeJsonLine } = require('./logging/json-line') as typeof import('./logging/json-line');

async function main(): Promise<void> {
  const { loadEnv } = require('./config/env') as typeof import('./config/env');
  const { preBoot } = require('./tracing') as typeof import('./tracing');
  const pre = await preBoot(loadEnv(), {
    onRetry: (attempt, reason) => writeJsonLine('warn', `RunConfig 조회 재시도 ${attempt}: ${reason}`, 'Bootstrap'),
  });
  const { bootstrap } = await import('./bootstrap.js');
  await bootstrap(pre);
}

main().catch((err: unknown) => {
  writeJsonLine('error', `[bootstrap] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, 'Bootstrap');
  process.exit(1);
});
