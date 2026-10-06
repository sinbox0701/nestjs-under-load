import { phaseInfo } from '../events/phases';
import type { RunEvent } from '../events/types';
import type { Gap } from '../playback/compression';
import { SPEEDS, STAGE_PER_REAL, type Speed } from '../playback/constants';

export interface PlaybackBarProps {
  P: number;
  total: number;
  playing: boolean;
  speed: Speed;
  ff: boolean;
  auto: boolean;
  folded: Gap[];
  /** 스크러버 눈금(핵심 이벤트). */
  marks: RunEvent[];
  inFoldedGap: Gap | null;
  onPlayToggle: () => void;
  onFirst: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (P: number) => void;
  onSpeed: (s: Speed) => void;
  onToggleFF: () => void;
  onToggleAuto: () => void;
}

const fmt = (ms: number) => ms.toFixed(1);

/** 기록 재생 컨트롤(DESIGN_SYSTEM §4.8). */
export function PlaybackBar(p: PlaybackBarProps) {
  const pct = (x: number) => `${(x / p.total) * 100}%`;
  const slow = Math.round(STAGE_PER_REAL / p.speed);
  const atEnd = p.P >= p.total;
  return (
    <div className="pbar">
      <div className="pbar__row">
        <button type="button" className="btn" onClick={p.onFirst} aria-label="처음">
          ⏮
        </button>
        <button type="button" className="btn" onClick={p.onPrev} aria-label="이전 단계">
          ◀
        </button>
        <button type="button" className="btn is-sel" onClick={p.onPlayToggle}>
          {p.playing ? '❚❚ 일시정지' : atEnd ? '▶ 다시 재생' : '▶ 재생'}
        </button>
        <button type="button" className="btn" onClick={p.onNext} aria-label="다음 단계">
          ▶
        </button>
        <div className="seg" role="radiogroup" aria-label="재생 속도">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={s === p.speed}
              tabIndex={s === p.speed ? 0 : -1}
              className={s === p.speed ? 'btn is-sel' : 'btn'}
              onClick={() => p.onSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
        <button type="button" className="btn" aria-pressed={p.ff} onClick={p.onToggleFF}>
          빈 구간 빨리 감기 {p.ff ? 'ON' : 'OFF'}
        </button>
        <button type="button" className="btn" aria-pressed={p.auto} onClick={p.onToggleAuto}>
          자동 멈춤 {p.auto ? 'ON' : 'OFF'}
        </button>
      </div>

      <div className="pbar__rail">
        <div className="pbar__track" aria-hidden="true">
          <i className="pbar__done" style={{ width: pct(p.P) }} />
          {p.folded.map((g) => (
            <i
              key={g.a}
              className="pbar__fold"
              style={{ left: pct(g.a), width: pct(g.b - g.a) }}
              title={`실제 ${fmt(g.b - g.a)}ms 압축 (빈 구간 빨리 감기)`}
            />
          ))}
          {p.marks.map((e) => (
            <i
              key={e.id}
              className={`pbar__tick tk-${phaseInfo(e.phase).tone}`}
              style={{ left: pct(e.t) }}
            />
          ))}
        </div>
        <input
          type="range"
          className="pbar__range"
          min={0}
          max={p.total}
          step="any"
          value={p.P}
          aria-label="재생 위치"
          aria-valuetext={`실제 +${fmt(p.P)}ms / ${fmt(p.total)}ms`}
          onChange={(e) => p.onSeek(Number(e.currentTarget.value))}
        />
      </div>

      <div className="pbar__clock small">
        <span>
          실제 +{fmt(p.P)}ms / {fmt(p.total)}ms
        </span>
        <span className="dim">
          {p.ff
            ? `이벤트 앞뒤는 ${p.speed}× (실제보다 ${slow}배 느림) · 빗금 구간은 최대 0.3초로 접음`
            : `${p.speed}× 재생 = 실제보다 ${slow}배 느림, 실제 시간 비율 그대로`}
        </span>
        {p.inFoldedGap && p.playing && (
          <span>
            ▶▶ 빈 구간 빨리 감기 중 · 실제 {fmt(p.inFoldedGap.b - p.inFoldedGap.a)}ms를 0.3초로
          </span>
        )}
      </div>
    </div>
  );
}
