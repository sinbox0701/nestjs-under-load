import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Res,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import { Product } from '../entities/product.entity';
import { LedgerWriter } from '../support/ledger.writer';
import type { ContentionPoint, G02Strategy } from '../support/strategy.types';
import { G02_RUNTIME, G02_STRATEGY, G02_STRATEGY_PARAMS } from '../support/tokens';
import { orderCreateSchema, requestIdSchema } from './order.dto';

export interface G02Runtime {
  instance: string;
  contentionWindow(point: ContentionPoint): Promise<void>;
}

/**
 * 컨트롤러는 입력 검증과 strategy 위임만 한다. 처리 방식은 부팅 시 RunConfig로 주입된 strategy가 정한다.
 * 응답: 성공 201 `{ result: 'success' }`, 품절 409 `{ result: 'sold_out' }`, 그 밖의 실패 5xx(원장에 남지 않음).
 */
@Controller('g02')
export class G02Controller {
  private readonly ledger: LedgerWriter;

  constructor(
    private readonly em: EntityManager,
    @Inject(G02_STRATEGY) private readonly strategy: G02Strategy,
    @Inject(G02_STRATEGY_PARAMS) private readonly params: Record<string, unknown>,
    @Inject(G02_RUNTIME) private readonly runtime: G02Runtime,
  ) {
    this.ledger = new LedgerWriter(runtime.instance);
  }

  @Post('orders')
  @HttpCode(201)
  async createOrder(
    @Headers('x-request-id') rawRequestId: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: { status(code: number): unknown },
  ): Promise<{ result: string; requestId: string }> {
    const requestId = requestIdSchema.safeParse(rawRequestId);
    if (!requestId.success) throw new BadRequestException('X-Request-Id 헤더(uuid)가 필요합니다.');
    const dto = orderCreateSchema.safeParse(body);
    if (!dto.success) throw new BadRequestException(dto.error.message);

    const result = await this.strategy.execute(
      { requestId: requestId.data, productId: dto.data.productId, qty: dto.data.qty },
      {
        em: this.em.fork(),
        params: this.params,
        instance: this.runtime.instance,
        contentionWindow: this.runtime.contentionWindow,
        ledger: this.ledger,
      },
    );
    if (result === 'sold_out') res.status(409);
    return { result, requestId: requestId.data };
  }

  @Get('products/:id/stock')
  async getStock(@Param('id', ParseIntPipe) id: number): Promise<{ id: number; stock: number }> {
    const product = await this.em.fork().findOne(Product, id);
    if (!product) throw new NotFoundException(`product ${id} not found`);
    return { id: product.id, stock: product.stock };
  }
}
