import { Controller, Get, Inject, Optional, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';

import type { ReadyResponse } from '@under-load/contracts';

import type { RunConfig } from '../config/run-config';

export const LAB_STATE = Symbol('LAB_STATE');

export interface LabState {
  instance: string;
  runConfig: RunConfig | null;
  bootedAt: string;
  /** task=prepare-template 이면 마이그레이션·시드가 끝난 뒤 bootstrap 이 채운다. 채워지기 전에는 ready 가 503. */
  prepared?: { database: string; durationMs: number };
}

/**
 * 관리 엔드포인트(DESIGN §4.3 lab-admin). run.mjs가 ready 응답의 runId·instance로
 * "모든 인스턴스가 새 RunConfig로 부팅했는지"를 확인한다.
 */
@Controller('_lab')
export class LabController {
  constructor(
    @Inject(LAB_STATE) private readonly state: LabState,
    @Optional() private readonly orm?: MikroORM,
  ) {}

  @Get('health')
  health(): { ok: true; instance: string } {
    return { ok: true, instance: this.state.instance };
  }

  @Get('ready')
  async ready(): Promise<ReadyResponse> {
    const rc = this.state.runConfig;
    if (!rc) throw new ServiceUnavailableException(`instance ${this.state.instance}: RunConfig 없음(대기 모드)`);
    const db = this.orm ? await this.orm.checkConnection() : { ok: false, reason: 'ORM 없음' };
    if (!db.ok) throw new ServiceUnavailableException(`instance ${this.state.instance}: DB 연결 실패 (${db.reason})`);
    if (rc.task === 'prepare-template' && !this.state.prepared) {
      throw new ServiceUnavailableException(`instance ${this.state.instance}: 템플릿 준비 중`);
    }
    return {
      instance: this.state.instance,
      runId: rc.runId,
      task: rc.task,
      scenario: rc.scenario,
      strategy: rc.strategy,
      instrumentation: rc.instrumentation,
      bootedAt: this.state.bootedAt,
      ...(this.state.prepared ? { prepared: this.state.prepared } : {}),
    };
  }
}
