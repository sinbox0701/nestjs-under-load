import type { ReactNode } from 'react';
import { TERMS, parseRich } from '../../scenarios/rich';

/** 용어 표기(점선 밑줄, 마우스 올림·키보드 포커스로 툴팁 — DESIGN_SYSTEM §7). */
export function Term({ k, children }: { k: string; children: ReactNode }) {
  return (
    <span className="term" tabIndex={0} data-tip={TERMS[k] ?? ''}>
      {children}
    </span>
  );
}

/** 기록이 실은 설명 서식(**굵게**, {{용어|말}})을 React 노드로. HTML을 끼워 넣지 않는다. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {parseRich(text).map((seg, i) =>
        seg.kind === 'bold' ? (
          <b key={i}>{seg.text}</b>
        ) : seg.kind === 'term' ? (
          <Term key={i} k={seg.term}>
            {seg.text}
          </Term>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

const SQL_RE =
  /("version" = \$\d+|"locked_by" = \$\d+|"fence" = \$\d+|"lease_until" > clock_timestamp\(\)|"lease_until" <= clock_timestamp\(\)|"stock" >= \$\d+|for update)|\b(select|update|set|from|where|and|or|is|null|as|limit|returning|begin|commit|rollback|interval|insert|into|values)\b/g;

/** SQL 한 문장: 키워드 파랑, 경합 핵심 조건 노랑. */
export function SqlText({ sql }: { sql: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of sql.matchAll(SQL_RE)) {
    if (m.index > last) out.push(sql.slice(last, m.index));
    out.push(
      <span key={m.index} className={m[1] ? 'hl' : 'kw'}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < sql.length) out.push(sql.slice(last));
  return <>{out}</>;
}

/** SQL 상자 한 줄: 결과(→), 대기(⧗), 주석(--), begin/commit/rollback, 문장. */
export function SqlLine({ line }: { line: string }) {
  if (line.startsWith('→'))
    return <span className={`out ${/0 rows|423|409|503/.test(line) ? 'bad' : 'ok'}`}>{line}</span>;
  if (line.startsWith('⧗')) return <span className="hl">{line}</span>;
  if (line.startsWith('--')) return <span className="cm">{line}</span>;
  if (/^(begin|commit|rollback)$/.test(line))
    return <span className={`out ${line === 'rollback' ? 'bad' : ''}`}>{line}</span>;
  const m = /^(.*?)(\s+--.*)$/.exec(line);
  if (m)
    return (
      <>
        <SqlText sql={m[1]!} />
        <span className="cm">{m[2]}</span>
      </>
    );
  return <SqlText sql={line} />;
}
