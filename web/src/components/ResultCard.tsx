import { useState } from 'react';
import type { RecordingNotice, RunSummary } from '../events/types';
import type { ScenarioId } from './lib/config';
import { Icon } from './lib/icons';
import { fmtDur, fmtTput, invariantLine, loadNote } from './lib/result';

/** 재생 위치까지 센 시뮬레이션 수(재생 엔진 counters). */
export interface PositionCounts {
  conflicts: number;
  rejects: number;
  retries: number;
  soldOut: number;
}

export interface ResultCardProps {
  scenario: ScenarioId;
  hasRec: boolean;
  running: boolean;
  /** 재생 위치까지 누적 정합성 위반 수(원장 이벤트 기준). 첫 이벤트 전이면 null. */
  violations: number | null;
  /** 재생 위치까지 센 409·423·재시도·품절. 첫 이벤트 전이면 null. */
  counts: PositionCounts | null;
  /** 기록 끝에 도달했는가. */
  atEnd: boolean;
  /** 머리줄 상태 문구(재생 중 · 일시정지 · 자동 멈춤 …). */
  state: string;
  pred: number | null;
  /** 기록 전체 요약(재생 위치와 무관). 없으면 숫자는 "—". */
  summary: RunSummary | null;
  /** 재생 끝 요약 한 줄(끝이 아니면 보이지 않는다). */
  endLine: string | null;
  /** 이 기록이 무엇인지(실측·시뮬레이션·예시) 고지. 없으면 고지 없음. */
  notice: RecordingNotice | null;
}

/**
 * 결과 카드(DESIGN_SYSTEM §4.4). 두 영역으로 나눈다.
 * - 시뮬레이션 영역: 정합성 위반 수(가장 먼저)·품절/409, 재생 위치 기준. 기록의 원장 이벤트로 센다.
 * - 실측 영역: 처리량·p95·실패율, 기록 전체(재생 위치와 무관). 실측이 없으면 "— 실측 없음".
 */
export function ResultCard(p: ResultCardProps) {
  const v = p.violations;
  const bad = (v ?? 0) > 0;
  // 위반이 새로 늘면 첫 칸을 깜박인다(렌더 중 이전 값과 비교, 되감기에는 반응하지 않음).
  const [flash, setFlash] = useState(0);
  const [prev, setPrev] = useState(v ?? 0);
  if ((v ?? 0) !== prev) {
    if ((v ?? 0) > prev) setFlash(flash + 1);
    setPrev(v ?? 0);
  }
  const s = p.hasRec ? p.summary : null;
  const m = s?.measured ?? null;
  const noMeasure = !!s && !m;
  const g01 = p.scenario === 'g01-shared-document';
  const p95 = m ? fmtDur(m.p95Ms) : null;
  const primaryCls = `res__primary${v === null ? '' : bad ? ' is-bad' : ' is-ok'}${flash ? ' is-flash' : ''}`;
  const simKind = p.notice?.kind ?? 'measured';
  const c = p.counts;
  const simStat = g01
    ? c
      ? `409 ${c.conflicts} · 423 ${c.rejects} · 재시도 ${c.retries}`
      : '409 · 423 · 재시도'
    : `품절 ${c ? c.soldOut : '—'}`;
  const noData = '—';
  const measHint = noMeasure ? '실측 없음' : undefined;

  return (
    <section className="panel a-result" aria-label="결과">
      <div className="panel__h">
        <h2>결과</h2>
        <span className="meta">{p.state}</span>
      </div>
      <div className="res">
        <div className="res__zh res__zh--sim" data-testid="zone-sim">
          <span>{simKind === 'measured' ? '실측 기록' : '시뮬레이션'} · 재생 위치 기준</span>
          {p.hasRec && p.notice && p.notice.kind !== 'measured' && (
            <span className="fake-chip badge" title={p.notice.text}>
              <Icon name="bang" />
              {p.notice.label}
            </span>
          )}
        </div>
        <div className={primaryCls} key={flash} data-testid="res-primary" aria-live="polite">
          <span className="res__label">
            {v !== null && <Icon name={bad ? 'cross' : 'check'} />}
            정합성 위반 · {g01 ? '잃어버린 수정' : '잃어버린 갱신'}
            <span className="pos">재생 위치까지</span>
          </span>
          <span className="res__num" data-testid="violations">
            {v === null ? '—' : v}
          </span>
          <div>
            <div className="res__verdict">
              {v === null ? (
                <span className="badge t-neutral">
                  {p.hasRec ? '재생 전' : p.running ? '실행 중' : '실행 전'}
                </span>
              ) : bad ? (
                <span className="badge t-bad">
                  <Icon name="cross" />
                  빠르지만 틀림 · 순위 제외
                </span>
              ) : (
                <span className="badge t-ok">
                  <Icon name="check" />
                  정합성 통과
                </span>
              )}
              {p.pred !== null && (
                <span className="badge t-neutral" data-testid="pred">
                  예측 {p.pred}
                  {v !== null &&
                    ` · ${p.atEnd ? '실제' : '지금'} ${v}${p.atEnd ? (p.pred === v ? ' ✓ 적중' : ' ✕ 빗나감') : ''}`}
                </span>
              )}
            </div>
            <div className="res__sub">{invariantLine(s, v, p.atEnd, g01)}</div>
            <div className="res__sub res__simstat" data-testid="sim-stat">
              {simStat}
              {!g01 && <span className="mute"> · 정상 거절(409), 실패 아님</span>}
            </div>
          </div>
        </div>
        <div className="res__zh res__zh--meas" data-testid="zone-meas">
          <span>실측 · 기록 전체 (재생 위치와 무관)</span>
          {p.hasRec &&
            (m ? (
              <span className="badge t-info" title={`run ${m.run} · ${m.condition}`}>
                {m.source}
              </span>
            ) : noMeasure ? (
              <span className="badge t-neutral">실측 없음</span>
            ) : null)}
        </div>
        <div className="res__m">
          <span className="res__label" title="기록 전체 요약 · 재생 위치와 무관">
            처리량 · 전체
          </span>
          <span className="res__num">
            {m ? fmtTput(m.throughputRps) : noData}
            <small>{measHint ? `(${measHint})` : 'req/s'}</small>
          </span>
          <div className="res__sub" title={m?.throughputSub}>
            {m ? m.throughputSub : noMeasure ? null : '성공 기준'}
          </div>
        </div>
        <div className="res__m">
          <span className="res__label" title="기록 전체 요약 · 재생 위치와 무관">
            {m?.p95Label ?? 'p95 지연'} · 전체
          </span>
          <span className="res__num">
            {p95 ? p95.n : noData}
            <small>{measHint ? `(${measHint})` : (p95?.u ?? 'ms')}</small>
          </span>
          <div className="res__sub" title={m?.p95Sub}>
            {m ? m.p95Sub : noMeasure ? null : '성공 요청'}
          </div>
        </div>
        <div className="res__m">
          <span className="res__label" title="기록 전체 요약 · 재생 위치와 무관">
            실패율 · 전체
          </span>
          <span className="res__num">
            {m ? m.failPct.toFixed(1) : noData}
            <small>{measHint ? `(${measHint})` : '%'}</small>
          </span>
          <div className="res__sub" title={m?.failSub}>
            {m ? m.failSub : noMeasure ? null : '실패 응답 비율'}
          </div>
        </div>
        {m && (
          <div className="res__src" data-testid="meas-src">
            run <code>{m.run}</code> · {m.condition}
          </div>
        )}
        {p.hasRec && p.notice?.differs && (
          <div className="res__differs" data-testid="differs">
            <span className="badge t-wait">
              <Icon name="bang" />
              실측과 다름
            </span>
            {p.notice.differs}
          </div>
        )}
        {p.endLine && p.atEnd && (
          <div className="res__end" role="status">
            {p.endLine}
          </div>
        )}
        {p.hasRec && p.notice && (
          <details className="res__about">
            <summary>이 기록에 대해 · {p.notice.label}</summary>
            <p>{p.notice.text}</p>
          </details>
        )}
        <div className="res__note">
          <span>로컬 단일 머신 · 처리 방식 간 상대 비교용</span>
          <span>{loadNote(s, g01)}</span>
        </div>
      </div>
    </section>
  );
}
