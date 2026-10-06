import { phaseInfo, type PhaseGroup } from '../events/phases';
import type { RunEvent } from '../events/types';
import { currentRowIndex, type Row, type RowView } from '../playback/rows';

const GROUPS: { id: PhaseGroup; label: string; key: boolean }[] = [
  { id: 'arrive', label: '도착·응답', key: false },
  { id: 'io', label: '읽기·쓰기', key: false },
  { id: 'lock', label: '락', key: true },
  { id: 'conflict', label: '충돌', key: true },
  { id: 'retry', label: '재시도', key: true },
  { id: 'commit', label: '커밋', key: true },
  { id: 'lost', label: '잃어버린 수정', key: true },
];

export interface TimelineProps {
  rows: Row[];
  events: RunEvent[];
  actors: string[];
  labels: string[];
  P: number;
  total: number;
  view: RowView;
  off: ReadonlySet<PhaseGroup>;
  onView: (v: RowView) => void;
  onToggleGroup: (g: PhaseGroup) => void;
  /** 행을 누르면 그 시점으로 이동하고 일시정지. */
  onPickRow: (row: Row) => void;
}

const fmt = (ms: number) => ms.toFixed(1);

/** 이벤트 타임라인(DESIGN_SYSTEM §4.7, §4.9). */
export function Timeline(p: TimelineProps) {
  const now = currentRowIndex(p.rows, p.P);
  const pct = (t: number) => `${(t / p.total) * 100}%`;
  return (
    <section className="panel timeline" aria-label="이벤트 타임라인">
      <h2 className="panel__h">
        이벤트 타임라인 <span className="meta">대표 {p.actors.length}명</span>
      </h2>
      <div className="timeline__tools">
        <div className="seg" role="radiogroup" aria-label="보기">
          {(['key', 'all'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={p.view === v}
              tabIndex={p.view === v ? 0 : -1}
              className={p.view === v ? 'btn is-sel' : 'btn'}
              onClick={() => p.onView(v)}
            >
              {v === 'key' ? '핵심만' : '전체'}
            </button>
          ))}
        </div>
        {GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            className="btn small"
            aria-pressed={!p.off.has(g.id)}
            disabled={p.view === 'key' && !g.key}
            onClick={() => p.onToggleGroup(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>

      <div className="timeline__lanes">
        {p.actors.map((actor, i) => (
          <div key={actor} className="lane">
            <span className={`chip a${i}`}>{p.labels[i]}</span>
            <div className="lane__track">
              {p.events
                .filter((e) => e.actor === actor && e.t <= p.P)
                .map((e) => (
                  <i
                    key={e.id}
                    className={`lane__mark tk-${phaseInfo(e.phase).tone}`}
                    style={{ left: pct(e.t) }}
                    title={phaseInfo(e.phase).label}
                  />
                ))}
              <i className="lane__now" style={{ left: pct(p.P) }} />
            </div>
          </div>
        ))}
      </div>

      <ol className="timeline__rows">
        {p.rows.map((row, i) => {
          const info = phaseInfo(row.phase);
          const first = row.events[0]!;
          const n = row.events.length;
          const time = n > 1 ? `+${fmt(row.t)}–${fmt(row.tEnd)}ms` : `+${fmt(row.t)}ms`;
          return (
            <li
              key={`${row.phase}@${row.t}`}
              className={i === now ? 'row is-now' : row.t > p.P ? 'row is-future' : 'row'}
              aria-current={i === now ? 'step' : undefined}
            >
              <button type="button" className="row__btn" onClick={() => p.onPickRow(row)}>
                <span className="row__t small">{time}</span>
                <span>
                  {row.events.map((e) => {
                    const idx = p.actors.indexOf(e.actor);
                    return (
                      <span key={e.id} className={`chip a${idx}`}>
                        {p.labels[idx] ?? e.actor}
                      </span>
                    );
                  })}
                </span>
                <span className={`badge t-${info.tone}`}>
                  {info.label}
                  {n > 1 ? ` ×${n}` : ''}
                </span>
                <span className="row__d">
                  {first.note ?? ''}
                  {n > 1 ? ` 외 ${n - 1}건` : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="small dim">
        시간은 기록 시작부터의 실제 ms(재생 시간 아님). 행을 누르면 그 시점으로 이동해 멈춥니다.
      </p>
    </section>
  );
}
