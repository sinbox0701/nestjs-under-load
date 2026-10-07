// 공개·내부 리스너, Host·Origin 가드, 라우터 규칙, env 설정 테스트.
// 실행: tsc -p tsconfig.json && node --test "test/*.test.ts" (dist 를 import 한다. Node 24 타입 제거 실행)
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { loadConfig } from '../dist/config.js';
import { createRouters, startHttpServers } from '../dist/http/index.js';

const GOOD_HOST = 'localhost:4000';
const guard = { allowedHosts: ['127.0.0.1:4000', 'localhost:4000', 'orchestrator:4000'], allowedOrigins: ['http://127.0.0.1:8080', 'http://localhost:5173'] };

function call(port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: GOOD_HOST, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('HTTP 골격', () => {
  let servers: Awaited<ReturnType<typeof startHttpServers>>;

  before(async () => {
    const routers = createRouters();
    routers.public.add('GET', '/health', (ctx) => ctx.json(200, { ok: true }));
    routers.public.add('GET', '/runs/:id', (ctx) => ctx.json(200, { id: ctx.params.id, q: ctx.query.get('x') }));
    routers.public.add('POST', '/echo', async (ctx) => ctx.json(200, await ctx.readJson(16)));
    routers.public.add('GET', '/boom', () => {
      throw new Error('boom');
    });
    routers.internal.add('GET', '/internal/run-config', (ctx) => ctx.empty(204));
    routers.internal.add('POST', '/ingest/events', (ctx) => ctx.empty(204));
    servers = await startHttpServers({ routers, guard, publicPort: 0, internalPort: 0, bindHost: '127.0.0.1', onError: () => {} });
  });
  after(() => servers.close());

  it('AC-1: 허용되지 않은 Origin 은 403, 허용 Origin 은 통과', async () => {
    const bad = await call(servers.ports.public, '/health', { origin: 'http://evil.example' });
    assert.equal(bad.status, 403);
    const ok = await call(servers.ports.public, '/health', { origin: 'http://127.0.0.1:8080' });
    assert.equal(ok.status, 200);
    const none = await call(servers.ports.public, '/health');
    assert.equal(none.status, 200);
  });

  it('AC-2: 허용 목록 밖 Host 는 403', async () => {
    const r = await call(servers.ports.public, '/health', { host: 'evil.example:4000' });
    assert.equal(r.status, 403);
    const rebind = await call(servers.ports.public, '/health', { host: '127.0.0.1:4001' });
    assert.equal(rebind.status, 403);
  });

  it('AC-3: /internal/*·/ingest/* 는 내부 리스너에만 있고 공개 리스너에서는 404', async () => {
    assert.equal((await call(servers.ports.public, '/internal/run-config')).status, 404);
    assert.equal((await call(servers.ports.public, '/ingest/events', {}, 'POST', '{}')).status, 404);
    assert.equal((await call(servers.ports.internal, '/internal/run-config')).status, 204);
    assert.equal((await call(servers.ports.internal, '/ingest/events', {}, 'POST', '{}')).status, 204);
    // 내부 리스너에는 공개 라우트가 없다
    assert.equal((await call(servers.ports.internal, '/runs/abc')).status, 404);
  });

  it('라우터: 경로 매개변수·쿼리·405·JSON 본문 제한·500', async () => {
    const r = await call(servers.ports.public, '/runs/a%20b?x=1');
    assert.deepEqual(JSON.parse(r.body), { id: 'a b', q: '1' });
    assert.equal((await call(servers.ports.public, '/health', {}, 'POST', '{}')).status, 405);
    assert.equal((await call(servers.ports.public, '/echo', {}, 'POST', '{"a":1}')).status, 200);
    assert.equal((await call(servers.ports.public, '/echo', {}, 'POST', '{"a":"0123456789abcdef"}')).status, 413);
    assert.equal((await call(servers.ports.public, '/echo', {}, 'POST', 'not json')).status, 400);
    assert.equal((await call(servers.ports.public, '/boom')).status, 500);
  });

  it('등록 규칙: 공개에 내부 경로, 내부에 공개 경로, 중복은 등록 시점에 throw', () => {
    const r = createRouters();
    assert.throws(() => r.public.add('GET', '/internal/x', () => {}));
    assert.throws(() => r.public.add('POST', '/ingest/events', () => {}));
    assert.throws(() => r.internal.add('GET', '/runs', () => {}));
    r.public.add('GET', '/a/:id', () => {});
    assert.throws(() => r.public.add('GET', '/a/:other', () => {}));
  });
});

describe('설정', () => {
  it('기본값과 env 덮어쓰기', () => {
    const c = loadConfig({});
    assert.equal(c.publicPort, 4000);
    assert.equal(c.internalPort, 4001);
    assert.deepEqual(c.allowedHosts, ['127.0.0.1:4000', 'localhost:4000', 'orchestrator:4000']);
    assert.equal(c.obs.grafanaTokenFile, '/runs/_meta/grafana-token');
    const d = loadConfig({ PUBLIC_PORT: '4100', RUNS_DIR: '/x', STACK_PROFILES: 'obs,bogus' });
    assert.equal(d.publicPort, 4100);
    assert.deepEqual(d.obs.profiles, ['obs']);
    assert.equal(d.obs.grafanaTokenFile, '/x/_meta/grafana-token');
  });

  it('잘못된 값이면 throw', () => {
    assert.throws(() => loadConfig({ PUBLIC_PORT: 'abc' }));
    assert.throws(() => loadConfig({ DOCKER_URL: 'not a url' }));
  });
});
