import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { highlightsFor, languageOf, outcomeFor } from './loader';
import { Explorer, HelpDialog, Matrix, SituationBar, VerdictPanel } from './panels';
import { scenarios as bundled } from './sources';
import type { Scenario } from './types';
import './lab.css';

const CodeEditor = lazy(() => import('./CodeEditor'));

function isTyping(el: EventTarget | null): boolean {
  return (
    el instanceof HTMLElement &&
    (el.matches(
      'input:not([type=checkbox]):not([type=radio]), select, textarea, [contenteditable="true"]',
    ) ||
      !!el.closest('.monaco-editor'))
  );
}

const strategyPath = (id: string) => `strategies/${id}.strategy.ts`;

export interface CodeLabProps {
  scenarios?: Scenario[];
}

export function CodeLab({ scenarios = bundled }: CodeLabProps) {
  const [dir, setDir] = useState(scenarios[0]?.dir ?? '');
  const scenario = scenarios.find((s) => s.dir === dir) ?? scenarios[0];
  const [situation, setSituation] = useState(scenario?.doc.situations[0]?.id ?? '');
  const [strategy, setStrategy] = useState(scenario?.strategies[0]?.id ?? '');
  const [tabs, setTabs] = useState<string[]>(() =>
    scenario?.strategies[0]?.file ? [scenario.strategies[0].file] : [],
  );
  const [active, setActive] = useState<string | null>(tabs[0] ?? null);
  const [compare, setCompare] = useState(false);
  const [compareWith, setCompareWith] = useState<string>(
    scenario?.strategies.find((s) => s.id !== strategy)?.id ?? '',
  );
  const [matrix, setMatrix] = useState(false);
  // 좁은 폭(<1024px)에서는 탐색기를 접은 채 시작한다.
  const [explorer, setExplorer] = useState(
    () => window.matchMedia?.('(min-width: 1024px)').matches ?? true,
  );
  const [help, setHelp] = useState(false);
  const [lineNumbers, setLineNumbers] = useState(true);
  const [minimap, setMinimap] = useState(false);
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(null);

  const openFile = useCallback((path: string) => {
    setTabs((t) => (t.includes(path) ? t : [...t, path]));
    setActive(path);
  }, []);

  const pickStrategy = useCallback(
    (id: string) => {
      if (!scenario) return;
      setStrategy(id);
      const info = scenario.strategies.find((s) => s.id === id);
      if (info?.file) openFile(info.file);
      setCompareWith((c) =>
        c === id ? (scenario.strategies.find((s) => s.id !== id)?.id ?? c) : c,
      );
    },
    [scenario, openFile],
  );

  const pickScenario = (d: string) => {
    const s = scenarios.find((x) => x.dir === d);
    if (!s || d === dir) return;
    setDir(d);
    setSituation(s.doc.situations[0]?.id ?? '');
    const first = s.strategies[0];
    setStrategy(first?.id ?? '');
    setCompareWith(s.strategies[1]?.id ?? '');
    setTabs(first?.file ? [first.file] : []);
    setActive(first?.file ?? null);
  };

  const onOpen = (path: string) => {
    const id = /^strategies\/(.+)\.strategy\.ts$/.exec(path)?.[1];
    if (id && scenario?.strategies.some((s) => s.id === id)) pickStrategy(id);
    else openFile(path);
  };

  const closeTab = (path: string) => {
    const next = tabs.filter((x) => x !== path);
    setTabs(next);
    if (active === path) setActive(next[next.length - 1] ?? null);
  };

  // 키보드 단축키(에디터·입력 안에서는 끈다)
  useEffect(() => {
    if (!scenario) return;
    const sits = scenario.doc.situations;
    const sts = scenario.strategies;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (help) return;
      const si = sits.findIndex((s) => s.id === situation);
      const ti = sts.findIndex((s) => s.id === strategy);
      const k = e.key;
      if (k === ']' && sits.length) setSituation(sits[(si + 1) % sits.length]!.id);
      else if (k === '[' && sits.length)
        setSituation(sits[(si - 1 + sits.length) % sits.length]!.id);
      else if ((k === 'j' || k === 'J') && sts.length) pickStrategy(sts[(ti + 1) % sts.length]!.id);
      else if ((k === 'k' || k === 'K') && sts.length)
        pickStrategy(sts[(ti - 1 + sts.length) % sts.length]!.id);
      else if (/^[1-9]$/.test(k) && sts[Number(k) - 1]) pickStrategy(sts[Number(k) - 1]!.id);
      else if (k === 'd' || k === 'D') setCompare((c) => !c);
      else if (k === 'm' || k === 'M') setMatrix((m) => !m);
      else if (k === 'e' || k === 'E') setExplorer((x) => !x);
      else if (k === '?') setHelp(true);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scenario, situation, strategy, help, pickStrategy]);

  const activeFile = scenario?.files.find((f) => f.path === active) ?? null;
  const activeStrategy = useMemo(() => {
    const id = active ? /^strategies\/(.+)\.strategy\.ts$/.exec(active)?.[1] : undefined;
    return id ?? null;
  }, [active]);

  const mainHl = useMemo(() => {
    if (!scenario || !activeFile || !activeStrategy) return [];
    return highlightsFor(
      scenario.files,
      outcomeFor(scenario.doc, activeStrategy, situation),
      activeFile.path,
    );
  }, [scenario, activeFile, activeStrategy, situation]);

  const cmpFile =
    compare && activeStrategy
      ? (scenario?.files.find((f) => f.path === strategyPath(compareWith)) ?? null)
      : null;
  const cmpHl = useMemo(() => {
    if (!scenario || !cmpFile) return [];
    return highlightsFor(
      scenario.files,
      outcomeFor(scenario.doc, compareWith, situation),
      cmpFile.path,
    );
  }, [scenario, cmpFile, compareWith, situation]);

  // 판정 패널의 "볼 줄"은 선택한 strategy 기준
  const panelFocus = useMemo(() => {
    if (!scenario) return [];
    return highlightsFor(
      scenario.files,
      outcomeFor(scenario.doc, strategy, situation),
      strategyPath(strategy),
    );
  }, [scenario, strategy, situation]);

  if (!scenario) {
    return (
      <main className="lab lab--empty">
        <p>learn.yaml이 있는 시나리오가 없다. packs/**/learn.yaml 또는 fixture를 확인할 것.</p>
      </main>
    );
  }

  const label = (id: string) => scenario.strategies.find((s) => s.id === id)?.label ?? id;

  return (
    <main
      className={`lab${explorer ? '' : ' lab--noexp'}${matrix ? ' lab--matrix' : ''}`}
      aria-label="코드 실험실"
    >
      <div className="lab-area-bar">
        <div className="lab-titlebar">
          <button
            type="button"
            className="btn lab-iconbtn"
            aria-pressed={explorer}
            aria-label="탐색기 접기/펴기 (E)"
            title="탐색기 (E)"
            onClick={() => setExplorer((x) => !x)}
          >
            ☰
          </button>
          <h1 className="lab-title">
            <span className="badge t-neutral">
              {scenario.doc.scenario.slice(0, 3).toUpperCase()}
            </span>{' '}
            {scenario.doc.title}
          </h1>
          <span
            className={scenario.learnOrigin === 'packs' ? 'badge t-ok' : 'badge lab-fixture'}
            title={
              scenario.learnOrigin === 'packs'
                ? `packs/${scenario.dir}/learn.yaml에서 읽음`
                : `packs/${scenario.dir}/learn.yaml이 없어 web 안 예시 데이터를 보여 줌`
            }
          >
            {scenario.learnOrigin === 'packs' ? '✓ packs 데이터' : '예시 데이터(fixture)'}
          </span>
          <span className="lab-titlebar__tools">
            <button
              type="button"
              className="btn"
              aria-pressed={matrix}
              onClick={() => setMatrix((m) => !m)}
              title="매트릭스 (M)"
            >
              ▦ 매트릭스
            </button>
            <button type="button" className="btn" onClick={() => setHelp(true)} title="단축키 (?)">
              단축키 ?
            </button>
          </span>
        </div>
        <SituationBar scenario={scenario} situation={situation} onSituation={setSituation} />
      </div>

      {explorer && (
        <div className="lab-area-exp">
          <Explorer
            scenarios={scenarios}
            current={scenario}
            activePath={active}
            onScenario={pickScenario}
            onOpen={onOpen}
          />
        </div>
      )}

      <section className="lab-area-editor lab-editor" aria-label="에디터">
        <div className="lab-tabs" role="tablist" aria-label="열린 파일">
          {tabs.map((p) => {
            const f = scenario.files.find((x) => x.path === p);
            return (
              <div key={p} className={p === active ? 'lab-tab is-active' : 'lab-tab'}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={p === active}
                  className="lab-tab__btn"
                  onClick={() => onOpen(p)}
                  title={p}
                >
                  {p.split('/').pop()}
                  {f?.origin === 'fixture' && <span className="lab-origin">예시</span>}
                </button>
                <button
                  type="button"
                  className="lab-tab__x"
                  aria-label={`${p} 닫기`}
                  onClick={() => closeTab(p)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <div className="lab-editor__tools">
          <code className="lab-crumb">
            {scenario.dir}/{active ?? ''}
          </code>
          <span className="lab-editor__right">
            <label className="lab-toggle">
              <input
                type="checkbox"
                checked={compare}
                disabled={!activeStrategy}
                onChange={(e) => setCompare(e.target.checked)}
              />
              나란히 비교 <kbd className="lab-kbd">D</kbd>
            </label>
            {compare && activeStrategy && (
              <label className="lab-select">
                <span className="sr-only">비교 대상</span>
                <span aria-hidden="true">↔</span>
                <select value={compareWith} onChange={(e) => setCompareWith(e.target.value)}>
                  {scenario.strategies
                    .filter((s) => s.id !== activeStrategy && s.file)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.id}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <label className="lab-toggle">
              <input
                type="checkbox"
                checked={lineNumbers}
                onChange={(e) => setLineNumbers(e.target.checked)}
              />
              줄 번호
            </label>
            <label className="lab-toggle">
              <input
                type="checkbox"
                checked={minimap}
                onChange={(e) => setMinimap(e.target.checked)}
              />
              미니맵
            </label>
          </span>
        </div>
        {cmpFile && activeStrategy && (
          <div className="lab-diffhead small">
            <span>
              ◀ <code>{activeStrategy}</code> {label(activeStrategy)}
            </span>
            <span>
              <code>{compareWith}</code> {label(compareWith)} ▶
            </span>
          </div>
        )}
        <div className="lab-editor__body">
          {activeFile ? (
            <Suspense
              fallback={<div className="lab-editor__loading small dim">에디터 불러오는 중…</div>}
            >
              <CodeEditor
                main={{
                  modelPath: `${scenario.dir}/${activeFile.path}`,
                  source: activeFile.source,
                  language: languageOf(activeFile.path),
                  highlights: mainHl,
                }}
                compare={
                  cmpFile
                    ? {
                        modelPath: `${scenario.dir}/${cmpFile.path}`,
                        source: cmpFile.source,
                        language: languageOf(cmpFile.path),
                        highlights: cmpHl,
                      }
                    : null
                }
                lineNumbers={lineNumbers}
                minimap={minimap}
                reveal={reveal}
              />
            </Suspense>
          ) : (
            <p className="lab-editor__empty dim">왼쪽 탐색기나 판정 표에서 파일을 연다.</p>
          )}
        </div>
      </section>

      <div className="lab-area-panel">
        <VerdictPanel
          scenario={scenario}
          situation={situation}
          strategy={strategy}
          onStrategy={pickStrategy}
          focus={panelFocus}
          onReveal={(line) => {
            const p = strategyPath(strategy);
            setCompare(false);
            openFile(p);
            setReveal({ line, nonce: Date.now() });
          }}
        />
      </div>

      {matrix && (
        <div className="lab-area-matrix">
          <Matrix
            scenario={scenario}
            situation={situation}
            strategy={strategy}
            onPick={(st, si) => {
              setSituation(si);
              pickStrategy(st);
            }}
          />
        </div>
      )}

      <footer className="lab-area-status lab-status small">
        <span>
          {scenario.learnOrigin === 'packs' ? 'packs' : 'fixture'} · {scenario.strategies.length}{' '}
          처리 방식 · {scenario.doc.situations.length} 상황
        </span>
        {scenario.warnings.length > 0 && (
          <details className="lab-warn">
            <summary>⚠ 경고 {scenario.warnings.length}</summary>
            <ul>
              {scenario.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}
        <span className="lab-status__right">
          판정은 “예상”(learn.yaml expected)과 “실측 run#”(measured)을 구분해 표시 ·{' '}
          <kbd className="lab-kbd">?</kbd> 단축키
        </span>
      </footer>

      {help && <HelpDialog onClose={() => setHelp(false)} />}
    </main>
  );
}
