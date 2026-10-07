// 공개(4000)·내부(4001) 두 node:http 리스너. 라우트 매칭·가드·오류 응답·JSON 헬퍼를 맡는다.
// 공개 리스너만 Host·Origin 가드를 건다(내부는 lab-net 에만 붙어 호스트 포트가 없다).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { checkPublicRequest, type GuardOptions } from './guard.js';
import { DEFAULT_BODY_LIMIT, HttpError, type HttpContext, type HttpMethod, type ListenerKind, type Router, type Routers } from './router.js';

export interface HttpServersOptions {
  readonly routers: Routers;
  readonly guard: GuardOptions;
  readonly publicPort: number;
  readonly internalPort: number;
  readonly bindHost: string;
  /** 내부 리스너 bind 주소. 기본 bindHost(공개와 따로 좁힐 때: INTERNAL_BIND_HOST) */
  readonly internalBindHost?: string;
  /** 처리하지 못한 오류 기록(기본 console.error) */
  readonly onError?: (err: unknown) => void;
}

export interface HttpServers {
  readonly public: Server;
  readonly internal: Server;
  /** 실제로 열린 포트(포트 0 을 줬을 때 확인용) */
  readonly ports: { readonly public: number; readonly internal: number };
  close(): Promise<void>;
}

/** 413 뒤 버리며 읽을 남은 본문 상한(바이트). 넘으면 연결을 끊는다. */
export const DRAIN_LIMIT = 16 * 1024 * 1024;

const METHODS = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function makeContext(req: IncomingMessage, res: ServerResponse, listener: ListenerKind, method: HttpMethod, url: URL, params: Record<string, string>): HttpContext {
  const send = (status: number, body: string | Buffer, contentType: string) => {
    res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  // 413 이면 남은 본문은 버리며 읽되(클라이언트가 413 응답을 받도록) DRAIN_LIMIT 를 넘으면 req.destroy() 로 연결을 끊는다.
  const tooLarge = () => {
    let drained = 0;
    req.on('data', (chunk: Buffer) => {
      drained += chunk.length;
      if (drained > DRAIN_LIMIT) req.destroy();
    });
    return new HttpError(413, { error: 'payload too large' });
  };
  const readBody = async (maxBytes = DEFAULT_BODY_LIMIT) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > maxBytes) throw tooLarge();
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  };
  return {
    req,
    res,
    listener,
    method,
    path: url.pathname,
    params,
    query: url.searchParams,
    json: (status, body) => send(status, JSON.stringify(body), 'application/json; charset=utf-8'),
    empty: (status) => {
      res.writeHead(status);
      res.end();
    },
    send,
    readBody,
    readJson: async (maxBytes) => {
      const buf = await readBody(maxBytes);
      try {
        return JSON.parse(buf.toString('utf8'));
      } catch {
        throw new HttpError(400, { error: 'invalid json' });
      }
    },
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

function makeServer(kind: ListenerKind, router: Router, guard: GuardOptions, onError: (err: unknown) => void): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (kind === 'public') {
          const g = checkPublicRequest(req, guard);
          if (!g.ok) return writeJson(res, 403, { error: 'forbidden', reason: g.reason });
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';
        const m = router.match(METHODS.has(method) ? method : '', url.pathname);
        if (m.kind === 'none') return writeJson(res, 404, { error: 'not found' });
        if (m.kind === 'method') return writeJson(res, 405, { error: 'method not allowed' }, { allow: m.allow.join(', ') });
        await m.handler(makeContext(req, res, kind, method as HttpMethod, url, m.params));
      } catch (err) {
        if (err instanceof HttpError) return writeJson(res, err.status, err.body);
        onError(err);
        writeJson(res, 500, { error: 'internal error' });
      }
    })();
  });

  // WS 업그레이드: 공개 리스너는 같은 가드를 거친다. 매칭 실패는 소켓을 닫는다.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (line: string) => {
      socket.end(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`);
    };
    void (async () => {
      try {
        if (kind === 'public' && !checkPublicRequest(req, guard).ok) return reject('403 Forbidden');
        const url = new URL(req.url ?? '/', 'http://localhost');
        const m = router.matchUpgrade(url.pathname);
        if (m.kind !== 'ok') return reject('404 Not Found');
        await m.handler(req, socket, head, m.params);
      } catch (err) {
        onError(err);
        reject('500 Internal Server Error');
      }
    })();
  });
  return server;
}

const listen = (server: Server, port: number, host: string) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });

/** 두 리스너를 연다. 라우트는 listen 전에 모두 등록돼 있어야 한다(배선 순서). */
export async function startHttpServers(opts: HttpServersOptions): Promise<HttpServers> {
  const onError = opts.onError ?? ((err) => console.error('[http]', err));
  const pub = makeServer('public', opts.routers.public, opts.guard, onError);
  const int = makeServer('internal', opts.routers.internal, opts.guard, onError);
  const ports = { public: await listen(pub, opts.publicPort, opts.bindHost), internal: 0 };
  try {
    ports.internal = await listen(int, opts.internalPort, opts.internalBindHost ?? opts.bindHost);
  } catch (err) {
    pub.close();
    throw err;
  }
  const closeOne = (s: Server) =>
    new Promise<void>((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
  return { public: pub, internal: int, ports, close: async () => void (await Promise.all([closeOne(pub), closeOne(int)])) };
}
