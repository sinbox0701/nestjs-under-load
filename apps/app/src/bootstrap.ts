import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';

import type { Server } from 'node:http';

import { AppModule } from './app.module';
import { LAB_STATE, type LabState } from './lab/lab.controller';
import { LabJsonLogger } from './logging';
import { loadPack } from './packs/registry';
import { prepareTemplate } from './prepare/prepare-template';
import type { PreBoot } from './tracing';

/**
 * main.ts 의 preBoot 결과(env·RunConfig)로 부팅한다. RunConfig 는 여기서 다시 조회하지 않는다.
 */
export async function bootstrap({ env, runConfig, tracing }: PreBoot): Promise<void> {
  // 첫 줄부터 JSON(+trace_id). NestFactory 에 logger 를 따로 넘기지 않으므로 이 설정이 유지된다.
  Logger.overrideLogger(new LabJsonLogger());
  const logger = new Logger('Bootstrap');
  const pack = runConfig ? await loadPack(runConfig.scenario) : null;

  if (runConfig) {
    logger.log(
      `RunConfig: run=${runConfig.runId} scenario=${runConfig.scenario} strategy=${runConfig.strategy} instrumentation=${runConfig.instrumentation} tracing=${tracing ? 'on' : 'off'} instance=${env.INSTANCE_NAME}`,
    );
  } else {
    logger.warn(`RunConfig 없음(${env.ORCHESTRATOR_URL ?? env.RUN_CONFIG_PATH}) → 대기 모드(/_lab만 응답)`);
  }

  // task=prepare-template: 서비스용 ORM 도 템플릿 DB 를 바라보게 하고(ready 의 DB 확인), 마이그레이션·시드를 먼저 끝낸다.
  const prepare = runConfig?.task === 'prepare-template' ? runConfig.prepareTemplate : undefined;
  const appEnv = prepare ? { ...env, POSTGRES_DB: prepare.database } : env;
  const prepared = prepare && pack ? await prepareTemplate(env, pack, prepare) : undefined;
  if (prepared) logger.log(`템플릿 준비 완료: ${prepared.database} (${prepared.durationMs}ms)`);

  const app = await NestFactory.create(AppModule.register(appEnv, runConfig, pack), { bufferLogs: false });
  // SIGTERM → onApplicationShutdown → ORM 연결 종료. 그레이스풀 드레인은 5단계(G24).
  app.enableShutdownHooks();
  // RunConfig.timeouts.serverRequestMs(C1) → Node HTTP 서버 requestTimeout(요청 전체 수신 제한, 넘으면 408). null 이면 Node 기본값.
  const serverRequestMs = runConfig?.timeouts.serverRequestMs;
  if (serverRequestMs != null) (app.getHttpServer() as Server).requestTimeout = serverRequestMs;
  if (prepared) app.get<LabState>(LAB_STATE).prepared = prepared;
  if (runConfig) {
    // MikroORM 7의 init()은 접속하지 않는다(첫 쿼리 때 지연 생성). 그 상태의 checkConnection()은 시도 없이
    // 'Connection not established'를 돌려주므로 /_lab/ready가 계속 503이 된다. 리스닝 전에 명시적으로 접속한다.
    await app.get(MikroORM).connect();
  }
  await app.listen(env.PORT, '0.0.0.0');
  logger.log(`listening on :${env.PORT}`);
}
