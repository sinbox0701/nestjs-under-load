/**
 * 무대 단독 미리보기(개발용, 빌드 입력 아님): `pnpm dev` 후 /src/stage/preview/index.html.
 * 실제 화면 배치는 App(B)이 한다. 여기서는 무대 + 최소 재생 컨트롤만 붙여 장면을 확인한다.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Stage } from '../../components/Stage';
import type { Recording } from '../../events/types';
import { SPEEDS } from '../../playback/constants';
import { foldedGapAt } from '../../playback/compression';
import { createPlaybackStore } from '../../playback/store';
import { buildG01Recording, type G01StrategyCode } from '../../scenarios/g01';
import '../../theme/theme';
import { g02Demo, type G02DemoStrategy } from './demo';

type Pick =
  | { g: 'g01'; strategy: G01StrategyCode; people: 2 | 3 | 4 }
  | { g: 'g02'; strategy: G02DemoStrategy; instances: 1 | 2 };

const PICKS: { id: string; label: string; pick: Pick }[] = [
  ...(['naive-overwrite', 'blind-retry', 'optimistic-version', 'edit-lease'] as const).flatMap(
    (strategy) =>
      ([2, 4] as const).map((people) => ({
        id: `g01-${strategy}-${people}`,
        label: `G01 ${strategy} · ${people}명`,
        pick: { g: 'g01' as const, strategy, people },
      })),
  ),
  ...(['no-lock', 'row-lock', 'conditional-update'] as const).map((strategy) => ({
    id: `g02-${strategy}`,
    label: `G02 ${strategy} (데모)`,
    pick: { g: 'g02' as const, strategy, instances: 1 as const },
  })),
  ...([1, 2] as const).map((instances) => ({
    id: `g02-memory-${instances}`,
    label: `G02 app-memory-lock · 서버 ${instances}대 (데모)`,
    pick: { g: 'g02' as const, strategy: 'app-memory-lock' as const, instances },
  })),
];

function build(p: Pick): Recording {
  return p.g === 'g01'
    ? buildG01Recording({ strategy: p.strategy, people: p.people })
    : g02Demo(p.strategy, p.instances);
}

const store = createPlaybackStore(build(PICKS[0]!.pick));

export function Preview() {
  const s = useStore(store);
  const [id, setId] = useState(PICKS[0]!.id);
  const transportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!s.playing) return;
    let last = performance.now();
    let raf = requestAnimationFrame(function frame(now) {
      store.getState().tick(Math.min(64, now - last));
      last = now;
      raf = requestAnimationFrame(frame);
    });
    return () => cancelAnimationFrame(raf);
  }, [s.playing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
      const st = store.getState();
      if (e.key === ' ') st.toggle();
      else if (e.key === 'ArrowRight') st.next();
      else if (e.key === 'ArrowLeft') st.prev();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const gap = useMemo(() => (s.ff ? foldedGapAt(s.map, s.P) : null), [s.ff, s.map, s.P]);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 16, display: 'grid', gap: 12 }}>
      <Stage
        prepared={s.prepared}
        P={s.P}
        callout={s.callout}
        playing={s.playing}
        speed={s.speed}
        foldedGap={gap}
        onContinue={s.play}
        transportRef={transportRef}
      />
      <div
        ref={transportRef}
        className="panel"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
      >
        <button type="button" className="btn" onClick={() => s.seek(0)}>
          처음
        </button>
        <button type="button" className="btn" onClick={s.prev}>
          ← 단계
        </button>
        <button type="button" className="btn is-sel" onClick={s.toggle}>
          {s.playing ? '일시정지' : s.callout ? '▶ 계속' : '재생'}
        </button>
        <button type="button" className="btn" onClick={s.next}>
          단계 →
        </button>
        <select
          aria-label="속도"
          value={s.speed}
          onChange={(e) => s.setSpeed(Number(e.target.value) as (typeof SPEEDS)[number])}
        >
          {SPEEDS.map((v) => (
            <option key={v} value={v}>
              1/{Math.round(40 / v)}
            </option>
          ))}
        </select>
        <button type="button" className="btn" aria-pressed={s.auto} onClick={s.toggleAuto}>
          자동 멈춤
        </button>
        <input
          type="range"
          aria-label="재생 위치"
          min={0}
          max={s.prepared.total}
          step={0.1}
          value={s.P}
          onChange={(e) => s.seek(Number(e.target.value))}
          style={{ flex: '1 1 200px' }}
        />
        <select
          aria-label="기록"
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            const p = PICKS.find((x) => x.id === e.target.value)!;
            store.getState().load(build(p.pick));
          }}
        >
          {PICKS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
