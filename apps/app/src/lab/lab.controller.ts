import { Controller, Get, Inject, Optional, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';

import type { RunConfig } from '../config/run-config';

export const LAB_STATE = Symbol('LAB_STATE');

export interface LabState {
  instance: string;
  runConfig: RunConfig | null;
  bootedAt: string;
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
  async ready(): Promise<{ instance: string; runId: string; scenario: string; strategy: string; bootedAt: string }> {
    const rc = this.state.runConfig;
    if (!rc) throw new ServiceUnavailableException(`instance ${this.state.instance}: RunConfig 없음(대기 모드)`);
    const db = this.orm ? await this.orm.checkConnection() : { ok: false, reason: 'ORM 없음' };
    if (!db.ok) throw new ServiceUnavailableException(`instance ${this.state.instance}: DB 연결 실패 (${db.reason})`);
    return {
      instance: this.state.instance,
      runId: rc.runId,
      scenario: rc.scenario,
      strategy: rc.strategy,
      bootedAt: this.state.bootedAt,
    };
  }
}
