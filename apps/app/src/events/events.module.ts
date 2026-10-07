import { Global, Module } from '@nestjs/common';
import { LAB_EVENT_SINK, NOOP_EVENT_SINK } from '@under-load/contracts';

/**
 * 이벤트 sink 주입점(C9). 지금은 아무것도 내보내지 않는 noop 을 전역으로 제공한다.
 * 실제 방출기는 이 provider 를 교체하는 식으로 붙는다. 팩 컨트롤러는 `@Optional()` 로 받는다.
 */
@Global()
@Module({
  providers: [{ provide: LAB_EVENT_SINK, useValue: NOOP_EVENT_SINK }],
  exports: [LAB_EVENT_SINK],
})
export class EventsModule {}
