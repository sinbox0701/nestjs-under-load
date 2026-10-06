import { useEffect, useRef, useState } from 'react';
import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { phaseInfo, type Tone } from '../events/phases';
import { parseCodeRef, type CodeSource, type RunEvent } from '../events/types';

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

export interface CodePanelProps {
  code: CodeSource;
  /** 강조할 이벤트(재생 위치의 마지막 이벤트 또는 자동 멈춤 이벤트). */
  event: RunEvent | null;
  actors: string[];
  labels: string[];
}

/** 강조 줄 색: 충돌·위반=빨강, 락 대기=노랑, 커밋=초록, 그 외=파랑(DESIGN_SYSTEM §4.10). */
function lineTone(tone: Tone): 'bad' | 'wait' | 'ok' | 'info' {
  if (tone === 'bad' || tone === 'wait' || tone === 'ok') return tone;
  return 'info';
}

export function CodePanel({ code, event, actors, labels }: CodePanelProps) {
  const [html, setHtml] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const ref = event?.codeRef ? parseCodeRef(event.codeRef) : null;
  const line = ref && ref.path === code.path ? ref.line : null;
  const tone = event ? lineTone(phaseInfo(event.phase).tone) : 'info';

  useEffect(() => {
    let alive = true;
    getHighlighter()
      .then((h) =>
        h.codeToHtml(code.source.replace(/\n$/, ''), { lang: 'typescript', theme: 'nul-css-vars' }),
      )
      .then((out) => alive && setHtml(out))
      .catch(() => alive && setHtml(null));
    return () => {
      alive = false;
    };
  }, [code.source]);

  // 강조 줄 표시 + 패널 안에서만 스크롤(페이지 스크롤은 건드리지 않는다)
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const lines = body.querySelectorAll<HTMLElement>('.line');
    lines.forEach((el, i) => {
      const on = line === i + 1;
      el.classList.toggle('is-hl', on);
      el.dataset.tone = on ? tone : '';
      if (on) {
        const top = el.offsetTop - body.offsetTop;
        if (top < body.scrollTop || top > body.scrollTop + body.clientHeight - el.offsetHeight) {
          body.scrollTop = Math.max(0, top - body.clientHeight / 3);
        }
      }
    });
  }, [html, line, tone]);

  const info = event ? phaseInfo(event.phase) : null;
  return (
    <div className="code">
      <div className="code__h small">
        <code className="code__path">{code.path}</code>
      </div>
      {code.example && (
        <p className="small dim">시안용 예시 코드 — 실제 구현은 개발자가 직접 쓴다(DESIGN §5.4).</p>
      )}
      <div ref={bodyRef} className="code__body">
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="code__plain">{code.source}</pre>
        )}
      </div>
      <div className="code__event" aria-live="off">
        {event && info ? (
          <>
            <div className="code__event-h small">
              <span className={`chip a${actors.indexOf(event.actor)}`}>
                {labels[actors.indexOf(event.actor)] ?? event.actor}
              </span>{' '}
              <span className={`badge t-${info.tone}`}>{info.label}</span>{' '}
              {line ? `${line}번 줄` : '줄 정보 없음'} · 실제 +{event.t.toFixed(1)}ms
            </div>
            {event.sql && (
              <pre className="sql">
                {event.sql}
                {event.rows !== undefined && `\n→ ${event.rows} rows`}
              </pre>
            )}
            {event.note && <p>{event.note}</p>}
          </>
        ) : (
          <p className="small dim">재생하면 이벤트를 낸 줄을 강조합니다.</p>
        )}
      </div>
    </div>
  );
}
