import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

import { NO_ACTOR } from '@under-load/contracts';

/** 요청 하나의 컨텍스트(C9: sink 가 AsyncLocalStorage 에서 읽는다). */
export interface RequestContext {
  /** X-Lab-Actor, 없으면 `-` */
  actor: string;
  /** X-Request-Id, 없으면 app 이 만든다 */
  reqId: string;
  /** traceparent 의 trace-id(32 hex). 없거나 형식이 틀리면 undefined */
  traceId?: string;
  /** 대표 표본 여부 = traceparent 플래그의 sampled 비트. OTel 이 꺼져 있어도 헤더를 직접 파싱한다 */
  sampled: boolean;
}

const als = new AsyncLocalStorage<RequestContext>();

/** W3C traceparent: `00-<trace-id 32hex>-<parent-id 16hex>-<flags 2hex>` (version ff 는 무효). */
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;

export function parseTraceparent(header: string | undefined): { traceId: string; sampled: boolean } | null {
  if (!header) return null;
  const m = TRACEPARENT_RE.exec(header.trim().toLowerCase());
  if (!m || m[1] === 'ff') return null;
  const traceId = m[2];
  if (/^0+$/.test(traceId) || /^0+$/.test(m[3])) return null;
  return { traceId, sampled: (parseInt(m[4], 16) & 1) === 1 };
}

type HeaderValue = string | string[] | undefined;
const first = (v: HeaderValue): string | undefined => (Array.isArray(v) ? v[0] : v);

/** 요청 헤더에서 컨텍스트를 만든다. 헤더 키는 소문자(Node 규칙). */
export function contextFromHeaders(headers: Record<string, HeaderValue>): RequestContext {
  const tp = parseTraceparent(first(headers['traceparent']));
  const actor = first(headers['x-lab-actor'])?.trim();
  const reqId = first(headers['x-request-id'])?.trim();
  return {
    actor: actor || NO_ACTOR,
    reqId: reqId || `r_${randomBytes(4).toString('hex')}`,
    ...(tp ? { traceId: tp.traceId } : {}),
    sampled: tp?.sampled ?? false,
  };
}

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** 요청 밖(부팅·백그라운드)이면 undefined. */
export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}
