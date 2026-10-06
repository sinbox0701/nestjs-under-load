import type { RunEvent } from '../events/types';

export interface ServerInsideProps {
  sampleCount: number;
  /** 락이 없는 방식이면 왜 없는지 한 줄. */
  noLockReason: string | null;
  lastSql: RunEvent | null;
  actorLabel: (actor: string) => string;
}

/** 서버 속 패널 축약(DESIGN_SYSTEM §4.6). 락 트리·풀·트랜잭션은 PG 프로브 연결 뒤 채운다. */
export function ServerInside({
  sampleCount,
  noLockReason,
  lastSql,
  actorLabel,
}: ServerInsideProps) {
  return (
    <div className="server">
      <p className="small dim">샘플: 대표 {sampleCount}명분</p>
      <h3 className="server__h">락 보유/대기</h3>
      <p className="small">{noLockReason ?? '—'}</p>
      <h3 className="server__h">커넥션 풀</h3>
      <p className="small dim">PG 프로브 연결 전(—)</p>
      <h3 className="server__h">현재 SQL</h3>
      {lastSql?.sql ? (
        <pre className="sql" title={lastSql.sql}>
          {actorLabel(lastSql.actor)} · {lastSql.sql}
          {lastSql.rows !== undefined && `\n→ ${lastSql.rows} rows`}
        </pre>
      ) : (
        <p className="small dim">아직 나간 SQL 없음</p>
      )}
    </div>
  );
}
