// 공개 리스너 가드(계약 C2, DESIGN §13): Host 허용 목록 + Origin(있으면) 허용 목록. 어기면 403.
import type { IncomingMessage } from 'node:http';

export interface GuardOptions {
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
}

export type GuardResult = { ok: true } | { ok: false; reason: 'host' | 'origin' };

/** Host 는 필수(없으면 거부), Origin 은 있을 때만 검사한다. 비교는 대소문자 무시. */
export function checkPublicRequest(req: Pick<IncomingMessage, 'headers'>, opts: GuardOptions): GuardResult {
  const host = req.headers.host?.toLowerCase();
  if (!host || !opts.allowedHosts.some((h) => h.toLowerCase() === host)) return { ok: false, reason: 'host' };
  const origin = req.headers.origin;
  if (origin !== undefined && !opts.allowedOrigins.some((o) => o.toLowerCase() === String(origin).toLowerCase())) return { ok: false, reason: 'origin' };
  return { ok: true };
}
