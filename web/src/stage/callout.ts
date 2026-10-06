import { phaseInfo, type Tone } from '../events/phases';
import type { RunEvent } from '../events/types';
import type { AutoStop } from '../playback/stops';
import {
  actorRef,
  flag,
  fmtReal,
  labelOf,
  num,
  roundOfEvent,
  roundsOf,
  stagePhase,
  str,
  type Round,
  type StageInput,
} from './events';
import type { StageScene } from './model';
import { serverOf } from './queueCounter';

/** 자동 멈춤 설명: 굵은 한 줄 요약 + 보충(§4.8). */
export interface CalloutText {
  tone: Tone;
  title: string;
  body: string;
  /**
   * 기록이 실은 설명(RunEvent.callout, scenarios/rich.ts 서식: **굵게**, {{용어|말}}).
   * 있으면 화면은 title·body 대신 이것을 그린다.
   */
  rich?: string;
}

/** 자동 멈춤 조준 틀 크기(논리 px, §4.8). */
export const SPOT_SIZE = 44;

/** 760px 미만이거나 배율 < 2이면 무대 안이 아니라 무대 아래 시트에 띄운다. */
export function useSheetFor(viewportWidth: number, K: number): boolean {
  return viewportWidth < 760 || K < 2;
}

function lastOf(stop: AutoStop): RunEvent {
  return stop.events[stop.events.length - 1]!;
}

/** 조준 틀 가운데(논리 좌표). */
export function calloutTarget(
  scene: StageScene,
  stop: AutoStop,
  ids: readonly string[],
): { x: number; y: number } {
  if (scene.kind === 'empty') return { x: 128, y: 96 };
  const e = lastOf(stop);
  const ph = stagePhase(e);
  if (scene.kind === 'shared-document' && (ph === 'lost' || ph === 'lease_expired'))
    return { x: 128, y: 86 };
  if (scene.kind === 'queue-at-counter' && ph === 'oversold')
    return { x: scene.stock.cx, y: scene.stock.top + 4 };
  const a = scene.actors[ids.indexOf(e.actor)];
  if (a && a.visible) return { x: a.x, y: a.y - 10 };
  return scene.kind === 'queue-at-counter'
    ? { x: scene.stock.cx, y: scene.stock.top + 4 }
    : { x: 128, y: 86 };
}

function firstInRound(
  rd: Round,
  pred: (e: RunEvent) => boolean,
  before = Infinity,
): RunEvent | null {
  for (const e of rd.events) {
    if (e.t > before) break;
    if (pred(e)) return e;
  }
  return null;
}

function lastInRound(rd: Round, pred: (e: RunEvent) => boolean, before: number): RunEvent | null {
  let found: RunEvent | null = null;
  for (const e of rd.events) {
    if (e.t > before) break;
    if (pred(e)) found = e;
  }
  return found;
}

/**
 * 자동 멈춤 설명 문장. G01은 design/mockup.html `explain`과 같은 문장이다(용어 툴팁만 뺐다).
 * attrs가 없으면 같은 라운드의 이벤트에서 찾아 채운다(읽은 시각, 저장 시각, 보유자 등).
 */
export function explainStop(
  input: StageInput,
  stop: AutoStop,
  labels: readonly string[],
): CalloutText {
  const ids = input.meta.actors;
  const strat = input.meta.strategy.id;
  const blind = /blind/.test(strat);
  const e = stop.events[0]!;
  const rd = roundOfEvent(roundsOf(input), e);
  const rel = (x: RunEvent | null) => (x ? fmtReal(x.t - rd.start) : '?');
  const L = (i: number | null) => labelOf(labels, i);
  const me = ids.indexOf(e.actor);
  const who = [...new Set(stop.events.map((x) => L(ids.indexOf(x.actor))))].join(', ');
  const tone = phaseInfo(stop.phase).tone;
  const ph = stagePhase(e);
  const readOf = (i: number, before = Infinity) =>
    firstInRound(rd, (x) => x.actor === ids[i] && stagePhase(x) === 'db_read', before);
  const out = (title: string, body: string, t: Tone = tone): CalloutText => ({
    tone: t,
    title,
    body,
  });

  if (input.meta.sceneType === 'queue-at-counter') {
    const c = explainCounter(input, stop, labels, rd);
    return e.callout ? { ...c, rich: e.callout } : c;
  }
  if (e.callout) {
    const c = explainLocal();
    return { ...c, rich: e.callout };
  }
  return explainLocal();

  function explainLocal(): CalloutText {
    switch (ph) {
      case 'db_read': {
        const first = firstInRound(
          rd,
          (x) => stagePhase(x) === 'db_read' && x.actor !== e.actor,
          e.t,
        );
        const v = num(e, 'version', 'v');
        const fi = first ? ids.indexOf(first.actor) : 0;
        return out(
          `${L(me)}도 같은 버전(v${v ?? '?'})을 받았다 — 아직 아무도 저장 전`,
          `${L(fi)}는 +${rel(first)}ms, ${L(me)}는 +${rel(e)}ms에 읽었다. 같은 버전을 들고 각자 편집을 시작한다. 이 순간이 원인이다.`,
          'info',
        );
      }
      case 'lost': {
        const by = actorRef(e, input.meta, 'by');
        if (flag(e, 'blind') || blind)
          return out(
            `${L(by)}가 버전만 바꿔 같은 본문을 다시 보냄 → ${L(me)}의 수정이 사라짐`,
            '409를 "버전만 갱신하면 되는 오류"로 다룬 결과다. 버전 검사는 통과하므로 서버도 DB도 모른다.',
          );
        const byRead = by !== null ? readOf(by, e.t) : null;
        const saved = lastInRound(
          rd,
          (x) => x.actor === e.actor && stagePhase(x) === 'committed',
          e.t,
        );
        return out(
          `${L(by)}가 ${L(me)}의 수정을 덮어씀`,
          `잃어버린 수정 +1. ${L(by)}는 +${rel(byRead)}ms에 읽었다 — ${L(me)}가 저장한 +${rel(saved)}ms보다 먼저. 둘 다 200 OK라 아무도 모른다.`,
        );
      }
      case 'conflict': {
        const cur = num(e, 'cur', 'currentVersion');
        const read = readOf(me, e.t);
        const rv =
          num(e, 'readVersion', 'rv', 'sentVersion') ?? (read ? num(read, 'version', 'v') : null);
        const owner = actorRef(e, input.meta, 'owner', 'holder');
        const reason = str(e, 'reason');
        const waited = !!lastInRound(
          rd,
          (x) => x.actor === e.actor && stagePhase(x) === 'lock_wait',
          e.t,
        );
        const via =
          str(e, 'via') ?? (reason === 'lease_lost' ? 'lease' : waited ? 'recheck' : 'lockVersion');
        const prior = rd.events.filter(
          (x) => x.t < e.t && x.actor === e.actor && stagePhase(x) === 'conflict',
        );
        const again = flag(e, 'again') || (blind && prior.length > 0);
        if (via === 'recheck')
          return out(
            `${L(me)}의 UPDATE가 0행`,
            `${L(owner ?? (me === 0 ? 1 : 0))}의 행 락을 기다렸다가, ${L(owner ?? (me === 0 ? 1 : 0))} 커밋 뒤 PostgreSQL이 최신 행으로 WHERE version = ${rv ?? '?'}를 다시 검사했다(현재 v${cur ?? '?'} — 거짓) → 0 rows → OptimisticLockError → rollback(원장도 안 남음) → 409, currentVersion ${cur ?? '?'}.`,
          );
        if (via === 'lease') {
          const fence = num(e, 'fence');
          const curFence = num(e, 'currentFence', 'curFence');
          return out(
            `깨어난 ${L(me)}의 늦은 저장이 409 (lease_lost)`,
            `${L(me)}가 멈춘 사이 TTL이 지나 ${L(owner)}가 잠금을 가져갔다(fence ${curFence ?? '?'}). save의 WHERE locked_by = '${L(me)}' AND fence = ${fence ?? '?'} AND lease_until > clock_timestamp()가 0행 → 재조회(locked_by = '${L(owner)}') → rollback. currentVersion ${cur ?? '?'}은 ${L(owner)}의 acquire(+1)까지 반영된 값이다.`,
          );
        }
        if (again)
          return out(
            `${who}의 재시도도 409 — 여기서 실패로 끝남`,
            `409 때 기억한 v${rv ?? '?'}로 다시 보냈지만, 그 사이 다른 사람의 재시도가 v${cur ?? '?'}로 올렸다. 클라이언트 코드는 if 한 번만 재시도하므로 더 보내지 않는다. 이 수정은 저장되지 않았고 본인은 실패를 안다.`,
          );
        return out(
          `${who}의 저장이 409로 거절됨`,
          `들고 온 v${rv ?? '?'} ≠ 현재 v${cur ?? '?'}. UPDATE를 보내기 전에 lockVersion 메모리 비교에서 걸렸다. 응답 본문에 currentVersion ${cur ?? '?'}과 현재 내용이 실린다. 다음: ${blind ? '(고장) 버전만 바꿔 같은 body로 다시 PUT' : '다시 GET → 내 변경을 최신본에 다시 적용 → 새 버전으로 PUT'}.`,
        );
      }
      case 'lock_wait': {
        const owner = actorRef(e, input.meta, 'owner', 'holder');
        const read = readOf(me, e.t);
        const rv =
          num(e, 'readVersion', 'rv', 'sentVersion') ?? (read ? num(read, 'version', 'v') : null);
        return out(
          `${L(me)}의 UPDATE가 ${L(owner)}의 행 락을 기다린다`,
          `둘 다 WHERE version = ${rv ?? '?'}로 거의 동시에 도착했다. 먼저 잡은 ${L(owner)}가 커밋할 때까지 DB 안에서 대기한다(커넥션을 쥔 채).`,
        );
      }
      case 'lease_rejected':
        return out(
          `${who}는 423을 받고 문 밖으로`,
          '서버는 줄을 세우지 않는다. 클라이언트가 Retry-After 뒤 다시 노크(폴링)하고, 먼저 온 순서는 보장되지 않는다. 기다리는 동안 DB 커넥션·트랜잭션은 없다.',
        );
      case 'holder_left':
        return out(
          `잠금을 쥔 ${L(me)}가 떠났다 — release를 보내지 않았다`,
          `탭을 닫거나 이탈하면 DELETE /lease가 오지 않는다. locked_by = '${L(me)}'가 DB 칼럼에 남아, lease_until(DB 시계)이 지날 때까지 다른 사람은 423을 받는다. 회수는 TTL 만료로만 된다.`,
        );
      case 'holder_paused':
        return out(
          `잠금을 쥔 ${L(me)}의 클라이언트가 멈췄다 (GC·네트워크 단절)`,
          `${L(me)}는 아직 잠금을 쥐었다고 믿고 fence ${num(e, 'fence') ?? '?'}를 들고 있다. 서버는 ${L(me)}가 살아 있는지 모르니 lease_until이 지나야 풀린다. 깨어나 늦게 저장하면 fence로 거른다.`,
        );
      case 'lease_expired':
        return out(
          'TTL 만료',
          'lease_until ≤ clock_timestamp()라서 다음 acquire의 조건(만료된 잠금)에 맞는다. 다음에 노크하는 사람이 회수한다. 시각은 DB 시계로 잰다.',
        );
    }
    return out(phaseInfo(e.phase).label, e.note ?? '');
  }
}

/** G02 창구 장면 설명(새로 쓴 문장). */
function explainCounter(
  input: StageInput,
  stop: AutoStop,
  labels: readonly string[],
  rd: Round,
): CalloutText {
  const ids = input.meta.actors;
  const e = stop.events[0]!;
  const L = (i: number | null) => labelOf(labels, i);
  const me = ids.indexOf(e.actor);
  const who = [...new Set(stop.events.map((x) => L(ids.indexOf(x.actor))))].join(', ');
  const tone = phaseInfo(stop.phase).tone;
  const memory = /memory/.test(input.meta.strategy.id) || str(e, 'lock') === 'memory';
  const ph = stagePhase(e);
  const out = (title: string, body: string, t: Tone = tone): CalloutText => ({
    tone: t,
    title,
    body,
  });

  switch (ph) {
    case 'lock_wait': {
      if (memory) {
        const s = (serverOf(e, input.meta) ?? 0) + 1;
        return out(
          `${who}는 서버 ${s}의 메모리 락을 기다린다`,
          `이 mutex는 서버 ${s} 프로세스 안에만 있다. 다른 서버의 창구는 이 줄을 모르고 같은 재고 행을 따로 읽고 쓴다.`,
        );
      }
      const owner = actorRef(e, input.meta, 'owner', 'holder');
      return out(
        `${who}의 SELECT … FOR UPDATE가 ${L(owner)}의 행 락을 기다린다`,
        `같은 재고 행을 먼저 잠근 ${L(owner)}가 커밋하거나 롤백할 때까지 DB 안에서 대기한다(커넥션을 쥔 채). 창구 앞 줄이 곧 행 락 대기열이다.`,
      );
    }
    case 'oversold':
    case 'lost':
    case 'committed': {
      const read = firstInRound(rd, (x) => x.actor === e.actor && stagePhase(x) === 'db_read', e.t);
      const q = read ? num(read, 'qty', 'stock') : null;
      return out(
        '재고보다 많이 팔렸다 — 초과 판매',
        memory
          ? `두 서버가 각자 자기 메모리 락만 잡았다. 서로 다른 창구에서 같은 재고${q !== null ? `(${q})` : ''}를 읽고 각자 빼서 썼다. 락이 프로세스 안에만 있으면 서버 2대에서는 막지 못한다.`
          : `${L(me)}가 읽은 재고${q !== null ? `(${q})` : ''}는 다른 주문이 쓰기 전 값이었다. 읽기와 쓰기 사이를 아무것도 막지 않아 같은 재고를 두 번 팔았다. 둘 다 성공 응답을 받았다.`,
        'bad',
      );
    }
    case 'sold_out':
    case 'conflict':
    case 'failed':
      return out(
        `${who}는 품절 — 0행`,
        'UPDATE … WHERE qty >= 1이 최신 행으로 다시 검사돼 0행이 됐다. 재고는 0 아래로 내려가지 않고, 이 주문은 품절로 응답한다.',
        'wait',
      );
    case 'lock_timeout':
      return out(
        `${who}의 락 대기가 lock_timeout으로 끝났다`,
        '정해진 시간 안에 행 락을 얻지 못해 실패로 응답한다. 재고는 바뀌지 않았다.',
      );
  }
  return out(phaseInfo(e.phase).label, e.note ?? '');
}
