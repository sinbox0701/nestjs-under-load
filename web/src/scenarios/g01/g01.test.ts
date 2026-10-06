import { describe, expect, it } from 'vitest';
import type { Recording, RunEvent } from '../../events/types';
import { createPlaybackStore, prepare, serverAt, withCause } from '../../playback';
import { explain } from './codemap';
import { buildG01Recording, type G01Options, type G01StrategyCode } from './index';
import type { MEvent } from './rounds';

const build = (strategy: G01StrategyCode, o: Omit<G01Options, 'strategy'> = {}) =>
  buildG01Recording({ strategy, ...o });
const of = (r: Recording, phase: string) => r.events.filter((e) => e.phase === phase);
const num = (e: RunEvent, k: string) => e.attrs?.[k] as number;

describe('G01 원장 기반 위반 수(시안 재검토 수치)', () => {
  it('덮어쓰기: 2명 4라운드 위반 4, 3명 8 · 잃어버린 수정 이벤트 수 = 원장 판정', () => {
    const r2 = build('naive-overwrite', { people: 2 });
    expect(r2.verdict!.violations).toBe(4);
    expect(of(r2, 'custom:lost_update')).toHaveLength(4);
    expect(prepare(r2).cumulative.at(-1)!.violations).toBe(4);
    expect(r2.summary!.violations).toBe(4);
    const r3 = build('naive-overwrite', { people: 3 });
    expect(r3.verdict!.violations).toBe(8);
    expect(of(r3, 'custom:lost_update')).toHaveLength(8);
    // 응답은 전부 200
    expect(of(r2, 'responded').every((e) => e.note === '200 OK')).toBe(true);
  });

  it('맹목 재시도: 2명이면 라운드마다 위반 1(총 4)', () => {
    const r = build('blind-retry', { people: 2 });
    expect(r.verdict!.violations).toBe(4);
    const lost = of(r, 'custom:lost_update');
    expect(
      lost.every((e) => e.attrs?.blind === true && e.actor === 'B' && e.attrs?.by === 'A'),
    ).toBe(true);
  });

  it('맹목 재시도: 3명이면 C의 재시도는 기억한 버전이 낡아 다시 409로 끝나고 원장에 남지 않는다', () => {
    const r = build('blind-retry', { people: 3 });
    expect(r.verdict!.violations).toBe(4);
    const again = of(r, 'conflict').filter((e) => e.attrs?.again === true);
    expect(again).toHaveLength(4);
    expect(
      again.every((e) => e.actor === 'C' && num(e, 'readVersion') < num(e, 'currentVersion')),
    ).toBe(true);
    expect(r.ledger!.some((x) => x.actor === 'C')).toBe(false);
    expect(
      of(r, 'responded').filter((e) => e.actor === 'C' && e.note?.startsWith('409')),
    ).toHaveLength(4);
  });

  it('버전 감지: 2~4명 모두 위반 0, 짝수 라운드는 동시 PUT → 행 락 대기 → 재평가 0 rows → 409', () => {
    for (const people of [2, 3, 4] as const) {
      const r = build('optimistic-version', { people });
      expect(r.verdict!.violations).toBe(0);
      expect(of(r, 'custom:lost_update')).toHaveLength(0);
      expect(r.verdict!.ok).toBe(true);
    }
    const r = build('optimistic-version');
    const recheck = of(r, 'conflict').filter((e) => e.attrs?.via === 'recheck');
    expect(recheck.map((e) => e.round)).toEqual([1, 3]);
    expect(recheck.every((e) => e.rows === 0)).toBe(true);
    for (const c of recheck) {
      const wait = r.events.find((e) => e.phase === 'lock_wait' && e.round === c.round)!;
      expect(wait.t).toBeLessThan(c.t);
      expect(wait.server!.rowLock).toEqual({ holder: 'B', waiters: ['A'] });
    }
  });

  it('편집 잠금: 인원·편집 시간 모든 조합에서 위반 0', () => {
    for (const people of [2, 3, 4] as const)
      for (const edit of [0, 1, 2, 3])
        expect(build('edit-lease', { people, edit }).verdict!.violations).toBe(0);
  });
});

describe('G01 원인 장면', () => {
  it('같은 버전을 두 번째로 받은 읽기가 원인 멈춤이다(라운드마다 첫 멈춤)', () => {
    const r = build('naive-overwrite');
    const p = prepare(r);
    const causes = p.stops.filter((s) => s.phase === 'db_read');
    expect(causes).toHaveLength(4);
    for (const s of causes) {
      const e = s.events[0]!;
      expect(e.actor).toBe('B');
      expect(e.cause).toBe(true);
      const a = r.events.find(
        (x) => x.round === e.round && x.phase === 'db_read' && x.actor === 'A',
      )!;
      expect(num(a, 'version')).toBe(num(e, 'version'));
      expect(e.callout).toMatch(/같은 버전/);
    }
    expect(withCause(p, false).stops.some((s) => s.phase === 'db_read')).toBe(false);
  });
});

describe('G01 편집 잠금 장면', () => {
  const r = build('edit-lease', { people: 3 });

  it('R3 멈춤 → TTL 회수 → 늦은 저장은 409 lease_lost, currentVersion = 새 보유자 acquire 이후 값', () => {
    const lost = of(r, 'conflict').find((e) => e.attrs?.reason === 'lease_lost')!;
    expect(lost.round).toBe(2);
    const acq = r.events
      .filter((e) => e.phase === 'lock_acquired' && e.round === 2 && e.t < lost.t)
      .at(-1)!;
    expect(acq.attrs?.take).toBe('expired');
    expect(num(lost, 'currentVersion')).toBe(num(acq, 'version'));
    expect(lost.attrs?.owner).toBe(acq.actor);
    expect(num(lost, 'currentFence')).toBe(num(acq, 'fence'));
    expect(num(lost, 'fence')).toBe(num(acq, 'fence') - 1);
    expect(
      r.ledger!.filter((x) => x.actor === 'A' && x.t > acq.t && x.t < lost.t + 10),
    ).toHaveLength(0);
    expect(of(r, 'custom:holder_paused').map((e) => e.round)).toEqual([2]);
  });

  it('R2 이탈: release 없이 떠나고 TTL 만료 뒤 다음 노크가 회수한다(A는 저장하지 않음)', () => {
    const left = of(r, 'custom:holder_left');
    expect(left.map((e) => [e.round, e.actor])).toEqual([[1, 'A']]);
    const exp = of(r, 'lease_expired').find((e) => e.round === 1)!;
    const next = r.events.find((e) => e.phase === 'lock_acquired' && e.round === 1 && e.t > exp.t)!;
    expect(next.attrs?.take).toBe('expired');
    expect(r.events.some((e) => e.round === 1 && e.actor === 'A' && e.phase === 'committed')).toBe(
      false,
    );
  });

  it('acquire·save·release가 각각 version +1, fence는 acquire마다 +1', () => {
    for (const rd of [0, 3]) {
      const evs = r.events.filter(
        (e) => e.round === rd && ['lock_acquired', 'committed', 'lock_released'].includes(e.phase),
      );
      for (let k = 0; k + 2 < evs.length; k += 3) {
        const [a, c, l] = evs.slice(k, k + 3) as [RunEvent, RunEvent, RunEvent];
        expect([a.phase, c.phase, l.phase]).toEqual([
          'lock_acquired',
          'committed',
          'lock_released',
        ]);
        expect(num(c, 'version')).toBe(num(a, 'version') + 1);
        expect(num(l, 'version')).toBe(num(c, 'version') + 1);
      }
      const rinfo = r.rounds![rd]!;
      expect(rinfo.endVersion - rinfo.baseVersion).toBe(9);
    }
    const fences = of(r, 'lock_acquired').map((e) => num(e, 'fence'));
    expect(fences).toEqual(fences.map((_, i) => fences[0]! + i));
  });

  it('423 노크는 서버 큐가 아니다: 같은 사람의 노크가 겹치지 않고(중복 0), 순서 보장이 없다', () => {
    for (const people of [2, 3, 4] as const) {
      const rec = build('edit-lease', { people });
      for (const rd of rec.rounds!) {
        for (const who of rec.meta.actors) {
          const seq = rec.events.filter(
            (e) =>
              e.round === rd.index &&
              e.actor === who &&
              ['retry', 'custom:lease_rejected', 'lock_acquired'].includes(e.phase),
          );
          for (let k = 1; k < seq.length; k++) {
            const prev = seq[k - 1]!;
            const cur = seq[k]!;
            // 다시 노크(retry)는 앞 응답(423) 뒤에만, 423·획득 앞에는 노크가 하나씩
            if (cur.phase === 'retry') expect(prev.phase).toBe('custom:lease_rejected');
            else expect(prev.phase).toBe('retry');
            expect(cur.t).toBeGreaterThanOrEqual(prev.t);
          }
        }
      }
    }
    expect(of(r, 'lock_acquired').some((e) => /먼저 차지/.test(e.note ?? ''))).toBe(true);
  });

  it('첫 423만 자동 멈춤이고, 이탈·멈춤·TTL 만료·lease_lost에서 선다', () => {
    const p = prepare(r);
    const kinds = new Set(p.stops.map((s) => s.phase));
    for (const k of [
      'custom:lease_rejected',
      'custom:holder_left',
      'custom:holder_paused',
      'lease_expired',
      'conflict',
    ])
      expect(kinds.has(k as never)).toBe(true);
    const rej = p.stops.filter((s) => s.phase === 'custom:lease_rejected').flatMap((s) => s.events);
    expect(rej.every((e) => e.attrs?.first === true)).toBe(true);
    expect(of(r, 'custom:lease_rejected').length).toBeGreaterThan(rej.length);
  });
});

describe('G01 재생 연결', () => {
  it('자동 멈춤 시각 = 이벤트 시각(재생 저장소도 그 자리에 선다)', () => {
    for (const s of [
      'naive-overwrite',
      'blind-retry',
      'optimistic-version',
      'edit-lease',
    ] as const) {
      const r = build(s, { people: 3 });
      const p = prepare(r);
      expect(p.stops.length).toBeGreaterThan(0);
      for (const st of p.stops) expect(st.at).toBe(st.events.at(-1)!.t);
      const store = createPlaybackStore(r);
      store.getState().play();
      store.getState().tick(1e12);
      expect(store.getState().P).toBe(p.stops[0]!.at);
      expect(store.getState().callout?.events[0]!.callout).toBeTruthy();
    }
  });

  it('원인 멈춤을 끄면 원인 장면을 건너뛰고, 설명 중이던 원인 callout도 닫힌다', () => {
    const r = build('naive-overwrite');
    const store = createPlaybackStore(r);
    store.getState().play();
    store.getState().tick(1e12);
    expect(store.getState().callout?.phase).toBe('db_read');
    store.getState().toggleCause();
    expect(store.getState().callout).toBeNull();
    store.getState().play();
    store.getState().tick(1e12);
    expect(store.getState().callout?.phase).toBe('custom:lost_update');
  });

  it('타임라인 행: 커밋은 사람별로 따로, 라운드를 넘어 묶지 않는다', () => {
    const store = createPlaybackStore(build('naive-overwrite'));
    const commits = store.getState().rows.filter((x) => x.phase === 'committed');
    expect(commits).toHaveLength(8);
    expect(commits.every((x) => x.events.length === 1)).toBe(true);
  });

  it('서버 속: P에 살아 있는 세션만, 라운드가 바뀌면 그 라운드 상태', () => {
    const r = build('optimistic-version');
    const p = prepare(r);
    const wait = r.events.find((e) => e.phase === 'lock_wait')!;
    const s = serverAt(p, wait.t)!;
    expect(s.rowLock?.holder).toBe('B');
    expect(s.sessions.find((x) => x.actor === 'A')?.state).toBe('lock_wait');
    // 행 락 보유자 B는 UPDATE를 끝내고 커밋 전(문장 사이) = idle in transaction
    expect(s.sessions.find((x) => x.actor === 'B')?.state).toBe('idle_in_transaction');
    const bw = r.events.find((e) => e.phase === 'db_write' && e.actor === 'B' && e.t <= wait.t)!;
    expect(bw.server!.sessions.find((x) => x.actor === 'B')?.state).toBe('active');
    const r2 = r.rounds![2]!;
    expect(serverAt(p, r2.start)!.version).toBe(r2.baseVersion);
  });
});

describe('G01 기록 형태', () => {
  it('결정적: 같은 옵션 = 같은 기록', () => {
    const a = build('edit-lease', { people: 4, shape: 'spike', edit: 2, seed: 7 });
    const b = build('edit-lease', { people: 4, shape: 'spike', edit: 2, seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.events.every((e, i) => i === 0 || a.events[i - 1]!.t <= e.t)).toBe(true);
  });

  it('원장·이력은 저장과 같은 트랜잭션: 커밋마다 원장 1행, 409·rollback은 원장 없음', () => {
    for (const s of [
      'naive-overwrite',
      'blind-retry',
      'optimistic-version',
      'edit-lease',
    ] as const) {
      const r = build(s, { people: 3 });
      const commits = of(r, 'committed');
      expect(r.ledger).toHaveLength(commits.length);
      commits.forEach((c, i) => {
        expect(r.ledger![i]!.t).toBe(c.t);
        expect(r.ledger![i]!.editToken).toBe(c.attrs?.editToken);
        const lines = c.sqlLines!;
        expect(lines.indexOf('commit')).toBeGreaterThan(
          lines.findIndex((x) => x.includes('"document_revision"')),
        );
        expect(lines.findIndex((x) => x.includes('"edit_ledger"'))).toBeGreaterThan(-1);
      });
      for (const c of of(r, 'conflict')) expect(r.ledger!.some((x) => x.t === c.t)).toBe(false);
    }
  });

  it('codeRef는 처리 방식 코드의 마커 줄을 가리키고, 멈춤마다 설명이 있다', () => {
    const r = build('optimistic-version');
    const lines = r.code!.source.split('\n');
    const recheck = of(r, 'conflict').find((e) => e.attrs?.via === 'recheck')!;
    expect(recheck.marker).toBe('409');
    expect(lines[Number(recheck.codeRef!.split(':').pop()) - 1]).toMatch(/ConflictException/);
    expect(recheck.sqlLines).toContain('→ 0 rows');
    expect(r.code!.source).not.toMatch(/⟦/);
    for (const e of r.events)
      if (e.marker) expect(e.codeRef).toMatch(/^packs\/generic\/g01-shared-document\/.+:\d+$/);
    for (const st of prepare(r).stops) expect(st.events[0]!.callout).toBeTruthy();
  });

  it('트랜잭션 띠: 읽기(자동 커밋)와 저장(begin…commit)이 따로, 409는 rollback 띠', () => {
    const r = build('optimistic-version');
    const kinds = new Set(r.txBands!.map((b) => b.kind));
    for (const k of ['read', 'edit', 'tx', 'tx-rollback', 'wait'])
      expect(kinds.has(k as never)).toBe(true);
    expect(r.txBands!.every((b) => b.end >= b.start)).toBe(true);
    const lease = build('edit-lease');
    expect(new Set(lease.txBands!.map((b) => b.kind)).has('autocommit')).toBe(true);
  });

  it('실측 전이라 처리량·p95·실패율을 지어내지 않는다(measured null), 위반·409는 기록에서 센다', () => {
    for (const code of [
      'naive-overwrite',
      'blind-retry',
      'optimistic-version',
      'edit-lease',
    ] as const) {
      const r = build(code, { people: 3, edit: 2 });
      expect(r.summary!.measured).toBeNull();
      expect(r.summary!.violations).toBe(r.verdict!.violations);
      expect(r.summary!.conflicts).toBe(r.events.filter((e) => e.phase === 'conflict').length);
      if (r.verdict!.ok)
        expect(r.summary!.invariantSub).toBe('원장의 성공 수정 토큰 = 최종 이력 (일치)');
      else expect(r.summary!.invariantSub).not.toMatch(/일치/);
      expect(Object.keys(r.verdict!.checks)).toEqual(['lost-update']);
    }
  });

  it('잃어버린 수정 설명은 읽은 시각이 없으면 그 문장을 빼고, 있으면 실제 ms로 쓴다', () => {
    const r = build('naive-overwrite');
    const lost = r.events.find((e) => e.phase === 'custom:lost_update' && e.callout)!;
    expect(lost.callout).toMatch(/\+\d+(\.\d+)?ms에 읽었다/);
    expect(lost.callout).not.toMatch(/\+0ms에 읽었다 — .*\+0ms보다/);
    expect(lost.attrs?.byReadMs).toBeUndefined();
    expect(lost.attrs?.victimSaveMs).toBeUndefined();
  });

  it('시뮬레이션 고지가 붙는다', () => {
    expect(build('naive-overwrite').notice).toMatchObject({
      kind: 'simulated',
      label: '시뮬레이션 기록(실측 아님)',
    });
  });
});

describe('explain: 값 없는 시각은 지어내지 않는다', () => {
  const read: MEvent = { t: 900, a: 1, phase: 'db_read', v: 7, d: '' };
  const lost: MEvent = { t: 2000, a: 0, phase: 'lost', by: 1, d: '' };
  it('첫 읽기 시각이 없으면 "A는 +0ms" 문장을 뺀다', () => {
    expect(explain('naive', [read], undefined)).not.toMatch(/A는 \+/);
    expect(explain('naive', [read], undefined)).toMatch(/B는 \+\d+(\.\d+)?ms에 읽었다\./);
    expect(explain('naive', [read], 300)).toMatch(/A는 \+\d+(\.\d+)?ms, B는/);
  });
  it('덮어쓴 사람 읽기·피해자 저장 시각이 없으면 비교 문장을 뺀다', () => {
    expect(explain('naive', [lost], undefined)).not.toMatch(/에 읽었다/);
    expect(explain('naive', [{ ...lost, byRead: 500, vSave: 1500 }], undefined)).toMatch(
      /B는 \+\d+(\.\d+)?ms에 읽었다 — A가 저장한 \+\d+(\.\d+)?ms보다 먼저/,
    );
  });
});
