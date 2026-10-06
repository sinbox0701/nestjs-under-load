/**
 * Monaco를 CDN 없이 로컬 번들로 쓴다(@monaco-editor/react 기본값은 CDN 로더).
 * 이 모듈은 코드 실험실 청크에서만 불린다.
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_id, label) {
    return label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker();
  },
};

// 읽기 전용 학습 화면: import 대상(@nestjs 등)이 없어 생기는 빨간 밑줄을 끈다.
const noDiag = {
  noSemanticValidation: true,
  noSyntaxValidation: true,
  noSuggestionDiagnostics: true,
};
monaco.typescript.typescriptDefaults.setDiagnosticsOptions(noDiag);
monaco.typescript.javascriptDefaults.setDiagnosticsOptions(noDiag);

// theme/tokens.css의 4가지 문법 색(키워드·문자열·주석·기본)만 쓴다.
const rules = (
  kw: string,
  str: string,
  cm: string,
  fg: string,
): monaco.editor.ITokenThemeRule[] => [
  { token: '', foreground: fg },
  { token: 'keyword', foreground: kw },
  { token: 'string', foreground: str },
  { token: 'string.sql', foreground: str },
  { token: 'comment', foreground: cm, fontStyle: 'italic' },
  { token: 'number', foreground: fg },
  { token: 'type', foreground: fg },
  { token: 'operator.sql', foreground: kw },
];
monaco.editor.defineTheme('nul-light', {
  base: 'vs',
  inherit: false,
  rules: rules('2f6bcb', '94704f', '5a6170', '1e222a'),
  colors: {
    'editor.background': '#f6f7f3',
    'editor.foreground': '#1e222a',
    'editorLineNumber.foreground': '#9aa2af',
    'editorLineNumber.activeForeground': '#1e222a',
    'editorGutter.background': '#eceeea',
    'editor.selectionBackground': '#b9c0ca',
    'editorIndentGuide.background1': '#dadde1',
    'editorWidget.background': '#f6f7f3',
    'editorWidget.border': '#1e222a',
    'editorHoverWidget.background': '#f6f7f3',
    'editorHoverWidget.border': '#1e222a',
    'diffEditor.insertedTextBackground': '#1f7f4522',
    'diffEditor.removedTextBackground': '#cc3b3422',
    'diffEditor.insertedLineBackground': '#1f7f4514',
    'diffEditor.removedLineBackground': '#cc3b3414',
  },
});
monaco.editor.defineTheme('nul-dark', {
  base: 'vs-dark',
  inherit: false,
  rules: rules('8fb6f2', 'd2a982', '9aa2af', 'e8eaed'),
  colors: {
    'editor.background': '#181b20',
    'editor.foreground': '#e8eaed',
    'editorLineNumber.foreground': '#5a6170',
    'editorLineNumber.activeForeground': '#e8eaed',
    'editorGutter.background': '#1f232a',
    'editor.selectionBackground': '#3a404b',
    'editorIndentGuide.background1': '#2a2f37',
    'editorWidget.background': '#1f232a',
    'editorWidget.border': '#3a404b',
    'editorHoverWidget.background': '#1f232a',
    'editorHoverWidget.border': '#3a404b',
    'diffEditor.insertedTextBackground': '#4cc27c26',
    'diffEditor.removedTextBackground': '#f06a5f26',
    'diffEditor.insertedLineBackground': '#4cc27c14',
    'diffEditor.removedLineBackground': '#f06a5f14',
  },
});

loader.config({ monaco });

export { monaco };
