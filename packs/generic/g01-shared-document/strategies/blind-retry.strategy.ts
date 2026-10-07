import { OptimisticVersionStrategy } from './optimistic-version.strategy';

/**
 * blind-retry — 맹목 재시도 (kind: broken)
 *
 * 서버 구현은 optimistic-version과 **완전히 같다**(이 클래스는 id만 바꾼다). 차이는 클라이언트(k6) 동작뿐이다(C10).
 *
 * 클라이언트가 하는 일(k6/blind-retry.js)
 * - 409를 받으면 응답 본문에서 `currentVersion`만 꺼내 **같은 본문**에 버전만 바꿔 다시 PUT 한다(재시도는 한 번).
 * - 최신 내용을 다시 읽지 않으므로, 재시도 본문은 앞사람 수정이 빠진 옛 배열 + 내 토큰이다.
 *
 * 왜 깨지나
 * - 재시도의 version은 현재 값이라 서버의 버전 검사(①·②)를 통과한다. 서버도 DB도 정상 저장으로 본다.
 * - 결과: 앞사람 토큰은 원장에 커밋됐는데 최종 문서에서 사라진다(no_lost_update 위반). 409를 "버전만 갱신하면 되는
 *   일시 오류"로 오해한 전형이다. 올바른 재시도는 다시 GET → 내 변경을 최신본에 다시 적용 → 새 버전으로 PUT(optimistic-version).
 * - 서버가 막을 방법은 없다. 버전은 "무엇을 보고 고쳤는가"의 증거인데, 클라이언트가 보지 않은 버전을 들고 오기 때문이다.
 */
export class BlindRetryStrategy extends OptimisticVersionStrategy {
  override readonly id: string = 'blind-retry';
}
