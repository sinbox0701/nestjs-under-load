import { z } from 'zod';

/**
 * C4 이벤트 프로토콜 v0 · C9 팩 쪽 EventSink 계약.
 * 정본: docs/CONTRACTS-phase1.md, phase 목록은 DESIGN §9.1.
 */

// ─────────────────────────────── phase ───────────────────────────────

/** DESIGN §9.1 공통 phase 23개(문서 순서). web/src/events/types.ts COMMON_PHASES 와 같다. */
export const COMMON_PHASES = [
  'arrived',
  'rejected',
  'lock_wait',
  'lock_acquired',
  'lock_released',
  'lock_timeout',
  'conflict',
  'retry',
  'db_read',
  'db_write',
  'committed',
  'rolled_back',
  'failed',
  'responded',
  'enqueued',
  'dequeued',
  'lease_expired',
  'published',
  'consumed',
  'cache_hit',
  'cache_miss',
  'injected_delay',
  'sql',
] as const;
export type CommonPhase = (typeof COMMON_PHASES)[number];
export type CustomPhase = `custom:${string}`;
export type Phase = CommonPhase | CustomPhase;

/** 시나리오 확장 phase. web ndjson.ts 와 같은 규칙. */
export const CUSTOM_PHASE_RE = /^custom:[\w-]+$/;
const COMMON_SET: ReadonlySet<string> = new Set(COMMON_PHASES);
export const isPhase = (p: unknown): p is Phase =>
  typeof p === 'string' && (COMMON_SET.has(p) || CUSTOM_PHASE_RE.test(p));

/** 공통 23개 또는 `custom:<name>`. 키로도 쓰므로 단일 정규식으로 만든다. */
export const PHASE_RE = new RegExp(`^(?:${COMMON_PHASES.join('|')}|custom:[\\w-]+)$`);
export const PhaseSchema = z.string().regex(PHASE_RE) as unknown as z.ZodType<Phase, string>;

// ─────────────────────────────── WireEventV0 ───────────────────────────────

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
/** 평면 스칼라 맵. */
export const EventAttrsSchema = z.record(z.string(), scalar);
export type EventAttrs = z.infer<typeof EventAttrsSchema>;

export const EntityRefSchema = z.strictObject({ type: z.string().min(1), id: z.string() });
export type EntityRef = z.infer<typeof EntityRefSchema>;

/** 표본 판정 기본값: k6 `__VU <= REP_ACTORS` 이면 traceparent 플래그 01. */
export const DEFAULT_REP_ACTORS = 8;
/** X-Lab-Actor 가 없을 때의 actor 값. */
export const NO_ACTOR = '-';

/**
 * 이벤트 한 줄(v0). 모르는 키는 거절한다(`codeRef` 는 v0 에서 보내지 않는다).
 * attrs 를 보낼 때는 `strategy` 를 포함한다.
 */
export const WireEventV0Schema = z
  .strictObject({
    v: z.literal(0),
    runId: z.string().min(1),
    /** epoch µs 정수 */
    ts: z.number().int().min(0),
    /** 인스턴스별 0부터 단조 증가 */
    seq: z.number().int().min(0),
    instance: z.string().min(1),
    /** X-Lab-Actor, 없으면 "-" */
    actor: z.string().min(1),
    phase: PhaseSchema,
    reqId: z.string().min(1).optional(),
    traceId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
    entity: EntityRefSchema.optional(),
    durMs: z.number().min(0).nullable().optional(),
    attrs: EventAttrsSchema.optional(),
    sampled: z.boolean().optional(),
    injected: z.boolean().optional(),
    /** 마스킹된 SQL */
    sql: z.string().optional(),
    rows: z.number().int().min(0).optional(),
    note: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.attrs && typeof e.attrs.strategy !== 'string') {
      ctx.addIssue({ code: 'custom', path: ['attrs', 'strategy'], message: 'attrs 에는 strategy(문자열)가 있어야 한다' });
    }
  });
export type WireEventV0 = z.infer<typeof WireEventV0Schema>;

export interface NdjsonLineError {
  /** 1부터 */
  line: number;
  reason: string;
}

/** NDJSON → 유효한 WireEventV0 와 줄별 오류. 빈 줄은 건너뛰고, 던지지 않는다. */
export function parseEventsNdjson(text: string): { events: WireEventV0[]; errors: NdjsonLineError[] } {
  const events: WireEventV0[] = [];
  const errors: NdjsonLineError[] = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    const s = line.trim();
    if (!s) return;
    let raw: unknown;
    try {
      raw = JSON.parse(s);
    } catch {
      errors.push({ line: idx + 1, reason: 'JSON 아님' });
      return;
    }
    const r = WireEventV0Schema.safeParse(raw);
    if (r.success) events.push(r.data);
    else errors.push({ line: idx + 1, reason: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') });
  });
  return { events, errors };
}

// ─────────────────────────────── AggWindow · IngestBatch ───────────────────────────────

export const AGG_WINDOW_MS = 1000;

/** 1초 창 phase 별 카운트(별도 agg.ndjson, web ndjson.ts 는 읽지 않음). */
export const AggWindowSchema = z.strictObject({
  v: z.literal(0),
  runId: z.string().min(1),
  instance: z.string().min(1),
  /** epoch ms */
  windowStart: z.number().int().min(0),
  windowMs: z.literal(AGG_WINDOW_MS),
  counts: z.record(z.string().regex(PHASE_RE), z.number().int().min(0)) as unknown as z.ZodType<
    Partial<Record<Phase, number>>,
    Record<string, number>
  >,
  /** 누적 */
  dropped: z.number().int().min(0),
});
export type AggWindow = z.infer<typeof AggWindowSchema>;

export const PoolStatsSchema = z.strictObject({
  total: z.number().int().min(0),
  idle: z.number().int().min(0),
  waiting: z.number().int().min(0),
});
export type PoolStats = z.infer<typeof PoolStatsSchema>;

/** `POST /ingest/events` 본문 최대 크기(1 MiB). */
export const INGEST_MAX_BYTES = 1024 * 1024;

/** `POST /ingest/events` 요청 본문. 응답 204 · runId 가 현재 실행과 다르면 409. */
export const IngestBatchSchema = z
  .strictObject({
    v: z.literal(0),
    runId: z.string().min(1),
    instance: z.string().min(1),
    /** epoch ms */
    sentAt: z.number().int().min(0),
    /** 누적 */
    dropped: z.number().int().min(0),
    events: z.array(WireEventV0Schema),
    agg: z.array(AggWindowSchema),
    pool: PoolStatsSchema.optional(),
  })
  .superRefine((b, ctx) => {
    const check = (list: readonly { runId: string; instance: string }[], key: 'events' | 'agg') =>
      list.forEach((x, i) => {
        if (x.runId !== b.runId) ctx.addIssue({ code: 'custom', path: [key, i, 'runId'], message: '배치 runId 와 다르다' });
        if (x.instance !== b.instance) ctx.addIssue({ code: 'custom', path: [key, i, 'instance'], message: '배치 instance 와 다르다' });
      });
    check(b.events, 'events');
    check(b.agg, 'agg');
  });
export type IngestBatch = z.infer<typeof IngestBatchSchema>;

// ─────────────────────────────── C9 EventSink ───────────────────────────────

/** 문자열 DI 토큰. 컨트롤러는 `@Optional() @Inject(LAB_EVENT_SINK)` 로 받고, 없으면 NOOP_EVENT_SINK 를 쓴다. */
export const LAB_EVENT_SINK = 'LAB_EVENT_SINK' as const;

export interface EventFields {
  entity?: EntityRef;
  attrs?: EventAttrs;
  durMs?: number;
  injected?: boolean;
  sql?: string;
  rows?: number;
  note?: string;
}

/** 팩이 보는 이벤트 출구. 요청 정보(actor/reqId/sampled/traceId)는 sink 가 AsyncLocalStorage 에서 읽는다. */
export interface EventSink {
  readonly enabled: boolean;
  emit(phase: Phase, fields?: EventFields): void;
}

export const NOOP_EVENT_SINK: EventSink = Object.freeze({
  enabled: false,
  emit(): void {},
});
