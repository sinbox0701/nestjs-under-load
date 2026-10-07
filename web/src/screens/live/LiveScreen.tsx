import { useEffect, useMemo, useReducer, useState } from 'react';
import { WS_CURRENT, type Api, type WsMessage } from '../../api';
import { Timeline } from '../../components/Timeline';
import { scenarioIdOf } from '../../components/lib/config';
import { toRecording, type WireEvent } from '../../events/ndjson';
import type { PhaseGroup } from '../../events/phases';
import { prepare } from '../../playback/prepare';
import { buildRows, type RowView } from '../../playback/rows';
import { MEASURED_BADGE, STAGE_BADGE } from './badges';
import { PoolGauges } from './PoolGauges';
import { ProbeTree } from './ProbeTree';
import { initialLive, liveReduce, sampleCount } from './state';
import '../../components/components.css';
import './live.css';

export interface LiveScreenProps {
  api: Api;
  /** 기본 'current'(진행 중인 실행을 따라간다). */
  runId?: string;
  /** 시나리오 id 를 알면 넘긴다. 없으면 runId 에서 g01/g02 를 읽는다. */
  scenario?: string;
}

const STATE_LABEL = {
  queued: '대기',
  running: '실행 중',
  done: '끝남',
  aborted: '중단됨',
  failed: '실패',
} as const;

/** 서버 속 라이브(화면 4): WS 이벤트·PG 프로브·풀을 텍스트로 그린다. 표본은 대표 요청만이다. */
export function LiveScreen({ api, runId = WS_CURRENT, scenario }: LiveScreenProps) {
  const [live, dispatch] = useReducer(liveReduce, initialLive);
  const [conn, setConn] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [view, setView] = useState<RowView>('key');
  const [off, setOff] = useState<ReadonlySet<PhaseGroup>>(new Set());

  useEffect(() => {
    return api.subscribeRun(runId, (m: WsMessage) => dispatch(m), {
      onOpen: () => setConn('open'),
      onClose: () => setConn('closed'),
    });
  }, [api, runId]);

  const n = sampleCount(live.events);
  const strategyId = useMemo(() => {
    const a = live.events.find((e) => typeof e.attrs?.strategy === 'string')?.attrs?.strategy;
    return typeof a === 'string' ? a : '';
  }, [live.events]);
  const scenarioId = scenarioIdOf(scenario ?? live.runId ?? '');
  const prepared = useMemo(
    () =>
      prepare(
        toRecording(live.events as WireEvent[], {
          meta: {
            runId: live.runId ?? '',
            scenario: scenarioId,
            strategy: { id: strategyId, label: strategyId, kind: 'broken' },
          },
        }),
      ),
    [live.events, live.runId, scenarioId, strategyId],
  );
  const rows = useMemo(
    () => buildRows(prepared.events, { view, off }, { info: prepared.info }),
    [prepared, view, off],
  );
  const toggleGroup = (g: PhaseGroup) =>
    setOff((o) => {
      const next = new Set(o);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  return (
    <div className="nul live" aria-label="서버 속 라이브">
      <header className="live__top">
        <span className="badge t-info" data-testid="measured-badge">
          {MEASURED_BADGE(n)}
        </span>
        <span className="live__hint">
          실제 실행의 대표 요청만 보입니다(전량 아님). 무대 화면의{' '}
          <span className="badge t-neutral">{STAGE_BADGE}</span> 배지는 가상 기록입니다.
        </span>
        <span className="live__conn" role="status">
          {conn === 'open' ? '연결됨' : conn === 'connecting' ? '연결 중' : '연결 끊김'}
          {live.status
            ? ` · ${STATE_LABEL[live.status.state]} · ${live.status.step} (${live.status.progress.done}/${live.status.progress.total})`
            : ''}
          {live.end ? ` · ${live.end.valid ? '유효' : `무효: ${live.end.reasons.join(', ')}`}` : ''}
        </span>
      </header>
      {live.runId && <p className="live__run">run {live.runId}</p>}
      <div className="live__grid">
        <section className="panel" aria-label="락 차단">
          <div className="panel__h">
            <span>락 차단 트리</span>
            <span className="meta">PG 프로브</span>
          </div>
          <ProbeTree probe={live.probe} />
        </section>
        <section className="panel" aria-label="풀">
          <div className="panel__h">
            <span>풀 게이지</span>
            <span className="meta">인스턴스별</span>
          </div>
          <PoolGauges pools={live.pools} />
        </section>
      </div>
      <Timeline
        hasRec={prepared.events.length > 0}
        prepared={prepared}
        scenario={scenarioId}
        strategyId={strategyId}
        people={0}
        P={prepared.total}
        rows={rows}
        view={view}
        off={off}
        callout={null}
        onView={setView}
        onToggleGroup={toggleGroup}
        onPickRow={() => {}}
      />
    </div>
  );
}
