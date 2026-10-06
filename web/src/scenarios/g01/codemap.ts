/**
 * G01 이벤트 → 코드 줄(마커 id)·SQL 상자·한 줄 설명, 자동 멈춤 설명.
 * design/mockup.html codeMap()·explain() 문구 그대로(HTML 대신 rich 서식: **굵게**, {{term|말}}).
 */
import type { Tone } from '../../events/phases';
import { T } from '../rich';
import { LEASE_VER, LEDGER_SQL, SQL } from './code';
import { EDITS, LABELS as L } from './constants';
import type { G01StrategyId } from './constants';
import type { MEvent } from './rounds';

export interface CodeHit {
  tag: string;
  also?: string[];
  sql: string[];
  note: string;
  tone?: Tone;
}

export function codeMap(s: G01StrategyId, e: MEvent, edit: number): CodeHit | null {
  const who = L[e.a]!;
  const lease = s === 'lease';
  const lbl = (i: number | undefined) => (i === undefined ? '?' : L[i]!);
  switch (e.phase) {
    case 'arrived':
      if (e.req === 'get')
        return {
          tag: 'cget',
          also: ['open'],
          sql: [],
          note: `${who}가 문서 화면을 연다(GET). 응답에 본문·수정 토큰 목록과 version이 함께 온다.`,
        };
      if (e.req === 'acq')
        return {
          tag: 'cpoll',
          also: ['acquire'],
          sql: [],
          note: `${who}가 고치기 전에 편집 잠금부터 요청한다(POST /lease).`,
        };
      if (e.retry)
        return s === 'blind'
          ? {
              tag: 'cretry',
              also: ['entry'],
              sql: [],
              note: `${who}가 409 때 받은 currentVersion ${e.rv}만 바꿔 **처음 본문 그대로** 다시 PUT. 서버가 볼 땐 정상 요청이다. 재시도는 if 한 번뿐이다.`,
              tone: 'bad',
            }
          : {
              tag: 'cretry',
              also: ['entry'],
              sql: [],
              note: `${who}가 병합본을 새 버전 v${e.rv}로 PUT.`,
            };
      if (e.late)
        return {
          tag: 'cput',
          also: ['save'],
          sql: [],
          note: `멈췄던 A가 깨어나 원래 보내려던 저장(fence ${e.fence})을 이제 보낸다. A는 그사이 잠금을 잃은 줄 모른다.`,
        };
      return {
        tag: 'cput',
        also: lease ? ['save'] : ['entry'],
        sql: [],
        note: lease
          ? `${who}가 잠금을 쥔 채 저장한다(PUT, fence ${e.fence}).`
          : s === 'naive'
            ? `${who}가 저장한다(PUT). version ${e.rv}을 보내지만 서버가 보지 않는다.`
            : `${who}가 저장한다(PUT, 화면을 열 때 받은 version ${e.rv}).`,
      };
    case 'db_read':
      if (lease)
        return {
          tag: 'cget',
          also: ['cpoll'],
          sql: [SQL.sel, `→ 1 row (version = ${e.v})`],
          note: `잠금을 쥔 ${who}만 본문을 받는다. ${T('autocommit', '자동 커밋')} SELECT.`,
        };
      if (!e.open)
        return {
          tag: 'cregget',
          also: s === 'opt' ? ['read'] : [],
          sql: [SQL.sel, `→ 1 row (version = ${e.v})`],
          note: `409를 받은 ${who}가 최신본(v${e.v})을 다시 받는다. 이제 내 변경을 이 위에 다시 적용한다.`,
        };
      return {
        tag: 'read',
        also: ['open', 'openret'],
        sql: [
          SQL.sel,
          `→ 1 row (version = ${e.v})`,
          '-- 자동 커밋: 이 읽기 트랜잭션은 여기서 끝난다',
        ],
        note: `${who}는 v${e.v}을 받아 화면에 둔다. 읽기 트랜잭션은 이미 끝났고, 이후 편집은 서버 밖(사람 시간)이다.${e.dup ? ' **앞사람과 같은 버전이다.**' : ''}`,
      };
    case 'editing':
      if (e.merge)
        return {
          tag: 'creapply',
          sql: [],
          note: `${who}가 최신본에 자기 변경을 다시 적용한다(자동 병합이 안 되면 사람이 고른다). 이 동안에도 서버는 아무것도 잡지 않는다.`,
        };
      return {
        tag: 'cedit',
        sql: [],
        note: lease
          ? `${who}가 편집한다(사람 시간 ${EDITS[edit]!.name}). 그동안 잠금을 쥐고 있어서 다른 사람은 423을 받는다. DB 세션은 없다.`
          : `${who}가 편집한다. 편집은 브라우저에서 일어나고 서버·DB는 아무것도 쥐고 있지 않다(트랜잭션·커넥션 없음).`,
      };
    case 'db_write':
      if (e.w === 'naive')
        return {
          tag: 'write',
          also: ['begin'],
          sql: ['begin', SQL.naive],
          note: `${T('native', 'nativeUpdate')}는 버전 검사 없이 바로 UPDATE한다. 원장·이력 INSERT와 한 트랜잭션(begin … commit)이지만 WHERE에 version이 없어서 앞사람 본문 위에 그대로 쓴다.`,
        };
      if (e.w === 'lease')
        return {
          tag: 'write',
          also: ['begin', 'save'],
          sql: ['begin', SQL.save + `  -- $4 = '${who}', $5 = ${e.fence}`],
          note: `보유자이고 fence가 같고 lease가 아직 유효할 때만 1행이 바뀐다. 조건은 DB 시계(clock_timestamp())로 판단한다. 같은 트랜잭션에서 원장·이력을 쓴 뒤 commit.`,
        };
      if (e.w === 'leaseFail')
        return {
          tag: 'write',
          also: ['begin', 'save'],
          sql: [
            'begin',
            SQL.save + `  -- $4 = 'A', $5 = ${e.fence}`,
            `→ 0 rows (지금 locked_by = '${lbl(e.owner)}', fence = ${e.curFence})`,
          ],
          note: `잠금이 이미 ${lbl(e.owner)}에게 넘어가 locked_by·fence가 둘 다 다르다 → ${T('rows0', '0행')}.`,
          tone: 'bad',
        };
      return {
        tag: 'flush',
        also: ['begin', 'check', 'assign'],
        sql: [
          'begin',
          SQL.sel,
          `→ 1 row (version = ${e.rv}, lockVersion ${e.rv}과 같음)`,
          SQL.opt + `  -- $5 = ${e.rv}`,
          ...(e.blocked ? ['⧗ 같은 행을 B가 갱신 중 → 행 락 대기'] : []),
        ],
        note: `트랜잭션을 연 뒤(원장을 같이 쓰려고) ${T('lockVersion', 'lockVersion')} 비교(메모리)를 통과하고, ${T('flush', 'flush')}가 WHERE version = ${e.rv}로 UPDATE한다.`,
      };
    case 'lock_wait':
      return {
        tag: 'flush',
        sql: [
          SQL.opt + `  -- $5 = ${e.rv}`,
          `⧗ ${lbl(e.owner)}의 트랜잭션이 이 행을 갱신 중 → 행 락 대기 (커넥션을 쥔 채)`,
        ],
        note: `READ COMMITTED에서 같은 행을 고치는 두 번째 UPDATE는 ${T('rowlock', '행 락')}을 기다린다. ${lbl(e.owner)}가 원장까지 쓰고 커밋하면 WHERE를 다시 평가한다.`,
        tone: 'wait',
      };
    case 'committed':
      if (lease)
        return {
          tag: 'commit',
          also: ['write', 'ledger'],
          sql: [`→ 1 row · returning version = ${e.v}`, ...LEDGER_SQL, 'commit'],
          note: `${who}의 저장 성공. 원장·이력이 같은 트랜잭션에 들어가 함께 커밋됐다. 이 시점 내용 = ${who}안.`,
          tone: 'ok',
        };
      if (s === 'naive')
        return {
          tag: 'commit',
          also: ['write', 'ledger'],
          sql: [`→ 1 row · returning version = ${e.v}`, ...LEDGER_SQL, 'commit'],
          note: `${who}의 저장 성공. 원장엔 ${who}의 수정 토큰이 남았다. 이 시점 내용 = ${who}안. (version은 올랐지만 아무도 확인하지 않았다)`,
          tone: 'ok',
        };
      return {
        tag: 'commit',
        also: ['flush', 'ledger', 'return'],
        sql: [`→ 1 row · returning version = ${e.v}`, ...LEDGER_SQL, 'commit'],
        note: `v${e.v} 저장 성공. UPDATE와 원장·이력 INSERT가 한 트랜잭션으로 커밋됐다.`,
        tone: 'ok',
      };
    case 'lost':
      if (e.blind)
        return {
          tag: 'cretry',
          also: ['flush'],
          sql: [
            SQL.opt + `  -- version 비교는 통과`,
            '→ 1 row (앞사람 수정 위에 옛 본문)',
            '-- 원장엔 두 토큰 모두 커밋 · 최종 이력엔 덮인 쪽 토큰이 없다',
          ],
          note: `${lbl(e.by)}의 재시도가 버전 검사를 통과해 ${who}의 수정을 지웠다. 409를 "버전만 갱신하면 되는 오류"로 다룬 결과다.`,
          tone: 'bad',
        };
      return {
        tag: 'write',
        sql: [
          SQL.naive,
          `→ 1 row (${who}가 쓴 본문 위에 그대로)`,
          '-- 원장엔 두 토큰 모두 커밋 · 최종 이력엔 덮인 쪽 토큰이 없다',
        ],
        note: `${lbl(e.by)}의 UPDATE가 ${who}가 방금 쓴 본문을 덮었다. DB 입장에선 정상 갱신이라 에러가 나지 않는다.`,
        tone: 'bad',
      };
    case 'conflict':
      if (e.via === 'recheck')
        return {
          tag: '409',
          also: ['flush', 'catch', 'reread'],
          sql: [
            `-- ${lbl(e.owner)} commit → 최신 행으로 WHERE 재평가: version ${e.cur} ≠ ${e.rv}`,
            '→ 0 rows',
            'rollback',
            SQL.sel + '  -- 재조회 (트랜잭션 밖)',
            `→ HTTP 409 { reason: "version_mismatch", currentVersion: ${e.cur}, current: "…" }`,
          ],
          note: `${T('epq', 'WHERE 재평가')} 결과 ${T('rows0', '0행')}. MikroORM이 영향 행 수 0을 보고 OptimisticLockError를 던지고(실패 지점 ②) 트랜잭션은 rollback(원장 INSERT 전이라 남는 것 없음). 서비스가 currentVersion을 다시 조회해 ${T('s409', '409')} version_mismatch로 바꾼다.`,
          tone: 'bad',
        };
      if (e.via === 'lease')
        return {
          tag: '409',
          also: ['lost', 'reread'],
          sql: [
            SQL.sel + '  -- 재조회 (같은 트랜잭션)',
            `→ 1 row (locked_by = '${lbl(e.owner)}', fence = ${e.curFence}, version = ${e.cur})`,
            'rollback',
            `→ HTTP 409 { reason: "lease_lost", currentVersion: ${e.cur}, current: "…" }`,
          ],
          note: `locked_by·fence가 다르니 lease_lost. currentVersion ${e.cur}은 ${lbl(e.owner)}의 acquire(+1) 뒤의 값이다. 저장 실패는 ${T('s409', '409')}로 통일하고 reason으로 구분한다. 예외로 rollback되어 원장은 남지 않는다.`,
          tone: 'bad',
        };
      return {
        tag: '409',
        also: e.again ? ['check', 'catch', 'reread', 'cretry'] : ['check', 'catch', 'reread'],
        sql: [
          'begin',
          SQL.sel,
          `→ 1 row (version = ${e.cur})`,
          `-- 메모리 비교: lockVersion ${e.rv} ≠ 엔티티 version ${e.cur} → OptimisticLockError (UPDATE 없음)`,
          'rollback',
          `→ HTTP 409 { reason: "version_mismatch", currentVersion: ${e.cur}, current: "…" }`,
        ],
        note: e.again
          ? `${who}의 재시도가 기억한 v${e.rv}는 이미 낡았다(현재 v${e.cur}). 클라이언트는 if 한 번만 재시도하므로 이 409로 끝난다.`
          : `${T('lockVersion', 'lockVersion')} 비교(실패 지점 ①, 메모리 비교)에서 걸렸다. UPDATE 없이 rollback. 응답에 currentVersion과 현재 내용을 싣는다. 동시에 도착했다면 둘 다 여기를 통과하고 ②(flush 0행)에서 갈린다.`,
        tone: 'bad',
      };
    case 'retry':
      if (lease)
        return {
          tag: 'cpoll',
          sql: [],
          note: `${who}가 ${T('retryafter', 'Retry-After')}만큼 쉬었다가 다시 노크한다. 서버는 누가 먼저 왔는지 기억하지 않는다.`,
          tone: 'retry',
        };
      if (e.blind)
        return {
          tag: 'cregget',
          also: ['c409'],
          sql: [],
          note: `${who}는 409 본문에서 currentVersion(${e.rv})만 꺼낸다. 최신 내용은 보지 않는다 — 여기가 고장이다.`,
          tone: 'bad',
        };
      return {
        tag: 'c409',
        also: ['cregget', 'creapply'],
        sql: [],
        note: `올바른 재시도: 다시 GET → 내 변경을 최신본에 다시 적용(병합 또는 사용자 결정) → 새 버전으로 PUT.`,
        tone: 'retry',
      };
    case 'lock_acquired':
      return {
        tag: 'take',
        also: ['acqwhere'],
        sql: [SQL.acq, `→ 1 row · returning version = ${e.v}`, `-- fence = ${e.fence}`],
        note: `${e.take === 'expired' ? '만료된 잠금을 회수했다. ' : ''}조건부 UPDATE 한 번(${T('autocommit', '자동 커밋')})이 확인과 기록을 같이 한다. fence가 ${e.fence}로 오르고, 이 번호를 클라이언트가 save·release에 들고 온다. 만료 시각은 DB 시계(clock_timestamp() + 30s). ${LEASE_VER}`,
      };
    case 'lease_rejected':
      return {
        tag: '423',
        also: ['held', 'acqwhere'],
        sql: [
          SQL.acq,
          `→ 0 rows (locked_by = '${lbl(e.owner)}', lease 유효)`,
          '→ HTTP 423 Locked · Retry-After: 1',
        ],
        note: `${T('rows0', '0행')} → ${T('s423', '423')}. 서버는 대기열을 만들지 않고 바로 응답을 끝낸다. 커넥션·트랜잭션은 남지 않는다.`,
        tone: 'wait',
      };
    case 'lock_released':
      return {
        tag: 'release',
        also: ['crel'],
        sql: [SQL.rel + `  -- $4 = '${who}', $5 = ${e.fence}`, '→ 1 row'],
        note: `내 잠금·내 fence일 때만 푼다(자동 커밋 한 문장). 잠금을 잃은 옛 세션은 새 보유자의 잠금을 풀 수 없다. 해제 없이 떠나면 lease_until이 지나야 풀린다.`,
      };
    case 'holder_left':
      return {
        tag: 'crel',
        sql: [],
        note: `A가 떠나 이 줄(release)이 실행되지 않았다. locked_by = 'A'가 남고, lease_until이 지나야 다음 acquire가 가져간다(TTL 회수). 서버 인스턴스와는 상관없다 — 잠금은 DB 칼럼이다.`,
        tone: 'bad',
      };
    case 'holder_paused':
      return {
        tag: 'cput',
        sql: [],
        note: `A의 클라이언트가 이 줄(저장)을 보내기 직전에 멈췄다(GC·네트워크 단절). A가 든 fence ${e.fence}는 잠금이 다른 사람에게 넘어가면 무효가 된다.`,
        tone: 'bad',
      };
    case 'lease_expired':
      return {
        tag: 'acqwhere',
        sql: [
          '-- lease_until ≤ clock_timestamp() : 다음 acquire의 WHERE("lease_until" <= clock_timestamp())에 맞는다',
        ],
        note: `TTL이 지나 잠금이 효력을 잃었다. 칼럼 값은 그대로지만 다음 acquire가 덮어쓰고 fence를 올린다.`,
        tone: 'wait',
      };
    case 'responded':
      if (/^409/.test(e.d))
        return lease
          ? {
              tag: 'cput',
              sql: [],
              note: `${who}에게 409 lease_lost. 클라이언트는 다시 잠금부터 얻어야 한다.`,
              tone: 'bad',
            }
          : {
              tag: 'cretry',
              also: ['c409'],
              sql: [],
              note: `${who}에게 두 번째 409. 재시도는 if 한 번뿐이라 여기서 실패로 끝난다(수정은 저장되지 않음).`,
              tone: 'bad',
            };
      return lease
        ? { tag: 'crel', sql: [], note: `${who}에게 응답.` }
        : {
            tag: 'return',
            also: ['cput'],
            sql: [],
            note:
              s === 'naive'
                ? `${who}에게 200 OK. 클라이언트는 덮어쓰였는지 알 수 없다.`
                : `${who}에게 응답.`,
          };
  }
  return null;
}

/** 대표 SQL 문장(SQL 상자 첫 select/update/insert). */
export function stmtOf(hit: CodeHit | null): string | undefined {
  return hit?.sql.find((x) => /^(select|update|insert)/.test(x));
}

/** 실제 ms 표기(무대 ms ÷ 40, 소수 1자리) — 시안 realMs. */
const realMs = (stageMs: number) => (stageMs / 40).toFixed(1);

/**
 * 자동 멈춤 설명. events = 같은 멈춤으로 묶인 이벤트들(시안 explain(c)).
 * firstRead = 같은 라운드 A의 첫 읽기 시각(원인 장면 설명용).
 */
export function explain(s: G01StrategyId, events: MEvent[], firstRead: number | undefined): string {
  const e = events[0]!;
  const who = [...new Set(events.map((x) => L[x.a]))].join(', ');
  const lbl = (i: number | undefined) => (i === undefined ? '?' : L[i]!);
  switch (e.phase) {
    case 'db_read':
      return `**${L[e.a]}도 같은 버전(v${e.v})을 받았다 — 아직 아무도 저장 전** ${
        firstRead === undefined
          ? `${L[e.a]}는 +${realMs(e.t)}ms에 읽었다.`
          : `A는 +${realMs(firstRead)}ms, ${L[e.a]}는 +${realMs(e.t)}ms에 읽었다.`
      } 같은 버전을 들고 각자 편집을 시작한다. 이 순간이 원인이다.`;
    case 'lost':
      if (e.blind)
        return `**${lbl(e.by)}가 버전만 바꿔 같은 본문을 다시 보냄 → ${L[e.a]}의 수정이 사라짐** 409를 "버전만 갱신하면 되는 오류"로 다룬 결과다. 버전 검사는 통과하므로 서버도 DB도 모른다.`;
      return `**${lbl(e.by)}가 ${L[e.a]}의 수정을 덮어씀** — 잃어버린 수정 +1.${
        e.byRead !== undefined && e.vSave !== undefined
          ? ` ${lbl(e.by)}는 +${realMs(e.byRead)}ms에 읽었다 — ${L[e.a]}가 저장한 +${realMs(e.vSave)}ms보다 먼저.`
          : ''
      } 둘 다 200 OK라 아무도 모른다.`;
    case 'conflict':
      if (e.via === 'recheck')
        return `**${L[e.a]}의 UPDATE가 0행** — B의 행 락을 기다렸다가, B 커밋 뒤 PostgreSQL이 최신 행으로 WHERE version = ${e.rv}를 다시 검사했다(현재 v${e.cur} — 거짓) → 0 rows → OptimisticLockError → rollback(원장도 안 남음) → 409, currentVersion ${e.cur}.`;
      if (e.via === 'lease')
        return `**깨어난 A의 늦은 저장이 409 (lease_lost)** — A가 멈춘 사이 TTL이 지나 ${lbl(e.owner)}가 잠금을 가져갔다(fence ${e.curFence}). save의 WHERE locked_by = 'A' AND fence = ${e.fence} AND lease_until > clock_timestamp()가 0행 → 재조회(locked_by = '${lbl(e.owner)}') → rollback. currentVersion ${e.cur}은 ${lbl(e.owner)}의 acquire(+1)까지 반영된 값이다.`;
      if (e.again)
        return `**${who}의 재시도도 409 — 여기서 실패로 끝남** 409 때 기억한 v${e.rv}로 다시 보냈지만, 그 사이 다른 사람의 재시도가 v${e.cur}로 올렸다. 클라이언트 코드는 if 한 번만 재시도하므로 더 보내지 않는다. 이 수정은 저장되지 않았고 본인은 실패를 안다.`;
      return `**${who}의 저장이 409로 거절됨** — 들고 온 v${e.rv} ≠ 현재 v${e.cur}. UPDATE를 보내기 전에 lockVersion 메모리 비교에서 걸렸다. 응답 본문에 currentVersion ${e.cur}과 현재 내용이 실린다. 다음: ${s === 'blind' ? '(고장) 버전만 바꿔 같은 body로 다시 PUT' : '다시 GET → 내 변경을 최신본에 다시 적용 → 새 버전으로 PUT'}.`;
    case 'lock_wait':
      return `**${L[e.a]}의 UPDATE가 B의 행 락을 기다린다** — 둘 다 WHERE version = ${e.rv}로 거의 동시에 도착했다. 먼저 잡은 B가 커밋할 때까지 DB 안에서 대기한다(커넥션을 쥔 채).`;
    case 'lease_rejected':
      return `**${who}는 423을 받고 문 밖으로** — 서버는 줄을 세우지 않는다. 클라이언트가 Retry-After 뒤 다시 노크(폴링)하고, 먼저 온 순서는 보장되지 않는다. 기다리는 동안 DB 커넥션·트랜잭션은 없다.`;
    case 'holder_left':
      return `**잠금을 쥔 A가 떠났다 — release를 보내지 않았다** 탭을 닫거나 이탈하면 DELETE /lease가 오지 않는다. locked_by = 'A'가 DB 칼럼에 남아, lease_until(DB 시계)이 지날 때까지 다른 사람은 423을 받는다. 회수는 TTL 만료로만 된다.`;
    case 'holder_paused':
      return `**잠금을 쥔 A의 클라이언트가 멈췄다 (GC·네트워크 단절)** A는 아직 잠금을 쥐었다고 믿고 fence ${e.fence}를 들고 있다. 서버는 A가 살아 있는지 모르니 lease_until이 지나야 풀린다. 깨어나 늦게 저장하면 fence로 거른다.`;
    case 'lease_expired':
      return `**TTL 만료** — lease_until ≤ clock_timestamp()라서 다음 acquire의 조건(만료된 잠금)에 맞는다. 다음에 노크하는 사람이 회수한다. 시각은 DB 시계로 잰다.`;
  }
  return '';
}
