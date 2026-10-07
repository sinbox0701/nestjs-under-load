import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';

import { requestContextMiddleware } from './request-context.middleware';

/** 모든 라우트에 요청 컨텍스트(ALS)를 건다. AppModule 이 import 한다. */
@Module({})
export class RequestContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestContextMiddleware).forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
