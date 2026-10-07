// DockerControl: 가짜 socket-proxy(HTTP 서버)로 요청 경로·메서드와 응답 해석을 확인한다.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { DockerError, createDockerControl } from '../dist/docker/index.js';

type Rec = { method: string; url: string };

const inspectOf = (id: string, number: number, extra: Record<string, unknown> = {}) => ({
  Id: id,
  Name: `/nestjs-under-load-app-${number}`,
  Image: `sha256:img${number}`,
  State: { Status: 'running' },
  Config: { Image: 'nestjs-under-load/app:dev', Labels: { 'com.docker.compose.service': 'app', 'com.docker.compose.container-number': String(number) } },
  HostConfig: { NanoCpus: 1_000_000_000, Memory: 536_870_912, CpusetCpus: '2-5' },
  ...extra,
});

describe('DockerControl', () => {
  let server: Server;
  let base = '';
  const recs: Rec[] = [];
  let stopStatus = 204;

  before(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '';
      recs.push({ method: req.method ?? '', url });
      const json = (status: number, body?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      };
      const path = url.split('?')[0]!;
      if (req.method === 'GET' && path === '/containers/json') return json(200, [{ Id: 'bbb' }, { Id: 'aaa' }]);
      if (req.method === 'GET' && path === '/containers/aaa/json') return json(200, inspectOf('aaa', 1));
      if (req.method === 'GET' && path === '/containers/bbb/json') return json(200, inspectOf('bbb', 2, { State: { Status: 'exited' }, HostConfig: { NanoCpus: 0, Memory: 0, CpusetCpus: '' } }));
      if (req.method === 'GET' && path === '/containers/nope/json') return json(404, { message: 'No such container: nope' });
      if (req.method === 'POST' && path === '/containers/aaa/stop') return json(stopStatus);
      if (req.method === 'POST' && path === '/containers/aaa/start') return json(204);
      if (req.method === 'POST' && path === '/containers/aaa/restart') return json(204);
      if (req.method === 'GET' && path === '/info') return json(200, { NCPU: 14, MemTotal: 10_000_000_000, ServerVersion: '28.0.1', OperatingSystem: 'Docker Desktop' });
      if (req.method === 'GET' && path === '/version') return json(200, { ApiVersion: '1.48' });
      return json(403, { message: 'forbidden' });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const control = () => createDockerControl({ baseUrl: base, composeProject: 'nestjs-under-load' });

  it('AC-1: compose 라벨 필터로 app 을 찾고 number 오름차순으로 돌려준다', async () => {
    recs.length = 0;
    const list = await control().list('app');
    const first = recs[0]!;
    assert.equal(first.method, 'GET');
    assert.ok(first.url.startsWith('/containers/json?all=1&filters='));
    const filters = JSON.parse(decodeURIComponent(first.url.split('filters=')[1]!)) as { label: string[] };
    assert.deepEqual(filters.label, ['com.docker.compose.service=app', 'com.docker.compose.project=nestjs-under-load']);
    assert.deepEqual(
      list.map((c) => [c.id, c.number, c.state]),
      [
        ['aaa', 1, 'running'],
        ['bbb', 2, 'exited'],
      ],
    );
  });

  it('inspect: 한도·이미지를 변환한다(0 은 null)', async () => {
    const a = await control().inspect('aaa');
    assert.equal(a.name, 'nestjs-under-load-app-1');
    assert.equal(a.service, 'app');
    assert.equal(a.image, 'nestjs-under-load/app:dev');
    assert.equal(a.imageId, 'sha256:img1');
    assert.deepEqual(a.limits, { cpus: 1, memBytes: 536_870_912, cpuset: '2-5' });
    const b = await control().inspect('bbb');
    assert.deepEqual(b.limits, { cpus: null, memBytes: null, cpuset: null });
    await assert.rejects(control().inspect('nope'), (e: unknown) => e instanceof DockerError && e.status === 404);
  });

  it('AC-1: stop·start·restart 요청 경로가 Docker Engine API 형식이다', async () => {
    recs.length = 0;
    const c = control();
    await c.stop('aaa', { timeoutSec: 5 });
    await c.stop('aaa');
    await c.start('aaa');
    await c.restart('aaa', { timeoutSec: 3 });
    assert.deepEqual(recs, [
      { method: 'POST', url: '/containers/aaa/stop?t=5' },
      { method: 'POST', url: '/containers/aaa/stop' },
      { method: 'POST', url: '/containers/aaa/start' },
      { method: 'POST', url: '/containers/aaa/restart?t=3' },
    ]);
  });

  it('stop 304(이미 정지)는 성공, 그 밖의 오류는 던진다', async () => {
    stopStatus = 304;
    await control().stop('aaa');
    stopStatus = 500;
    await assert.rejects(control().stop('aaa'), /500/);
    stopStatus = 204;
    await assert.rejects(control().start('zzz'), (e: unknown) => e instanceof DockerError && e.status === 403);
  });

  it('info: /info 와 /version 을 합친다', async () => {
    assert.deepEqual(await control().info(), { ncpu: 14, memTotalBytes: 10_000_000_000, serverVersion: '28.0.1', operatingSystem: 'Docker Desktop', apiVersion: '1.48' });
  });
});
