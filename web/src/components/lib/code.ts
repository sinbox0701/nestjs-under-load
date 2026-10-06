/**
 * 코드 패널 모델(순수 함수): 이벤트 → 강조 줄 · SQL · 설명, 비교(diff + 공통 줄 접기).
 *
 * 코드 원문과 마커는 기록(Recording.code, scenarios/codeFor)이 준다.
 * - G01: 시안 예시 코드, 마커 = ⟦tag⟧ 이름
 * - G02: packs/generic/g02-stock-decrement/strategies/*.strategy.ts 원문, 마커 = `// @event <phase>`
 * 줄 찾기 순서: 이벤트 marker → codeRef(같은 파일) → phase 마커.
 */
import type { Tone } from '../../events/phases';
import { parseCodeRef, type CodeSource, type RunEvent } from '../../events/types';

export interface CodeHit {
  /** 강조 줄(1부터). */
  line: number;
  /** 같이 실행된 줄(파랑 8%). */
  also: number[];
  sql: string[];
  /** 한 줄 설명(rich text). */
  note: string;
  tone: 'bad' | 'ok' | 'wait' | 'retry' | 'info';
}

export function codeLines(code: CodeSource): string[] {
  return code.source.replace(/\n$/, '').split('\n');
}

/** `// @event a b c` 마커(첫 줄): 기록이 markers를 주지 않을 때. */
export function eventMarkers(lines: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  lines.forEach((ln, i) => {
    const m = /\/\/\s*@event\s+([^/—]+?)\s*$/.exec(ln);
    if (!m) return;
    for (const p of m[1]!.trim().split(/\s+/)) out[p] ??= i + 1;
  });
  return out;
}

function markersOf(code: CodeSource, lines: readonly string[]): Record<string, number> {
  return code.markers ?? eventMarkers(lines);
}

const lineToneOf = (t: Tone | undefined): CodeHit['tone'] =>
  t === 'bad' || t === 'wait' || t === 'ok' || t === 'retry' ? t : 'info';

/** 이벤트가 가리키는 줄. 없으면 null. */
export function eventLine(code: CodeSource, e: RunEvent): number | null {
  const lines = codeLines(code);
  const mk = markersOf(code, lines);
  const ok = (n: number | undefined): n is number => !!n && n >= 1 && n <= lines.length;
  if (e.marker && ok(mk[e.marker])) return mk[e.marker]!;
  if (e.codeRef) {
    const ref = parseCodeRef(e.codeRef);
    if ((ref.path === code.path || code.path.endsWith(ref.path)) && ok(ref.line)) return ref.line;
  }
  const byPhase = mk[e.phase] ?? mk[e.phase.replace(/^custom:/, '')];
  return ok(byPhase) ? byPhase : null;
}

/** 이벤트 → 강조 줄 · SQL · 설명. 같은 표(기록)에서 나오므로 서로 모순되지 않는다. */
export function resolveHit(
  code: CodeSource,
  e: RunEvent,
  phaseTone: (e: RunEvent) => Tone,
): CodeHit | null {
  const line = eventLine(code, e);
  if (!line) return null;
  const mk = markersOf(code, codeLines(code));
  const sql =
    e.sqlLines ??
    (e.sql
      ? [e.sql, ...(e.rows !== undefined ? [`→ ${e.rows} ${e.rows === 1 ? 'row' : 'rows'}`] : [])]
      : []);
  return {
    line,
    also: (e.markerAlso ?? []).map((m) => mk[m]).filter((n): n is number => !!n && n !== line),
    sql,
    note: e.codeNote ?? e.note ?? '',
    tone: lineToneOf(e.codeTone ?? phaseTone(e)),
  };
}

/** 강조 줄이 속한 메서드(클래스.메서드()) 또는 k6 스크립트. */
export function methodOf(code: CodeSource, lines: readonly string[], line: number): string {
  const cls = code.className ?? /export class (\w+)/.exec(code.source)?.[1] ?? '';
  if (code.clientFrom && line > code.clientFrom) return 'k6 스크립트';
  for (let i = line - 1; i >= 0; i--) {
    const m = /^\s+(?:private\s+|public\s+)?(?:async\s+)?(\w+)\(/.exec(lines[i]!);
    if (m && !/^(if|while|for|switch|catch)$/.test(m[1]!))
      return cls ? `${cls}.${m[1]}()` : `${m[1]}()`;
  }
  return cls;
}

// ---------------------------------------------------------------- 비교

/** LCS로 바뀐 줄 표시(a = 비교 대상, b = 지금). */
export function lcsDiff(
  a: readonly string[],
  b: readonly string[],
): { a: boolean[]; b: boolean[] } {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ra = new Array<boolean>(n).fill(false);
  const rb = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ra[i++] = true;
    else rb[j++] = true;
  }
  while (i < n) ra[i++] = true;
  while (j < m) rb[j++] = true;
  return { a: ra, b: rb };
}

export type FoldItem =
  | { type: 'line'; n: number; changed: boolean }
  | { type: 'fold'; key: string; from: number; to: number; lines: number[] };

/**
 * 비교 열: 바뀐 줄은 펼치고, 4줄 이상 이어진 공통 줄은 접는다(앞뒤 1줄은 남김).
 * 줄 번호는 1부터. `unfold`에 든 묶음은 편다.
 */
export function foldPlan(
  side: string,
  changed: readonly boolean[],
  unfold: ReadonlySet<string>,
): FoldItem[] {
  const out: FoldItem[] = [];
  const N = changed.length;
  let i = 0;
  while (i < N) {
    if (changed[i]) {
      out.push({ type: 'line', n: i + 1, changed: true });
      i++;
      continue;
    }
    let j = i;
    while (j < N && !changed[j]) j++;
    const key = `${side}:${i}`;
    if (j - i > 3 && !unfold.has(key)) {
      const head = i > 0 ? 1 : 0;
      const tail = j < N ? 1 : 0;
      for (let k = i; k < i + head; k++) out.push({ type: 'line', n: k + 1, changed: false });
      const a = i + head;
      const b = j - tail;
      out.push({
        type: 'fold',
        key,
        from: a + 1,
        to: b,
        lines: Array.from({ length: b - a }, (_, x) => a + x + 1),
      });
      for (let k = b; k < j; k++) out.push({ type: 'line', n: k + 1, changed: false });
    } else for (let k = i; k < j; k++) out.push({ type: 'line', n: k + 1, changed: false });
    i = j;
  }
  return out;
}

/** 강조 줄이 접힌 묶음 안에 있으면 그 묶음 key. */
export function foldKeyOf(items: readonly FoldItem[], line: number): string | null {
  for (const it of items) if (it.type === 'fold' && it.lines.includes(line)) return it.key;
  return null;
}
