// 시나리오 불변식 실행·판정. scripts/run.mjs 의 parseInvariantsSql·judgeInvariants 를 이식했다.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { InvariantResult } from '@under-load/contracts';

import type { InvariantRunner, ScenarioDef } from '../ports.js';
import { type PgConnect, withSession } from './pg.js';

export type InvariantSection = { name: string; sql: string };

/** `-- name: <id>` 구간으로 나눈다. 각 구간의 SQL 에서 주석·빈 줄은 유지하되 앞뒤 공백은 자른다. */
export function parseInvariantsSql(text: string): InvariantSection[] {
  const sections: { name: string; lines: string[] }[] = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const line of text.split('\n')) {
    const m = /^--\s*name:\s*([a-z0-9_]+)\s*$/.exec(line);
    if (m) {
      if (sections.some((s) => s.name === m[1])) throw new Error(`invariants.sql: 중복 이름 '${m[1]}'`);
      current = { name: m[1]!, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections.map(({ name, lines }) => {
    const sql = lines.join('\n').trim();
    const body = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .trim();
    if (!body) throw new Error(`invariants.sql: '${name}' 구간이 비어 있습니다`);
    return { name, sql };
  });
}

type Row = Record<string, unknown>;

/** manifest invariants(`sql: invariants.sql#name`)와 SQL 결과를 묶어 판정. 결과는 manifest 순서. */
export function judgeInvariants(invariants: ScenarioDef['invariants'], results: Record<string, Row | null>): InvariantResult[] {
  return invariants.map((inv) => {
    const name = inv.sql.split('#')[1] ?? '';
    const row = results[name] ?? null;
    if (inv.severity === 'info') return { id: inv.id, severity: inv.severity, violations: null, passed: null, value: row };
    const violations = row && typeof row.violations === 'number' && Number.isInteger(row.violations) && row.violations >= 0 ? row.violations : null;
    return { id: inv.id, severity: inv.severity, violations, passed: violations === 0 };
  });
}

/** pg 의 bigint·numeric 은 문자열로 온다. run.mjs parseCsvRow 처럼 숫자 문자열은 Number 로. */
function normalizeRow(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v]));
}

export type InvariantRunnerOptions = {
  connect: PgConnect;
  runDb: string;
  /** invariantsSqlPath 의 기준 디렉터리(레포 루트) */
  repoDir: string;
};

export function createInvariantRunner(opts: InvariantRunnerOptions): InvariantRunner {
  return {
    async run(scenario) {
      const file = path.resolve(opts.repoDir, scenario.invariantsSqlPath);
      const sections = parseInvariantsSql(await readFile(file, 'utf8'));
      const results: Record<string, Row | null> = {};
      await withSession(opts.connect, opts.runDb, async (s) => {
        // manifest 가 가리키는 구간만, 순서대로 실행한다. 구간이 없으면 결과 없음(critical 은 실패).
        for (const inv of scenario.invariants) {
          const name = inv.sql.split('#')[1] ?? '';
          const sec = sections.find((x) => x.name === name);
          if (!sec || name in results) continue;
          const r = await s.query(sec.sql);
          results[name] = r.rows[0] ? normalizeRow(r.rows[0]) : null;
        }
      });
      return judgeInvariants(scenario.invariants, results);
    },
  };
}
