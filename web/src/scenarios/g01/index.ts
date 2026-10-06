/**
 * G01 같은 문서 동시 수정 — 결정적 시뮬레이션 기록 생성기.
 * 규칙은 design/mockup.html 3절(buildRecording)과 같다. 출력은 재생 엔진이 받는 Recording(실제 ms).
 */
import type {
  LedgerEntry,
  Phase,
  PhaseInfoOverride,
  Recording,
  RoundInfo,
  RunEvent,
  RunSummary,
  Sample,
  TxBand,
  TxMark,
} from '../../events/types';
import { STAGE_PER_REAL } from '../../playback/constants';
import { computeAutoStops } from '../../playback/stops';
import { rng } from '../rng';
import { G01_ENTITY, g01Code, g01Line } from './code';
import { codeMap, explain, stmtOf } from './codemap';
import {
  EDITS,
  G01_STRATEGIES,
  LABELS as L,
  PEOPLE,
  ROUNDS,
  ROUTE,
  SHAPES,
  START_FENCE,
  START_VERSION,
  type G01Strategy,
  type People,
  type ShapeId,
} from './constants';
import { buildRound, type DocState, type MEvent, type MPhase } from './rounds';
import { serverSnapshots, txBands } from './server';

export * from './constants';
export { g01Code, G01_ENTITY } from './code';

export type G01StrategyCode =
  'naive-overwrite' | 'blind-retry' | 'optimistic-version' | 'edit-lease';

export interface G01Options {
  strategy: G01StrategyCode;
  /** 같은 문서를 고치는 사람 수(2~4). 기본 2. */
  people?: People;
  /** 도착 모양. 기본 const. */
  shape?: ShapeId;
  /** 편집 시간 옵션 인덱스(EDITS: 압축·2초·30초·5분). 기본 0. edit-lease만 결과에 영향. */
  edit?: number;
  /** 실행 번호(seed). 같은 값이면 같은 기록. 기본 1. */
  seed?: number;
}

const PHASE: Record<MPhase, Phase> = {
  arrived: 'arrived',
  db_read: 'db_read',
  editing: 'custom:editing',
  db_write: 'db_write',
  lock_wait: 'lock_wait',
  conflict: 'conflict',
  retry: 'retry',
  committed: 'committed',
  lost: 'custom:lost_update',
  lock_acquired: 'lock_acquired',
  lease_rejected: 'custom:lease_rejected',
  lock_released: 'lock_released',
  holder_left: 'custom:holder_left',
  holder_paused: 'custom:holder_paused',
  lease_expired: 'lease_expired',
  responded: 'responded',
};

/** 시안 phase 사전(PH) — 라벨·색·묶음·핵심·자동 멈춤. */
export const G01_PHASES: Partial<Record<Phase, Required<PhaseInfoOverride>>> = {
  arrived: { label: '요청', tone: 'info', group: 'arrive', key: false, autoStop: false },
  db_read: { label: '읽기·버전', tone: 'neutral', group: 'read', key: true, autoStop: false },
  'custom:editing': {
    label: '편집(사람)',
    tone: 'neutral',
    group: 'edit',
    key: false,
    autoStop: false,
  },
  db_write: { label: '쓰기', tone: 'neutral', group: 'io', key: false, autoStop: false },
  lock_wait: { label: '행 락 대기', tone: 'wait', group: 'lock', key: true, autoStop: true },
  conflict: { label: '409 충돌', tone: 'bad', group: 'conflict', key: true, autoStop: true },
  retry: { label: '재시도', tone: 'retry', group: 'retry', key: true, autoStop: false },
  committed: { label: '커밋', tone: 'ok', group: 'commit', key: true, autoStop: false },
  'custom:lost_update': {
    label: '잃어버린 수정',
    tone: 'bad',
    group: 'lost',
    key: true,
    autoStop: true,
  },
  lock_acquired: { label: '잠금 획득', tone: 'info', group: 'lock', key: true, autoStop: false },
  'custom:lease_rejected': {
    label: '423 거절',
    tone: 'wait',
    group: 'lock',
    key: true,
    autoStop: false,
  },
  lock_released: { label: '잠금 해제', tone: 'neutral', group: 'lock', key: true, autoStop: false },
  'custom:holder_left': {
    label: '보유자 이탈',
    tone: 'bad',
    group: 'lock',
    key: true,
    autoStop: true,
  },
  'custom:holder_paused': {
    label: '보유자 멈춤',
    tone: 'bad',
    group: 'lock',
    key: true,
    autoStop: true,
  },
  lease_expired: { label: 'TTL 만료', tone: 'wait', group: 'lock', key: true, autoStop: true },
  responded: { label: '응답', tone: 'neutral', group: 'arrive', key: false, autoStop: false },
};

/** 시안 isAuto: 원인(두 번째 같은 버전 수신)·첫 423·자동 멈춤 phase. */
function isAuto(e: MEvent): boolean {
  if (e.phase === 'db_read') return !!e.dupFirst;
  if (e.phase === 'lease_rejected') return !!e.first;
  return G01_PHASES[PHASE[e.phase]]!.autoStop;
}

const toReal = (stage: number) => stage / STAGE_PER_REAL;

export function strategyOf(code: G01StrategyCode): G01Strategy {
  const s = G01_STRATEGIES.find((x) => x.code === code);
  if (!s) throw new Error(`G01: 모르는 처리 방식 ${code}`);
  return s;
}

/**
 * 결과 요약. G01 팩은 아직 실측 전이라 처리량·p95·실패율은 없다(measured: null —
 * 생성 규칙으로 표현용 수치를 지어내지 않는다). 409·423·재시도·위반은 이 기록에서 센 값이다.
 */
function summarize(
  st: G01Strategy,
  counts: { conf: number; r423: number; retr: number; viol: number },
): RunSummary {
  const bad = counts.viol > 0;
  return {
    measured: null,
    loadModel: 'closed',
    conflicts: counts.conf,
    rejected423: counts.r423,
    retries: counts.retr,
    violations: counts.viol,
    invariant: '불변식: 원장의 성공 수정 토큰이 모두 최종 이력에 있다',
    invariantSub: !bad
      ? '원장의 성공 수정 토큰 = 최종 이력 (일치)'
      : st.id === 'blind'
        ? '409 뒤 맹목 재시도가 앞사람 토큰을 이력에서 지움'
        : '원장엔 커밋된 토큰이 최종 이력엔 없음 · 응답은 전부 200',
  };
}

function attrsOf(e: MEvent): RunEvent['attrs'] {
  const out: NonNullable<RunEvent['attrs']> = {};
  const lbl = (i: number | undefined) => (i === undefined ? undefined : L[i]);
  const put = (k: string, v: string | number | boolean | undefined) => {
    if (v !== undefined && v !== false && v !== '') out[k] = v;
  };
  put('version', e.v);
  put('readVersion', e.rv);
  put('currentVersion', e.cur);
  put('owner', lbl(e.owner));
  put('by', lbl(e.by));
  put('via', e.via);
  put('reason', e.reason);
  put('again', e.again);
  put('fence', e.fence);
  put('currentFence', e.curFence);
  put('take', e.take);
  put('blind', e.blind);
  put('knock', e.knock);
  put('req', e.req);
  put('open', e.open);
  put('dup', e.dup);
  put('late', e.late);
  put('merge', e.merge);
  put('retry', e.retry);
  put('first', e.first);
  put('blocked', e.blocked);
  put('hold', e.hold);
  put('write', e.w);
  put('editToken', e.token);
  put('txid', e.txid);
  return Object.keys(out).length ? out : undefined;
}

function rowsOf(e: MEvent): number | undefined {
  switch (e.phase) {
    case 'db_read':
    case 'committed':
    case 'lock_acquired':
    case 'lock_released':
      return 1;
    case 'lease_rejected':
      return 0;
    case 'db_write':
      return e.w === 'leaseFail' ? 0 : undefined;
    case 'conflict':
      return e.via === 'recheck' ? 0 : undefined;
    default:
      return undefined;
  }
}

export function buildG01Recording(opts: G01Options): Recording {
  const st = strategyOf(opts.strategy);
  const n = opts.people ?? 2;
  const shape = opts.shape ?? 'const';
  const edit = opts.edit ?? 0;
  const seed = opts.seed ?? 1;
  if (!PEOPLE.includes(n)) throw new Error(`G01: 사람 수는 2~4 (받은 값 ${n})`);
  if (!EDITS[edit]) throw new Error(`G01: 편집 시간 옵션 0~${EDITS.length - 1} (받은 값 ${edit})`);
  const shapeIdx = SHAPES.findIndex((x) => x.id === shape);
  const R = rng(
    seed * 9973 + st.seedIndex * 131 + PEOPLE.indexOf(n) * 17 + shapeIdx * 7 + edit * 3,
  );

  const doc: DocState = {
    tokens: ['e_seed'],
    ledger: [],
    fence: START_FENCE,
    txid: 90_000,
    owner: new Map(),
  };
  const code = g01Code(st.id);
  const events: RunEvent[] = [];
  const mEvents: MEvent[] = [];
  const rounds: RoundInfo[] = [];
  const bands: TxBand[] = [];
  const marks: TxMark[] = [];
  const lag: Sample[] = [];
  const eldBase = { naive: 6, blind: 8, opt: 8, lease: 7 }[st.id];
  const counts = { conf: 0, r423: 0, retr: 0, viol: 0 };
  const firstReads: (number | undefined)[] = [];
  let v = START_VERSION;
  let start = 0;
  let seq = 0;

  const ledger: LedgerEntry[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const before = doc.ledger.length;
    const b = buildRound(r, v, { strategy: st.id, n, shape, edit }, doc);
    const real = (t: number) => toReal(start + t);
    for (const x of doc.ledger.slice(before)) {
      ledger.push({
        t: real(x.t),
        actor: L[x.a]!,
        requestId: x.requestId,
        editToken: x.token,
        txid: x.txid,
      });
    }
    for (let t = 0; t < b.span; t += 450) {
      lag.push({ t: real(t), v: Math.max(2, Math.round(eldBase * (0.6 + R() * 0.9))) });
    }
    const hits = b.ev.map((e) => codeMap(st.id, e, edit));
    const snaps = serverSnapshots(b.ev, {
      lease: st.id === 'lease',
      baseVersion: v,
      crowd: 1 + (r % 2),
      toReal: real,
      sqlOf: (e) => stmtOf(codeMap(st.id, e, edit)),
    });
    const tb = txBands(b.ev, n, r, b.span, real);
    bands.push(...tb.bands);
    marks.push(...tb.marks);
    firstReads[r] = b.ev.find((x) => x.phase === 'db_read' && x.a === 0)?.t;
    const reqNo = new Map<number, number>();
    b.ev.forEach((e, i) => {
      const hit = hits[i] ?? null;
      const phase = PHASE[e.phase];
      const actor = L[e.a]!;
      if (e.phase === 'arrived') reqNo.set(e.a, (reqNo.get(e.a) ?? 0) + 1);
      if (e.phase === 'conflict') counts.conf++;
      if (e.phase === 'lease_rejected') counts.r423++;
      if (e.phase === 'retry') counts.retr++;
      if (e.phase === 'lost') counts.viol++;
      const line = hit ? g01Line(st.id, hit.tag) : undefined;
      const sql = stmtOf(hit);
      const rows = rowsOf(e);
      const key = G01_PHASES[phase]!.key;
      seq += 1;
      const ev: RunEvent = {
        id: `g01#${seq}`,
        t: real(e.t),
        actor,
        phase,
        note: e.d,
        reqId: `r${r + 1}_${actor}${reqNo.get(e.a) ?? 1}`,
        round: r,
        autoStop: isAuto(e),
        mergeKey: key ? `${r}|${actor}` : `${r}`,
        server: snaps[i]!,
      };
      if (e.phase === 'db_read' && e.dupFirst) ev.cause = true;
      if (e.phase === 'conflict') ev.stopKey = `${e.via ?? ''}|${e.again ? 'again' : ''}`;
      if (line !== undefined) ev.codeRef = `${code.path}:${line}`;
      if (hit) {
        ev.marker = hit.tag;
        if (hit.also?.length) ev.markerAlso = hit.also;
        if (hit.tone) ev.codeTone = hit.tone;
        if (hit.sql.length) ev.sqlLines = hit.sql;
        ev.codeNote = hit.note;
      }
      if (sql) ev.sql = sql;
      if (rows !== undefined) ev.rows = rows;
      const attrs = attrsOf(e);
      if (attrs) ev.attrs = attrs;
      events.push(ev);
      mEvents.push(e);
    });
    rounds.push({
      index: r,
      start: toReal(start),
      end: toReal(start + b.span),
      baseVersion: v,
      endVersion: b.endVersion,
    });
    v = b.endVersion;
    start += b.span;
  }

  // 자동 멈춤 설명: 재생 엔진과 같은 규칙(같은 phase·stopKey, 묶음 창)으로 묶어 첫 이벤트에 싣는다
  const index = new Map(events.map((e, i) => [e, i] as const));
  for (const stop of computeAutoStops(events, (_p, e) => e.autoStop === true, 0)) {
    const ms = stop.events.map((e) => mEvents[index.get(e)!]!);
    stop.events[0]!.callout = explain(st.id, ms, firstReads[stop.events[0]!.round ?? 0]);
  }

  // 판정: 원장의 성공 토큰 중 최종 이력(문서 tokens)에 없는 것
  const missing = doc.ledger.filter((x) => !doc.tokens.includes(x.token));
  const violations = missing.length;
  const summary = summarize(st, { ...counts, viol: violations });

  return {
    meta: {
      runId: `sim_g01_${st.code}_p${n}_${shape}_e${edit}_s${seed}`,
      pack: 'generic',
      scenario: 'g01-shared-document',
      scenarioTitle: '같은 문서 동시 수정',
      strategy: { id: st.code, label: st.name, kind: st.kind },
      sceneType: 'shared-document',
      actors: L.slice(0, n),
      totalActors: n,
      isolation: 'READ COMMITTED',
      route: st.id === 'lease' ? `POST ${ROUTE}/lease · PUT ${ROUTE}` : `PUT ${ROUTE}`,
      durationMs: toReal(start),
      autoStopDelayMs: 0,
      actorLabels: Object.fromEntries(L.slice(0, n).map((x) => [x, x])),
      options: { strategy: st.code, people: n, shape, edit, seed },
      seed,
    },
    events,
    code,
    extraCode: [G01_ENTITY],
    rounds,
    txBands: bands,
    txMarks: marks,
    summary,
    ledger,
    verdict: {
      violations,
      ok: violations === 0,
      checks: { 'lost-update': violations },
      detail: `원장 성공 ${doc.ledger.length}건 · 최종 이력에 없는 수정 토큰 ${violations}개${violations ? ` (${missing.map((x) => x.token).join(', ')})` : ''}`,
    },
    notice: {
      kind: 'simulated',
      label: '시뮬레이션 기록(실측 아님)',
      text: `design/mockup.html의 G01 기록 생성 규칙으로 만든 결정적 기록이다(seed ${seed}). G01 팩은 아직 실측 전이라 처리량·p95·실패율은 보이지 않고(실측 없음), 시각은 표현용이며 편집 구간은 사람 시간을 압축해 그렸다. 위반 수는 이 기록의 원장(수정 토큰)과 최종 이력으로 계산했다.`,
    },
    eventLoopLag: lag,
    phases: G01_PHASES,
  };
}
