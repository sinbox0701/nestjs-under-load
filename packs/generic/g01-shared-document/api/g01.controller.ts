import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  MethodNotAllowedException,
  NotFoundException,
  Optional,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import { NotFoundError } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { type EventSink, LAB_EVENT_SINK, NOOP_EVENT_SINK } from '@under-load/contracts';

import { LedgerWriter } from '../support/ledger.writer';
import type {
  ContentionPoint,
  DocumentFields,
  G01Strategy,
  SaveOutcome,
  StrategyContext,
} from '../support/strategy.types';
import { leaseAcquireSchema, leaseReleaseSchema, patchSchema, putSchema, requestIdSchema } from './document.dto';
import { G01_RUNTIME, G01_STRATEGY, G01_STRATEGY_PARAMS } from './tokens';

export interface G01Runtime {
  instance: string;
  contentionWindow(point: ContentionPoint): Promise<{ injected: boolean; durMs: number } | void>;
}

/** 응답 객체의 필요한 부분만(express·테스트 가짜 모두 맞는다). */
export interface ResponseLike {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

/** C10 GET 응답. 409 `version_mismatch` 본문의 `current`도 같은 모양이다. */
export interface DocumentView {
  id: number;
  version: number;
  fields: DocumentFields;
  fieldVersions: { a: number; b: number; c: number; d: number };
  editCount: number;
  lease: { lockedBy: string; leaseUntil: Date; fence: string } | null;
}

/**
 * 컨트롤러는 입력 검증과 strategy 위임, 결과 → HTTP 응답 변환만 한다(DESIGN §3 원칙 6).
 * 엔드포인트·DTO는 strategy와 무관하게 같고, strategy가 지원하지 않는 연산(PATCH·lease)은 405로 거절한다.
 * 응답(C10): 성공 200, 버전 누락 428 `version_required`, 불일치 409 `version_mismatch`(currentVersion·current),
 * lease 저장 실패 409 `lease_lost|lease_expired`, acquire 거절 423 `locked` + `Retry-After`.
 */
@Controller('g01/documents')
export class G01Controller {
  private readonly ledger: LedgerWriter;
  private readonly events: EventSink;

  constructor(
    private readonly em: EntityManager,
    @Inject(G01_STRATEGY) private readonly strategy: G01Strategy<any>,
    @Inject(G01_STRATEGY_PARAMS) private readonly params: Record<string, unknown>,
    @Inject(G01_RUNTIME) private readonly runtime: G01Runtime,
    @Optional() @Inject(LAB_EVENT_SINK) events?: EventSink,
  ) {
    this.events = events ?? NOOP_EVENT_SINK;
    this.ledger = new LedgerWriter(runtime.instance);
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number): Promise<DocumentView> {
    const view = await this.readView(id);
    if (!view) throw new NotFoundException(`document ${id} not found`);
    return view;
  }

  @Put(':id')
  @HttpCode(200)
  async put(
    @Param('id', ParseIntPipe) id: number,
    @Headers('x-request-id') rawRequestId: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: ResponseLike,
  ): Promise<unknown> {
    if (this.requireVersion(body, res)) return { reason: 'version_required' };
    const requestId = this.parseRequestId(rawRequestId);
    const dto = putSchema.safeParse(body);
    if (!dto.success) throw new BadRequestException(dto.error.message);
    const outcome = await this.guard(id, () =>
      this.strategy.save(
        {
          requestId,
          documentId: id,
          version: dto.data.version,
          fields: dto.data.fields,
          editToken: dto.data.editToken,
          lease: dto.data.lease,
        },
        this.ctx(),
      ),
    );
    return this.toResponse(id, outcome, res);
  }

  @Patch(':id')
  @HttpCode(200)
  async patch(
    @Param('id', ParseIntPipe) id: number,
    @Headers('x-request-id') rawRequestId: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: ResponseLike,
  ): Promise<unknown> {
    const patch = this.strategy.patch;
    if (!patch) throw new MethodNotAllowedException({ reason: 'not_supported', operation: 'patch', strategy: this.strategy.id });
    if (this.requireVersion(body, res)) return { reason: 'version_required' };
    const requestId = this.parseRequestId(rawRequestId);
    const dto = patchSchema.safeParse(body);
    if (!dto.success) throw new BadRequestException(dto.error.message);
    const outcome = await this.guard(id, () =>
      patch.call(
        this.strategy,
        {
          requestId,
          documentId: id,
          version: dto.data.version,
          field: dto.data.field,
          value: dto.data.value,
          editToken: dto.data.editToken,
        },
        this.ctx(),
      ),
    );
    return this.toResponse(id, outcome, res);
  }

  @Post(':id/lease')
  @HttpCode(200)
  async acquire(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: ResponseLike,
  ): Promise<unknown> {
    const acquire = this.strategy.acquire;
    if (!acquire) throw new MethodNotAllowedException({ reason: 'not_supported', operation: 'lease', strategy: this.strategy.id });
    const dto = leaseAcquireSchema.safeParse(body);
    if (!dto.success) throw new BadRequestException(dto.error.message);
    const outcome = await this.guard(id, () => acquire.call(this.strategy, { documentId: id, holder: dto.data.holder }, this.ctx()));
    if (outcome.ok) return { fence: outcome.fence, leaseUntil: outcome.leaseUntil };
    res.status(423);
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(outcome.retryAfterMs / 1000))));
    return { reason: 'locked', lockedBy: outcome.lockedBy, retryAfterMs: outcome.retryAfterMs };
  }

  @Delete(':id/lease')
  @HttpCode(204)
  async release(@Param('id', ParseIntPipe) id: number, @Body() body: unknown): Promise<void> {
    const release = this.strategy.release;
    if (!release) throw new MethodNotAllowedException({ reason: 'not_supported', operation: 'lease', strategy: this.strategy.id });
    const dto = leaseReleaseSchema.safeParse(body);
    if (!dto.success) throw new BadRequestException(dto.error.message);
    await this.guard(id, () => release.call(this.strategy, { documentId: id, holder: dto.data.holder, fence: dto.data.fence }, this.ctx()));
  }

  /** 본문에 version이 없으면 428을 세팅하고 true. 호출부가 `{reason:'version_required'}`를 돌려준다. */
  private requireVersion(body: unknown, res: ResponseLike): boolean {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadRequestException('JSON 객체 본문이 필요합니다.');
    const v = (body as Record<string, unknown>).version;
    if (v !== undefined && v !== null) return false;
    res.status(428);
    return true;
  }

  private parseRequestId(raw: string | undefined): string {
    const parsed = requestIdSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('X-Request-Id 헤더(uuid)가 필요합니다.');
    return parsed.data;
  }

  private ctx(): StrategyContext<any> {
    return {
      em: this.em.fork(),
      params: this.params,
      instance: this.runtime.instance,
      contentionWindow: this.runtime.contentionWindow,
      ledger: this.ledger,
      events: this.events,
    };
  }

  /** 없는 문서는 strategy 안의 `findOneOrFail`이 던진다 → 404 */
  private async guard<T>(id: number, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof NotFoundError) throw new NotFoundException(`document ${id} not found`);
      throw err;
    }
  }

  private async toResponse(id: number, outcome: SaveOutcome, res: ResponseLike): Promise<unknown> {
    if (outcome.ok) return { version: outcome.version };
    res.status(409);
    if (outcome.reason !== 'version_mismatch') return { reason: outcome.reason };
    // current는 strategy가 아니라 여기서 재조회해 채운다(strategy 간 같은 모양).
    const current = await this.readView(id);
    return { reason: 'version_mismatch', currentVersion: outcome.currentVersion, current };
  }

  private async readView(id: number): Promise<DocumentView | null> {
    const rows = await this.em.fork().execute(
      `select id, version, field_a, field_b, field_c, field_d, field_versions, edit_count,
              locked_by, lease_until, fence::text as fence,
              (locked_by is not null and lease_until is not null and lease_until > clock_timestamp()) as lease_active
       from g01_document where id = ?`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      version: r.version,
      fields: { a: r.field_a, b: r.field_b, c: r.field_c, d: r.field_d },
      fieldVersions: r.field_versions,
      editCount: r.edit_count,
      // 만료된 lease는 보이지 않는다(만료 판정은 DB 시계).
      lease: r.lease_active ? { lockedBy: r.locked_by, leaseUntil: r.lease_until, fence: r.fence } : null,
    };
  }
}
