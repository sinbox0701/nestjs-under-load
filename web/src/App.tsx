import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import {
  CodePanel,
  PlaybackBar,
  ResultCard,
  ServerInside,
  Stage,
  Timeline,
  TopBar,
} from './components';
import { g01NaiveOverwrite } from './events/fixtures/g01-naive-overwrite';
import { phaseInfo } from './events/phases';
import type { RunEvent } from './events/types';
import {
  SPEEDS,
  STAGE_PER_REAL,
  createPlaybackStore,
  foldedGapAt,
  foldedGaps,
  rowTarget,
  sceneAt,
  snapshotAt,
  stopForRow,
  type AutoStop,
} from './playback';
import { applyTheme, readTheme, type ThemeChoice } from './theme/theme';

const store = createPlaybackStore(g01NaiveOverwrite);
const LABELS = ['A', 'B', 'C', 'D'];

function explain(stop: AutoStop, label: (actor: string) => string): string {
  const e = stop.events[0]!;
  if (e.phase === 'custom:lost_update') {
    const by = typeof e.attrs?.by === 'string' ? label(e.attrs.by) : '?';
    return `${by}가 ${label(e.actor)}의 수정을 덮어씀 — 잃어버린 수정 +1. ${label(e.actor)}도 200 OK를 받아서 아무도 모른다.`;
  }
  return e.note ?? phaseInfo(e.phase).label;
}

function isTyping(el: EventTarget | null): boolean {
  return (
    el instanceof HTMLElement && el.matches('input, select, textarea, [contenteditable="true"]')
  );
}

export function App() {
  const s = useStore(store);
  const { prepared, P } = s;
  const { meta, code } = prepared.recording;
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const label = (actor: string) => LABELS[meta.actors.indexOf(actor)] ?? actor;

  useEffect(() => applyTheme(theme), [theme]);

  // 재생 루프: 재생 중일 때만 rAF로 벽시계 경과를 넘긴다.
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

  // 키보드(DESIGN_SYSTEM §4.8)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const onButton = e.target instanceof HTMLButtonElement;
      const st = store.getState();
      if (e.key === ' ' && !onButton) st.toggle();
      else if (e.key === 'ArrowRight' && !onButton) st.next();
      else if (e.key === 'ArrowLeft' && !onButton) st.prev();
      else if (e.key === 'Home') st.seek(0);
      else if (/^[1-4]$/.test(e.key)) st.setSpeed(SPEEDS[Number(e.key) - 1]!);
      else if (e.key === 'a' || e.key === 'A') st.toggleAuto();
      else if (e.key === 'f' || e.key === 'F') st.toggleFF();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const snap = useMemo(() => snapshotAt(prepared, P), [prepared, P]);
  const scene = useMemo(() => sceneAt(prepared, P), [prepared, P]);
  const folded = useMemo(() => foldedGaps(s.map), [s.map]);
  const marks = useMemo(
    () => prepared.events.filter((e) => phaseInfo(e.phase).key && phaseInfo(e.phase).tone !== 'ok'),
    [prepared],
  );
  const codeEvent: RunEvent | null = s.callout
    ? s.callout.events[s.callout.events.length - 1]!
    : snap.last;
  const [tab, setTab] = useState<'code' | 'server'>('code');
  const bad = snap.counters.violations > 0;
  const slow = Math.round(STAGE_PER_REAL / s.speed);

  return (
    <div className="app">
      <div className="area-top">
        <TopBar current="실행" theme={theme} onThemeChange={setTheme} />
      </div>

      <div className="area-result">
        <ResultCard counters={snap.counters} metrics={null} />
      </div>

      <div className="area-stage">
        <Stage
          scene={scene}
          labels={LABELS}
          ariaLabel={`${meta.scenarioTitle} · ${meta.strategy.label} · ${meta.actors.length}명. 위반 ${snap.counters.violations}`}
          hud={
            <>
              <span className="badge t-neutral">{meta.scenario.slice(0, 3).toUpperCase()}</span>
              <span>
                {meta.strategy.label} · {meta.route} · {meta.actors.length}명
              </span>
              <span className="badge t-neutral">{meta.isolation}</span>
              <span className={bad ? 'badge t-bad push' : 'badge t-ok push'} role="status">
                {bad ? `✕ 위반 ${snap.counters.violations}` : '✓ 정합성 OK'}
              </span>
            </>
          }
          footer={
            <>
              <span>
                대표 {meta.actors.length}명 표시 / 전체 {meta.totalActors}명
              </span>
              <span>
                {s.playing ? '▶' : '■'} 실제 {prepared.total.toFixed(1)}ms 기록을 {s.speed}×로{' '}
                {s.playing ? '재생 중' : '멈춤'} (실제보다 {slow}배 느림)
              </span>
            </>
          }
          overlay={
            s.callout ? (
              <div className="callout small">
                <span className={`badge t-${phaseInfo(s.callout.phase).tone}`}>■ 자동 멈춤</span>
                <b>{explain(s.callout, label)}</b>
                <span className="dim">Space 계속 · → 다음 단계</span>
              </div>
            ) : null
          }
        />
        <PlaybackBar
          P={P}
          total={prepared.total}
          playing={s.playing}
          speed={s.speed}
          ff={s.ff}
          auto={s.auto}
          folded={s.ff ? folded : []}
          marks={marks}
          inFoldedGap={foldedGapAt(s.map, P)}
          onPlayToggle={s.toggle}
          onFirst={() => s.seek(0)}
          onPrev={s.prev}
          onNext={s.next}
          onSeek={(p) => s.seek(p)}
          onSpeed={s.setSpeed}
          onToggleFF={s.toggleFF}
          onToggleAuto={s.toggleAuto}
        />
      </div>

      <section className="panel area-side" aria-label="코드와 서버 속">
        <div className="tabs" role="tablist">
          {(['code', 'server'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'btn is-sel' : 'btn'}
              onClick={() => setTab(t)}
            >
              {t === 'code' ? '코드' : '서버 속'}
            </button>
          ))}
        </div>
        {tab === 'code' && code ? (
          <CodePanel code={code} event={codeEvent} actors={meta.actors} labels={LABELS} />
        ) : (
          <ServerInside
            sampleCount={meta.actors.length}
            noLockReason="락 없음: 읽고-고치고-쓰기 사이에 아무것도 막지 않는다"
            lastSql={snap.lastSql}
            actorLabel={label}
          />
        )}
      </section>

      <div className="area-timeline">
        <Timeline
          rows={s.rows}
          events={prepared.events}
          actors={meta.actors}
          labels={LABELS}
          P={P}
          total={prepared.total}
          view={s.view}
          off={s.off}
          onView={s.setView}
          onToggleGroup={s.toggleGroup}
          onPickRow={(row) => s.seek(rowTarget(row), stopForRow(prepared.stops, row))}
        />
      </div>

      <footer className="area-foot foot small dim">
        이 결과는 로컬 단일 머신(Docker Desktop VM, CPU·메모리 limit 고정)에서 처리 방식 간 상대
        비교를 위해 측정한 값입니다. 운영 환경의 처리 용량을 뜻하지 않습니다. · 지금 화면은 가짜
        기록(fixture) 재생입니다.
      </footer>
    </div>
  );
}
