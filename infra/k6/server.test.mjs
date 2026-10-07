import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCpuStat, parseCpuMax, buildK6Invocation, validateJobRequest, createRunner } from './server.mjs';

const dir = mkdtempSync(join(tmpdir(), 'k6runner-'));
const cg = join(dir, 'cg');
mkdirSync(cg);
writeFileSync(join(cg, 'cpu.stat'), 'usage_usec 5000\nuser_usec 3000\nsystem_usec 2000\nnr_periods 10\nnr_throttled 2\nthrottled_usec 700\n');
writeFileSync(join(cg, 'cpu.max'), '200000 100000\n');
const argsFile = join(dir, 'args.json');
// 가짜 k6: 인자·env 를 기록하고, SIGINT 를 받으면 종료한다. FAKE_EXIT 가 있으면 즉시 그 코드로 끝난다.
const fake = join(dir, 'fake-k6.mjs');
writeFileSync(
  fake,
  `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
process.on('SIGINT', () => process.exit(105));
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }));
if (process.argv[2] === 'inspect') { console.log(JSON.stringify({ maxVUs: 3 })); process.exit(0); }
if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));
setInterval(() => {}, 1000);
`,
);
chmodSync(fake, 0o755);

const req = (over = {}) => ({ runId: 'r1', phase: 'main', script: '/packs/x/k6/template.js', env: { BASE_URL: 'http://nginx' }, tags: { scenario: 'g02' }, prometheusRw: false, htmlExport: null, summaryPath: '/runs/r1/summary.json', ...over });

async function withServer(fn, env = {}) {
  const server = createRunner({ k6Bin: fake, cgroupDir: cg, env: { ...process.env, ...env } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(call);
  } finally {
    server.close_jobs();
    await new Promise((r) => server.close(r));
  }
}

async function waitState(call, id, want) {
  for (let i = 0; i < 200; i++) {
    const r = await call('GET', `/jobs/${id}`);
    if (r.body.state === want) return r.body;
    await new Promise((r2) => setTimeout(r2, 25));
  }
  assert.fail(`state ${want} 도달 못함`);
}

test('cpu.stat/cpu.max 파서는 run.mjs 와 같은 결과', async () => {
  const run = await import('../../scripts/run.mjs');
  const text = readFileSync(join(cg, 'cpu.stat'), 'utf8');
  assert.deepEqual(parseCpuStat(text), run.parseCpuStat(text));
  assert.deepEqual(parseCpuStat(text), { usageUsec: 5000, nrPeriods: 10, nrThrottled: 2, throttledUsec: 700 });
  assert.equal(parseCpuMax('200000 100000'), 2);
  assert.equal(parseCpuMax('max 100000'), null);
  assert.equal(parseCpuStat('garbage'), null);
});

test('AC-4: prometheusRw=true 면 인자·env 구성', () => {
  const { args, env } = buildK6Invocation(req({ prometheusRw: true, htmlExport: '/runs/r1/report.html' }), {});
  assert.deepEqual(args.slice(0, 3), ['run', '--tag', 'run_id=r1']);
  assert.ok(args.join(' ').includes('-o experimental-prometheus-rw'));
  assert.equal(env.K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM, 'true');
  assert.equal(env.K6_WEB_DASHBOARD_EXPORT, '/runs/r1/report.html');
  assert.equal(args.at(-1), '/packs/x/k6/template.js');
  const off = buildK6Invocation(req(), {});
  assert.ok(!off.args.includes('-o'));
  assert.equal(off.env.K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM, undefined);
});

test('요청 검증(strict)', () => {
  assert.equal(validateJobRequest(req()), null);
  assert.ok(validateJobRequest(req({ phase: 'x' })));
  assert.ok(validateJobRequest({ ...req(), extra: 1 }));
  assert.ok(validateJobRequest(req({ env: { A: 1 } })));
});

test('health·잘못된 본문 400·없는 job 404', async () => {
  await withServer(async (call) => {
    assert.equal((await call('GET', '/health')).status, 200);
    assert.equal((await call('POST', '/jobs', { runId: 'x' })).status, 400);
    assert.equal((await call('GET', '/jobs/nope')).status, 404);
  });
});

test('AC-1·AC-2·AC-3: 두 번째 POST 409, abort 시 SIGINT 후 aborted, cpu 형식', async () => {
  await withServer(async (call) => {
    rmSync(argsFile, { force: true });
    const a = await call('POST', '/jobs', req({ prometheusRw: true }));
    assert.equal(a.status, 202);
    for (let i = 0; i < 200 && !existsSync(argsFile); i++) await new Promise((r) => setTimeout(r, 25)); // 가짜 k6 핸들러 설치 대기
    const second = await call('POST', '/jobs', req());
    assert.equal(second.status, 409);
    const running = await call('GET', `/jobs/${a.body.jobId}`);
    assert.equal(running.body.state, 'running');
    assert.deepEqual(running.body.cpu.before, { usageUsec: 5000, nrPeriods: 10, nrThrottled: 2, throttledUsec: 700 });
    assert.equal(running.body.cpu.cpuMaxCores, 2);
    assert.equal((await call('POST', `/jobs/${a.body.jobId}/abort`)).status, 202);
    const done = await waitState(call, a.body.jobId, 'aborted');
    assert.equal(done.exitCode, 105);
    assert.ok(done.endedAt);
    assert.deepEqual(done.cpu.after, { usageUsec: 5000, nrPeriods: 10, nrThrottled: 2, throttledUsec: 700 });
    assert.equal((await call('POST', `/jobs/${a.body.jobId}/abort`)).status, 409);
    // 끝난 뒤에는 새 job 허용
    rmSync(argsFile, { force: true });
    const b = await call('POST', '/jobs', req());
    assert.equal(b.status, 202);
    for (let i = 0; i < 200 && !existsSync(argsFile); i++) await new Promise((r) => setTimeout(r, 25));
    await call('POST', `/jobs/${b.body.jobId}/abort`);
    await waitState(call, b.body.jobId, 'aborted');
  });
});

test('k6 정상 종료 done, 비정상 종료 failed', async () => {
  await withServer(async (call) => {
    const a = await call('POST', '/jobs', req());
    assert.equal((await waitState(call, a.body.jobId, 'done')).exitCode, 0);
  }, { FAKE_EXIT: '0' });
  await withServer(async (call) => {
    const a = await call('POST', '/jobs', req());
    assert.equal((await waitState(call, a.body.jobId, 'failed')).exitCode, 99);
  }, { FAKE_EXIT: '99' });
});

test('inspect 는 k6 inspect JSON 을 돌려준다', async () => {
  await withServer(async (call) => {
    const r = await call('POST', '/inspect', { script: '/packs/x/k6/template.js', env: {} });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { maxVUs: 3 });
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')).args, ['inspect', '--execution-requirements', '/packs/x/k6/template.js']);
  });
});
