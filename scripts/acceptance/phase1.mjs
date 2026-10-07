#!/usr/bin/env node
// 1단계 수용 실측(ROADMAP 1단계 완료 기준 1–6). 오케스트레이터 공개 API(기본 127.0.0.1:4000)만으로 실행·판정하고
// 증거를 runs/_acceptance/<timestamp>.json 에 남긴다. 실패한 기준은 고치지 않고 원인 단서와 함께 기록한다.
//
//   node scripts/acceptance/phase1.mjs                         # 기준 1·2 → 3 → 4 → 6 (기본)
//   node scripts/acceptance/phase1.mjs --only c5 --out <json>  # 기준 5: k6 cpus 0.2 override 를 먼저 적용해 둔다
//   node scripts/acceptance/phase1.mjs --only probe,g01 --out <json>   # 노트 재료: G02 프로브 on/off · G01 5 strategy
//
// 단계 id
//   c12   기준 1·2: G02 no-lock·row-lock·conditional-update × 앱 2대 × closed × 3회. no-lock 위반 ≥1, 나머지 6회 위반 0,
//         compare 응답에서 invariants 가 throughputRps 앞. 주입 없이 먼저 돌리고, no-lock 위반이 0회면 D8 에 따라
//         injectDelay after-read:30 으로 한 번 더 돈다(결과에 injected=true, 메타데이터 interventions 에 남는다).
//   c3    기준 3: app-memory-lock 1대 3회 위반 0 · 2대 위반 ≥1, axis=topology.appInstances 비교(D6). 주입 정책은 c12 와 같다.
//   c4    기준 4: c12 의 같은 설정 3회 메타데이터 미채움 0개(C3 completeness + 스키마), vus 만 다른 배치와 비교 → comparable=false.
//   c5    기준 5: k6 cpus 를 0.2 로 낮춘 상태(scripts/acceptance/k6-cpu-0.2.override.yml)에서 closed·think 0 실행 → valid=false(k6 CPU 사유).
//   c6    기준 6: open 실행의 failures.total = http + dropped(droppedCountedAsFailure 인 반복). dropped>0 인 실행이 있어야 통과.
//   probe G02 PG 락 프로브 on/off 대조(row-lock·advisory-xact-lock × 3회 × 2), axis=pgProbe.enabled 비교. 판정 없음(노트 재료).
//   g01   G01 5 strategy × 3회(10초). T-135 AC-4: summary 에 g01_success·g01_conflict_409·g01_locked_423·g01_failed.
//
// 관측 경로(obs 프로필)는 실행마다 보조로 기록한다: 스크레이프 누락(metadata.validity.checks.scrapeGaps),
// Prometheus 스냅샷(prom.json 아티팩트), Grafana 주석(익명 Viewer 로 /api/annotations?tags=run:<id> 조회).
// 세션 완료 대기는 스크립트 안의 재시도(setTimeout 간격 조회)로 한다.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(REPO_ROOT, 'runs', '_acceptance');
const ALL_STEPS = ['c12', 'c3', 'c4', 'c5', 'c6', 'probe', 'g01'];
const DEFAULT_STEPS = ['c12', 'c3', 'c4', 'c6'];

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:4000' },
    grafana: { type: 'string', default: 'http://127.0.0.1:3001' },
    only: { type: 'string' },
    out: { type: 'string' },
    duration: { type: 'string', default: '30s' },
    warmup: { type: 'string', default: '10s' },
    'poll-ms': { type: 'string', default: '5000' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (opts.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n'));
  process.exit(0);
}
const steps = opts.only ? opts.only.split(',').map((s) => s.trim()) : DEFAULT_STEPS;
for (const s of steps) if (!ALL_STEPS.includes(s)) throw new Error(`알 수 없는 단계: ${s} (가능: ${ALL_STEPS.join(', ')})`);
const POLL_MS = Number(opts['poll-ms']);

// ───────────────────────────── 기록 ─────────────────────────────

const stampNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
const outFile = opts.out ? path.resolve(opts.out) : path.join(OUT_DIR, `${stampNow()}.json`);
mkdirSync(path.dirname(outFile), { recursive: true });
/** --out 으로 기존 파일을 주면 이어 쓴다(기준 5 는 k6 override 를 바꾼 뒤 따로 돌리기 때문). */
const evidence = existsSync(outFile)
  ? JSON.parse(readFileSync(outFile, 'utf8'))
  : { kind: 'phase1-acceptance', version: 1, base: opts.base, invocations: [], criteria: {}, notes: {} };
const invocation = { startedAt: new Date().toISOString(), steps, endedAt: null };
evidence.invocations.push(invocation);
const save = () => writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** 세션이 끝날 때까지 조회를 되풀이한다. 끝난 상태를 돌려준다. */
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

const durSec = (d) => {
  let t = 0;
  for (const m of d.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) t += Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]];
  return t;
};

/** POST /runs. busy 면 그 세션이 끝나길 기다렸다 다시 낸다. 202 면 세션 종료까지 기다린다. */
async function runSession(request, label) {
  const runs = request.strategies.length * (request.appInstances.length + 1) * request.reps;
  const timeoutMs = runs * (durSec(request.load.duration) + durSec(request.load.warmup) + 90) * 1000;
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
    return { accepted: r.json, status: 202, response: r.json, session };
  }
  throw new Error('POST /runs 가 계속 busy');
}

/** 한 배치의 반복별 사실(위반 합, 유효성, 관측 경로)을 모은다. */
async function batchFacts(batchId) {
  const b = await getJson(`/batches/${encodeURIComponent(batchId)}`);
  const reps = [];
  for (let i = 0; i < b.runIds.length; i++) {
    const runId = b.runIds[i];
    const { row, metadata: md } = await getJson(`/runs/${encodeURIComponent(runId)}`);
    const critical = (b.invariants ?? []).filter((inv) => inv.severity === 'critical');
    const violations = critical.reduce((sum, inv) => sum + (inv.violations[i] ?? 0), 0);
    reps.push({
      runId,
      status: row.status,
      valid: row.valid,
      invariantsPassed: row.invariantsPassed,
      violationsTotal: row.violationsTotal,
      criticalViolations: violations,
      violatedInvariants: critical.filter((inv) => (inv.violations[i] ?? 0) > 0).map((inv) => `${inv.id}=${inv.violations[i]}`),
      invalidReasons: md?.validity?.reasons ?? null,
      interventions: md?.interventions ?? null,
      k6: md?.k6 ? { requests: md.k6.requests, throughputRps: md.k6.throughputRps, httpFailures: md.k6.httpFailures, dropped: md.k6.dropped } : null,
      obs: md ? await obsFacts(runId, md) : null,
    });
  }
  return { batch: b, reps };
}

/** obs 프로필 경로: 스크레이프 누락·Prometheus 스냅샷·Grafana 주석. */
async function obsFacts(runId, md) {
  const out = { profiles: md.stack?.profiles ?? null, scrapeGaps: md.validity?.checks?.scrapeGaps ?? null };
  const snap = await api('GET', `/runs/${encodeURIComponent(runId)}/artifacts/prom.json`);
  out.promSnapshot = snap.status === 200 ? { bytes: snap.text.length, queries: snap.json ? Object.keys(snap.json.queries ?? snap.json).length : null } : { status: snap.status };
  try {
    const res = await fetch(`${opts.grafana}/api/annotations?tags=${encodeURIComponent(`run:${runId}`)}&limit=50`);
    const anns = res.ok ? await res.json() : null;
    out.grafanaAnnotations = anns
      ? { count: anns.length, phases: [...new Set(anns.flatMap((a) => a.tags.filter((t) => t.startsWith('phase:'))))].sort() }
      : { status: res.status };
  } catch (e) {
    out.grafanaAnnotations = { error: String(e?.message ?? e) };
  }
  return out;
}

/** compare 응답과, 배치마다 invariants 가 throughputRps 보다 앞에 있는지(원문 키 순서). */
async function compareEvidence(batchIds, axis) {
  const q = `/compare?batches=${batchIds.map(encodeURIComponent).join(',')}${axis ? `&axis=${encodeURIComponent(axis)}` : ''}`;
  const r = await api('GET', q);
  if (r.status !== 200) return { url: q, status: r.status, response: r.json ?? r.text };
  const order = r.json.batches.map((b) => {
    const raw = JSON.stringify(b);
    return { batchId: b.batchId, invariantsBeforeThroughput: raw.indexOf('"invariants"') < raw.indexOf('"throughputRps"') };
  });
  return {
    url: q,
    webUrl: `http://127.0.0.1:8080/#compare?batches=${batchIds.join(',')}${axis ? `&axis=${axis}` : ''}`,
    status: 200,
    comparable: r.json.comparable,
    axis: r.json.axis,
    diffs: r.json.diffs,
    codeVersionDiffers: r.json.codeVersionDiffers,
    keyOrder: order,
  };
}

// ───────────────────────────── 요청 ─────────────────────────────

const INJECT = [{ point: 'after-read', ms: 30 }];

/** G02 closed 기본(D8: 상품 수 적게, think 0, vus 50). 재고는 실행 중 소진되지 않게 크게. */
function g02Request(over = {}) {
  return {
    scenario: 'g02-stock-decrement',
    strategies: ['no-lock'],
    strategyParams: {},
    appInstances: [2],
    includeMemoryLockSingle: false,
    reps: 3,
    load: {
      model: 'closed',
      profile: 'constant',
      vus: 50,
      rate: null,
      preAllocatedVUs: null,
      maxVUs: null,
      duration: opts.duration,
      warmup: opts.warmup,
      thinkTimeMs: [0, 0],
      requestTimeout: '10s',
    },
    data: { seed: 42, seedOptions: { products: 1, warmupProducts: 1, stockPerProduct: 100000 }, distribution: { kind: 'uniform' } },
    scenarioParams: { qty: 1 },
    instrumentation: 'metrics',
    injectDelay: [],
    prediction: 'T-140 수용 실측',
    label: 'T-140 acceptance',
    ...over,
  };
}

const openLoad = (rate, preAllocatedVUs, maxVUs, requestTimeout, duration = '20s', warmup = '5s') => ({
  model: 'open',
  profile: 'constant',
  vus: null,
  rate,
  preAllocatedVUs,
  maxVUs,
  duration,
  warmup,
  thinkTimeMs: [0, 0],
  requestTimeout,
});

const batchOf = (accepted, strategy, n) => accepted?.batches.find((b) => b.strategy === strategy && b.appInstances === n)?.batchId ?? null;

// ───────────────────────────── 기준 ─────────────────────────────

/** 기준 1·2 */
async function c12() {
  const strategies = ['no-lock', 'row-lock', 'conditional-update'];
  const attempts = [];
  let final = null;
  for (const injected of [false, true]) {
    const request = g02Request({ strategies, injectDelay: injected ? INJECT : [], prediction: 'no-lock 은 2대에서 위반, 나머지는 위반 0' });
    const s = await runSession(request, `기준1·2${injected ? '(주입 after-read:30)' : ''}`);
    if (!s.accepted) {
      attempts.push({ injected, status: s.status, response: s.response });
      break;
    }
    const batches = {};
    for (const st of strategies) batches[st] = await batchFacts(batchOf(s.accepted, st, 2));
    const noLockViolatingReps = batches['no-lock'].reps.filter((r) => r.criticalViolations > 0).length;
    const fixedViolatingReps = ['row-lock', 'conditional-update'].flatMap((st) => batches[st].reps).filter((r) => r.criticalViolations > 0).length;
    const fixedReps = ['row-lock', 'conditional-update'].flatMap((st) => batches[st].reps).length;
    const allDone = Object.values(batches).every((b) => b.reps.length === 3 && b.reps.every((r) => r.status === 'done'));
    const attempt = {
      injected,
      sessionId: s.accepted.sessionId,
      sessionState: s.session.state,
      request,
      batchIds: Object.fromEntries(strategies.map((st) => [st, batchOf(s.accepted, st, 2)])),
      noLockViolatingReps,
      fixedViolatingReps,
      fixedReps,
      allDone,
      batches: Object.fromEntries(Object.entries(batches).map(([k, v]) => [k, { reps: v.reps, badges: v.batch.badges, validity: v.batch.validity }])),
    };
    attempts.push(attempt);
    final = attempt;
    save();
    if (noLockViolatingReps >= 1) break;
    log('no-lock 위반 0회 → D8: after-read:30 주입으로 다시 시도');
  }
  const compare = final ? await compareEvidence(Object.values(final.batchIds), null) : null;
  const pass2 =
    !!final && final.allDone && final.noLockViolatingReps >= 1 && final.fixedViolatingReps === 0 && final.fixedReps === 6;
  const pass1 = !!compare && compare.status === 200 && compare.keyOrder.every((k) => k.invariantsBeforeThroughput);
  evidence.criteria.c1 = {
    title: '기준 1: G02 3 strategy × 3회 → 비교 응답에서 불변식이 처리량 앞',
    pass: pass1,
    compare,
    note: '화면 표시 순서는 AC-5 스크린샷(runs/_acceptance/*.png)으로 본다',
  };
  evidence.criteria.c2 = {
    title: '기준 2: no-lock 앱 2대·closed 위반 ≥1회, row-lock·conditional-update 6회 위반 0',
    pass: pass2,
    injected: final?.injected ?? null,
    attempts,
  };
  save();
  return final;
}

/** 기준 3 */
async function c3() {
  const attempts = [];
  let final = null;
  for (const injected of [false, true]) {
    const request = g02Request({
      strategies: ['app-memory-lock'],
      appInstances: [2],
      includeMemoryLockSingle: true,
      injectDelay: injected ? INJECT : [],
      prediction: 'app-memory-lock 은 1대 통과, 2대 위반',
    });
    const s = await runSession(request, `기준3${injected ? '(주입 after-read:30)' : ''}`);
    if (!s.accepted) {
      attempts.push({ injected, status: s.status, response: s.response });
      break;
    }
    const i2 = batchOf(s.accepted, 'app-memory-lock', 2);
    const i1 = batchOf(s.accepted, 'app-memory-lock', 1);
    const attempt = { injected, sessionId: s.accepted.sessionId, sessionState: s.session.state, request, accepted: s.accepted, batchIds: { i1, i2 } };
    if (!i1) {
      // 1대 대조 케이스가 계획에 없다 → appInstances:[1] 을 직접 내 보고 거절 사유를 남긴다(세션은 시작되지 않는다).
      const probe = await api('POST', '/runs', { ...request, appInstances: [1], includeMemoryLockSingle: false });
      attempt.singleInstanceRequest = { status: probe.status, response: probe.json ?? probe.text };
      if (probe.status === 202) await waitSession(probe.json.sessionId, 30 * 60_000);
    }
    attempt.i2 = i2 ? await batchFacts(i2) : null;
    attempt.i1 = i1 ? await batchFacts(i1) : null;
    attempt.i2ViolatingReps = attempt.i2?.reps.filter((r) => r.criticalViolations > 0).length ?? null;
    attempt.i1ViolatingReps = attempt.i1?.reps.filter((r) => r.criticalViolations > 0).length ?? null;
    if (attempt.i2) attempt.i2 = { reps: attempt.i2.reps, badges: attempt.i2.batch.badges };
    if (attempt.i1) attempt.i1 = { reps: attempt.i1.reps, badges: attempt.i1.batch.badges };
    attempts.push(attempt);
    final = attempt;
    save();
    if ((attempt.i2ViolatingReps ?? 0) >= 1) break;
    log('app-memory-lock 2대 위반 0회 → D8 정책대로 after-read:30 주입으로 다시 시도');
  }
  const compare = final?.batchIds.i1 && final?.batchIds.i2 ? await compareEvidence([final.batchIds.i1, final.batchIds.i2], 'topology.appInstances') : null;
  const axisOk =
    !!compare && compare.status === 200 && compare.comparable === true && compare.diffs.some((d) => d.kind === 'axis' && d.path === 'topology.appInstances');
  const pass =
    !!final &&
    final.i1?.reps.length === 3 &&
    final.i1ViolatingReps === 0 &&
    (final.i2ViolatingReps ?? 0) >= 1 &&
    axisOk;
  // 다시 돌리면 이전 판정·시도를 지우지 않고 previousAttempts 로 옮긴다(실패 기록이 새 티켓 근거).
  const prev = evidence.criteria.c3;
  evidence.criteria.c3 = {
    previousAttempts: prev ? [...(prev.previousAttempts ?? []), { ...prev, previousAttempts: undefined }] : [],
    title: '기준 3: app-memory-lock 1대 3회 위반 0 · 2대 위반 ≥1, axis=topology.appInstances 한 비교',
    pass,
    injected: final?.injected ?? null,
    compare,
    failure: pass
      ? null
      : !final?.batchIds.i1
        ? '1대 대조 배치가 만들어지지 않았다(singleInstanceRequest 참고). 비교 URL 을 만들 수 없다'
        : null,
    attempts,
  };
  save();
}

/** 기준 4 */
async function c4() {
  const src = evidence.criteria.c2?.attempts?.at(-1);
  if (!src?.batchIds) {
    evidence.criteria.c4 = { title: '기준 4', pass: false, failure: 'c12 결과가 없다(같은 --out 으로 c12 를 먼저 돌린다)' };
    return save();
  }
  let completeness, RunMetadataV1Schema;
  try {
    ({ completeness } = await import(path.join(REPO_ROOT, 'orchestrator/dist/metadata/completeness.js')));
    ({ RunMetadataV1Schema } = await import(path.join(REPO_ROOT, 'engine/contracts/dist/index.js')));
  } catch (e) {
    throw new Error(`orchestrator/contracts dist 가 없다. 먼저 pnpm build:libs && pnpm --filter @under-load/orchestrator exec tsc -p tsconfig.json (${e.message})`);
  }
  const perRun = [];
  for (const batchId of Object.values(src.batchIds)) {
    const b = await getJson(`/batches/${encodeURIComponent(batchId)}`);
    for (const runId of b.runIds) {
      const { metadata } = await getJson(`/runs/${encodeURIComponent(runId)}`);
      const rep = completeness(metadata);
      const schema = RunMetadataV1Schema.safeParse(metadata);
      perRun.push({
        runId,
        missing: rep.missing,
        allowedNull: rep.allowedNull,
        schemaOk: schema.success,
        schemaIssues: schema.success ? [] : schema.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
  }
  const missingTotal = perRun.reduce((n, r) => n + r.missing.length, 0);

  // vus 만 다른 배치(no-lock 1회)
  const base = src.request;
  const request = { ...base, strategies: ['no-lock'], reps: 1, load: { ...base.load, vus: 20 }, prediction: '기준 4: vus 만 다른 대조 배치' };
  const s = await runSession(request, '기준4(vus 20)');
  const other = batchOf(s.accepted, 'no-lock', 2);
  const compare = other ? await compareEvidence([src.batchIds['no-lock'], other], null) : null;
  const blocking = compare?.diffs?.filter((d) => d.kind === 'blocking') ?? [];
  const pass = missingTotal === 0 && perRun.every((r) => r.schemaOk) && perRun.length === 9 && compare?.comparable === false && blocking.some((d) => d.path === 'load.vus');
  evidence.criteria.c4 = {
    title: '기준 4: 같은 설정 3회 메타데이터 미채움 0, vus 만 다른 두 배치 비교 → comparable=false',
    pass,
    completeness: { runs: perRun.length, missingTotal, perRun },
    vusOnly: { batchId: other, sessionId: s.accepted?.sessionId ?? null, compare, blockingPaths: blocking.map((d) => d.path) },
    control: { note: '같은 조건(strategy 만 다름) 비교는 기준 1 compare.comparable', comparable: evidence.criteria.c1?.compare?.comparable ?? null },
  };
  save();
}

/** open 배치의 반복마다 failures.total = http + (droppedCountedAsFailure ? dropped : 0) 인지. */
async function openFailureFacts(batchId) {
  const b = await getJson(`/batches/${encodeURIComponent(batchId)}`);
  const f = b.failures;
  return b.runIds.map((runId, i) => ({
    runId,
    http: f.http[i],
    dropped: f.dropped[i],
    droppedCountedAsFailure: f.droppedCountedAsFailure[i],
    total: f.total[i],
    sumHolds: f.total[i] === f.http[i] + (f.droppedCountedAsFailure[i] ? f.dropped[i] : 0),
    exercised: f.droppedCountedAsFailure[i] === true && f.dropped[i] > 0,
  }));
}

/** 기준 5: 실행 전에 k6 를 cpus 0.2 override 로 다시 띄워 둔다. */
async function c5() {
  // open 400rps 로는 0.2코어에서도 평균 0.68·스로틀 0.197 로 임계 바로 아래였다(첫 시도 기록). closed·think 0 이면
  // k6 가 쉬지 않고 요청을 만들어 limit 를 다 쓴다.
  const request = g02Request({
    strategies: ['conditional-update'],
    reps: 1,
    load: { ...g02Request().load, duration: '20s', warmup: '5s' },
    prediction: '기준 5: k6 cpus 0.2 → 무효(k6 CPU)',
  });
  const s = await runSession(request, '기준5(k6 cpus 0.2)');
  const batchId = batchOf(s.accepted, 'conditional-update', 2);
  const facts = batchId ? await batchFacts(batchId) : null;
  const runId = facts?.reps[0]?.runId;
  const md = runId ? (await getJson(`/runs/${encodeURIComponent(runId)}`)).metadata : null;
  const k6Cpus = md?.limits?.k6?.cpus ?? null;
  const reasons = md?.validity?.reasons ?? [];
  const pass = k6Cpus !== null && k6Cpus <= 0.25 && md?.validity?.valid === false && reasons.some((r) => r.includes('k6 CPU'));
  const prev = evidence.criteria.c5;
  evidence.criteria.c5 = {
    previousAttempts: prev ? [...(prev.previousAttempts ?? []), { ...prev, previousAttempts: undefined }] : [],
    title: '기준 5: k6 cpus 0.2 로 포화시킨 실행이 무효(k6 CPU 사유)',
    pass,
    batchId,
    runId,
    limitsK6: md?.limits?.k6 ?? null,
    request,
    validity: md?.validity ?? null,
    k6: md?.k6 ?? null,
    failure: k6Cpus !== null && k6Cpus > 0.25 ? `k6 limit 이 ${k6Cpus} 다. override 를 적용하고 다시 돌린다` : null,
  };
  save();
}

/** 기준 6 */
async function c6() {
  const runsOut = [];
  // (a) 주입 없는 open: maxVUs ≥ rate×timeout 이라 dropped 가 생기면 실패로 합산된다.
  const a = await runSession(
    g02Request({ strategies: ['conditional-update'], reps: 1, load: openLoad(200, 50, 400, '2s'), prediction: '기준 6(a): open, 주입 없음' }),
    '기준6(a)',
  );
  const aId = batchOf(a.accepted, 'conditional-update', 2);
  if (aId) runsOut.push({ case: 'open 200rps, 주입 없음', batchId: aId, reps: await openFailureFacts(aId) });
  // (b) dropped 유도: row-lock + after-read 300ms 로 VU 가 응답을 기다리며 묶이게 한다. maxVUs = rate×timeout(100×1s).
  const b = await runSession(
    g02Request({
      strategies: ['row-lock'],
      reps: 1,
      load: openLoad(100, 20, 100, '1s'),
      injectDelay: [{ point: 'after-read', ms: 300 }],
      prediction: '기준 6(b): dropped 유도(주입됨)',
    }),
    '기준6(b)',
  );
  const bId = batchOf(b.accepted, 'row-lock', 2);
  if (bId) runsOut.push({ case: 'open 100rps, row-lock + after-read:300(주입됨), maxVUs=rate×timeout', batchId: bId, reps: await openFailureFacts(bId) });
  const all = runsOut.flatMap((r) => r.reps);
  const pass = all.length > 0 && all.every((r) => r.sumHolds) && all.some((r) => r.exercised);
  evidence.criteria.c6 = {
    title: '기준 6: open 실행 failures.total = http + dropped(droppedCountedAsFailure)',
    pass,
    runs: runsOut,
    failure: pass ? null : all.some((r) => r.exercised) ? '합산식이 맞지 않는 반복이 있다' : 'dropped>0 이면서 실패로 합산되는 반복이 없다(합산을 실제로 확인 못 함)',
  };
  save();
}

/** 노트 재료: G02 PG 락 프로브 on/off 대조. 끄는 쪽도 intervalMs 를 같게 둬서 enabled 만 다르게 한다. */
async function probe() {
  const strategies = ['row-lock', 'advisory-xact-lock'];
  const sessions = {};
  for (const enabled of [true, false]) {
    const request = g02Request({ strategies, pgProbe: { enabled, intervalMs: 1000 }, prediction: `PG 락 프로브 ${enabled ? 'on' : 'off'}` });
    const s = await runSession(request, `프로브 ${enabled ? 'on' : 'off'}`);
    sessions[enabled ? 'on' : 'off'] = { sessionId: s.accepted?.sessionId ?? null, accepted: s.accepted, status: s.status, response: s.accepted ? undefined : s.response };
  }
  const perStrategy = {};
  for (const st of strategies) {
    const on = batchOf(sessions.on.accepted, st, 2);
    const off = batchOf(sessions.off.accepted, st, 2);
    if (!on || !off) continue;
    const summarize = async (id) => {
      const f = await batchFacts(id);
      return {
        batchId: id,
        throughputRps: f.batch.throughputRps,
        latencyMs: f.batch.latencyMs,
        failures: f.batch.failures,
        violations: f.reps.map((r) => r.criticalViolations),
        valid: f.reps.map((r) => r.valid),
        invalidReasons: f.reps.map((r) => r.invalidReasons),
        probeLines: await Promise.all(
          f.batch.runIds.map(async (runId) => {
            const r = await api('GET', `/runs/${encodeURIComponent(runId)}/artifacts/probe.ndjson`);
            return r.status === 200 ? r.text.split('\n').filter(Boolean).length : 0;
          }),
        ),
      };
    };
    perStrategy[st] = { on: await summarize(on), off: await summarize(off), compare: await compareEvidence([on, off], 'pgProbe.enabled') };
  }
  evidence.notes.g02Probe = { title: 'G02 PG 락 프로브 on/off 대조(노트 재료)', sessions, perStrategy };
  save();
}

/** 노트 재료 + T-135 AC-4: G01 5 strategy. */
async function g01() {
  const scenarios = await getJson('/scenarios');
  const g = scenarios.find((s) => s.id === 'g01-shared-document');
  const strategies = g.strategies.map((s) => s.id);
  const request = {
    scenario: 'g01-shared-document',
    strategies,
    strategyParams: {},
    appInstances: [2],
    includeMemoryLockSingle: false,
    reps: 3,
    load: {
      model: 'closed',
      profile: 'constant',
      vus: 20,
      rate: null,
      preAllocatedVUs: null,
      maxVUs: null,
      duration: '10s',
      warmup: '5s',
      thinkTimeMs: [0, 0],
      requestTimeout: '10s',
    },
    data: { seed: 42, seedOptions: {}, distribution: { kind: 'uniform' } },
    scenarioParams: {},
    instrumentation: 'metrics',
    injectDelay: [],
    prediction: 'naive-overwrite·blind-retry 는 lost update, 나머지는 0',
    label: 'T-140 G01',
  };
  const s = await runSession(request, 'G01 5 strategy');
  const COUNTERS = ['g01_success', 'g01_conflict_409', 'g01_locked_423', 'g01_failed'];
  const perStrategy = {};
  for (const st of strategies) {
    const id = batchOf(s.accepted, st, 2);
    if (!id) continue;
    const f = await batchFacts(id);
    const counters = [];
    for (const runId of f.batch.runIds) {
      const r = await api('GET', `/runs/${encodeURIComponent(runId)}/artifacts/summary.json`);
      const metrics = r.json?.metrics ?? {};
      counters.push(Object.fromEntries(COUNTERS.map((c) => [c, metrics[c]?.values?.count ?? metrics[c]?.count ?? null])));
    }
    perStrategy[st] = {
      batchId: id,
      violations: f.reps.map((r) => r.criticalViolations),
      violated: f.reps.map((r) => r.violatedInvariants),
      valid: f.reps.map((r) => r.valid),
      invalidReasons: f.reps.map((r) => r.invalidReasons),
      throughputRps: f.batch.throughputRps,
      latencyMs: f.batch.latencyMs.success,
      failures: f.batch.failures,
      counters,
    };
  }
  const present = Object.values(perStrategy).flatMap((p) => p.counters);
  const seen = Object.fromEntries(COUNTERS.map((c) => [c, present.some((x) => x[c] !== null)]));
  evidence.notes.g01 = {
    title: 'G01 5 strategy × 3회(노트 재료) + T-135 AC-4',
    sessionId: s.accepted?.sessionId ?? null,
    request,
    t135ac4: { pass: Object.values(seen).every(Boolean), countersSeenInSomeSummary: seen },
    perStrategy,
  };
  save();
}

// ───────────────────────────── 실행 ─────────────────────────────

const STEP_FN = { c12, c3, c4, c5, c6, probe, g01 };

const health = await getJson('/health');
let hostGit = null;
try {
  hostGit = {
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() !== '',
  };
} catch {
  /* git 없음 */
}
evidence.git ??= { orchestratorHealth: health.gitSha, host: hostGit, note: '메타데이터 git 은 /repo 마운트가 worktree 면 GIT_SHA/GIT_DIRTY 폴백 값이다' };
log(`오케스트레이터 ${opts.base} gitSha=${health.gitSha} → ${path.relative(REPO_ROOT, outFile)}`);

for (const step of steps) {
  log(`── ${step} ──`);
  try {
    await STEP_FN[step]();
  } catch (e) {
    log(`${step} 실패: ${e.stack ?? e}`);
    (step in { probe: 1, g01: 1 } ? evidence.notes : evidence.criteria)[`${step}Error`] = String(e?.stack ?? e);
    save();
  }
}
invocation.endedAt = new Date().toISOString();
save();

const AC = {
  'AC-1 (기준 1·2)': ['c1', 'c2'],
  'AC-2 (기준 3)': ['c3'],
  'AC-3 (기준 4)': ['c4'],
  'AC-4 (기준 5·6)': ['c5', 'c6'],
};
console.log('\n기준별 판정');
for (const [k, v] of Object.entries(evidence.criteria)) if (v && typeof v === 'object' && 'pass' in v) console.log(`  ${k.padEnd(4)} ${v.pass ? 'PASS' : 'FAIL'}  ${v.title}`);
for (const [ac, ids] of Object.entries(AC)) {
  const got = ids.map((id) => evidence.criteria[id]?.pass);
  console.log(`  ${ac}: ${got.some((x) => x === undefined) ? '미실행 포함' : got.every(Boolean) ? 'PASS' : 'FAIL'}`);
}
if (evidence.notes.g01) console.log(`  T-135 AC-4(g01_* 카운터): ${evidence.notes.g01.t135ac4.pass ? 'PASS' : 'FAIL'}`);
console.log(`\n증거: ${path.relative(REPO_ROOT, outFile)}`);
