import { phaseInfo } from '../events/phases';
import type { RunEvent } from '../events/types';
import {
  actorRef,
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
  STAGE_H,
  moveTo,
  placeAt,
  posAt,
  toneToLabel,
  walkingAt,
  type ActorView,
  type BubbleView,
  type CounterWindow,
  type Emote,
  type LabelTone,
  type Mover,
  type PopView,
  type QueueCounterScene,
} from './model';
import type { IconName } from './sprites';

/**
 * G02 `queue-at-counter` 장면 = f(P). 창구(행)·재고 상자(DB의 재고 행)·주문 손님.
 * mockup.html에는 없는 장면이라 같은 스프라이트 규칙(12×18 캐릭터, 7×8 자물쇠, 이벤트로만 이동)으로 새로 만들었다.
 *
 * - 락 없는 방식(no-lock, conditional-update): 손님이 창구 앞에 나란히 서서 동시에 읽고 쓴다.
 * - 행 락(row-lock, advisory): 상자에 자물쇠(보유자 색 띠). 나머지는 창구 앞 줄.
 * - 메모리 락(app-memory-lock): 서버별 창구 2개, 창구마다 자기 자물쇠. 상자는 하나(같은 DB 행)라 두 창구가 동시에 판다.
 */

export const G02_MAX_DRAWN = 8;
export const COUNTER_Y = 100;
const SERVE_Y = 130;
const QUEUE_Y = 160;
const QUEUE_GAP = 18;
/** 줄 맨 앞은 창구(손님이 서는 자리)에서 옆으로 이만큼 비켜 선다 — 말풍선·감정 표시가 겹치지 않게. */
const QUEUE_OFFSET = 34;

const FOREVER = 1e12;
const KNOCK = sm(420);
const LUNGE = sm(330);
const BUMP = sm(330);
const POP_LIFE = sm(1800);
const FADE = sm(300);

/** 손님은 화면 아래(매장 입구 = 보는 사람 쪽)에서 들어오고 나간다. */
const STREET_Y = STAGE_H + 20;

/** 이벤트가 난 서버(0/1): `attrs.server`(0·1) > `attrs.instance` > `meta.actorInstances[actor]`('app-2' → 1). */
export function serverOf(
  e: RunEvent,
  meta?: Pick<StageInput['meta'], 'actorInstances'>,
): number | null {
  const s = num(e, 'server');
  if (s !== null) return s > 0 ? 1 : 0;
  const inst = str(e, 'instance') ?? meta?.actorInstances?.[e.actor] ?? null;
  if (inst) {
    const m = /(\d+)\s*$/.exec(inst);
    if (m) return Number(m[1]) > 1 ? 1 : 0;
  }
  return null;
}

/** 서버가 2대인 기록인가(서버별 창구 2개). */
export function isPerServer(input: StageInput): boolean {
  const seen = new Set<number>();
  for (const id of input.meta.actors) {
    const inst = input.meta.actorInstances?.[id];
    const m = inst ? /(\d+)\s*$/.exec(inst) : null;
    if (m) seen.add(Number(m[1]) > 1 ? 1 : 0);
  }
  for (const e of input.events) {
    const s = serverOf(e);
    if (s !== null) seen.add(s);
  }
  return seen.size > 1;
}

/** 앱 메모리 락(mutex) 방식인가: 자물쇠가 상자(DB 행)가 아니라 서버 창구에 걸린다. */
export function isMemoryLock(input: StageInput): boolean {
  return (
    /memory/.test(input.meta.strategy.id) || input.events.some((e) => str(e, 'lock') === 'memory')
  );
}

/** 락으로 줄을 세우는 방식인가(락 이벤트가 하나라도 있으면). */
function usesLock(input: StageInput): boolean {
  if (/no-lock|conditional/.test(input.meta.strategy.id)) return false;
  return input.events.some((e) => {
    const p = stagePhase(e);
    return p === 'lock_wait' || p === 'lock_acquired';
  });
}

function initialQtyOf(events: readonly RunEvent[]): number | null {
  for (const e of events) {
    const v = num(e, 'initialQty', 'stockBefore', 'initial');
    if (v !== null) return v;
  }
  for (const e of events) if (stagePhase(e) === 'db_read') return num(e, 'qty', 'stock');
  return null;
}

function spread(k: number, m: number): number {
  const gap = m > 4 ? 20 : 24;
  return Math.round((k - (m - 1) / 2) * gap);
}

interface ActorState extends Mover {
  i: number;
  vis: boolean;
  leaving: boolean;
  carry: boolean;
  read: number | null;
  emote: Emote | null;
  emoteT: number;
  emoteDur: number;
  knockT: number;
  lungeT: number;
  win: number;
}

export function queueCounterSceneAt(
  input: StageInput,
  P: number,
  labels: readonly string[],
): QueueCounterScene {
  const ids = input.meta.actors;
  const n = Math.min(G02_MAX_DRAWN, ids.length);
  const perServer = isPerServer(input);
  const memory = isMemoryLock(input);
  const locking = usesLock(input);
  const rounds = roundsOf(input);
  const rd = roundAt(rounds, P);
  const lt = P - rd.start;
  const L = (i: number | null) => labelOf(labels, i);

  const windows: CounterWindow[] = perServer
    ? [
        { cx: 72, label: '서버 1 창구', lockHolder: null },
        { cx: 184, label: '서버 2 창구', lockHolder: null },
      ]
    : [{ cx: 128, label: memory ? '창구 · 서버 1' : '창구', lockHolder: null }];
  const crate = perServer ? { cx: 128, top: 74 } : { cx: 128, top: COUNTER_Y - 12 };

  // 창구 배정: 이벤트의 서버 표시 > 짝·홀 순번
  const winOf = new Array<number>(n).fill(0);
  if (perServer) {
    for (let i = 0; i < n; i++) winOf[i] = i % 2;
    for (const e of input.events) {
      const i = ids.indexOf(e.actor);
      const s = serverOf(e, input.meta);
      if (i >= 0 && i < n && s !== null) winOf[i] = s;
    }
  }
  const membersOf = (w: number) => winOf.map((x, i) => (x === w ? i : -1)).filter((i) => i >= 0);
  const serveSpot = (i: number) => {
    const w = winOf[i]!;
    const cx = windows[w]!.cx;
    if (locking) return { x: cx, y: SERVE_Y };
    const ms = membersOf(w);
    return { x: cx + spread(ms.indexOf(i), ms.length), y: SERVE_Y };
  };
  const queueSpot = (w: number, k: number) => {
    const dir = perServer && w === 1 ? 1 : -1;
    return { x: windows[w]!.cx + dir * (QUEUE_OFFSET + k * QUEUE_GAP), y: QUEUE_Y + (k % 2) };
  };

  const actors: ActorState[] = Array.from({ length: n }, (_, i) => ({
    ...placeAt(0, STREET_Y),
    i,
    vis: false,
    leaving: false,
    carry: false,
    read: null,
    emote: null,
    emoteT: 0,
    emoteDur: 0,
    knockT: -FOREVER,
    lungeT: -FOREVER,
    win: winOf[i]!,
  }));
  const queues: number[][] = windows.map(() => []);
  const stock = {
    qty: initialQtyOf(rd.events),
    initial: initialQtyOf(rd.events),
    lockHolder: null as number | null,
    bumpT: -FOREVER,
    oversold: false,
  };
  const explicitOversell = rd.events.some((e) => stagePhase(e) === 'oversold');
  /** 락을 기다리는 사람(줄 말풍선은 창구마다 하나로 모은다 — 사람마다 띄우면 줄에서 겹친다). */
  const waiting = new Map<
    number,
    { t: number; key: string; owner: number | null; memory: boolean }
  >();
  /** 이 락 이벤트가 메모리 락인가: `attrs.lock`이 있으면 그것, 없으면 방식으로 추정. */
  /** 락을 풀고 나간 사람: 대기자의 attrs.owner가 이미 풀었으면 "누구 처리 중"으로 쓰지 않는다. */
  const released = new Set<number>();
  const memLock = (e: RunEvent) => {
    const k = str(e, 'lock');
    return k === 'memory' || (k === null && memory);
  };
  const pops: { t: number; key: string; text: string; icon: IconName; tone: LabelTone }[] = [];
  let bubbles: {
    t: number;
    a: number;
    key: string;
    text: string;
    tone: LabelTone;
    life: number;
  }[] = [];

  const emote = (a: ActorState, e: Emote | null, t: number, dur: number) => {
    a.emote = e;
    a.emoteT = t;
    a.emoteDur = dur;
  };
  const leaveQueue = (i: number, t: number) => {
    waiting.delete(i);
    for (let w = 0; w < queues.length; w++) {
      const q = queues[w]!;
      const k = q.indexOf(i);
      if (k < 0) continue;
      q.splice(k, 1);
      // 뒤에 선 사람들이 한 칸씩 앞으로(이 이벤트 시각에 걷기 시작)
      q.forEach((j, kk) => {
        if (kk >= k) {
          const s = queueSpot(w, kk);
          moveTo(actors[j]!, s.x, s.y, t);
        }
      });
    }
  };
  const joinQueue = (i: number, t: number) => {
    const a = actors[i]!;
    const q = queues[a.win]!;
    if (q.includes(i)) return;
    q.push(i);
    const s = queueSpot(a.win, q.length - 1);
    moveTo(a, s.x, s.y, t);
  };
  const oversellPop = (t: number, key: string) => {
    stock.oversold = true;
    pops.push({ t, key, text: '−1 초과 판매', icon: 'cross', tone: 'bad' });
  };

  for (const e of rd.events) {
    if (e.t > P) break;
    const i = ids.indexOf(e.actor);
    const t = e.t - rd.start;
    const ph = stagePhase(e);
    const a = i >= 0 && i < n ? actors[i]! : null;
    switch (ph) {
      case 'arrived':
        if (!a) break;
        if (!a.vis || a.leaving) {
          a.vis = true;
          a.leaving = false;
          if (locking) {
            const q = queues[a.win]!;
            Object.assign(
              a,
              placeAt(queueSpot(a.win, q.includes(i) ? q.indexOf(i) : q.length).x, STREET_Y),
            );
            joinQueue(i, t);
          } else {
            const s = serveSpot(i);
            Object.assign(a, placeAt(s.x, STREET_Y));
            moveTo(a, s.x, s.y, t);
          }
        }
        break;
      case 'lock_wait': {
        if (!a) break;
        emote(a, 'wait', t, FOREVER);
        const owner = actorRef(e, input.meta, 'owner', 'holder');
        // 창구(메모리 락)를 이미 쥔 채 DB 행 락을 기다리면 줄로 돌아가지 않고 창구에서 기다린다.
        if (!memLock(e) && windows[a.win]!.lockHolder === i) {
          bubbles.push({
            t,
            a: i,
            key: `w${e.id}`,
            text: `${L(owner)}의 행 락 대기`,
            tone: 'wait',
            life: FOREVER,
          });
          break;
        }
        joinQueue(i, t);
        waiting.set(i, { t, key: `w${e.id}`, owner, memory: memLock(e) });
        break;
      }
      case 'lock_acquired': {
        released.delete(i);
        if (memLock(e)) {
          const w = a ? a.win : (serverOf(e, input.meta) ?? 0);
          windows[w]!.lockHolder = i;
        } else stock.lockHolder = i;
        if (!a) break;
        leaveQueue(i, t);
        a.emote = null;
        bubbles = bubbles.filter((b) => b.a !== i || b.tone !== 'wait');
        const s = serveSpot(i);
        moveTo(a, s.x, s.y, t);
        break;
      }
      case 'lock_released':
        released.add(i);
        for (const w of windows) if (w.lockHolder === i) w.lockHolder = null;
        if (stock.lockHolder === i) stock.lockHolder = null;
        break;
      case 'db_read':
        if (!a) break;
        a.carry = true;
        a.read = num(e, 'qty', 'stock') ?? stock.qty;
        break;
      case 'db_write':
        if (a) a.lungeT = t;
        break;
      case 'committed': {
        const before = stock.qty;
        const dq = num(e, 'n', 'quantity') ?? 1;
        const fromRead = a && a.read !== null ? a.read - dq : null;
        stock.qty =
          num(e, 'qty', 'stock') ?? fromRead ?? (stock.qty === null ? null : stock.qty - dq);
        stock.bumpT = t;
        if (a) {
          a.carry = false;
          emote(a, 'check', t, sm(900));
        }
        if (!explicitOversell && stock.qty !== null && stock.qty < 0 && (before ?? 0) >= stock.qty)
          oversellPop(t, `o${e.id}`);
        break;
      }
      case 'oversold':
        oversellPop(t, `o${e.id}`);
        break;
      case 'sold_out':
      case 'conflict':
      case 'failed':
      case 'rolled_back':
      case 'lock_timeout': {
        if (!a) break;
        leaveQueue(i, t);
        a.carry = false;
        a.knockT = t;
        emote(a, 'bang', t, sm(1500));
        bubbles = bubbles.filter((b) => b.a !== i || b.tone !== 'wait');
        const reason = str(e, 'reason');
        const soldOut = ph === 'sold_out' || reason === 'sold_out' || e.rows === 0;
        bubbles.push({
          t,
          a: i,
          key: `b${e.id}`,
          text:
            ph === 'lock_timeout'
              ? '락 타임아웃 · 실패'
              : soldOut
                ? '품절 · 0행'
                : phaseInfo(e.phase).label,
          tone: soldOut ? 'wait' : 'bad',
          life: sm(1700),
        });
        break;
      }
      case 'retry':
        if (a) emote(a, 'retry', t, sm(450));
        break;
      case 'responded':
        if (!a) break;
        leaveQueue(i, t);
        a.leaving = true;
        a.carry = false;
        a.emote = null;
        moveTo(a, posAt(a, t).x, STREET_Y, t);
        // 대기 말풍선만 지운다. 결과 말풍선(품절 등)은 응답이 곧바로 와도 나가는 동안 남는다.
        bubbles = bubbles.filter((b) => b.a !== i || b.life < FOREVER);
        break;
      default:
        if (!a || ph !== 'other' || e.phase === 'sql' || e.phase === 'injected_delay') break;
        {
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

  // 창구마다 줄 말풍선 하나: 줄 맨 앞 사람 머리 위에 "누구 다음 차례" 또는 "N명 대기"
  queues.forEach((q, w) => {
    const ws = q.filter((i) => waiting.has(i));
    if (!ws.length) return;
    const front = ws[0]!;
    const info = waiting.get(front)!;
    const owner = info.owner !== null && !released.has(info.owner) ? info.owner : null;
    const holder = (info.memory ? windows[w]!.lockHolder : stock.lockHolder) ?? owner;
    const kind = info.memory ? '메모리 락' : '행 락';
    const latest = Math.max(...ws.map((i) => waiting.get(i)!.t));
    bubbles.push({
      t: latest,
      a: front,
      key: `wq${w}`,
      text:
        holder === null
          ? `${ws.length}명 대기 (${kind})`
          : ws.length > 1
            ? `${ws.length}명 대기 · ${L(holder)} 처리 중 (${kind})`
            : `${L(holder)} 다음 차례 (${kind})`,
      tone: 'wait',
      life: FOREVER,
    });
  });

  const stageLt = lt * 40;
  const views: ActorView[] = actors.map((a) => {
    const p = posAt(a, lt);
    const walking = walkingAt(a, lt);
    const ka = lt - a.knockT;
    const la = lt - a.lungeT;
    const x = Math.round(p.x);
    const emoteNow = a.emote && lt - a.emoteT > a.emoteDur ? null : a.emote;
    return {
      index: a.i,
      id: ids[a.i]!,
      look: 'customer',
      visible: a.vis && !(a.leaving && !walking),
      x,
      y: Math.round(p.y),
      walking,
      step: walking ? ((((stageLt / 140) | 0) % 2) as 0 | 1) : 0,
      flip: walking ? a.tx < a.fx : x > windows[a.win]!.cx,
      knock: ka >= 0 && ka < KNOCK ? 1 - ka / KNOCK : 0,
      knockDir: a.i % 2 ? 1 : -1,
      lunge: la >= 0 && la < LUNGE ? 1 - la / LUNGE : 0,
      carry: a.carry,
      footTag: a.carry && a.read !== null ? `읽음 ${a.read}` : null,
      emote: emoteNow,
      ghost: false,
    };
  });

  const popViews: PopView[] = pops
    .filter((p) => lt - p.t < POP_LIFE)
    .map((p) => {
      const age = lt - p.t;
      return {
        key: p.key,
        text: p.text,
        icon: p.icon,
        tone: p.tone,
        x: crate.cx,
        y: Math.round(crate.top - 14 - (age / POP_LIFE) * 14),
        y0: crate.top - 14,
        opacity: Math.min(1, (POP_LIFE - age) / FADE),
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

  // 그리지 않는 사람: 이벤트의 attrs.others(집계 카운트)가 있으면 그 값, 없으면 대표 밖 인원
  let others = Math.max(0, input.meta.totalActors - n);
  for (const e of rd.events) {
    if (e.t > P) break;
    const o = num(e, 'others', 'queueOthers');
    if (o !== null) others = o;
  }

  return {
    kind: 'queue-at-counter',
    lt,
    roundIndex: Math.max(0, rounds.indexOf(rd)),
    roundCount: rounds.length,
    roundStart: rd.start,
    roundEnd: rd.end,
    actors: views,
    bubbles: bubbleViews,
    pops: popViews,
    others,
    windows,
    stock: {
      qty: stock.qty,
      initial: stock.initial,
      lockHolder: stock.lockHolder,
      oversold: stock.oversold || (stock.qty !== null && stock.qty < 0),
      bump: lt - stock.bumpT >= 0 && lt - stock.bumpT < BUMP,
      cx: crate.cx,
      top: crate.top,
    },
    perServer,
    queued: queues.reduce((s, q) => s + q.length, 0),
  };
}
