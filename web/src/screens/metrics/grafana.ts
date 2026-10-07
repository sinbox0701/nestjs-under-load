/** Grafana 대시보드 임베드 URL(C5 UID). 변수는 run_id, 시간 범위는 from/to(epoch ms). */
export const DASHBOARDS = [
  { tab: '개요', uid: 'nul-run-overview' },
  { tab: 'RED', uid: 'nul-red' },
  { tab: 'USE-앱', uid: 'nul-use-app' },
  { tab: 'USE-PG', uid: 'nul-use-pg' },
  { tab: '부하', uid: 'nul-loadgen' },
] as const;

export type DashboardUid = (typeof DASHBOARDS)[number]['uid'];

export interface GrafanaUrlInput {
  /** Grafana 가 서 있는 경로 접두사(리버스 프록시). 기본 `/grafana`. */
  base?: string;
  uid: string;
  runId: string;
  fromMs: number;
  toMs: number;
  /** false 면 kiosk 없이(새 탭에서 열 때). */
  kiosk?: boolean;
}

export function grafanaUrl(i: GrafanaUrlInput): string {
  const base = (i.base ?? '/grafana').replace(/\/$/, '');
  const q = new URLSearchParams({
    'var-run_id': i.runId,
    from: String(Math.round(i.fromMs)),
    to: String(Math.round(i.toMs)),
  }).toString();
  return `${base}/d/${i.uid}/${i.uid}?${q}${i.kiosk === false ? '' : '&kiosk'}`;
}
