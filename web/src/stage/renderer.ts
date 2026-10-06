import { Application, Container, Sprite, Texture, TextureStyle } from 'pixi.js';
import { backdropKey, backdropOps, backdropSpecOf, sceneOps, type DrawOp } from './drawList';
import { STAGE_H, STAGE_W, type StageScene } from './model';
import { PAL, isPalKey, type Bitmap, type ColorMap } from './sprites';

// 도트 그래픽: 텍스처는 최근접 보간(DESIGN_SYSTEM §9, PixiJS v8 API).
TextureStyle.defaultOptions.scaleMode = 'nearest';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

function mapKey(map?: ColorMap): string {
  if (!map) return '';
  return Object.keys(map)
    .sort()
    .map((k) => `${k}${map[k]}`)
    .join('');
}

/** 비트맵 → 캔버스(픽셀 한 칸 = 1px). 가로 뒤집기 포함. */
function rasterize(rows: Bitmap, map: ColorMap | undefined, flip: boolean): HTMLCanvasElement {
  const w = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const h = rows.length;
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, w);
  cv.height = Math.max(1, h);
  const g = cv.getContext('2d');
  if (!g) return cv;
  g.imageSmoothingEnabled = false;
  for (let j = 0; j < h; j++) {
    const row = rows[j]!;
    for (let i = 0; i < row.length; i++) {
      const raw = row[i]!;
      if (raw === '.') continue;
      const c = map?.[raw] ?? raw;
      if (!isPalKey(c)) continue;
      g.fillStyle = hex(PAL[c]);
      g.fillRect(flip ? row.length - 1 - i : i, j, 1, 1);
    }
  }
  return cv;
}

function paintOps(ops: readonly DrawOp[]): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = STAGE_W;
  cv.height = STAGE_H;
  const g = cv.getContext('2d');
  if (!g) return cv;
  g.imageSmoothingEnabled = false;
  for (const op of ops) {
    g.globalAlpha = op.alpha ?? 1;
    if (op.k === 'rect') {
      g.fillStyle = hex(PAL[op.c]);
      g.fillRect(op.x, op.y, op.w, op.h);
    } else g.drawImage(rasterize(op.rows, op.map, !!op.flip), op.x, op.y);
  }
  g.globalAlpha = 1;
  return cv;
}

/**
 * PixiJS 8 무대 렌더러. 장면 → 그릴 목록(drawList.ts, 순수) → 스프라이트 풀.
 * 배경은 장면 타입별로 한 장의 텍스처로 굽고, 비트맵은 (이름·색·뒤집기)마다 텍스처를 한 번만 만든다.
 * 글자는 그리지 않는다(HTML 레이어).
 */
export class StageRenderer {
  private readonly app: Application;
  private readonly bg = new Sprite(Texture.EMPTY);
  private readonly layer = new Container();
  private readonly pool: Sprite[] = [];
  private readonly textures = new Map<string, Texture>();
  private bgKey = '';
  private dead = false;
  private bgTexture: Texture | null = null;

  private constructor(app: Application) {
    this.app = app;
    app.stage.addChild(this.bg, this.layer);
  }

  /** 비동기 초기화. WebGL·캔버스를 못 쓰는 환경(jsdom 등)에서는 null. */
  static async create(): Promise<StageRenderer | null> {
    try {
      const app = new Application();
      await app.init({
        width: STAGE_W,
        height: STAGE_H,
        resolution: 1,
        antialias: false,
        roundPixels: true,
        background: PAL.h,
        autoStart: false,
      });
      return new StageRenderer(app);
    } catch {
      return null;
    }
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  private texture(op: Extract<DrawOp, { k: 'bmp' }>): Texture {
    const key = `${op.id}|${mapKey(op.map)}|${op.flip ? 1 : 0}`;
    let t = this.textures.get(key);
    if (!t) {
      t = Texture.from(rasterize(op.rows, op.map, !!op.flip));
      this.textures.set(key, t);
    }
    return t;
  }

  private sprite(k: number): Sprite {
    let s = this.pool[k];
    if (!s) {
      s = new Sprite(Texture.WHITE);
      this.pool.push(s);
      this.layer.addChild(s);
    }
    s.visible = true;
    return s;
  }

  draw(scene: StageScene): void {
    if (this.dead) return;
    const spec = backdropSpecOf(scene);
    const key = backdropKey(spec);
    if (key !== this.bgKey) {
      this.bgTexture?.destroy(true);
      this.bgTexture = Texture.from(paintOps(backdropOps(spec)));
      this.bg.texture = this.bgTexture;
      this.bgKey = key;
    }
    const ops = sceneOps(scene);
    ops.forEach((op, k) => {
      const s = this.sprite(k);
      s.alpha = op.alpha ?? 1;
      s.position.set(op.x, op.y);
      if (op.k === 'rect') {
        s.texture = Texture.WHITE;
        s.tint = PAL[op.c];
        s.width = op.w;
        s.height = op.h;
      } else {
        const t = this.texture(op);
        s.texture = t;
        s.tint = 0xffffff;
        s.scale.set(1, 1);
      }
    });
    for (let k = ops.length; k < this.pool.length; k++) this.pool[k]!.visible = false;
    this.app.render();
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    for (const t of this.textures.values()) t.destroy(true);
    this.textures.clear();
    this.bgTexture?.destroy(true);
    this.app.destroy(true, { children: true });
  }
}
