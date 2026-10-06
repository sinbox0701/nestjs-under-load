import { labelOf } from './events';
import { STAGE_W, type LabelTone, type StageScene } from './model';
import { knockOffset } from './drawList';
import { DOC_POS } from './sharedDocument';
import { COUNTER_Y } from './queueCounter';
import type { IconName } from './sprites';

/**
 * 무대 위 HTML 글자 레이어(이름표·버전 표지·말풍선·팝업). 글자는 캔버스에 그리지 않는다(§3.2).
 * 위치는 논리 좌표이고, 화면에서는 `× K`로 옮긴다.
 */
export type OverlayKind =
  'tag' | 'vtag' | 'doc' | 'stock' | 'zone' | 'window' | 'bubble' | 'pop' | 'crowd';

export type Anchor = 'above' | 'below' | 'center' | 'left' | 'right';

export interface OverlayLabel {
  key: string;
  kind: OverlayKind;
  text: string;
  x: number;
  y: number;
  anchor: Anchor;
  /** 이름표 색(actor 순번). */
  actor?: number;
  tone?: LabelTone;
  icon?: IconName;
  opacity?: number;
  /** 문서·상자 표지의 자물쇠 보유자. */
  lock?: string;
  expired?: boolean;
}

/** 버전 표지끼리 화면에서 이만큼(CSS px)보다 가까우면 한 사람 건너 한 줄 내린다(§4.5). */
export const FOOT_TAG_MIN_GAP = 30;
/**
 * 내리는 거리(논리 px). 시안은 11(한 줄)이지만 표지 높이가 12px(10px/12px)라 세 자리 버전(v10…)에서
 * ×1일 때 모서리가 1px 겹쳐서 12로 둔다.
 */
export const FOOT_TAG_DROP = 12;

/**
 * 발밑 표지가 이웃과 겹치지 않게 내릴 줄을 정한다. 왼쪽부터 보며, 바로 앞 표지가 아직
 * 안 내려갔고 화면 간격이 FOOT_TAG_MIN_GAP보다 좁으면 이번 것을 내린다(번갈아 내림).
 */
export function footTagDrops(xs: readonly { key: string; x: number }[], K: number): Set<string> {
  const sorted = [...xs].sort((a, b) => a.x - b.x);
  const dropped = new Set<string>();
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if ((cur.x - prev.x) * K < FOOT_TAG_MIN_GAP && !dropped.has(prev.key)) dropped.add(cur.key);
  }
  return dropped;
}

export interface LabelOptions {
  /** prefers-reduced-motion: 팝업을 떠오르게 하지 않고 처음 자리에 둔다. */
  reducedMotion?: boolean;
}

export function buildLabels(
  scene: StageScene,
  K: number,
  labels: readonly string[],
  opts: LabelOptions = {},
): OverlayLabel[] {
  if (scene.kind === 'empty') return [];
  const out: OverlayLabel[] = [];
  const L = (i: number | null) => labelOf(labels, i);

  // 이름표(감정 표시가 있으면 그 위로)
  for (const a of scene.actors) {
    if (!a.visible || a.x <= 4 || a.x >= STAGE_W - 4) continue;
    out.push({
      key: `tag${a.index}`,
      kind: 'tag',
      text: L(a.index),
      x: a.x + knockOffset(a),
      y: a.emote ? a.y - 34 : a.y - 20,
      anchor: 'above',
      actor: a.index,
    });
  }

  // 발밑 표지(받은 버전 · 읽은 재고) — 몸·사본과 겹치지 않게 발밑, 좁으면 번갈아 한 줄 내림
  const feet = scene.actors
    .filter((a) => a.visible && a.footTag)
    .map((a) => ({ key: `ft${a.index}`, x: a.x + knockOffset(a), a }));
  const drops = footTagDrops(feet, K);
  for (const f of feet) {
    out.push({
      key: f.key,
      kind: 'vtag',
      text: f.a.footTag!,
      x: f.x,
      y: f.a.y + 2 + (drops.has(f.key) ? FOOT_TAG_DROP : 0),
      anchor: 'below',
      actor: f.a.index,
    });
  }

  if (scene.kind === 'shared-document') {
    const d = scene.doc;
    out.push({
      key: 'doc',
      kind: 'doc',
      text: `DB v${d.version ?? '?'}`,
      x: DOC_POS.x + 7,
      y: DOC_POS.y - 8,
      anchor: 'above',
      ...(d.lock !== null ? { lock: L(d.lock), expired: d.expired } : {}),
    });
    if (scene.lease)
      out.push({
        key: 'zone',
        kind: 'zone',
        text: '문 밖 · 각자 다시 노크 (줄 아님)',
        x: 3,
        y: 176,
        anchor: 'left',
      });
  } else {
    const st = scene.stock;
    out.push({
      key: 'stock',
      kind: 'stock',
      text: `재고 ${st.qty ?? '?'}`,
      x: st.cx,
      y: st.top - 6,
      anchor: 'above',
      tone: st.oversold ? 'bad' : 'neutral',
      ...(st.lockHolder !== null ? { lock: L(st.lockHolder) } : {}),
    });
    scene.windows.forEach((w, k) =>
      out.push({
        key: `win${k}`,
        kind: 'window',
        text: w.label,
        x: w.cx,
        y: COUNTER_Y + 20,
        anchor: 'center',
        ...(w.lockHolder !== null ? { lock: L(w.lockHolder) } : {}),
      }),
    );
  }

  if (scene.others > 0)
    out.push({
      key: 'crowd',
      kind: 'crowd',
      text: `그 밖 ${scene.others}명 (그림 생략)`,
      x: STAGE_W - 3,
      y: 186,
      anchor: 'right',
    });

  // 말풍선: 화면 밖으로 나가지 않게 가로를 64..192로 묶는다
  for (const b of scene.bubbles) {
    const a = scene.actors[b.actor];
    if (!a) continue;
    out.push({
      key: b.key,
      kind: 'bubble',
      text: b.text,
      x: Math.max(64, Math.min(STAGE_W - 64, a.x)),
      y: a.y - 40,
      anchor: 'above',
      tone: b.tone,
      opacity: b.opacity,
    });
  }
  for (const p of scene.pops)
    out.push({
      key: p.key,
      kind: 'pop',
      text: p.text,
      x: p.x,
      y: opts.reducedMotion ? p.y0 : p.y,
      anchor: 'above',
      tone: p.tone,
      icon: p.icon,
      opacity: p.opacity,
    });
  return out;
}
