#!/usr/bin/env node
// 실측 → learn.yaml `measured` 채우기 (DESIGN §5.4: measured는 오케스트레이터가 채운다. 0단계는 run.mjs 세션 결과로 이 스크립트가 한다).
//
//   node scripts/measured.mjs --session <sessionId>            # 어떤 outcome에 무엇을 쓸지 출력만
//   node scripts/measured.mjs --session <sessionId> --write    # learn.yaml에 기록
//
// 규칙
// - 세션의 batch(strategy × 앱 대수, 3회 반복)마다 learn.yaml situation 하나에 대응시킨다.
//   대응 조건: instances = 앱 대수, load.model = open, load.rate = 도착률, data(products·stockPerProduct·uniform 분포)가 같고 chaos 없음.
//   load.shape·duration은 0단계 run.mjs가 constant만 지원하므로 비교하지 않고, 차이는 conditions에 적는다.
// - 무효(validity.valid=false) 실행은 집계에서 뺀다. 유효 실행이 없으면 그 batch는 쓰지 않는다.
// - 기존 measured는 덮어쓴다. 실행하지 않은 situation의 measured는 건드리지 않는다(null 유지).
// - learn.yaml 전체를 다시 직렬화하면 접힌 문자열이 재배치되므로, 해당 outcome의 `measured:` 블록만 텍스트로 바꾸고 다시 파싱해 확인한다.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import YAML from 'yaml';

import { REPO_ROOT, RUNS_DIR, SCENARIOS, durationToSeconds } from './run.mjs';

const round = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** 값 목록 → { median, min, max } (null 제외) */
export function spread(values, digits = 1) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return { median: round(mid, digits), min: round(v[0], digits), max: round(v[v.length - 1], digits) };
}

/** 실행 메타데이터 하나 → 핵심 수치 */
export function runFacts(md) {
  const k6 = md.k6 ?? {};
  const durationSec = durationToSeconds(md.load.duration);
  const dropped = k6.droppedIterations ?? 0;
  const attempted = (k6.httpReqs ?? 0) + dropped;
  // dropped는 maxVUs가 충분할 때만 실패로 센다(DESIGN §7.2). 부족하면 애초에 무효 실행이다.
  const failed = (k6.failed ?? 0) + (md.validity?.droppedCountedAsFailure ? dropped : 0);
  const violations = Object.fromEntries((md.invariants ?? []).filter((i) => i.severity !== 'info').map((i) => [i.id, i.violations]));
  const ledger = (md.invariants ?? []).find((i) => i.id === 'ledger-matches-k6')?.value ?? null;
  return {
    runId: md.runId,
    valid: md.validity?.valid !== false,
    invalidReasons: md.validity?.reasons ?? [],
    violations,
    violationTotal: Object.values(violations).reduce((a, b) => a + (b ?? 0), 0),
    ledgerSuccess: ledger?.success ?? null,
    // 처리량 = 본 실행 구간에 응답을 받은 요청 수 / 본 실행 길이
    throughputRps: k6.httpReqs != null ? k6.httpReqs / durationSec : null,
    p95Ms: k6.latencyMs?.p95 ?? null,
    failRatePct: attempted > 0 ? (failed / attempted) * 100 : null,
    k6CpuAvgRatio: md.validity?.k6CpuAvgRatio ?? null,
  };
}

/** batch(같은 strategy × 앱 대수의 반복들) → situation 대응 키 */
export function batchKey(md) {
  return {
    strategy: md.strategy.id,
    appInstances: md.topology.appInstances,
    model: md.load.model,
    rate: md.load.rate,
    products: md.data.rows.products,
    stockPerProduct: md.data.stockPerProduct,
    distribution: md.data.distribution,
    chaos: (md.interventions ?? []).length === 0 && (md.chaos ?? []).length === 0 ? 'none' : 'some',
  };
}

/** learn.yaml situations 중 batch 조건과 맞는 것. 0개나 2개 이상이면 null(쓰지 않음). */
export function matchSituation(situations, key) {
  const hits = situations.filter(
    (s) =>
      s.instances === key.appInstances &&
      s.load?.model === key.model &&
      s.load?.rate === key.rate &&
      s.data?.products === key.products &&
      s.data?.stockPerProduct === key.stockPerProduct &&
      (s.data?.distribution?.kind ?? 'uniform') === key.distribution &&
      (s.chaos ?? 'none') === 'none' &&
      key.chaos === 'none' &&
      !s.params,
  );
  return hits.length === 1 ? hits[0] : null;
}

function conditionsText(md, situation, reps) {
  const h = md.host ?? {};
  const memGiB = h.dockerMemBytes ? (h.dockerMemBytes / 2 ** 30).toFixed(1) : '?';
  const shapeNote = situation.load?.shape && situation.load.shape !== 'constant' ? `(상황 정의 shape=${situation.load.shape}, 0단계 run.mjs는 constant만 지원)` : '';
  return [
    `로컬 맥(${h.cpu ?? '?'}, Docker ${h.dockerNcpu ?? '?'} vCPU / ${memGiB} GiB, profile ${md.profile}, cpuset ${md.limits?.app?.cpuset ?? 'none'})`,
    `app ${md.topology.appInstances}대(각 cpus ${md.limits?.app?.cpus ?? '?'}) · postgres cpus ${md.limits?.postgres?.cpus ?? '?'} · nginx round-robin`,
    `open constant-arrival-rate ${md.load.rate}/s × ${md.load.duration}${shapeNote} · 웜업 ${md.load.warmup} · ${reps}회 반복 · k6 timeout ${md.timeouts.k6RequestMs}ms · maxVUs ${md.load.maxVUs}`,
    `상품 ${md.data.rows.products}개 × 재고 ${md.data.stockPerProduct}, 균등 분포, 요청당 ${md.data.qtyPerOrder}개`,
    '절대 수치가 아니라 같은 조건의 strategy 간 상대 비교용',
  ].join(' · ');
}

/** batch의 실행 메타데이터 목록 → learn.yaml measured 객체 */
export function buildMeasured(mds, situation) {
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
  const totalStock = md.data.rows.products * md.data.stockPerProduct;
  const fmtRange = (s, unit) => (s ? `${s.median}${unit}(${s.min}~${s.max})` : '?');
  const violationText =
    withViolation === 0
      ? `위반 0 (${valid.length}/${valid.length}회)`
      : `위반 ${withViolation}/${valid.length}회 발생(${violatedIds.map((id) => `${id} 상품 ${valid.map((f) => f.violations[id] ?? 0).join('·')}개`).join(', ')})`;
  const ledgerText = `원장 성공 ${valid.map((f) => f.ledgerSuccess ?? '?').join('·')}건 / 총재고 ${totalStock}`;
  const excluded = facts.length - valid.length;
  return {
    run: md.batchId,
    runs: valid.map((f) => f.runId),
    summary: [
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
    conditions: conditionsText(md, situation, facts.length),
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
export function planMeasured(session, learn, readMetadata) {
  const batches = new Map();
  for (const r of session.runs) {
    const md = readMetadata(r.runId);
    if (!batches.has(md.batchId)) batches.set(md.batchId, []);
    batches.get(md.batchId).push(md);
  }
  const out = [];
  for (const [batchId, mds] of batches) {
    const key = batchKey(mds[0]);
    const situation = matchSituation(learn.situations, key);
    if (!situation) {
      out.push({ batchId, skip: `대응하는 situation 없음(${JSON.stringify(key)})` });
      continue;
    }
    const measured = buildMeasured(mds, situation);
    if (!measured) {
      out.push({ batchId, skip: '유효한 실행 없음' });
      continue;
    }
    out.push({ batchId, strategy: key.strategy, situation: situation.id, measured });
  }
  return out;
}

async function main() {
  const { values } = parseArgs({ options: { session: { type: 'string' }, write: { type: 'boolean' } } });
  if (!values.session) throw new Error('--session <sessionId> 가 필요합니다 (runs/_sessions/<id>.json)');
  const session = JSON.parse(readFileSync(path.join(RUNS_DIR, '_sessions', `${values.session}.json`), 'utf8'));
  const learnPath = path.join(REPO_ROOT, SCENARIOS[session.scenario], 'learn.yaml');
  let text = readFileSync(learnPath, 'utf8');
  const learn = YAML.parse(text);
  const plan = planMeasured(session, learn, (runId) => JSON.parse(readFileSync(path.join(RUNS_DIR, runId, 'metadata.json'), 'utf8')));
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
