/**
 * 설명 문구의 작은 서식(rich text). 시나리오 생성기는 HTML을 만들지 않고 이 서식만 쓴다.
 *   **굵게**            → 강조
 *   {{term|보이는 말}}   → 용어 툴팁(TERMS[term])
 * 화면은 parseRich로 조각을 받아 그린다.
 */

/** "왜?" 용어 툴팁 — design/mockup.html TERMS 그대로. */
export const TERMS: Record<string, string> = {
  autocommit: '자동 커밋: BEGIN 없이 보낸 문장 하나가 곧 트랜잭션 하나다. 끝나면 바로 커밋된다.',
  flush:
    'flush: identity map에서 바뀐 엔티티를 찾아 UPDATE를 만든다. em.transactional 안이면 그 트랜잭션에서 실행되고(여기서는 원장·이력 INSERT와 함께 commit), 밖이면 스스로 BEGIN … COMMIT으로 감싼다.',
  identity:
    'identity map: EntityManager가 읽어 둔 엔티티 사본. flush는 이 사본의 바뀐 필드로 UPDATE를 만든다.',
  rows0:
    '0행 갱신: WHERE에 맞는 행이 없어 UPDATE가 아무것도 바꾸지 못한 것. DB 에러가 아니라서 ORM이 영향 행 수를 보고 OptimisticLockError로 바꾼다.',
  lockVersion:
    'lockVersion: findOne 옵션. 읽어 온 엔티티의 version과 메모리에서 비교만 한다(SQL·트랜잭션 없음). 다르면 OptimisticLockError, 값이 undefined면 검사를 건너뛴다. 동시에 도착한 저장은 이 비교를 둘 다 통과할 수 있어서, 실제 보장은 flush의 WHERE version = ? 가 한다.',
  lease:
    'lease(임대 잠금): 만료 시각이 있는 잠금. 쥔 사람이 사라져도 시간이 지나면 풀린다. DB 칼럼 locked_by·lease_until에 기록한다.',
  s423: '423 Locked: WebDAV(RFC 4918) 코드를 일부러 빌려 쓴다. 여기서는 편집 잠금 acquire 거절에만 쓰고 Retry-After를 함께 보낸다.',
  s409: '409 Conflict: 내가 알던 상태가 현재와 다르다. 저장 실패는 모두 409 + reason(version_mismatch | lease_lost | lease_expired).',
  rc: 'READ COMMITTED: PostgreSQL 기본 격리 수준. 문장마다 그 순간 커밋된 데이터를 본다.',
  epq: 'WHERE 재평가: READ COMMITTED에서 UPDATE가 행 락을 기다렸다가 앞 트랜잭션이 커밋하면, 최신 행으로 WHERE를 다시 검사한다(EvalPlanQual). 거짓이면 그 행을 건너뛴다 → 0 rows.',
  rowlock:
    '행 락: UPDATE가 고치는 행에 거는 락. 트랜잭션이 끝날 때 풀린다. 같은 행을 고치려는 다른 UPDATE는 기다린다.',
  fencing:
    'fencing 토큰(fence 칼럼): 잠금을 얻을 때마다 1씩 오르는 번호. save가 WHERE fence = ?로 함께 확인해, 잠금을 잃은 뒤(같은 사람이 다시 얻었더라도) 옛 세션이 늦게 보낸 저장을 거른다.',
  native:
    'nativeUpdate: identity map과 버전 검사를 거치지 않고 UPDATE를 바로 보낸다. MikroORM 7.1.4에서는 version + 1이 자동으로 붙지만 WHERE version 조건은 없다.',
  retryafter:
    'Retry-After: 몇 초 뒤 다시 시도하라는 응답 헤더. 서버가 줄을 세우는 게 아니라 클라이언트가 다시 온다.',
};

export type RichSeg =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'term'; text: string; term: string; tip: string };

const RE = /\*\*(.+?)\*\*|\{\{(\w+)\|([^}]+)\}\}/g;

/** 용어 표기 헬퍼: T('epq', 'WHERE 재평가') → "{{epq|WHERE 재평가}}". */
export const T = (term: string, label: string) => `{{${term}|${label}}}`;

export function parseRich(text: string): RichSeg[] {
  const out: RichSeg[] = [];
  let last = 0;
  for (const m of text.matchAll(RE)) {
    const i = m.index;
    if (i > last) out.push({ kind: 'text', text: text.slice(last, i) });
    if (m[1] !== undefined) out.push({ kind: 'bold', text: m[1] });
    else out.push({ kind: 'term', term: m[2]!, text: m[3]!, tip: TERMS[m[2]!] ?? '' });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** 서식을 벗긴 평문(툴팁·aria-label용). */
export function richToPlain(text: string): string {
  return parseRich(text)
    .map((s) => s.text)
    .join('');
}
