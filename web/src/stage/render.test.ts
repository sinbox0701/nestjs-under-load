import { describe, expect, it } from 'vitest';
import type { AutoStop } from '../playback/stops';
import { calloutTarget, explainStop, useSheetFor } from './callout';
import { actorOps, backdropOps, sceneOps, type DrawOp } from './drawList';
import { buildLabels, footTagDrops, FOOT_TAG_DROP } from './labels';
import type { ActorView, SharedDocumentScene } from './model';
import { STAGE_H, STAGE_W } from './model';
import { FOOT_H, TXSUM_H, stageScale } from './scale';
import { stageSceneAt } from './scene';
import { inputOf, rec } from './testkit';
import { bandsFor, txSummary } from './txsum';
import { roundsOf } from './events';

const actor = (over: Partial<ActorView> = {}): ActorView => ({
  index: 0,
  id: 'A',
  look: 'staff',
  visible: true,
  x: 114,
  y: 136,
  walking: false,
  step: 0,
  flip: false,
  knock: 0,
  knockDir: -1,
  lunge: 0,
  carry: false,
  footTag: null,
  emote: null,
  ghost: false,
  ...over,
});

const four = rec({ actors: ['A', 'B', 'C', 'D'] }, [
  [0, 'A', 'arrived'],
  [0, 'B', 'arrived'],
  [0, 'C', 'arrived'],
  [0, 'D', 'arrived'],
  [50, 'A', 'db_read', { attrs: { version: 10 } }],
  [50, 'B', 'db_read', { attrs: { version: 10 } }],
  [50, 'C', 'db_read', { attrs: { version: 10 } }],
  [50, 'D', 'db_read', { attrs: { version: 10 } }],
]);

describe('그릴 목록(drawList)', () => {
  it('직원 12×18: 그림자 + 몸 14줄 + 다리 4줄, 좌표는 발 기준 정수', () => {
    const ops = actorOps(actor());
    const body = ops.find((o) => o.k === 'bmp' && o.id === 'staff') as Extract<
      DrawOp,
      { k: 'bmp' }
    >;
    const legs = ops.find((o) => o.k === 'bmp' && o.id.startsWith('legs')) as Extract<
      DrawOp,
      { k: 'bmp' }
    >;
    expect(body.rows).toHaveLength(14);
    expect(body.rows.every((r) => r.length === 12)).toBe(true);
    expect([body.x, body.y]).toEqual([108, 118]);
    expect(legs.y).toBe(132);
    expect(ops[0]).toMatchObject({ k: 'rect', w: 8, h: 2, c: 'm' });
  });

  it('보이지 않는 actor는 그리지 않는다', () => {
    expect(actorOps(actor({ visible: false }))).toEqual([]);
  });

  it('감정 표시는 12×12 말풍선 안 8×8 아이콘, 대기는 노랑 바탕', () => {
    const ops = actorOps(actor({ emote: 'wait' }));
    expect(ops.some((o) => o.k === 'rect' && o.w === 10 && o.h === 10 && o.c === 'y')).toBe(true);
    const ico = ops.find((o) => o.k === 'bmp' && o.id === 'icon-wait') as Extract<
      DrawOp,
      { k: 'bmp' }
    >;
    expect(ico.rows).toHaveLength(8);
  });

  it('멈춘 보유자는 회색 실루엣(색 치환), 튕김은 10px 안쪽', () => {
    const ghost = actorOps(actor({ ghost: true }));
    expect(ghost.find((o) => o.k === 'bmp' && o.id === 'staff')).toMatchObject({ map: { S: 'm' } });
    const knocked = actorOps(actor({ knock: 0.5, knockDir: 1 }));
    const body = knocked.find((o) => o.k === 'bmp' && o.id === 'staff')!;
    expect(body.x - 108).toBe(10);
  });

  it('사람은 y 오름차순으로 그린다(깊이), 모든 좌표는 정수, 반투명은 날아가는 종이만', () => {
    const naive = rec({}, [
      [0, 'A', 'arrived'],
      [5, 'B', 'arrived'],
      [40, 'A', 'db_read', { attrs: { version: 7 } }],
      [60, 'A', 'committed', { attrs: { version: 8 } }],
      [61, 'B', 'custom:lost_update', { attrs: { by: 'A' } }],
    ]);
    const s = stageSceneAt(inputOf(naive), 70);
    const ops = sceneOps(s);
    for (const o of ops) {
      expect(Number.isInteger(o.x)).toBe(true);
      expect(Number.isInteger(o.y)).toBe(true);
      if (o.alpha !== undefined && o.alpha < 1) expect(o.tag).toMatch(/^paper:/);
    }
    expect(ops.some((o) => o.tag === 'paper:1')).toBe(true);
    const order = ops
      .filter((o) => o.k === 'bmp' && (o.id === 'staff' || o.id === 'customer'))
      .map((o) => o.y);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('편집 잠금 만료: 회색 자물쇠 + 빨간 사선 7칸', () => {
    const r = rec({ strategy: 'edit-lease' }, [
      [0, 'A', 'lock_acquired', { attrs: { version: 8 } }],
      [10, 'A', 'lease_expired'],
    ]);
    const ops = sceneOps(stageSceneAt(inputOf(r), 11));
    const lock = ops.filter((o) => o.tag === 'lease-lock');
    expect(lock.find((o) => o.k === 'bmp')).toMatchObject({ map: { k: 's', m: 'h' } });
    expect(lock.filter((o) => o.k === 'rect' && o.c === 'r')).toHaveLength(7);
  });

  it('G02: 재고 상자 + 행 잠금 자물쇠(보유자 색 띠), 초과 판매면 상자 외곽선 빨강', () => {
    const r = rec({ sceneType: 'queue-at-counter', strategy: 'row-lock' }, [
      [0, 'A', 'arrived', { attrs: { initialQty: 1 } }],
      [1, 'A', 'lock_acquired'],
      [2, 'A', 'committed', { attrs: { qty: -1 } }],
    ]);
    const ops = sceneOps(stageSceneAt(inputOf(r), 2.5));
    expect(ops.find((o) => o.tag === 'crate')).toMatchObject({ k: 'bmp', map: { k: 'r' } });
    expect(ops.filter((o) => o.tag === 'row-lock' && o.k === 'bmp')).toHaveLength(1);
    expect(ops.some((o) => o.tag === 'row-lock' && o.k === 'rect' && o.c === 's')).toBe(true);
  });

  it('배경은 무대 256×192 안에만 그린다', () => {
    for (const spec of [
      { kind: 'shared-document' as const, lease: true },
      { kind: 'queue-at-counter' as const, perServer: true },
    ]) {
      for (const o of backdropOps(spec)) {
        if (o.k !== 'rect') continue;
        expect(o.x).toBeGreaterThanOrEqual(0);
        expect(o.y).toBeGreaterThanOrEqual(0);
        expect(o.x + o.w).toBeLessThanOrEqual(STAGE_W);
        expect(o.y + o.h).toBeLessThanOrEqual(STAGE_H);
      }
    }
  });
});

describe('글자 레이어(labels)', () => {
  it('발밑 버전 표지: 화면 간격이 30px보다 좁으면 한 사람 건너 한 줄 내린다', () => {
    const xs = [100, 119, 138, 157].map((x, i) => ({ key: `k${i}`, x }));
    expect([...footTagDrops(xs, 1)]).toEqual(['k1', 'k3']);
    expect([...footTagDrops(xs, 1.5)]).toEqual(['k1', 'k3']);
    expect([...footTagDrops(xs, 2)]).toEqual([]);
  });

  it('375px(×1)에서 4명의 버전 표지가 서로·캐릭터와 겹치지 않는다', () => {
    const s = stageSceneAt(inputOf(four), 60) as SharedDocumentScene;
    const K = 1; // 375px 휴대폰: floor((375-32-4) / 256) = 1
    const tags = buildLabels(s, K, ['A', 'B', 'C', 'D']).filter((l) => l.kind === 'vtag');
    expect(tags.map((t) => t.text)).toEqual(['v10', 'v10', 'v10', 'v10']);
    // Galmuri9 10px: 글자 약 5px + 좌우 3px 여백 → "v10" ≈ 21px, 높이 12px
    const box = (t: (typeof tags)[number]) => {
      const w = t.text.length * 5 + 6;
      return { l: t.x * K - w / 2, r: t.x * K + w / 2, top: t.y * K, bottom: t.y * K + 12 };
    };
    for (let i = 0; i < tags.length; i++)
      for (let j = i + 1; j < tags.length; j++) {
        const a = box(tags[i]!);
        const b = box(tags[j]!);
        const overlap = a.l < b.r && b.l < a.r && a.top < b.bottom && b.top < a.bottom;
        expect(overlap).toBe(false);
      }
    // 발밑(몸 아래)에 있고, 내려도 무대 안
    for (const t of tags) {
      const a = s.actors.find((x) => Math.abs(x.x - t.x) < 1)!;
      expect(t.y).toBeGreaterThanOrEqual(a.y + 2);
      expect(t.y + 12).toBeLessThanOrEqual(STAGE_H);
    }
    expect(tags.filter((t) => t.y === s.actors[0]!.y + 2 + FOOT_TAG_DROP)).toHaveLength(2);
  });

  it('DB 문서 표지는 버전 + 잠금 보유자, 만료면 표시', () => {
    const r = rec({ strategy: 'edit-lease' }, [
      [0, 'A', 'lock_acquired', { attrs: { version: 8 } }],
      [10, 'A', 'lease_expired'],
    ]);
    const doc = buildLabels(stageSceneAt(inputOf(r), 11), 2, ['A', 'B']).find(
      (l) => l.kind === 'doc',
    )!;
    expect(doc).toMatchObject({ text: 'DB v8', lock: 'A', expired: true });
  });

  it('G02: 재고 숫자 표지(초과 판매면 빨강), 창구 이름', () => {
    const r = rec({ sceneType: 'queue-at-counter', strategy: 'no-lock' }, [
      [0, 'A', 'arrived', { attrs: { initialQty: 1 } }],
      [1, 'A', 'committed', { attrs: { qty: 0 } }],
      [2, 'B', 'committed', { attrs: { qty: -1 } }],
    ]);
    const ls = buildLabels(stageSceneAt(inputOf(r), 1.5), 2, ['A', 'B']);
    expect(ls.find((l) => l.kind === 'stock')).toMatchObject({ text: '재고 0', tone: 'neutral' });
    const bad = buildLabels(stageSceneAt(inputOf(r), 2.5), 2, ['A', 'B']);
    expect(bad.find((l) => l.kind === 'stock')).toMatchObject({ text: '재고 -1', tone: 'bad' });
    expect(bad.find((l) => l.kind === 'window')?.text).toBe('창구');
  });

  it('prefers-reduced-motion: 팝업이 떠오르지 않고 처음 자리에 있다', () => {
    const r = rec({}, [[0, 'A', 'custom:lost_update', { attrs: { by: 'B' } }]]);
    const s = stageSceneAt(inputOf(r), 20);
    const moving = buildLabels(s, 2, ['A', 'B']).find((l) => l.kind === 'pop')!;
    const still = buildLabels(s, 2, ['A', 'B'], { reducedMotion: true }).find(
      (l) => l.kind === 'pop',
    )!;
    expect(moving.y).toBeLessThan(66);
    expect(still.y).toBe(66);
  });
});

describe('정수 배율(scale)', () => {
  it('폭만: n = floor(w × DPR / 256), K = n / DPR, 최대 4×DPR', () => {
    expect(stageScale({ availWidth: 835, devicePixelRatio: 1 })).toEqual({ n: 3, K: 3 });
    expect(stageScale({ availWidth: 343, devicePixelRatio: 1 })).toEqual({ n: 1, K: 1 });
    expect(stageScale({ availWidth: 343, devicePixelRatio: 3 })).toEqual({ n: 4, K: 4 / 3 });
    expect(stageScale({ availWidth: 5000, devicePixelRatio: 1 })).toEqual({ n: 4, K: 4 });
    expect(stageScale({ availWidth: 100, devicePixelRatio: 1 })).toEqual({ n: 1, K: 1 });
  });

  it('넓은 화면은 높이로도 제한: 하단 줄 30 + 재생 바 + 띠 요약 58을 늘 미리 비운다', () => {
    const h = (vh: number) => ({ viewportHeight: vh, stageTop: 120, transportHeight: 110 });
    // 900 − 120 − 30 − 110 − 58 − 4 = 578 → floor(578/192) = 3
    expect(stageScale({ availWidth: 835, devicePixelRatio: 1, height: h(900) }).n).toBe(3);
    // 790 → 468 → 2
    expect(stageScale({ availWidth: 835, devicePixelRatio: 1, height: h(790) }).n).toBe(2);
    // DPR 2: 기기 픽셀 4배 → K = 2
    expect(stageScale({ availWidth: 835, devicePixelRatio: 2, height: h(790) })).toEqual({
      n: 4,
      K: 2,
    });
    expect(FOOT_H + TXSUM_H).toBe(88);
  });

  it('높이가 아주 모자라도 기기 픽셀 1배 아래로 내려가지 않는다(DPR 1.5도 정수)', () => {
    const tiny = { viewportHeight: 300, stageTop: 200, transportHeight: 110 };
    expect(stageScale({ availWidth: 835, devicePixelRatio: 1, height: tiny }).n).toBe(1);
    const s = stageScale({ availWidth: 835, devicePixelRatio: 1.5, height: tiny });
    expect(Number.isInteger(s.n)).toBe(true);
    expect(s.n).toBe(1);
  });

  it('시트 순환 버그 없음: 배율이 시트 여부와 무관해서 창을 줄였다 늘리면 원래 배율로 돌아온다', () => {
    const at = (vh: number) =>
      stageScale({
        availWidth: 835,
        devicePixelRatio: 1,
        height: { viewportHeight: vh, stageTop: 120, transportHeight: 110 },
      });
    const before = at(790);
    expect(useSheetFor(1440, before.K)).toBe(false);
    const shrunk = at(520); // ×1 → 시트가 뜬다
    expect(shrunk.K).toBe(1);
    expect(useSheetFor(1440, shrunk.K)).toBe(true);
    // 시트가 떠 있어도 입력에 시트가 없으므로 높이를 되돌리면 ×2로 돌아온다
    expect(at(790)).toEqual(before);
  });
});

describe('자동 멈춤 설명·조준 틀·트랜잭션 띠 요약', () => {
  const naive = rec({ strategy: 'naive-overwrite' }, [
    [0, 'A', 'arrived'],
    [8.5, 'B', 'arrived'],
    [37.5, 'A', 'db_read', { attrs: { version: 7 } }],
    [42.5, 'A', 'custom:editing'],
    [46, 'B', 'db_read', { attrs: { version: 7 } }],
    [51, 'B', 'custom:editing'],
    [86, 'A', 'arrived'],
    [89, 'A', 'db_write', { attrs: { write: 'naive' } }],
    [93.5, 'A', 'committed', { attrs: { version: 8 } }],
    [108.5, 'B', 'arrived'],
    [111.5, 'B', 'db_write', { attrs: { write: 'naive' } }],
    [116, 'B', 'committed', { attrs: { version: 9 } }],
    [117, 'A', 'custom:lost_update', { attrs: { by: 'B' } }],
  ]);
  const input = inputOf(naive);
  const lost = input.events.find((e) => e.phase === 'custom:lost_update')!;
  const stop: AutoStop = { phase: lost.phase, at: 117, first: 117, events: [lost] };

  it('잃어버린 수정: 시안과 같은 문장, 읽은·저장 시각은 같은 라운드 이벤트에서 찾는다', () => {
    const c = explainStop(input, stop, ['A', 'B']);
    expect(c.title).toBe('B가 A의 수정을 덮어씀');
    expect(c.body).toContain('B는 +46.0ms에 읽었다 — A가 저장한 +93.5ms보다 먼저');
    expect(c.tone).toBe('bad');
  });

  it('원인 장면(같은 버전 두 번째 수신)', () => {
    const read = input.events.find((e) => e.actor === 'B' && e.phase === 'db_read')!;
    const c = explainStop(input, { phase: 'db_read', at: 46, first: 46, events: [read] }, [
      'A',
      'B',
    ]);
    expect(c.title).toBe('B도 같은 버전(v7)을 받았다 — 아직 아무도 저장 전');
    expect(c.body).toContain('A는 +37.5ms, B는 +46.0ms에 읽었다');
  });

  it('기록이 실은 설명(RunEvent.callout)이 있으면 그것을 쓴다', () => {
    const withCallout = { ...lost, callout: '**기록 설명** 본문' };
    const c = explainStop(input, { ...stop, events: [withCallout] }, ['A', 'B']);
    expect(c.rich).toBe('**기록 설명** 본문');
  });

  it('조준 틀: 잃어버린 수정은 책상 위 문서, 그 밖은 그 사람 머리 근처', () => {
    const s = stageSceneAt(input, 117);
    expect(calloutTarget(s, stop, input.meta.actors)).toEqual({ x: 128, y: 86 });
    const read = input.events.find((e) => e.actor === 'B' && e.phase === 'db_read')!;
    const s2 = stageSceneAt(input, 46);
    const t = calloutTarget(
      s2,
      { phase: 'db_read', at: 46, first: 46, events: [read] },
      input.meta.actors,
    );
    expect(t).toEqual({ x: s2.kind === 'shared-document' ? s2.actors[1]!.x : 0, y: 126 });
  });

  it('760 미만이거나 배율 < 2이면 시트', () => {
    expect(useSheetFor(375, 1)).toBe(true);
    expect(useSheetFor(900, 2)).toBe(false);
    expect(useSheetFor(1440, 1.5)).toBe(true);
  });

  it('트랜잭션 띠: 읽기(자동 커밋) → 편집(사람 시간) → begin…commit', () => {
    const rd = roundsOf(input)[0]!;
    const bands = bandsFor(input, rd, 0);
    expect(bands.filter((b) => b.kind === 'band').map((b) => b.kind === 'band' && b.cls)).toEqual([
      'rd',
      'ed',
      'tx',
    ]);
    const sum = txSummary(input, stop, 117, ['A', 'B'])!;
    expect(sum.whoLabel).toBe('A');
    expect(sum.words).toEqual(['읽기(자동 커밋)', '편집(사람 시간)', 'begin…commit']);
    // 멈춘 사람(A) + 관련된 사람(덮어쓴 B), 멈춘 사람 줄 표시
    expect(sum.lanes.map((l) => [l.label, l.isWho])).toEqual([
      ['A', true],
      ['B', false],
    ]);
    for (const l of sum.lanes)
      for (const it of l.items) {
        expect(it.left).toBeGreaterThanOrEqual(0);
        expect(it.left).toBeLessThanOrEqual(100);
      }
  });

  it('기록이 실은 띠(txBands)가 있으면 그것을 쓴다(타임라인과 같은 데이터)', () => {
    const withBands = inputOf({
      ...naive,
      txBands: [{ actor: 'A', kind: 'read', start: 37, end: 39, tip: '읽기' }],
      txMarks: [{ actor: 'A', kind: 'bad', t: 117, tip: '잃어버린 수정' }],
    });
    const sum = txSummary(withBands, stop, 117, ['A', 'B'])!;
    const a = sum.lanes.find((l) => l.isWho)!;
    expect(a.items.map((i) => i.kind)).toEqual(['band', 'mark']);
    expect(sum.words).toEqual(['읽기(자동 커밋)']);
  });
});
