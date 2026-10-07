import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './client';
import type { WsMessage } from './types';

describe('createApi({ mock: true }) — AC-3', () => {
  const api = createApi({ mock: true });

  it('REST 8종을 fixture 로 응답한다', async () => {
    const scenarios = await api.getScenarios();
    expect(scenarios[0]?.id).toBe('g02-stock-decrement');
    const accepted = await api.postRun({} as never);
    expect(accepted.sessionId).toBeTruthy();
    expect(accepted.batches.length).toBeGreaterThan(0);
    expect((await api.getSession(accepted.sessionId)).sessionId).toBe(accepted.sessionId);
    expect((await api.listRuns()).items.length).toBe(1);
    const run = await api.getRun('x');
    expect(run.row.runId).toBeTruthy();
    expect(run.metadata?.runId).toBeTruthy();
    expect((await api.getBatch('b')).batchId).toBeTruthy();
    expect(typeof (await api.compare(['a', 'b'], 'topology.appInstances')).comparable).toBe(
      'boolean',
    );
    expect((await api.learnMeasured('g02-stock-decrement')).scenario).toBe('g02-stock-decrement');
  });

  it('subscribeRun 은 fixture WsMessage 를 type 순서대로 흘린다', async () => {
    vi.useFakeTimers();
    try {
      const got: string[] = [];
      api.subscribeRun('current', (m) => got.push(m.type));
      await vi.advanceTimersByTimeAsync(1000);
      expect(got).toEqual(['status', 'events', 'agg', 'pool', 'probe', 'invariants', 'end']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('HTTP 래퍼', () => {
  it('경로·쿼리를 /api 아래로 만들고 비 2xx 는 ApiError', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url.endsWith('/runs') && init?.method === 'POST')
        return new Response(JSON.stringify({ reason: 'busy', sessionId: 's1' }), { status: 409 });
      return new Response(JSON.stringify({ items: [], next: null }), { status: 200 });
    });
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.listRuns({ scenario: 'g02', limit: 5 });
    await api.compare(['a', 'b'], 'instrumentation');
    expect(calls[0]?.[0]).toBe('/api/runs?scenario=g02&limit=5');
    expect(calls[1]?.[0]).toBe('/api/compare?batches=a%2Cb&axis=instrumentation');
    const err = await api.postRun({} as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).body).toEqual({ reason: 'busy', sessionId: 's1' });
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

describe('subscribeRun(WS) — AC-4', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const make = () => createApi({ WebSocket: FakeWebSocket as unknown as typeof WebSocket });
  const msg = (type: string, data: unknown) => ({ type, runId: 'r1', at: 1, data });

  it('type 별로 넘기고 모양이 아닌 프레임은 버린다', () => {
    const got: WsMessage[] = [];
    make().subscribeRun('current', (m) => got.push(m));
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toMatch(/^wss?:\/\/.+\/ws\/runs\/current$/);
    ws.emit(msg('status', { step: 'x' }));
    ws.emit(msg('pool', { total: 1 }));
    ws.emit({ nope: true });
    ws.onmessage?.({ data: 'not json' });
    expect(got.map((m) => m.type)).toEqual(['status', 'pool']);
  });

  it('끊기면 한 번 다시 붙고, end 뒤에는 붙지 않는다', () => {
    const got: string[] = [];
    const onClose = vi.fn();
    make().subscribeRun('r1', (m) => got.push(m.type), { reconnectDelayMs: 100, onClose });
    FakeWebSocket.instances[0]!.onclose?.();
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1]!;
    second.onopen?.();
    second.emit(msg('events', []));
    second.emit(msg('end', { valid: true, reasons: [] }));
    second.onclose?.();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(got).toEqual(['events', 'end']);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('해제하면 소켓을 닫고 재연결하지 않는다', () => {
    const off = make().subscribeRun('r1', () => {}, { reconnectDelayMs: 100 });
    const ws = FakeWebSocket.instances[0]!;
    off();
    expect(ws.closed).toBe(true);
    ws.onclose?.();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
