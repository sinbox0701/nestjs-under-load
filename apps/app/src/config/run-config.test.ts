import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseRunConfig, upgradeRunConfigV0 } from '@under-load/contracts';

import { loadEnv } from './env';
import { fetchRunConfig, loadRunConfig, resolveRunConfig } from './run-config';

const APP_DIR = path.resolve(__dirname, '../..');
const FIXTURES = path.join(path.dirname(require.resolve('@under-load/contracts/package.json')), 'fixtures');

const v0Path = path.join(FIXTURES, 'run-config.v0.json');
const v1: unknown = JSON.parse(readFileSync(path.join(FIXTURES, 'run-config.v1.json'), 'utf8'));
const v1Id = (v1 as { runId: string }).runId;

/** 응답 순서를 정해 둔 가짜 오케스트레이터. */
async function fakeOrchestrator(responses: { status: number; body?: unknown }[]) {
  const requests: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const r = responses[Math.min(requests.length - 1, responses.length - 1)]!;
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(r.body === undefined ? undefined : JSON.stringify(r.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('파일 모드 (AC-1)', () => {
  it('0단계 fixture 를 기존과 같은 값으로 읽는다', () => {
    const rc = loadRunConfig(v0Path);
    const raw = JSON.parse(readFileSync(v0Path, 'utf8')) as Parameters<typeof upgradeRunConfigV0>[0];
    assert.deepEqual(rc, upgradeRunConfigV0(raw));
    assert.equal(rc?.runId, raw.runId);
    assert.equal(rc?.strategy, raw.strategy);
    assert.deepEqual(rc?.pool, { ...raw.pool, acquireTimeoutMs: null });
    assert.equal(rc?.task, 'serve');
  });

  it('파일이 없으면 null(대기 모드)', () => {
    assert.equal(loadRunConfig('/nonexistent/run-config.json'), null);
  });

  it('ORCHESTRATOR_URL 이 없으면 HTTP 를 시도하지 않고 파일을 읽는다', async () => {
    const env = loadEnv({ RUN_CONFIG_PATH: v0Path });
    assert.equal(env.ORCHESTRATOR_URL, undefined);
    assert.equal((await resolveRunConfig(env))?.scenario, 'g02-stock-decrement');
  });

  it('빈 문자열·공백 ORCHESTRATOR_URL 은 없는 것으로 보고 파일 모드로 간다', async () => {
    for (const blank of ['', '   ']) {
      const env = loadEnv({ ORCHESTRATOR_URL: blank, RUN_CONFIG_PATH: v0Path });
      assert.equal(env.ORCHESTRATOR_URL, undefined);
      assert.equal((await resolveRunConfig(env))?.runId, (JSON.parse(readFileSync(v0Path, 'utf8')) as { runId: string }).runId);
    }
  });
});

describe('HTTP 모드 (AC-2)', () => {
  it('200 이면 RunConfig 를 적용하고 instance 쿼리를 보낸다', async () => {
    const orch = await fakeOrchestrator([{ status: 200, body: v1 }]);
    try {
      const rc = await fetchRunConfig(orch.url, 'app-1');
      assert.deepEqual(rc, parseRunConfig(v1));
      assert.equal(orch.requests[0], '/internal/run-config?instance=app-1');
    } finally {
      await orch.close();
    }
  });

  it('204 면 null(대기 모드)', async () => {
    const orch = await fakeOrchestrator([{ status: 204 }]);
    try {
      assert.equal(await fetchRunConfig(orch.url, 'app-1'), null);
    } finally {
      await orch.close();
    }
  });

  it('실패하면 재시도하고, 이후 200 을 받으면 적용한다', async () => {
    const orch = await fakeOrchestrator([{ status: 503 }, { status: 500 }, { status: 200, body: v1 }]);
    const retries: [number, string][] = [];
    try {
      const rc = await fetchRunConfig(orch.url, 'app-1', { retryIntervalMs: 5, onRetry: (n, r) => retries.push([n, r]) });
      assert.equal(rc?.runId, v1Id);
      assert.deepEqual(retries, [
        [1, 'HTTP 503'],
        [2, 'HTTP 500'],
      ]);
    } finally {
      await orch.close();
    }
  });

  it('연결이 안 되면 maxAttempts 번 시도한 뒤 던진다', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      throw new TypeError('fetch failed');
    };
    await assert.rejects(
      fetchRunConfig('http://orchestrator:4001', 'a', { fetchImpl, maxAttempts: 3, retryIntervalMs: 1 }),
      /3회 시도/,
    );
    assert.equal(calls, 3);
  });

  it('200 인데 계약과 다르면 재시도 없이 던진다', async () => {
    const orch = await fakeOrchestrator([{ status: 200, body: { schemaVersion: 1, task: 'serve' } }]);
    try {
      await assert.rejects(fetchRunConfig(orch.url, 'a', { retryIntervalMs: 1 }), /RunConfig 검증 실패/);
      assert.equal(orch.requests.length, 1);
    } finally {
      await orch.close();
    }
  });

  it('부팅: 204 면 /_lab/ready 가 503(대기 모드), /_lab/health 는 200', async () => {
    const orch = await fakeOrchestrator([{ status: 204 }]);
    const port = 39000 + (process.pid % 500);
    const child = spawn(process.execPath, [path.join(APP_DIR, 'dist/main.js')], {
      env: { ...process.env, PORT: String(port), ORCHESTRATOR_URL: orch.url, INSTANCE_NAME: 'app-t121' },
      stdio: 'pipe',
    });
    try {
      let health: Response | null | undefined;
      for (let i = 0; i < 100 && !health; i++) {
        health = await fetch(`http://127.0.0.1:${port}/_lab/health`).catch(() => null);
        if (!health) await new Promise<void>((r) => setTimeout(r, 100));
      }
      assert.ok(health?.ok, '앱이 뜨지 않음');
      assert.equal((await fetch(`http://127.0.0.1:${port}/_lab/ready`)).status, 503);
      assert.equal(orch.requests[0], '/internal/run-config?instance=app-t121');
    } finally {
      child.kill('SIGTERM');
      await once(child, 'exit');
      await orch.close();
    }
  });
});
