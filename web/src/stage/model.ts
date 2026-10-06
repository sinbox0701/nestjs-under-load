import type { Tone } from '../events/phases';
import type { IconName } from './sprites';
import { STAGE_PER_REAL } from '../playback/constants';

/** 무대 논리 해상도(DESIGN_SYSTEM §3.2). */
export const STAGE_W = 256;
export const STAGE_H = 192;

/** 걷는 속도: 90 논리px/무대초 = 0.09 px/무대ms → 실제 ms당. */
export const PX_PER_REAL_MS = 0.09 * STAGE_PER_REAL;

export type Emote = 'check' | 'bang' | 'retry' | 'wait' | 'write' | 'cross' | 'stop';

/** 그릴 actor 하나(장면 상태의 결과값). 좌표는 논리 px 정수. */
export interface ActorView {
  index: number;
  id: string;
  look: 'staff' | 'customer';
  visible: boolean;
  /** 발 위치(가운데 아래). */
  x: number;
  y: number;
  walking: boolean;
  /** 다리 프레임(걸을 때 140 무대ms마다 바뀜). */
  step: 0 | 1;
  /** 왼쪽을 보면 true(가로 뒤집기). */
  flip: boolean;
  /** 튕김(409·423) 남은 정도 1→0. */
  knock: number;
  /** 튕기는 방향. */
  knockDir: -1 | 1;
  /** 쓰기 들썩임 남은 정도 1→0. */
  lunge: number;
  /** 사본·주문서를 들었나. */
  carry: boolean;
  /** 발밑 표지 글자(받은 버전 `v7`, 읽은 재고 `읽음 3`). */
  footTag: string | null;
  emote: Emote | null;
  /** 멈춘 보유자(회색 실루엣). */
  ghost: boolean;
}

export type LabelTone = 'bad' | 'wait' | 'ok' | 'info' | 'neutral';

export interface BubbleView {
  key: string;
  actor: number;
  text: string;
  tone: LabelTone;
  opacity: number;
}

export interface PopView {
  key: string;
  text: string;
  icon: IconName;
  tone: LabelTone;
  /** 논리 좌표(가운데 아래 기준). */
  x: number;
  y: number;
  /** 떠오르기 전 처음 y(prefers-reduced-motion이면 이 자리에 고정). */
  y0: number;
  opacity: number;
}

/** 날아가며 사라지는 종이(잃어버린 수정). 반투명은 이것만 쓴다(§5). */
export interface PaperView {
  key: string;
  actor: number;
  x: number;
  y: number;
  tilt: number;
  alpha: number;
}

interface SceneBase {
  /** 라운드 시작부터 경과(실제 ms). */
  lt: number;
  roundIndex: number;
  roundCount: number;
  roundStart: number;
  roundEnd: number;
  actors: ActorView[];
  bubbles: BubbleView[];
  pops: PopView[];
  /** 그리지 않는 나머지 인원(카운터). */
  others: number;
}

export interface DocView {
  version: number | null;
  /** 편집 잠금 보유자(G01 edit-lease). */
  lock: number | null;
  expired: boolean;
  writing: boolean;
  /** 커밋 직후 서류 들썩임. */
  lift: boolean;
  /** 서류 위 펜 위치(0..2). */
  pen: number;
}

export interface SharedDocumentScene extends SceneBase {
  kind: 'shared-document';
  lease: boolean;
  doc: DocView;
  papers: PaperView[];
  /** 지금 DB 행 락을 쥔 actor. */
  rowLock: number | null;
}

export interface CounterWindow {
  /** 창구 가운데 x(논리 px). */
  cx: number;
  /** 서버 이름(서버별 창구일 때). */
  label: string;
  /** 메모리 락 보유자(app-memory-lock). */
  lockHolder: number | null;
}

export interface StockView {
  qty: number | null;
  initial: number | null;
  /** 행 락·advisory 락 보유자(상자에 자물쇠). */
  lockHolder: number | null;
  oversold: boolean;
  /** 차감 직후 상자 들썩임. */
  bump: boolean;
  /** 상자 x(가운데). */
  cx: number;
  /** 상자 위쪽 y. */
  top: number;
}

export interface QueueCounterScene extends SceneBase {
  kind: 'queue-at-counter';
  windows: CounterWindow[];
  stock: StockView;
  /** 서버별 창구(메모리 락). */
  perServer: boolean;
  /** 줄에 선 사람 수(그린 사람 기준). */
  queued: number;
}

export interface EmptyScene {
  kind: 'empty';
}

export type StageScene = SharedDocumentScene | QueueCounterScene | EmptyScene;

export function toneToLabel(t: Tone): LabelTone {
  return t === 'retry' ? 'wait' : t;
}

// ---- 이동(보간) ----------------------------------------------------------

/** 이벤트 시각 t0에 (fx,fy)에서 출발해 (tx,ty)로 걷는 중. 프레임 누적 상태가 없어 되감기에 안전하다. */
export interface Mover {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  t0: number;
  dur: number;
}

export function placeAt(x: number, y: number): Mover {
  return { fx: x, fy: y, tx: x, ty: y, t0: 0, dur: 0 };
}

export function posAt(m: Mover, t: number): { x: number; y: number } {
  if (m.dur <= 0) return { x: m.tx, y: m.ty };
  const f = Math.min(1, Math.max(0, (t - m.t0) / m.dur));
  return { x: m.fx + (m.tx - m.fx) * f, y: m.fy + (m.ty - m.fy) * f };
}

/** 이벤트 시각 t에 지금 자리에서 (x,y)로 걷기 시작. */
export function moveTo(m: Mover, x: number, y: number, t: number): void {
  const p = posAt(m, t);
  m.fx = p.x;
  m.fy = p.y;
  m.tx = x;
  m.ty = y;
  m.t0 = t;
  m.dur = Math.hypot(x - p.x, y - p.y) / PX_PER_REAL_MS;
}

export function walkingAt(m: Mover, t: number): boolean {
  return m.dur > 0 && t < m.t0 + m.dur && t >= m.t0;
}
