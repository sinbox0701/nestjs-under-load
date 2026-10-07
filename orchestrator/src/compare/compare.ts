// 배치 비교 판정(C2 CompareResult, DESIGN §7.3). 계약의 COMPARABLE_PATHS·AXIS_PATHS·WARNING_PATHS 를 그대로 쓴다.
// - 비교 조건 경로 아래에서 값이 다른 잎(예: `load.vus`)마다 diff 하나. 배열은 잎으로 본다.
// - 그 잎이 `axis`(와 그 하위)에 있으면 kind=axis, 아니면 blocking. blocking 이 없을 때만 comparable.
// - WARNING_PATHS(git.sha)가 다르면 warning 이고 codeVersionDiffers=true.
import { AXIS_PATHS, COMPARABLE_PATHS, WARNING_PATHS, type AxisPath, type BatchSummary, type CompareResult } from '@under-load/contracts';
import { isDeepStrictEqual } from 'node:util';

/** DESIGN §3.1 기본 문구. */
export const HONESTY_NOTE = '로컬 단일 머신의 상대 비교다. 절대 수치로 읽지 않는다.';

type Diff = CompareResult['diffs'][number];

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const getPath = (root: unknown, path: string): unknown => {
  let cur: unknown = root;
  for (const key of path.split('.')) {
    if (!isPlain(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
};

const allEqual = (values: readonly unknown[]) => values.every((v) => isDeepStrictEqual(v, values[0]));

/** 값들이 모두 객체면 키별로 내려가고, 아니면 그 경로가 잎이다. 다른 잎만 모은다. */
function leafDiffs(path: string, values: readonly unknown[], out: { path: string; values: unknown[] }[]): void {
  if (allEqual(values)) return;
  if (values.every(isPlain)) {
    const keys = new Set(values.flatMap((v) => Object.keys(v as object)));
    for (const k of keys) {
      leafDiffs(
        `${path}.${k}`,
        values.map((v) => (v as Record<string, unknown>)[k]),
        out,
      );
    }
    return;
  }
  out.push({ path, values: values.map((v) => v ?? null) });
}

const underAxis = (path: string, axis: AxisPath | null) => axis !== null && (path === axis || path.startsWith(`${axis}.`));

/** `axis` 는 AXIS_PATHS 중 하나(검증은 호출자). metadata[i] 는 batches[i] 의 대표 실행 메타데이터. */
export function compareBatches(batches: BatchSummary[], metadata: readonly unknown[], axis: AxisPath | null): CompareResult {
  if (axis !== null && !(AXIS_PATHS as readonly string[]).includes(axis)) throw new Error(`axis 로 쓸 수 없는 경로: ${axis}`);
  const diffs: Diff[] = [];

  for (const base of COMPARABLE_PATHS) {
    const leaves: { path: string; values: unknown[] }[] = [];
    leafDiffs(
      base,
      metadata.map((m) => getPath(m, base)),
      leaves,
    );
    for (const l of leaves) diffs.push({ path: l.path, values: l.values, kind: underAxis(l.path, axis) ? 'axis' : 'blocking' });
  }

  let codeVersionDiffers = false;
  for (const p of WARNING_PATHS) {
    const values = metadata.map((m) => getPath(m, p));
    if (allEqual(values)) continue;
    diffs.push({ path: p, values: values.map((v) => v ?? null), kind: 'warning' });
    if (p === 'git.sha') codeVersionDiffers = true;
  }

  return {
    comparable: !diffs.some((d) => d.kind === 'blocking'),
    axis,
    diffs,
    codeVersionDiffers,
    batches: batches.map(orderBatchSummary),
    honestyNote: HONESTY_NOTE,
  };
}

/**
 * 응답용 BatchSummary 정리(저장소가 준 값을 해치지 않는다).
 * - 키 순서를 정합성(invariants) → 유효성 → 처리량·지연 → 실패 순으로 고정한다(DESIGN §3-1: 위반 수가 가장 앞).
 * - open 모델은 failures.total 에 dropped 를 합산한다(droppedCountedAsFailure 인 반복만).
 */
export function orderBatchSummary(b: BatchSummary): BatchSummary {
  const f = b.failures;
  const total = b.loadModel === 'open' ? f.http.map((h, i) => h + (f.droppedCountedAsFailure[i] ? (f.dropped[i] ?? 0) : 0)) : f.total;
  return {
    batchId: b.batchId,
    scenario: b.scenario,
    strategy: b.strategy,
    appInstances: b.appInstances,
    loadModel: b.loadModel,
    reps: b.reps,
    runIds: b.runIds,
    invariants: b.invariants,
    validity: b.validity,
    throughputRps: b.throughputRps,
    latencyMs: b.latencyMs,
    failures: { http: f.http, dropped: f.dropped, droppedCountedAsFailure: f.droppedCountedAsFailure, total },
    interventions: b.interventions,
    badges: b.badges,
  };
}
