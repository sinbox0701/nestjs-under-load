import { useEffect, useState } from 'react';
import { NO_TRACE_SINK_TEXT, type Api, type BatchBadge, type BatchSummary, type CompareResult } from '../../api';
import './compare.css';
import {
  HONESTY_TEXT,
  fmtNum,
  fmtSpread,
  invalidReps,
  invariantSummary,
  rankBatches,
  sum,
  type RankEntry,
} from './logic';

const BADGE_TEXT: Record<BatchBadge, string> = {
  'closed-latency-caution': '닫힌 모델: 지연이 낮게 보일 수 있음',
  injected: '주입됨',
  unstable: '편차 큼',
  'no-trace-sink': NO_TRACE_SINK_TEXT,
};
const BADGE_TONE: Record<BatchBadge, string> = {
  'closed-latency-caution': 't-wait',
  injected: 't-info',
  unstable: 't-wait',
  'no-trace-sink': 't-wait',
};

const colLabel = (b: BatchSummary) =>
  `${b.strategy} · 앱 ${b.appInstances}대 · ${b.loadModel === 'open' ? '열린' : '닫힌'} 모델`;
const showVal = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

function Cols({
  batches,
  children,
}: {
  batches: BatchSummary[];
  children: (b: BatchSummary, i: number) => React.ReactNode;
}) {
  return (
    <div className="cx__cols" style={{ ['--n' as string]: batches.length }}>
      {batches.map((b, i) => (
        <div key={b.batchId} className="cx__col" data-batch={b.batchId}>
          <h3>{colLabel(b)}</h3>
          {children(b, i)}
        </div>
      ))}
    </div>
  );
}

function Badges({ b }: { b: BatchSummary }) {
  return (
    <div className="cx__row">
      {b.badges.map((x) => (
        <span key={x} className={`badge ${BADGE_TONE[x]}`}>
          {x === 'unstable' ? `${b.reps}회 편차 큼` : BADGE_TEXT[x]}
        </span>
      ))}
    </div>
  );
}

function Banner({ r }: { r: CompareResult }) {
  const blocking = r.diffs.filter((d) => d.kind === 'blocking');
  const axis = r.diffs.filter((d) => d.kind === 'axis');
  const warn = r.diffs.filter((d) => d.kind === 'warning');
  return (
    <>
      {!r.comparable && (
        <div className="cx__ban cx__ban--bad" role="alert" data-testid="not-comparable">
          <div>
            <span className="badge t-bad">비교 불가(조건 다름)</span>
            조건이 다른 실행끼리는 처리량·지연을 견주지 않는다. 다른 경로:
          </div>
          <ul className="cx__ul">
            {blocking.map((d) => (
              <li key={d.path}>
                <code>{d.path}</code> — {d.values.map(showVal).join(' ≠ ')}
              </li>
            ))}
          </ul>
        </div>
      )}
      {axis.length > 0 && (
        <div className="cx__ban" data-testid="axis">
          <span className="badge t-info">비교 축</span>
          {axis.map((d) => (
            <span key={d.path}>
              <code>{d.path}</code> — {d.values.map(showVal).join(' → ')} (이 값만 일부러 다르게 둔
              비교)
            </span>
          ))}
        </div>
      )}
      {(warn.length > 0 || r.codeVersionDiffers) && (
        <div className="cx__ban" data-testid="warning">
          <span className="badge t-wait">코드 버전 다름</span>
          {warn.map((d) => (
            <span key={d.path}>
              <code>{d.path}</code> — {d.values.map(showVal).join(' ≠ ')}
            </span>
          ))}
          <span>코드가 달라서 생긴 차이가 섞였을 수 있다.</span>
        </div>
      )}
    </>
  );
}

function Invariants({ batches }: { batches: BatchSummary[] }) {
  return (
    <section className="panel cx__sec" data-section="invariants" aria-labelledby="cx-inv">
      <h2 className="panel__h" id="cx-inv">
        1. 정합성(불변식) <span className="meta">가장 먼저 본다</span>
      </h2>
      <Cols batches={batches}>
        {(b) => {
          const s = invariantSummary(b);
          return (
            <>
              <div className="cx__row">
                {s.state === 'violated' && (
                  <span className="badge t-bad">위반 {s.violations}건</span>
                )}
                {s.state === 'passed' && <span className="badge t-ok">통과</span>}
                {s.state === 'unknown' && <span className="badge t-neutral">미측정</span>}
                {s.failedReps.length > 0 && (
                  <span className="cx__k">
                    위반 반복: {s.failedReps.map((r) => `r${r}`).join(', ')}
                  </span>
                )}
              </div>
              {b.invariants.map((inv) => (
                <div key={inv.id} className="cx__row">
                  <span className="cx__k">{inv.severity === 'critical' ? '필수' : '참고'}</span>
                  <span>{inv.id}</span>
                  <span className="cx__v">
                    {inv.passed
                      .map(
                        (p, i) =>
                          `r${i + 1} ${p === null ? '—' : p ? '통과' : `위반 ${inv.violations[i] ?? '?'}`}`,
                      )
                      .join(' · ')}
                  </span>
                </div>
              ))}
            </>
          );
        }}
      </Cols>
    </section>
  );
}

function Validity({ batches }: { batches: BatchSummary[] }) {
  return (
    <section className="panel cx__sec" data-section="validity" aria-labelledby="cx-val">
      <h2 className="panel__h" id="cx-val">
        2. 유효성
      </h2>
      <Cols batches={batches}>
        {(b) => {
          const bad = invalidReps(b);
          return (
            <>
              <div className="cx__row">
                <span
                  className={`badge ${bad.length === 0 ? 't-ok' : b.validity.validReps === 0 ? 't-bad' : 't-wait'}`}
                >
                  유효 {b.validity.validReps}/{b.reps}회
                </span>
                <Badges b={b} />
              </div>
              {bad.map((x) => (
                <div key={x.rep} className="cx__row">
                  <span className="badge t-bad">무효</span>
                  <span>
                    r{x.rep}: {x.reasons.join(', ')}
                  </span>
                </div>
              ))}
            </>
          );
        }}
      </Cols>
    </section>
  );
}

function Throughput({ batches, comparable }: { batches: BatchSummary[]; comparable: boolean }) {
  const ranks = rankBatches(batches);
  const of = (b: BatchSummary): RankEntry => ranks.find((r) => r.batch.batchId === b.batchId)!;
  return (
    <section className="panel cx__sec" data-section="throughput" aria-labelledby="cx-tp">
      <h2 className="panel__h" id="cx-tp">
        3. 처리량·지연{' '}
        <span className="meta">
          숫자 옆은 {Math.max(...batches.map((b) => b.reps))}회 범위(최소–최대)
        </span>
      </h2>
      {!comparable && (
        <p className="dim" data-testid="no-rank">
          비교 불가라 순위를 매기지 않는다. 아래 숫자는 서로 견주지 않는다.
        </p>
      )}
      <Cols batches={batches}>
        {(b) => {
          const e = of(b);
          const ok = b.latencyMs.success;
          const bad = b.latencyMs.failed;
          return (
            <>
              <div className="cx__row">
                {comparable && e.rank !== null && (
                  <span className="badge t-neutral">처리량 {e.rank}위</span>
                )}
                {comparable && e.rank === null && (
                  <span className="badge t-bad" data-testid="excluded">
                    순위 제외 — {e.excludedReasons.join(' / ')}
                  </span>
                )}
                {e.fastButWrong && <span className="badge t-bad">빠르지만 틀림</span>}
                {e.inv.state === 'violated' && !e.fastButWrong && (
                  <span className="badge t-bad">정합성 위반 {e.inv.violations}건</span>
                )}
              </div>
              <div className="cx__k">처리량</div>
              <div className="cx__big cx__v">{fmtSpread(b.throughputRps, 'req/s')}</div>
              <div className="cx__k">성공 요청 지연(ms)</div>
              <div className="cx__v">p50 {fmtSpread(ok.p50, '', 1)}</div>
              <div className="cx__v">p95 {fmtSpread(ok.p95, '', 1)}</div>
              <div className="cx__v">p99 {fmtSpread(ok.p99, '', 1)}</div>
              <div className="cx__v cx__k">n(성공) {ok.n.map(fmtNum).join(' / ')}</div>
              <div className="cx__k">실패 요청 지연(ms) — 성공과 섞지 않는다</div>
              <div className="cx__v">p95 {fmtSpread(bad.p95, '', 1)}</div>
              <div className="cx__v cx__k">n(실패) {bad.n.map(fmtNum).join(' / ')}</div>
            </>
          );
        }}
      </Cols>
    </section>
  );
}

function Failures({ batches }: { batches: BatchSummary[] }) {
  return (
    <section className="panel cx__sec" data-section="failures" aria-labelledby="cx-fail">
      <h2 className="panel__h" id="cx-fail">
        4. 실패 <span className="meta">dropped(열린 모델에서 못 보낸 요청)를 합산</span>
      </h2>
      <Cols batches={batches}>
        {(b) => {
          const f = b.failures;
          return (
            <>
              {f.total.map((t, i) => (
                <div key={i} className="cx__row" data-testid="failure-rep">
                  <span className="cx__k">r{i + 1}</span>
                  <span className="cx__v">
                    실패 = HTTP {fmtNum(f.http[i] ?? 0)} + dropped {fmtNum(f.dropped[i] ?? 0)}
                    {' = '}
                    {fmtNum(t)}
                  </span>
                  {f.droppedCountedAsFailure[i] === false && (
                    <span className="badge t-wait">dropped 미합산</span>
                  )}
                </div>
              ))}
              <div className="cx__v cx__k">
                합계 HTTP {fmtNum(sum(f.http))} + dropped {fmtNum(sum(f.dropped))}
              </div>
            </>
          );
        }}
      </Cols>
    </section>
  );
}

export function CompareView({ result }: { result: CompareResult }) {
  const { batches } = result;
  return (
    <div className="cx" data-testid="compare">
      <h1>비교</h1>
      <Banner r={result} />
      <Invariants batches={batches} />
      <Validity batches={batches} />
      <Throughput batches={batches} comparable={result.comparable} />
      <Failures batches={batches} />
      <footer className="cx__foot" data-testid="honesty">
        <p>{HONESTY_TEXT}</p>
        {result.honestyNote && result.honestyNote !== HONESTY_TEXT && <p>{result.honestyNote}</p>}
      </footer>
    </div>
  );
}

export interface CompareScreenProps {
  api: Api;
  batchIds: string[];
  axis?: string | null;
}

export function CompareScreen({ api, batchIds, axis }: CompareScreenProps) {
  const key = `${batchIds.join(',')}|${axis ?? ''}`;
  const [state, setState] = useState<{ key: string; result?: CompareResult; error?: string }>({
    key: '',
  });
  useEffect(() => {
    let live = true;
    api
      .compare(batchIds, axis ?? undefined)
      .then((result) => live && setState({ key, result }))
      .catch(
        (e: unknown) =>
          live && setState({ key, error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      live = false;
    };
    // key 가 batchIds·axis 를 대표한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);

  if (batchIds.length < 2)
    return (
      <div className="cx">
        <p role="status">비교할 배치를 두 개 이상 고른다(실행 기록에서 선택).</p>
      </div>
    );
  if (state.key !== key)
    return (
      <div className="cx">
        <p role="status" className="dim">
          비교 불러오는 중…
        </p>
      </div>
    );
  if (state.error || !state.result)
    return (
      <div className="cx">
        <p role="alert">
          <span className="badge t-bad">불러오기 실패</span> {state.error}
        </p>
      </div>
    );
  return <CompareView result={state.result} />;
}

/** 주소의 `?batches=a,b&axis=…` 를 읽는 진입점. */
export function CompareRoute({ api, search = location.search }: { api: Api; search?: string }) {
  const p = new URLSearchParams(search);
  const batchIds = (p.get('batches') ?? '').split(',').filter(Boolean);
  return <CompareScreen api={api} batchIds={batchIds} axis={p.get('axis')} />;
}
