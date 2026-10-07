import { useEffect, useMemo, useRef, useState } from 'react';
import { PHASE_GROUPS, type PhaseGroup } from '../events/phases';
import { roundAt, type Prepared } from '../playback/prepare';
import type { Row, RowView } from '../playback/rows';
import type { AutoStop } from '../playback/stops';
import { LABELS, type ScenarioId } from './lib/config';
import { Icon } from './lib/icons';
import { Seg } from './lib/Seg';
import {
  KEY_GROUPS,
  actorIdx,
  actorLabel,
  bandsOf,
  causeRow,
  currentRow,
  fmtMs,
  groupIcon,
  legendOf,
  phaseIcon,
  rowRound,
  type Band,
} from './lib/model';

const pctOf = (x: number, span: number) => Math.max(0, Math.min(100, (x / (span || 1)) * 100));

/** 띠 하나(라운드 시작 기준 시각). 아직 오지 않은 부분은 그리지 않는다. */
export function BandEl({ b, span, lt }: { b: Band; span: number; lt: number }) {
  if (b.kind === 'mark') {
    if (b.t > lt) return null;
    return (
      <i className={`mark ${b.mark}`} style={{ left: `${pctOf(b.t, span)}%` }} title={b.tip} />
    );
  }
  const start = Math.max(0, b.start);
  if (start > lt) return null;
  const w = Math.max(0.4, pctOf(Math.min(b.end, lt), span) - pctOf(start, span));
  return (
    <i
      className={`bd ${b.cls}`}
      style={{ left: `${pctOf(start, span)}%`, width: `${w}%` }}
      title={b.tip}
    />
  );
}

export interface TimelineProps {
  hasRec: boolean;
  prepared: Prepared;
  scenario: ScenarioId;
  strategyId: string;
  /** 기록이 없을 때 그릴 빈 레인 수. */
  people: number;
  P: number;
  /** 재생 엔진이 묶은 행(같은 phase·mergeKey · 1.4초 안 → ×N). */
  rows: Row[];
  view: RowView;
  off: ReadonlySet<PhaseGroup>;
  callout: AutoStop | null;
  onView: (v: RowView) => void;
  onToggleGroup: (g: PhaseGroup) => void;
  /** 행을 누르면 그 시점으로 이동하고 일시정지. */
  onPickRow: (row: Row) => void;
}

/** 이벤트 타임라인(DESIGN_SYSTEM §4.7, §4.9): 요청별 트랜잭션 띠 레인 + 행 목록. */
export function Timeline(p: TimelineProps) {
  const [open, setOpen] = useState(true);
  const listRef = useRef<HTMLOListElement>(null);
  const { prepared } = p;
  const rec = prepared.recording;
  const meta = rec.meta;
  const rounds = prepared.rounds;
  const rd = roundAt(prepared, p.P);
  const span = rd.end - rd.start;
  const lt = p.P - rd.start;
  const lanes = useMemo(
    () =>
      p.hasRec
        ? meta.actors.map((id) => bandsOf(rec, prepared.events, rounds, rd, id, prepared.info))
        : Array.from({ length: p.people }, () => [] as Band[]),
    [p.hasRec, meta, rec, prepared, rounds, rd, p.people],
  );
  const vrows = useMemo(
    () => (p.hasRec ? p.rows.filter((r) => rowRound(rounds, r) === rd.index) : []),
    [p.hasRec, p.rows, rounds, rd.index],
  );
  const cur = currentRow(vrows, p.P);
  const cause = causeRow(vrows, meta, p.callout);
  const present = useMemo(() => {
    const s = new Set<PhaseGroup>();
    for (const e of prepared.events) s.add(prepared.info(e.phase).group);
    return s;
  }, [prepared]);
  const groups = PHASE_GROUPS.filter((g) => g.id !== 'other' || present.has('other'));

  // 현재 행이 목록 밖이면 목록 안에서만 스크롤(페이지는 건드리지 않는다)
  useEffect(() => {
    const list = listRef.current;
    const now = list?.querySelector<HTMLElement>('.is-now');
    if (!list || !now) return;
    const top = now.offsetTop - list.offsetTop;
    const h = list.clientHeight;
    if (top < list.scrollTop || top + now.offsetHeight > list.scrollTop + h)
      list.scrollTop = top - h / 3;
  }, [cur, rd.index]);

  const legend = legendOf(p.hasRec ? rec : null, p.scenario, p.strategyId, prepared.info);
  const n = rounds.length;
  return (
    <section className="panel a-timeline" aria-label="이벤트 타임라인">
      <div className="panel__h">
        <button
          className="tl-toggle"
          type="button"
          aria-expanded={open}
          aria-controls="tlBody"
          onClick={() => setOpen(!open)}
        >
          <span className="car" aria-hidden="true">
            ▾
          </span>
          이벤트 타임라인
        </button>
        <div className="prog">
          <span className="meta">{p.hasRec ? `라운드 ${rd.index + 1}/${n}` : '라운드 —'}</span>
          <span className="prog__bar">
            <i
              style={{
                width: p.hasRec ? `${((rd.index + Math.min(1, lt / (span || 1))) / n) * 100}%` : 0,
              }}
            />
          </span>
        </div>
      </div>
      <div className="panel__b" id="tlBody" hidden={!open}>
        <div className="tl-tools">
          <Seg<RowView>
            label="표시 범위"
            className="seg--sm"
            value={p.view}
            onChange={p.onView}
            items={[
              { value: 'key', label: '핵심만' },
              { value: 'all', label: '전체' },
            ]}
          />
          <div className="filters" role="group" aria-label="이벤트 종류 필터">
            {groups.map((g) => {
              const dis = p.view === 'key' && !KEY_GROUPS.has(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  className={`fchip t-${g.tone}`}
                  aria-pressed={!p.off.has(g.id) && !dis}
                  disabled={dis}
                  title={dis ? '"전체"에서만 보이는 종류' : undefined}
                  onClick={() => p.onToggleGroup(g.id)}
                >
                  <Icon name={groupIcon(g.id)} />
                  {g.id === 'lost' && p.scenario === 'g02-stock-decrement'
                    ? '잃어버린 갱신'
                    : g.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="legend" aria-label="레인 범례">
          {legend.map((it) => (
            <span key={`${it.cls}:${it.text}`}>
              <i className={it.cls.startsWith('mark') ? it.cls : `bd ${it.cls}`} />
              {it.text}
            </span>
          ))}
        </div>
        <div className="lanes">
          {lanes.map((bands, i) => (
            <div className="lane" key={i}>
              <span className={`chip a${i % 4}`}>
                {p.hasRec ? actorLabel(meta, meta.actors[i]!) : LABELS[i]}
              </span>
              <div className="lane__track" data-testid={`lane-${i}`}>
                {p.hasRec && (
                  <>
                    <i className="ph" style={{ left: `${Math.min(99.5, pctOf(lt, span))}%` }} />
                    {bands.map((b, k) => (
                      <BandEl key={k} b={b} span={span} lt={lt} />
                    ))}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
        <ol
          ref={listRef}
          className="log"
          aria-label="이번 라운드 이벤트 (행을 누르면 그 시점으로 이동)"
        >
          {!p.hasRec ? (
            <li className="empty is-future">실행하면 기록이 여기에 쌓입니다</li>
          ) : vrows.length === 0 ? (
            <li className="empty is-future">필터에 맞는 이벤트 없음</li>
          ) : (
            vrows.map((row, k) => {
              const info = prepared.info(row.phase);
              const e0 = row.events[0]!;
              const N = row.events.length;
              const who = [...new Set(row.events.map((e) => e.actor))];
              const d = N > 1 ? `${e0.note ?? ''} 외 ${N - 1}건` : (e0.note ?? '');
              const cls = [
                info.key ? 'is-key' : '',
                k === cur ? 'is-now' : '',
                k > cur && k !== cause ? 'is-future' : '',
                k === cause ? 'is-cause' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <li
                  key={`${row.t}:${k}`}
                  className={cls || undefined}
                  aria-current={k === cur ? 'step' : undefined}
                >
                  <button
                    type="button"
                    title={`${d} — 누르면 이 시점으로 이동`}
                    onClick={() => p.onPickRow(row)}
                  >
                    <span className="ts">
                      +{fmtMs(row.t - rd.start)}
                      {N > 1 ? `–${fmtMs(row.tEnd - rd.start)}` : ''}ms
                    </span>
                    <span className="who">
                      {who.map((a) => (
                        <span key={a} className={`chip a${actorIdx(meta, a) % 4}`}>
                          {actorLabel(meta, a)}
                        </span>
                      ))}
                    </span>
                    <span className={`badge t-${info.tone}`}>
                      <Icon name={phaseIcon(row.phase, info)} />
                      {info.label}
                      {N > 1 ? ` ×${N}` : ''}
                    </span>
                    <span className="d">{d}</span>
                  </button>
                </li>
              );
            })
          )}
        </ol>
        <p className="note">
          시간은 라운드 시작부터의 실제 경과 시간(ms)입니다. 편집 구간(사람 시간)은 압축해서
          그립니다. 캐릭터 이동은 기록된 이벤트 사이의 보간이며, 이벤트 없이 상태가 바뀌지 않습니다.
          같은 사람의 같은 종류가 이어지면 ×N으로 묶습니다.
        </p>
      </div>
    </section>
  );
}
