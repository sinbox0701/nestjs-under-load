import { Application, Graphics, TextureStyle } from 'pixi.js';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Tone } from '../events/phases';
import { STAGE_H, STAGE_W, integerScale, type Scene } from '../playback/scene';
import { PALETTE } from '../theme/theme';

// 도트 그래픽: 텍스처는 최근접 보간(DESIGN_SYSTEM §9, PixiJS v8 API).
TextureStyle.defaultOptions.scaleMode = 'nearest';

/** 이름표·캐릭터 색(상태 색과 섞지 않는다, DESIGN_SYSTEM §1.2). */
const ACTOR_COLORS = [PALETTE.slate, PALETTE.wood, PALETTE.ink, PALETTE.mist];
const TONE_COLORS: Record<Tone, number> = {
  ok: PALETTE.ok,
  wait: PALETTE.wait,
  bad: PALETTE.bad,
  retry: PALETTE.retry,
  info: PALETTE.info,
  neutral: PALETTE.mist,
};

export interface StageProps {
  scene: Scene;
  labels: string[];
  /** 접근성: 현재 상황(DESIGN_SYSTEM §7). */
  ariaLabel: string;
  hud: ReactNode;
  footer: ReactNode;
  overlay?: ReactNode;
}

function drawBackdrop(g: Graphics) {
  g.rect(0, 0, STAGE_W, 72).fill(PALETTE.paper);
  g.rect(0, 72, STAGE_W, STAGE_H - 72).fill(PALETTE.shell);
  g.rect(100, 96, 56, 14).fill(PALETTE.wood);
  g.rect(121, 84, 14, 12).fill(PALETTE.paper).stroke({ color: PALETTE.ink, width: 1 });
}

function drawActors(g: Graphics, scene: Scene) {
  g.clear();
  for (const a of scene.actors) {
    if (!a.visible) continue;
    const x = a.x - 4;
    const y = a.y - 14;
    g.rect(x - 1, a.y, 10, 2).fill(PALETTE.mist); // 그림자
    g.rect(x, y, 8, 14).fill(ACTOR_COLORS[a.index % ACTOR_COLORS.length]!);
    g.rect(x + 2, y + 1, 4, 4).fill(PALETTE.skin);
    g.rect(x, y - 4, 8, 2).fill(TONE_COLORS[a.tone]); // 상태 띠
  }
}

export function Stage({ scene, labels, ariaLabel, hud, footer, overlay }: StageProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const actorsRef = useRef<Graphics | null>(null);
  const appRef = useRef<Application | null>(null);
  const sceneRef = useRef(scene);
  const [k, setK] = useState(1);

  // 정수 배율 계산
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setK(integerScale(el.clientWidth, window.devicePixelRatio || 1));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // PixiJS 마운트(StrictMode 이중 마운트·비동기 init 안전)
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let ready = false;
    const app = new Application();
    app
      .init({
        width: STAGE_W,
        height: STAGE_H,
        resolution: 1,
        antialias: false,
        roundPixels: true,
        background: PALETTE.shell,
        autoStart: false,
      })
      .then(() => {
        if (disposed) {
          app.destroy(true, { children: true });
          return;
        }
        ready = true;
        app.canvas.setAttribute('role', 'img');
        host.appendChild(app.canvas);
        const bg = new Graphics();
        drawBackdrop(bg);
        const actors = new Graphics();
        app.stage.addChild(bg, actors);
        actorsRef.current = actors;
        appRef.current = app;
        drawActors(actors, sceneRef.current);
        app.render();
      });
    return () => {
      disposed = true;
      actorsRef.current = null;
      appRef.current = null;
      if (ready) app.destroy(true, { children: true });
    };
  }, []);

  // 장면이 바뀔 때만 다시 그린다(시간 경과만으로 움직이지 않는다).
  useEffect(() => {
    sceneRef.current = scene;
    const g = actorsRef.current;
    const app = appRef.current;
    if (!g || !app) return;
    drawActors(g, scene);
    app.render();
  }, [scene]);

  useEffect(() => {
    appRef.current?.canvas.setAttribute('aria-label', ariaLabel);
  }, [ariaLabel]);

  const w = STAGE_W * k;
  const h = STAGE_H * k;
  return (
    <section className="panel stage" aria-label="무대">
      <div className="stage__hud">{hud}</div>
      <div ref={wrapRef} className="stage__mat">
        <div className="stage__box" style={{ width: w, height: h }}>
          <div ref={hostRef} className="stage__canvas" style={{ width: w, height: h }} />
          <div className="stage__overlay" aria-hidden="true">
            {scene.actors
              .filter((a) => a.visible)
              .map((a) => (
                <span
                  key={a.id}
                  className={`chip a${a.index} stage__tag`}
                  style={{
                    transform: `translate(${Math.round(a.x * k)}px, ${Math.round((a.y - 20) * k)}px) translate(-50%, -100%)`,
                  }}
                >
                  {labels[a.index]}
                </span>
              ))}
          </div>
          {overlay}
        </div>
      </div>
      <div className="stage__foot small">
        {footer}
        <span className="dim">
          {STAGE_W}×{STAGE_H} ×{k.toFixed(2).replace(/\.?0+$/, '')}
        </span>
      </div>
    </section>
  );
}
