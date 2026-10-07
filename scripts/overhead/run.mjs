#!/usr/bin/env node
// 계측 수준별 오버헤드 실측(DESIGN §9.1, 계약 C6). 오케스트레이터 공개 API(기본 127.0.0.1:4000)로 G02 row-lock 을
// open 고정 도착률로 돌리고, 증거를 runs/_overhead/<timestamp>.json 과 같은 이름의 .md(표)로 남긴다.
// 스택은 obs 프로필로 떠 있어야 한다(app CPU 는 cAdvisor → Prometheus 에서 읽는다).
//
//   node scripts/overhead/run.mjs --explore --rates 200,400,800      # 탐색: 도착률 후보 × 저/고경합 × off·full × 1회(짧게)
//   node scripts/overhead/run.mjs --rate-low 400 --rate-high 400     # 본 측정: 저/고경합 × off·metrics·full × 3회
//   node scripts/overhead/run.mjs --render runs/_overhead/<x>.json   # 증거 JSON → 표(markdown) 다시 출력
//
// 반복 순서: 반복 r 마다 (기준 × 수준)을 한 바퀴씩 돈다(각 실행은 reps 1 세션). 시간에 따른 드리프트가 한 수준에 몰리지 않게 한다.
// app CPU: 본 실행 구간(steps 「k6 본 실행」→「불변식 검사」) + 앞 8초(웜업 끝)의 cAdvisor container_cpu_usage_seconds_total rate(app 서비스 합).
//   Prometheus 는 호스트 포트가 없어 `docker exec <prometheus 컨테이너> wget` 으로 묻는다.
// 대기는 스크립트 안의 재시도(setTimeout 간격 조회)로 한다.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { CONTENTIONS, LEVELS, aggregate, mainWindow, overheadRequest, renderExplore, renderInvalid, renderRuns, renderTable, runFacts } from './lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(REPO_ROOT, 'runs', '_overhead');

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:4000' },
    'prom-container': { type: 'string', default: 'nestjs-under-load-prometheus-1' },
    explore: { type: 'boolean', default: false },
    rates: { type: 'string', default: '200,400,800' },
    'explore-levels': { type: 'string', default: 'off,full' },
    'rate-low': { type: 'string' },
    'rate-high': { type: 'string' },
    reps: { type: 'string', default: '3' },
    duration: { type: 'string' },
    warmup: { type: 'string' },
    render: { type: 'string' },
    out: { type: 'string' },
    'poll-ms': { type: 'string', default: '3000' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (opts.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).join('\n'));
  process.exit(0);
}

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = Number(opts['poll-ms']);
const CPU_LEAD_SEC = 8;

/** 증거 → 표 markdown */
function renderEvidence(ev) {
  const parts = [`<!-- ${ev.kind} · ${ev.startedAt} · git ${ev.git?.host?.sha ?? '?'} -->`];
  if (ev.kind === 'overhead-explore') {
    parts.push(renderExplore(ev.runs));
  } else {
    parts.push('### 2기준 × 3수준', renderTable(aggregate(ev.runs)), '### 반복별 값', renderRuns(ev.runs), '### 무효 실행', renderInvalid(ev.runs));
  }
  return parts.join('\n\n') + '\n';
}

if (opts.render) {
  process.stdout.write(renderEvidence(JSON.parse(readFileSync(path.resolve(opts.render), 'utf8'))));
  process.exit(0);
}

// ───────────────────────────── API ─────────────────────────────

async function api(method, p, body) {
  const res = await fetch(opts.base + p, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 본문이 JSON 이 아니면 text 만 */
  }
  return { status: res.status, json, text };
}

async function getJson(p) {
  const r = await api('GET', p);
  if (r.status !== 200) throw new Error(`GET ${p} → ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}

async function waitSession(sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const s = await getJson(`/sessions/${encodeURIComponent(sessionId)}`);
    const where = s.current ? `${s.current.step}` : '';
    if (where !== last) {
      log(`  ${s.state} ${where}`);
      last = where;
    }
    if (['done', 'aborted', 'failed'].includes(s.state)) return s;
    if (Date.now() > deadline) throw new Error(`세션 ${sessionId} 이 ${timeoutMs}ms 안에 끝나지 않았다(state=${s.state})`);
    await delay(POLL_MS);
  }
}

const durSec = (d) => {
  let t = 0;
  for (const m of d.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) t += Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]];
  return t;
};

/** POST /runs(reps 1). busy 면 그 세션 종료를 기다렸다 다시 낸다. */
async function runOnce(request) {
  const timeoutMs = (durSec(request.load.duration) + durSec(request.load.warmup) + 180) * 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await api('POST', '/runs', request);
    if (r.status === 409 && r.json?.reason === 'busy') {
      log(`busy: 세션 ${r.json.sessionId} 종료를 기다린다`);
      await waitSession(r.json.sessionId, 30 * 60_000);
      continue;
    }
    if (r.status !== 202) throw new Error(`POST /runs → ${r.status} ${r.text.slice(0, 500)}`);
    const runId = r.json.batches[0].runIds[0];
    log(`세션 ${r.json.sessionId} run ${runId}`);
    await waitSession(r.json.sessionId, timeoutMs);
    return runId;
  }
  throw new Error('POST /runs 가 계속 busy');
}

// ───────────────────────────── app CPU (cAdvisor) ─────────────────────────────

function promQuery(query, timeSec) {
  const url = `http://localhost:9090/api/v1/query?query=${encodeURIComponent(query)}&time=${timeSec}`;
  const out = execFileSync('docker', ['exec', opts['prom-container'], 'wget', '-qO-', url], { encoding: 'utf8' });
  const j = JSON.parse(out);
  if (j.status !== 'success') throw new Error(`Prometheus ${query}: ${out.slice(0, 300)}`);
  return j.data.result;
}

/**
 * 본 실행 구간 평균 app CPU(코어). 스크레이프가 구간 끝을 덮을 때까지 재시도한다(최대 약 30초).
 * processCores 는 prom-client process_cpu_seconds_total(metrics+ 에만 있음, 교차 확인용).
 */
async function appCpu(window, instances) {
  if (!window) return null;
  // cAdvisor 표본 간격이 5~10초로 들쭉날쭉해서 본 구간만 보면 인스턴스 하나가 표본 1개뿐일 때가 있다(탐색 2차 3/12회).
  // 그래서 구간 앞으로 CPU_LEAD_SEC 를 더 본다. 그 앞은 같은 도착률의 웜업 끝부분이라 부하 성격이 같다(웜업 10초 > 8초).
  const rangeSec = Math.max(5, Math.round((window.toMs - window.fromMs) / 1000)) + CPU_LEAD_SEC;
  const t = window.toMs / 1000;
  const sel = 'container_cpu_usage_seconds_total{container_label_com_docker_compose_service="app"}';
  for (let i = 0; i < 10; i++) {
    const latest = promQuery(`max(timestamp(${sel}))`, Date.now() / 1000);
    const lastTs = Number(latest[0]?.value?.[1] ?? 0);
    if (lastTs >= t) break;
    await delay(3000);
  }
  const per = promQuery(`sum by (name) (rate(${sel}[${rangeSec}s]))`, t);
  const perInstance = Object.fromEntries(per.map((x) => [x.metric.name, Number(x.value[1])]).filter(([, v]) => v > 0.001));
  // 활성 app 중 하나라도 구간 안 표본이 없으면(재시작 직후 cAdvisor 시리즈 지연) 합이 과소 집계되므로 측정 불가로 둔다.
  const complete = Object.keys(perInstance).length >= instances;
  const cores = complete ? Object.values(perInstance).reduce((a, b) => a + b, 0) : null;
  const proc = promQuery(`sum(rate(process_cpu_seconds_total{job="app"}[${rangeSec}s]))`, t);
  return {
    cores,
    perInstance,
    processCores: proc.length ? Number(proc[0].value[1]) : null,
    window: { ...window, rangeSec, complete, source: `cAdvisor container_cpu_usage_seconds_total(service=app) rate, 본 구간 + 앞 ${CPU_LEAD_SEC}s` },
  };
}

// ───────────────────────────── 실행 ─────────────────────────────

const stampNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
const kind = opts.explore ? 'overhead-explore' : 'overhead';
const outFile = opts.out ? path.resolve(opts.out) : path.join(OUT_DIR, `${stampNow()}_${opts.explore ? 'explore' : 'main'}.json`);
mkdirSync(path.dirname(outFile), { recursive: true });

const duration = opts.duration ?? (opts.explore ? '15s' : '30s');
const warmup = opts.warmup ?? (opts.explore ? '5s' : '10s');

let hostGit = null;
try {
  hostGit = {
    sha: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() !== '',
  };
} catch {
  /* git 없음 */
}
/** 오케스트레이터가 막 다시 뜬 경우를 위해 health 를 몇 번 재시도한다. */
async function waitHealth() {
  for (let i = 0; ; i++) {
    try {
      return await getJson('/health');
    } catch (e) {
      if (i >= 30) throw e;
      await delay(2000);
    }
  }
}
const health = await waitHealth();

/** 실행 계획: [{level, contention, rep, rate}] */
let plan;
if (opts.explore) {
  const rates = opts.rates.split(',').map(Number);
  const levels = opts['explore-levels'].split(',');
  plan = rates.flatMap((rate) => CONTENTIONS.flatMap((contention) => levels.map((level) => ({ level, contention, rep: 1, rate }))));
} else {
  if (!opts['rate-low'] || !opts['rate-high']) throw new Error('--rate-low 와 --rate-high 가 필요하다(먼저 --explore 로 정한다)');
  const rate = { low: Number(opts['rate-low']), high: Number(opts['rate-high']) };
  const reps = Number(opts.reps);
  plan = [];
  for (let rep = 1; rep <= reps; rep++) for (const contention of CONTENTIONS) for (const level of LEVELS) plan.push({ level, contention, rep, rate: rate[contention] });
}

const evidence = {
  kind,
  version: 1,
  base: opts.base,
  startedAt: new Date().toISOString(),
  endedAt: null,
  git: { orchestratorHealth: health.gitSha, host: hostGit },
  params: { duration, warmup, plan: plan.map((p) => `${p.contention}/${p.level}/r${p.rep}@${p.rate}`) },
  runs: [],
  errors: [],
};
const save = () => {
  writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');
  writeFileSync(outFile.replace(/\.json$/, '.md'), renderEvidence(evidence));
};
log(`오케스트레이터 ${opts.base} gitSha=${health.gitSha} · ${plan.length}회 → ${path.relative(REPO_ROOT, outFile)}`);

for (const [i, p] of plan.entries()) {
  log(`── ${i + 1}/${plan.length} ${p.contention} ${p.level} r${p.rep} @ ${p.rate} req/s ──`);
  try {
    const request = overheadRequest({
      ...p,
      duration,
      warmup,
      label: `T-141 overhead${opts.explore ? ' explore' : ''}`,
      prediction: `계측 수준 ${p.level} 오버헤드(${p.contention === 'low' ? '저경합' : '고경합'}, ${p.rate} req/s)`,
    });
    const runId = await runOnce(request);
    const { row, metadata: md } = await getJson(`/runs/${encodeURIComponent(runId)}`);
    const cpu = await appCpu(mainWindow(md?.steps), md?.topology?.appInstances ?? 2);
    const facts = runFacts({ runId, row, md, appCpu: cpu, ...p });
    facts.limits = md?.limits ?? null;
    facts.stackProfiles = md?.stack?.profiles ?? null;
    facts.mdGit = md?.git ?? null;
    facts.load = md?.load ?? null;
    evidence.runs.push(facts);
    log(
      `  p50 ${facts.p50?.toFixed(2)} p99 ${facts.p99?.toFixed(2)} ms n=${facts.n} · ${facts.throughputRps} req/s · app CPU ${facts.appCpuCores?.toFixed(2)} · ${facts.valid ? '유효' : `무효: ${facts.reasons.join('; ')}`}`,
    );
  } catch (e) {
    log(`  실패: ${e.stack ?? e}`);
    evidence.errors.push({ ...p, error: String(e?.message ?? e) });
  }
  save();
}
evidence.endedAt = new Date().toISOString();
save();
console.log('\n' + renderEvidence(evidence));
console.log(`증거: ${path.relative(REPO_ROOT, outFile)} (+ .md)`);
