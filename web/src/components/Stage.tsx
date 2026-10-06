import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { STAGE_PER_REAL } from '../playback/constants';
import { snapshotAt, type Prepared } from '../playback/prepare';
import type { AutoStop } from '../playback/stops';
import {
  PxIcon,
  STAGE_H,
  STAGE_W,
  StageRenderer,
  WIDE_MIN,
  actorLabels,
  buildLabels,
  calloutTarget,
  explainStop,
  fmtReal,
  fmtScale,
  roundsOf,
  SPOT_SIZE,
  stageInputOf,
  stageScale,
  stageSceneAt,
  txSummary,
  useSheetFor,
  type Anchor,
  type OverlayLabel,
  type StageInput,
  type TxSummary,
} from '../stage';
import { parseRich } from '../scenarios/rich';
import '../stage/stage.css';

export interface StageProps {
  /** 재생할 기록. 없으면(아직 실행 전) 가운데 CTA를 보인다. */
  prepared?: Prepared | null;
  /** 재생 위치(실제 ms). */
  P?: number;
  /** 자동 멈춤(또는 단계 이동으로 핵심 이벤트에 도착)한 지점. 있으면 무대를 어둡게 + 조준 틀 + 설명. */
  callout?: AutoStop | null;
  /** 대표 actor 이름표(기본 A, B, C …). */
  labels?: readonly string[];
  playing?: boolean;
  /** 재생 속도(1 = 실제의 1/40). */
  speed?: number;
  /** 지금 접힌 빈 구간 안이면 그 구간(실제 ms). */
  foldedGap?: { a: number; b: number } | null;
  /** 설명의 `▶ 계속` 버튼. */
  onContinue?: () => void;
  /** 기록이 없을 때 CTA `▶ 실행해서 보기`. */
  onRun?: () => void;
  /** 기록을 만드는 중이면 그 안내(예: `실행 중 · 기록 만드는 중 R2/4 (Esc 실행 중단)`). */
  running?: string | null;
  /** 기록이 없을 때 CTA 아래 질문. */
  question?: string;
  /** 무대 아래 재생 바(높이 제한 배율 계산용). 없으면 무대 패널 바로 다음 형제를 잰다. */
  transportRef?: RefObject<HTMLElement | null>;
  /** 캔버스 aria-label을 덮어쓴다(기본: 처리 방식·인원·위반 수). */
  ariaLabel?: string;
  /** HUD 오른쪽 끝에 덧붙일 것. */
  hud?: ReactNode;
  /** 하단 줄에 덧붙일 것. */
  footer?: ReactNode;
  /** @deprecated 예전 App 호환용. 무시한다(장면은 prepared·P로 직접 계산). */
  scene?: unknown;
  /** @deprecated 예전 App 호환용. 자동 멈춤 설명은 callout으로 무대가 직접 그린다. */
  overlay?: ReactNode;
}

const ANCHOR: Record<Anchor, string> = {
  above: 'translate(-50%, -100%)',
  below: 'translate(-50%, 0)',
  center: 'translate(-50%, -50%)',
  left: 'translate(0, -50%)',
  right: 'translate(-100%, -50%)',
};

function scenarioCode(scenario: string): string {
  const m = /^([a-z]\d+)/i.exec(scenario);
  return m ? m[1]!.toUpperCase() : scenario;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

interface Fit {
  K: number;
  vw: number;
}

/** 정수 배율(§3.2): 폭과(넓은 화면이면) 남은 높이로 제한. 시트 높이는 넣지 않는다. */
function useStageFit(
  matRef: RefObject<HTMLDivElement | null>,
  boxRef: RefObject<HTMLDivElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  transportRef?: RefObject<HTMLElement | null>,
): Fit {
  const [fit, setFit] = useState<Fit>({ K: 1, vw: 1440 });
  useLayoutEffect(() => {
    const mat = matRef.current;
    if (!mat) return;
    const below = () =>
      transportRef?.current ?? (panelRef.current?.nextElementSibling as HTMLElement | null) ?? null;
    const update = () => {
      const vw = window.innerWidth;
      const wide = vw >= WIDE_MIN;
      const box = boxRef.current;
      const s = stageScale({
        availWidth: mat.clientWidth,
        devicePixelRatio: window.devicePixelRatio || 1,
        ...(wide && box
          ? {
              height: {
                viewportHeight: window.innerHeight,
                stageTop: box.getBoundingClientRect().top + window.scrollY,
                transportHeight: below()?.offsetHeight ?? 0,
              },
            }
          : {}),
      });
      setFit((f) => (f.K === s.K && f.vw === vw ? f : { K: s.K, vw }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(mat);
    const b = below();
    if (b) ro.observe(b);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [matRef, boxRef, panelRef, transportRef]);
  return fit;
}

function Label({ l, K }: { l: OverlayLabel; K: number }) {
  const style: CSSProperties = {
    transform: `translate(${Math.round(l.x * K)}px, ${Math.round(l.y * K)}px) ${ANCHOR[l.anchor]}`,
  };
  if (l.opacity !== undefined && l.opacity < 1) style.opacity = Math.max(0, l.opacity);
  const cls = ['stg-l', `stg-l--${l.kind}`];
  if (l.kind === 'tag' && l.actor !== undefined) cls.push(`a${l.actor % 4}`);
  if (l.tone && (l.kind === 'bubble' || l.kind === 'pop' || l.kind === 'stock'))
    cls.push(`t-${l.tone}`);
  if (l.expired) cls.push('is-expired');
  return (
    <div className={cls.join(' ')} style={style}>
      {l.icon ? <PxIcon name={l.icon} /> : null}
      {l.text}
      {l.lock !== undefined ? (
        <>
          {' '}
          <PxIcon name="lock" />
          {l.lock}
          {l.expired ? ' 만료' : ''}
        </>
      ) : null}
      {l.kind === 'stock' && l.tone === 'bad' ? (
        <>
          {' '}
          <PxIcon name="cross" />
          초과 판매
        </>
      ) : null}
    </div>
  );
}

/** 기록이 실은 설명 서식(**굵게**, {{용어|말}}) — 용어는 점선 밑줄 + 툴팁(마우스·키보드 포커스). */
function RichText({ text }: { text: string }) {
  return (
    <>
      {parseRich(text).map((seg, k) =>
        seg.kind === 'bold' ? (
          <b key={k}>{seg.text}</b>
        ) : seg.kind === 'term' ? (
          <span key={k} className="stg-term" tabIndex={0} title={seg.tip} data-tip={seg.tip}>
            {seg.text}
          </span>
        ) : (
          <span key={k}>{seg.text}</span>
        ),
      )}
    </>
  );
}

function TxStrip({ sum }: { sum: TxSummary }) {
  const words = sum.words.join(' → ');
  return (
    <div className="stg-tx" aria-label="트랜잭션 띠 요약">
      <div className="stg-tx__h">
        <b>트랜잭션 띠</b>
        <span>
          R{sum.round} 시작 → +{sum.sinceStart}ms
        </span>
        <span className="stg-tx__w" title={words}>
          {sum.whoLabel}: {words || '—'}
        </span>
      </div>
      {sum.lanes.map((lane) => (
        <div key={lane.actor} className={lane.isWho ? 'stg-lane is-who' : 'stg-lane'}>
          <span className={`chip a${lane.actor % 4}`}>{lane.label}</span>
          <div className="stg-lane__track">
            {lane.items.map((it, k) =>
              it.kind === 'mark' ? (
                <i
                  key={k}
                  className={`stg-mk stg-mk--${it.mark}`}
                  style={{ left: `${it.left}%` }}
                  title={it.tip}
                />
              ) : (
                <i
                  key={k}
                  className={`stg-bd stg-bd--${it.cls}`}
                  style={{ left: `${it.left}%`, width: `${it.width}%` }}
                  title={it.tip}
                />
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Stage({
  prepared = null,
  P = 0,
  callout = null,
  labels: labelsProp,
  playing = false,
  speed = 0.25,
  foldedGap = null,
  onContinue,
  onRun,
  running = null,
  question = '두 사람이 같은 문서를 동시에 고치면?',
  transportRef,
  ariaLabel,
  hud,
  footer,
}: StageProps) {
  const panelRef = useRef<HTMLElement>(null);
  const matRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<StageRenderer | null>(null);
  const { K, vw } = useStageFit(matRef, boxRef, panelRef, transportRef);
  const reduced = useReducedMotion();

  const input: StageInput | null = useMemo(
    () => (prepared ? stageInputOf(prepared) : null),
    [prepared],
  );
  const meta = input?.meta ?? null;
  const labels = useMemo(() => labelsProp ?? (meta ? actorLabels(meta) : []), [labelsProp, meta]);
  const scene = useMemo(() => stageSceneAt(input, P, labels), [input, P, labels]);
  const overlay = useMemo(
    () => buildLabels(scene, K, labels, { reducedMotion: reduced }),
    [scene, K, labels, reduced],
  );
  const violations = prepared ? snapshotAt(prepared, P).counters.violations : 0;

  // 위반이 새로 생기면 HUD 배지 펄스(렌더 중 이전 값 비교 — React 권장 패턴)
  const [prevViol, setPrevViol] = useState(violations);
  const [pulse, setPulse] = useState(0);
  if (violations !== prevViol) {
    setPrevViol(violations);
    if (violations > prevViol) setPulse((p) => p + 1);
  }

  // PixiJS 마운트(StrictMode 이중 마운트·비동기 init 안전). 실패하면(jsdom 등) 글자 레이어만 남는다.
  const sceneRef = useRef(scene);
  useEffect(() => {
    sceneRef.current = scene;
    rendererRef.current?.draw(scene);
  }, [scene]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let made: StageRenderer | null = null;
    void StageRenderer.create().then((r) => {
      if (!r) return;
      if (disposed) {
        r.destroy();
        return;
      }
      made = r;
      r.canvas.setAttribute('role', 'img');
      host.appendChild(r.canvas);
      rendererRef.current = r;
      r.draw(sceneRef.current);
    });
    return () => {
      disposed = true;
      rendererRef.current = null;
      made?.destroy();
    };
  }, []);

  const title = meta ? `${meta.scenarioTitle} (${scenarioCode(meta.scenario)})` : '무대';
  const label =
    ariaLabel ??
    (meta
      ? `${title} · ${meta.strategy.label} · 대표 ${meta.actors.length}명. ${violations > 0 ? `정합성 위반 ${violations}건` : '정합성 위반 없음'}`
      : '무대 · 기록 없음');
  useEffect(() => {
    rendererRef.current?.canvas.setAttribute('aria-label', label);
  });

  const w = STAGE_W * K;
  const h = STAGE_H * K;
  const sheet = useSheetFor(vw, K);
  const explain = callout && input ? explainStop(input, callout, labels) : null;
  const target = callout && input && meta ? calloutTarget(scene, callout, meta.actors) : null;
  const sum = callout && input ? txSummary(input, callout, P, labels) : null;
  const rounds = input ? roundsOf(input) : [];
  const live = scene.kind === 'empty' ? null : scene;
  const span = live ? live.roundEnd - live.roundStart : 0;
  const slow = Math.round(STAGE_PER_REAL / speed);
  const injected = prepared?.events.some((e) => e.injected) ?? false;

  const calloutBody = explain ? (
    <>
      <span className={`badge t-${explain.tone}`}>
        <PxIcon name="stop" />
        자동 멈춤
      </span>
      <span>
        {explain.rich ? (
          <RichText text={explain.rich} />
        ) : (
          <>
            <b>{explain.title}</b> {explain.body}
          </>
        )}
      </span>
      <span className="stg-callout__hint">
        <span>Space 계속 · → 다음 단계</span>
        {onContinue ? (
          <button type="button" className="stg-go" onClick={onContinue}>
            <PxIcon name="play" />
            계속
          </button>
        ) : null}
      </span>
    </>
  ) : null;

  let real = '실행 전';
  if (running) real = running;
  else if (live && foldedGap)
    real = `▶▶ 빈 구간 빨리 감기 · 실제 ${fmtReal(foldedGap.b - foldedGap.a)}ms를 0.3초로`;
  else if (live)
    real = `${playing ? '▶' : '■'} 실제 ${fmtReal(span)}ms ${rounds.length > 1 ? '라운드' : '기록'}를 1/${slow} 속도로 ${playing ? '재생 중' : '멈춤'}`;

  return (
    <section ref={panelRef} className="panel stg" aria-label="무대">
      <div className="stg-hud">
        <div className="stg-hud__title">
          <b>{title}</b>
          {meta ? (
            <span className="stg-hud__sub" title={meta.route}>
              {meta.strategy.label}({meta.strategy.id}) · {meta.totalActors}명
            </span>
          ) : null}
        </div>
        <div className="stg-hud__right">
          {live ? (
            <span
              className="stg-hud__clock"
              title={`라운드 시작부터 실제 경과 / 라운드 길이 · 실제의 1/${slow} 속도`}
            >
              R{live.roundIndex + 1}/{live.roundCount} · +{fmtReal(Math.max(0, live.lt))}ms /{' '}
              {fmtReal(span)}ms
            </span>
          ) : null}
          {meta ? (
            <span className="badge t-neutral" title="이 처리 방식의 트랜잭션 격리 수준">
              {meta.isolation}
            </span>
          ) : null}
          <span
            key={pulse}
            className={`stg-inv badge ${violations > 0 ? 't-bad' : 't-ok'}${pulse > 0 && violations > 0 ? ' is-pulse' : ''}`}
            role="status"
          >
            <PxIcon name={violations > 0 ? 'cross' : 'check'} />
            {violations > 0 ? `위반 ${violations}` : '정합성 OK'}
          </span>
          {hud}
        </div>
      </div>

      <div ref={matRef} className="stg-mat">
        <div ref={boxRef} className="stg-box" style={{ width: w, height: h }}>
          <div ref={hostRef} className="stg-canvas" />
          <div className={K < 2 ? 'stg-ov is-small' : 'stg-ov'} aria-hidden="true">
            {overlay.map((l) => (
              <Label key={l.key} l={l} K={K} />
            ))}
            {target ? (
              <div
                className="stg-spot"
                style={{
                  width: SPOT_SIZE * K,
                  height: SPOT_SIZE * K,
                  transform: `translate(${Math.round(target.x * K)}px, ${Math.round(target.y * K)}px) translate(-50%, -50%)`,
                }}
              />
            ) : null}
          </div>
          {calloutBody && !sheet ? (
            <div
              className={`stg-callout stg-callout--in${scene.kind === 'queue-at-counter' ? ' is-top' : ''}`}
              role="note"
            >
              {calloutBody}
            </div>
          ) : null}
          {!prepared ? (
            <div className="stg-cta">
              {running ? (
                <p>{running}</p>
              ) : (
                <>
                  <button type="button" className="btn" onClick={onRun} disabled={!onRun}>
                    <PxIcon name="play" />
                    실행해서 보기
                  </button>
                  <p>{question}</p>
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {calloutBody && sheet ? (
        <div className="stg-sheet" aria-live="polite">
          <div className="stg-callout">{calloutBody}</div>
        </div>
      ) : null}
      {sum ? <TxStrip sum={sum} /> : null}

      <div className="stg-foot">
        <span>
          {meta
            ? `대표 ${Math.min(meta.actors.length, meta.totalActors)}명 표시 / 전체 ${meta.totalActors}명`
            : '기록 없음'}
        </span>
        <span className="stg-foot__real">{real}</span>
        <span className="stg-foot__meta">
          {STAGE_W}×{STAGE_H} {fmtScale(K)}
        </span>
        {injected ? (
          <span
            className="badge t-info"
            title="인위 개입(경합 창 지연·편집 시간 압축 등)이 걸린 이벤트가 있다"
          >
            주입됨
          </span>
        ) : null}
        {footer}
      </div>
    </section>
  );
}
