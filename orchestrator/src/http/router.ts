// node:http 용 최소 라우터. 모듈 티켓은 `router.add(method, path, handler)` 로만 라우트를 등록한다.
//   router.add('GET', '/runs/:id', async (ctx) => ctx.json(200, { id: ctx.params.id }));
// 경로 매개변수는 `:name`(한 세그먼트). 와일드카드·정규식 없음. 같은 (method, path) 중복 등록은 오류.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ListenerKind = 'public' | 'internal';

/** 핸들러에서 던지면 그 상태 코드와 JSON 본문으로 응답한다. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown = { error: 'error' },
  ) {
    super(typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${status}`);
    this.name = 'HttpError';
  }
}

export interface HttpContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly listener: ListenerKind;
  readonly method: HttpMethod;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  /** JSON 응답. */
  json(status: number, body: unknown): void;
  /** 본문 없는 응답(204 등). */
  empty(status: number): void;
  /** 문자열·Buffer 응답. */
  send(status: number, body: string | Buffer, contentType: string): void;
  /** 요청 본문을 Buffer 로 읽는다. maxBytes 초과면 413 HttpError. */
  readBody(maxBytes?: number): Promise<Buffer>;
  /** 요청 본문을 JSON 으로 읽는다. 비었거나 깨졌으면 400 HttpError. */
  readJson(maxBytes?: number): Promise<unknown>;
}

export type Handler = (ctx: HttpContext) => void | Promise<void>;

/** WS 업그레이드 핸들러(ws 서버의 handleUpgrade 를 부른다). */
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, params: Readonly<Record<string, string>>) => void | Promise<void>;

export const DEFAULT_BODY_LIMIT = 1024 * 1024;

interface Route<H> {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: H;
}

type Match<H> = { kind: 'ok'; handler: H; params: Record<string, string> } | { kind: 'method'; allow: string[] } | { kind: 'none' };

/** 공개 리스너에 둘 수 없는 경로 접두(계약 C2: 내부 포트 전용). */
export const INTERNAL_ONLY_PREFIXES = ['/internal/', '/ingest/'] as const;
const isInternalOnly = (p: string) => INTERNAL_ONLY_PREFIXES.some((x) => p.startsWith(x));
const split = (p: string) => p.split('/').filter(Boolean);

function find<H>(routes: readonly Route<H>[], method: string, path: string): Match<H> {
  const parts = split(path);
  const allow = new Set<string>();
  for (const r of routes) {
    if (r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length && ok; i++) {
      const seg = r.segments[i]!;
      if (seg.startsWith(':')) {
        try {
          params[seg.slice(1)] = decodeURIComponent(parts[i]!);
        } catch {
          ok = false;
        }
      } else ok = seg === parts[i];
    }
    if (!ok) continue;
    if (r.method === method) return { kind: 'ok', handler: r.handler, params };
    allow.add(r.method);
  }
  return allow.size ? { kind: 'method', allow: [...allow] } : { kind: 'none' };
}

export class Router {
  private readonly routes: Route<Handler>[] = [];
  private readonly upgrades: Route<UpgradeHandler>[] = [];

  constructor(readonly kind: ListenerKind) {}

  private check(method: string, path: string) {
    if (!path.startsWith('/')) throw new Error(`라우트 경로는 '/' 로 시작해야 한다: ${path}`);
    const internal = isInternalOnly(path);
    if (this.kind === 'public' && internal) throw new Error(`공개 리스너에는 ${INTERNAL_ONLY_PREFIXES.join('·')} 라우트를 등록할 수 없다: ${method} ${path}`);
    if (this.kind === 'internal' && !internal && path !== '/health' && path !== '/metrics')
      throw new Error(`내부 리스너에는 /internal/*·/ingest/*·/health·/metrics 만 등록할 수 있다: ${method} ${path}`);
  }

  /** 라우트 등록. 공개/내부 리스너 규칙을 어기거나 중복이면 즉시 throw 한다(부팅 시점에 드러난다). */
  add(method: HttpMethod, path: string, handler: Handler): this {
    this.check(method, path);
    const segments = split(path);
    const shape = (segs: readonly string[]) => segs.map((x) => (x.startsWith(':') ? ':' : x)).join('/');
    if (this.routes.some((r) => r.method === method && shape(r.segments) === shape(segments)))
      throw new Error(`이미 등록된 라우트: ${method} ${path}`);
    this.routes.push({ method, segments, handler });
    return this;
  }

  /** WS 업그레이드 경로 등록(예: '/ws/runs/:runId'). 공개 리스너 전용 관례지만 규칙은 add 와 같다. */
  addUpgrade(path: string, handler: UpgradeHandler): this {
    this.check('UPGRADE', path);
    this.upgrades.push({ method: 'UPGRADE', segments: split(path), handler });
    return this;
  }

  match(method: string, path: string): Match<Handler> {
    return find(this.routes, method, path);
  }

  matchUpgrade(path: string): Match<UpgradeHandler> {
    return find(this.upgrades, 'UPGRADE', path);
  }

  /** 등록된 'METHOD /path' 목록(테스트·디버그). */
  list(): string[] {
    return this.routes.map((r) => `${r.method} /${r.segments.join('/')}`);
  }
}

/** 두 리스너용 라우터 한 쌍. 배선(T-138)이 만들어 각 모듈의 register 함수에 넘긴다. */
export interface Routers {
  readonly public: Router;
  readonly internal: Router;
}

export const createRouters = (): Routers => ({ public: new Router('public'), internal: new Router('internal') });
