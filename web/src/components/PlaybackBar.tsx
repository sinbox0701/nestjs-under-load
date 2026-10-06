import { useState, type MouseEvent, type ReactNode, type Ref } from 'react';
import type { RoundInfo } from '../events/types';
import type { Gap } from '../playback/compression';
import { SPEEDS, STAGE_PER_REAL, type Speed } from '../playback/constants';
import { SPEED_LABELS } from './lib/config';
import { Icon } from './lib/icons';
import { roundAt } from '../playback/prepare';
import { fmtMs } from './lib/model';
import { Seg } from './lib/Seg';

export interface Tick {
  t: number;
  tone: 'bad' | 'wait' | 'retry' | 'read';
}

export interface PlaybackBarProps {
  hasRec: boolean;
  /** 실행 중(기록 만드는 중) 단계. null이면 실행 중 아님. */
  runStep: number | null;
  rounds: RoundInfo[];
  P: number;
  total: number;
  playing: boolean;
  /** 자동 멈춤 설명이 떠 있음 → 큰 버튼은 `계속`. */
  paused: boolean;
  speed: Speed;
  ff: boolean;
  auto: boolean;
  autoCause: boolean;
  /** 접히는 빈 구간(빗금). */
  folded: Gap[];
  ticks: Tick[];
  /** 기록 끝 요약(굵게). 끝이 아니면 null. */
  endSummary: string | null;
  onPlayToggle: () => void;
  onFirst: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (P: number) => void;
  onSpeed: (s: Speed) => void;
  onToggleFF: () => void;
  onToggleAuto: () => void;
  onToggleCause: () => void;
  /** 키보드로 누른 버튼을 잠깐 눌린 모양으로. */
  pressed?: 'play' | 'prev' | 'next' | null;
  /** 무대가 배율 계산에 재생 바 높이를 잰다. */
  sectionRef?: Ref<HTMLElement>;
}

const slowOf = (speed: number) => Math.round(STAGE_PER_REAL / speed);

/** 기록 재생 컨트롤(DESIGN_SYSTEM §4.8). 재생 바는 실행하지 않는다(실행 진입점은 `실행하기` 하나). */
export function PlaybackBar({ sectionRef, ...p }: PlaybackBarProps) {
  const [scrubTip, setScrubTip] = useState('');
  const running = p.runStep !== null;
  const has = p.hasRec && !running;
  const atEnd = p.hasRec && p.P >= p.total;
  const pct = (x: number) => `${(x / (p.total || 1)) * 100}%`;
  const slow = slowOf(p.speed);
  const base = `실제의 1/${slow} 속도로 재생${p.ff ? ' · 빈 구간 접음' : ' · 실제 시간 비율 그대로'}`;
  const rd = p.hasRec ? roundAt(p, p.P) : null;

  let label: ReactNode;
  let aria: string;
  if (running) {
    label = (
      <>
        <Icon name="wait" />
        실행 중
      </>
    );
    aria = '실행 중';
  } else if (!p.hasRec || (!p.playing && !p.paused && !atEnd)) {
    label = (
      <>
        <Icon name="play" />
        재생
      </>
    );
    aria = '재생';
  } else if (p.playing) {
    label = (
      <>
        <Icon name="stop" />
        일시정지
      </>
    );
    aria = '일시정지';
  } else if (p.paused) {
    label = (
      <>
        <Icon name="play" />
        계속
      </>
    );
    aria = '계속';
  } else {
    label = (
      <>
        <Icon name="retry" />
        다시 보기
      </>
    );
    aria = '다시 보기';
  }

  let clockPos = '기록 없음';
  let clockTitle = '';
  if (running) clockPos = `실행 중 R${p.runStep}/${p.rounds.length || 4}`;
  else if (rd) {
    const lt = p.P - rd.start;
    clockPos = `R${rd.index + 1}/${p.rounds.length} · +${fmtMs(lt)}ms / ${fmtMs(rd.end - rd.start)}ms`;
    clockTitle = `라운드 시작부터 실제 경과 · 기록 전체 ${fmtMs(p.P)} / ${fmtMs(p.total)}ms · 실제의 1/${slow} 속도로 재생 · 편집 구간은 사람 시간을 압축한 것`;
  }

  const onMove = (e: MouseEvent<HTMLInputElement>) => {
    if (!p.hasRec) return;
    const r = e.currentTarget.getBoundingClientRect();
    const P = Math.max(0, ((e.clientX - r.left) / (r.width || 1)) * p.total);
    const g = p.folded.find((x) => P >= x.a && P < x.b);
    const rr = roundAt(p, P);
    setScrubTip(
      g
        ? `실제 ${fmtMs(g.b - g.a)}ms 압축 (빈 구간 빨리 감기)`
        : `R${rr.index + 1} · 실제 +${fmtMs(P - rr.start)}ms`,
    );
  };

  return (
    <section ref={sectionRef} className="panel a-transport" aria-label="기록 재생">
      <div className="transport" role="group" aria-label="기록 재생">
        <div className="tp-btns">
          <button
            className="tbtn"
            type="button"
            aria-label="처음으로 (Home)"
            title="처음으로 (Home)"
            disabled={!has}
            onClick={p.onFirst}
          >
            <span style={{ display: 'inline-flex' }}>
              <Icon name="stop" />
              <Icon name="play" flip />
            </span>
          </button>
          <button
            className={p.pressed === 'prev' ? 'tbtn is-pressed' : 'tbtn'}
            type="button"
            aria-label="이전 단계 (←)"
            title="이전 단계 (←)"
            disabled={!has}
            onClick={p.onPrev}
          >
            <Icon name="play" flip />
          </button>
          <button
            className={p.pressed === 'play' ? 'tbtn tbtn--play is-pressed' : 'tbtn tbtn--play'}
            type="button"
            aria-label={`${aria} (Space)`}
            title={p.hasRec ? undefined : '재생할 기록이 없다 — 먼저 실행하기(Enter)'}
            disabled={!has}
            onClick={p.onPlayToggle}
          >
            {label}
          </button>
          <button
            className={p.pressed === 'next' ? 'tbtn is-pressed' : 'tbtn'}
            type="button"
            aria-label="다음 단계 (→)"
            title="다음 단계 (→)"
            disabled={!has}
            onClick={p.onNext}
          >
            <Icon name="play" />
          </button>
        </div>
        <div className="field field--inline">
          <span className="lbl">속도</span>
          <Seg<Speed>
            label="재생 속도"
            className="seg--sm"
            value={p.speed}
            onChange={p.onSpeed}
            items={SPEEDS.map((s, i) => ({
              value: s,
              label: SPEED_LABELS[i],
              title: `실제의 1/${slowOf(s)} 속도`,
            }))}
          />
        </div>
        <div className="autobox">
          <button
            className="toggle"
            type="button"
            aria-pressed={p.auto}
            title="충돌·잃어버린 수정·락 대기·잠금 거절에서 자동으로 멈춤 (A)"
            onClick={p.onToggleAuto}
          >
            <i aria-hidden="true" />
            자동 멈춤
          </button>
          <label className="chk" title="두 번째 사람이 같은 버전을 받는 순간(원인)에서도 멈춤">
            <input
              type="checkbox"
              checked={p.autoCause}
              disabled={!p.auto}
              onChange={p.onToggleCause}
            />
            원인에서도
          </label>
        </div>
        <button
          className="toggle ff-toggle"
          type="button"
          aria-pressed={p.ff}
          title="이벤트가 없는 구간(걷기·편집 같은 사람 시간)을 최대 0.3초로 접음 (F). 걷기 같은 이동은 기록된 두 이벤트 사이의 보간일 뿐, 이벤트 없이 상태가 바뀌지 않는다"
          onClick={p.onToggleFF}
        >
          <i aria-hidden="true" />빈 구간 빨리 감기
        </button>
        <div className="scrub">
          <div className="scrub__rail" aria-hidden="true">
            {p.hasRec && (
              <>
                <i className="scrub__fill" style={{ width: pct(p.P) }} />
                {p.ff &&
                  p.folded.map((g) => (
                    <i
                      key={`gz${g.a}`}
                      className="gz"
                      style={{ left: pct(g.a), width: pct(g.b - g.a) }}
                    />
                  ))}
                {p.rounds.map((r) => (
                  <span key={`r${r.index}`}>
                    {r.index > 0 && <i className="rd" style={{ left: pct(r.start) }} />}
                    <span className="rl" style={{ left: pct(r.start) }}>
                      R{r.index + 1}
                    </span>
                  </span>
                ))}
                {p.ticks.map((k, i) => (
                  <i key={`tk${i}`} className={`tk ${k.tone}`} style={{ left: pct(k.t) }} />
                ))}
              </>
            )}
          </div>
          <input
            type="range"
            min={0}
            max={p.hasRec ? p.total : 1}
            step="any"
            value={p.hasRec ? p.P : 0}
            aria-label="재생 위치"
            aria-valuetext={clockPos}
            disabled={!has}
            title={scrubTip}
            onMouseMove={onMove}
            onChange={(e) => p.onSeek(Number(e.currentTarget.value))}
          />
        </div>
        <div className="clock">
          <span className="pos" title={clockTitle}>
            {clockPos}
          </span>
          {p.endSummary && atEnd ? (
            <span className="end">{p.endSummary}</span>
          ) : (
            <span>{base}</span>
          )}
        </div>
      </div>
    </section>
  );
}
