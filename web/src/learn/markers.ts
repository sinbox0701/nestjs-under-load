/**
 * 코드 마커 `// @learn <marker-id> — <한 줄 설명>`으로 강조 줄을 찾는다.
 * 계측 마커 `// @event <phase>`와는 별개다(같은 줄 근처에 함께 있어도 된다).
 */

export interface MarkerHit {
  id: string;
  /** 마커 주석 줄(1부터) */
  line: number;
  /** 마커가 가리키는 코드 끝 줄(1부터). 마커 줄 자신이 코드이면 line과 같다. */
  endLine: number;
  /** 마커 설명(대시 뒤 문장). 없으면 빈 문자열 */
  text: string;
}

const MARKER = /\/\/\s*@learn\s+([A-Za-z0-9_.-]+)\s*(?:[—–-]+\s*(.*))?$/;
const COMMENT_ONLY = /^\s*(\/\/|\/\*|\*)/;
const STATEMENT_END = /[;{}]\s*$|\)\s*$|^\s*\)/;
const MAX_SPAN = 8;

/** 마커 다음에 오는 첫 코드 문장의 끝 줄을 찾는다(빈 줄·주석은 건너뜀). */
function statementEnd(lines: string[], from: number): number {
  let i = from;
  while (i < lines.length && (lines[i]!.trim() === '' || COMMENT_ONLY.test(lines[i]!))) i++;
  if (i >= lines.length) return from - 1;
  const start = i;
  while (i < lines.length - 1 && i - start < MAX_SPAN && !STATEMENT_END.test(lines[i]!)) i++;
  return i;
}

export function parseMarkers(source: string): Map<string, MarkerHit> {
  const lines = source.split(/\r?\n/);
  const out = new Map<string, MarkerHit>();
  lines.forEach((raw, idx) => {
    const m = MARKER.exec(raw);
    if (!m) return;
    const id = m[1]!;
    if (out.has(id)) return; // 같은 id가 또 있으면 첫 번째만
    const codeBefore = raw.slice(0, m.index).trim();
    const end = codeBefore ? idx : statementEnd(lines, idx + 1);
    out.set(id, { id, line: idx + 1, endLine: Math.max(idx, end) + 1, text: (m[2] ?? '').trim() });
  });
  return out;
}

export function findMarker(source: string, id: string): MarkerHit | null {
  return parseMarkers(source).get(id) ?? null;
}
