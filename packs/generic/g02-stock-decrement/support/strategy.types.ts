import type { EntityManager } from '@mikro-orm/postgresql';
import type { EventSink } from '@under-load/contracts';

import type { OrderResult } from '../entities/order-ledger.entity';
import type { LedgerWriter } from './ledger.writer';

export type { OrderResult };

/** 컨트롤러가 strategy에 넘기는 명령. 엔드포인트·DTO는 strategy와 무관하게 같다(DESIGN §3 원칙 6). */
export interface OrderCommand {
  /** k6가 보낸 `X-Request-Id`(uuid). 원장 유니크 키 */
  requestId: string;
  productId: number;
  qty: number;
}

/**
 * 경합 창 지연 주입 지점 이름. RunConfig `injectDelay`에 같은 이름이 있을 때만 대기한다(DESIGN §6.3).
 * - `after-read`: 읽기 후 쓰기 전. **모든 strategy가 같은 위치에 둔다**(공정 비교). 읽기가 없는 strategy(conditional-update)는
 *   트랜잭션 안 첫 쓰기 문장 바로 앞에 둔다. 락을 쥔 상태인지는 strategy마다 다르고, 그 차이가 비교 대상이다.
 * - `after-lock`: row-lock 전용. 행 잠금을 얻은 직후(잠금 안 작업 시간 흉내).
 */
export type ContentionPoint = 'after-read' | 'before-write' | 'after-lock';

export interface StrategyContext<P = Record<string, unknown>> {
  /** 요청별 fork된 EntityManager. 트랜잭션 경계는 strategy가 직접 연다. */
  em: EntityManager;
  /** manifest params 스키마로 부팅 시 검증된 strategy 파라미터 */
  params: P;
  /** 이 요청을 처리하는 app 인스턴스 이름(원장에 기록) */
  instance: string;
  /** 경합 창 지연 주입 훅. 설정이 없으면 즉시 반환한다. 주입 여부는 메타데이터 `interventions`에 남는다. */
  contentionWindow(point: ContentionPoint): Promise<void>;
  /** 원장 기록기. **재고 변경과 같은 트랜잭션 안에서** 호출해야 한다. */
  ledger: LedgerWriter;
  /** 이벤트 출구(C9). 켜져 있지 않으면 noop 이라 그냥 호출해도 된다. */
  events: EventSink;
}

/**
 * G02 처리 방식 하나. 1파일 1strategy(`strategies/*.strategy.ts`).
 *
 * 계약:
 * - 성공이면 재고를 `qty`만큼 줄이고 원장에 `success`를 같은 트랜잭션으로 남긴 뒤 `'success'`.
 * - 재고가 모자라면 재고는 그대로, 원장에 `sold_out`을 남기고 `'sold_out'`.
 * - 그 밖의 실패(락 타임아웃 등)는 예외를 던진다 → 트랜잭션 롤백, 원장에 남지 않음, HTTP 5xx.
 */
export interface G02Strategy<P = Record<string, unknown>> {
  readonly id: string;
  execute(cmd: OrderCommand, ctx: StrategyContext<P>): Promise<OrderResult>;
}
