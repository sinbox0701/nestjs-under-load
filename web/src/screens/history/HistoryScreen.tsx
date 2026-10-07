import { useEffect, useState } from 'react';
import type { Api, BatchSummary, RunDetail, RunRow } from '../../api';
import { HONESTY_TEXT, fmtSpread, invariantSummary } from '../compare/logic';
import './history.css';
import {
  ARTIFACTS,
  artifactUrl,
  autoAxis,
  compareUrl,
  groupByBatch,
  type BatchGroup,
} from './logic';

const MAX_PICK = 3;
const STATUS_TEXT = { running: '진행 중', done: '완료', failed: '실패', aborted: '중단' } as const;
const STATUS_TONE = {
  running: 't-info',
  done: 't-ok',
  failed: 't-bad',
  aborted: 't-neutral',
} as const;

type Summaries = Record<string, BatchSummary | 'error'>;

function RunLine({ row, apiBase, api }: { row: RunRow; apiBase: string; api: Api }) {
  const [detail, setDetail] = useState<RunDetail | 'loading' | 'error' | null>(null);
  const toggle = () => {
    if (detail) return setDetail(null);
    setDetail('loading');
    api.getRun(row.runId).then(setDetail, () => setDetail('error'));
  };
  return (
    <div data-testid="run-line">
      <div className="hx__run">
        <span className="hx__k">r{row.repetition}</span>
        <span className={`badge ${STATUS_TONE[row.status]}`}>{STATUS_TEXT[row.status]}</span>
        {row.valid === null ? (
          <span className="badge t-neutral">유효성 미정</span>
        ) : row.valid ? (
          <span className="badge t-ok">유효</span>
        ) : (
          <span className="badge t-bad">무효</span>
        )}
        {row.invariantsPassed === null ? (
          <span className="badge t-neutral">불변식 미측정</span>
        ) : row.invariantsPassed ? (
          <span className="badge t-ok">불변식 통과</span>
        ) : (
          <span className="badge t-bad">불변식 위반 {row.violationsTotal ?? '?'}건</span>
        )}
        <button type="button" className="btn" aria-expanded={detail !== null} onClick={toggle}>
          메타데이터 {detail ? '닫기' : '보기'}
        </button>
        {ARTIFACTS.map(([name, label]) => (
          <a
            key={name}
            href={artifactUrl(apiBase, row.runId, name)}
            target="_blank"
            rel="noreferrer"
          >
            {label}
          </a>
        ))}
      </div>
      {detail === 'loading' && <p className="dim">메타데이터 불러오는 중…</p>}
      {detail === 'error' && <p role="alert">메타데이터를 불러오지 못했다.</p>}
      {detail && typeof detail === 'object' && (
        <>
          {detail.steps.length > 0 && (
            <p className="hx__k">단계: {detail.steps.map((s) => s.name).join(' → ')}</p>
          )}
          <pre className="hx__meta" data-testid="metadata">
            {detail.metadata
              ? JSON.stringify(detail.metadata, null, 2)
              : '메타데이터 없음(실행 중이거나 기록 전)'}
          </pre>
        </>
      )}
    </div>
  );
}

function Item(props: {
  group: BatchGroup;
  summary: BatchSummary | 'error' | undefined;
  picked: boolean;
  disabled: boolean;
  onPick: () => void;
  api: Api;
  apiBase: string;
}) {
  const { group, summary, picked, disabled, onPick, api, apiBase } = props;
  const [open, setOpen] = useState(false);
  const first = group.rows[0]!;
  const s = summary && summary !== 'error' ? summary : null;
  const inv = s ? invariantSummary(s) : null;
  const running = group.rows.some((r) => r.status === 'running');
  return (
    <li className="panel hx__item" data-testid="batch-item" data-batch={group.batchId}>
      <div className="hx__head">
        <label className="hx__pick">
          <input
            type="checkbox"
            checked={picked}
            disabled={disabled}
            onChange={onPick}
            aria-label={`비교용으로 선택: ${first.scenario} ${first.strategy} 앱 ${first.appInstances}대`}
          />
        </label>
        <div className="hx__main">
          <div className="hx__row">
            <span className="hx__title">
              {first.scenario} · {first.strategy}
            </span>
            <span>앱 {first.appInstances}대</span>
            <span className="hx__k">
              {first.model === 'open' ? '열린' : '닫힌'} 모델 · 계측 {first.instrumentation}
            </span>
            {running && <span className="badge t-info">진행 중</span>}
          </div>
          {s ? (
            <>
              <div className="hx__row">
                {inv!.state === 'violated' && (
                  <span className="badge t-bad">불변식 위반 {inv!.violations}건</span>
                )}
                {inv!.state === 'passed' && <span className="badge t-ok">불변식 통과</span>}
                {inv!.state === 'unknown' && <span className="badge t-neutral">불변식 미측정</span>}
                <span
                  className={`badge ${s.validity.validReps === s.reps ? 't-ok' : s.validity.validReps === 0 ? 't-bad' : 't-wait'}`}
                >
                  유효 {s.validity.validReps}/{s.reps}회
                </span>
                {s.badges.includes('injected') && <span className="badge t-info">주입됨</span>}
                {s.badges.includes('unstable') && <span className="badge t-wait">{s.reps}회 편차 큼</span>}
              </div>
              <div className="hx__row">
                <span className="hx__k">처리량</span>
                <span>{fmtSpread(s.throughputRps, 'req/s')}</span>
              </div>
            </>
          ) : (
            <div className="hx__row">
              <span className="badge t-neutral">
                {summary === 'error' ? '요약 불러오기 실패' : '요약 불러오는 중'}
              </span>
            </div>
          )}
          <div className="hx__row">
            <button
              type="button"
              className="btn"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              실행 {group.rows.length}건 {open ? '접기' : '펼치기'}
            </button>
          </div>
        </div>
      </div>
      {open && (
        <div className="hx__runs">
          {group.rows.map((r) => (
            <RunLine key={r.runId} row={r} api={api} apiBase={apiBase} />
          ))}
        </div>
      )}
    </li>
  );
}

export interface HistoryScreenProps {
  api: Api;
  /** 비교로 이동한다. 기본은 주소 이동(location.assign). */
  onNavigate?: (url: string) => void;
  /** 아티팩트 링크의 API 기준 경로. */
  apiBase?: string;
}

export function HistoryScreen({
  api,
  onNavigate = (u) => location.assign(u),
  apiBase = '/api',
}: HistoryScreenProps) {
  const [groups, setGroups] = useState<BatchGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sums, setSums] = useState<Summaries>({});
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    api
      .listRuns({ limit: 100 })
      .then((list) => {
        if (!live) return;
        const gs = groupByBatch(list.items);
        setGroups(gs);
        for (const g of gs)
          api.getBatch(g.batchId).then(
            (b) => live && setSums((m) => ({ ...m, [g.batchId]: b })),
            () => live && setSums((m) => ({ ...m, [g.batchId]: 'error' })),
          );
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [api]);

  const toggle = (id: string) =>
    setPicked((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : p.length < MAX_PICK ? [...p, id] : p,
    );

  const go = () => {
    const sel = picked.map((id) => groups!.find((g) => g.batchId === id)!);
    const axis = sel.length === 2 ? autoAxis(sel[0]!, sel[1]!) : null;
    onNavigate(compareUrl(picked, axis));
  };

  return (
    <div className="hx" data-testid="history">
      <div className="hx__bar">
        <h1>실행 기록</h1>
        <button type="button" className="btn is-sel" disabled={picked.length < 2} onClick={go}>
          선택한 {picked.length}개 비교
        </button>
      </div>
      <p className="hx__k">
        같은 조건으로 반복한 실행을 배치로 묶어 보여 준다. 비교할 배치를 2~{MAX_PICK}개 고른다.
      </p>
      {error && (
        <p role="alert">
          <span className="badge t-bad">불러오기 실패</span> {error}
        </p>
      )}
      {!error && !groups && (
        <p role="status" className="dim">
          실행 기록 불러오는 중…
        </p>
      )}
      {groups && groups.length === 0 && <p role="status">아직 실행 기록이 없다.</p>}
      {groups && groups.length > 0 && (
        <ul className="hx__list">
          {groups.map((g) => (
            <Item
              key={g.batchId}
              group={g}
              summary={sums[g.batchId]}
              picked={picked.includes(g.batchId)}
              disabled={!picked.includes(g.batchId) && picked.length >= MAX_PICK}
              onPick={() => toggle(g.batchId)}
              api={api}
              apiBase={apiBase}
            />
          ))}
        </ul>
      )}
      <footer className="hx__foot" data-testid="honesty">
        <p>{HONESTY_TEXT}</p>
      </footer>
    </div>
  );
}
