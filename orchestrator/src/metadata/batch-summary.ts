// 배치 요약: 반복 실행들의 메타데이터(v1·0단계 v0 모두)에서 BatchSummary 를 만든다.
// 숫자는 metadata.k6 에서 읽는다. v1: { throughputRps, httpFailures, dropped, latencyMs: { success, failed } },
// 0단계 v0: { httpReqRate, failed, droppedIterations, latencyMs: { n, p50, p95, p99 } }(성공·실패 구분 없음 → 전부 success 로 본다).
import { BatchSummarySchema } from '@under-load/contracts';
import type { BatchSummary, RunMetadata } from '@under-load/contracts';

import type { BatchRecord } from '../ports.js';

type Spread = { median: number; min: number; max: number } | null;
type Bag = Record<string, unknown>;

/** 불안정 배지 기준: 처리량 (max-min)/median 이 이 값을 넘으면 unstable. */
export const UNSTABLE_SPREAD_RATIO = 0.2;

const bag = (v: unknown): Bag => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Bag) : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => {
  const n = num(v);
  return n !== null && n >= 0 ? Math.trunc(n) : 0;
};

export function spread(values: (number | null)[]): Spread {
  const xs = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = xs.length >> 1;
  const median = xs.length % 2 === 1 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
  return { median, min: xs[0]!, max: xs[xs.length - 1]! };
}

type Pct = { p50: number | null; p95: number | null; p99: number | null; n: number };

function latencyOf(k6: Bag): { success: Pct; failed: Pct } {
  const lat = bag(k6.latencyMs);
  const empty: Pct = { p50: null, p95: null, p99: null, n: 0 };
  const pick = (b: Bag): Pct => ({ p50: num(b.p50), p95: num(b.p95), p99: num(b.p99), n: count(b.n) });
  if ('success' in lat || 'failed' in lat) return { success: pick(bag(lat.success)), failed: pick(bag(lat.failed)) };
  return { success: 'n' in lat ? pick(lat) : empty, failed: empty };
}

/** `metadatas` 는 repetition 오름차순이고 결과가 있는 실행만 담는다(진행 중 배치는 일부만). */
export function summarizeBatch(batch: BatchRecord, metadatas: RunMetadata[]): BatchSummary {
  const k6s = metadatas.map((m) => bag(m.k6));
  const lats = k6s.map(latencyOf);
  const throughputs = k6s.map((k) => num(k.throughputRps) ?? num(k.httpReqRate));
  const http = k6s.map((k) => count(k.httpFailures ?? k.failed));
  const dropped = k6s.map((k) => count(k.dropped ?? k.droppedIterations));
  const counted = metadatas.map((m) => m.validity?.droppedCountedAsFailure === true);

  // 불변식: 첫 등장 순서로 id 를 모으고, 실행마다 칸을 맞춘다(없으면 null).
  const invariantDefs = new Map<string, 'critical' | 'info'>();
  for (const m of metadatas) for (const inv of m.invariants ?? []) if (!invariantDefs.has(inv.id)) invariantDefs.set(inv.id, inv.severity);
  const invariants = [...invariantDefs].map(([id, severity]) => {
    const per = metadatas.map((m) => (m.invariants ?? []).find((i) => i.id === id));
    return { id, severity, violations: per.map((i) => i?.violations ?? null), passed: per.map((i) => i?.passed ?? null) };
  });

  const interventions = metadatas[0]?.interventions ?? [];
  const tp = spread(throughputs);
  const validity = metadatas.map((m) => m.validity);

  const badges: BatchSummary['badges'] = [];
  if (batch.loadModel === 'closed') badges.push('closed-latency-caution');
  if (interventions.length > 0) badges.push('injected');
  const invalidAny = validity.some((v) => v?.valid === false);
  if (invalidAny || (tp !== null && tp.median > 0 && (tp.max - tp.min) / tp.median > UNSTABLE_SPREAD_RATIO)) badges.push('unstable');

  return BatchSummarySchema.parse({
    batchId: batch.batchId,
    scenario: batch.scenario,
    strategy: batch.strategy,
    appInstances: batch.appInstances,
    loadModel: batch.loadModel,
    reps: batch.reps,
    runIds: metadatas.map((m) => m.runId),
    invariants,
    validity: {
      validReps: validity.filter((v) => v?.valid === true).length,
      invalidReasons: validity.map((v) => v?.reasons ?? []),
    },
    throughputRps: tp,
    latencyMs: {
      success: {
        p50: spread(lats.map((l) => l.success.p50)),
        p95: spread(lats.map((l) => l.success.p95)),
        p99: spread(lats.map((l) => l.success.p99)),
        n: lats.map((l) => l.success.n),
      },
      failed: { p95: spread(lats.map((l) => l.failed.p95)), n: lats.map((l) => l.failed.n) },
    },
    failures: {
      http,
      dropped,
      droppedCountedAsFailure: counted,
      total: http.map((h, i) => h + (counted[i] ? dropped[i]! : 0)),
    },
    interventions,
    badges,
  });
}
