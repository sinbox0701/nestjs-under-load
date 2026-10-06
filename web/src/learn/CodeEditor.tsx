import Editor, { DiffEditor } from '@monaco-editor/react';
import { useEffect, useState } from 'react';
import type { Highlight } from './loader';
import { monaco } from './monaco-setup';
import { useResolvedTheme } from './useResolvedTheme';

type ICodeEditor = monaco.editor.ICodeEditor;

export interface EditorSide {
  /** 모델 구분용 경로(같은 경로면 같은 모델) */
  modelPath: string;
  source: string;
  language: string;
  highlights: Highlight[];
}

export interface CodeEditorProps {
  main: EditorSide;
  /** 있으면 나란히 비교(diff). main이 왼쪽(원본), compare가 오른쪽 */
  compare?: EditorSide | null;
  lineNumbers: boolean;
  minimap: boolean;
  /** 이 값이 바뀌면 해당 줄로 스크롤 */
  reveal?: { line: number; nonce: number } | null;
}

function md(h: Highlight): monaco.IMarkdownString {
  const text = h.text ? ` — ${h.text}` : '';
  return { value: `**@learn ${h.marker}**${text}\n\n${h.why}` };
}

const RULER: Record<Highlight['tone'], string> = {
  ok: '#1f7f45',
  bad: '#cc3b34',
  wait: '#e2ae24',
  retry: '#eb7a2c',
  info: '#2f6bcb',
};

/** 한 에디터에 focus 강조(거터 아이콘 + 배경 + 마커 호버)를 단다. */
function useHighlights(editor: ICodeEditor | null, highlights: Highlight[], source: string) {
  useEffect(() => {
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const max = model.getLineCount();
    const decos: monaco.editor.IModelDeltaDecoration[] = [];
    for (const h of highlights) {
      if (h.line > max) continue;
      const end = Math.min(h.endLine, max);
      decos.push({
        range: new monaco.Range(h.line, 1, end, model.getLineMaxColumn(end)),
        options: {
          isWholeLine: true,
          className: `lab-hl lab-hl--${h.tone}`,
          linesDecorationsClassName: `lab-hlbar lab-hlbar--${h.tone}`,
          overviewRuler: { color: RULER[h.tone], position: 4 },
        },
      });
      const lineMax = model.getLineMaxColumn(h.line);
      decos.push({
        range: new monaco.Range(h.line, 1, h.line, lineMax),
        options: {
          glyphMarginClassName: `lab-glyph lab-glyph--${h.tone}`,
          glyphMarginHoverMessage: md(h),
        },
      });
      // 마커 주석(`// @learn …`) 부분에만 점선 밑줄 + 호버
      const at = model.getLineContent(h.line).search(/\/\/\s*@learn\b/);
      if (at >= 0) {
        decos.push({
          range: new monaco.Range(h.line, at + 1, h.line, lineMax),
          options: { hoverMessage: md(h), inlineClassName: 'lab-marker' },
        });
      }
    }
    const col = editor.createDecorationsCollection(decos);
    const first = highlights[0];
    if (first && first.line <= max)
      editor.revealLinesInCenterIfOutsideViewport(first.line, first.endLine);
    return () => col.clear();
  }, [editor, highlights, source]);
}

const BASE: monaco.editor.IStandaloneEditorConstructionOptions = {
  readOnly: true,
  domReadOnly: true,
  glyphMargin: true,
  fontSize: 12,
  lineHeight: 18,
  fontFamily:
    "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  scrollBeyondLastLine: false,
  renderLineHighlight: 'none',
  automaticLayout: true,
  fixedOverflowWidgets: true,
  stickyScroll: { enabled: false },
  padding: { top: 8, bottom: 8 },
  contextmenu: false,
  occurrencesHighlight: 'off',
  renderValidationDecorations: 'off',
  lineDecorationsWidth: 6,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
};

export default function CodeEditor({
  main,
  compare,
  lineNumbers,
  minimap,
  reveal,
}: CodeEditorProps) {
  const theme = useResolvedTheme() === 'dark' ? 'nul-dark' : 'nul-light';
  const [left, setLeft] = useState<ICodeEditor | null>(null);
  const [right, setRight] = useState<ICodeEditor | null>(null);
  const options = {
    ...BASE,
    lineNumbers: lineNumbers ? ('on' as const) : ('off' as const),
    minimap: { enabled: minimap },
  };

  useHighlights(left, main.highlights, main.source);
  useHighlights(compare ? right : null, compare?.highlights ?? [], compare?.source ?? '');

  useEffect(() => {
    if (left && reveal) {
      left.revealLineInCenter(reveal.line);
      left.setPosition({ lineNumber: reveal.line, column: 1 });
    }
  }, [left, reveal]);

  if (compare) {
    return (
      <DiffEditor
        key="diff"
        height="100%"
        theme={theme}
        original={main.source}
        modified={compare.source}
        originalLanguage={main.language}
        modifiedLanguage={compare.language}
        originalModelPath={`diff-a/${main.modelPath}`}
        modifiedModelPath={`diff-b/${compare.modelPath}`}
        loading={<div className="lab-editor__loading small dim">에디터 불러오는 중…</div>}
        options={{
          ...options,
          renderSideBySide: true,
          // 휴대폰 폭에서만 한 줄(inline) diff로 바꾼다.
          useInlineViewWhenSpaceIsLimited: true,
          renderSideBySideInlineBreakpoint: 520,
          originalEditable: false,
          ignoreTrimWhitespace: true,
          renderOverviewRuler: false,
        }}
        onMount={(d) => {
          setLeft(d.getOriginalEditor());
          setRight(d.getModifiedEditor());
        }}
      />
    );
  }
  return (
    <Editor
      key="single"
      height="100%"
      theme={theme}
      path={main.modelPath}
      value={main.source}
      language={main.language}
      loading={<div className="lab-editor__loading small dim">에디터 불러오는 중…</div>}
      options={options}
      onMount={(e) => {
        setLeft(e);
        setRight(null);
      }}
    />
  );
}
