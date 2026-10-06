/**
 * G01 라운드 생성 — design/mockup.html 3절 buildRound·buildLease를 순수 함수로 옮겼다.
 * 시각은 라운드 시작부터의 무대 ms(정수). 원장·이력은 수정 토큰으로 직접 계산하고, 잃어버린 수정 이벤트는
 * 손으로 놓지 않고 "커밋이 지운 토큰"에서 나온다(판정 = 원장 기준, DESIGN §3-1).
 */
import {
  EDIT_STAGE,
  EDITS,
  LABELS as L,
  ROUND_TAIL,
  ROUTE as R,
  ROUNDS,
  TTL_STAGE,
} from './constants';
import type { G01StrategyId, ShapeId } from './constants';

/** 시안 phase 이름(변환 전). */
export type MPhase =
  | 'arrived'
  | 'db_read'
  | 'editing'
  | 'db_write'
  | 'lock_wait'
  | 'conflict'
  | 'retry'
  | 'committed'
  | 'lost'
  | 'lock_acquired'
  | 'lease_rejected'
  | 'lock_released'
  | 'holder_left'
  | 'holder_paused'
  | 'lease_expired'
  | 'responded';

/** 시안 이벤트(라운드 기준 무대 ms). 필드 이름은 시안 그대로. */
export interface MEvent {
  t: number;
  a: number;
  phase: MPhase;
  d: string;
  req?: 'get' | 'put' | 'acq';
  rv?: number;
  v?: number;
  open?: boolean;
  dup?: boolean;
  dupFirst?: boolean;
  w?: 'naive' | 'opt' | 'lease' | 'leaseFail';
  blocked?: boolean;
  owner?: number;
  via?: 'recheck' | 'lockVersion' | 'lease';
  cur?: number;
  reason?: 'version_mismatch' | 'lease_lost';
  again?: boolean;
  retry?: boolean;
  blind?: boolean;
  merge?: boolean;
  knock?: boolean;
  first?: boolean;
  fence?: number;
  curFence?: number;
  take?: 'expired' | '';
  late?: boolean;
  hold?: boolean;
  by?: number;
  byRead?: number;
  vSave?: number;
  /** 원장 행(커밋 이벤트에만). */
  token?: string;
  requestId?: string;
  txid?: number;
}

export interface MLedger {
  t: number;
  a: number;
  token: string;
  requestId: string;
  txid: number;
}

/** 라운드를 넘어 이어지는 DB 상태(문서 토큰 = 최종 이력, 원장, fence, txid). */
export interface DocState {
  tokens: string[];
  ledger: MLedger[];
  fence: number;
  txid: number;
  /** 라운드 안 원장 행(같은 라운드에서만 덮인다). */
  owner: Map<string, { a: number; t: number }>;
}

export interface RoundOpts {
  strategy: G01StrategyId;
  n: number;
  shape: ShapeId;
  edit: number;
}

export interface MRound {
  ev: MEvent[];
  span: number;
  pace: number;
  endVersion: number;
}

export function buildRound(round: number, v0: number, o: RoundOpts, doc: DocState): MRound {
  const { strategy: s, n, shape } = o;
  let pace = 1;
  if (shape === 'ramp') pace = 1.4 - round * (0.8 / (ROUNDS - 1));
  if (shape === 'spike') pace = round === 2 ? 0.45 : 1.1;
  const st = Math.round(340 * pace);
  const ev: MEvent[] = [];
  const add = (t: number, a: number, phase: MPhase, x: Partial<MEvent> & { d: string }) => {
    const e: MEvent = { t: Math.round(t), a, phase, ...x };
    ev.push(e);
    return e;
  };
  const tok = (a: number) => `e_r${round + 1}_${L[a]}`;
  const snap: Record<number, { tokens: string[]; t: number }> = {};
  const read = (a: number, t: number) => (snap[a] = { tokens: [...doc.tokens], t: Math.round(t) });

  /** 저장 커밋: 원장 INSERT + 이력(tokens) 교체. 지워진 토큰마다 잃어버린 수정 이벤트를 낸다. */
  const commit = (
    t: number,
    a: number,
    written: string[],
    d: string,
    v: number,
    lostNote: (by: number, victim: number) => string,
    blind = false,
  ) => {
    const token = tok(a);
    const requestId = `req_r${round + 1}_${L[a]}`;
    doc.txid += 1;
    const e = add(t, a, 'committed', { d, v, token, requestId, txid: doc.txid });
    doc.ledger.push({ t: e.t, a, token, requestId, txid: doc.txid });
    const dropped = doc.tokens.filter((x) => !written.includes(x));
    for (const x of dropped) {
      const victim = doc.owner.get(x);
      if (!victim) continue;
      add(t + 40, victim.a, 'lost', {
        d: lostNote(a, victim.a),
        by: a,
        blind,
        byRead: snap[a]?.t ?? 0,
        vSave: victim.t,
      });
    }
    doc.tokens = written;
    doc.owner.set(token, { a, t: e.t });
  };

  let cur = v0;
  doc.owner.clear();

  if (s === 'lease') cur = buildLease(round, v0, o, st, add, doc, read, snap, commit, tok);
  else {
    const readT = (i: number) => 1500 + i * st;
    for (let i = 0; i < n; i++) {
      add(i * st, i, 'arrived', { d: `GET ${R} · 화면 열기`, req: 'get' });
      add(readT(i), i, 'db_read', {
        d: `v${v0} 받음 (자동 커밋 SELECT)${i ? ' · 같은 버전' : ''}`,
        v: v0,
        open: true,
        dup: i > 0,
        dupFirst: i === 1,
      });
      read(i, readT(i));
      add(readT(i) + 200, i, 'editing', {
        d: '편집 중 · 사람 시간(압축) · 서버는 아무것도 안 잡음',
      });
    }
    const base = readT(n - 1) + 200 + EDIT_STAGE;
    if (s === 'naive') {
      for (let k = 0; k < n; k++) {
        const t = base + k * 900;
        add(t, k, 'arrived', {
          d: `PUT ${R} · version ${v0} (서버가 보지 않음)`,
          req: 'put',
          rv: v0,
        });
        add(t + 120, k, 'db_write', {
          d: 'begin · nativeUpdate · WHERE id만 (version 조건 없음)',
          w: 'naive',
        });
        cur++;
        commit(
          t + 300,
          k,
          [...snap[k]!.tokens, tok(k)],
          `원장·이력 INSERT → commit · v${cur} · 이 시점 내용 = ${L[k]}안`,
          cur,
          (by, victim) => `${L[by]}가 덮어씀 · ${L[victim]}도 200 받음`,
        );
        add(t + 560, k, 'responded', { d: '200 OK' });
      }
    } else {
      const blind = s === 'blind';
      const conc = round % 2 === 1;
      const losers = [0, 2, 3].slice(0, n - 1);
      // 409를 받은 사람마다 그 순간의 currentVersion을 따로 기억한다(맹목 재시도는 이 값으로 다시 PUT)
      const seen: Record<number, number> = {};
      const t = base;
      let lastConf: number;
      const okNote = (a: number, v: number) =>
        `원장·이력 INSERT → commit · v${v} · 이 시점 내용 = ${L[a]}안`;
      add(t, 1, 'arrived', { d: `PUT ${R} · version ${v0}`, req: 'put', rv: v0 });
      add(t + 120, 1, 'db_write', {
        d: `begin · lockVersion ${v0} 통과 → UPDATE … version = ${v0}`,
        w: 'opt',
        rv: v0,
      });
      const lostB = (by: number, victim: number) => `${L[by]}가 덮어씀 · ${L[victim]}도 200 받음`;
      if (conc) {
        add(t + 40, 0, 'arrived', {
          d: `PUT ${R} · version ${v0} (B와 거의 동시)`,
          req: 'put',
          rv: v0,
        });
        add(t + 200, 0, 'db_write', {
          d: `begin · lockVersion ${v0} 통과 → UPDATE … version = ${v0}`,
          w: 'opt',
          rv: v0,
          blocked: true,
        });
        add(t + 240, 0, 'lock_wait', {
          d: 'B의 UPDATE가 같은 행을 잡고 있음 → 행 락 대기',
          owner: 1,
          rv: v0,
        });
        cur++;
        commit(t + 700, 1, [...snap[1]!.tokens, tok(1)], okNote(1, cur), cur, lostB);
        add(t + 760, 0, 'conflict', {
          d: `B 커밋 → WHERE 재평가 → 0 rows → rollback · 409 · currentVersion ${cur}`,
          via: 'recheck',
          rv: v0,
          cur,
          owner: 1,
          reason: 'version_mismatch',
        });
        add(t + 900, 1, 'responded', { d: '200 OK' });
        lastConf = t + 760;
      } else {
        cur++;
        commit(t + 300, 1, [...snap[1]!.tokens, tok(1)], okNote(1, cur), cur, lostB);
        add(t + 520, 1, 'responded', { d: '200 OK' });
        add(t + 700, 0, 'arrived', { d: `PUT ${R} · version ${v0}`, req: 'put', rv: v0 });
        add(t + 860, 0, 'conflict', {
          d: `lockVersion ${v0} ≠ 현재 ${cur} → rollback · 409 · currentVersion ${cur}`,
          via: 'lockVersion',
          rv: v0,
          cur,
          reason: 'version_mismatch',
        });
        lastConf = t + 860;
      }
      seen[0] = cur;
      for (let k = 2; k < n; k++) {
        const u = lastConf + 300;
        add(u, k, 'arrived', { d: `PUT ${R} · version ${v0}`, req: 'put', rv: v0 });
        add(u + 160, k, 'conflict', {
          d: `lockVersion ${v0} ≠ 현재 ${cur} → rollback · 409 · currentVersion ${cur}`,
          via: 'lockVersion',
          rv: v0,
          cur,
          reason: 'version_mismatch',
        });
        seen[k] = cur;
        lastConf = u + 160;
      }
      let rt = lastConf + 600;
      for (const j of losers) {
        if (blind) {
          // 클라이언트 코드는 if 한 번: 기억한 currentVersion으로 한 번만 다시 PUT. 그 사이 버전이 더 올랐으면 다시 409로 끝난다
          const mv = seen[j]!;
          add(rt, j, 'retry', {
            d: `409 때 받은 currentVersion ${mv}만 꺼냄 · 최신 내용은 안 봄`,
            blind: true,
            rv: mv,
          });
          const p = rt + 300;
          add(p, j, 'arrived', {
            d: `PUT · version ${mv} · body는 처음 그대로`,
            req: 'put',
            rv: mv,
            retry: true,
          });
          if (mv === cur) {
            add(p + 120, j, 'db_write', {
              d: `begin · lockVersion ${mv} 통과 → UPDATE … version = ${mv}`,
              w: 'opt',
              rv: mv,
            });
            cur++;
            commit(
              p + 300,
              j,
              [...snap[j]!.tokens, tok(j)],
              `원장·이력 INSERT → commit · v${cur} · 이 시점 내용 = ${L[j]}의 옛 본문`,
              cur,
              (by) => `${L[by]}가 버전만 바꿔 덮어씀 · 서버는 정상 처리로 봄`,
              true,
            );
            add(p + 560, j, 'responded', { d: '200 OK (재시도 1회)' });
          } else {
            add(p + 160, j, 'conflict', {
              d: `기억한 v${mv} ≠ 현재 v${cur} → rollback · 다시 409 · if 한 번뿐이라 여기서 끝`,
              via: 'lockVersion',
              rv: mv,
              cur,
              reason: 'version_mismatch',
              again: true,
            });
            add(p + 380, j, 'responded', { d: '409 (재시도 1회 뒤 실패 · 이 수정은 저장 안 됨)' });
          }
          rt = p + 900;
        } else {
          add(rt, j, 'retry', { d: '다시 GET → 내 변경을 최신본에 다시 적용' });
          add(rt + 240, j, 'db_read', { d: `v${cur} 다시 받음 (최신본)`, v: cur });
          read(j, rt + 240);
          add(rt + 440, j, 'editing', {
            d: '최신본에 내 변경 다시 적용 (병합·사용자 결정)',
            merge: true,
          });
          const p = rt + 440 + 900;
          add(p, j, 'arrived', {
            d: `PUT · version ${cur} · 병합본`,
            req: 'put',
            rv: cur,
            retry: true,
          });
          add(p + 120, j, 'db_write', {
            d: `begin · lockVersion ${cur} 통과 → UPDATE … version = ${cur}`,
            w: 'opt',
            rv: cur,
          });
          cur++;
          commit(
            p + 300,
            j,
            [...snap[j]!.tokens, tok(j)],
            `원장·이력 INSERT → commit · v${cur} · 앞사람 수정 + ${L[j]} 수정`,
            cur,
            lostB,
          );
          add(p + 520, j, 'responded', { d: '200 OK (재시도 1회)' });
          rt = p + 800;
        }
      }
    }
  }
  // 같은 시각은 넣은 순서를 지킨다(안정 정렬)
  ev.sort((a, b) => a.t - b.t);
  return { ev, span: ev[ev.length - 1]!.t + ROUND_TAIL, pace, endVersion: cur };
}

type Add = (t: number, a: number, phase: MPhase, x: Partial<MEvent> & { d: string }) => MEvent;

/*
 * 편집 잠금: 서버는 줄을 세우지 않는다. 423 → 클라이언트가 n ms 뒤 다시 노크(폴링). 다음 노크가 가장 빠른 사람이 가져간다.
 * 보유자가 끝나는 두 장면(서버 인스턴스와 무관 — 잠금은 DB 칼럼이라 서버를 죽여도 그대로다):
 *   R2 'left'   클라이언트 이탈 → release를 보내지 않음 → TTL 만료 → 다음 노크가 회수
 *   R3 'paused' 같은 클라이언트가 멈춤(GC·네트워크 단절) → TTL 만료·회수 → 깨어나 늦게 저장 → locked_by·fence 불일치 → 409 lease_lost
 */
function buildLease(
  round: number,
  v0: number,
  o: RoundOpts,
  st: number,
  add: Add,
  doc: DocState,
  read: (a: number, t: number) => unknown,
  snap: Record<number, { tokens: string[]; t: number }>,
  commit: (
    t: number,
    a: number,
    written: string[],
    d: string,
    v: number,
    lostNote: (by: number, victim: number) => string,
  ) => void,
  tok: (a: number) => string,
): number {
  const { n } = o;
  const mode = round === 1 ? 'left' : round === 2 ? 'paused' : '';
  const editName = EDITS[o.edit]!.name;
  let cur = v0;
  for (let i = 0; i < n; i++)
    add(i * st, i, 'arrived', { d: `POST ${R}/lease · 잠금 요청`, req: 'acq' });
  interface W {
    j: number;
    next: number;
    every: number;
    lastT: number;
  }
  const waiting: W[] = [];
  for (let j = 1; j < n; j++) {
    const k0 = Math.max(1700 + (j - 1) * Math.round(st * 0.7), j * st + 1400);
    add(k0, j, 'lease_rejected', {
      d: `acquire 0 rows → 423 · Retry-After · 보유자 ${L[0]}`,
      owner: 0,
      first: true,
    });
    const every = 1000 + (n - j) * 170; // 늦게 온 사람이 더 자주 노크할 수도 있다 → 순서 보장 없음
    waiting.push({ j, next: k0 + every, every, lastT: k0 });
  }
  // 노크 한 번 = retry(다시 노크) + lease_rejected(423) 한 쌍. 같은 사람의 노크는 앞 노크 응답 뒤에만 시작한다(중복 없음)
  const knock = (w: W, owner: number) => {
    add(Math.max(w.lastT + 200, w.next - 450), w.j, 'retry', {
      d: 'Retry-After 지나서 다시 노크',
      knock: true,
    });
    add(w.next, w.j, 'lease_rejected', { d: `acquire 0 rows → 423 · 보유자 ${L[owner]}`, owner });
    w.lastT = w.next;
    w.next += w.every;
  };
  const pollUntil = (free: number, owner: number) =>
    waiting.forEach((w) => {
      while (w.next < free) knock(w, owner);
    });
  let holder = 0;
  let at = 1500;
  let note = '빈 잠금 → 획득';
  let take: 'expired' | '' = '';
  let late: { fence: number } | null = null;
  for (;;) {
    cur++;
    doc.fence++; // acquire도 UPDATE라 버전 칼럼 +1 (save +1, release +1 → 한 차례에 +3)
    const fence = doc.fence;
    add(at, holder, 'lock_acquired', {
      d: `${note} · fence ${fence} · lease_until = DB clock_timestamp() + 30s`,
      v: cur,
      fence,
      take,
    });
    if (late) {
      // 멈췄던 A가 깨어나 늦게 저장 — 새 보유자의 acquire(+1) 뒤라 409의 currentVersion은 그 값
      const t = at + 900;
      add(t, 0, 'arrived', {
        d: `PUT ${R} · 깨어난 A의 늦은 저장 (fence ${late.fence})`,
        req: 'put',
        late: true,
        fence: late.fence,
      });
      add(t + 120, 0, 'db_write', {
        d: `begin · WHERE locked_by = A AND fence = ${late.fence} AND lease_until > clock_timestamp() → 0 rows`,
        w: 'leaseFail',
        owner: holder,
        fence: late.fence,
        curFence: fence,
      });
      add(t + 260, 0, 'conflict', {
        d: `재조회: locked_by = ${L[holder]}, fence ${fence} → rollback · 409 lease_lost · currentVersion ${cur}`,
        via: 'lease',
        reason: 'lease_lost',
        owner: holder,
        cur,
        fence: late.fence,
        curFence: fence,
      });
      add(t + 480, 0, 'responded', { d: '409 Conflict' });
      late = null;
    }
    add(at + 300, holder, 'db_read', { d: `v${cur} 받음 (자동 커밋 SELECT)`, v: cur, open: true });
    read(holder, at + 300);
    add(at + 500, holder, 'editing', {
      d: `편집 중 · 사람 시간 ${editName} · 잠금 쥔 채`,
      hold: true,
    });
    let free: number;
    if (mode && holder === 0) {
      if (mode === 'left')
        add(at + 1300, 0, 'holder_left', {
          d: 'A가 떠남(탭 닫기·이탈) · release(DELETE /lease)를 보내지 않음 · locked_by = A가 남음',
        });
      else {
        add(at + 1300, 0, 'holder_paused', {
          d: `A 클라이언트가 멈춤(GC·네트워크 단절) · 저장 직전 · fence ${fence}를 든 채`,
          fence,
        });
        late = { fence };
      }
      free = at + TTL_STAGE;
      pollUntil(free, 0);
      add(free, 0, 'lease_expired', {
        d: 'lease_until ≤ clock_timestamp() · 칼럼엔 A가 남았지만 효력 없음',
      });
    } else {
      const s = at + 500 + EDIT_STAGE;
      add(s, holder, 'arrived', {
        d: `PUT ${R} · 잠금 보유자 저장 (fence ${fence})`,
        req: 'put',
        fence,
      });
      add(s + 120, holder, 'db_write', {
        d: `begin · WHERE locked_by = ${L[holder]} AND fence = ${fence} AND lease_until > clock_timestamp()`,
        w: 'lease',
        fence,
      });
      cur++;
      commit(
        s + 300,
        holder,
        [...snap[holder]!.tokens, tok(holder)],
        `원장·이력 INSERT → commit · v${cur} · 이 시점 내용 = ${L[holder]}안`,
        cur,
        (by, victim) => `${L[by]}가 ${L[victim]}의 수정을 덮어씀`,
      );
      free = s + 500;
      pollUntil(free, holder);
      cur++;
      add(free, holder, 'lock_released', {
        d: `잠금 해제 (DELETE /lease · WHERE locked_by AND fence = ${fence})`,
        v: cur,
        fence,
      });
      add(free + 100, holder, 'responded', { d: '200 OK' });
    }
    if (!waiting.length) break;
    if (waiting.length > 1) {
      // 시안: 늦게 온 사람의 노크 주기가 마침 맞아 먼저 차지하는 장면을 보인다
      const lateW = waiting.reduce((p, q) => (q.j > p.j ? q : p));
      const m = Math.min(...waiting.map((x) => x.next));
      lateW.next = Math.max(free + 60, lateW.lastT + 700, m - 80);
    }
    waiting.sort((p, q) => p.next - q.next);
    const w = waiting.shift()!;
    const earliest = Math.min(w.j, ...waiting.map((x) => x.j));
    add(Math.max(w.lastT + 200, w.next - 450), w.j, 'retry', {
      d: 'Retry-After 지나서 다시 노크',
      knock: true,
    });
    const wasExpired = !!mode && holder === 0;
    at = w.next;
    holder = w.j;
    take = wasExpired ? 'expired' : '';
    note = wasExpired
      ? '만료된 잠금 회수'
      : w.j !== earliest
        ? `${L[w.j]}가 먼저 차지 (${L[earliest]}가 먼저 왔지만 순서 보장 없음)`
        : '빈 잠금 → 획득';
  }
  return cur;
}
