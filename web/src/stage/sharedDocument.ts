import { phaseInfo } from '../events/phases';
import type { RunEvent } from '../events/types';
import {
  actorRef,
  flag,
  labelOf,
  num,
  roundAt,
  roundsOf,
  sm,
  stagePhase,
  str,
  type StageInput,
} from './events';
import {
  STAGE_W,
  moveTo,
  placeAt,
  posAt,
  toneToLabel,
  walkingAt,
  type ActorView,
  type BubbleView,
  type Emote,
  type LabelTone,
  type Mover,
  type PaperView,
  type PopView,
  type SharedDocumentScene,
} from './model';
import type { IconName } from './sprites';

/**
 * G01 `shared-document` 장면 = f(P). design/mockup.html `sceneAt`을 옮겼다.
 * 라운드 시작부터 P까지의 이벤트를 접어서(fold) 만든다. 이동은 이벤트 사이 보간뿐이다.
 */

/** 그릴 수 있는 최대 대표 인원(책상 자리 수). 나머지는 카운터로. */
export const G01_MAX_DRAWN = 4;
export const DESK = { x: 100, y: 96, w: 56 } as const;
export const DOC_POS = { x: 121, y: 84 } as const;

export function homeX(i: number): number {
  return i % 2 === 0 ? -14 : STAGE_W + 14;
}

export function deskSpot(i: number, n: number, lease: boolean): { x: number; y: number } {
  if (lease) return { x: 128, y: 134 };
  const xs: Record<number, number[]> = {
    1: [128],
    2: [114, 142],
    3: [106, 128, 150],
    4: [100, 119, 138, 157],
  };
  const row = xs[Math.max(1, Math.min(4, n))]!;
  return { x: row[Math.min(i, row.length - 1)]!, y: 136 };
}

export function knockSpot(i: number): { x: number; y: number } {
  return { x: i % 2 ? 156 : 100, y: 144 + (i >> 1) * 6 };
}

export function waitSpot(i: number): { x: number; y: number } {
  return {
    x: i % 2 ? STAGE_W - 30 - (i >> 1) * 16 : 30 + (i >> 1) * 16,
    y: 154 + (i >> 1) * 4,
  };
}

interface ActorState extends Mover {
  i: number;
  vis: boolean;
  leaving: boolean;
  carry: boolean;
  cv: number | null;
  emote: Emote | null;
  emoteT: number;
  emoteDur: number;
  knockT: number;
  lungeT: number;
  editing: boolean;
  paused: boolean;
  seen: boolean;
  conflicts: number;
}

interface Timed {
  t: number;
  life: number;
}

const FOREVER = 1e12;
const KNOCK = sm(420);
const LUNGE = sm(330);
const FLASH = sm(330);
const PAPER_LIFE = sm(1600);
const POP_LIFE = sm(1800);
const FADE = sm(300);

/** 기록이 edit-lease(편집 잠금) 장면인가. */
export function isLease(input: StageInput): boolean {
  if (/lease/.test(input.meta.strategy.id)) return true;
  return input.events.some((e) => {
    const p = stagePhase(e);
    return p === 'lease_rejected' || p === 'holder_left' || p === 'holder_paused';
  });
}

/** 라운드 시작 버전: attrs.baseVersion > 첫 읽기 버전 > 첫 커밋·획득 버전 − 1. */
export function baseVersionOf(events: readonly RunEvent[]): number | null {
  for (const e of events) {
    const b = num(e, 'baseVersion');
    if (b !== null) return b;
  }
  for (const e of events) {
    const p = stagePhase(e);
    const v = num(e, 'version', 'v');
    if (v === null) continue;
    if (p === 'db_read') return v;
    if (p === 'committed' || p === 'lock_acquired') return v - 1;
  }
  return null;
}

/** 모르는 phase는 말풍선 글자로만(DESIGN §10.3 장면 매핑). 잡음이 되는 것은 뺀다. */
const SILENT = new Set([
  'sql',
  'injected_delay',
  'cache_hit',
  'cache_miss',
  'enqueued',
  'dequeued',
]);

export function sharedDocumentSceneAt(
  input: StageInput,
  P: number,
  labels: readonly string[],
): SharedDocumentScene {
  const ids = input.meta.actors;
  const n = Math.min(G01_MAX_DRAWN, ids.length);
  const lease = isLease(input);
  const blind = /blind/.test(input.meta.strategy.id);
  const rounds = roundsOf(input);
  const rd = roundAt(rounds, P);
  const lt = P - rd.start;

  const actors: ActorState[] = Array.from({ length: n }, (_, i) => ({
    ...placeAt(homeX(i), 150),
    i,
    vis: false,
    leaving: false,
    carry: false,
    cv: null,
    emote: null,
    emoteT: 0,
    emoteDur: 0,
    knockT: -FOREVER,
    lungeT: -FOREVER,
    editing: false,
    paused: false,
    seen: false,
    conflicts: 0,
  }));
  const doc = {
    version: rd.baseVersion ?? baseVersionOf(rd.events),
    lock: null as number | null,
    expired: false,
    writing: null as number | null,
    flashT: -FOREVER,
  };
  let rowLock: number | null = null;
  const papers: (Timed & { a: number; key: string })[] = [];
  const pops: (Timed & { key: string; text: string; icon: IconName; tone: LabelTone })[] = [];
  let bubbles: (Timed & { a: number; key: string; text: string; tone: LabelTone })[] = [];
  const L = (i: number | null) => labelOf(labels, i);

  const emote = (a: ActorState, e: Emote | null, t: number, dur: number) => {
    a.emote = e;
    a.emoteT = t;
    a.emoteDur = dur;
  };

  for (const e of rd.events) {
    if (e.t > P) break;
    const i = ids.indexOf(e.actor);
    const t = e.t - rd.start;
    const ph = stagePhase(e);
    // 그리는 사람 밖(5번째 이후)이라도 문서 상태는 바꾼다.
    const a = i >= 0 && i < n ? actors[i]! : null;
    switch (ph) {
      case 'arrived': {
        if (!a) break;
        const late = flag(e, 'late') || a.paused;
        if (late) {
          a.paused = false;
          emote(a, 'bang', t, sm(400));
        }
        if (!a.vis || a.leaving) {
          const req = str(e, 'req');
          const acquire = lease && (req === 'acq' || (req === null && !a.seen));
          a.vis = true;
          a.leaving = false;
          Object.assign(a, placeAt(homeX(i), 146 + (i > 1 ? 10 : 0)));
          const sp = acquire ? knockSpot(i) : deskSpot(i, n, lease);
          moveTo(a, sp.x, sp.y, t);
        }
        a.seen = true;
        break;
      }
      case 'db_read':
        if (!a) break;
        a.carry = true;
        a.cv = num(e, 'version', 'v') ?? doc.version;
        a.editing = false;
        break;
      case 'editing':
        if (!a) break;
        a.editing = true;
        emote(a, 'write', t, FOREVER);
        break;
      case 'db_write': {
        if (a) {
          a.editing = false;
          a.emote = null;
          a.lungeT = t;
        }
        doc.writing = i;
        // UPDATE가 잡은 행 락은 commit까지(원장 INSERT 포함). 편집 잠금의 실패한 save는 행을 못 잡는다.
        if (str(e, 'write', 'w') !== 'leaseFail' && rowLock === null && (e.rows ?? 1) > 0)
          rowLock = i;
        break;
      }
      case 'lock_wait': {
        if (!a) break;
        emote(a, 'wait', t, FOREVER);
        const owner = actorRef(e, input.meta, 'owner', 'holder') ?? rowLock;
        bubbles.push({
          t,
          a: i,
          key: `w${e.id}`,
          text: `${L(owner)} 커밋 기다리는 중 (행 락)`,
          tone: 'wait',
          life: FOREVER,
        });
        break;
      }
      case 'committed':
        if (a) {
          a.carry = false;
          emote(a, 'check', t, sm(900));
        }
        doc.writing = null;
        doc.flashT = t;
        doc.version = num(e, 'version', 'v') ?? (doc.version === null ? null : doc.version + 1);
        if (a) a.cv = doc.version;
        if (rowLock === i) rowLock = null;
        bubbles = bubbles.filter((b) => b.a !== i || b.tone !== 'wait');
        break;
      case 'lost':
        papers.push({ t, a: i, key: `p${e.id}`, life: PAPER_LIFE });
        pops.push({
          t,
          key: `p${e.id}`,
          text: '잃어버린 수정 +1',
          icon: 'cross',
          tone: 'bad',
          life: POP_LIFE,
        });
        break;
      case 'conflict': {
        if (doc.writing === i) doc.writing = null;
        if (rowLock === i) rowLock = null;
        if (!a) break;
        a.carry = false;
        a.knockT = t;
        emote(a, 'bang', t, sm(1500));
        a.conflicts++;
        const cur = num(e, 'cur', 'currentVersion') ?? doc.version;
        const reason = str(e, 'reason');
        const again = flag(e, 'again') || (blind && a.conflicts > 1);
        bubbles = bubbles.filter((b) => b.a !== i || b.tone !== 'wait');
        bubbles.push({
          t,
          a: i,
          key: `b${e.id}`,
          text:
            reason === 'lease_lost'
              ? '409 · 잠금을 잃었어요'
              : reason === 'lease_expired'
                ? '409 · 잠금이 만료됐어요'
                : again
                  ? `409 · 또 거절 (v${cur ?? '?'}) · 포기`
                  : `409 · 먼저 고쳐졌어요 (v${cur ?? '?'})`,
          tone: 'bad',
          life: sm(1700),
        });
        break;
      }
      case 'retry':
        if (!a) break;
        emote(a, 'retry', t, sm(450));
        if (flag(e, 'knock') || (lease && a.vis && !a.carry)) {
          const k = knockSpot(i);
          moveTo(a, k.x, k.y, t);
        }
        break;
      case 'lock_acquired': {
        doc.lock = i;
        doc.expired = false;
        doc.version =
          num(e, 'version', 'v') ??
          (doc.version === null || !lease ? doc.version : doc.version + 1);
        if (!a) break;
        a.emote = null;
        // 멈춘 옛 보유자가 책상 앞에 서 있으면 옆자리로
        const sp = actors.some((o) => o.paused && o.i !== i)
          ? { x: 154, y: 134 }
          : deskSpot(i, n, lease);
        moveTo(a, sp.x, sp.y, t);
        bubbles = bubbles.filter((b) => b.a !== i || b.tone !== 'wait');
        break;
      }
      case 'lease_rejected': {
        if (!a) break;
        a.knockT = t;
        emote(a, 'wait', t, FOREVER);
        bubbles.push({
          t,
          a: i,
          key: `r${e.id}`,
          text: '423 · 잠겨 있음',
          tone: 'wait',
          life: sm(900),
        });
        const w = waitSpot(i);
        moveTo(a, w.x, w.y, t + sm(120));
        break;
      }
      case 'lock_released':
        doc.lock = null;
        doc.version =
          num(e, 'version', 'v') ??
          (doc.version === null || !lease ? doc.version : doc.version + 1);
        break;
      case 'holder_left':
        if (!a) break;
        a.leaving = true;
        a.carry = false;
        a.editing = false;
        a.emote = null;
        moveTo(a, homeX(i), 150, t);
        pops.push({
          t,
          key: `g${e.id}`,
          text: `${L(i)} 이탈 · release 없음 · 잠금은 남음`,
          icon: 'out',
          tone: 'bad',
          life: POP_LIFE,
        });
        break;
      case 'holder_paused':
        if (!a) break;
        a.paused = true;
        a.editing = false;
        emote(a, 'stop', t, FOREVER);
        pops.push({
          t,
          key: `g${e.id}`,
          text: `${L(i)} 멈춤 (GC·네트워크 단절) · 잠금은 남음`,
          icon: 'stop',
          tone: 'bad',
          life: POP_LIFE,
        });
        break;
      case 'lease_expired':
        doc.expired = true;
        pops.push({
          t,
          key: `x${e.id}`,
          text: 'TTL 만료 · 누구나 회수 가능',
          icon: 'wait',
          tone: 'wait',
          life: POP_LIFE,
        });
        break;
      case 'responded':
        if (!a) break;
        a.leaving = true;
        a.carry = false;
        a.editing = false;
        a.emote = null;
        moveTo(a, homeX(i), 150, t);
        bubbles = bubbles.filter((b) => b.a !== i);
        break;
      case 'failed':
      case 'rolled_back':
      case 'lock_timeout':
        if (!a) break;
        a.carry = false;
        emote(a, 'bang', t, sm(900));
        bubbles.push({
          t,
          a: i,
          key: `f${e.id}`,
          text: phaseInfo(e.phase).label,
          tone: 'bad',
          life: sm(1200),
        });
        break;
      default:
        if (!a || SILENT.has(e.phase)) break;
        if (ph === 'other') {
          const info = phaseInfo(e.phase);
          bubbles.push({
            t,
            a: i,
            key: `o${e.id}`,
            text: info.label,
            tone: toneToLabel(info.tone),
            life: sm(900),
          });
        }
    }
  }

  const stageLt = lt * 40; // 무대 ms(다리 프레임·펜 위치용)
  const views: ActorView[] = actors.map((a) => {
    const p = posAt(a, lt);
    const walking = walkingAt(a, lt);
    const visible = a.vis && !(a.leaving && !walking);
    let emoteNow = a.emote;
    if (emoteNow && lt - a.emoteT > a.emoteDur) emoteNow = a.editing ? 'write' : null;
    const ka = lt - a.knockT;
    const la = lt - a.lungeT;
    const x = Math.round(p.x);
    return {
      index: a.i,
      id: ids[a.i]!,
      look: 'staff',
      visible,
      x,
      y: Math.round(p.y),
      walking,
      step: walking ? ((((stageLt / 140) | 0) % 2) as 0 | 1) : 0,
      flip: walking ? a.tx < a.fx : x > 128,
      knock: ka >= 0 && ka < KNOCK ? 1 - ka / KNOCK : 0,
      knockDir: a.i % 2 ? 1 : -1,
      lunge: la >= 0 && la < LUNGE ? 1 - la / LUNGE : 0,
      carry: a.carry,
      footTag: a.carry && a.cv !== null ? `v${a.cv}` : null,
      emote: emoteNow,
      ghost: a.paused,
    };
  });

  const paperViews: PaperView[] = papers
    .filter((p) => lt - p.t < p.life)
    .map((p) => {
      const s = ((lt - p.t) * 40) / 1000; // 무대 초
      const dir = p.a % 2 ? 1 : -1;
      const life = 1.6 - s;
      return {
        key: p.key,
        actor: p.a,
        x: Math.round(122 + dir * 34 * s),
        y: Math.round(84 - 46 * s + 15 * s * s),
        tilt: Math.round(Math.sin(s * 9) * 2),
        alpha: Math.max(0, Math.min(1, life / 0.8)),
      };
    });

  const popViews: PopView[] = pops
    .filter((p) => lt - p.t < p.life)
    .map((p) => {
      const age = lt - p.t;
      return {
        key: p.key,
        text: p.text,
        icon: p.icon,
        tone: p.tone,
        x: 128,
        y: Math.round(66 - (age / p.life) * 14),
        y0: 66,
        opacity: Math.min(1, (p.life - age) / FADE),
      };
    });

  const bubbleViews: BubbleView[] = bubbles
    .filter((b) => lt - b.t < b.life && views[b.a]?.visible)
    .map((b) => ({
      key: b.key,
      actor: b.a,
      text: b.text,
      tone: b.tone,
      opacity: b.life >= FOREVER ? 1 : Math.min(1, (b.life - (lt - b.t)) / FADE),
    }));

  return {
    kind: 'shared-document',
    lt,
    roundIndex: Math.max(0, rounds.indexOf(rd)),
    roundCount: rounds.length,
    roundStart: rd.start,
    roundEnd: rd.end,
    actors: views,
    bubbles: bubbleViews,
    pops: popViews,
    others: Math.max(0, input.meta.totalActors - n),
    lease,
    doc: {
      version: doc.version,
      lock: doc.lock,
      expired: doc.expired,
      writing: doc.writing !== null,
      lift: lt - doc.flashT >= 0 && lt - doc.flashT < FLASH,
      pen: ((stageLt / 80) | 0) % 3,
    },
    papers: paperViews,
    rowLock,
  };
}
