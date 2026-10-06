import type { ReactNode } from 'react';
import type { RecordingMeta, ServerSnapshot } from '../events/types';
import type { ScenarioId } from './lib/config';
import { Icon } from './lib/icons';
import { actorIdx, actorLabel, sessionState, type SessionState } from './lib/model';
import { SqlText, Term } from './lib/rich';

export interface ServerInsideProps {
  hasRec: boolean;
  scenario: ScenarioId;
  strategyId: string;
  meta: RecordingMeta;
  /** 재생 위치의 서버 속 스냅샷(기록이 준다). */
  snap: ServerSnapshot | null;
  /** P 이하 마지막 SQL(문장을 낸 사람과 문장). */
  lastSql: { actor: string; sql: string } | null;
}

function Why({ scenario }: { scenario: ScenarioId }) {
  if (scenario === 'g02-stock-decrement')
    return (
      <details className="why">
        <summary>왜? 격리 수준을 올리지 않고 무엇으로 막을까</summary>
        <p>
          READ COMMITTED에서 같은 행을 고치는 두 번째 UPDATE는 앞 트랜잭션의 행 잠금을 기다렸다가,
          커밋 뒤 최신 행으로 WHERE를 다시 검사한다(EvalPlanQual). 락 없이 읽은 값으로 계산한 상수를
          SET 하면(no-lock) 조건이 id뿐이라 그대로 통과해 앞의 차감을 덮어쓴다. 그래서 판정을
          WHERE에 넣거나(조건부 UPDATE: stock &gt;= qty, SET stock = stock - qty) 읽을 때 행을 먼저
          잠근다(SELECT … FOR UPDATE). 앱 메모리 락은 프로세스마다 따로라 앱이 2대면 서로를 모른다.
        </p>
      </details>
    );
  return (
    <details className="why">
      <summary>왜? 격리 수준을 올리면 덮어쓰기가 막힐까</summary>
      <p>
        못 막는다. 화면 열기(SELECT, 자동 커밋)와 저장(begin → UPDATE → 원장·이력 INSERT → commit)은{' '}
        <b>서로 다른 트랜잭션</b>이고, 그 사이에 사람의 편집 시간(초~분)이 끼어 있다. DB는 각
        트랜잭션 안쪽만 보므로 SERIALIZABLE로 올려도 &quot;B가 A보다 먼저 읽었다&quot;는 사실을
        모른다. 그래서 클라이언트가 본 버전을 저장 요청 본문(version)에 들고 와야 한다(서버는
        lockVersion + WHERE version으로 확인). (대비: 읽기와 쓰기가 한 트랜잭션 안이었다면
        SERIALIZABLE은 늦은 쪽을 40001 serialization_failure로 중단시킨다. 하지만 사람 편집 시간
        동안 트랜잭션을 열어 둘 수는 없다.) 동시에 도착한 두 UPDATE는 READ COMMITTED의 행 락 + WHERE
        재평가로 충분히 갈린다.
      </p>
    </details>
  );
}

function stateBadge(st: SessionState): ReactNode {
  if (st === 'active · Lock')
    return (
      <span className="badge t-wait">
        <Icon name="wait" />
        active · Lock
      </span>
    );
  if (st === 'idle in transaction')
    return (
      <span className="badge t-neutral" title="트랜잭션을 연 채 앱이 일하는 중(문장 실행 중 아님)">
        idle in transaction
      </span>
    );
  return <span className="badge t-info">active</span>;
}

function Tree({ p, chip }: { p: ServerInsideProps; chip: (id: string) => ReactNode }) {
  const s = p.hasRec ? p.snap : null;
  const label = (id: string) => actorLabel(p.meta, id);
  const rows: ReactNode[] = [];
  if (p.strategyId === 'edit-lease') {
    rows.push(
      <div key="h1" className="row h">
        편집 잠금 · locked_by / lease_until
      </div>,
    );
    const ls = s?.lease;
    if (ls) {
      rows.push(
        <div key="own" className="row">
          {chip(ls.holder)}
          {ls.expired ? (
            <>
              <span className="badge t-wait">
                <Icon name="wait" />
                만료
              </span>
              <span>칼럼엔 {label(ls.holder)}가 남았지만 다음 acquire가 가져감</span>
            </>
          ) : (
            <>
              <span className="badge t-info">
                <Icon name="lock" />
                보유
              </span>
              <span>lease_until = DB clock_timestamp() + 30s · fence {ls.fence}</span>
            </>
          )}
        </div>,
      );
      if (ls.holderState === 'paused')
        rows.push(
          <div key="pz" className="row child">
            {chip(ls.holder)}
            <span className="badge t-bad">
              <Icon name="stop" />
              멈춤
            </span>
            <span className="mute">
              GC·네트워크 단절 · 서버는 살아 있는지 모름 → TTL까지 잠금 유지
            </span>
          </div>,
        );
      else if (ls.holderState === 'left')
        rows.push(
          <div key="lf" className="row child">
            {chip(ls.holder)}
            <span className="badge t-bad">
              <Icon name="out" />
              이탈
            </span>
            <span className="mute">release 없음 → TTL 만료로만 회수</span>
          </div>,
        );
    } else
      rows.push(
        <div key="none" className="row mute">
          {s ? '보유자 없음' : '실행 전'}
        </div>,
      );
    rows.push(
      <div key="h2" className="row h">
        문 밖 · 클라이언트 쪽 재시도 (서버 큐 아님 · 순서 보장 없음)
      </div>,
    );
    const outside = s?.outside ?? [];
    if (outside.length)
      outside.forEach((id) =>
        rows.push(
          <div key={`o${id}`} className="row">
            {chip(id)}
            <span className="badge t-wait">
              <Icon name="lock" />
              423
            </span>
            <span className="mute">
              <Term k="retryafter">Retry-After</Term> 뒤 다시 노크 · 커넥션 없음
            </span>
          </div>,
        ),
      );
    else
      rows.push(
        <div key="no" className="row mute">
          없음
        </div>,
      );
    if (s?.stale)
      rows.push(
        <div key="stale" className="row">
          {chip(s.stale)}
          <span className="badge t-bad">
            <Icon name="stop" />
            멈춤
          </span>
          <span className="mute">잠금을 잃은 줄 모름 · 옛 fence를 든 채</span>
        </div>,
      );
    rows.push(
      <div key="h3" className="row h">
        DB 행 락
      </div>,
      <div key="m3" className="row mute">
        acquire·release는 한 문장(자동 커밋), save는 원장·이력 INSERT 뒤 commit까지 — 모두 ms 단위
      </div>,
    );
    return <div className="tree">{rows}</div>;
  }
  if (p.strategyId === 'app-memory-lock') {
    rows.push(
      <div key="h1" className="row h">
        앱 메모리 mutex · 인스턴스마다 따로 (pg_locks에 보이지 않음)
      </div>,
    );
    const locks = s?.memLocks ?? [];
    if (locks.length)
      locks.forEach((m) => {
        rows.push(
          <div key={`m${m.instance}`} className="row">
            <span className="badge t-neutral">{m.instance}</span>
            {m.holder ? (
              <>
                {chip(m.holder)}
                <span className="badge t-info">
                  <Icon name="lock" />
                  보유
                </span>
                <span>커밋이 끝난 뒤 finally에서 해제</span>
              </>
            ) : (
              <span className="mute">보유자 없음</span>
            )}
          </div>,
        );
        m.queue.forEach((id) =>
          rows.push(
            <div key={`q${m.instance}${id}`} className="row child">
              {chip(id)}
              <span className="badge t-wait">
                <Icon name="wait" />
                대기
              </span>
              <span className="mute">이벤트 루프 안 Promise로 대기 · DB 커넥션 없음</span>
            </div>,
          ),
        );
      });
    else
      rows.push(
        <div key="none" className="row mute">
          {s ? '보유자 없음' : '실행 전'}
        </div>,
      );
    rows.push(
      <div key="h2" className="row h">
        DB 행 락
      </div>,
    );
  }
  const rl = s?.rowLock;
  if (rl) {
    rows.push(
      <div key="own" className="row">
        {chip(rl.holder)}
        <span className="badge t-info">
          <Icon name="lock" />
          보유
        </span>
        <span>
          {p.scenario === 'g01-shared-document'
            ? 'UPDATE 실행됨 · 원장·이력 INSERT 뒤 commit 전'
            : p.strategyId === 'row-lock'
              ? 'SELECT … FOR UPDATE · 원장 INSERT 뒤 commit 전'
              : 'UPDATE 실행됨 · 원장 INSERT 뒤 commit 전'}
        </span>
      </div>,
    );
    rl.waiters.forEach((id) =>
      rows.push(
        <div key={`w${id}`} className="row child">
          {chip(id)}
          <span className="badge t-wait">
            <Icon name="wait" />
            대기
          </span>
          <span className="mute">
            {p.strategyId === 'row-lock' ? (
              <>{label(rl.holder)} 커밋 → 최신 커밋 버전을 다시 읽음</>
            ) : (
              <>
                {label(rl.holder)} 커밋 → <Term k="epq">WHERE 재평가</Term>
                {p.scenario === 'g01-shared-document' ? ' → 0행' : ''}
              </>
            )}
          </span>
        </div>,
      ),
    );
  } else
    rows.push(
      <div key="none2" className="row mute">
        {s ? '보유 중인 행 락 없음' : '실행 전'}
      </div>,
    );
  const tail =
    p.scenario === 'g02-stock-decrement'
      ? p.strategyId === 'row-lock'
        ? 'FOR UPDATE부터 커밋까지가 전부 보유 시간 — lock_timeout을 넘으면 55P03 → 503'
        : p.strategyId === 'conditional-update'
          ? '락 보유 = UPDATE ~ COMMIT · SELECT 왕복이 락 안에 없다'
          : '읽을 때는 아무것도 잠그지 않는다 — UPDATE가 잡은 행 락은 커밋까지'
      : p.strategyId === 'naive-overwrite'
        ? '편집 중엔 아무 락도 없고, 저장 트랜잭션도 버전을 확인하지 않는다'
        : '편집 중엔 락이 없다 — 저장 트랜잭션의 version 비교가 늦은 쪽을 거절';
  rows.push(
    <div key="tail" className="row mute">
      {tail}
    </div>,
  );
  return <div className="tree">{rows}</div>;
}

/** 서버 속 패널(DESIGN_SYSTEM §4.6). 처리 방식마다 보여 주는 락이 다르다. */
export function ServerInside(p: ServerInsideProps) {
  const s = p.hasRec ? p.snap : null;
  const chip = (id: string) => (
    <span className={`chip a${Math.max(0, actorIdx(p.meta, id)) % 4}`}>
      {actorLabel(p.meta, id)}
    </span>
  );
  const sessions = (s?.sessions ?? []).map((x) => ({ ...x, st: sessionState(x) }));
  const size = s?.pool.size ?? 10;
  const used = Math.min(size, sessions.length + (s?.pool.crowd ?? 0));
  const locked = sessions.filter((x) => x.st === 'active · Lock').length;
  const idle = size - used;
  const g01 = p.scenario === 'g01-shared-document';
  const lease = p.strategyId === 'edit-lease';
  return (
    <>
      <div className="kv">
        <span>격리 수준</span>
        <span>
          <span className="badge t-neutral">
            <Term k="rc">{p.meta.isolation || 'READ COMMITTED'}</Term>
          </span>{' '}
          PostgreSQL 기본값 · 처리 방식이 바꾸지 않음
        </span>
      </div>
      <Why scenario={p.scenario} />
      <div className="kv">
        <span>
          {lease ? (
            <>
              편집 잠금 (<Term k="lease">lease</Term> · DB 칼럼) → 문 밖 재시도 → DB 행 락
            </>
          ) : p.strategyId === 'app-memory-lock' ? (
            '앱 메모리 락 → DB 행 락'
          ) : (
            <>
              DB <Term k="rowlock">행 락</Term>
            </>
          )}
        </span>
        <span>{g01 ? 'document#7' : 'g02_product#1'}</span>
      </div>
      <Tree p={p} chip={chip} />
      <div className="kv">
        <span>커넥션 풀 (이 인스턴스)</span>
        <span>
          <b>
            {used}/{size}
          </b>{' '}
          사용 ·{' '}
          {s
            ? `대표 ${sessions.length}${s.pool.crowd ? ` + 다른 ${g01 ? '문서' : '요청'} ${s.pool.crowd}` : ''} · 풀 대기 0`
            : '대기 0'}
        </span>
      </div>
      <div className="pool" aria-hidden="true">
        {Array.from({ length: size }, (_, i) => (
          <i key={i} className={i < locked ? 'lk' : i < used ? 'on' : ''} />
        ))}
      </div>
      <div className="kv">
        <span>현재 SQL (파라미터 마스킹)</span>
        <span>{s && p.lastSql ? chip(p.lastSql.actor) : null}</span>
      </div>
      <div className="sql" title={s && p.lastSql ? p.lastSql.sql : ''}>
        {s && p.lastSql ? <SqlText sql={p.lastSql.sql} /> : '—'}
      </div>
      <div className="kv" style={{ marginTop: 'var(--s3)' }}>
        <span>DB 세션 (pg_stat_activity 샘플)</span>
        <span>
          {s
            ? `active ${sessions.filter((x) => x.st !== 'idle in transaction').length} · idle in transaction ${sessions.filter((x) => x.st === 'idle in transaction').length} · idle ${idle}`
            : ''}
        </span>
      </div>
      <ul className="tx">
        {sessions.length ? (
          <>
            {sessions.map((x) => (
              <li key={x.actor}>
                <span className="pid">
                  {chip(x.actor)}
                  {x.pid}
                </span>
                {stateBadge(x.st)}
                <span className="st" title={x.sql ?? ''}>
                  {x.sql ?? '(문장 사이 · 트랜잭션 열림)'}
                </span>
              </li>
            ))}
            {idle > 0 && (
              <li>
                <span className="pid">풀</span>
                <span className="badge t-neutral">idle</span>
                <span className="st">× {idle} · 트랜잭션 없음 · 다음 요청을 기다리는 커넥션</span>
              </li>
            )}
          </>
        ) : (
          <li>
            <span className="empty">
              {s ? '대표 세션 없음 — 지금은 아무도 DB에 있지 않다 (편집·대기는 DB 밖)' : '실행 전'}
            </span>
          </li>
        )}
      </ul>
      <p className="note">
        HTTP 요청 목록이 아니라 DB 세션입니다.{' '}
        {g01
          ? '편집 중인 사람, 423을 받고 다시 노크하려는 사람은 세션을 잡지 않습니다.'
          : p.strategyId === 'app-memory-lock'
            ? '앱 메모리 mutex를 기다리는 요청은 세션을 잡지 않습니다(pg_locks에도 없음).'
            : 'idle in transaction = 트랜잭션을 연 채 앱이 일하는 중(주입 지연 포함). 그동안 잡은 행 락은 풀리지 않습니다.'}
      </p>
      <p className="note">
        시계열(RED·USE·풀·PG)은 지표 화면의 Grafana가 그립니다. 여기는 Grafana가 못 그리는 것만.
      </p>
    </>
  );
}
