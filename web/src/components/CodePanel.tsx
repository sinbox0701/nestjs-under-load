import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  createCssVariablesTheme,
  createHighlighterCore,
  type HighlighterCore,
  type ThemedToken,
} from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { Tone } from '../events/phases';
import type { CodeSource, RecordingMeta, RunEvent } from '../events/types';
import {
  codeLines,
  eventLine,
  foldKeyOf,
  foldPlan,
  lcsDiff,
  methodOf,
  resolveHit,
  type FoldItem,
} from './lib/code';
import { scenarioDef, tagOf, type ScenarioId } from './lib/config';
import { Icon, type IconName } from './lib/icons';
import { actorIdx, actorLabel, fmtMs } from './lib/model';
import { Rich, SqlLine } from './lib/rich';

// 문법 색은 CSS 변수(theme/tokens.css)로 → 라이트/다크를 CSS만으로 바꾼다.
const THEME = createCssVariablesTheme({
  name: 'nul-css-vars',
  variablePrefix: '--shiki-',
  fontStyle: true,
});
let highlighter: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [THEME],
    langs: [import('shiki/langs/typescript.mjs')],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

/** 줄 단위 shiki 토큰. 준비 전에는 null(글자만 보인다). */
function useTokens(lines: readonly string[]): ThemedToken[][] | null {
  const code = lines.join('\n');
  const [out, setOut] = useState<{ code: string; tokens: ThemedToken[][] } | null>(null);
  useEffect(() => {
    let alive = true;
    getHighlighter()
      .then((h) => h.codeToTokens(code, { lang: 'typescript', theme: 'nul-css-vars' }).tokens)
      .then((tokens) => alive && setOut({ code, tokens }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [code]);
  return out?.code === code ? out.tokens : null;
}

function CodeText({ text, tokens }: { text: string; tokens: ThemedToken[] | undefined }) {
  if (!tokens) return <>{text || ' '}</>;
  if (!tokens.length) return <> </>;
  return (
    <>
      {tokens.map((t, i) => {
        const comment = t.color?.includes('comment');
        const bold = t.fontStyle !== undefined && (t.fontStyle & 2) !== 0;
        return (
          <span
            key={i}
            className={comment ? 'c-cm' : undefined}
            style={comment ? undefined : { color: t.color, fontWeight: bold ? 700 : undefined }}
          >
            {t.content}
          </span>
        );
      })}
    </>
  );
}

export interface Cursor {
  actor: string;
  event: RunEvent;
}

export interface CodePanelProps {
  hasRec: boolean;
  scenario: ScenarioId;
  strategyId: string;
  meta: RecordingMeta;
  /** 지금 처리 방식의 코드(기록 또는 시나리오 레지스트리). */
  code: CodeSource;
  /** 비교 대상 코드를 얻는다(처리 방식 id → 코드). */
  codeOf: (strategyId: string) => CodeSource | null;
  /** 함께 볼 공통 코드(엔티티 등). */
  extra: CodeSource | null;
  /** 강조할 이벤트(자동 멈춤 이벤트 또는 재생 위치의 이 라운드 마지막 이벤트). */
  event: RunEvent | null;
  /** 이벤트 시각 기준(라운드 시작, 실제 ms). */
  roundStart: number;
  /** 각 actor의 현재 이벤트(거터 A▶ B▶). */
  cursors: Cursor[];
  /** phase 표시(배지 글자·색·아이콘). */
  phase: (e: RunEvent) => { label: string; tone: Tone; icon: IconName };
  compare: boolean;
  /** 화면 읽기 알림: 재생 중엔 끄고 자동 멈춤에 섰을 때만 켠다(없으면 끔). */
  announce?: boolean;
  compareWith: string;
  onToggleCompare: () => void;
  onCompareWith: (id: string) => void;
}

function useMedia(q: string): boolean {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches;
  const [on, setOn] = useState(get);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const f = () => setOn(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [q]);
  return on;
}

interface LineOpts {
  cls?: string;
  mark?: string;
  cursors?: { idx: number; label: string }[];
}

function Line({
  lines,
  n,
  tokens,
  o,
}: {
  lines: readonly string[];
  n: number;
  tokens: ThemedToken[][] | null;
  o: LineOpts;
}) {
  return (
    <div className={`cl ${o.cls ?? ''}`.trim()} data-n={n}>
      <span className="ln">{n}</span>
      <span className="cur">
        {o.cursors?.map((c) => (
          <i key={c.label} className={`a${c.idx % 4}`} title={`${c.label}의 현재 줄`}>
            {c.label}
          </i>
        ))}
      </span>
      <span className="mk">{o.mark ?? ''}</span>
      <code>
        <CodeText text={lines[n - 1] ?? ''} tokens={tokens?.[n - 1]} />
      </code>
    </div>
  );
}

const FoldBtn = ({
  it,
  onOpen,
}: {
  it: Extract<FoldItem, { type: 'fold' }>;
  onOpen: () => void;
}) => (
  <button type="button" className="fold" onClick={onOpen}>
    ⋯ 공통 {it.lines.length}줄 접음 ({it.from}–{it.to}) · 펼치기
  </button>
);

/** 코드 패널(DESIGN_SYSTEM §4.10): 이벤트를 낸 서버 코드 줄 강조 + SQL + 한 줄 설명 + 비교. */
export function CodePanel(p: CodePanelProps) {
  const def = scenarioDef(p.scenario);
  const st = def.strategies.find((s) => s.id === p.strategyId) ?? def.strategies[0]!;
  const tag = tagOf(st.kind);
  const options = def.strategies.filter((s) => s.id !== p.strategyId && !s.disabled);
  const otherId = options.some((s) => s.id === p.compareWith) ? p.compareWith : options[0]?.id;
  // codeOf는 캐시된 코드를 돌려준다(같은 id면 같은 객체) → 아래 lines·diff memo가 매 프레임 다시 돌지 않는다.
  const other = p.compare && otherId ? p.codeOf(otherId) : null;
  const sO = other ? def.strategies.find((s) => s.id === otherId)! : null;
  const lines = useMemo(() => codeLines(p.code), [p.code]);
  const otherLines = useMemo(() => (other ? codeLines(other) : []), [other]);
  const extraLines = useMemo(() => (p.extra ? codeLines(p.extra) : []), [p.extra]);
  const tokens = useTokens(lines);
  const otherTokens = useTokens(otherLines);
  const extraTokens = useTokens(extraLines);
  const [unfold, setUnfold] = useState<ReadonlySet<string>>(new Set());
  const [miniPref, setMiniPref] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const narrow = useMedia('(max-width: 759px)');
  const wide = useMedia('(min-width: 1120px)');
  const mini = narrow && miniPref;
  const wrapRef = useRef<HTMLDivElement>(null);
  const toneOf = p.phase;

  const hit = useMemo(
    () => (p.event ? resolveHit(p.code, p.event, (e) => toneOf(e).tone) : null),
    [p.code, p.event, toneOf],
  );
  const cursorsAt = useMemo(() => {
    const m = new Map<number, { idx: number; label: string }[]>();
    for (const c of p.cursors) {
      const n = eventLine(p.code, c.event);
      if (!n) continue;
      const cur = {
        idx: Math.max(0, actorIdx(p.meta, c.actor)),
        label: actorLabel(p.meta, c.actor),
      };
      m.set(n, [...(m.get(n) ?? []), cur]);
    }
    return m;
  }, [p.code, p.cursors, p.meta]);

  const diff = useMemo(
    () => (other ? lcsDiff(otherLines, lines) : null),
    [other, otherLines, lines],
  );
  const basePlan = useMemo(() => (diff ? foldPlan('cur', diff.b, unfold) : null), [diff, unfold]);
  // 강조 줄이 접힌 곳에 있으면 그 묶음을 자동으로 편다.
  const autoKey = basePlan && hit ? foldKeyOf(basePlan, hit.line) : null;
  const eff = useMemo(() => (autoKey ? new Set([...unfold, autoKey]) : unfold), [unfold, autoKey]);
  const curItems = diff ? foldPlan('cur', diff.b, eff) : null;
  const otherItems = diff ? foldPlan('other', diff.a, eff) : null;
  const open = (key: string) => setUnfold(new Set([...unfold, key]));

  // 넓은 화면: 코드 영역 높이를 남은 화면에 맞춘다(무대+재생 바+코드가 한 화면).
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (!wide || mini) {
      el.style.maxHeight = '';
      return;
    }
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.maxHeight = `${Math.max(240, window.innerHeight - top - 152)}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [wide, mini, p.compare, p.scenario]);

  // 강조 줄을 코드 영역 안에서 가운데로(페이지 스크롤은 건드리지 않는다).
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !hit || mini) return;
    const el = wrap.querySelector<HTMLElement>(`[data-side="cur"] .cl[data-n="${hit.line}"]`);
    if (!el || wrap.scrollHeight <= wrap.clientHeight) return;
    wrap.scrollTop = Math.max(0, el.offsetTop - wrap.clientHeight / 2 + el.offsetHeight / 2);
  }, [hit, mini, p.compare, wide]);

  const entry = p.code.markers?.entry ?? p.code.markers?.acquire ?? p.code.markers?.arrived ?? 1;
  const center = hit?.line ?? entry;
  const near = (n: number) => !mini || Math.abs(n - center) <= 5;
  const lineCls = (n: number, base = '') => {
    const c = [base];
    if (hit?.line === n) c.push('is-hit', `tone-${hit.tone}`);
    else if (hit?.also.includes(n)) c.push('is-hit2');
    return c.filter(Boolean).join(' ');
  };

  const curRows: ReactNode = curItems
    ? curItems.map((it) =>
        it.type === 'fold' ? (
          mini ? null : (
            <FoldBtn key={it.key} it={it} onOpen={() => open(it.key)} />
          )
        ) : near(it.n) ? (
          <Line
            key={it.n}
            lines={lines}
            n={it.n}
            tokens={tokens}
            o={{
              cls: lineCls(it.n, it.changed ? `dl-${tag.tone}` : ''),
              mark: it.changed ? '+' : '',
              cursors: cursorsAt.get(it.n),
            }}
          />
        ) : null,
      )
    : lines.map((_, i) =>
        near(i + 1) ? (
          <Line
            key={i}
            lines={lines}
            n={i + 1}
            tokens={tokens}
            o={{ cls: lineCls(i + 1), cursors: cursorsAt.get(i + 1) }}
          />
        ) : null,
      );

  const tO = sO ? tagOf(sO.kind) : null;
  const nAdd = diff?.b.filter(Boolean).length ?? 0;
  const nDel = diff?.a.filter(Boolean).length ?? 0;
  const fileOf = (c: CodeSource) =>
    c.clientPath
      ? `${c.path.split('/').pop()} + ${c.clientPath.split('/').pop()}`
      : c.path.split('/').pop();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied('복사됨 ✓');
    } catch {
      setCopied('복사 실패');
    }
    setTimeout(() => setCopied(null), 1400);
  };

  const editIdx = Number(p.meta.options?.edit ?? 0);
  // 편집 옵션 2(30초)·3(5분)은 TTL 30초에 닿는다
  const longEdit =
    editIdx >= 2
      ? (def.options.find((o) => o.key === 'edit')?.values.find((v) => v.value === editIdx)
          ?.label ?? null)
      : null;
  const e = p.event;
  const ph = e ? p.phase(e) : null;
  const ai = e ? actorIdx(p.meta, e.actor) : -1;

  return (
    <>
      <div className="code-bar">
        <span
          className="code-file"
          title={
            p.code.example
              ? '시안용 예시 코드 · 실제 구현은 packs/generic/g01-shared-document/strategies/에 개발자가 직접 쓴다'
              : '팩 strategy 원문(빌드 시 번들, 읽기 전용)'
          }
        >
          <span className={`badge t-${tag.tone}`}>
            <Icon name={tag.icon} />
            {tag.tag}
          </span>
          <span className="badge t-neutral">{p.code.example ? '시안 예시 코드' : '팩 원문'}</span>
          {p.code.label ?? p.code.path}
        </span>
        <div className="code-tools">
          <button
            className="toggle"
            type="button"
            aria-pressed={p.compare}
            title="두 처리 방식 코드를 위아래로 놓고 다른 줄만 펼침 (C)"
            onClick={() => {
              setUnfold(new Set());
              p.onToggleCompare();
            }}
          >
            <i aria-hidden="true" />
            비교
          </button>
          {p.compare && (
            <select
              className="select"
              aria-label="비교할 처리 방식"
              value={otherId}
              onChange={(ev) => {
                setUnfold(new Set());
                p.onCompareWith(ev.currentTarget.value);
              }}
            >
              {options.map((s) => (
                <option key={s.id} value={s.id}>
                  비교 대상: {s.label}
                </option>
              ))}
            </select>
          )}
          <button className="btn btn--ghost" type="button" onClick={copy}>
            {copied ?? '복사'}
          </button>
        </div>
      </div>
      {p.code.example && (
        <p className="code-note">
          시안용 예시 코드 · 실제 구현은 <code>packs/generic/g01-shared-document/strategies/</code>
          에 개발자가 직접 쓴다.
        </p>
      )}
      {p.strategyId === 'edit-lease' && (
        <p
          className="code-note"
          data-testid="lease-renew-note"
          title="acquire의 lease_until = clock_timestamp() + 30초. 연장(renew) 요청·엔드포인트는 이 코드에 없다."
        >
          잠금 TTL은 30초다. 편집이 30초·5분처럼 TTL에 닿거나 넘으면{' '}
          <b>클라이언트가 만료 전에 잠금을 연장(renew)한다고 가정</b>했다 — 이 코드엔 연장 경로가
          없다.
          {longEdit && ` (지금 편집 시간 ${longEdit} — 연장 없이는 저장 전에 잠금이 만료된다)`}
        </p>
      )}
      {p.extra && (
        <details className="ent">
          <summary>
            공통 코드 <code>{p.extra.label ?? p.extra.path}</code>
          </summary>
          <div className="code-wrap">
            <div className="code-col">
              {extraLines.map((_, i) => (
                <Line key={i} lines={extraLines} n={i + 1} tokens={extraTokens} o={{}} />
              ))}
            </div>
          </div>
        </details>
      )}
      <div
        ref={wrapRef}
        className={`code-wrap${other ? ' two' : ''}${mini ? ' mini' : ''}`}
        data-testid="code-wrap"
      >
        <div className="code-col" data-side="cur">
          {other && !mini && (
            <div className="code-col__h">
              <span className={`badge t-${tag.tone}`}>
                <Icon name={tag.icon} />
                {tag.tag}
              </span>
              {st.label} · {fileOf(p.code)} ·{' '}
              <span className={`badge t-${tag.tone}`}>+ {nAdd}줄</span> · 지금 재생 중
            </div>
          )}
          {curRows}
        </div>
        {other && sO && tO && otherItems && !mini && (
          <div className="code-col" data-side="other">
            <div className="code-col__h">
              <span className={`badge t-${tO.tone}`}>
                <Icon name={tO.icon} />
                {tO.tag}
              </span>
              {sO.label} · {fileOf(other)} ·{' '}
              <span className={`badge t-${tO.tone}`}>− {nDel}줄</span> · 비교 대상
            </div>
            {otherItems.map((it) =>
              it.type === 'fold' ? (
                <FoldBtn key={it.key} it={it} onOpen={() => open(it.key)} />
              ) : (
                <Line
                  key={it.n}
                  lines={otherLines}
                  n={it.n}
                  tokens={otherTokens}
                  o={{ cls: it.changed ? `dl-${tO.tone}` : '', mark: it.changed ? '−' : '' }}
                />
              ),
            )}
          </div>
        )}
      </div>
      {narrow && (
        <button
          className="btn btn--ghost mini-more"
          type="button"
          onClick={() => setMiniPref(!miniPref)}
        >
          {miniPref ? '전체 코드 보기' : '강조 줄 주변만 보기'}
        </button>
      )}
      <div className="code-ev" aria-live={p.announce ? 'polite' : 'off'}>
        {e && ph && hit ? (
          <>
            <div className="code-ev__h">
              <span className={`chip a${Math.max(0, ai) % 4}`}>{actorLabel(p.meta, e.actor)}</span>
              <span className={`badge t-${ph.tone}`}>
                <Icon name={ph.icon} />
                {ph.label}
              </span>
              <b>
                {methodOf(p.code, lines, hit.line)} · {hit.line}번 줄
              </b>
              <span>· 실제 +{fmtMs(e.t - p.roundStart)}ms</span>
            </div>
            {hit.sql.length > 0 && (
              <pre className="sqlbox" data-testid="sqlbox">
                {hit.sql.map((l, i) => (
                  <span key={i}>
                    {i > 0 && '\n'}
                    <SqlLine line={l} />
                  </span>
                ))}
              </pre>
            )}
            {hit.note && (
              <p>
                <Rich text={hit.note} />
              </p>
            )}
          </>
        ) : (
          <p className="idle">
            {p.hasRec
              ? '재생하면 이벤트를 낸 코드 줄과 그 순간의 SQL이 여기에 나옵니다. 거터의 A▶ B▶는 각자 지금 있는 줄입니다.'
              : '실행하면 기록을 만들고, 재생 중 이벤트마다 해당 코드 줄을 강조합니다.'}
          </p>
        )}
      </div>
    </>
  );
}
