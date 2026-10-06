/**
 * G02 대표 요청 시뮬레이터(결정적). 요청 4개가 같은 상품 재고를 1개씩 차감하는 과정을
 * DB 행 락(FIFO, 커밋까지 보유)·앱 메모리 mutex(인스턴스별)·READ COMMITTED 읽기 규칙으로 흉내 낸다.
 * 실측이 아니다. 판정은 이 시뮬레이션이 남긴 원장으로 한다.
 */
import type {
  LedgerEntry,
  Phase,
  RunEvent,
  ServerSession,
  ServerSnapshot,
  TxBand,
  TxMark,
} from '../../events/types';
import {
  APP_MS,
  G02_ACTORS,
  G02_ARRIVALS,
  G02_STOCK0,
  PRODUCT_ID,
  RT,
  WINDOW_MS,
  type G02StrategyCode,
} from './model';

type Cmd =
  { wait: number } | { row: 'acquire' | 'release' } | { mem: 'acquire' | 'release'; inst: string };
type Proc = Generator<Cmd, void, number>;

export interface SimEvent extends Omit<RunEvent, 'id' | 'codeRef'> {
  /** 코드 마커(G02 소스의 `// @event` phase). */
  marker?: string;
}

export interface SimResult {
  events: SimEvent[];
  ledger: LedgerEntry[];
  finalStock: number;
  bands: TxBand[];
  marks: TxMark[];
  /** 잠금(행·메모리) 대기 최대값(ms). */
  maxWaitMs: number;
}

const SQL = {
  select: `select "p0".* from "g02_product" as "p0" where "p0"."id" = ${PRODUCT_ID} limit 1`,
  forUpdate: `select "p0".* from "g02_product" as "p0" where "p0"."id" = ${PRODUCT_ID} limit 1 for update`,
  setLocal: "set local lock_timeout = '1000ms'",
  set: (v: number) => `update "g02_product" set "stock" = ${v} where "id" = ${PRODUCT_ID}`,
  cond: `update "g02_product" set "stock" = stock - 1 where "id" = ${PRODUCT_ID} and "stock" >= 1 returning "stock"`,
  ledger: (rid: string, result: string, inst: string) =>
    `insert into "g02_order_ledger" ("request_id", "product_id", "qty", "result", "instance") values ('${rid}', ${PRODUCT_ID}, 1, '${result}', '${inst}') returning "id", "txid", "created_at"`,
};

const round2 = (x: number) => Math.round(x * 1000) / 1000;

export function simulate(
  strategy: G02StrategyCode,
  instances: 1 | 2,
  injected: boolean,
): SimResult {
  const window = injected ? WINDOW_MS : APP_MS;
  const actors = G02_ACTORS;
  const instOf = (i: number) => `app-${instances === 1 ? 1 : (i % 2) + 1}`;
  const rid = (i: number) => `00000000-0000-4000-8000-00000000000${i + 1}`;

  // ── DB·앱 상태 ──
  let now = 0;
  let stock = G02_STOCK0; // 커밋된 재고
  const successes: number[] = []; // 성공 커밋 순서(actor)
  const row = { holder: null as number | null, waiters: [] as { i: number; since: number }[] };
  const mem = new Map<string, { holder: number | null; waiters: { i: number; since: number }[] }>();
  const memOf = (inst: string) => {
    let m = mem.get(inst);
    if (!m) mem.set(inst, (m = { holder: null, waiters: [] }));
    return m;
  };
  const tx = new Map<number, { since: number; sql?: string }>(); // 열린 DB 트랜잭션
  const readers = new Map<number, number>(); // 락 없이 읽고 아직 커밋 전인 요청 → 읽은 값
  let txid = 70_000;
  let maxWait = 0;

  const events: SimEvent[] = [];
  const ledger: LedgerEntry[] = [];
  const bands: TxBand[] = [];
  const marks: TxMark[] = [];

  const snapshot = (): ServerSnapshot => {
    const sessions: ServerSession[] = [...tx.entries()]
      .sort(([p], [q]) => p - q)
      .map(([i, s]) => ({
        actor: actors[i]!,
        pid: 4200 + i,
        state: row.waiters.some((w) => w.i === i) ? 'lock_wait' : 'active',
        ...(s.sql ? { sql: s.sql } : {}),
        since: round2(s.since),
        until: null,
      }));
    const snap: ServerSnapshot = {
      version: stock,
      content: null,
      rowLock:
        row.holder !== null
          ? { holder: actors[row.holder]!, waiters: row.waiters.map((w) => actors[w.i]!) }
          : null,
      sessions,
      pool: { size: 10 * instances, crowd: 1 },
    };
    if (strategy === 'app-memory-lock') {
      snap.memLocks = [...Array(instances).keys()].map((k) => {
        const m = memOf(`app-${k + 1}`);
        return {
          instance: `app-${k + 1}`,
          holder: m.holder !== null ? actors[m.holder]! : null,
          queue: m.waiters.map((w) => actors[w.i]!),
        };
      });
    }
    return snap;
  };

  const emit = (i: number, phase: Phase, x: Partial<SimEvent> = {}) => {
    const e: SimEvent = {
      t: round2(now),
      actor: actors[i]!,
      phase,
      reqId: `r_${actors[i]}`,
      ...x,
    };
    if (x.sql && tx.has(i)) tx.get(i)!.sql = x.sql;
    e.server = snapshot();
    events.push(e);
    return e;
  };
  const band = (i: number, kind: TxBand['kind'], start: number, end: number, tip: string) =>
    bands.push({ actor: actors[i]!, kind, start: round2(start), end: round2(end), tip });
  const mark = (i: number, kind: TxMark['kind'], tip: string) =>
    marks.push({ actor: actors[i]!, kind, t: round2(now), tip });

  // ── 조각 동작 ──
  const begin = (i: number) => {
    tx.set(i, { since: now });
  };

  /** 행 락 획득. 기다렸으면 lock_wait를 남기고 기다린 ms를 돌려준다. */
  function* rowLock(
    i: number,
    waitPhase: { marker: string; note: string; sql?: string },
  ): Generator<Cmd, number, number> {
    const t0 = now;
    if (row.holder !== null && row.holder !== i) {
      emit(i, 'lock_wait', {
        marker: waitPhase.marker,
        note: waitPhase.note,
        ...(waitPhase.sql ? { sql: waitPhase.sql } : {}),
        sqlLines: [
          ...(waitPhase.sql ? [waitPhase.sql] : []),
          `⧗ ${actors[row.holder]}의 트랜잭션이 이 행을 쥐고 있음 → 행 락 대기`,
        ],
        attrs: { lock: 'row', owner: actors[row.holder]! },
        callout: `**${actors[i]}가 ${actors[row.holder]}의 행 락을 기다린다** — 같은 상품 행을 고치려는 트랜잭션은 앞 트랜잭션이 커밋할 때까지 DB 안에서 기다린다(커넥션을 쥔 채).`,
      });
    }
    const waited: number = yield { row: 'acquire' };
    if (waited > 0) {
      band(i, 'wait', t0, now, '행 락 대기 (트랜잭션 안)');
      maxWait = Math.max(maxWait, waited);
    }
    return waited;
  }

  /** release: 커밋으로 행 락을 풀었다고 알릴 때 lock_released의 코드 마커(없으면 null). */
  function* commit(
    i: number,
    result: 'success' | 'sold_out',
    marker: string,
    release: string | null,
  ): Proc {
    yield { wait: RT }; // 원장 INSERT
    const lsql = SQL.ledger(rid(i), result, instOf(i));
    tx.get(i)!.sql = lsql;
    yield { wait: RT * 0.6 }; // COMMIT
    txid += 1;
    ledger.push({
      t: round2(now),
      actor: actors[i]!,
      requestId: rid(i),
      qty: 1,
      result,
      txid,
      instance: instOf(i),
    });
    const since = tx.get(i)!.since;
    tx.delete(i);
    readers.delete(i);
    if (row.holder === i) yield { row: 'release' };
    if (result === 'success')
      emit(i, 'committed', {
        marker,
        note: `원장 success INSERT → commit · 재고 ${stock}`,
        sql: lsql,
        sqlLines: [lsql, '→ 1 row', 'commit'],
        rows: 1,
        attrs: { result, txid, stock, qty: stock },
        codeNote:
          '재고 변경과 원장 INSERT가 한 트랜잭션으로 커밋됐다. 판정은 이 원장으로 한다(원장 성공 수량 = 실제 차감량).',
        codeTone: 'ok',
      });
    else
      // 품절: 재고는 그대로(차감 0행), 원장에 sold_out을 남기고 커밋한다. 충돌(conflict)·실패가 아니라
      // 정상 응답(409 품절)이므로 custom:sold_out으로 따로 낸다(무대·타임라인은 phase로 받는다).
      emit(i, 'custom:sold_out', {
        marker,
        note: '품절 · 재고 차감 0행 → 원장 sold_out INSERT → commit (409)',
        sql: lsql,
        sqlLines: [lsql, '→ 1 row', 'commit'],
        rows: 0,
        autoStop: false,
        attrs: { result, reason: 'sold_out', txid, stock, qty: stock },
        codeNote: '품절로 판정해 원장에 sold_out을 남기고 커밋했다. 재고는 바뀌지 않는다.',
        codeTone: 'wait',
      });
    const sold = ledger.filter((x) => x.result === 'success').length;
    if (result === 'success' && sold > G02_STOCK0)
      emit(i, 'custom:oversold', {
        marker,
        note: `초과 판매 · 원장 성공 ${sold}건 > 시작 재고 ${G02_STOCK0} (재고 ${stock})`,
        attrs: { qty: stock, sold, initialQty: G02_STOCK0 },
        codeNote: `원장에는 성공이 ${sold}건인데 시작 재고는 ${G02_STOCK0}개였다. 덮어쓰인 차감만큼 재고보다 많이 팔렸다.`,
        codeTone: 'bad',
      });
    band(i, 'tx', since, now, 'begin … commit (원장 포함)');
    mark(i, 'ok', result === 'success' ? `commit · 재고 ${stock}` : 'commit · sold_out');
    if (release)
      emit(i, 'lock_released', {
        marker: release,
        note: '커밋으로 행 락 해제',
        attrs: { lock: 'row', owner: actors[i]! },
      });
  }

  /** 앱이 계산한 상수를 SET 하는 커밋. 커밋 시점에 이미 다른 차감이 있었으면 그만큼 지운다(잃어버린 갱신). */
  function applySet(i: number, seen: number) {
    const erased = Math.max(0, seen - stock);
    stock = seen - 1;
    const victims = successes.slice(successes.length - erased);
    successes.push(i);
    return victims;
  }

  /** 락 없이 읽고-계산하고-쓰기. 응답(responded)은 부르는 쪽이 낸다(메모리 mutex는 해제 뒤에 응답). */
  function* readThenWrite(i: number, lostMarker: string): Generator<Cmd, string, number> {
    begin(i);
    yield { wait: RT };
    const seen = stock;
    const overlap = [...readers.entries()].find(([j, v]) => j !== i && v === seen);
    readers.set(i, seen);
    emit(i, 'db_read', {
      marker: 'db_read',
      note: `재고 ${seen} 읽음 (락 없음)${overlap ? ` · ${actors[overlap[0]]}와 같은 값` : ''}`,
      sql: SQL.select,
      sqlLines: [SQL.select, `→ 1 row (stock = ${seen})`],
      rows: 1,
      attrs: { stock: seen, qty: seen },
      codeNote:
        '락 없이 읽은 값이다. 여기서 UPDATE까지가 경합 창이고, 그 사이 다른 커밋이 끼어도 모른다.',
      ...(overlap
        ? {
            cause: true,
            autoStop: true,
            callout: `**${actors[i]}도 재고 ${seen}을 읽었다 — ${actors[overlap[0]]}가 아직 커밋 전** 둘 다 같은 값으로 계산해 같은 상수를 쓴다. 이 순간이 원인이다.`,
          }
        : {}),
    });
    const r0 = now;
    yield { wait: window };
    if (injected) {
      emit(i, 'injected_delay', {
        marker: 'injected_delay',
        note: `경합 창 ${WINDOW_MS}ms 주입 (after-read)`,
        injected: true,
        durMs: WINDOW_MS,
        codeNote:
          '실험용 지연 주입: 읽기 후 쓰기 전. 로컬은 DB 왕복이 짧아 경합 창이 좁아서 넓혀 본다.',
      });
      band(i, 'injected', r0, now, `주입 지연 ${WINDOW_MS}ms`);
    }
    if (seen < 1) {
      yield* commit(i, 'sold_out', 'committed', null);
      return '409 품절';
    }
    const setSql = SQL.set(seen - 1);
    const waited = yield* rowLock(i, {
      marker: 'db_write',
      note: `UPDATE stock = ${seen - 1} · 행 락 대기`,
      sql: setSql,
    });
    if (waited > 0)
      emit(i, 'lock_acquired', {
        marker: 'db_write',
        note: `UPDATE가 행 락을 쥠 (${waited.toFixed(1)}ms 대기 · 커밋까지)`,
        durMs: round2(waited),
        attrs: { lock: 'row', owner: actors[i]! },
      });
    yield { wait: RT };
    emit(i, 'db_write', {
      marker: 'db_write',
      note: `UPDATE stock = ${seen - 1} (앱이 계산한 상수, WHERE id만)`,
      sql: setSql,
      sqlLines: [setSql, '→ 1 row'],
      rows: 1,
      attrs: { stock: seen - 1, seen },
      codeNote:
        '앱이 계산한 상수를 SET 한다. DB의 현재값과 상관없이 덮어쓰므로, 앞 커밋이 끼어 있었다면 그 차감이 사라진다.',
    });
    const victims = applySet(i, seen);
    yield* commit(i, 'success', 'committed', waited > 0 ? 'committed' : null);
    for (const v of victims) {
      emit(v, 'custom:lost_update', {
        marker: lostMarker,
        note: `${actors[i]}가 ${actors[v]}의 차감을 덮어씀 · 원장은 성공 2건, 재고는 1만 줄어듦`,
        attrs: { by: actors[i]!, seen },
        codeNote: `${actors[i]}의 UPDATE가 읽었던 과거 값(${seen})으로 계산한 상수를 썼다. ${actors[v]}의 커밋된 차감이 사라졌다. 응답은 둘 다 성공이다.`,
        codeTone: 'bad',
        callout: `**${actors[i]}가 ${actors[v]}의 차감을 덮어씀** — 잃어버린 갱신 +1. 둘 다 재고 ${seen}을 읽고 ${seen - 1}을 썼다. 원장엔 성공이 둘 다 남았지만 재고는 한 번만 줄었다.`,
      });
      mark(v, 'bad', `잃어버린 갱신 (by ${actors[i]})`);
    }
    return '201 주문 성공';
  }

  function* noLock(i: number): Proc {
    const note = yield* readThenWrite(i, 'db_write');
    emit(i, 'responded', { marker: 'committed', note });
  }

  function* appMemoryLock(i: number): Proc {
    const inst = instOf(i);
    const m = memOf(inst);
    const t0 = now;
    if (m.holder !== null) {
      emit(i, 'lock_wait', {
        marker: 'lock_wait',
        note: `${inst} 메모리 mutex 대기 (${actors[m.holder]} 뒤)`,
        attrs: { lock: 'memory', instance: inst, owner: actors[m.holder]! },
        codeNote:
          '이 프로세스의 Promise 체인 꼬리에 붙는다. 이 대기는 DB가 모른다(pg_locks에 안 보임).',
        callout: `**${actors[i]}가 ${inst}의 메모리 mutex를 기다린다** — 같은 프로세스 안에서는 한 줄로 선다. 다른 인스턴스의 요청은 이 줄을 모른다.`,
      });
    }
    const waited: number = yield { mem: 'acquire', inst };
    if (waited > 0) {
      band(i, 'mem-wait', t0, now, `${inst} 메모리 mutex 대기`);
      maxWait = Math.max(maxWait, waited);
    }
    emit(i, 'lock_acquired', {
      marker: 'lock_acquired',
      note: `${inst} 메모리 mutex 획득${waited > 0 ? ` (${waited.toFixed(1)}ms 대기)` : ''}`,
      ...(waited > 0 ? { durMs: round2(waited) } : {}),
      attrs: { lock: 'memory', instance: inst, owner: actors[i]! },
      codeNote: '앞 사람이 해제해야 내 차례가 온다. 락의 범위는 이 프로세스뿐이다.',
    });
    const note = yield* readThenWrite(i, 'db_write');
    yield { mem: 'release', inst };
    emit(i, 'lock_released', {
      marker: 'lock_released',
      note: `${inst} 메모리 mutex 해제 (커밋 뒤)`,
      attrs: { lock: 'memory', instance: inst, owner: actors[i]! },
    });
    emit(i, 'responded', { marker: 'lock_released', note });
  }

  function* rowLockStrategy(i: number): Proc {
    begin(i);
    yield { wait: RT };
    tx.get(i)!.sql = SQL.setLocal;
    const waited = yield* rowLock(i, {
      marker: 'lock_wait',
      note: 'SELECT … FOR UPDATE · 행 락 대기',
      sql: SQL.forUpdate,
    });
    yield { wait: RT };
    const seen = stock;
    emit(i, 'lock_acquired', {
      marker: 'lock_acquired',
      note: `FOR UPDATE 획득 · 최신 재고 ${seen}${waited > 0 ? ` (${waited.toFixed(1)}ms 대기)` : ''}`,
      sql: SQL.forUpdate,
      sqlLines: [SQL.setLocal, SQL.forUpdate, `→ 1 row (stock = ${seen})`],
      rows: 1,
      ...(waited > 0 ? { durMs: round2(waited) } : {}),
      attrs: { stock: seen, qty: seen, lock: 'row', owner: actors[i]! },
      codeNote:
        'SELECT … FOR UPDATE는 잠금을 기다린 뒤 최신 커밋 버전을 읽어 온다. 커밋까지가 전부 보유 시간이다.',
    });
    if (injected) {
      const r0 = now;
      yield { wait: WINDOW_MS };
      emit(i, 'injected_delay', {
        marker: 'injected_delay',
        note: `경합 창 ${WINDOW_MS}ms 주입 (after-read · 행 락을 쥔 채)`,
        injected: true,
        durMs: WINDOW_MS,
        codeNote:
          '같은 30ms라도 FOR UPDATE 뒤라 행 락 보유 시간이 된다. 뒤 요청은 그만큼 줄을 선다.',
      });
      band(i, 'injected', r0, now, `주입 지연 ${WINDOW_MS}ms (락 보유 중)`);
    } else yield { wait: APP_MS };
    if (seen < 1) {
      yield* commit(i, 'sold_out', 'committed', 'lock_released');
      emit(i, 'responded', { marker: 'committed', note: '409 품절' });
      return;
    }
    yield { wait: RT };
    stock = seen - 1;
    successes.push(i);
    emit(i, 'db_write', {
      marker: 'db_write',
      note: `UPDATE stock = ${seen - 1} (잠근 최신 값으로 계산)`,
      sql: SQL.set(seen - 1),
      sqlLines: [SQL.set(seen - 1), '→ 1 row'],
      rows: 1,
      attrs: { stock: seen - 1 },
      codeNote: '잠근 행의 최신 값으로 판정·계산했다. 다른 트랜잭션은 이 행을 바꿀 수 없다.',
    });
    yield* commit(i, 'success', 'committed', 'lock_released');
    emit(i, 'responded', { marker: 'committed', note: '201 주문 성공' });
  }

  function* conditional(i: number): Proc {
    begin(i);
    const r0 = now;
    yield { wait: injected ? WINDOW_MS : APP_MS };
    if (injected) {
      emit(i, 'injected_delay', {
        marker: 'injected_delay',
        note: `경합 창 ${WINDOW_MS}ms 주입 (UPDATE 앞 · 잠금 쥐기 전)`,
        injected: true,
        durMs: WINDOW_MS,
        codeNote:
          '읽기가 없으므로 주입 지점은 UPDATE 바로 앞이다. 잠금을 쥐기 전이라 지연만 늘고 겹침은 생기지 않는다.',
      });
      band(i, 'injected', r0, now, `주입 지연 ${WINDOW_MS}ms (락 없음)`);
    }
    const waited = yield* rowLock(i, {
      marker: 'db_write',
      note: '조건부 UPDATE · 행 락 대기',
      sql: SQL.cond,
    });
    yield { wait: RT };
    const ok = stock >= 1; // 락을 얻은 뒤 최신 행으로 WHERE 재평가(EvalPlanQual)
    if (ok) {
      stock -= 1;
      successes.push(i);
    }
    // 무대가 줄에서 창구로 옮긴 뒤 쓰기를 보이도록 락 획득을 같은 시각 먼저 낸다.
    emit(i, 'lock_acquired', {
      marker: 'lock_acquired',
      note: `UPDATE가 행 락을 쥠 (커밋까지)${waited > 0 ? ` · ${waited.toFixed(1)}ms 대기` : ''}`,
      ...(waited > 0 ? { durMs: round2(waited) } : {}),
      attrs: { lock: 'row', owner: actors[i]! },
    });
    emit(i, 'db_write', {
      marker: 'db_write',
      note: ok
        ? `UPDATE stock = stock - 1 WHERE stock >= 1 → 1 row (재고 ${stock})`
        : 'WHERE stock >= 1 거짓 → 0 rows (품절)',
      sql: SQL.cond,
      sqlLines: [
        SQL.cond,
        ...(waited > 0 ? ['-- 앞 커밋 뒤 최신 행으로 WHERE 재평가'] : []),
        ok ? `→ 1 row (stock = ${stock})` : '→ 0 rows',
      ],
      rows: ok ? 1 : 0,
      attrs: { stock },
      codeNote: ok
        ? 'SET stock = stock - 1: DB가 최신 값으로 계산하므로 덮어쓰기가 없다. 판정과 차감이 한 문장이다.'
        : '영향 행 수 0 = 조건(재고 충분)이 거짓. 품절로 응답한다.',
      ...(ok ? {} : { codeTone: 'wait' as const }),
    });
    yield* commit(i, ok ? 'success' : 'sold_out', 'committed', 'lock_released');
    emit(i, 'responded', { marker: 'committed', note: ok ? '201 주문 성공' : '409 품절' });
  }

  const body: Record<G02StrategyCode, (i: number) => Proc> = {
    'no-lock': noLock,
    'app-memory-lock': appMemoryLock,
    'row-lock': rowLockStrategy,
    'conditional-update': conditional,
  };

  function* request(i: number): Proc {
    emit(i, 'arrived', {
      marker: 'arrived',
      note: `POST /g02/orders · 상품 ${PRODUCT_ID} × 1 → ${instOf(i)}`,
      attrs: { instance: instOf(i), initialQty: G02_STOCK0 },
    });
    yield* body[strategy](i);
  }

  // ── 스케줄러: (시각, 순번) 순서로 프로세스를 한 걸음씩 ──
  let seq = 0;
  const queue: { t: number; seq: number; p: Proc; v: number }[] = [];
  const schedule = (t: number, p: Proc, v: number) => {
    queue.push({ t, seq: seq++, p, v });
  };
  const procs: Proc[] = [];
  const procOf = (i: number) => procs[i]!;
  G02_ARRIVALS.forEach((t, i) => {
    procs[i] = request(i);
    schedule(t, procs[i]!, 0);
  });
  const step = (p: Proc, v: number) => {
    const r = p.next(v);
    if (r.done) return;
    const c = r.value;
    const i = procs.indexOf(p);
    if ('wait' in c) schedule(now + c.wait, p, 0);
    else if ('row' in c) {
      if (c.row === 'acquire') {
        if (row.holder === null) {
          row.holder = i;
          schedule(now, p, 0);
        } else row.waiters.push({ i, since: now });
      } else {
        row.holder = null;
        const nx = row.waiters.shift();
        if (nx) {
          row.holder = nx.i;
          schedule(now, procOf(nx.i), now - nx.since);
        }
        schedule(now, p, 0);
      }
    } else {
      const m = memOf(c.inst);
      if (c.mem === 'acquire') {
        if (m.holder === null) {
          m.holder = i;
          schedule(now, p, 0);
        } else m.waiters.push({ i, since: now });
      } else {
        m.holder = null;
        const nx = m.waiters.shift();
        if (nx) {
          m.holder = nx.i;
          schedule(now, procOf(nx.i), now - nx.since);
        }
        schedule(now, p, 0);
      }
    }
  };
  while (queue.length) {
    queue.sort((a, b) => a.t - b.t || a.seq - b.seq);
    const q = queue.shift()!;
    now = q.t;
    step(q.p, q.v);
  }

  return { events, ledger, finalStock: stock, bands, marks, maxWaitMs: round2(maxWait) };
}
