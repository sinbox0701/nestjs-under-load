/**
 * 오케스트레이터 클라이언트(C2). 기본 경로는 REST `/api`, WS `/ws`(개발 서버·nginx 프록시를 거친다).
 * `createApi({ mock: true })` 는 contracts fixture 로 응답하므로 오케스트레이터 없이 화면을 만들 수 있다.
 */
import type {
  BatchSummary,
  CompareResult,
  LearnMeasured,
  ListRunsQuery,
  RunDetail,
  RunList,
  RunRequest,
  RunsAccepted,
  ScenarioInfo,
  Session,
  ValidationErrors,
  WsMessage,
} from './types';

/** 2xx 가 아닌 응답. 400 은 body.errors, 409 는 body.reason='busy'·sessionId. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`오케스트레이터 응답 ${status}`);
    this.name = 'ApiError';
  }
  get validationErrors(): ValidationErrors['errors'] | null {
    const b = this.body as Partial<ValidationErrors> | null;
    return this.status === 400 && Array.isArray(b?.errors) ? b.errors : null;
  }
}

export interface SubscribeOptions {
  /** 연결이 끊겼을 때 다시 붙는 최대 횟수. 기본 3. */
  maxReconnects?: number;
  /** 재연결 대기(ms). 기본 1000. */
  reconnectDelayMs?: number;
  /** 소켓이 열릴 때(재연결 포함). */
  onOpen?: () => void;
  /** 더 이상 재연결하지 않고 끝났을 때(end 수신·해제·재시도 소진). */
  onClose?: () => void;
}

export interface Api {
  getScenarios(): Promise<ScenarioInfo[]>;
  postRun(req: RunRequest): Promise<RunsAccepted>;
  getSession(sessionId: string): Promise<Session>;
  listRuns(query?: ListRunsQuery): Promise<RunList>;
  getRun(runId: string): Promise<RunDetail>;
  getBatch(batchId: string): Promise<BatchSummary>;
  compare(batchIds: string[], axis?: string): Promise<CompareResult>;
  learnMeasured(scenario: string): Promise<LearnMeasured>;
  /** 구독 해제 함수를 돌려준다. runId 에 'current'(types.ts WS_CURRENT)를 쓰면 진행 중인 실행을 따라간다. */
  subscribeRun(
    runId: string,
    onMessage: (msg: WsMessage) => void,
    opts?: SubscribeOptions,
  ): () => void;
}

export interface CreateApiOptions {
  mock?: boolean;
  /** REST 접두사. 기본 `/api`. */
  baseUrl?: string;
  /** WS 접두사. 기본 `/ws`. 절대 ws(s):// 주소도 된다. */
  wsBase?: string;
  /** 테스트용 주입. */
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
}

const enc = encodeURIComponent;

function wsUrl(wsBase: string, runId: string): string {
  const path = `${wsBase.replace(/\/$/, '')}/runs/${enc(runId)}`;
  if (/^wss?:\/\//.test(path)) return path;
  const { protocol, host } = globalThis.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}${path}`;
}

/** WS 한 줄 → WsMessage. 모양이 아니면 null(버린다). */
function parseWs(data: unknown): WsMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const m = JSON.parse(data) as Partial<WsMessage> | null;
    return m && typeof m === 'object' && typeof m.type === 'string' && 'data' in m
      ? (m as WsMessage)
      : null;
  } catch {
    return null;
  }
}

export function createApi(opts: CreateApiOptions = {}): Api {
  return opts.mock ? createMockApi() : createHttpApi(opts);
}

function createHttpApi(opts: CreateApiOptions): Api {
  const base = (opts.baseUrl ?? '/api').replace(/\/$/, '');
  const wsBase = opts.wsBase ?? '/ws';
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(`${base}${path}`, init);
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) throw new ApiError(res.status, body);
    return body as T;
  }

  const qs = (q: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  return {
    getScenarios: () => call('/scenarios'),
    postRun: (req) =>
      call('/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      }),
    getSession: (id) => call(`/sessions/${enc(id)}`),
    listRuns: (q = {}) => call(`/runs${qs({ ...q })}`),
    getRun: (id) => call(`/runs/${enc(id)}`),
    getBatch: (id) => call(`/batches/${enc(id)}`),
    compare: (ids, axis) => call(`/compare${qs({ batches: ids.join(','), axis })}`),
    learnMeasured: (scenario) => call(`/learn/${enc(scenario)}/measured`),
    subscribeRun(runId, onMessage, so = {}) {
      const WS = opts.WebSocket ?? globalThis.WebSocket;
      const maxReconnects = so.maxReconnects ?? 3;
      const delay = so.reconnectDelayMs ?? 1000;
      let closed = false;
      let ended = false;
      let attempts = 0;
      let sock: WebSocket | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (closed) return;
        closed = true;
        so.onClose?.();
      };
      const connect = () => {
        const s = new WS(wsUrl(wsBase, runId));
        sock = s;
        s.onopen = () => {
          attempts = 0;
          so.onOpen?.();
        };
        s.onmessage = (ev) => {
          const m = parseWs(ev.data);
          if (!m) return;
          if (m.type === 'end') ended = true;
          onMessage(m);
        };
        s.onclose = () => {
          if (closed) return;
          if (ended || attempts >= maxReconnects) return finish();
          attempts += 1;
          timer = setTimeout(connect, delay);
        };
      };
      connect();
      return () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        sock?.close();
      };
    },
  };
}

const MOCK_WS_STEP_MS = 50;

function createMockApi(): Api {
  const fx = () => import('./mock-fixtures').then((m) => m.fixtures);
  return {
    getScenarios: async () => (await fx()).scenarios,
    postRun: async () => {
      const { session } = await fx();
      return {
        sessionId: session.sessionId,
        batches: session.batches.map((b) => ({
          batchId: b.batchId,
          strategy: b.strategy,
          appInstances: b.appInstances,
          runIds: b.runIds,
        })),
      };
    },
    getSession: async () => (await fx()).session,
    listRuns: async () => ({ items: [(await fx()).runRow], next: null }),
    getRun: async () => {
      const { runRow, metadata } = await fx();
      const steps = (metadata as { steps?: { name: string; at: string }[] }).steps ?? [];
      return { row: runRow, metadata, steps };
    },
    getBatch: async () => (await fx()).batch,
    compare: async () => (await fx()).compare,
    // fixture 가 없다 — 셀은 비워 둔다(화면은 "실측 없음"으로 보여야 한다).
    learnMeasured: async (scenario) => ({ scenario, cells: [] }),
    subscribeRun(_runId, onMessage, so = {}) {
      let closed = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      void fx().then(({ wsMessages }) => {
        if (closed) return;
        so.onOpen?.();
        wsMessages.forEach((m, i) => {
          timers.push(setTimeout(() => onMessage(m), i * MOCK_WS_STEP_MS));
        });
        timers.push(
          setTimeout(() => {
            closed = true;
            so.onClose?.();
          }, wsMessages.length * MOCK_WS_STEP_MS),
        );
      });
      return () => {
        closed = true;
        timers.forEach(clearTimeout);
      };
    },
  };
}
