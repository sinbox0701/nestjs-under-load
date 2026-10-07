import type { AxisPath, RunRow } from '../../api';

export interface BatchGroup {
  batchId: string;
  rows: RunRow[];
}

/** 실행 목록을 batchId 로 묶는다(처음 나온 순서 유지). */
export function groupByBatch(rows: RunRow[]): BatchGroup[] {
  const map = new Map<string, BatchGroup>();
  for (const r of rows) {
    const g = map.get(r.batchId) ?? { batchId: r.batchId, rows: [] };
    g.rows.push(r);
    map.set(r.batchId, g);
  }
  return [...map.values()].map((g) => ({
    ...g,
    rows: [...g.rows].sort((a, z) => a.repetition - z.repetition),
  }));
}

/** 두 배치가 한 가지 축으로만 다르면 그 축을 돌려준다. 앱 대수만 다르면 topology.appInstances. */
export function autoAxis(a: BatchGroup, b: BatchGroup): AxisPath | null {
  const x = a.rows[0];
  const y = b.rows[0];
  if (!x || !y || x.scenario !== y.scenario || x.model !== y.model) return null;
  const differs: AxisPath[] = [];
  if (x.appInstances !== y.appInstances) differs.push('topology.appInstances');
  if (x.instrumentation !== y.instrumentation) differs.push('instrumentation');
  return differs.length === 1 ? differs[0]! : null;
}

/** `/compare?batches=a,b[&axis=…]`. 쉼표는 그대로 둔다. */
export function compareUrl(batchIds: string[], axis: AxisPath | null): string {
  const q = `batches=${batchIds.map(encodeURIComponent).join(',')}`;
  return `/compare?${q}${axis ? `&axis=${encodeURIComponent(axis)}` : ''}`;
}

export const ARTIFACTS = [
  ['report.html', 'k6 HTML 리포트'],
  ['summary.json', 'summary'],
  ['metadata.json', '메타데이터 파일'],
  ['events.ndjson', '이벤트'],
] as const;

export const artifactUrl = (apiBase: string, runId: string, name: string): string =>
  `${apiBase.replace(/\/$/, '')}/runs/${encodeURIComponent(runId)}/artifacts/${name}`;
