import type { Counters } from '../playback/prepare';

export interface ResultCardProps {
  counters: Counters;
  /** 집계 지표(처리량·p95·실패율). 기록에 없으면 null → "—". */
  metrics: { tput: number; p95: number; samples: number; failPct: number } | null;
}

/** 정합성 위반 수 → 처리량 → p95 → 실패율 순서(DESIGN §3-1, DESIGN_SYSTEM §4.4). */
export function ResultCard({ counters, metrics }: ResultCardProps) {
  const bad = counters.violations > 0;
  return (
    <section className="panel result" aria-live="polite" aria-label="결과">
      <h2 className="panel__h">
        결과 <span className="meta">재생 위치까지 누적</span>
      </h2>
      <div className="result__primary">
        <span className={bad ? 'result__big is-bad' : 'result__big is-ok'}>
          {bad ? '✕' : '✓'} {counters.violations}
        </span>
        <div>
          <div>정합성 위반(잃어버린 수정)</div>
          <span className={bad ? 'badge t-bad' : 'badge t-ok'}>
            {bad ? '빠르지만 틀림 · 순위 제외' : '정합성 통과'}
          </span>
        </div>
      </div>
      <dl className="result__grid">
        <div>
          <dt className="small dim">처리량</dt>
          <dd>{metrics ? `${metrics.tput} req/s` : '—'}</dd>
        </div>
        <div>
          <dt className="small dim">p95</dt>
          <dd>{metrics ? `${metrics.p95} ms` : '—'}</dd>
          {metrics && <dd className="small dim">n={metrics.samples}</dd>}
        </div>
        <div>
          <dt className="small dim">실패율</dt>
          <dd>{metrics ? `${metrics.failPct}%` : '—'}</dd>
          <dd className="small dim">
            409 {counters.conflicts} · 재시도 {counters.retries}
          </dd>
        </div>
      </dl>
      <p className="small dim">로컬 단일 머신 · 상대 비교용</p>
    </section>
  );
}
