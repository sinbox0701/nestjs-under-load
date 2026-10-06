import { useEffect, useRef, type KeyboardEvent } from 'react';
import {
  VERDICT_META,
  evidenceOf,
  isInjected,
  outcomeFor,
  shortRunId,
  situationSummary,
  type Evidence,
  type Highlight,
} from './loader';
import type { Concept, LabFile, Outcome, Scenario, StrategyInfo, Verdict } from './types';

/* ───────── 공통 배지 ───────── */

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const m = VERDICT_META[verdict];
  return (
    <span className={`badge t-${m.tone}`} data-verdict={verdict}>
      <span aria-hidden="true">{m.icon}</span>
      {m.label}
    </span>
  );
}

export function EvidenceBadge({ ev }: { ev: Evidence }) {
  if (ev.kind === 'measured') {
    const injected = ev.injectedMs != null;
    return (
      <span className="lab-evs">
        <span
          className="badge lab-ev lab-ev--measured"
          title={`${ev.run ? `실측 run#${ev.run}\n` : ''}${ev.text}`}
        >
          <span className="lab-ev__run">실측{ev.run ? ` run#${shortRunId(ev.run)}` : ''}</span>
        </span>
        {injected && (
          <span
            className="badge t-info lab-ev--injected"
            title={`경합 창 ${ev.injectedMs}ms 인위 지연을 주입하고 잰 실측`}
          >
            주입됨
          </span>
        )}
      </span>
    );
  }
  if (ev.kind === 'expected') {
    return (
      <span className="badge lab-ev lab-ev--expected" title={ev.text}>
        예상
      </span>
    );
  }
  return <span className="badge t-neutral">데이터 없음</span>;
}

/* ───────── 탐색기 ───────── */

const FILE_ICON: Record<string, string> = {
  ts: 'TS',
  js: 'JS',
  sql: 'DB',
  yaml: 'YM',
  yml: 'YM',
};
function icon(path: string): string {
  return FILE_ICON[path.split('.').pop() ?? ''] ?? '··';
}

interface TreeNode {
  name: string;
  path: string | null;
  file?: LabFile;
  children: TreeNode[];
}
function tree(files: LabFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: null, children: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) {
        node.children.push({ name: p, path: f.path, file: f, children: [] });
        return;
      }
      let next = node.children.find((c) => c.name === p && !c.file);
      if (!next) {
        next = { name: p, path: null, children: [] };
        node.children.push(next);
      }
      node = next;
    });
  }
  return root.children;
}

export interface ExplorerProps {
  scenarios: Scenario[];
  current: Scenario;
  activePath: string | null;
  onScenario: (dir: string) => void;
  onOpen: (path: string) => void;
}

export function Explorer({ scenarios, current, activePath, onScenario, onOpen }: ExplorerProps) {
  const packs = [...new Set(scenarios.map((s) => s.pack))];
  const renderNode = (n: TreeNode, depth: number) =>
    n.file ? (
      <li key={n.path}>
        <button
          type="button"
          className={n.path === activePath ? 'lab-tree__file is-active' : 'lab-tree__file'}
          style={{ paddingLeft: 8 + depth * 12 }}
          aria-current={n.path === activePath ? 'true' : undefined}
          onClick={() => onOpen(n.path!)}
          title={`${n.path} · ${n.file.origin === 'packs' ? 'packs에서 읽음' : 'fixture 예시'}`}
        >
          <span className="lab-tree__icon" aria-hidden="true">
            {icon(n.name)}
          </span>
          <span className="lab-tree__name">{n.name}</span>
          {n.file.origin === 'fixture' && <span className="lab-origin">예시</span>}
        </button>
      </li>
    ) : (
      <li key={`d:${n.name}`}>
        <div className="lab-tree__dir" style={{ paddingLeft: 8 + depth * 12 }}>
          <span aria-hidden="true">▾</span> {n.name}
        </div>
        <ul>{n.children.map((c) => renderNode(c, depth + 1))}</ul>
      </li>
    );

  return (
    <nav className="lab-explorer" aria-label="탐색기">
      <div className="lab-pane__h">
        <span>탐색기</span>
      </div>
      {packs.map((pack) => (
        <div key={pack} className="lab-tree">
          <div className="lab-tree__pack">
            <span aria-hidden="true">▣</span> {pack}
          </div>
          <ul>
            {scenarios
              .filter((s) => s.pack === pack)
              .map((s) => (
                <li key={s.dir}>
                  <button
                    type="button"
                    className={s.dir === current.dir ? 'lab-tree__scn is-active' : 'lab-tree__scn'}
                    aria-pressed={s.dir === current.dir}
                    onClick={() => onScenario(s.dir)}
                  >
                    <span aria-hidden="true">{s.dir === current.dir ? '▾' : '▸'}</span>
                    <span className="lab-tree__name">{s.doc.title}</span>
                  </button>
                  {s.dir === current.dir && (
                    <ul aria-label={`${s.doc.title} 파일`}>
                      {tree(s.files).map((n) => renderNode(n, 1))}
                    </ul>
                  )}
                </li>
              ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/* ───────── 상황 선택 바 ───────── */

export interface SituationBarProps {
  scenario: Scenario;
  situation: string;
  onSituation: (id: string) => void;
}

export function SituationBar({ scenario, situation, onSituation }: SituationBarProps) {
  const sits = scenario.doc.situations;
  const cur = sits.find((s) => s.id === situation);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + sits.length) % sits.length;
    onSituation(sits[n]!.id);
    refs.current[n]?.focus();
  };
  return (
    <div className="lab-sitbar">
      <div className="lab-sitbar__row">
        <span className="lab-sitbar__label small dim">상황</span>
        <div className="lab-chips" role="radiogroup" aria-label="부하·상황">
          {sits.map((s, i) => (
            <button
              key={s.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={s.id === situation}
              tabIndex={s.id === situation ? 0 : -1}
              className={s.id === situation ? 'lab-chip is-sel' : 'lab-chip'}
              onClick={() => onSituation(s.id)}
              onKeyDown={(e) => onKey(e, i)}
              title={situationSummary(s)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <label className="lab-select lab-sitbar__select">
          <span className="sr-only">상황 고르기</span>
          <select value={situation} onChange={(e) => onSituation(e.target.value)}>
            {sits.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {cur && (
        <p className="lab-sitbar__note">
          <span className="badge t-neutral">{situationSummary(cur) || cur.id}</span>
          {isInjected(cur) && <span className="badge t-info">주입됨</span>}
          {cur.note && <span>{cur.note}</span>}
        </p>
      )}
    </div>
  );
}

/* ───────── 판정 패널 ───────── */

export interface VerdictPanelProps {
  scenario: Scenario;
  situation: string;
  strategy: string;
  onStrategy: (id: string) => void;
  focus: Highlight[];
  onReveal: (line: number) => void;
}

function conceptsFor(all: Concept[], o: Outcome | null): Concept[] {
  if (!o?.concepts?.length) return all;
  return o.concepts.map((id) => all.find((c) => c.id === id)).filter((c): c is Concept => !!c);
}

export function VerdictPanel({
  scenario,
  situation,
  strategy,
  onStrategy,
  focus,
  onReveal,
}: VerdictPanelProps) {
  const { doc } = scenario;
  const sit = doc.situations.find((s) => s.id === situation);
  const o = outcomeFor(doc, strategy, situation);
  const ev = evidenceOf(o);
  const label = (id: string) => scenario.strategies.find((s) => s.id === id)?.label ?? id;
  return (
    <aside className="lab-panel" aria-label="판정">
      <section className="lab-sec">
        <h2 className="lab-sec__h">
          판정 <span className="meta">{sit?.label ?? situation}</span>
        </h2>
        <table className="lab-vt">
          <caption className="sr-only">현재 상황에서 처리 방식별 판정</caption>
          <thead>
            <tr>
              <th scope="col">처리 방식</th>
              <th scope="col">판정</th>
              <th scope="col">근거</th>
            </tr>
          </thead>
          <tbody>
            {scenario.strategies.map((s: StrategyInfo, i) => {
              const so = outcomeFor(doc, s.id, situation);
              const sel = s.id === strategy;
              return (
                <tr key={s.id} className={sel ? 'is-sel' : undefined} aria-selected={sel}>
                  <th scope="row">
                    <button
                      type="button"
                      className="lab-vt__pick"
                      aria-pressed={sel}
                      onClick={() => onStrategy(s.id)}
                      title={s.label}
                    >
                      <kbd className="lab-kbd">{i + 1}</kbd>
                      <code>{s.id}</code>
                    </button>
                  </th>
                  <td>
                    <VerdictBadge verdict={so?.verdict ?? 'n/a'} />
                  </td>
                  <td>
                    <EvidenceBadge ev={evidenceOf(so)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="lab-sec" aria-label="선택한 처리 방식">
        <h2 className="lab-sec__h">
          <code>{strategy}</code>
          {o && <VerdictBadge verdict={o.verdict} />}
        </h2>
        <p className="small dim">{label(strategy)}</p>
        {o ? (
          <>
            <p className="lab-why">
              <b>왜? </b>
              {o.why || '—'}
            </p>
            <div className={`lab-evbox lab-evbox--${ev.kind}`}>
              <EvidenceBadge ev={ev} />
              <span>{ev.kind === 'none' ? '예상·실측 없음' : ev.text}</span>
            </div>
            {o.measured && o.expected && (
              <p className="small dim">
                예상이었던 것: <span>{o.expected}</span>
              </p>
            )}
            {focus.length > 0 && (
              <>
                <h3 className="lab-sub">이 상황에서 볼 줄</h3>
                <ul className="lab-focus">
                  {focus.map((h) => (
                    <li key={h.marker}>
                      <button
                        type="button"
                        className="lab-focus__btn"
                        onClick={() => onReveal(h.line)}
                      >
                        <span className={`lab-dot lab-dot--${h.tone}`} aria-hidden="true" />
                        <code>
                          L{h.line}
                          {h.endLine > h.line ? `–${h.endLine}` : ''}
                        </code>{' '}
                        <code className="dim">{h.marker}</code>
                        <span className="lab-focus__txt">{h.text}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {o.sql.length > 0 && (
              <>
                <h3 className="lab-sub">그 순간 나가는 SQL</h3>
                <pre className="sql lab-sql">{o.sql.join('\n')}</pre>
              </>
            )}
          </>
        ) : (
          <p className="dim">이 조합의 판정 데이터가 없다.</p>
        )}
      </section>

      <section className="lab-sec" aria-label="관련 개념">
        <h2 className="lab-sec__h">관련 개념</h2>
        <div className="lab-cards">
          {conceptsFor(doc.concepts, o).map((c) => (
            <details key={c.id} className="lab-card">
              <summary>{c.label}</summary>
              <p>{c.body}</p>
            </details>
          ))}
        </div>
      </section>

      {doc.choose.length > 0 && (
        <section className="lab-sec" aria-label="결정 가이드">
          <h2 className="lab-sec__h">
            이 상황이면 이 코드 <span className="meta">결정 가이드</span>
          </h2>
          <ul className="lab-choose">
            {doc.choose.map((c, i) => {
              const pv = outcomeFor(doc, c.pick, situation)?.verdict ?? 'n/a';
              return (
                <li key={i} className={c.pick === strategy ? 'is-sel' : undefined}>
                  <p className="lab-choose__when">{c.when}</p>
                  <p>
                    <span aria-hidden="true">→ </span>
                    <button type="button" className="lab-link" onClick={() => onStrategy(c.pick)}>
                      <code>{c.pick}</code>
                    </button>{' '}
                    <span className="small dim">지금 상황:</span> <VerdictBadge verdict={pv} />
                  </p>
                  <p className="dim">{c.because}</p>
                  {c.avoid.length > 0 && (
                    <p className="small">
                      피할 것:{' '}
                      {c.avoid.map((a) => (
                        <button
                          key={a}
                          type="button"
                          className="lab-link lab-avoid"
                          onClick={() => onStrategy(a)}
                        >
                          <code>{a}</code>
                        </button>
                      ))}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </aside>
  );
}

/* ───────── 매트릭스 ───────── */

export interface MatrixProps {
  scenario: Scenario;
  situation: string;
  strategy: string;
  onPick: (strategy: string, situation: string) => void;
}

export function Matrix({ scenario, situation, strategy, onPick }: MatrixProps) {
  const { doc } = scenario;
  return (
    <section className="lab-matrix" aria-label="전체 판정 매트릭스">
      <div className="lab-pane__h">
        <span>매트릭스 · 처리 방식 × 상황</span>
        <span className="small dim">칸을 누르면 그 조합으로 이동</span>
      </div>
      <div className="lab-matrix__scroll">
        <table className="lab-mt">
          <thead>
            <tr>
              <th scope="col">처리 방식 \ 상황</th>
              {doc.situations.map((s) => (
                <th key={s.id} scope="col" className={s.id === situation ? 'is-cur' : undefined}>
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {scenario.strategies.map((st) => (
              <tr key={st.id}>
                <th scope="row" className={st.id === strategy ? 'is-cur' : undefined}>
                  <code>{st.id}</code>
                </th>
                {doc.situations.map((s) => {
                  const o = outcomeFor(doc, st.id, s.id);
                  const v = o?.verdict ?? 'n/a';
                  const cur = st.id === strategy && s.id === situation;
                  const ev = evidenceOf(o);
                  return (
                    <td key={s.id}>
                      <button
                        type="button"
                        className={cur ? 'lab-mt__cell is-cur' : 'lab-mt__cell'}
                        aria-current={cur ? 'true' : undefined}
                        aria-label={`${st.id} × ${s.label}: ${VERDICT_META[v].label}${ev.kind === 'measured' ? (ev.injectedMs != null ? ' (실측·주입됨)' : ' (실측)') : ''}`}
                        onClick={() => onPick(st.id, s.id)}
                      >
                        <VerdictBadge verdict={v} />
                        {ev.kind === 'measured' && (
                          <span className="lab-ev lab-ev--measured badge">
                            {ev.injectedMs != null ? '실측·주입됨' : '실측'}
                          </span>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ───────── 도움말 ───────── */

const SHORTCUTS: [string, string][] = [
  ['[ / ]', '이전 / 다음 상황'],
  ['J / K', '다음 / 이전 처리 방식'],
  ['1 – 9', '처리 방식 바로 고르기'],
  ['D', '나란히 비교 켜기/끄기'],
  ['M', '매트릭스 보기'],
  ['E', '탐색기 접기/펴기'],
  ['?', '이 도움말'],
  ['Esc', '도움말 닫기'],
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus();
  }, []);
  return (
    <div className="lab-modal" onClick={onClose}>
      <div
        ref={ref}
        className="panel lab-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lab-help-h"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id="lab-help-h" className="panel__h">
          단축키 <span className="meta">Esc로 닫기</span>
        </h2>
        <dl className="lab-help__list">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd className="lab-kbd">{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="small dim">
          에디터 안에 포커스가 있을 때는 단축키가 꺼진다. 마커 줄(거터 아이콘)에 마우스를 올리면
          설명이 뜬다.
        </p>
        <button type="button" className="btn" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}
