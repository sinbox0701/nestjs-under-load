#!/usr/bin/env node
// 실측 → learn.yaml `measured` 채우기 (DESIGN §5.4: measured는 오케스트레이터가 채운다. 0단계는 run.mjs 세션 결과로 이 스크립트가 한다).
//
//   node scripts/measured.mjs --session <sessionId>            # 어떤 outcome에 무엇을 쓸지 출력만
//   node scripts/measured.mjs --session <sessionId> --write    # learn.yaml에 기록
//   node scripts/measured.mjs --session <sessionId> --runs <runs 디렉터리>   # 다른 runs/ 를 읽는다(기본 REPO_ROOT/runs)
//
// 입력: runs/_sessions/<id>.json(0단계) 이 있으면 그 세션의 metadata.json 들(v0·v1)을, 없으면 runs/_meta/lab.sqlite(1단계) 의 세션 실행 행을 읽는다.
// 판정 규칙은 orchestrator/src/learn/measured.ts 와 같다(둘을 같이 고친다).
//
// 규칙
// - 세션의 batch(strategy × 앱 대수, 3회 반복)마다 learn.yaml situation 하나에 대응시킨다.
//   대응 조건: instances = 앱 대수, load(open 이면 rate, closed 이면 vus)·data(products·stockPerProduct 또는 documents, 분포 uniform/zipf s)·
//   scenarioParams.editMs 가 같고 chaos 없음. situation 에 값이 없는 키는 batch 에도 없어야 한다(null 끼리만 같다 — 모르면 채우지 않는다).
//   strategy 파라미터: manifest 기본값에 덧씌운 실효 파라미터가 같아야 한다. situation.params[strategy] 가 있으면 그 값이, 없으면(params 없음 또는 다른 strategy 용) 기본값이 기준이다.
//   경합 창 지연 주입(interventions의 inject-delay after-read)은 situation `injected.contentionWindowMs`와 ms가 같아야 한다(없으면 둘 다 0).
//   그 밖의 개입(after-lock 등)이 있으면 대응하지 않는다.
//   load.shape·duration은 0단계 run.mjs가 constant만 지원하므로 비교하지 않고, 차이는 conditions에 적는다.
// - 무효(validity.valid=false) 실행은 집계에서 뺀다. 유효 실행이 없으면 그 batch는 쓰지 않는다.
// - 기존 measured는 덮어쓴다. 실행하지 않은 situation의 measured는 건드리지 않는다(null 유지).
// - learn.yaml 전체를 다시 직렬화하면 접힌 문자열이 재배치되므로, 해당 outcome의 `measured:` 블록만 텍스트로 바꾸고 다시 파싱해 확인한다.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import YAML from 'yaml';

import { REPO_ROOT, RUNS_DIR, SCENARIOS, defaultStrategyParams, durationToSeconds } from './run.mjs';

const round = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** 값 목록 → { median, min, max } (null 제외) */
export function spread(values, digits = 1) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return { median: round(mid, digits), min: round(v[0], digits), max: round(v[v.length - 1], digits) };
}

const numOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * 실행 메타데이터 하나 → 핵심 수치. k6 모양 둘을 받는다.
 * - v1: { requests, throughputRps, httpFailures, dropped, latencyMs: { success: { p95 } } }
 * - 0단계 v0: { httpReqs, failed, droppedIterations, latencyMs: { p95 } }
 * 처리량 = 본 실행 구간 응답 수 / 본 실행 길이(초). v1 은 k6.throughputRps 그대로, v0 는 httpReqs / duration.
 */
export function runFacts(md) {
  const k6 = md.k6 ?? {};
  const durationSec = durationToSeconds(md.load.duration);
  const requests = numOf(k6.requests) ?? numOf(k6.httpReqs);
  const dropped = numOf(k6.dropped) ?? numOf(k6.droppedIterations) ?? 0;
  const attempted = (requests ?? 0) + dropped;
  // dropped는 maxVUs가 충분할 때만 실패로 센다(DESIGN §7.2). 부족하면 애초에 무효 실행이다.
  const failed = (numOf(k6.httpFailures) ?? numOf(k6.failed) ?? 0) + (md.validity?.droppedCountedAsFailure ? dropped : 0);
  const lat = k6.latencyMs ?? {};
  const violations = Object.fromEntries((md.invariants ?? []).filter((i) => i.severity !== 'info').map((i) => [i.id, i.violations]));
  const ledger = (md.invariants ?? []).find((i) => i.id === 'ledger-matches-k6')?.value ?? md.ledgerVsClient?.ledger ?? null;
  return {
    runId: md.runId,
    valid: md.validity?.valid !== false,
    invalidReasons: md.validity?.reasons ?? [],
    violations,
    violationTotal: Object.values(violations).reduce((a, b) => a + (b ?? 0), 0),
    ledgerSuccess: ledger?.success ?? null,
    throughputRps: numOf(k6.throughputRps) ?? (requests != null && durationSec > 0 ? requests / durationSec : null),
    p95Ms: numOf(lat.success?.p95) ?? numOf(lat.p95),
    failRatePct: attempted > 0 ? (failed / attempted) * 100 : null,
    k6CpuAvgRatio: md.validity?.k6CpuAvgRatio ?? null,
  };
}

/** 모든 strategy 공통 경합 창 지점. situation `injected.contentionWindowMs`가 이 지점의 지연이다(DESIGN §6.5). */
export const CONTENTION_POINT = 'after-read';

const isContentionWindow = (d) => d.type === 'inject-delay' && d.point === CONTENTION_POINT;

/** batch(같은 strategy × 앱 대수의 반복들) → situation 대응 키. v0 와 v1(seedOptions·scenarioParams·`zipf(1.1)`)을 둘 다 받는다. */
export function batchKey(md) {
  const interventions = md.interventions ?? [];
  const dist = String(md.data?.distribution ?? 'uniform');
  const zipf = /^zipf\(([\d.]+)\)$/.exec(dist);
  const rows = md.data?.rows ?? {};
  const seed = md.data?.seedOptions ?? {};
  return {
    strategy: md.strategy.id,
    params: md.strategy.params ?? {},
    appInstances: md.topology.appInstances,
    model: md.load.model,
    rate: md.load.rate ?? null,
    vus: md.load.vus ?? null,
    products: rows.products ?? seed.products,
    stockPerProduct: md.data?.stockPerProduct ?? seed.stockPerProduct,
    documents: rows.documents ?? seed.documents,
    editMs: md.data?.scenarioParams?.editMs,
    distribution: zipf ? 'zipf' : dist,
    zipfS: zipf ? Number(zipf[1]) : null,
    chaos: interventions.every(isContentionWindow) && (md.chaos ?? []).length === 0 ? 'none' : 'some',
    contentionWindowMs: interventions.filter(isContentionWindow).reduce((a, d) => a + d.ms, 0),
  };
}

const sortedJson = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/**
 * learn.yaml situations 중 batch 조건과 맞는 것. 0개나 2개 이상이면 null(쓰지 않음). 값이 없는 키는 null 로 보고 null 끼리만 같다.
 * `defaults` = { strategyId: manifest 기본 파라미터 }. 양쪽 모두 기본값을 덧씌운 실효 파라미터로 비교한다(기록에 기본값이 들어 있든 없든 같게 본다).
 */
export function matchSituation(situations, key, defaults = {}) {
  const hits = situations.filter((s) => {
    const kind = s.data?.distribution?.kind ?? 'uniform';
    const sameLoad = s.load?.model === key.model && (key.model === 'open' ? s.load?.rate === key.rate : (s.load?.vus ?? null) === (key.vus ?? null));
    // strategy 파라미터: 이 strategy 용 params 가 situation 에 있으면 같아야 하고, 없으면 batch 쪽도 비어 있어야 한다
    const base = (key.strategy !== undefined ? defaults[key.strategy] : undefined) ?? {};
    const wantParams = { ...base, ...((key.strategy !== undefined ? s.params?.[key.strategy] : undefined) ?? {}) };
    return (
      s.instances === key.appInstances &&
      sameLoad &&
      (s.data?.products ?? null) === (key.products ?? null) &&
      (s.data?.stockPerProduct ?? null) === (key.stockPerProduct ?? null) &&
      (s.data?.documents ?? null) === (key.documents ?? null) &&
      (s.scenarioParams?.editMs ?? null) === (key.editMs ?? null) &&
      kind === key.distribution &&
      (kind !== 'zipf' || s.data.distribution.s === key.zipfS) &&
      (s.chaos ?? 'none') === 'none' &&
      key.chaos === 'none' &&
      (s.injected?.contentionWindowMs ?? 0) === (key.contentionWindowMs ?? 0) &&
      sortedJson({ ...base, ...(key.params ?? {}) }) === sortedJson(wantParams)
    );
  });
  return hits.length === 1 ? hits[0] : null;
}

function conditionsText(md, situation, reps, defaults = {}) {
  const h = md.host ?? {};
  const memGiB = h.dockerMemBytes ? (h.dockerMemBytes / 2 ** 30).toFixed(1) : '?';
  const key = batchKey(md);
  const v1 = (md.schemaVersion ?? 0) >= 1;
  const base = defaults[key.strategy] ?? {};
  const nonDefault = Object.fromEntries(Object.entries(key.params).filter(([k, v]) => sortedJson(v) !== sortedJson(base[k])));
  const shapeNote =
    situation.load?.shape && situation.load.shape !== 'constant' ? (v1 ? `(상황 정의 shape=${situation.load.shape}, 실행은 constant)` : `(상황 정의 shape=${situation.load.shape}, 0단계 run.mjs는 constant만 지원)`) : '';
  const loadText =
    md.load.model === 'open'
      ? `open constant-arrival-rate ${md.load.rate}/s × ${md.load.duration}${shapeNote} · 웜업 ${md.load.warmup} · ${reps}회 반복 · k6 timeout ${md.timeouts?.k6RequestMs}ms · maxVUs ${md.load.maxVUs}`
      : `closed constant-vus ${md.load.vus} × ${md.load.duration}${shapeNote} · 웜업 ${md.load.warmup} · ${reps}회 반복 · k6 timeout ${md.timeouts?.k6RequestMs}ms`;
  const distText = key.distribution === 'zipf' ? `zipf(${key.zipfS}) 분포` : '균등 분포';
  const dataText =
    key.documents != null
      ? `문서 ${key.documents}개, ${distText}, 편집 ${key.editMs ?? '?'}ms`
      : `상품 ${key.products}개 × 재고 ${key.stockPerProduct}, ${distText}, 요청당 ${md.data?.qtyPerOrder ?? md.data?.scenarioParams?.qty ?? '?'}개`;
  return [
    `로컬 맥(${h.cpu ?? '?'}, Docker ${h.dockerNcpu ?? '?'} vCPU / ${memGiB} GiB, profile ${md.profile}, cpuset ${md.limits?.app?.cpuset ?? 'none'})`,
    `app ${md.topology.appInstances}대(각 cpus ${md.limits?.app?.cpus ?? '?'}) · postgres cpus ${md.limits?.postgres?.cpus ?? '?'} · nginx round-robin`,
    loadText,
    dataText,
    ...(key.contentionWindowMs > 0 ? [`경합 창 지연 ${key.contentionWindowMs}ms 주입됨(${CONTENTION_POINT}: 모든 strategy의 읽기 후 쓰기 전 같은 지점, 트랜잭션 안)`] : []),
    ...(Object.keys(nonDefault).length > 0 ? [`기본값과 다른 strategy 파라미터 ${JSON.stringify(nonDefault)}`] : []),
    '절대 수치가 아니라 같은 조건의 strategy 간 상대 비교용',
  ].join(' · ');
}

/** batch의 실행 메타데이터 목록 → learn.yaml measured 객체 */
export function buildMeasured(mds, situation, defaults = {}) {
  const facts = mds.map(runFacts);
  const valid = facts.filter((f) => f.valid);
  if (valid.length === 0) return null;
  const md = mds[0];
  const thr = spread(valid.map((f) => f.throughputRps));
  const p95 = spread(valid.map((f) => f.p95Ms), 2);
  const fail = spread(valid.map((f) => f.failRatePct), 2);
  const withViolation = valid.filter((f) => f.violationTotal > 0).length;
  const invIds = Object.keys(valid[0].violations);
  const violatedIds = invIds.filter((id) => valid.some((f) => (f.violations[id] ?? 0) > 0));
  const key = batchKey(md);
  const totalStock = key.products != null && key.stockPerProduct != null ? key.products * key.stockPerProduct : null;
  const fmtRange = (s, unit) => (s ? `${s.median}${unit}(${s.min}~${s.max})` : '?');
  const violationText =
    withViolation === 0
      ? `위반 0 (${valid.length}/${valid.length}회)`
      : `위반 ${withViolation}/${valid.length}회 발생(${violatedIds.map((id) => `${id} ${key.documents != null ? '' : '상품 '}${valid.map((f) => f.violations[id] ?? 0).join('·')}${key.documents != null ? '건' : '개'}`).join(', ')})`;
  const ledgerText = `원장 성공 ${valid.map((f) => f.ledgerSuccess ?? '?').join('·')}건${totalStock != null ? ` / 총재고 ${totalStock}` : ''}`;
  const excluded = facts.length - valid.length;
  const windowMs = key.contentionWindowMs;
  return {
    run: md.batchId,
    runs: valid.map((f) => f.runId),
    ...(windowMs > 0 ? { injected: { contentionWindowMs: windowMs } } : {}),
    summary: [
      ...(windowMs > 0 ? [`경합 창 ${windowMs}ms 주입됨`] : []),
      violationText,
      ledgerText,
      `처리량 ${fmtRange(thr, ' req/s')}`,
      `p95 ${fmtRange(p95, 'ms')}`,
      `실패율 ${fmtRange(fail, '%')}`,
      ...(excluded ? [`무효 ${excluded}회 제외`] : []),
      '로컬 맥 상대 비교',
    ].join(' · '),
    violations: Object.fromEntries(invIds.map((id) => [id, valid.map((f) => f.violations[id])])),
    ledgerSuccess: valid.map((f) => f.ledgerSuccess),
    throughputRps: thr,
    p95Ms: p95,
    failRatePct: fail,
    k6CpuAvgRatio: spread(valid.map((f) => f.k6CpuAvgRatio), 3),
    conditions: conditionsText(md, situation, facts.length, defaults),
  };
}

/**
 * learn.yaml 텍스트에서 (strategy, situation) outcome의 `measured:` 블록만 바꾼다.
 * outcome 항목은 `  - strategy: X` 로 시작하고, measured는 4칸 들여쓰기 키다(learn.yaml 규약).
 */
export function replaceMeasured(text, strategy, situation, measured) {
  const lines = text.split('\n');
  let inOutcomes = false;
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) inOutcomes = /^outcomes:\s*$/.test(line);
    if (!inOutcomes) continue;
    let m;
    if ((m = /^ {2}- strategy:\s*(\S+)\s*$/.exec(line))) cur = { strategy: m[1], situation: null };
    else if (cur && (m = /^ {4}situation:\s*(\S+)\s*$/.exec(line))) cur.situation = m[1];
    else if (cur && cur.strategy === strategy && cur.situation === situation && /^ {4}measured:/.test(line)) {
      let end = i + 1;
      while (end < lines.length && /^ {5,}\S/.test(lines[end])) end++;
      const doc = new YAML.Document({ measured });
      // 배열과 {median,min,max} 같은 작은 맵은 한 줄(flow)로
      YAML.visit(doc, {
        Seq: (_, n) => void (n.flow = true),
        Map: (_, n) => void (n !== doc.contents && n.items.every((it) => YAML.isScalar(it.value)) && n.items.length <= 4 && (n.flow = true)),
      });
      const block = doc
        .toString({ lineWidth: 0 })
        .trimEnd()
        .split('\n')
        .map((l) => `    ${l}`);
      lines.splice(i, end - i, ...block);
      return lines.join('\n');
    }
  }
  throw new Error(`learn.yaml에 outcome ${strategy} × ${situation}의 measured 키가 없습니다`);
}

/** 세션 → [{ strategy, situation, measured } | { skip }] */
export function planMeasured(session, learn, readMetadata, defaults = {}) {
  const batches = new Map();
  for (const r of session.runs) {
    const md = readMetadata(r.runId);
    if (!batches.has(md.batchId)) batches.set(md.batchId, []);
    batches.get(md.batchId).push(md);
  }
  const out = [];
  for (const [batchId, mds] of batches) {
    const key = batchKey(mds[0]);
    const situation = matchSituation(learn.situations, key, defaults);
    if (!situation) {
      out.push({ batchId, skip: `대응하는 situation 없음(${JSON.stringify(key)})` });
      continue;
    }
    const measured = buildMeasured(mds, situation, defaults);
    if (!measured) {
      out.push({ batchId, skip: '유효한 실행 없음' });
      continue;
    }
    out.push({ batchId, strategy: key.strategy, situation: situation.id, measured });
  }
  return out;
}

/** 세션 → { scenario, readMetadata, runs }. `_sessions/<id>.json`(0단계)이 있으면 그것, 없으면 lab.sqlite(1단계)의 실행 행. */
export function loadSession(runsDir, sessionId) {
  const file = path.join(runsDir, '_sessions', `${sessionId}.json`);
  if (existsSync(file)) {
    const session = JSON.parse(readFileSync(file, 'utf8'));
    return { scenario: session.scenario, session, readMetadata: (runId) => JSON.parse(readFileSync(path.join(runsDir, runId, 'metadata.json'), 'utf8')) };
  }
  const dbFile = path.join(runsDir, '_meta', 'lab.sqlite');
  if (!existsSync(dbFile)) throw new Error(`세션 ${sessionId}: ${file} 도 ${dbFile} 도 없습니다`);
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db.prepare('SELECT run_id, scenario, metadata_json FROM runs WHERE session_id = ? AND metadata_json IS NOT NULL ORDER BY batch_id, repetition').all(sessionId);
    if (rows.length === 0) throw new Error(`세션 ${sessionId} 의 실행이 lab.sqlite 에 없습니다`);
    const byId = new Map(rows.map((r) => [r.run_id, JSON.parse(r.metadata_json)]));
    return { scenario: rows[0].scenario, session: { runs: rows.map((r) => ({ runId: r.run_id })) }, readMetadata: (runId) => byId.get(runId) };
  } finally {
    db.close();
  }
}

async function main() {
  const { values } = parseArgs({ options: { session: { type: 'string' }, runs: { type: 'string' }, write: { type: 'boolean' } } });
  if (!values.session) throw new Error('--session <sessionId> 가 필요합니다 (runs/_sessions/<id>.json 또는 runs/_meta/lab.sqlite)');
  const { scenario, session, readMetadata } = loadSession(values.runs ? path.resolve(values.runs) : RUNS_DIR, values.session);
  const learnPath = path.join(REPO_ROOT, SCENARIOS[scenario] ?? `packs/generic/${scenario}`, 'learn.yaml');
  let text = readFileSync(learnPath, 'utf8');
  const learn = YAML.parse(text);
  const manifest = YAML.parse(readFileSync(path.join(path.dirname(learnPath), 'manifest.yaml'), 'utf8'));
  const defaults = Object.fromEntries((manifest.strategies ?? []).map((st) => [st.id, defaultStrategyParams(manifest, st.id)]));
  const plan = planMeasured(session, learn, readMetadata, defaults);
  for (const p of plan) {
    if (p.skip) {
      console.log(`- ${p.batchId}: 건너뜀 — ${p.skip}`);
      continue;
    }
    console.log(`- ${p.strategy} × ${p.situation}: ${p.measured.summary}`);
    text = replaceMeasured(text, p.strategy, p.situation, p.measured);
  }
  // 다시 파싱해 기록한 값이 그대로 읽히는지 확인
  const check = YAML.parse(text);
  for (const p of plan.filter((x) => !x.skip)) {
    const o = check.outcomes.find((x) => x.strategy === p.strategy && x.situation === p.situation);
    if (JSON.stringify(o?.measured) !== JSON.stringify(p.measured)) throw new Error(`재파싱 불일치: ${p.strategy} × ${p.situation}`);
  }
  if (values.write) {
    writeFileSync(learnPath, text);
    console.log(`기록: ${path.relative(REPO_ROOT, learnPath)}`);
  } else {
    console.log('(--write 없이 실행: 파일을 바꾸지 않음)');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`실패: ${e.message}`);
    process.exit(1);
  });
}
