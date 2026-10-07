import { useEffect, useState } from 'react';
import type { Api, RunsAccepted, Session, SessionState, WsMessage } from '../../api';
import { WS_CURRENT } from '../../api';

type Status = Extract<WsMessage, { type: 'status' }>['data'];

const STATE_UI: Record<SessionState, { label: string; tone: string }> = {
  queued: { label: '대기', tone: 't-neutral' },
  running: { label: '실행 중', tone: 't-info' },
  done: { label: '끝남', tone: 't-ok' },
  aborted: { label: '중단됨', tone: 't-wait' },
  failed: { label: '실패', tone: 't-bad' },
};

/** 세션 진행(status WS)을 보여 준다. 상태는 색과 글자를 함께 쓴다. */
export function SessionProgress(p: { api: Api; sessionId: string; accepted: RunsAccepted | null }) {
  const { api, sessionId } = p;
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [ended, setEnded] = useState<{ valid: boolean; reasons: string[] } | null>(null);
  const [lost, setLost] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getSession(sessionId)
      .then((s) => alive && setSession(s))
      .catch(() => undefined);
    const off = api.subscribeRun(
      WS_CURRENT,
      (m) => {
        if (!alive) return;
        if (m.type === 'status') setStatus(m.data);
        else if (m.type === 'end') setEnded(m.data);
      },
      { onClose: () => alive && setLost(true) },
    );
    return () => {
      alive = false;
      off();
    };
  }, [api, sessionId]);

  const state: SessionState = status?.state ?? session?.state ?? 'queued';
  const ui = STATE_UI[state];
  const prog = status?.progress;
  const pct = prog && prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0;
  const batches = p.accepted?.batches ?? session?.batches ?? [];

  return (
    <section className="panel rs-prog" aria-label="세션 진행" aria-live="polite">
      <h2 className="panel__h">
        세션 진행 <span className="meta">{sessionId}</span>
      </h2>
      <p>
        <span className={`badge ${ui.tone}`}>{ui.label}</span>{' '}
        {status
          ? `${status.step} · ${status.repetition}회차`
          : (session?.current?.step ?? '시작을 기다리는 중')}
      </p>
      {prog && (
        <p>
          <progress max={prog.total} value={prog.done} aria-label="전체 진행률" />{' '}
          <span>
            {prog.done}/{prog.total} ({pct}%)
          </span>
        </p>
      )}
      {batches.length > 0 && (
        <ul className="rs-sumlist">
          {batches.map((b) => (
            <li key={b.batchId}>
              {b.strategy} · 앱 {b.appInstances}대
            </li>
          ))}
        </ul>
      )}
      {ended && (
        <p>
          <span className={`badge ${ended.valid ? 't-ok' : 't-bad'}`}>
            {ended.valid ? '유효' : '무효'}
          </span>{' '}
          {ended.reasons.join(', ')}
        </p>
      )}
      {lost && !ended && (
        <p className="rs-hint">실시간 연결이 끊겼다. 세션 상태는 다시 열면 확인된다.</p>
      )}
    </section>
  );
}
