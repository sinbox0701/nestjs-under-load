import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { loadRunConfig } from './config/run-config';
import { loadPack } from './packs/registry';

export async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const env = loadEnv();
  const runConfig = loadRunConfig(env.RUN_CONFIG_PATH);
  const pack = runConfig ? await loadPack(runConfig.scenario) : null;

  if (runConfig) {
    logger.log(
      `RunConfig: run=${runConfig.runId} scenario=${runConfig.scenario} strategy=${runConfig.strategy} instance=${env.INSTANCE_NAME}`,
    );
  } else {
    logger.warn(`RunConfig 없음(${env.RUN_CONFIG_PATH}) → 대기 모드(/_lab만 응답)`);
  }

  const app = await NestFactory.create(AppModule.register(env, runConfig, pack), { bufferLogs: false });
  // SIGTERM → onApplicationShutdown → ORM 연결 종료. 그레이스풀 드레인은 5단계(G24).
  app.enableShutdownHooks();
  await app.listen(env.PORT, '0.0.0.0');
  logger.log(`listening on :${env.PORT}`);
}
