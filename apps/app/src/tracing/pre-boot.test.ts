// main.ts 의 부팅 앞단(preBoot): RunConfig 조회 → tracing 결정. 세 경로(파일 모드·빈 ORCHESTRATOR_URL·HTTP 204)와
// 실제 main.js 기동(첫 줄부터 JSON, RunConfig 재조회 없음)을 확인한다. PG 는 쓰지 않는다(전부 대기 모드).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { loadEnv } from '../config/env';
import { preBoot } from './pre-boot';
import type { StartTracingOptions } from './start-tracing';

const APP_DIR = path.resolve(__dirname, '../..');
const FIXTURES = path.join(path.dirname(require.resolve('@under-load/contracts/package.json')), 'fixtures');
const v1 = JSON.parse(readFileSync(path.join(FIXTURES, 'run-config.v1.json'), 'utf8')) as Record<string, unknown>;
const full = { ...v1, instrumentation: 'full' };

const dir = mkdtempSync(path.join(tmpdir(), 'nul-preboot-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const fullPath = path.join(dir, 'full.json');
writeFileSync(fullPath, JSON.stringify(full));
const missingPath = path.join(dir, 'missing.json');

/** 호출을 기록하는 가짜 startTracing(SDK 를 켜지 않는다). */
function fakeStart() {
  const calls: StartTracingOptions[] = [];
  return { calls, start: (o: StartTracingOptions) => (calls.push(o), true) };
}

const noFetch: typeof fetch = () => {
  throw new Error('HTTP 를 시도하면 안 된다');
};

async function fakeOrchestrator(status: number, body?: unknown) {
  const requests: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('preBoot', () => {
  it('파일 모드(ORCHESTRATOR_URL 없음): 파일의 RunConfig 로 tracing 을 결정한다', async () => {
    const f = fakeStart();
    const pre = await preBoot(loadEnv({ RUN_CONFIG_PATH: fullPath, INSTANCE_NAME: 'i1' }), { fetchImpl: noFetch, start: f.start });
    assert.equal(pre.runConfig?.instrumentation, 'full');
    assert.equal(pre.tracing, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.instance, 'i1');
    assert.equal(f.calls[0]!.runConfig.runId, v1.runId);
  });

  it('파일 모드: 파일이 없으면 대기 모드이고 tracing 을 부르지 않는다', async () => {
    const f = fakeStart();
    const pre = await preBoot(loadEnv({ RUN_CONFIG_PATH: missingPath }), { fetchImpl: noFetch, start: f.start });
    assert.deepEqual([pre.runConfig, pre.tracing, f.calls.length], [null, false, 0]);
  });

  it('빈 문자열·공백 ORCHESTRATOR_URL 은 파일 모드(HTTP 시도 없음)', async () => {
    for (const url of ['', '  ']) {
      const f = fakeStart();
      const pre = await preBoot(loadEnv({ ORCHESTRATOR_URL: url, RUN_CONFIG_PATH: fullPath }), {
        fetchImpl: noFetch,
        start: f.start,
      });
      assert.equal(pre.runConfig?.runId, v1.runId);
      assert.equal(f.calls.length, 1);
    }
  });

  it('HTTP 204 면 대기 모드, tracing 을 부르지 않는다', async () => {
    const orch = await fakeOrchestrator(204);
    try {
      const f = fakeStart();
      const pre = await preBoot(loadEnv({ ORCHESTRATOR_URL: orch.url, RUN_CONFIG_PATH: fullPath, INSTANCE_NAME: 'i2' }), {
        start: f.start,
      });
      assert.deepEqual([pre.runConfig, pre.tracing, f.calls.length], [null, false, 0]);
      assert.deepEqual(orch.requests, ['/internal/run-config?instance=i2']);
    } finally {
      await orch.close();
    }
  });

  it('HTTP 200 이면 받은 RunConfig 로 tracing 을 결정한다(파일은 보지 않는다)', async () => {
    const orch = await fakeOrchestrator(200, full);
    try {
      const f = fakeStart();
      const pre = await preBoot(loadEnv({ ORCHESTRATOR_URL: orch.url, RUN_CONFIG_PATH: missingPath }), { start: f.start });
      assert.equal(pre.runConfig?.instrumentation, 'full');
      assert.equal(f.calls.length, 1);
    } finally {
      await orch.close();
    }
  });
});

async function freePort(): Promise<number> {
  const s = createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** main.js 를 띄워 health 가 뜰 때까지 기다리고, ready 상태와 stdout 첫 줄을 돌려준다. */
async function bootMain(env: Record<string, string>): Promise<{ ready: number; firstLine: string }> {
  const port = await freePort();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, PORT: String(port) };
  if (!('ORCHESTRATOR_URL' in env)) delete childEnv.ORCHESTRATOR_URL;
  const child = spawn(process.execPath, [path.join(APP_DIR, 'dist/main.js')], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b: Buffer) => (out += b.toString()));
  try {
    let health: Response | null = null;
    for (let i = 0; i < 100 && !health?.ok; i++) {
      health = await fetch(`http://127.0.0.1:${port}/_lab/health`).catch(() => null);
      if (!health?.ok) await new Promise<void>((r) => setTimeout(r, 100));
    }
    assert.ok(health?.ok, `앱이 뜨지 않음: ${out}`);
    const ready = (await fetch(`http://127.0.0.1:${port}/_lab/ready`)).status;
    return { ready, firstLine: out.split('\n')[0]! };
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
}

describe('main.js 기동(대기 모드 세 경로)', () => {
  const expectJson = (line: string) => {
    const o = JSON.parse(line) as { level: string; context: string };
    assert.equal(o.context, 'Bootstrap');
  };

  it('ORCHESTRATOR_URL 없음 + 파일 없음 → 대기 모드, 첫 줄부터 JSON', async () => {
    const r = await bootMain({ RUN_CONFIG_PATH: missingPath });
    assert.equal(r.ready, 503);
    expectJson(r.firstLine);
  });

  it('ORCHESTRATOR_URL 빈 문자열 → 파일 모드(HTTP 없음)', async () => {
    const r = await bootMain({ ORCHESTRATOR_URL: ' ', RUN_CONFIG_PATH: missingPath });
    assert.equal(r.ready, 503);
    expectJson(r.firstLine);
  });

  it('HTTP 204 → 대기 모드, RunConfig 조회는 한 번뿐(bootstrap 재조회 없음)', async () => {
    const orch = await fakeOrchestrator(204);
    try {
      const r = await bootMain({ ORCHESTRATOR_URL: orch.url, INSTANCE_NAME: 'app-t137' });
      assert.equal(r.ready, 503);
      expectJson(r.firstLine);
      assert.deepEqual(orch.requests, ['/internal/run-config?instance=app-t137']);
    } finally {
      await orch.close();
    }
  });
});
