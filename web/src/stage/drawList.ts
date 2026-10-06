import type { ActorView, QueueCounterScene, SharedDocumentScene, StageScene } from './model';
import { STAGE_H, STAGE_W } from './model';
import { DESK, DOC_POS } from './sharedDocument';
import { COUNTER_Y } from './queueCounter';
import {
  COPY,
  CRATE,
  CRATE_OVERSOLD,
  CUSTOMER,
  GHOST,
  GHOST_LEGS,
  ICON,
  LEGS,
  PADLOCK,
  PADLOCK_EXPIRED,
  STAFF,
  iconMap,
  suitOf,
  type Bitmap,
  type ColorMap,
  type PalKey,
} from './sprites';

/**
 * 장면 → 그릴 목록(순수 함수, PixiJS 없이 테스트한다).
 * 좌표는 논리 px 정수. 그리는 순서 = 배열 순서(뒤가 위). 사람은 y 오름차순(§5 깊이).
 */
export type DrawOp =
  | {
      k: 'bmp';
      /** 비트맵 이름(텍스처 캐시 키의 일부). */
      id: string;
      rows: Bitmap;
      map?: ColorMap;
      x: number;
      y: number;
      flip?: boolean;
      alpha?: number;
      /** 테스트·디버그용 출처(예: actor:0). */
      tag?: string;
    }
  | {
      k: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      c: PalKey;
      alpha?: number;
      tag?: string;
    };

const rect = (x: number, y: number, w: number, h: number, c: PalKey, tag?: string): DrawOp => ({
  k: 'rect',
  x,
  y,
  w,
  h,
  c,
  ...(tag ? { tag } : {}),
});

// ---- 배경(장면 타입별로 한 번만 만든다) ------------------------------------

export interface BackdropSpec {
  kind: 'shared-document' | 'queue-at-counter' | 'empty';
  lease?: boolean;
  perServer?: boolean;
}

export function backdropKey(s: BackdropSpec): string {
  return `${s.kind}|${s.lease ? 1 : 0}|${s.perServer ? 1 : 0}`;
}

function wallAndFloor(ops: DrawOp[]): void {
  ops.push(
    rect(0, 0, STAGE_W, 64, 'p'),
    rect(0, 38, STAGE_W, 2, 'n'),
    rect(0, 62, STAGE_W, 2, 'm'),
  );
  ops.push(rect(0, 64, STAGE_W, STAGE_H - 64, 'h'));
  // 바닥 줄눈(점선)
  for (let y = 64; y < STAGE_H; y += 16)
    for (let x = 0; x < STAGE_W; x += 2) ops.push(rect(x, y, 1, 1, 'n'));
  for (let x = 0; x < STAGE_W; x += 32)
    for (let y = 64; y < STAGE_H; y += 2) ops.push(rect(x, y, 1, 1, 'n'));
  // 좌우 출입구
  ops.push(rect(0, 140, 10, 28, 'm'), rect(STAGE_W - 10, 140, 10, 28, 'm'));
}

/** design/mockup.html paintBg와 같은 사무실 벽(창문·게시판·시계·서류장). */
function officeWall(ops: DrawOp[]): void {
  ops.push(rect(20, 10, 44, 26, 's'), rect(22, 12, 40, 22, 'n'), rect(41, 12, 2, 22, 'p'));
  for (let i = 0; i < 6; i++)
    ops.push(rect(26 + i, 30 - i, 1, 1, 'p'), rect(47 + i, 28 - i, 1, 1, 'p'));
  ops.push(rect(150, 12, 40, 22, 'd'), rect(151, 13, 38, 20, 'w'));
  ops.push(rect(154, 16, 8, 7, 'p'), rect(165, 15, 9, 8, 'p'), rect(177, 17, 8, 7, 'p'));
  ops.push(rect(155, 18, 6, 1, 'k'), rect(166, 18, 7, 1, 'k'), rect(178, 20, 6, 1, 'k'));
  ops.push(rect(157, 15, 2, 2, 'r'), rect(168, 14, 2, 2, 'b'), rect(180, 16, 2, 2, 'y'));
  ops.push(
    rect(102, 12, 12, 12, 'k'),
    rect(103, 13, 10, 10, 'p'),
    rect(107, 15, 1, 4, 'k'),
    rect(108, 18, 3, 1, 'k'),
  );
  ops.push(
    rect(216, 22, 30, 42, 's'),
    rect(218, 24, 26, 12, 'm'),
    rect(218, 38, 26, 12, 'm'),
    rect(218, 52, 26, 10, 'm'),
  );
  ops.push(rect(228, 29, 6, 2, 's'), rect(228, 43, 6, 2, 's'), rect(228, 56, 6, 2, 's'));
}

/** G02 매장 벽: 진열 선반 두 줄(작은 상자들)과 시계. 상태 색은 쓰지 않는다. */
function shopWall(ops: DrawOp[]): void {
  for (const sx of [12, 196]) {
    ops.push(rect(sx, 14, 48, 2, 'd'), rect(sx, 34, 48, 2, 'd'), rect(sx, 54, 48, 2, 'd'));
    ops.push(rect(sx, 14, 2, 42, 'd'), rect(sx + 46, 14, 2, 42, 'd'));
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 4; c++) {
        const x = sx + 4 + c * 11;
        const y = 24 + r * 20;
        ops.push(
          rect(x, y, 9, 10, 'k'),
          rect(x + 1, y + 1, 7, 8, r ? 'w' : 'm'),
          rect(x + 2, y + 4, 5, 1, 'p'),
        );
      }
  }
  ops.push(
    rect(122, 10, 12, 12, 'k'),
    rect(123, 11, 10, 10, 'p'),
    rect(127, 13, 1, 4, 'k'),
    rect(128, 16, 3, 1, 'k'),
  );
}

export function backdropOps(s: BackdropSpec): DrawOp[] {
  const ops: DrawOp[] = [];
  if (s.kind === 'queue-at-counter') {
    ops.push(rect(0, 0, STAGE_W, 64, 'p'), rect(0, 62, STAGE_W, 2, 'm'));
    shopWall(ops);
    ops.push(rect(0, 64, STAGE_W, STAGE_H - 64, 'h'));
    for (let y = 64; y < STAGE_H; y += 16)
      for (let x = 0; x < STAGE_W; x += 2) ops.push(rect(x, y, 1, 1, 'n'));
    for (let x = 0; x < STAGE_W; x += 32)
      for (let y = 64; y < STAGE_H; y += 2) ops.push(rect(x, y, 1, 1, 'n'));
    // 줄 서는 자리 표시(노란 점선 — 순서 표시일 뿐 장식 아님)
    const lines: [number, number][] = s.perServer
      ? [
          [4, 48],
          [208, 252],
        ]
      : [[4, 104]];
    for (const [a, b] of lines) for (let x = a; x < b; x += 6) ops.push(rect(x, 170, 3, 1, 'y'));
    return ops;
  }
  wallAndFloor(ops);
  officeWall(ops);
  if (s.kind === 'shared-document' && s.lease) {
    // 편집 잠금: 문 밖 대기 구역(노란 점선 — 순서가 아님)
    for (let x = 14; x < 64; x += 6) ops.push(rect(x, 166, 3, 1, 'y'));
    for (let x = STAGE_W - 64; x < STAGE_W - 14; x += 6) ops.push(rect(x, 166, 3, 1, 'y'));
  }
  return ops;
}

// ---- 공통 조각 -------------------------------------------------------------

const EMOTE_COLOR: Record<NonNullable<ActorView['emote']>, PalKey> = {
  check: 'g',
  bang: 'r',
  retry: 'o',
  wait: 'k',
  write: 's',
  cross: 'r',
  stop: 's',
};

/** 튕김: 사인 곡선으로 10px 밀렸다 돌아옴. */
export function knockOffset(a: ActorView): number {
  return Math.round(a.knockDir * Math.sin(a.knock * Math.PI) * 10);
}

export function actorOps(a: ActorView): DrawOp[] {
  if (!a.visible) return [];
  const tag = `actor:${a.index}`;
  const legs = a.walking ? (a.step ? LEGS.a : LEGS.b) : LEGS.stand;
  const bob = a.walking && a.step ? -1 : 0;
  const ly = -Math.round(Math.sin(a.lunge * Math.PI) * 4);
  const x = a.x - 6 + knockOffset(a);
  const y = a.y - 18 + bob + ly;
  const body = a.look === 'customer' ? CUSTOMER : STAFF;
  const ops: DrawOp[] = [
    rect(x + 2, a.y - 1, 8, 2, 'm', tag), // 그림자
    {
      k: 'bmp',
      id: a.look,
      rows: body,
      map: a.ghost ? GHOST : suitOf(a.index),
      x,
      y,
      flip: a.flip,
      tag,
    },
    {
      k: 'bmp',
      id: `legs-${a.walking ? (a.step ? 'a' : 'b') : 'stand'}`,
      rows: legs,
      ...(a.ghost ? { map: GHOST_LEGS } : {}),
      x,
      y: y + 14,
      flip: a.flip,
      tag,
    },
  ];
  if (a.carry)
    ops.push({ k: 'bmp', id: 'copy', rows: COPY, x: x + (a.flip ? -4 : 9), y: y + 6, tag });
  if (a.emote) {
    const ex = x + 1;
    const ey = y - 14;
    ops.push(
      rect(ex - 1, ey - 1, 12, 12, 'k', tag),
      rect(ex, ey, 10, 10, a.emote === 'wait' ? 'y' : 'p', tag),
      rect(ex + 4, ey + 11, 2, 1, 'k', tag),
      {
        k: 'bmp',
        id: `icon-${a.emote}`,
        rows: ICON[a.emote],
        map: iconMap(EMOTE_COLOR[a.emote]),
        x: ex + 1,
        y: ey + 1,
        tag,
      },
    );
  }
  return ops;
}

function padlockOps(
  x: number,
  y: number,
  holder: number | null,
  expired: boolean,
  tag: string,
): DrawOp[] {
  if (expired) {
    const ops: DrawOp[] = [
      { k: 'bmp', id: 'padlock', rows: PADLOCK, map: PADLOCK_EXPIRED, x, y, tag },
    ];
    for (let i = 0; i < 7; i++) ops.push(rect(x + i, y + i, 1, 1, 'r', tag));
    return ops;
  }
  const ops: DrawOp[] = [{ k: 'bmp', id: 'padlock', rows: PADLOCK, x, y, tag }];
  if (holder !== null) ops.push(rect(x, y + 9, 7, 1, suitOf(holder).S!, tag)); // 보유자 색 띠
  return ops;
}

function sortedActors(actors: readonly ActorView[]): ActorView[] {
  return [...actors].sort((p, q) => p.y - q.y || p.index - q.index);
}

// ---- G01 -------------------------------------------------------------------

function deskOps(): DrawOp[] {
  const { x, y, w } = DESK;
  return [
    rect(x + 2, y + 24, w - 4, 3, 'm'),
    rect(x, y + 6, w, 18, 'd'),
    rect(x, y, w, 8, 'w'),
    rect(x, y + 8, w, 1, 'k'),
    rect(x + 4, y + 12, w - 8, 1, 'w'),
    rect(x + 2, y + 24, 3, 2, 'k'),
    rect(x + w - 5, y + 24, 3, 2, 'k'),
  ];
}

function docOps(s: SharedDocumentScene): DrawOp[] {
  const { x, y } = DOC_POS;
  const d = s.doc;
  const lift = d.lift ? -1 : 0;
  const tag = 'doc';
  const ops: DrawOp[] = [
    rect(x - 1, y - 1 + lift, 16, 18, 'k', tag),
    rect(x, y + lift, 14, 16, 'p', tag),
    rect(x + 2, y + 2 + lift, 10, 2, 'b', tag),
  ];
  for (let r = 0; r < 4; r++)
    ops.push(rect(x + 2, y + 6 + r * 2 + lift, r === 3 ? 6 : 10, 1, 's', tag));
  if (d.writing) ops.push(rect(x + 9 + d.pen, y + 12, 3, 1, 'k', 'pen'));
  if (d.lock !== null) ops.push(...padlockOps(x + 10, y - 6, d.lock, d.expired, 'lease-lock'));
  return ops;
}

function paperOps(s: SharedDocumentScene): DrawOp[] {
  const ops: DrawOp[] = [];
  for (const p of s.papers) {
    const tag = `paper:${p.actor}`;
    const a = p.alpha;
    ops.push(
      { ...rect(p.x - 1, p.y - 1, 12, 14, 'k', tag), alpha: a } as DrawOp,
      { ...rect(p.x, p.y, 10, 12, 'p', tag), alpha: a } as DrawOp,
      { ...rect(p.x + 1, p.y + 1, 8, 2, suitOf(p.actor).S!, tag), alpha: a } as DrawOp,
      { ...rect(p.x + 2 + p.tilt, p.y + 5, 6, 1, 'r', tag), alpha: a } as DrawOp,
      { ...rect(p.x + 2 - p.tilt, p.y + 8, 6, 1, 'r', tag), alpha: a } as DrawOp,
    );
  }
  return ops;
}

function sharedDocumentOps(s: SharedDocumentScene): DrawOp[] {
  const ops: DrawOp[] = [...deskOps(), ...docOps(s)];
  for (const a of sortedActors(s.actors)) ops.push(...actorOps(a));
  ops.push(...paperOps(s));
  return ops;
}

// ---- G02 -------------------------------------------------------------------

function counterOps(cx: number, w: number): DrawOp[] {
  const x = cx - w / 2;
  const y = COUNTER_Y;
  return [
    rect(x + 2, y + 22, w - 4, 3, 'm'),
    rect(x, y + 6, w, 16, 'd'),
    rect(x, y, w, 7, 'w'),
    rect(x, y + 7, w, 1, 'k'),
    rect(x + 4, y + 11, w - 8, 1, 'w'),
    rect(x + 4, y + 16, w - 8, 1, 'w'),
    rect(x + 2, y + 22, 3, 2, 'k'),
    rect(x + w - 5, y + 22, 3, 2, 'k'),
  ];
}

function crateOps(s: QueueCounterScene): DrawOp[] {
  const st = s.stock;
  const x = st.cx - 8;
  const y = st.top + (st.bump ? -1 : 0);
  const ops: DrawOp[] = [];
  if (s.perServer) {
    // 두 창구가 함께 쓰는 DB 받침대(가운데)
    ops.push(rect(st.cx - 14, st.top + 11, 28, 4, 'd'), rect(st.cx - 14, st.top + 11, 28, 1, 'k'));
    ops.push(rect(st.cx - 12, st.top + 15, 2, 12, 'k'), rect(st.cx + 10, st.top + 15, 2, 12, 'k'));
  }
  ops.push({
    k: 'bmp',
    id: 'crate',
    rows: CRATE,
    ...(st.oversold ? { map: CRATE_OVERSOLD } : {}),
    x,
    y,
    tag: 'crate',
  });
  if (st.lockHolder !== null)
    ops.push(...padlockOps(st.cx + 6, y - 5, st.lockHolder, false, 'row-lock'));
  return ops;
}

function windowLockOps(s: QueueCounterScene): DrawOp[] {
  const ops: DrawOp[] = [];
  s.windows.forEach((w, k) => {
    if (w.lockHolder !== null)
      ops.push(...padlockOps(w.cx + 22, COUNTER_Y - 9, w.lockHolder, false, `mem-lock:${k}`));
  });
  return ops;
}

function queueCounterOps(s: QueueCounterScene): DrawOp[] {
  const ops: DrawOp[] = [];
  const width = s.perServer ? 72 : 96;
  for (const w of s.windows) ops.push(...counterOps(w.cx, width));
  ops.push(...crateOps(s), ...windowLockOps(s));
  for (const a of sortedActors(s.actors)) ops.push(...actorOps(a));
  return ops;
}

export function sceneOps(s: StageScene): DrawOp[] {
  if (s.kind === 'shared-document') return sharedDocumentOps(s);
  if (s.kind === 'queue-at-counter') return queueCounterOps(s);
  return [];
}

export function backdropSpecOf(s: StageScene): BackdropSpec {
  if (s.kind === 'shared-document') return { kind: s.kind, lease: s.lease };
  if (s.kind === 'queue-at-counter') return { kind: s.kind, perServer: s.perServer };
  return { kind: 'shared-document' };
}
