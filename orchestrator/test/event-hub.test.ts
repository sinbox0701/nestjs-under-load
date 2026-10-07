// EventHub: 수신 검증·runId 대조·파일 기록·링버퍼·WS 팬아웃·지표.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { parseEventsNdjson } from '@under-load/contracts';
import type { IngestBatch, WsMessage } from '@under-load/contracts';
import { WebSocket } from 'ws';

import { createEventHub } from '../dist/event-hub/index.js';
import { createRouters, startHttpServers } from '../dist/http/index.js';
import type { Clock } from '../dist/ports.js';

const fixture = JSON.parse(readFileSync(new URL('../../engine/contracts/fixtures/ingest-batch.json', import.meta.url), 'utf8')) as IngestBatch;
const RUN = fixture.runId;
const clock: Clock = { now: () => 1759827610000, nowIso: () => '2025-10-07T09:00:10.000Z', sleep: async () => {} };
const guard = { allowedHosts: ['localhost:4000'], allowedOrigins: [] as string[] };

function post(port: number, body: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/ingest/events', method: 'POST', headers: { host: 'localhost:4000', 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const get = (port: number, path: string) =>
  new Promise<string>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { host: 'localhost:4000' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    })
      .on('error', reject)
      .end();
  });

/** 접속하고 메시지를 모은다. open 후 서버 쪽 등록이 끝나도록 첫 메시지·짧은 대기 없이 open 만 기다린다. */
async function subscribe(port: number, target: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/runs/${target}`, { headers: { host: 'localhost:4000' } });
  const msgs: WsMessage[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d)) as WsMessage));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, msgs };
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('조건 대기 시간 초과');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const batchOf = (runId: string, n: number, base = 0): IngestBatch => ({
  ...fixture,
  runId,
  events: Array.from({ length: n }, (_, i) => ({ ...fixture.events[0]!, runId, seq: base + i, ts: 1759827610000000 + base + i })),
  agg: [],
});

describe('EventHub', () => {
  let dir: string;
  let hub: ReturnType<typeof createEventHub>;
  let servers: Awaited<ReturnType<typeof startHttpServers>>;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'event-hub-'));
    hub = createEventHub({ clock, ringEvents: 100 });
    const routers = createRouters();
    hub.registerRoutes(routers);
    servers = await startHttpServers({ routers, guard, publicPort: 0, internalPort: 0, bindHost: '127.0.0.1', onError: () => {} });
  });
  after(async () => {
    await hub.close();
    await servers.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('AC-1: 유효 배치 → events.ndjson 줄 수 = 이벤트 수, 각 줄이 유효', async () => {
    await hub.beginRun({ runId: RUN, batchId: 'b1', sessionId: 's1', dir: join(dir, RUN) });
    const r = await post(servers.ports.internal, JSON.stringify(fixture));
    assert.equal(r.status, 204);
    await hub.endRun(RUN);
    const text = await readFile(join(dir, RUN, 'events.ndjson'), 'utf8');
    const parsed = parseEventsNdjson(text);
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.events.length, fixture.events.length);
    assert.deepEqual(parsed.events, fixture.events);
    const agg = (await readFile(join(dir, RUN, 'agg.ndjson'), 'utf8')).trim().split('\n');
    assert.equal(agg.length, fixture.agg.length);
  });

  it('AC-2: runId 불일치는 409 이고 run_mismatch 지표 +1, 깨진 본문은 400', async () => {
    await hub.beginRun({ runId: RUN, batchId: 'b1', sessionId: 's1', dir: join(dir, RUN) });
    const before = hub.renderMetrics();
    assert.match(before, /lab_orch_ingest_rejected_total\{reason="run_mismatch"\} 0/);
    const r = await post(servers.ports.internal, JSON.stringify(batchOf('other-run', 1)));
    assert.equal(r.status, 409);
    assert.match(hub.renderMetrics(), /lab_orch_ingest_rejected_total\{reason="run_mismatch"\} 1/);
    assert.equal((await post(servers.ports.internal, '{"v":0}')).status, 400);
    assert.match(await get(servers.ports.internal, '/metrics'), /lab_orch_ingest_rejected_total\{reason="invalid"\} 1/);
    await hub.endRun(RUN);
  });

  it('1MB 를 넘는 본문은 413', async () => {
    await hub.beginRun({ runId: RUN, batchId: 'b1', sessionId: 's1', dir: join(dir, RUN) });
    const r = await post(servers.ports.internal, JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) }));
    assert.equal(r.status, 413);
    await hub.endRun(RUN);
  });

  it('AC-3: 구독자 2명이 같은 events 를 받고 current 구독은 실행이 바뀌면 새 runId 를 받는다', async () => {
    const A = 'run-A';
    const B = 'run-B';
    await hub.beginRun({ runId: A, batchId: 'b', sessionId: 's', dir: join(dir, A) });
    const s1 = await subscribe(servers.ports.public, A);
    const s2 = await subscribe(servers.ports.public, A);
    const cur = await subscribe(servers.ports.public, 'current');
    assert.match(hub.renderMetrics(), /lab_orch_ws_clients 3/);

    assert.equal((await post(servers.ports.internal, JSON.stringify(batchOf(A, 3)))).status, 204);
    await waitFor(() => [s1, s2, cur].every((s) => s.msgs.some((m) => m.type === 'events')));
    const ev = (s: typeof s1) => s.msgs.find((m) => m.type === 'events');
    assert.deepEqual(ev(s1), ev(s2));
    assert.equal(ev(cur)?.runId, A);

    await hub.endRun(A);
    await hub.beginRun({ runId: B, batchId: 'b', sessionId: 's', dir: join(dir, B) });
    assert.equal((await post(servers.ports.internal, JSON.stringify(batchOf(B, 2)))).status, 204);
    await waitFor(() => cur.msgs.some((m) => m.runId === B && m.type === 'events'));
    assert.ok(!s1.msgs.some((m) => m.runId === B));

    // 새로 접속하면 링버퍼 재생을 받는다
    const late = await subscribe(servers.ports.public, B);
    await waitFor(() => late.msgs.some((m) => m.type === 'events'));
    await hub.endRun(B);
    for (const s of [s1, s2, cur, late]) s.ws.close();
    await waitFor(() => /lab_orch_ws_clients 0/.test(hub.renderMetrics()));
  });

  it('AC-4: 링버퍼가 차면 오래된 것부터 버리고 파일 쓰기는 계속된다(1만 개)', async () => {
    const R = 'run-ring';
    await hub.beginRun({ runId: R, batchId: 'b', sessionId: 's', dir: join(dir, R) });
    for (let i = 0; i < 10; i++) assert.equal((await post(servers.ports.internal, JSON.stringify(batchOf(R, 1000, i * 1000)))).status, 204);
    const snap = hub.snapshot(R);
    assert.equal(snap.events.length, 100);
    assert.equal(snap.events[0]!.seq, 9900);
    assert.equal(snap.events.at(-1)!.seq, 9999);
    await hub.endRun(R);
    const lines = (await readFile(join(dir, R, 'events.ndjson'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 10000);
    assert.equal(JSON.parse(lines[0]!).seq, 0);
  });
});
