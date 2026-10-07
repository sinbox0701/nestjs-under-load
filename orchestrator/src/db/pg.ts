// pg 연결 추상. DbAdmin·InvariantRunner 가 이 모양으로만 쓰므로 테스트는 SQL 기록 가짜로 갈아 끼운다.
import pg from 'pg';

import type { OrchestratorConfig } from '../config.js';

export type PgSession = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};

/** database 이름으로 관리자 연결 1개를 연다. 호출자가 end() 한다. */
export type PgConnect = (database: string) => Promise<PgSession>;

export function createPgConnect(cfg: OrchestratorConfig['pg']): PgConnect {
  return async (database) => {
    const client = new pg.Client({ host: cfg.host, port: cfg.port, user: cfg.adminUser, password: cfg.adminPassword, database });
    client.on('error', () => {
      // 유휴 연결 오류는 다음 query 에서 드러난다. 프로세스를 죽이지 않는다.
    });
    await client.connect();
    return {
      query: async (sql, params) => ({ rows: (await client.query(sql, params)).rows as Record<string, unknown>[] }),
      end: () => client.end(),
    };
  };
}

/** 식별자 인용(DB·역할 이름). */
export const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** 문자열 리터럴 인용(standard_conforming_strings=on 기준). */
export const quoteLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** 연결을 열어 fn 을 돌리고 반드시 닫는다. */
export async function withSession<T>(connect: PgConnect, database: string, fn: (s: PgSession) => Promise<T>): Promise<T> {
  const s = await connect(database);
  try {
    return await fn(s);
  } finally {
    await s.end().catch(() => {});
  }
}
