import { createStore } from 'zustand/vanilla';
import type { PhaseGroup } from '../events/phases';
import type { Recording } from '../events/types';
import { advance, buildCompressionMap, type CompressionMap } from './compression';
import { DEFAULT_SPEED, type Speed } from './constants';
import { autoTest, prepare, withCause, type Prepared } from './prepare';
import { buildRows, stepNext, stepPrev, stopForRow, type Row, type RowView } from './rows';
import { firstStopBetween, type AutoStop } from './stops';

/**
 * 재생 상태 저장소(React 무관, zustand/vanilla). 화면 전체는 P 하나의 함수다.
 * 파생값(map, rows)은 입력(speed·ff·view·off)이 바뀔 때만 다시 만든다.
 */
export interface PlaybackState {
  prepared: Prepared;
  P: number;
  playing: boolean;
  speed: Speed;
  ff: boolean;
  auto: boolean;
  /** 원인 장면(같은 버전 수신 등)에서도 자동 멈춤. 기본 켬. */
  autoCause: boolean;
  /** 자동 멈춤(또는 단계 이동으로 핵심 이벤트에 도착)한 지점의 설명 대상. */
  callout: AutoStop | null;
  view: RowView;
  off: ReadonlySet<PhaseGroup>;
  map: CompressionMap;
  rows: Row[];
}

export interface PlaybackActions {
  load(recording: Recording): void;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(P: number, callout?: AutoStop | null): void;
  next(): void;
  prev(): void;
  setSpeed(speed: Speed): void;
  toggleFF(): void;
  toggleAuto(): void;
  /** 원인 멈춤 켬/끔. 끄면 원인 설명 중이던 callout도 닫는다. */
  toggleCause(): void;
  setView(view: RowView): void;
  toggleGroup(group: PhaseGroup): void;
  /** 벽시계 wallMs만큼 진행. 자동 멈춤 지점을 넘지 않는다. */
  tick(wallMs: number): void;
}

export type PlaybackStore = PlaybackState & PlaybackActions;

function derive(s: Pick<PlaybackState, 'prepared' | 'speed' | 'ff' | 'view' | 'off'>) {
  return {
    map: buildCompressionMap(s.prepared.gaps, s.prepared.total, s.speed, s.ff),
    rows: buildRows(
      s.prepared.events,
      { view: s.view, off: s.off },
      { info: s.prepared.info, isAuto: autoTest(s.prepared), delay: s.prepared.delay },
    ),
  };
}

export function createPlaybackStore(recording: Recording) {
  return createStore<PlaybackStore>()((set, get) => {
    const base = {
      prepared: prepare(recording),
      speed: DEFAULT_SPEED as Speed,
      ff: true,
      view: 'key' as RowView,
      off: new Set<PhaseGroup>() as ReadonlySet<PhaseGroup>,
    };
    const clamp = (P: number) => Math.min(get().prepared.total, Math.max(0, P));
    return {
      ...base,
      ...derive(base),
      P: 0,
      playing: false,
      auto: true,
      autoCause: true,
      callout: null,

      load(rec) {
        const prepared = prepare(rec, { cause: get().autoCause });
        set({ prepared, P: 0, playing: false, callout: null, ...derive({ ...get(), prepared }) });
      },
      play() {
        const { P, prepared } = get();
        set({ playing: true, callout: null, P: P >= prepared.total ? 0 : P });
      },
      pause() {
        set({ playing: false });
      },
      toggle() {
        if (get().playing) get().pause();
        else get().play();
      },
      seek(P, callout = null) {
        set({ P: clamp(P), playing: false, callout });
      },
      next() {
        const { rows, P, prepared } = get();
        const r = stepNext(rows, P, prepared.total);
        get().seek(r.P, stopForRow(prepared.stops, r.row));
      },
      prev() {
        const { rows, P, prepared } = get();
        const r = stepPrev(rows, P);
        get().seek(r.P, stopForRow(prepared.stops, r.row));
      },
      setSpeed(speed) {
        set({ speed, ...derive({ ...get(), speed }) });
      },
      toggleFF() {
        const ff = !get().ff;
        set({ ff, ...derive({ ...get(), ff }) });
      },
      toggleAuto() {
        const auto = !get().auto;
        set(auto ? { auto } : { auto, callout: null });
      },
      toggleCause() {
        const autoCause = !get().autoCause;
        const prepared = withCause(get().prepared, autoCause);
        const c = get().callout;
        const keep = c && (autoCause || !c.events.some((e) => e.cause));
        set({ autoCause, prepared, callout: keep ? c : null, ...derive({ ...get(), prepared }) });
      },
      setView(view) {
        set({ view, ...derive({ ...get(), view }) });
      },
      toggleGroup(group) {
        const off = new Set(get().off);
        if (off.has(group)) off.delete(group);
        else off.add(group);
        set({ off, ...derive({ ...get(), off }) });
      },
      tick(wallMs) {
        const s = get();
        if (!s.playing) return;
        let np = advance(s.map, s.P, wallMs);
        if (s.auto) {
          const stop = firstStopBetween(s.prepared.stops, s.P, np);
          if (stop) {
            set({ P: stop.at, playing: false, callout: stop });
            return;
          }
        }
        if (np >= s.prepared.total) {
          np = s.prepared.total;
          set({ P: np, playing: false });
          return;
        }
        set({ P: np });
      },
    };
  });
}
