import { useEffect, useState } from 'react';
import type { Api } from '../../api';
import { Seg } from '../../components/lib/Seg';
import { DASHBOARDS, grafanaUrl } from './grafana';
import './metrics.css';

export interface MetricsScreenProps {
  runId: string;
  /** 시간 범위(epoch ms). 둘 다 없으면 api 로 실행 구간을 읽는다. */
  fromMs?: number;
  toMs?: number;
  api?: Api;
  grafanaBase?: string;
}

/** 지표 패널(화면 5): Grafana 대시보드를 run_id·실행 구간으로 임베드한다. */
export function MetricsScreen({ runId, fromMs, toMs, api, grafanaBase }: MetricsScreenProps) {
  const [uid, setUid] = useState<string>(DASHBOARDS[0].uid);
  const [fetched, setFetched] = useState<{ from: number; to: number } | null>(null);
  const [err, setErr] = useState(false);
  const given = fromMs !== undefined && toMs !== undefined;
  const range = given ? { from: fromMs, to: toMs } : fetched;

  useEffect(() => {
    if (given || !api) return;
    let alive = true;
    api
      .getRun(runId)
      .then((d) => {
        if (!alive) return;
        const from = Date.parse(d.row.startedAt);
        const to = d.row.endedAt ? Date.parse(d.row.endedAt) : Date.now();
        setFetched({ from: fromMs ?? from, to: toMs ?? to });
        setErr(false);
      })
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [api, runId, fromMs, toMs, given]);

  const src = range
    ? grafanaUrl({ base: grafanaBase, uid, runId, fromMs: range.from, toMs: range.to })
    : null;
  const open = range
    ? grafanaUrl({
        base: grafanaBase,
        uid,
        runId,
        fromMs: range.from,
        toMs: range.to,
        kiosk: false,
      })
    : null;
  const cur = DASHBOARDS.find((d) => d.uid === uid)!;

  return (
    <div className="nul metrics" aria-label="지표 패널">
      <header className="metrics__top">
        <Seg<string>
          label="대시보드"
          value={uid}
          onChange={setUid}
          items={DASHBOARDS.map((d) => ({ value: d.uid, label: d.tab }))}
        />
        <span className="metrics__run">run {runId}</span>
        {open && (
          <a className="metrics__open" href={open} target="_blank" rel="noreferrer noopener">
            Grafana 에서 열기
          </a>
        )}
      </header>
      {src ? (
        <iframe
          key={uid}
          className="metrics__frame"
          title={`Grafana ${cur.tab}`}
          src={src}
          loading="lazy"
        />
      ) : (
        <p className="metrics__empty" role="status">
          {err ? '실행 구간을 불러오지 못했습니다' : '실행 구간을 읽는 중'}
        </p>
      )}
    </div>
  );
}
