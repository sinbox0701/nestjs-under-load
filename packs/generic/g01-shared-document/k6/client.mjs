// G01 k6 클라이언트가 만드는 요청 본문(순수 함수). HTTP·k6 API 를 쓰지 않아 node 단위 테스트가 된다.
// 편집 모델(C10): 클라이언트는 읽은 필드 배열 뒤에 자기 editToken 을 붙여 저장한다.
// 서버가 성공이라고 한 수정의 토큰은 최종 문서에 남아 있어야 하고(no_lost_update), 사라지면 그게 lost update 다.

export const FIELDS = ['a', 'b', 'c', 'd'];

/** 12자 수정 토큰(서버 DTO 는 길이 12 를 요구한다). uuid 에서 하이픈을 빼고 앞 12자. */
export function makeEditToken(uuid) {
  return uuid.replace(/-/g, '').slice(0, 12);
}

/** doc.fields 를 복사해 field 배열 뒤에 token 을 붙인 새 fields. 원본은 건드리지 않는다. */
export function appendToken(fields, field, token) {
  return { ...fields, [field]: [...fields[field], token] };
}

/**
 * PUT 본문: 문서 전체 교체. version 은 "내가 읽은 시점의 버전"이다(버전 검사의 증거).
 * lease 는 edit-lease 에서만 넣는다(보유자·fence — 만료된 보유자의 늦은 저장을 서버가 거절하게 한다).
 */
export function buildPutBody(doc, field, token, lease) {
  const body = { version: doc.version, fields: appendToken(doc.fields, field, token), editToken: token };
  if (lease) body.lease = { holder: lease.holder, fence: lease.fence };
  return body;
}

/** PATCH 본문(field-merge): 바뀐 필드 하나만 보낸다. 다른 필드는 서버가 건드리지 않으므로 남의 수정과 겹치지 않는다. */
export function buildPatchBody(doc, field, token) {
  return { version: doc.version, field, value: [...doc.fields[field], token], editToken: token };
}

/**
 * blind-retry 의 재시도 본문. **fields 를 다시 계산하지 않는다**: 첫 시도의 본문을 그대로 두고 version 만 바꾼다.
 * 서버가 알려 준 currentVersion 은 버전 검사를 통과하게 해 주지만, fields 는 여전히 "내가 처음 읽은 옛 배열 + 내 토큰"이다.
 * 그래서 409 와 재시도 사이에 커밋된 앞사람 토큰이 최종 문서에서 사라진다(lost update).
 * 올바른 재시도(optimistic-version)는 다시 GET 해서 buildPutBody(최신 doc, …) 로 fields 를 새로 만든다.
 */
export function blindRetryBody(firstBody, currentVersion) {
  return { ...firstBody, version: currentVersion };
}
