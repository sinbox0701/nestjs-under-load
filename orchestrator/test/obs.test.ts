// ObsClient(T-114): 가짜 Grafana·Prometheus HTTP 서버로 주석·토큰·스냅샷·스크레이프 누락을 확인한다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { loadConfig } from '../dist/config.js';
import { createObsClient } from '../dist/obs/index.js';
import type { Clock } from '../dist/ports.js';

type Req = { method: string; url: string; headers: IncomingMessage['headers']; body: unknown };

const clock: Clock = { now: () => 1_700_000_000_000, nowIso: () => '2023-11-14T22:13:20.000Z', sleep: async () => {} };

function fakeServer(handler: (r: Req) => { status?: number; body?: unknown }) {
  const reqs: Req[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const r: Req = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw === '' ? null : JSON.parse(raw) };
      reqs.push(r);
      const out = handler(r);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  const listen = () =>
    new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  return { reqs, server, listen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const matrix = (times: number[], vals?: string[]) => ({
  status: 'success',
  data: { resultType: 'matrix', result: [{ metric: { job: 'app', instance: 'app-1:3000' }, values: times.map((t, i) => [t, vals?.[i] ?? '1']) }] },
});

describe('ObsClient', () => {
  let dir: string;
  let tokenFile: string;
  let promBody: unknown;
  let grafanaStatus: (r: Req) => number | undefined;
  const grafana = fakeServer((r) => {
    const status = grafanaStatus(r);
    if (status !== undefined) return { status, body: { message: 'x' } };
    if (r.url.startsWith('/api/serviceaccounts/search')) return { body: { serviceAccounts: [] } };
    if (r.url === '/api/serviceaccounts') return { body: { id: 7 } };
    if (r.url === '/api/serviceaccounts/7/tokens') return { body: { id: 1, key: 'glsa_tok' } };
    return { body: { id: 99 } };
  });
  const prom = fakeServer(() => ({ body: promBody }));
  let grafanaUrl = '';
  let promUrl = '';

  before(async () => {
    grafanaUrl = await grafana.listen();
    promUrl = await prom.listen();
  });
  after(async () => {
    await grafana.close();
    await prom.close();
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'obs-test-'));
    tokenFile = join(dir, '_meta', 'grafana-token');
    grafana.reqs.length = 0;
    prom.reqs.length = 0;
    grafanaStatus = () => undefined;
    promBody = matrix([0, 5, 10]);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const make = (over: { profiles?: string; grafana?: string; prom?: string } = {}) => {
    const config = loadConfig({
      RUNS_DIR: dir,
      STACK_PROFILES: over.profiles ?? 'obs',
      GRAFANA_URL: over.grafana ?? grafanaUrl,
      PROMETHEUS_URL: over.prom ?? promUrl,
      GRAFANA_TOKEN_FILE: tokenFile,
    });
    return createObsClient({ obs: config.obs, clock });
  };
  const note = { runId: 'r1', batchId: 'b1', phase: 'main' as const, text: '본 실행', timeMs: 1000, timeEndMs: 2000 };

  it('AC-1: 주석 본문 tags 가 C5 형식이다', async () => {
    const res = await make().annotate(note);
    assert.equal(res.status, 'ok');
    const ann = grafana.reqs.find((r) => r.url === '/api/annotations');
    assert.ok(ann);
    const body = ann.body as { tags: string[]; time: number; timeEnd: number; text: string };
    assert.deepEqual(body.tags, ['nul', 'run:r1', 'batch:b1', 'phase:main']);
    assert.equal(body.time, 1000);
    assert.equal(body.timeEnd, 2000);
    assert.equal(ann.headers.authorization, 'Bearer glsa_tok');
    assert.equal((await readFile(tokenFile, 'utf8')).trim(), 'glsa_tok');
  });

  it('prepareToken: 주석 없이 토큰만 만들고, 꺼져 있으면 요청 없이 not-measured', async () => {
    assert.equal((await make().prepareToken()).status, 'ok');
    assert.equal((await readFile(tokenFile, 'utf8')).trim(), 'glsa_tok');
    assert.equal(grafana.reqs.filter((r) => r.url === '/api/annotations').length, 0);
    grafana.reqs.length = 0;
    assert.equal((await make({ profiles: '' }).prepareToken()).status, 'not-measured');
    assert.equal(grafana.reqs.length, 0);
  });

  it('AC-2: 토큰 파일이 있으면 서비스 계정 API 를 부르지 않는다', async () => {
    await mkdir(join(dir, '_meta'), { recursive: true });
    await writeFile(tokenFile, 'saved_tok\n', { mode: 0o644 });
    const c = make();
    await c.annotate(note);
    await c.annotate({ ...note, phase: 'warmup' });
    assert.equal(grafana.reqs.filter((r) => r.url.startsWith('/api/serviceaccounts')).length, 0);
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
    const anns = grafana.reqs.filter((r) => r.url === '/api/annotations');
    assert.equal(anns.length, 2);
    assert.equal(anns[0]!.headers.authorization, 'Bearer saved_tok');
  });

  it('토큰은 처음 한 번만 만든다(두 번째 클라이언트는 파일을 읽는다)', async () => {
    await make().annotate(note);
    await make().annotate(note);
    assert.equal(grafana.reqs.filter((r) => r.url === '/api/serviceaccounts').length, 1);
    assert.equal(grafana.reqs.filter((r) => r.url.endsWith('/tokens')).length, 1);
  });

  it('401 이면 토큰을 다시 만들어 한 번 재시도한다', async () => {
    await mkdir(join(dir, '_meta'), { recursive: true });
    await writeFile(tokenFile, 'stale');
    grafanaStatus = (r) => (r.url === '/api/annotations' && r.headers.authorization === 'Bearer stale' ? 401 : undefined);
    const res = await make().annotate(note);
    assert.equal(res.status, 'ok');
    assert.equal((await readFile(tokenFile, 'utf8')).trim(), 'glsa_tok');
  });

  it('AC-3: up 원시 표본에 15초 공백이 있으면 gaps>=1, 없으면 0', async () => {
    // 실제 Prometheus 응답 모양: /api/v1/query 의 범위 벡터(matrix), 표본 시각은 소수 초
    promBody = matrix([0.4, 5.4, 10.4, 40.8, 45.8, 50.8]);
    const gap = await make().scrapeGaps({ fromMs: 0, toMs: 60_000 });
    assert.ok(gap.status === 'ok' && gap.gaps === 1);
    const req = prom.reqs[0]!;
    assert.ok(req.url.startsWith('/api/v1/query?'), 'query_range 가 아니라 instant 범위 벡터를 쓴다');
    const q = new URL(req.url, 'http://x').searchParams;
    assert.equal(q.get('query'), 'up[60s]');
    assert.equal(q.get('time'), '60');

    promBody = matrix([0.4, 5.4, 10.4, 15.4, 20.4, 25.4]);
    const none = await make().scrapeGaps({ fromMs: 0, toMs: 60_000 });
    assert.ok(none.status === 'ok' && none.gaps === 0);
  });

  it('up==0 표본도 누락으로 센다(연속 0 은 1구간)', async () => {
    promBody = matrix([0, 5, 10, 15, 20, 25], ['1', '0', '0', '1', '0', '1']);
    const r = await make().scrapeGaps({ fromMs: 0, toMs: 30_000 });
    assert.ok(r.status === 'ok' && r.gaps === 2);
  });

  it('긴 구간은 나눠 질의하고 경계를 넘는 공백도 센다', async () => {
    const min = 60;
    // 25분 구간 → 10분 단위 3번. 응답은 같은 시리즈(표본 일부가 겹쳐도 합쳐진다)
    promBody = matrix([0, 5, 10, 20 * min, 20 * min + 5]);
    const r = await make().scrapeGaps({ fromMs: 0, toMs: 25 * min * 1000 });
    assert.equal(prom.reqs.length, 3);
    assert.deepEqual(prom.reqs.map((x) => new URL(x.url, 'http://x').searchParams.get('query')), ['up[600s]', 'up[600s]', 'up[300s]']);
    assert.ok(r.status === 'ok' && r.gaps === 1);
  });

  it('snapshot: 주요 지표 질의를 prom.json 으로 동결한다', async () => {
    const out = join(dir, 'r1', 'prom.json');
    const res = await make().snapshot({ runId: 'r1', fromMs: 0, toMs: 60_000, outFile: out });
    assert.deepEqual(res, { status: 'ok', file: out });
    const doc = JSON.parse(await readFile(out, 'utf8')) as { runId: string; queries: Record<string, { query: string; result: unknown[] }> };
    assert.equal(doc.runId, 'r1');
    assert.ok(Object.keys(doc.queries).length >= 5);
    assert.equal(doc.queries.up!.result.length, 1);
    await assert.rejects(stat(`${out}.tmp`));
  });

  it('AC-4: 연결 거부면 예외 없이 not-measured', async () => {
    // 닫힌 포트 확보
    const tmp = fakeServer(() => ({}));
    const dead = await tmp.listen();
    await tmp.close();
    const c = make({ grafana: dead, prom: dead });
    const out = join(dir, 'r1', 'prom.json');
    assert.equal((await c.annotate(note)).status, 'not-measured');
    assert.equal((await c.snapshot({ runId: 'r1', fromMs: 0, toMs: 1000, outFile: out })).status, 'not-measured');
    assert.equal((await c.scrapeGaps({ fromMs: 0, toMs: 1000 })).status, 'not-measured');
    await assert.rejects(stat(out));
  });

  it('obs 프로필이 없으면 요청 없이 not-measured', async () => {
    const c = make({ profiles: '' });
    assert.equal((await c.annotate(note)).status, 'not-measured');
    assert.equal((await c.snapshot({ runId: 'r1', fromMs: 0, toMs: 1000, outFile: join(dir, 'p.json') })).status, 'not-measured');
    assert.equal((await c.scrapeGaps({ fromMs: 0, toMs: 1000 })).status, 'not-measured');
    assert.equal(grafana.reqs.length + prom.reqs.length, 0);
  });
});

// ── 실제 Prometheus 통합: 컨테이너를 pause 해 스크레이프 공백을 만든다(약 30초). NUL_TEST_PROM=1 일 때만 돌고, 도커·이미지가 없어도 skip ──
const PROM_IMAGE = 'prom/prometheus:v3.5.0';
/** 병행 worktree 게이트끼리 겹치지 않게 실행마다 고유한 이름 */
const PROM_NAME = `nul-t114-prom-${process.pid}-${Date.now()}`;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const dockerReady = (() => {
  if (process.env.NUL_TEST_PROM !== '1') return false;
  try {
    docker('image', 'inspect', PROM_IMAGE);
    return true;
  } catch {
    return false;
  }
})();
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** fn 이 성공할 때까지 짧게 재시도 */
async function retry<T>(fn: () => Promise<T>, tries = 100, ms = 300): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await wait(ms);
    }
  }
  throw last;
}

describe('ObsClient × 실제 Prometheus', { skip: dockerReady ? false : 'NUL_TEST_PROM=1 이고 도커·이미지가 있을 때만 실행', timeout: 120_000 }, () => {
  let promUrl = '';

  before(async () => {
    try {
      docker('rm', '-f', PROM_NAME);
    } catch {
      // 없음
    }
    const cfg = 'global:\n  scrape_interval: 1s\nscrape_configs:\n  - job_name: prometheus\n    static_configs:\n      - targets: [\"localhost:9090\"]\n';
    docker('run', '--rm', '-d', '--name', PROM_NAME, '-p', '127.0.0.1::9090', '--entrypoint', 'sh', PROM_IMAGE, '-c', `printf '${cfg}' > /tmp/p.yml && exec /bin/prometheus --config.file=/tmp/p.yml --storage.tsdb.path=/tmp/data`);
    const port = docker('port', PROM_NAME, '9090/tcp').split('\n')[0]!.split(':').pop();
    promUrl = `http://127.0.0.1:${port}`;
    await retry(async () => {
      const res = await fetch(`${promUrl}/-/ready`);
      if (!res.ok) throw new Error(`ready ${res.status}`);
    });
  });
  after(() => {
    try {
      docker('rm', '-f', PROM_NAME);
    } catch {
      // 이미 정리됨
    }
  });

  it('17초 pause 공백(query_range 로는 안 보임)을 원시 표본으로 센다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'obs-int-'));
    try {
      const config = loadConfig({ RUNS_DIR: dir, STACK_PROFILES: 'obs', PROMETHEUS_URL: promUrl, GRAFANA_URL: 'http://127.0.0.1:1' });
      const c = createObsClient({ obs: config.obs, clock });
      const t0 = Date.now();
      await wait(6000);
      docker('pause', PROM_NAME);
      await wait(17_000);
      docker('unpause', PROM_NAME);
      await wait(4000);
      const t1 = Date.now();
      const r = await c.scrapeGaps({ fromMs: t0, toMs: t1 });
      assert.ok(r.status === 'ok' && r.gaps >= 1, JSON.stringify(r));

      // 공백 없는 뒤쪽 구간만 보면 0
      const clean = await c.scrapeGaps({ fromMs: Date.now() - 2500, toMs: Date.now() });
      assert.ok(clean.status === 'ok' && clean.gaps === 0, JSON.stringify(clean));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
