import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  CodePanel,
  KeysOverlay,
  PlaybackBar,
  ResultCard,
  RunControls,
  resultFooter,
  ServerInside,
  Stage,
  Timeline,
  TopBar,
} from './components';
import {
  SCENARIO_UI,
  defaultConfig,
  nextStrategy,
  scenarioIdOf,
  type RunConfig,
} from './components/lib/config';
import { lastPerActor, phaseIcon, roundIndexOf, tickTone } from './components/lib/model';
import type { CodeSource, Recording, RunEvent } from './events/types';
import {
  SPEEDS,
  createPlaybackStore,
  foldedGapAt,
  foldedGaps,
  roundAt,
  rowTarget,
  serverAt,
  snapshotAt,
  stopForRow,
  upperBound,
} from './playback';
import { buildRecording, codeFor, type ScenarioRequest } from './scenarios';

const ROUNDS = 4;
const RUN_STEP_MS = 260;

function request(cfg: RunConfig, seed: number): ScenarioRequest {
  return {
    scenario: cfg.scenario,
    strategy: cfg.strategy,
    ...cfg.options,
    seed,
  } as ScenarioRequest;
}

// 재생 엔진(store)은 기록 하나를 늘 들고 있다. 첫 실행 전에는 화면이 기록 없음(무대 CTA)으로 보인다.
const store = createPlaybackStore(buildRecording(request(defaultConfig(), 1)));

function isTyping(el: EventTarget | null): boolean {
  return (
    el instanceof HTMLElement && el.matches('input, select, textarea, [contenteditable="true"]')
  );
}

/** `onToggleTheme`: T 단축키가 부르는 라이트/다크 전환. 테마 상태는 셸이 갖는다. */
export function App({ onToggleTheme }: { onToggleTheme?: () => void } = {}) {
  const s = useStore(store);
  const { prepared, P } = s;
  const [cfg, setCfg] = useState<RunConfig>(() => defaultConfig());
  // 실행 타이머가 기록을 만들 때 읽는 최신 설정(실행 중 설정은 잠기지만 이중 방어).
  const cfgRef = useRef(cfg);
  useEffect(() => {
    cfgRef.current = cfg;
  }, [cfg]);
  const [pred, setPred] = useState<number | null>(null);
  const [hasRec, setHasRec] = useState(false);
  const [runStep, setRunStep] = useState<number | null>(null);
  const [runMsg, setRunMsg] = useState('');
  const runNo = useRef(0);
  const runTimer = useRef<number | undefined>(undefined);
  const [tab, setTab] = useState<'code' | 'server'>('code');
  const [compare, setCompare] = useState(false);
  const [compareWith, setCompareWith] = useState('optimistic-version');
  const [keysOpen, setKeysOpen] = useState(false);
  const [pressed, setPressed] = useState<'play' | 'prev' | 'next' | null>(null);
  const transportRef = useRef<HTMLElement>(null);

  const rec: Recording = prepared.recording;
  const meta = rec.meta;
  const scenario = hasRec ? scenarioIdOf(meta.scenario) : cfg.scenario;
  const strategyId = hasRec ? meta.strategy.id : cfg.strategy;
  const events = prepared.events;
  const total = prepared.total;
  const rd = roundAt(prepared, P);
  const running = runStep !== null;
  const atEnd = hasRec && P >= total;
  const idx = hasRec ? upperBound(events, P) - 1 : -1;
  const posCounters = idx >= 0 ? snapshotAt(prepared, P).counters : null;
  const violations = posCounters ? posCounters.violations : null;
  const counts = posCounters
    ? {
        conflicts: posCounters.conflicts,
        rejects: posCounters.rejects ?? 0,
        retries: posCounters.retries,
        soldOut: posCounters.soldOut ?? 0,
      }
    : null;

  // ---------------------------------------------------------------- 재생 조작(재생 엔진 store)
  const play = useCallback(() => {
    if (hasRec && !running) store.getState().play();
  }, [hasRec, running]);
  const togglePlay = useCallback(() => {
    if (hasRec && !running) store.getState().toggle();
  }, [hasRec, running]);
  const stepNext = useCallback(() => {
    if (hasRec && !running) store.getState().next();
  }, [hasRec, running]);
  const stepPrev = useCallback(() => {
    if (hasRec && !running) store.getState().prev();
  }, [hasRec, running]);
  const seek = useCallback(
    (p: number) => {
      if (hasRec && !running) store.getState().seek(p);
    },
    [hasRec, running],
  );

  // 재생 루프: 재생 중일 때만 rAF로 벽시계 경과를 넘긴다(자동 멈춤은 store.tick이 지킨다).
  useEffect(() => {
    if (!s.playing) return;
    let last = performance.now();
    let id = requestAnimationFrame(function frame(now) {
      store.getState().tick(Math.min(64, now - last));
      last = now;
      id = requestAnimationFrame(frame);
    });
    return () => cancelAnimationFrame(id);
  }, [s.playing]);

  // ---------------------------------------------------------------- 실행 = 기록 만들기(진입점 하나)
  const build = useCallback((c: RunConfig) => {
    runNo.current += 1;
    store.getState().load(buildRecording(request(c, runNo.current)));
    setHasRec(true);
  }, []);
  const run = useCallback(() => {
    if (runStep !== null) return;
    store.getState().pause();
    setRunMsg('');
    setRunStep(0);
    let step = 0;
    const tick = () => {
      step += 1;
      setRunStep(step);
      if (step >= ROUNDS) {
        setRunStep(null);
        build(cfgRef.current);
        store.getState().play();
        return;
      }
      runTimer.current = window.setTimeout(tick, RUN_STEP_MS);
    };
    runTimer.current = window.setTimeout(tick, RUN_STEP_MS);
  }, [runStep, build]);
  const abortRun = useCallback(() => {
    if (runStep === null) return;
    window.clearTimeout(runTimer.current);
    setRunStep(null);
    setRunMsg('실행 중단됨 — 기록을 만들지 않았다');
  }, [runStep]);
  useEffect(() => () => window.clearTimeout(runTimer.current), []);

  const changeCfg = useCallback(
    (next: RunConfig) => {
      // 실행(기록 만드는 중)에는 설정을 바꾸지 않는다 — 만들어질 기록과 화면 설정이 어긋나지 않게.
      if (runStep !== null) return;
      setCfg(next);
      // 기록이 있으면 같은 설정으로 다시 만든다(재생은 멈춘 채).
      if (hasRec) build(next);
    },
    [hasRec, runStep, build],
  );
  const toggleCompare = useCallback(() => {
    setCompare((c) => !c);
    setTab('code');
  }, []);

  // ---------------------------------------------------------------- 키보드(design/mockup.html과 같은 배치)
  const flash = (k: 'play' | 'prev' | 'next') => {
    setPressed(k);
    window.setTimeout(() => setPressed(null), 120);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (keysOpen) {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        setKeysOpen(false);
      }
      return;
    }
    if (isTyping(e.target)) return;
    const t = e.target as HTMLElement | null;
    if (
      (e.key === 'Enter' || e.key === ' ') &&
      t?.closest?.('button, summary, a, .term, .stg-term')
    )
      return;
    const st = store.getState();
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (hasRec && !running) {
          flash('play');
          togglePlay();
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        flash('next');
        stepNext();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        flash('prev');
        stepPrev();
        break;
      case 'Home':
        e.preventDefault();
        seek(0);
        break;
      case 'Enter':
        e.preventDefault();
        run();
        break;
      case 'Escape':
        abortRun();
        break;
      case '1':
      case '2':
      case '3':
      case '4':
        st.setSpeed(SPEEDS[Number(e.key) - 1]!);
        break;
      case 'a':
      case 'A':
        st.toggleAuto();
        break;
      case 'f':
      case 'F':
        st.toggleFF();
        break;
      case 'c':
      case 'C':
        toggleCompare();
        break;
      case 's':
      case 'S':
        if (running) break;
        changeCfg({ ...cfg, strategy: nextStrategy(cfg.scenario, cfg.strategy) });
        break;
      case 't':
      case 'T':
        onToggleTheme?.();
        break;
      case '?':
        e.preventDefault();
        setKeysOpen(true);
        break;
    }
  };
  const keyRef = useRef(onKey);
  useEffect(() => {
    keyRef.current = onKey;
  });
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // ---------------------------------------------------------------- 화면 파생값
  const folded = useMemo(() => (s.ff ? foldedGaps(s.map) : []), [s.ff, s.map]);
  const ticks = useMemo(
    () =>
      events.flatMap((e) => {
        const tone = tickTone(e);
        return tone ? [{ t: e.t, tone }] : [];
      }),
    [events],
  );
  const cursors = useMemo(
    () =>
      hasRec ? [...lastPerActor(events, rd, P)].map(([actor, event]) => ({ actor, event })) : [],
    [hasRec, events, rd, P],
  );
  const codeEvent: RunEvent | null = !hasRec
    ? null
    : s.callout
      ? s.callout.events[s.callout.events.length - 1]!
      : idx >= 0 && roundIndexOf(prepared.rounds, events[idx]!) === rd.index
        ? events[idx]!
        : null;
  const code: CodeSource = useMemo(
    () => (hasRec && rec.code ? rec.code : codeFor(scenario, strategyId)),
    [hasRec, rec, scenario, strategyId],
  );
  const codeOf = useCallback(
    (id: string): CodeSource | null => {
      try {
        return codeFor(scenario, id);
      } catch {
        return null;
      }
    },
    [scenario],
  );
  const phase = useCallback(
    (e: RunEvent) => {
      const i = prepared.info(e.phase);
      return { label: i.label, tone: i.tone, icon: phaseIcon(e.phase, i) };
    },
    [prepared],
  );
  const snap = hasRec ? serverAt(prepared, P) : null;
  const lastSql = useMemo(() => {
    if (!hasRec) return null;
    for (let i = idx; i >= 0; i--) {
      const e = events[i]!;
      if (e.t < rd.start) break;
      if (e.sql) return { actor: e.actor, sql: e.sql };
    }
    return null;
  }, [hasRec, idx, events, rd.start]);

  const verdict = rec.verdict;
  const sum = rec.summary;
  const g01 = scenario === 'g01-shared-document';
  // 끝 줄: 기록 전체(시뮬레이션 기록에서 센 값). G01은 라운드, G02는 대표 요청 단위.
  const endCounts = snapshotAt(prepared, total).counters;
  const endSummary = hasRec
    ? (g01
        ? `${prepared.rounds.length}라운드 중 위반 ${verdict?.violations ?? endCounts.violations}건`
        : `대표 요청 ${meta.actors.length}개 중 위반 ${verdict?.violations ?? endCounts.violations}건`) +
      (g01
        ? ` · 409 ${sum?.conflicts ?? endCounts.conflicts} · 423 ${sum?.rejected423 ?? endCounts.rejects ?? 0}`
        : ` · 품절 ${sum?.soldOut ?? endCounts.soldOut ?? 0}`)
    : null;
  const endLine = hasRec && verdict ? `${endSummary} — ${verdict.detail}` : endSummary;
  const resultState = running
    ? '실행 중'
    : !hasRec
      ? '대기 중'
      : idx < 0
        ? '처음 위치'
        : s.playing
          ? `재생 중 · ${strategyId}`
          : atEnd
            ? g01
              ? `기록 끝 · ${prepared.rounds.length}라운드`
              : '기록 끝'
            : s.callout
              ? '자동 멈춤'
              : '일시정지';
  const notice = hasRec ? (rec.notice ?? null) : null;
  const n = hasRec ? meta.actors.length : Number(cfg.options.people ?? 4);

  return (
    <div className="nul">
      <TopBar
        onKeys={() => setKeysOpen(true)}
        fakeNote={
          notice
            ? `${notice.label} · 서버 연결 없음`
            : hasRec
              ? '서버 연결 없음'
              : '기록 없음 · 서버 연결 없음'
        }
      />
      <main className="grid">
        <RunControls
          cfg={cfg}
          onCfg={changeCfg}
          pred={pred}
          onPred={setPred}
          running={running}
          onRun={run}
          onStop={abortRun}
        />
        <div className="col col--l">
          <div className="a-stage">
            <Stage
              prepared={hasRec ? prepared : null}
              P={P}
              callout={hasRec ? s.callout : null}
              playing={s.playing}
              speed={s.speed}
              foldedGap={s.playing ? foldedGapAt(s.map, P) : null}
              onContinue={play}
              onRun={run}
              running={
                running ? `실행 중 · 기록 만드는 중 R${runStep}/${ROUNDS} (Esc 실행 중단)` : null
              }
              question={runMsg || SCENARIO_UI[cfg.scenario].question}
              transportRef={transportRef}
            />
          </div>
          <PlaybackBar
            sectionRef={transportRef}
            hasRec={hasRec}
            runStep={runStep}
            rounds={prepared.rounds}
            P={P}
            total={total}
            playing={s.playing}
            paused={!!s.callout}
            speed={s.speed}
            ff={s.ff}
            auto={s.auto}
            autoCause={s.autoCause}
            folded={folded}
            ticks={hasRec ? ticks : []}
            endSummary={endSummary}
            onPlayToggle={togglePlay}
            onFirst={() => seek(0)}
            onPrev={stepPrev}
            onNext={stepNext}
            onSeek={seek}
            onSpeed={s.setSpeed}
            onToggleFF={s.toggleFF}
            onToggleAuto={s.toggleAuto}
            onToggleCause={s.toggleCause}
            pressed={pressed}
          />
          <Timeline
            hasRec={hasRec}
            prepared={prepared}
            scenario={scenario}
            strategyId={strategyId}
            people={n}
            P={P}
            rows={s.rows}
            view={s.view}
            off={s.off}
            callout={s.callout}
            onView={s.setView}
            onToggleGroup={s.toggleGroup}
            onPickRow={(row) => s.seek(rowTarget(row), stopForRow(prepared.stops, row))}
          />
        </div>
        <div className="col col--r">
          <ResultCard
            scenario={scenario}
            hasRec={hasRec}
            running={running}
            violations={violations}
            counts={counts}
            atEnd={atEnd}
            state={resultState}
            pred={pred}
            summary={sum ?? null}
            endLine={endLine}
            notice={notice}
          />
          <section className="panel a-side" aria-label="코드와 서버 속">
            <div className="panel__h tabs-h">
              <div
                className="tabs"
                role="tablist"
                aria-label="보기"
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                  e.preventDefault();
                  e.stopPropagation();
                  const next = tab === 'code' ? 'server' : 'code';
                  setTab(next);
                  document.getElementById(next === 'code' ? 'tabCode' : 'tabSrv')?.focus();
                }}
              >
                {(
                  [
                    ['code', 'tabCode', 'pnCode', '코드'],
                    ['server', 'tabSrv', 'pnSrv', '서버 속'],
                  ] as const
                ).map(([id, tabId, panelId, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    id={tabId}
                    aria-controls={panelId}
                    aria-selected={tab === id}
                    tabIndex={tab === id ? 0 : -1}
                    onClick={() => setTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="meta">샘플: 대표 {n}명분</span>
            </div>
            <div
              className="panel__b"
              role="tabpanel"
              id="pnCode"
              aria-labelledby="tabCode"
              hidden={tab !== 'code'}
            >
              <CodePanel
                hasRec={hasRec}
                scenario={scenario}
                strategyId={strategyId}
                meta={meta}
                code={code}
                codeOf={codeOf}
                extra={rec.extraCode?.[0] ?? null}
                event={codeEvent}
                roundStart={rd.start}
                cursors={cursors}
                phase={phase}
                compare={compare}
                announce={hasRec && !s.playing && !!s.callout}
                compareWith={compareWith}
                onToggleCompare={toggleCompare}
                onCompareWith={setCompareWith}
              />
            </div>
            <div
              className="panel__b"
              role="tabpanel"
              id="pnSrv"
              aria-labelledby="tabSrv"
              hidden={tab !== 'server'}
            >
              <ServerInside
                hasRec={hasRec}
                scenario={scenario}
                strategyId={strategyId}
                meta={meta}
                snap={snap}
                lastSql={lastSql}
              />
            </div>
          </section>
        </div>
      </main>
      <footer className="nul-foot">
        <p data-testid="foot">{resultFooter(hasRec, notice, sum ?? null)}</p>
      </footer>
      {keysOpen && <KeysOverlay onClose={() => setKeysOpen(false)} />}
    </div>
  );
}
