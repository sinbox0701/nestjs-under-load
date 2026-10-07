import type { IncomingMessage, ServerResponse } from 'node:http';

import { contextFromHeaders, runWithRequestContext } from './request-context';

/** express/Nest 공용 미들웨어. 이후 핸들러와 비동기 연쇄 전체가 같은 컨텍스트를 본다. */
export function requestContextMiddleware(req: IncomingMessage, _res: ServerResponse, next: (err?: unknown) => void): void {
  runWithRequestContext(contextFromHeaders(req.headers), next);
}
