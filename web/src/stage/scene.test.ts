import { describe, expect, it } from 'vitest';
import { actorRef, roundAt, roundsOf, stagePhase } from './events';
import { stageSceneAt } from './scene';
import { inputOf, rec } from './testkit';
import type { QueueCounterScene, SharedDocumentScene } from './model';
import { knockSpot, waitSpot } from './sharedDocument';

// 시안(mockup.html) 덮어쓰기 1라운드를 실제 ms(무대 ms ÷ 40)로 옮긴 기록
const naive = rec({ strategy: 'naive-overwrite' }, [
  [0, 'A', 'arrived', { attrs: { req: 'get' } }],
  [8.5, 'B', 'arrived', { attrs: { req: 'get' } }],
  [37.5, 'A', 'db_read', { attrs: { version: 7 } }],
  [42.5, 'A', 'custom:editing'],
  [46, 'B', 'db_read', { attrs: { version: 7 } }],
  [51, 'B', 'custom:editing'],
  [86, 'A', 'arrived', { attrs: { req: 'put' } }],
  [89, 'A', 'db_write', { attrs: { write: 'naive' } }],
  [93.5, 'A', 'committed', { attrs: { version: 8 } }],
  [100, 'A', 'responded'],
  [108.5, 'B', 'arrived', { attrs: { req: 'put' } }],
  [111.5, 'B', 'db_write', { attrs: { write: 'naive' } }],
  [116, 'B', 'committed', { attrs: { version: 9 } }],
  [117, 'A', 'custom:lost_update', { attrs: { by: 'B' } }],
  [122.5, 'B', 'responded'],
]);
const L = ['A', 'B'];
const g01 = (r = naive, P: number) => stageSceneAt(inputOf(r), P, L) as SharedDocumentScene;

describe('이벤트 정규화', () => {
  it('custom: 접두사를 떼고 같은 뜻을 하나로 모은다', () => {
    const e = (phase: string) => ({ id: 'x', t: 0, actor: 'A', phase }) as never;
    expect(stagePhase(e('custom:lost_update'))).toBe('lost');
    expect(stagePhase(e('custom:lease_rejected'))).toBe('lease_rejected');
    expect(stagePhase(e('lease_expired'))).toBe('lease_expired');
    expect(stagePhase(e('custom:something_new'))).toBe('other');
  });

  it('actor 참조는 id·이름표·순번을 모두 받는다', () => {
    const meta = { actors: ['1-1', '2-1'], actorLabels: { '1-1': 'A', '2-1': 'B' } };
    const ev = (by: string | number) =>
      ({ id: 'x', t: 0, actor: '1-1', phase: 'arrived', attrs: { by } }) as never;
    expect(actorRef(ev('2-1'), meta, 'by')).toBe(1);
    expect(actorRef(ev('B'), meta, 'by')).toBe(1);
    expect(actorRef(ev(0), meta, 'by')).toBe(0);
    expect(actorRef(ev('Z'), meta, 'by')).toBeNull();
  });

  it('라운드: RunEvent.round로 나누고, Recording.rounds가 있으면 그 경계와 시작 버전을 쓴다', () => {
    const r = rec({}, [
      [0, 'A', 'arrived', { round: 0 }],
      [5, 'A', 'responded', { round: 0 }],
      [10, 'A', 'arrived', { round: 1 }],
      [12, 'A', 'responded', { round: 1 }],
    ]);
    const rs = roundsOf(inputOf(r));
    expect(rs.map((x) => [x.start, x.end, x.events.length])).toEqual([
      [0, 10, 2],
      [10, r.meta.durationMs, 2],
    ]);
    expect(roundAt(rs, 9.9).index).toBe(0);
    expect(roundAt(rs, 10).index).toBe(1);

    const withRounds = {
      ...r,
      events: r.events.map((e) => {
        const copy = { ...e };
        delete copy.round;
        return copy;
      }),
      rounds: [
        { index: 0, start: 0, end: 8, baseVersion: 7, endVersion: 8 },
        { index: 1, start: 8, end: 20, baseVersion: 8, endVersion: 9 },
      ],
    };
    const rs2 = roundsOf(inputOf(withRounds));
    expect(rs2.map((x) => [x.start, x.baseVersion, x.events.length])).toEqual([
      [0, 7, 2],
      [8, 8, 2],
    ]);
  });
});

describe('shared-document 장면(G01)', () => {
  it('기록 없으면 빈 장면', () => {
    expect(stageSceneAt(null, 0).kind).toBe('empty');
  });

  it('원인 장면: 두 사람이 같은 버전(v7)을 발밑에 들고 있다', () => {
    const s = g01(naive, 46);
    expect(s.actors.map((a) => a.footTag)).toEqual(['v7', 'v7']);
    expect(s.actors.every((a) => a.carry)).toBe(true);
    expect(s.doc.version).toBe(7);
  });

  it('편집 중: 연필 감정 표시, DB 문서는 그대로', () => {
    const s = g01(naive, 60);
    expect(s.actors.map((a) => a.emote)).toEqual(['write', 'write']);
    expect(s.doc.version).toBe(7);
  });

  it('커밋: 사본 내려놓음 + ✓, DB 버전 갱신, 서류 들썩임', () => {
    const s = g01(naive, 93.5);
    expect(s.actors[0]!.carry).toBe(false);
    expect(s.actors[0]!.emote).toBe('check');
    expect(s.doc.version).toBe(8);
    expect(s.doc.lift).toBe(true);
  });

  it('잃어버린 수정: 종이가 날아가고 빨강 팝업', () => {
    const s = g01(naive, 117.5);
    expect(s.papers).toHaveLength(1);
    expect(s.papers[0]!.actor).toBe(0);
    expect(s.pops.map((p) => p.text)).toEqual(['잃어버린 수정 +1']);
    expect(s.pops[0]!.tone).toBe('bad');
    // 종이는 무대 1.6초(실제 40ms) 뒤 사라진다
    expect(g01(naive, 117 + 41).papers).toHaveLength(0);
  });

  it('이동은 이벤트 사이 보간: 같은 P면 언제나 같은 장면(되감기 안전)', () => {
    const a = g01(naive, 20);
    g01(naive, 110);
    const b = g01(naive, 20);
    expect(b).toEqual(a);
    // 도착 직후 걷는 중, 이벤트 없는 구간이 지나도 자리에 멈춘다
    expect(g01(naive, 1).actors[0]!.walking).toBe(true);
    const settled = g01(naive, 37).actors[0]!;
    expect(settled.walking).toBe(false);
    expect([settled.x, settled.y]).toEqual([114, 136]);
  });

  it('응답 뒤 문으로 걸어 나가 사라진다', () => {
    expect(g01(naive, 101).actors[0]!.visible).toBe(true);
    expect(g01(naive, 160).actors[0]!.visible).toBe(false);
  });

  it('행 락 대기: ⧗ + 노란 말풍선(보유자 이름), 409 재평가 0행이면 말풍선이 409로 바뀐다', () => {
    const r = rec({ strategy: 'optimistic-version' }, [
      [0, 'A', 'arrived'],
      [1, 'B', 'arrived'],
      [30, 'A', 'db_read', { attrs: { version: 7 } }],
      [31, 'B', 'db_read', { attrs: { version: 7 } }],
      [80, 'B', 'arrived'],
      [81, 'B', 'db_write', { attrs: { write: 'opt' } }],
      [82, 'A', 'arrived'],
      [83, 'A', 'db_write', { attrs: { write: 'opt' } }],
      [84, 'A', 'lock_wait', { attrs: { owner: 'B' } }],
      [95, 'B', 'committed', { attrs: { version: 8 } }],
      [96, 'A', 'conflict', { rows: 0, attrs: { via: 'recheck', currentVersion: 8 } }],
    ]);
    const w = g01(r, 90);
    expect(w.rowLock).toBe(1);
    expect(w.actors[0]!.emote).toBe('wait');
    expect(w.bubbles.map((b) => [b.text, b.tone])).toEqual([
      ['B 커밋 기다리는 중 (행 락)', 'wait'],
    ]);
    const c = g01(r, 96.5);
    expect(c.rowLock).toBeNull();
    expect(c.bubbles.map((b) => b.text)).toEqual(['409 · 먼저 고쳐졌어요 (v8)']);
    expect(c.actors[0]!.knock).toBeGreaterThan(0);
  });

  it('편집 잠금: 423은 노크 자리에서 튕겨 문 밖으로, 멈춘 보유자는 회색, 만료는 자물쇠 회색', () => {
    const r = rec({ strategy: 'edit-lease' }, [
      [0, 'A', 'arrived', { attrs: { req: 'acq' } }],
      [8, 'B', 'arrived', { attrs: { req: 'acq' } }],
      [37.5, 'A', 'lock_acquired', { attrs: { version: 8, fence: 12 } }],
      [42.5, 'B', 'custom:lease_rejected', { attrs: { owner: 'A' } }],
      [70, 'A', 'custom:holder_paused', { attrs: { fence: 12 } }],
      [143, 'A', 'lease_expired'],
    ]);
    const s1 = g01(r, 20);
    expect(s1.lease).toBe(true);
    expect(s1.actors[1]!.walking).toBe(true);
    const ks = knockSpot(1);
    const s2 = g01(r, 42.5);
    expect([s2.actors[1]!.x, s2.actors[1]!.y]).toEqual([ks.x, ks.y]);
    expect(s2.doc.lock).toBe(0);
    expect(s2.doc.version).toBe(8);
    expect(s2.bubbles.map((b) => b.text)).toContain('423 · 잠겨 있음');
    const ws = waitSpot(1);
    const s3 = g01(r, 69);
    expect([s3.actors[1]!.x, s3.actors[1]!.y]).toEqual([ws.x, ws.y]);
    const s4 = g01(r, 100);
    expect(s4.actors[0]!.ghost).toBe(true);
    expect(s4.actors[0]!.emote).toBe('stop');
    const s5 = g01(r, 144);
    expect(s5.doc.expired).toBe(true);
    expect(s5.doc.lock).toBe(0);
  });

  it('대표 4명까지만 그리고 나머지는 카운터', () => {
    const r = rec({ actors: ['A', 'B', 'C', 'D', 'E'], totalActors: 20 }, [[0, 'E', 'arrived']]);
    const s = g01(r, 1);
    expect(s.actors).toHaveLength(4);
    expect(s.others).toBe(16);
  });

  it('매핑 없는 phase는 말풍선 글자로만', () => {
    const r = rec({}, [
      [0, 'A', 'arrived'],
      [1, 'A', 'cache_miss'],
      [2, 'A', 'custom:mystery'],
    ]);
    const s = g01(r, 2.5);
    expect(s.bubbles.map((b) => b.text)).toEqual(['custom:mystery']);
  });
});

describe('queue-at-counter 장면(G02)', () => {
  const g02 = (r: ReturnType<typeof rec>, P: number) =>
    stageSceneAt(inputOf(r), P, ['A', 'B', 'C', 'D']) as QueueCounterScene;

  it('락 없음: 둘 다 같은 재고를 읽고(발밑 "읽음 3") 각자 빼서 쓴다 → 초과 판매 −1', () => {
    const r = rec({ sceneType: 'queue-at-counter', strategy: 'no-lock' }, [
      [0, 'A', 'arrived', { attrs: { initialQty: 3 } }],
      [0.4, 'B', 'arrived'],
      [5, 'A', 'db_read', { attrs: { qty: 3 } }],
      [5.4, 'B', 'db_read', { attrs: { qty: 3 } }],
      [7, 'A', 'committed', { attrs: { qty: 2 } }],
      [7.4, 'B', 'committed', { attrs: { qty: 2 } }],
      [7.5, 'A', 'custom:oversold', { attrs: { by: 'B' } }],
    ]);
    const read = g02(r, 6);
    expect(read.windows).toHaveLength(1);
    expect(read.actors.slice(0, 2).map((a) => a.footTag)).toEqual(['읽음 3', '읽음 3']);
    expect(read.stock.qty).toBe(3);
    const after = g02(r, 8);
    expect(after.stock.qty).toBe(2);
    expect(after.stock.oversold).toBe(true);
    expect(after.pops.map((p) => [p.text, p.tone])).toEqual([['−1 초과 판매', 'bad']]);
    // 락이 없으면 창구 앞에 나란히(같은 자리에 겹치지 않음)
    const xs = after.actors.slice(0, 2).map((a) => a.x);
    expect(new Set(xs).size).toBe(2);
  });

  it('음수 재고로 커밋되면 −1 경고(명시적 oversold 이벤트가 없을 때)', () => {
    const r = rec({ sceneType: 'queue-at-counter', strategy: 'no-lock' }, [
      [0, 'A', 'arrived', { attrs: { initialQty: 0 } }],
      [1, 'A', 'committed', { attrs: { qty: -1 } }],
    ]);
    const s = g02(r, 1.5);
    expect(s.stock.qty).toBe(-1);
    expect(s.pops).toHaveLength(1);
  });

  it('행 잠금: 상자에 자물쇠(보유자), 나머지는 창구 앞 줄 → 보유자가 떠나면 한 칸씩 앞으로', () => {
    const r = rec(
      { sceneType: 'queue-at-counter', strategy: 'row-lock', actors: ['A', 'B', 'C'] },
      [
        [0, 'A', 'arrived', { attrs: { initialQty: 3 } }],
        [0.4, 'B', 'arrived'],
        [0.8, 'C', 'arrived'],
        [2, 'A', 'lock_acquired', { attrs: { lock: 'row' } }],
        [2.5, 'B', 'lock_wait', { attrs: { owner: 'A' } }],
        [3, 'C', 'lock_wait', { attrs: { owner: 'A' } }],
        [10, 'A', 'committed', { attrs: { qty: 2 } }],
        [10, 'A', 'lock_released'],
        [10.1, 'B', 'lock_acquired', { attrs: { lock: 'row' } }],
      ],
    );
    const s = g02(r, 9);
    expect(s.stock.lockHolder).toBe(0);
    expect(s.queued).toBe(2);
    expect(s.bubbles.map((b) => [b.actor, b.text])).toEqual([[1, '2명 대기 · A 처리 중 (행 락)']]);
    const t = g02(r, 45);
    expect(t.stock.lockHolder).toBe(1);
    expect(t.queued).toBe(1);
    // C는 줄 맨 앞(창구 옆)으로 옮겨 섰다
    expect(t.actors[2]!.x).toBe(128 - 34);
  });

  it('메모리 락 · 서버 2대: 서버별 창구 2개, 창구마다 자기 자물쇠, 상자는 하나', () => {
    const r = rec(
      {
        sceneType: 'queue-at-counter',
        strategy: 'app-memory-lock',
        actors: ['A', 'B'],
        actorInstances: { A: 'app-1', B: 'app-2' },
      },
      [
        [0, 'A', 'arrived', { attrs: { initialQty: 1 } }],
        [0.4, 'B', 'arrived'],
        [1, 'A', 'lock_acquired', { attrs: { lock: 'memory' } }],
        [1.2, 'B', 'lock_acquired', { attrs: { lock: 'memory' } }],
      ],
    );
    const s = g02(r, 20);
    expect(s.perServer).toBe(true);
    expect(s.windows.map((w) => [w.label, w.lockHolder])).toEqual([
      ['서버 1 창구', 0],
      ['서버 2 창구', 1],
    ]);
    expect(s.stock.lockHolder).toBeNull();
    expect(s.actors[0]!.x).toBeLessThan(128);
    expect(s.actors[1]!.x).toBeGreaterThan(128);
  });

  it('메모리 락 · 서버 1대: 창구 하나에 자물쇠, 나머지는 그 창구 줄', () => {
    const r = rec({ sceneType: 'queue-at-counter', strategy: 'app-memory-lock' }, [
      [0, 'A', 'arrived'],
      [0.4, 'B', 'arrived'],
      [1, 'A', 'lock_acquired'],
      [1.2, 'B', 'lock_wait'],
    ]);
    const s = g02(r, 5);
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0]!.lockHolder).toBe(0);
    expect(s.bubbles[0]!.text).toBe('A 다음 차례 (메모리 락)');
  });

  it('품절: 0행 → "품절 · 0행" 말풍선', () => {
    const r = rec({ sceneType: 'queue-at-counter', strategy: 'conditional-update' }, [
      [0, 'A', 'arrived', { attrs: { initialQty: 0 } }],
      [1, 'A', 'conflict', { rows: 0, attrs: { reason: 'sold_out' } }],
    ]);
    expect(g02(r, 1.5).bubbles.map((b) => b.text)).toEqual(['품절 · 0행']);
  });
});
