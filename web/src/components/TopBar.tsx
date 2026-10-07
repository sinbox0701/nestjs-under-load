import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ThemeChoice } from '../theme/theme';
import {
  SCENARIO_IDS,
  SCENARIO_UI,
  SHAPE_BARS,
  defaultConfig,
  scenarioDef,
  strategyOf,
  tagOf,
  type RunConfig,
  type ScenarioId,
} from './lib/config';
import { Icon } from './lib/icons';
import { Seg } from './lib/Seg';

export interface TopBarProps {
  /** 테마 버튼은 셸(Shell)이 갖는다. 무대의 T 단축키 상태 호환을 위해 받기만 한다. */
  theme?: ThemeChoice;
  onThemeChange?: (t: ThemeChoice) => void;
  onKeys: () => void;
  /** 가짜 데이터 고지(시안·fixture 재생 중). */
  fakeNote: string | null;
}

/** 상단 바: 브랜드 + 도구(가짜 데이터 고지 · 단축키 ?). 화면 탭·테마 버튼은 셸이 갖는다. DESIGN_SYSTEM §4.2 */
export function TopBar({ onKeys, fakeNote }: TopBarProps) {
  return (
    <header className="appbar">
      <div className="brand">
        <svg
          className="logo px-ico"
          viewBox="0 0 8 8"
          aria-hidden="true"
          shapeRendering="crispEdges"
        >
          <rect width="8" height="8" fill="var(--fg)" />
          <rect x="1" y="5" width="1" height="2" fill="var(--ok)" />
          <rect x="3" y="3" width="1" height="4" fill="var(--wait)" />
          <rect x="5" y="1" width="1" height="6" fill="var(--bad)" />
        </svg>
        nestjs-under-load
      </div>
      <div className="tools">
        {fakeNote && (
          <span className="fake">
            <Icon name="bang" />
            {fakeNote}
          </span>
        )}
        <button
          type="button"
          className="btn btn--ghost"
          aria-haspopup="dialog"
          title="단축키 (?)"
          onClick={onKeys}
        >
          단축키 <kbd>?</kbd>
        </button>
      </div>
    </header>
  );
}

export interface RunControlsProps {
  cfg: RunConfig;
  onCfg: (next: RunConfig) => void;
  pred: number | null;
  onPred: (v: number | null) => void;
  running: boolean;
  onRun: () => void;
  onStop: () => void;
}

const OPTION_LABEL: Record<string, string> = {
  people: '편집자 인원',
  shape: '부하 모양',
};

function editHint(cfg: RunConfig, editName: string, lease: boolean): string {
  if (!lease) return '편집 잠금에서만 대가가 달라진다 — 다른 방식은 편집 중 아무것도 잡지 않는다';
  return cfg.options.edit
    ? `잠금을 ${editName} 쥔다 · TTL 30s에 닿으면 클라이언트가 만료 전 연장(renew)한다고 가정 — 이 코드엔 연장 경로 없음`
    : '실험실 think time(압축). 오른쪽으로 갈수록 실제 사람 시간';
}

/** 설정 컨트롤 바(DESIGN_SYSTEM §4.3). 실행 진입점은 `실행하기` 하나다. */
export function RunControls({
  cfg,
  onCfg,
  pred,
  onPred,
  running,
  onRun,
  onStop,
}: RunControlsProps) {
  const [open, setOpen] = useState(false);
  const [predText, setPredText] = useState(pred === null ? '' : String(pred));
  const def = scenarioDef(cfg.scenario);
  const st = strategyOf(cfg.scenario, cfg.strategy);
  const setOpt = (key: string, v: string | number | boolean) =>
    !running && onCfg({ ...cfg, options: { ...cfg.options, [key]: v } });
  const optLabel = (key: string) =>
    def.options.find((o) => o.key === key)?.values.find((v) => v.value === cfg.options[key])
      ?.label ?? '';
  const editOpt = def.options.find((o) => o.key === 'edit');
  const lease = !!editOpt && (!editOpt.onlyFor || editOpt.onlyFor.includes(cfg.strategy));
  const hint = editOpt ? editHint(cfg, optLabel('edit'), lease) : '';
  const summary = [
    SCENARIO_UI[cfg.scenario].code,
    st.label,
    ...def.options.filter((o) => o.key !== 'edit').map((o) => optLabel(o.key)),
    ...(lease ? [`편집 ${optLabel('edit')}`] : []),
  ].join(' · ');

  return (
    <section
      className="panel controls a-controls"
      aria-label="실행 설정"
      aria-busy={running || undefined}
      title={running ? '실행 중에는 설정을 바꿀 수 없다 (Esc로 실행 중단)' : undefined}
    >
      <button
        className="ctl-sum"
        type="button"
        aria-expanded={open}
        aria-controls="ctlBody"
        onClick={() => setOpen(!open)}
      >
        <span>
          <b>설정</b> · {summary}
        </span>
        <span className="car" aria-hidden="true">
          ▾
        </span>
      </button>
      <div className="ctl-body" id="ctlBody">
        <div className="field">
          <span className="lbl">시나리오</span>
          <Seg<string>
            disabled={running}
            label="시나리오"
            value={cfg.scenario}
            onChange={(id) => id !== cfg.scenario && onCfg(defaultConfig(id as ScenarioId))}
            items={SCENARIO_IDS.map((id) => ({
              value: id,
              title: SCENARIO_UI[id].tip,
              label: (
                <>
                  <span className="badge t-info tag">{SCENARIO_UI[id].code}</span>
                  {scenarioDef(id).title}
                </>
              ),
            }))}
          />
        </div>
        <div className="field">
          <span className="lbl">
            처리 방식 <kbd>S</kbd>
          </span>
          <Seg<string>
            disabled={running}
            label="처리 방식"
            className="seg-strat"
            value={cfg.strategy}
            onChange={(id) => onCfg({ ...cfg, strategy: id })}
            items={def.strategies.map((s) => {
              const t = tagOf(s.kind);
              return {
                value: s.id,
                disabled: s.disabled,
                title: s.disabled
                  ? '시안에서는 준비 중 — 바뀐 필드만 조건부 UPDATE, 같은 필드 충돌만 409'
                  : s.id,
                label: (
                  <>
                    <span className={`badge t-${t.tone} tag`}>
                      <Icon name={t.icon} />
                      {t.tag}
                    </span>
                    {s.label}
                    {s.disabled && <span className="soon">준비 중</span>}
                  </>
                ),
              };
            })}
          />
        </div>
        {def.options
          .filter((o) => o.key !== 'edit')
          .map((o) => (
            <div className="field" key={o.key}>
              <span className="lbl">{OPTION_LABEL[o.key] ?? o.label}</span>
              <Seg<number>
                disabled={running}
                label={o.label}
                value={Math.max(
                  0,
                  o.values.findIndex((v) => v.value === cfg.options[o.key]),
                )}
                onChange={(i) => setOpt(o.key, o.values[i]!.value)}
                items={o.values.map((v, i) => ({
                  value: i,
                  label:
                    o.key === 'shape' && SHAPE_BARS[String(v.value)] ? (
                      <>
                        <span className="shape" aria-hidden="true">
                          {SHAPE_BARS[String(v.value)]!.map((h, k) => (
                            <i key={k} style={{ height: h + 1 }} />
                          ))}
                        </span>
                        {v.label}
                      </>
                    ) : (
                      v.label
                    ),
                }))}
              />
            </div>
          ))}
        {editOpt && (
          <div className={lease ? 'field' : 'field is-off'} title={hint}>
            <label className="lbl" htmlFor="editRange">
              편집 시간 (사람) · 압축 ↔ 실제
            </label>
            <div className="range">
              <input
                type="range"
                id="editRange"
                min={0}
                max={editOpt.values.length - 1}
                step={1}
                disabled={running}
                value={Math.max(
                  0,
                  editOpt.values.findIndex((v) => v.value === cfg.options.edit),
                )}
                aria-describedby="editHint"
                onChange={(e) =>
                  setOpt('edit', editOpt.values[Number(e.currentTarget.value)]!.value)
                }
              />
              <output htmlFor="editRange">{optLabel('edit')}</output>
            </div>
            <span className="hint" id="editHint" title={hint}>
              {hint}
            </span>
          </div>
        )}
        <div className="runbar">
          <label className="field pred">
            <span className="lbl">예측: 위반 몇 건? (선택)</span>
            <input
              type="number"
              min={0}
              max={99}
              inputMode="numeric"
              placeholder="—"
              value={predText}
              onChange={(e) => {
                const v = e.currentTarget.value.trim();
                setPredText(v);
                onPred(v === '' ? null : Math.max(0, Math.min(99, Math.round(Number(v)))));
              }}
            />
          </label>
          <button className="btn btn--run" type="button" disabled={running} onClick={onRun}>
            <Icon name="play" />
            실행하기
            <kbd>Enter</kbd>
          </button>
          <button className="btn" type="button" disabled={!running} onClick={onStop}>
            <Icon name="stop" />
            실행 중단
            <kbd>Esc</kbd>
          </button>
        </div>
      </div>
    </section>
  );
}

const KEYS: [string[], string][] = [
  [['Enter'], '실행하기 (기록 만들기)'],
  [['Esc'], '실행 중단 · 이 창 닫기'],
  [['Space'], '재생 / 일시정지 / 계속'],
  [['→', '←'], '다음 / 이전 단계 (타임라인에 보이는 행 단위)'],
  [['Home'], '처음으로'],
  [['1', '4'], '속도: 아주 느리게 · 느리게 · 보통 · 빠르게'],
  [['A'], '자동 멈춤 켜기/끄기'],
  [['F'], '빈 구간 빨리 감기'],
  [['C'], '코드 비교'],
  [['S'], '처리 방식 바꾸기'],
  [['T'], '테마'],
  [['?'], '이 창'],
];

/** `?` 단축키 오버레이(role=dialog, Esc로 닫고 포커스 복귀, Tab은 창 안에서만 돈다). */
export function KeysOverlay({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLElement>(null);
  const trap = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const f = [
      ...(boxRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
    if (!f.length) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    const at = document.activeElement;
    if (e.shiftKey ? at === first || !boxRef.current?.contains(at) : at === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  };
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => back?.focus?.();
  }, []);
  return (
    <div
      className="kbd-ov"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kbdTitle"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={trap}
    >
      <section className="panel" ref={boxRef}>
        <div className="panel__h">
          <h2 id="kbdTitle">단축키</h2>
          <button ref={closeRef} className="btn btn--ghost" type="button" onClick={onClose}>
            닫기 <kbd>Esc</kbd>
          </button>
        </div>
        <div className="panel__b">
          <dl>
            {KEYS.map(([keys, d]) => (
              <div key={d} style={{ display: 'contents' }}>
                <dt>
                  {keys.length === 2 && keys[0] === '1' ? (
                    <>
                      <kbd>1</kbd>–<kbd>4</kbd>
                    </>
                  ) : (
                    keys.map((k, i) => (
                      <span key={k}>
                        {i > 0 && ' '}
                        <kbd>{k}</kbd>
                      </span>
                    ))
                  )}
                </dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </div>
  );
}
