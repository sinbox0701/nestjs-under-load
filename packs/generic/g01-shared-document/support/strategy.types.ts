import type { EntityManager } from '@mikro-orm/postgresql';
import type { EventSink } from '@under-load/contracts';

import type { FieldVersions } from '../entities/document.entity';
import type { EditResult } from '../entities/edit-ledger.entity';

export type { EditResult, FieldVersions };

export type FieldName = 'a' | 'b' | 'c' | 'd';
export type DocumentFields = Record<FieldName, string[]>;

/** 컨트롤러가 strategy에 넘기는 저장 명령. HTTP 계약은 C10. 엔드포인트·DTO는 strategy와 무관하게 같다(DESIGN §3 원칙 6). */
export interface SaveCommand {
  /** k6가 보낸 `X-Request-Id`(uuid). 원장 유니크 키 */
  requestId: string;
  documentId: number;
  /** 클라이언트가 읽고 온 버전. 컨트롤러가 누락을 428로 거절하고 number로 변환해서 넘긴다. */
  version: number;
  /** PUT: 문서 전체. 클라이언트가 읽은 배열 뒤에 `editToken`을 붙인 값 */
  fields: DocumentFields;
  /** 12자 수정 토큰 */
  editToken: string;
  /** edit-lease 전용. 저장자가 들고 온 보유자·fence */
  lease?: { holder: string; fence: string };
}

/** field-merge(PATCH): 바뀐 필드 하나만 보낸다. */
export interface PatchCommand {
  requestId: string;
  documentId: number;
  version: number;
  field: FieldName;
  value: string[];
  editToken: string;
}

export interface LeaseCommand {
  documentId: number;
  holder: string;
  /** release 때만. acquire 시점엔 없다. */
  fence?: string;
}

/** 저장 결과. 실패는 예외가 아니라 값으로 돌려주고, 컨트롤러가 C10 응답 계약(409/423)으로 옮긴다. */
export type SaveOutcome =
  | { ok: true; version: number }
  | { ok: false; reason: 'version_mismatch'; currentVersion: number }
  | { ok: false; reason: 'lease_lost' | 'lease_expired' };

export type AcquireOutcome =
  | { ok: true; fence: string; leaseUntil: Date }
  | { ok: false; reason: 'locked'; lockedBy: string; retryAfterMs: number };

/**
 * 경합 창 지연 주입 지점 이름. RunConfig `injectDelay`에 같은 이름이 있을 때만 대기한다(DESIGN §6.3).
 * - `after-read`: 문서를 읽은 뒤 쓰기 전. 모든 strategy가 같은 위치에 둔다(공정 비교).
 * - `before-write`: 쓰기 문장 직전(원장·이력 INSERT 포함 트랜잭션 안).
 */
export type ContentionPoint = 'after-read' | 'before-write';

/** 성공한 수정의 원장·이력 기록 입력 */
export interface SuccessRecord {
  requestId: string;
  documentId: number;
  editToken: string;
  baseVersion: number;
  /** 저장 후 문서 버전 */
  version: number;
}

/**
 * 수정 원장·이력 기록기. **문서 변경과 같은 트랜잭션 안에서** 호출해야 한다(`em`은 트랜잭션의 em).
 * 구현은 `support/ledger.writer.ts`(후속 티켓)가 맡는다.
 */
export interface EditLedgerWriter {
  /** 원장 `success` 행과 `g01_document_revision` 행을 함께 INSERT */
  recordSuccess(em: EntityManager, rec: SuccessRecord): Promise<void>;
}

export interface StrategyContext<P = Record<string, unknown>> {
  /** 요청별 fork된 EntityManager. 트랜잭션 경계는 strategy가 직접 연다. */
  em: EntityManager;
  /** manifest params 스키마로 부팅 시 검증된 strategy 파라미터(예: edit-lease TTL) */
  params: P;
  /** 이 요청을 처리하는 app 인스턴스 이름(원장에 기록) */
  instance: string;
  /** 경합 창 지연 주입 훅. 설정이 없으면 즉시 반환한다. */
  contentionWindow(point: ContentionPoint): Promise<void>;
  ledger: EditLedgerWriter;
  /** C9. 컨트롤러가 `@Optional() @Inject(LAB_EVENT_SINK)`로 받고, 없으면 NOOP_EVENT_SINK를 넣는다. */
  events: EventSink;
}

/**
 * G01 처리 방식 하나. 1파일 1strategy(`strategies/*.strategy.ts`).
 * `blind-retry`는 서버 구현이 `optimistic-version`과 같고 클라이언트(k6) 동작만 다르다(C10).
 */
export interface G01Strategy<P = Record<string, unknown>> {
  readonly id: string;
  save(cmd: SaveCommand, ctx: StrategyContext<P>): Promise<SaveOutcome>;
  /** field-merge만 구현한다. */
  patch?(cmd: PatchCommand, ctx: StrategyContext<P>): Promise<SaveOutcome>;
  /** edit-lease만 구현한다. */
  acquire?(cmd: LeaseCommand, ctx: StrategyContext<P>): Promise<AcquireOutcome>;
  release?(cmd: LeaseCommand, ctx: StrategyContext<P>): Promise<void>;
}
