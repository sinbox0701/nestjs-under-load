// k6 실행기(계약 C7): 의존성 없는 node:http. k6 를 자식 프로세스로 실행하고(동시 1개)
// 자기 cgroup 의 cpu.stat·cpu.max 를 전후로 읽어 결과에 싣는다.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PORT = 7070;
const MAX_BODY = 1024 * 1024;

/** cgroup v2 cpu.stat 텍스트 → { usageUsec, nrPeriods, nrThrottled, throttledUsec } (scripts/run.mjs parseCpuStat 과 동일) */
export function parseCpuStat(text) {
  const kv = Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k, Number(v)]),
  );
  if (!Number.isFinite(kv.usage_usec)) return null;
  return { usageUsec: kv.usage_usec, nrPeriods: kv.nr_periods ?? 0, nrThrottled: kv.nr_throttled ?? 0, throttledUsec: kv.throttled_usec ?? 0 };
}

/** cgroup v2 cpu.max("200000 100000" → 2코어, "max 100000" → null) (run.mjs parseCpuMax 와 동일) */
export function parseCpuMax(text) {
  const [quota, period] = text.trim().split(/\s+/);
  if (!quota || quota === 'max' || !Number(period)) return null;
  return Number(quota) / Number(period);
}

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isStrMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');

/** K6JobRequestSchema(@under-load/contracts)와 같은 모양의 최소 검증. 문제 없으면 null, 있으면 사유 문자열. */
export function validateJobRequest(b) {
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return '본문이 객체가 아님';
  const allowed = ['runId', 'phase', 'script', 'env', 'tags', 'prometheusRw', 'htmlExport', 'summaryPath'];
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length) return `알 수 없는 키: ${extra.join(',')}`;
  if (!isStr(b.runId)) return 'runId';
  if (b.phase !== 'warmup' && b.phase !== 'main') return 'phase';
  if (!isStr(b.script)) return 'script';
  if (!isStrMap(b.env)) return 'env';
  if (!isStrMap(b.tags)) return 'tags';
  if (typeof b.prometheusRw !== 'boolean') return 'prometheusRw';
  if (!(b.htmlExport === null || isStr(b.htmlExport))) return 'htmlExport';
  if (!isStr(b.summaryPath)) return 'summaryPath';
  return null;
}

/** 요청 → k6 run 인자와 env. prometheusRw 면 remote-write 출력·native histogram, htmlExport 면 web dashboard export. */
export function buildK6Invocation(req, baseEnv = {}) {
  const args = ['run', '--tag', `run_id=${req.runId}`];
  for (const [k, v] of Object.entries(req.tags)) args.push('--tag', `${k}=${v}`);
  const env = { ...baseEnv, ...req.env, RUN_ID: req.runId, PHASE: req.phase, SUMMARY_PATH: req.summaryPath };
  if (req.prometheusRw) {
    args.push('-o', 'experimental-prometheus-rw');
    env.K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM = 'true';
    env.K6_PROMETHEUS_RW_SERVER_URL = baseEnv.K6_PROMETHEUS_RW_SERVER_URL ?? 'http://prometheus:9090/api/v1/write';
  }
  if (req.htmlExport) {
    env.K6_WEB_DASHBOARD = 'true';
    env.K6_WEB_DASHBOARD_EXPORT = req.htmlExport;
    env.K6_WEB_DASHBOARD_PORT = '-1'; // 라이브 대시보드 서버는 끄고 내보내기만 한다
  }
  args.push(req.script);
  return { args, env };
}

/**
 * 실행기 서버를 만든다(listen 은 호출자 몫).
 * opts: k6Bin(기본 k6), cgroupDir(기본 /sys/fs/cgroup), env(자식 기본 env)
 */
export function createRunner(opts = {}) {
  const k6Bin = opts.k6Bin ?? process.env.K6_BIN ?? 'k6';
  const cgroupDir = opts.cgroupDir ?? process.env.CGROUP_DIR ?? '/sys/fs/cgroup';
  const baseEnv = opts.env ?? process.env;
  const jobs = new Map();
  let current = null;

  const readCpu = async () => {
    const stat = await readFile(`${cgroupDir}/cpu.stat`, 'utf8').then(parseCpuStat, () => null);
    const max = await readFile(`${cgroupDir}/cpu.max`, 'utf8').then(parseCpuMax, () => null);
    return { stat, max };
  };

  async function startJob(req) {
    const id = randomUUID();
    const { args, env } = buildK6Invocation(req, baseEnv);
    const job = { state: 'running', exitCode: null, startedAt: new Date().toISOString(), endedAt: null, cpu: { before: null, after: null, cpuMaxCores: null }, child: null, abortRequested: false };
    jobs.set(id, job);
    current = id;
    const before = await readCpu();
    job.cpu.before = before.stat;
    job.cpu.cpuMaxCores = before.max;
    const finish = async (state, exitCode) => {
      if (job.state !== 'running') return;
      job.cpu.after = (await readCpu()).stat;
      job.state = job.abortRequested ? 'aborted' : state;
      job.exitCode = exitCode;
      job.endedAt = new Date().toISOString();
      job.child = null;
      if (current === id) current = null;
    };
    const child = spawn(k6Bin, args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
    job.child = child;
    child.on('error', () => void finish('failed', null));
    child.on('close', (code) => void finish(code === 0 ? 'done' : 'failed', code));
    return id;
  }

  function inspect(body) {
    return new Promise((resolve) => {
      const child = spawn(k6Bin, ['inspect', '--execution-requirements', body.script], { env: { ...baseEnv, ...body.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => resolve({ status: 500, body: { error: String(e.message) } }));
      child.on('close', (code) => {
        if (code !== 0) return resolve({ status: 422, body: { error: err.trim() || `k6 inspect exit ${code}` } });
        try {
          resolve({ status: 200, body: JSON.parse(out) });
        } catch {
          resolve({ status: 422, body: { error: 'k6 inspect 출력이 JSON 이 아님' } });
        }
      });
    });
  }

  const publicJob = ({ state, exitCode, startedAt, endedAt, cpu }) => ({ state, exitCode, startedAt, endedAt, cpu });

  async function route(method, path, readJson) {
    if (method === 'GET' && path === '/health') return { status: 200, body: { ok: true } };
    if (method === 'POST' && path === '/jobs') {
      const body = await readJson();
      if (body === undefined) return { status: 400, body: { error: '잘못된 JSON' } };
      const bad = validateJobRequest(body);
      if (bad) return { status: 400, body: { error: `요청 검증 실패: ${bad}` } };
      if (current) return { status: 409, body: { error: '이미 실행 중인 job 이 있음', jobId: current } };
      // 동기 구간에서 current 를 먼저 잡아 동시 POST 경합을 막는다
      current = 'pending';
      try {
        return { status: 202, body: { jobId: await startJob(body) } };
      } catch (e) {
        current = null;
        return { status: 500, body: { error: String(e.message) } };
      }
    }
    if (method === 'POST' && path === '/inspect') {
      const body = await readJson();
      if (body === undefined || body === null || typeof body !== 'object' || !isStr(body.script) || !isStrMap(body.env)) return { status: 400, body: { error: '요청 검증 실패' } };
      return inspect(body);
    }
    const m = /^\/jobs\/([^/]+)(\/abort)?$/.exec(path);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return { status: 404, body: { error: 'job 없음' } };
      if (method === 'GET' && !m[2]) return { status: 200, body: publicJob(job) };
      if (method === 'POST' && m[2]) {
        if (job.state !== 'running' || !job.child) return { status: 409, body: { error: '실행 중이 아님', state: job.state } };
        job.abortRequested = true;
        job.child.kill('SIGINT');
        return { status: 202, body: { jobId: m[1] } };
      }
    }
    return { status: 404, body: { error: '없는 경로' } };
  }

  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const readJson = () =>
      new Promise((resolve) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY) {
            resolve(undefined);
            req.destroy();
          } else chunks.push(c);
        });
        req.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(undefined);
          }
        });
        req.on('error', () => resolve(undefined));
      });
    route(req.method, path, readJson).then(
      ({ status, body }) => {
        const text = JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      },
      (e) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message) }));
      },
    );
  });
  server.close_jobs = () => {
    for (const j of jobs.values()) j.child?.kill('SIGINT');
  };
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createRunner();
  server.listen(Number(process.env.PORT ?? PORT), '0.0.0.0', () => console.log(`k6 실행기 :${PORT}`));
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      server.close_jobs();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}
