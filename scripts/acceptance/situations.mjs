#!/usr/bin/env node
// learn.yaml situation 실측 배치(T-156). learn.yaml 의 situations 정의(load·instances·data·scenarioParams·params·injected)를
// 그대로 RunRequest 로 옮겨 오케스트레이터 공개 API(기본 127.0.0.1:4000)로 돌리고, 세션·배치 id 를 runs/_situations/<timestamp>.json 에 남긴다.
// 실측 반영은 그다음 세션마다 `node scripts/measured.mjs --session <id> --write` 로 한다(이 스크립트는 learn.yaml 을 고치지 않는다).
//
//   node scripts/acceptance/situations.mjs                          # G01·G02 의 1단계 범위 situation 전부
//   node scripts/acceptance/situations.mjs --only g01               # 시나리오 하나(g01 | g02)
//   node scripts/acceptance/situations.mjs --situations a,b         # situation id 로 고르기
//   node scripts/acceptance/situations.mjs --strategies a,b         # strategy 로 고르기(무효 실행이 많은 배치만 다시 돌릴 때)
//   node scripts/acceptance/situations.mjs --dry-run                # 요청만 출력(API 호출 없음)
//   node scripts/acceptance/situations.mjs --out <json>             # 기존 기록에 이어 쓴다(이미 done 인 묶음은 건너뜀)
//
// 옮기는 규칙
// - chaos 가 none 이 아닌 situation(toxiproxy·after-lock 주입 등)은 1단계 범위 밖이라 건너뛰고 기록에 사유를 남긴다.
// - load: closed → constant-vus(vus), open → constant-arrival-rate(rate, maxVUs = rate × 요청 타임아웃 → dropped 를 실패로 센다).
//   shape 는 constant 만 지원한다(spike 는 constant 로 돌고 measured conditions 에 그 사실이 적힌다). duration 은 situation 값 그대로.
// - data: G02 seedOptions { products, stockPerProduct }, G01 seedOptions { documents }. 분포·scenarioParams 는 situation 값 그대로.
// - params: situation.params[strategy] 를 strategyParams 로(그 strategy 만). injected.contentionWindowMs → injectDelay after-read.
// - 앱 대수만 다른 situation 은 한 세션으로 묶는다. manifest minAppInstances 보다 적은 대수는 API 가 받지 않으므로
//   app-memory-lock 1대 대조(includeMemoryLockSingle)로만 돈다. 그 밖의 strategy 의 그 칸은 기록의 unreachable 에 남는다.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import YAML from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(REPO_ROOT, 'runs', '_situations');
const SCENARIOS = { g01: 'g01-shared-document', g02: 'g02-stock-decrement' };
const MEMORY_LOCK = 'app-memory-lock';

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:4000' },
    only: { type: 'string' },
    situations: { type: 'string' },
    strategies: { type: 'string' },
    out: { type: 'string' },
    reps: { type: 'string', default: '3' },
    warmup: { type: 'string', default: '5s' },
    timeout: { type: 'string', default: '10s' },
    'pre-vus': { type: 'string', default: '100' },
    'poll-ms': { type: 'string', default: '5000' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (opts.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).join('\n'));
  process.exit(0);
}
const POLL_MS = Number(opts['poll-ms']);
const REPS = Number(opts.reps);
const onlyScenarios = opts.only ? opts.only.split(',').map((s) => s.trim()) : Object.keys(SCENARIOS);
for (const s of onlyScenarios) if (!SCENARIOS[s]) throw new Error(`알 수 없는 시나리오: ${s} (가능: ${Object.keys(SCENARIOS).join(', ')})`);
const onlySituations = opts.situations ? new Set(opts.situations.split(',').map((s) => s.trim())) : null;
const onlyStrategies = opts.strategies ? new Set(opts.strategies.split(',').map((s) => s.trim())) : null;

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const durSec = (d) => {
  let t = 0;
  for (const m of String(d).matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) t += Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]];
  return t;
};
const sortedJson = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

// ───────────────────────────── situation → RunRequest ─────────────────────────────

function readPack(scenarioId) {
  const dir = path.join(REPO_ROOT, 'packs', 'generic', scenarioId);
  return {
    learn: YAML.parse(readFileSync(path.join(dir, 'learn.yaml'), 'utf8')),
    manifest: YAML.parse(readFileSync(path.join(dir, 'manifest.yaml'), 'utf8')),
  };
}

/** situation 에서 앱 대수를 뺀 조건. 같으면 한 세션으로 묶는다. */
const groupKey = (s) => sortedJson({ load: s.load, data: s.data, scenarioParams: s.scenarioParams ?? null, params: s.params ?? null, injected: s.injected ?? null });

function loadRequest(s) {
  const l = s.load;
  const base = { profile: 'constant', duration: l.duration, warmup: opts.warmup, thinkTimeMs: [0, 0], requestTimeout: opts.timeout };
  if (l.model === 'closed') return { model: 'closed', vus: l.vus, rate: null, preAllocatedVUs: null, maxVUs: null, ...base };
  const maxVUs = Math.ceil(l.rate * durSec(opts.timeout));
  return { model: 'open', vus: null, rate: l.rate, preAllocatedVUs: Math.min(Number(opts['pre-vus']), maxVUs), maxVUs, ...base };
}

function seedOptions(scenarioId, d) {
  if (scenarioId === SCENARIOS.g02) return { products: d.products, stockPerProduct: d.stockPerProduct };
  return { documents: d.documents };
}

/** 시나리오 하나 → 세션 계획 목록과 돌릴 수 없는 칸. */
export function planScenario(scenarioId, learn, manifest, filter = null, strategyFilter = null) {
  const strategies = manifest.strategies.map((s) => s.id).filter((id) => !strategyFilter || strategyFilter.has(id));
  const minApp = typeof manifest.minAppInstances === 'number' ? manifest.minAppInstances : 1;
  const skipped = [];
  const groups = new Map();
  for (const s of learn.situations) {
    if (filter && !filter.has(s.id)) continue;
    if ((s.chaos ?? 'none') !== 'none') {
      skipped.push({ situation: s.id, reason: `chaos ${JSON.stringify(s.chaos)} — 1단계 범위 밖` });
      continue;
    }
    const k = groupKey(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const sessions = [];
  const unreachable = [];
  for (const group of groups.values()) {
    const first = group[0];
    const counts = [...new Set(group.map((s) => s.instances))].sort((a, b) => a - b);
    const allowed = counts.filter((n) => n >= minApp);
    const single = counts.includes(1) && !allowed.includes(1);
    // minAppInstances 미만 대수는 app-memory-lock 1대 대조로만 돈다
    const runStrategies = allowed.length > 0 ? strategies : strategies.filter((id) => id === MEMORY_LOCK);
    for (const n of counts.filter((c) => c < minApp)) {
      for (const st of strategies.filter((id) => !(id === MEMORY_LOCK && n === 1))) {
        unreachable.push({ strategy: st, situation: group.find((s) => s.instances === n).id, reason: `app ${n}대 < manifest minAppInstances ${minApp}(API 거절)` });
      }
    }
    if (runStrategies.length === 0) continue;
    const params = Object.fromEntries(Object.entries(first.params ?? {}).filter(([st]) => runStrategies.includes(st)));
    const windowMs = first.injected?.contentionWindowMs ?? 0;
    const request = {
      scenario: scenarioId,
      strategies: runStrategies,
      strategyParams: params,
      appInstances: allowed.length > 0 ? allowed : [minApp],
      includeMemoryLockSingle: single && runStrategies.includes(MEMORY_LOCK),
      reps: REPS,
      load: loadRequest(first),
      data: { seed: 42, seedOptions: seedOptions(scenarioId, first.data), distribution: first.data.distribution ?? { kind: 'uniform' } },
      scenarioParams: scenarioId === SCENARIOS.g02 ? { qty: 1, ...(first.scenarioParams ?? {}) } : { ...(first.scenarioParams ?? {}) },
      instrumentation: 'metrics',
      injectDelay: windowMs > 0 ? [{ point: 'after-read', ms: windowMs }] : [],
      prediction: `learn.yaml expected (${group.map((s) => s.id).join(', ')})`,
      label: `T-156 ${group.map((s) => s.id).join('+')}`,
    };
    sessions.push({ situations: group.map((s) => ({ id: s.id, instances: s.instances })), request });
  }
  return { sessions, skipped, unreachable };
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

/** 세션이 끝날 때까지 조회를 되풀이한다(스크립트 안의 재시도). */
async function waitSession(sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const s = await getJson(`/sessions/${encodeURIComponent(sessionId)}`);
    const where = s.current ? `${s.current.runId} · ${s.current.step}` : '';
    if (where !== last) {
      log(`  ${s.state} ${where}`);
      last = where;
    }
    if (['done', 'aborted', 'failed'].includes(s.state)) return s;
    if (Date.now() > deadline) throw new Error(`세션 ${sessionId} 이 ${timeoutMs}ms 안에 끝나지 않았다(state=${s.state})`);
    await delay(POLL_MS);
  }
}

async function runSession(request, label) {
  const cases = request.strategies.length * request.appInstances.length + (request.includeMemoryLockSingle ? 1 : 0);
  const timeoutMs = cases * request.reps * (durSec(request.load.duration) + durSec(request.load.warmup) + 120) * 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await api('POST', '/runs', request);
    if (r.status === 409 && r.json?.reason === 'busy') {
      log(`busy: 세션 ${r.json.sessionId} 종료를 기다린다`);
      await waitSession(r.json.sessionId, timeoutMs);
      continue;
    }
    if (r.status !== 202) return { accepted: null, status: r.status, response: r.json ?? r.text, session: null };
    log(`${label}: 세션 ${r.json.sessionId} (${r.json.batches.map((b) => `${b.strategy}/i${b.appInstances}`).join(', ')})`);
    const session = await waitSession(r.json.sessionId, timeoutMs);
    return { accepted: r.json, status: 202, session };
  }
  throw new Error('POST /runs 가 계속 busy');
}

/** 배치마다 반복별 유효성·위반 합(반환 표 재료). */
async function batchSummary(batchId) {
  const b = await getJson(`/batches/${encodeURIComponent(batchId)}`);
  const reps = [];
  for (const runId of b.runIds) {
    const { row, metadata: md } = await getJson(`/runs/${encodeURIComponent(runId)}`);
    reps.push({ runId, status: row.status, valid: row.valid, violationsTotal: row.violationsTotal, invalidReasons: md?.validity?.reasons ?? null });
  }
  return { batchId, reps };
}

// ───────────────────────────── 실행 ─────────────────────────────

const stampNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');

async function main() {
  const plans = Object.fromEntries(
    onlyScenarios.map((key) => {
      const id = SCENARIOS[key];
      const { learn, manifest } = readPack(id);
      return [id, planScenario(id, learn, manifest, onlySituations, onlyStrategies)];
    }),
  );
  if (opts['dry-run']) {
    console.log(JSON.stringify(plans, null, 2));
    return;
  }
  const outFile = opts.out ? path.resolve(opts.out) : path.join(OUT_DIR, `${stampNow()}.json`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  const evidence = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : { kind: 'learn-situations', version: 1, base: opts.base, scenarios: {} };
  const save = () => writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');
  const health = await getJson('/health');
  let hostSha = null;
  try {
    hostSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    /* git 없음 */
  }
  evidence.git ??= { orchestratorHealth: health.gitSha, host: hostSha };
  log(`오케스트레이터 ${opts.base} gitSha=${health.gitSha} → ${path.relative(REPO_ROOT, outFile)}`);

  for (const [scenarioId, plan] of Object.entries(plans)) {
    const rec = (evidence.scenarios[scenarioId] ??= { sessions: [], skipped: plan.skipped, unreachable: plan.unreachable });
    for (const item of plan.sessions) {
      const label = item.situations.map((s) => s.id).join('+');
      if (rec.sessions.some((s) => s.label === label && s.state === 'done')) {
        log(`${label}: 이미 done — 건너뜀`);
        continue;
      }
      const entry = { label, situations: item.situations, request: item.request, startedAt: new Date().toISOString() };
      try {
        const s = await runSession(item.request, label);
        Object.assign(entry, { status: s.status, sessionId: s.accepted?.sessionId ?? null, state: s.session?.state ?? null, response: s.accepted ? undefined : s.response });
        if (s.accepted) entry.batches = await Promise.all(s.accepted.batches.map(async (b) => ({ strategy: b.strategy, appInstances: b.appInstances, ...(await batchSummary(b.batchId)) })));
      } catch (e) {
        entry.error = String(e?.stack ?? e);
        log(`${label} 실패: ${entry.error}`);
      }
      entry.endedAt = new Date().toISOString();
      rec.sessions = rec.sessions.filter((x) => x.label !== label || x.state === 'done');
      rec.sessions.push(entry);
      save();
    }
  }
  save();
  console.log('\n세션');
  for (const [scenarioId, rec] of Object.entries(evidence.scenarios)) {
    for (const s of rec.sessions) console.log(`  ${scenarioId} ${s.label}: ${s.sessionId ?? '-'} ${s.state ?? s.status ?? s.error?.slice(0, 80)}`);
  }
  console.log(`\n반영: 세션마다 node scripts/measured.mjs --session <id> --write\n증거: ${path.relative(REPO_ROOT, outFile)}`);
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main().catch((e) => {
    console.error(`실패: ${e.stack ?? e}`);
    process.exit(1);
  });
}
