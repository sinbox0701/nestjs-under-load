#!/usr/bin/env node
// 0단계 최소 실행기(오케스트레이터의 원형, DESIGN §7 / ROADMAP 0단계).
//
// 흐름(실행 1회): DB 리셋(템플릿 복제) → RunConfig 기록 → app restart(부팅 시 RunConfig 읽음) → readiness 확인
//               → k6 웜업(별도 실행, 웜업 전용 상품) → k6 본 실행(open model, constant-arrival-rate)
//               → invariants.sql → summary.json + metadata.json (runs/<runId>/)
// 같은 조건을 --reps(기본 3)회 반복한다. docker CLI를 호출하므로 호스트에서 실행한다.
//
//   node scripts/run.mjs                 # 4 strategy × 앱 2대 × 3회 + app-memory-lock 앱 1대 × 3회
//   node scripts/run.mjs --dry-run       # docker를 부르지 않고 단계·명령만 출력
//   node scripts/run.mjs --help
//
// DESIGN과 다른 0단계 단순화:
// - RunConfig는 오케스트레이터 HTTP(`/internal/run-config`)가 아니라 runs/_active/run-config.json 파일로 전달한다.
// - app 활성 수 조절은 `docker compose up --scale`(축소 시 컨테이너 제거)로 한다. 오케스트레이터는 stop/start만 쓸 예정.
// - k6 CPU 포화·스크레이프 누락 기반 무효 판정은 cAdvisor/Prometheus가 없어 하지 않는다(validity.checks에 미측정으로 남김).

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import YAML from 'yaml';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPOSE_FILE = path.join(REPO_ROOT, 'infra/compose/docker-compose.yml');
export const RUNS_DIR = path.join(REPO_ROOT, 'runs');
export const ACTIVE_DIR = path.join(RUNS_DIR, '_active');
const RUN_DB = 'lab_run';
const NGINX_URL = 'http://127.0.0.1:8081';
const PG_SHARED_STATS = ['archiver', 'bgwriter', 'checkpointer', 'io', 'recovery_prefetch', 'slru', 'wal'];

/** 시나리오 id → 팩 폴더(레포 기준). 0단계는 G02 하나. */
export const SCENARIOS = {
  'g02-stock-decrement': 'packs/generic/g02-stock-decrement',
};

export const DEFAULTS = Object.freeze({
  scenario: 'g02-stock-decrement',
  strategies: null, // null = manifest의 전체 strategy
  instances: [2],
  memoryLockSingle: true,
  reps: 3,
  rate: 100,
  duration: '30s',
  warmup: '10s',
  preVus: 50,
  maxVus: 200,
  timeout: '10s',
  products: 5,
  warmupProducts: 5,
  stock: 100,
  qty: 1,
  injectDelay: [],
  instrumentation: 'off',
  readyTimeoutSec: 90,
  dryRun: false,
});

const USAGE = `사용법: node scripts/run.mjs [옵션]

  --scenario <id>             기본 ${DEFAULTS.scenario}
  --strategies <a,b,...>      기본: manifest의 전체 strategy
  --instances <n[,m]>         앱 인스턴스 수 목록, 기본 2 (1~3)
  --no-memory-lock-single     app-memory-lock 앱 1대 대조 실행을 빼기(기본: 추가)
  --reps <n>                  반복 횟수, 기본 3
  --rate <n>                  도착률(iterations/s), 기본 100
  --duration <d>              본 실행 길이(예: 30s), 기본 30s
  --warmup <d>                웜업 길이(별도 k6 실행, 0s면 생략), 기본 10s
  --pre-vus <n> --max-vus <n> k6 preAllocatedVUs / maxVUs, 기본 50 / 200
  --timeout <d>               k6 요청 타임아웃, 기본 10s
  --products <n>              본 실행 상품 수, 기본 5
  --warmup-products <n>       웜업 전용 상품 수, 기본 5
  --stock <n>                 상품당 초기 재고, 기본 100
  --qty <n>                   요청당 차감 수량, 기본 1
  --inject-delay <point:ms>   경합 창 지연 주입(반복 가능), 예: after-read:50
  --instrumentation <lvl>     off|metrics|full (0단계는 기록만), 기본 off
  --dry-run                   docker를 호출하지 않고 단계·명령만 출력
  -h, --help`;

// ─────────────────────────────── 인자 파싱 ───────────────────────────────

const DURATION_RE = /^[1-9]\d*(ms|s|m|h)$/;

function toInt(name, raw, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`--${name}: ${min}~${max} 범위의 정수여야 합니다 (받은 값: ${raw})`);
  }
  return n;
}

function toDuration(name, raw, { allowZero = false } = {}) {
  if (allowZero && raw === '0s') return raw;
  if (!DURATION_RE.test(raw)) throw new Error(`--${name}: '30s' 같은 기간 형식이어야 합니다 (받은 값: ${raw})`);
  return raw;
}

/** 기간 문자열 → 초 */
export function durationToSeconds(d) {
  const m = /^(\d+)(ms|s|m|h)$/.exec(d);
  if (!m) throw new Error(`기간 형식 오류: ${d}`);
  const n = Number(m[1]);
  return { ms: n / 1000, s: n, m: n * 60, h: n * 3600 }[m[2]];
}

/** argv(노드·스크립트 경로 제외) → 검증된 옵션. --help면 { help: true }. */
export function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      scenario: { type: 'string' },
      strategies: { type: 'string' },
      instances: { type: 'string' },
      'no-memory-lock-single': { type: 'boolean' },
      reps: { type: 'string' },
      rate: { type: 'string' },
      duration: { type: 'string' },
      warmup: { type: 'string' },
      'pre-vus': { type: 'string' },
      'max-vus': { type: 'string' },
      timeout: { type: 'string' },
      products: { type: 'string' },
      'warmup-products': { type: 'string' },
      stock: { type: 'string' },
      qty: { type: 'string' },
      'inject-delay': { type: 'string', multiple: true },
      instrumentation: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return { help: true };
  if (positionals.length > 0) throw new Error(`알 수 없는 인자: ${positionals.join(' ')}`);

  const o = { ...DEFAULTS, injectDelay: [] };
  if (values.scenario !== undefined) {
    if (!(values.scenario in SCENARIOS)) {
      throw new Error(`--scenario: 알 수 없는 시나리오 '${values.scenario}'. 가능: ${Object.keys(SCENARIOS).join(', ')}`);
    }
    o.scenario = values.scenario;
  }
  if (values.strategies !== undefined) {
    const list = values.strategies.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) throw new Error('--strategies: 비어 있습니다');
    o.strategies = [...new Set(list)];
  }
  if (values.instances !== undefined) {
    o.instances = [...new Set(values.instances.split(',').map((s) => toInt('instances', s.trim(), { min: 1, max: 3 })))];
  }
  if (values['no-memory-lock-single']) o.memoryLockSingle = false;
  if (values.reps !== undefined) o.reps = toInt('reps', values.reps, { max: 20 });
  if (values.rate !== undefined) o.rate = toInt('rate', values.rate);
  if (values.duration !== undefined) o.duration = toDuration('duration', values.duration);
  if (values.warmup !== undefined) o.warmup = toDuration('warmup', values.warmup, { allowZero: true });
  if (values['pre-vus'] !== undefined) o.preVus = toInt('pre-vus', values['pre-vus']);
  if (values['max-vus'] !== undefined) o.maxVus = toInt('max-vus', values['max-vus']);
  if (values.timeout !== undefined) o.timeout = toDuration('timeout', values.timeout);
  if (values.products !== undefined) o.products = toInt('products', values.products);
  if (values['warmup-products'] !== undefined) o.warmupProducts = toInt('warmup-products', values['warmup-products']);
  if (values.stock !== undefined) o.stock = toInt('stock', values.stock, { min: 0 });
  if (values.qty !== undefined) o.qty = toInt('qty', values.qty);
  for (const spec of values['inject-delay'] ?? []) {
    const m = /^([a-z][a-z0-9-]*):(\d+)$/.exec(spec);
    if (!m) throw new Error(`--inject-delay: '<point>:<ms>' 형식이어야 합니다 (받은 값: ${spec})`);
    o.injectDelay.push({ point: m[1], ms: Number(m[2]) });
  }
  if (values.instrumentation !== undefined) {
    if (!['off', 'metrics', 'full'].includes(values.instrumentation)) {
      throw new Error(`--instrumentation: off|metrics|full 중 하나 (받은 값: ${values.instrumentation})`);
    }
    o.instrumentation = values.instrumentation;
  }
  if (o.maxVus < o.preVus) throw new Error('--max-vus는 --pre-vus 이상이어야 합니다');
  o.dryRun = Boolean(values['dry-run']);
  return o;
}

// ─────────────────────────────── manifest·계획 ───────────────────────────────

export function loadManifest(scenario) {
  const dir = path.join(REPO_ROOT, SCENARIOS[scenario]);
  const manifest = YAML.parse(readFileSync(path.join(dir, 'manifest.yaml'), 'utf8'));
  return { dir, manifest };
}

/** manifest params 스키마의 default 값으로 strategyParams를 만든다. */
export function defaultStrategyParams(manifest, strategyId) {
  const s = manifest.strategies.find((x) => x.id === strategyId);
  if (!s) throw new Error(`manifest에 strategy '${strategyId}'가 없습니다`);
  const out = {};
  for (const [k, spec] of Object.entries(s.params ?? {})) {
    if (spec && Object.hasOwn(spec, 'default')) out[k] = spec.default;
  }
  return out;
}

/**
 * 실행 계획: (strategy, appInstances) 케이스마다 reps회. 같은 케이스의 반복이 한 batch.
 * app-memory-lock은 기본으로 앱 1대 대조 케이스를 추가한다(ROADMAP 0단계 완료 기준).
 */
export function buildPlan(opts, manifest) {
  const known = manifest.strategies.map((s) => s.id);
  const strategies = opts.strategies ?? known;
  const unknown = strategies.filter((s) => !known.includes(s));
  if (unknown.length) throw new Error(`manifest에 없는 strategy: ${unknown.join(', ')} (가능: ${known.join(', ')})`);

  const cases = [];
  for (const strategy of strategies) {
    for (const n of opts.instances) cases.push({ strategy, appInstances: n });
    if (strategy === 'app-memory-lock' && opts.memoryLockSingle && !opts.instances.includes(1)) {
      cases.push({ strategy, appInstances: 1 });
    }
  }
  const plan = [];
  for (const c of cases) {
    for (let r = 1; r <= opts.reps; r++) plan.push({ ...c, repetition: r });
  }
  return plan;
}

const SCENARIO_SHORT = (scenario) => scenario.split('-')[0];

/** 2026-10-07T01:02:03.456Z → 2026-10-07T01-02-03Z */
export function stamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

export function makeBatchId(sessionStamp, scenario, strategy, appInstances) {
  return `${sessionStamp}_${SCENARIO_SHORT(scenario)}_${strategy}_i${appInstances}`;
}

export function makeRunId(batchId, repetition) {
  return `${batchId}_r${repetition}`;
}

export function sha256(data) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/** 팩 폴더의 파일들을 정렬된 순서로 해시(마이그레이션이 바뀌면 템플릿도 새로 만든다). */
export function hashDir(dir) {
  const h = createHash('sha256');
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts')).sort()) {
    h.update(f).update(readFileSync(path.join(dir, f)));
  }
  return `sha256:${h.digest('hex')}`;
}

export function seedOptions(opts) {
  return { products: opts.products, warmupProducts: opts.warmupProducts, stockPerProduct: opts.stock };
}

/** 템플릿 DB 식별 해시: 시나리오 + 시드 옵션 + 마이그레이션 내용. */
export function computeSeedHash(scenario, seedOpts, migrationsHash) {
  return sha256(JSON.stringify({ scenario, seedOpts, migrationsHash }));
}

export function templateDbName(scenario, seedHash) {
  return `tpl_${SCENARIO_SHORT(scenario)}_${seedHash.slice('sha256:'.length, 'sha256:'.length + 12)}`;
}

export function buildRunConfig({ runId, batchId, repetition, scenario, strategy, strategyParams, opts }) {
  return {
    runId,
    batchId,
    repetition,
    scenario,
    strategy,
    strategyParams,
    instrumentation: opts.instrumentation,
    injectDelay: opts.injectDelay,
    pool: { min: 2, max: 10 },
  };
}

/** k6에 넘길 -e KEY=VALUE 목록(params.schema.json과 같은 키). */
export function k6Env(opts, phase, summaryPath) {
  const warm = phase === 'warmup';
  return {
    BASE_URL: 'http://nginx',
    PHASE: phase,
    RATE: String(opts.rate),
    DURATION: warm ? opts.warmup : opts.duration,
    PRE_VUS: String(opts.preVus),
    MAX_VUS: String(opts.maxVus),
    PRODUCT_MIN: String(warm ? opts.products + 1 : 1),
    PRODUCT_MAX: String(warm ? opts.products + opts.warmupProducts : opts.products),
    QTY: String(opts.qty),
    REQUEST_TIMEOUT: opts.timeout,
    ...(summaryPath ? { SUMMARY_PATH: summaryPath } : {}),
  };
}

/** k6 스크립트 해시: 템플릿 내용 + 본 실행 파라미터(웜업·출력 경로 제외). */
export function k6ScriptHash(templateText, opts) {
  const { SUMMARY_PATH: _ignored, ...env } = k6Env(opts, 'main', null);
  return sha256(templateText + '\n' + JSON.stringify(env));
}

// ─────────────────────────────── 불변식·k6 결과 해석 ───────────────────────────────

/** `-- name: <id>` 구간으로 나눈다. 각 구간의 SQL에서 주석·빈 줄은 유지하되 앞뒤 공백은 자른다. */
export function parseInvariantsSql(text) {
  const sections = [];
  let current = null;
  for (const line of text.split('\n')) {
    const m = /^--\s*name:\s*([a-z0-9_]+)\s*$/.exec(line);
    if (m) {
      if (sections.some((s) => s.name === m[1])) throw new Error(`invariants.sql: 중복 이름 '${m[1]}'`);
      current = { name: m[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections.map(({ name, lines }) => {
    const sql = lines.join('\n').trim();
    const body = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .trim();
    if (!body) throw new Error(`invariants.sql: '${name}' 구간이 비어 있습니다`);
    return { name, sql };
  });
}

/** psql --csv 출력(헤더 + 1행) → 객체. 숫자는 Number로. */
export function parseCsvRow(csv) {
  const lines = csv.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0].split(',');
  const row = lines[1].split(',');
  return Object.fromEntries(header.map((h, i) => [h, row[i] !== undefined && row[i] !== '' && !Number.isNaN(Number(row[i])) ? Number(row[i]) : row[i]]));
}

/** manifest invariants(`sql: invariants.sql#name`)와 SQL 결과를 묶어 판정. */
export function judgeInvariants(manifest, results) {
  return manifest.invariants.map((inv) => {
    const name = inv.sql.split('#')[1];
    const row = results[name] ?? null;
    if (inv.severity === 'info') return { id: inv.id, severity: inv.severity, value: row };
    const violations = row && typeof row.violations === 'number' ? row.violations : null;
    return { id: inv.id, severity: inv.severity, violations, passed: violations === 0 };
  });
}

/** k6 handleSummary JSON → 필요한 값만. */
export function summarizeK6(summary) {
  const m = summary?.metrics ?? {};
  const count = (k) => m[k]?.values?.count ?? m[k]?.count ?? 0;
  const trend = m['http_req_duration{phase:main}']?.values ?? m.http_req_duration?.values ?? {};
  return {
    httpReqs: count('http_reqs'),
    iterations: count('iterations'),
    droppedIterations: count('dropped_iterations'),
    success: count('g02_orders_success'),
    soldOut: count('g02_orders_sold_out'),
    failed: count('g02_orders_failed'),
    latencyMs: {
      n: trend.count ?? null,
      p50: trend.med ?? null,
      p95: trend['p(95)'] ?? null,
      p99: trend['p(99)'] ?? null,
      max: trend.max ?? null,
    },
    httpReqRate: m.http_reqs?.values?.rate ?? null,
  };
}

/** 원장(DB) vs k6 보조 대조. k6가 적으면 클라이언트 타임아웃 후 서버 커밋 가능성. */
export function compareLedgerWithClient(ledger, k6) {
  if (!ledger || !k6) return null;
  const diffSuccess = ledger.success - k6.success;
  const diffSoldOut = ledger.sold_out - k6.soldOut;
  return {
    ledger: { success: ledger.success, soldOut: ledger.sold_out },
    client: { success: k6.success, soldOut: k6.soldOut, failed: k6.failed, dropped: k6.droppedIterations },
    diff: { success: diffSuccess, soldOut: diffSoldOut },
    note:
      diffSuccess > 0 || diffSoldOut > 0
        ? '원장이 k6보다 많음: 클라이언트 타임아웃 후 서버 커밋 가능성'
        : diffSuccess < 0 || diffSoldOut < 0
          ? 'k6가 원장보다 많음: 하네스/원장 기록 누락 의심'
          : null,
  };
}

/** 유효성 판정(DESIGN §7.2 중 0단계에서 가능한 것만). */
export function judgeValidity(opts, k6) {
  const reasons = [];
  const timeoutSec = durationToSeconds(opts.timeout);
  const maxVusEnough = opts.maxVus >= opts.rate * timeoutSec;
  if (k6 && k6.droppedIterations > 0 && !maxVusEnough) {
    reasons.push(`dropped_iterations=${k6.droppedIterations}, maxVUs(${opts.maxVus}) < rate×timeout(${opts.rate * timeoutSec}) → 설정 부족`);
  }
  if (k6 && k6.httpReqs === 0) reasons.push('k6 요청 0건');
  return {
    valid: reasons.length === 0,
    reasons,
    droppedCountedAsFailure: maxVusEnough,
    checks: { k6Cpu: 'not-measured(0단계: cAdvisor 없음)', scrapeGaps: 'not-measured(0단계)' },
  };
}

// ─────────────────────────────── 메타데이터 ───────────────────────────────

export function parsePgConf(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([a-z_.]+)\s*=\s*'?([^'#\n]*?)'?\s*(#.*)?$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** `docker compose config --format json` 결과에서 이미지·limit 추출(데몬 없이도 동작). */
export function extractComposeFacts(composeJson) {
  const svc = composeJson?.services ?? {};
  const pick = (name) => svc[name] ?? {};
  const limit = (name) => ({
    cpus: pick(name).cpus ?? null,
    mem: pick(name).mem_limit ?? null,
    cpuset: pick(name).cpuset ?? 'none',
  });
  return {
    images: { app: pick('app').image ?? null, postgres: pick('postgres').image ?? null, k6: pick('k6').image ?? null, nginx: pick('nginx').image ?? null },
    limits: { app: limit('app'), nginx: limit('nginx'), postgres: limit('postgres'), k6: limit('k6') },
  };
}

export function buildMetadata(ctx) {
  const { runId, batchId, sessionId, repetition, scenario, strategy, strategyParams, appInstances, opts } = ctx;
  const pgConf = ctx.pgConf ?? {};
  return {
    runId,
    batchId,
    sessionId,
    repetition,
    scenario,
    strategy: { id: strategy, params: strategyParams },
    git: ctx.git ?? { sha: null, dirty: null },
    images: ctx.composeFacts?.images ?? null,
    profile: 'minimal',
    host: ctx.host ?? null,
    limits: ctx.composeFacts?.limits ?? null,
    topology: { appInstances, lb: 'round-robin', dbPath: 'direct', proxy: 'off', replica: false },
    pool: { min: 2, max: 10, acquireTimeoutMs: null },
    postgres: {
      configHash: ctx.pgConfHash ?? null,
      maxConnections: pgConf.max_connections ? Number(pgConf.max_connections) : null,
      sharedBuffers: pgConf.shared_buffers ?? null,
      observerConnections: 0,
      appRoleConnectionLimit: null,
    },
    timeouts: {
      k6RequestMs: durationToSeconds(opts.timeout) * 1000,
      serverRequestMs: null,
      poolAcquireMs: null,
      statementMs: null,
      lockMs: strategyParams.lockTimeoutMs ?? null,
      idleInTxMs: null,
    },
    redis: null,
    data: {
      seed: null, // 결정적 시드(난수 없음). 대상 선택 난수는 k6 쪽(시드 고정은 1단계 loadtest/lib)
      seedHash: ctx.seedHash ?? null,
      templateDb: ctx.templateDb ?? null,
      rows: { products: opts.products, warmupProducts: opts.warmupProducts },
      stockPerProduct: opts.stock,
      qtyPerOrder: opts.qty,
      distribution: 'uniform',
    },
    load: {
      model: 'open',
      executor: 'constant-arrival-rate',
      profile: 'constant',
      rate: opts.rate,
      timeUnit: '1s',
      preAllocatedVUs: opts.preVus,
      maxVUs: opts.maxVus,
      duration: opts.duration,
      warmup: opts.warmup === '0s' ? 'none' : `${opts.warmup}(별도 실행, 웜업 전용 상품)`,
    },
    k6Script: { hash: ctx.k6ScriptHash ?? null, edited: false },
    instrumentation: opts.instrumentation,
    pgProbe: { enabled: false, intervalMs: null },
    interventions: opts.injectDelay.map((d) => ({ type: 'inject-delay', point: d.point, ms: d.ms })),
    chaos: [],
    coldStart: false,
    osCacheControlled: false,
    validity: ctx.validity ?? null,
    invariants: ctx.invariants ?? null,
    ledgerVsClient: ctx.ledgerVsClient ?? null,
    k6: ctx.k6 ?? null,
    steps: ctx.steps ?? [],
    artifacts: {
      runConfig: `runs/${runId}/run-config.json`,
      k6Summary: `runs/${runId}/summary.json`,
      metadata: `runs/${runId}/metadata.json`,
    },
    startedAt: ctx.startedAt ?? null,
    endedAt: ctx.endedAt ?? null,
    dryRun: Boolean(opts.dryRun),
  };
}

// ─────────────────────────────── docker 실행기 ───────────────────────────────

export function createExec({ dryRun, log = console.log }) {
  return function exec(cmd, args, { capture = false, allowFail = false, dryStdout = '' } = {}) {
    const printable = [cmd, ...args].map((a) => (/[\s"'$`]/.test(a) ? JSON.stringify(a) : a)).join(' ');
    log(`    $ ${printable}`);
    if (dryRun) return { status: 0, stdout: dryStdout };
    const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', cwd: REPO_ROOT });
    if (r.error) throw r.error;
    if (r.status !== 0 && !allowFail) {
      throw new Error(`명령 실패(exit ${r.status}): ${printable}\n${r.stderr ?? ''}`);
    }
    return { status: r.status, stdout: r.stdout ?? '' };
  };
}

function compose(exec, args, o) {
  return exec('docker', ['compose', '-f', COMPOSE_FILE, ...args], o);
}

function psql(exec, db, sql, o = {}) {
  return compose(exec, ['exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db, '-X', ...(o.csv ? ['--csv'] : ['-tA']), '-c', sql], {
    capture: true,
    ...o,
  });
}

function gitInfo() {
  const run = (args) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  const sha = run(['rev-parse', '--short', 'HEAD']);
  const status = run(['status', '--porcelain']);
  return { sha: sha.status === 0 ? sha.stdout.trim() : null, dirty: status.status === 0 ? status.stdout.trim().length > 0 : null };
}

function hostInfo(exec, dryRun) {
  const base = { os: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? null, node: process.version };
  if (dryRun) return { ...base, dockerNcpu: null, dockerMemBytes: null, dockerServerVersion: null };
  const r = exec('docker', ['info', '--format', '{{json .}}'], { capture: true, allowFail: true });
  try {
    const info = JSON.parse(r.stdout);
    return { ...base, dockerNcpu: info.NCPU ?? null, dockerMemBytes: info.MemTotal ?? null, dockerServerVersion: info.ServerVersion ?? null, dockerOs: info.OperatingSystem ?? null };
  } catch {
    return { ...base, dockerNcpu: null, dockerMemBytes: null, dockerServerVersion: null };
  }
}

function writeJsonAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}

/** nginx 경유 /_lab/ready를 돌려 N개 인스턴스가 모두 이 runId로 부팅했는지 확인. */
async function waitReady(runId, appInstances, timeoutSec, log) {
  const seen = new Set();
  const deadline = Date.now() + timeoutSec * 1000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${NGINX_URL}/_lab/ready`, { signal: AbortSignal.timeout(2000) });
      const body = await res.json();
      if (res.ok && body.runId === runId) seen.add(body.instance);
      else last = JSON.stringify(body);
    } catch (e) {
      last = String(e?.message ?? e);
    }
    if (seen.size >= appInstances) {
      log(`    ready: ${[...seen].join(', ')}`);
      return [...seen];
    }
    await sleep(500);
  }
  throw new Error(`readiness 타임아웃(${timeoutSec}s): ${seen.size}/${appInstances} 인스턴스 준비. 마지막 응답: ${last}`);
}

// ─────────────────────────────── 실행 ───────────────────────────────

export async function runSession(opts, { log = console.log } = {}) {
  const exec = createExec({ dryRun: opts.dryRun, log });
  const { dir: packDir, manifest } = loadManifest(opts.scenario);
  const packRel = SCENARIOS[opts.scenario];
  const plan = buildPlan(opts, manifest);
  const sessionStamp = stamp(new Date());
  const sessionId = `${sessionStamp}_${randomBytes(2).toString('hex')}`;
  const invariantSections = parseInvariantsSql(readFileSync(path.join(packDir, 'invariants.sql'), 'utf8'));
  const templateText = readFileSync(path.join(packDir, 'k6/template.js'), 'utf8');
  const pgConfText = readFileSync(path.join(REPO_ROOT, 'infra/postgres/postgresql.conf'), 'utf8');
  const seedOpts = seedOptions(opts);
  const seedHash = computeSeedHash(opts.scenario, seedOpts, hashDir(path.join(packDir, 'migrations')));
  const tplDb = templateDbName(opts.scenario, seedHash);
  const stepLog = (s) => log(`\n▶ ${s}`);

  log(`세션 ${sessionId}: ${plan.length}회 실행 (${opts.dryRun ? 'DRY-RUN' : 'LIVE'})`);
  for (const p of plan) log(`  - ${p.strategy} × 앱 ${p.appInstances}대 × r${p.repetition}`);

  // 메타데이터 공통값(세션 단위)
  let composeFacts = null;
  // compose config는 데몬 없이도 동작하는 읽기 전용 명령이라 dry-run에서도 실제로 실행한다.
  const cfg = compose(createExec({ dryRun: false, log: () => {} }), ['config', '--format', 'json'], { capture: true, allowFail: true });
  try {
    composeFacts = extractComposeFacts(JSON.parse(cfg.stdout));
  } catch {
    composeFacts = null;
  }
  const common = {
    sessionId,
    scenario: opts.scenario,
    opts,
    git: gitInfo(),
    host: hostInfo(exec, opts.dryRun),
    composeFacts,
    pgConf: parsePgConf(pgConfText),
    pgConfHash: sha256(pgConfText),
    seedHash,
    templateDb: tplDb,
    k6ScriptHash: k6ScriptHash(templateText, opts),
  };

  // 1) 스택 준비
  stepLog('스택 준비: app 이미지 빌드, postgres·k6·nginx 기동');
  if (!opts.dryRun) mkdirSync(ACTIVE_DIR, { recursive: true });
  compose(exec, ['build', 'app']);
  compose(exec, ['up', '-d', '--wait', 'postgres', 'k6']);

  // 2) 템플릿 DB (없을 때만: 마이그레이션 + 시드)
  stepLog(`템플릿 DB 확인: ${tplDb}`);
  const exists = psql(exec, 'postgres', `select 1 from pg_database where datname = '${tplDb}'`, { dryStdout: '' }).stdout.trim() === '1';
  if (exists) {
    log('    이미 있음 → 재사용');
  } else {
    try {
      psql(exec, 'postgres', `create database "${tplDb}" owner lab_app`);
      compose(exec, [
        'run', '--rm', '--no-deps', '-e', `POSTGRES_DB=${tplDb}`, '--entrypoint', 'node', 'app',
        'dist/cli/prepare-template.js', '--scenario', opts.scenario,
        ...Object.entries(seedOpts).flatMap(([k, v]) => ['--seed-opt', `${k}=${v}`]),
      ]);
      psql(exec, 'postgres', `alter database "${tplDb}" with is_template true allow_connections false`);
    } catch (e) {
      psql(exec, 'postgres', `drop database if exists "${tplDb}" with (force)`, { allowFail: true });
      throw e;
    }
  }

  const results = [];
  for (const p of plan) {
    const batchId = makeBatchId(sessionStamp, opts.scenario, p.strategy, p.appInstances);
    const runId = makeRunId(batchId, p.repetition);
    const runDir = path.join(RUNS_DIR, runId);
    const strategyParams = defaultStrategyParams(manifest, p.strategy);
    const startedAt = new Date().toISOString();
    const steps = [];
    const step = (name) => {
      steps.push({ name, at: new Date().toISOString() });
      stepLog(`[${runId}] ${name}`);
    };

    // 3) 초기화: app 정지 → 실행 DB를 템플릿에서 복제 → 통계 리셋
    step('app 정지');
    compose(exec, ['stop', 'app']);
    step(`실행 DB 리셋: ${RUN_DB} ← ${tplDb}`);
    psql(exec, 'postgres', `drop database if exists ${RUN_DB} with (force)`);
    psql(exec, 'postgres', `create database ${RUN_DB} owner lab_app template "${tplDb}"`);
    psql(exec, RUN_DB, 'vacuum analyze');
    psql(exec, 'postgres', 'checkpoint');
    psql(exec, 'postgres', 'select pg_stat_statements_reset()');
    psql(exec, RUN_DB, 'select pg_stat_reset()');
    psql(exec, 'postgres', PG_SHARED_STATS.map((t) => `select pg_stat_reset_shared('${t}');`).join(' '));

    // 4) RunConfig 게시 → app restart
    step('RunConfig 기록');
    const runConfig = buildRunConfig({ runId, batchId, repetition: p.repetition, scenario: opts.scenario, strategy: p.strategy, strategyParams, opts });
    log(`    ${JSON.stringify(runConfig)}`);
    if (!opts.dryRun) {
      writeJsonAtomic(path.join(ACTIVE_DIR, 'run-config.json'), runConfig);
      writeJsonAtomic(path.join(runDir, 'run-config.json'), runConfig);
    }
    step(`app 시작(앱 ${p.appInstances}대) + readiness`);
    compose(exec, ['up', '-d', '--no-recreate', '--scale', `app=${p.appInstances}`, 'app', 'nginx']);
    if (!opts.dryRun) await waitReady(runId, p.appInstances, opts.readyTimeoutSec, log);
    else log(`    (dry-run) GET ${NGINX_URL}/_lab/ready 로 ${p.appInstances}개 인스턴스가 runId=${runId}인지 확인`);

    // 5) 웜업(별도 실행, 결과 버림)
    if (opts.warmup !== '0s') {
      step(`k6 웜업 ${opts.warmup} (상품 ${opts.products + 1}..${opts.products + opts.warmupProducts})`);
      compose(exec, ['exec', '-T', 'k6', 'k6', 'run', '--quiet', ...envArgs(k6Env(opts, 'warmup', null)), `/${packRel}/k6/template.js`], { allowFail: true });
    }

    // 6) 본 실행
    step(`k6 본 실행 ${opts.duration} @ ${opts.rate}/s (open, constant-arrival-rate)`);
    const summaryInContainer = `/runs/${runId}/summary.json`;
    const k6Run = compose(exec, ['exec', '-T', 'k6', 'k6', 'run', ...envArgs(k6Env(opts, 'main', summaryInContainer)), `/${packRel}/k6/template.js`], { allowFail: true });

    // 7) 불변식
    step('불변식 검사(invariants.sql, DB 원장 기준)');
    const sqlResults = {};
    for (const s of invariantSections) {
      const r = psql(exec, RUN_DB, s.sql, { csv: true, allowFail: true, dryStdout: '' });
      sqlResults[s.name] = parseCsvRow(r.stdout);
    }
    const invariants = opts.dryRun ? null : judgeInvariants(manifest, sqlResults);

    // 8) 수집·메타데이터
    step('summary·메타데이터 저장');
    const summaryFile = path.join(runDir, 'summary.json');
    const k6 = !opts.dryRun && existsSync(summaryFile) ? { exitCode: k6Run.status, ...summarizeK6(JSON.parse(readFileSync(summaryFile, 'utf8'))) } : null;
    const metadata = buildMetadata({
      ...common,
      runId,
      batchId,
      repetition: p.repetition,
      strategy: p.strategy,
      strategyParams,
      appInstances: p.appInstances,
      validity: opts.dryRun ? null : judgeValidity(opts, k6),
      invariants,
      ledgerVsClient: compareLedgerWithClient(sqlResults.ledger_counts, k6),
      k6,
      steps,
      startedAt,
      endedAt: new Date().toISOString(),
    });
    if (opts.dryRun) {
      log(`    (dry-run) runs/${runId}/metadata.json 키: ${Object.keys(metadata).join(', ')}`);
    } else {
      writeJsonAtomic(path.join(runDir, 'metadata.json'), metadata);
      const failed = (invariants ?? []).filter((i) => i.severity !== 'info' && !i.passed).map((i) => `${i.id}=${i.violations}`);
      log(`    불변식: ${failed.length ? `위반 ${failed.join(', ')}` : '모두 통과'} | k6 성공 ${k6?.success ?? '?'} 품절 ${k6?.soldOut ?? '?'} 실패 ${k6?.failed ?? '?'} 드롭 ${k6?.droppedIterations ?? '?'}`);
    }
    results.push({ runId, batchId, strategy: p.strategy, appInstances: p.appInstances, repetition: p.repetition, invariants, validity: metadata.validity });
  }

  const sessionSummary = { sessionId, scenario: opts.scenario, dryRun: opts.dryRun, runs: results };
  if (!opts.dryRun) writeJsonAtomic(path.join(RUNS_DIR, '_sessions', `${sessionId}.json`), sessionSummary);
  log(`\n완료: ${results.length}회${opts.dryRun ? ' (dry-run, 파일 기록 없음)' : ` → runs/_sessions/${sessionId}.json`}`);
  return sessionSummary;
}

function envArgs(env) {
  return Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

async function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`오류: ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  await runSession(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`\n실행 실패: ${e.message}`);
    process.exit(1);
  });
}
