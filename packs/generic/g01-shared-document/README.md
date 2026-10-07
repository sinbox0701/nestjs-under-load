# G01 같은 문서 동시 수정

여럿이 같은 문서를 읽고 각자 고쳐 저장할 때, 늦게 저장한 쪽이 앞사람 수정을 덮어써 사라지게 하는(lost update) 조건과 그것을 막는 방법을 비교한다.
응답은 둘 다 200이라 겉으로는 아무 일도 없어 보인다. 판정은 DB에 남은 사실(원장의 성공 토큰과 최종 문서)로 한다.

- 시나리오 정의: `docs/SCENARIOS.md` G01
- 학습 데이터(코드 실험실): [`learn.yaml`](learn.yaml) — 개념, 상황 5개, strategy × 상황 판정 25칸, "이 상황이면 이 코드"
- 실행 정의: [`manifest.yaml`](manifest.yaml), k6 클라이언트: [`k6/template.js`](k6/template.js)·[`k6/client.mjs`](k6/client.mjs)
- 불변식: [`invariants.sql`](invariants.sql)

## 편집 모델

한 사람의 한 번 = 문서를 연다(`GET`, 자동 커밋 SELECT) → 편집 시간(`EDIT_MS`, 실제의 초~분을 ms로 압축)만큼 고친다 → 저장한다(`PUT`, field-merge만 `PATCH`).
저장은 "읽은 필드 배열 뒤에 내 수정 토큰(12자)을 붙인 것"이고, 클라이언트는 **GET 때 받은 version을 본문에 들고 온다**.
서버가 성공이라고 답한 토큰이 최종 문서에 없으면 그것이 잃어버린 갱신이다(`no_lost_update`).

## strategy

| id | 종류 | 한 줄 요약 | 코드 |
| --- | --- | --- | --- |
| `naive-overwrite` | broken | `nativeUpdate`로 `WHERE id`만 걸고 덮어쓴다. version은 올라가지만 아무도 비교하지 않는다 | [strategies/naive-overwrite.strategy.ts](strategies/naive-overwrite.strategy.ts) |
| `blind-retry` | broken | 서버는 optimistic-version과 같다. 클라이언트가 409 뒤 **버전만 바꿔 같은 본문**을 다시 보낸다 | [strategies/blind-retry.strategy.ts](strategies/blind-retry.strategy.ts), [k6/client.mjs](k6/client.mjs) `blindRetryBody` |
| `optimistic-version` | fixed | `lockVersion` 메모리 비교(①) + flush `UPDATE … WHERE version = ?` 0행(②) → 409. 클라이언트는 다시 GET → 재적용 → PUT | [strategies/optimistic-version.strategy.ts](strategies/optimistic-version.strategy.ts) |
| `field-merge` | tradeoff | 바뀐 필드만 PATCH, 그 필드의 마지막 변경 버전으로 조건부 UPDATE. 같은 필드끼리만 409 | [strategies/field-merge.strategy.ts](strategies/field-merge.strategy.ts) |
| `edit-lease` | tradeoff | 편집 전 잠금(`locked_by`·`lease_until`·`fence`). 거절은 423 + 클라이언트 폴링(서버 큐 없음), 늦은 저장은 fence로 409 | [strategies/edit-lease.strategy.ts](strategies/edit-lease.strategy.ts) |

응답 계약: 저장 실패는 모두 **409**(`version_mismatch` | `lease_lost` | `lease_expired`), acquire 거절만 **423**(`Retry-After`), 버전 누락은 **428**.

## 예측 질문

실행하기 전에 답을 적어 두고, 결과(불변식·409/423 수·처리량)를 본 뒤 맞았는지와 이유를 실험 노트에 남긴다. 판정과 근거는 코드 실험실(`learn.yaml`)에 있다.

1. 문서 1개·사람 20명에서 `naive-overwrite`의 lost update가 반복마다 같은 수로 나올까? 응답 오류율·처리량은 다섯 중 어디쯤일까?
2. `optimistic-version`에서 사람 수를 2 → 20으로 늘리면 성공 처리량은 늘까 줄까? 409는 성공 1건당 몇 건쯤 될까?
3. `edit-lease`의 TTL(100ms)이 편집 시간(150ms)보다 짧으면 무엇이 깨지나? lost update가 날까, 저장이 안 될까?
4. 409를 받고 `currentVersion`만 바꿔 같은 본문으로 다시 PUT 하면(`blind-retry`) 무엇이 사라지나? 서버 로그에는 무엇이 남나?
5. 격리 수준을 SERIALIZABLE로 올리면 `naive-overwrite`의 덮어쓰기가 막힐까?
6. 편집 시간을 0으로 두고 저장 트랜잭션 안에 30ms를 주입하면, `optimistic-version`의 409는 ①(메모리 비교)과 ②(flush 0행) 중 어디서 더 많이 날까?
7. 문서 100개 Zipf에서 `field-merge`와 `optimistic-version`의 409 수는 얼마나 차이 날까? `edit-lease`의 처리량은?
8. 같은 문서를 20명이 고칠 때 `edit-lease`의 423을 오래 받는 사람이 정해져 있을까(도착 순서대로 받을까)?

## 학습 체크리스트

- [ ] 쓰기 경로 중 WHERE에 version을 거는 경로가 하나라도 빠지면 낙관 락이 무력해진다. `em.nativeUpdate`는 version을 올리기만 하고 비교하지 않는다(실제 SQL로 확인).
- [ ] `lockVersion`은 메모리 비교일 뿐 락 SQL이 아니다. 동시성 보장은 flush의 `UPDATE … WHERE version = ?` 0행 → `OptimisticLockError`가 한다. undefined면 검사 생략, 문자열 `'3'`은 `3`과 불일치라 컨트롤러가 428·number 변환을 맡는다.
- [ ] 낙관 락의 실패 지점은 두 곳(① 메모리 비교, ② flush 0행)이고 둘 다 409 `version_mismatch` + `currentVersion` 재조회다. conflict 이벤트의 `at`으로 어느 쪽인지 구분할 수 있다.
- [ ] READ COMMITTED의 동시 UPDATE는 행 잠금을 기다린 뒤 **최신 행으로 WHERE를 다시 평가**(EvalPlanQual)한다. 그래서 `version = ?`가 거짓이 되면 0행, `id = ?`뿐이면 그대로 덮어쓴다.
- [ ] 트랜잭션 경계: 읽기(GET)는 자동 커밋, 저장은 `em.transactional`로 UPDATE와 원장·이력 INSERT를 함께 커밋한다. 읽기와 저장이 다른 트랜잭션이라 그 사이 틈이 생긴다.
- [ ] 덮어쓰기는 SERIALIZABLE로도 막지 못한다. 읽기와 쓰기가 다른 트랜잭션이고 그 사이가 사람의 편집 시간이다. 한 트랜잭션 안이었다면 늦은 쪽이 40001로 중단된다.
- [ ] 409를 받으면 버전만 갱신해 재시도하는 것은 해법이 아니다(`blind-retry`). 다시 GET → 내 변경을 최신본에 재적용 → 새 버전으로 PUT.
- [ ] 409(저장 충돌: 다시 읽고 재적용)와 423(자원 점유: 기다렸다 다시)을 나눈 이유를 설명할 수 있다.
- [ ] `edit-lease`의 423은 서버 큐가 아니라 클라이언트 폴링이다. FIFO가 없어 굶주림·몰림이 생길 수 있고, 편집 시간이 길수록 처리량이 1 / 편집 시간에 묶인다.
- [ ] fence는 만료된 보유자의 늦은 저장을 같은 UPDATE 안에서 거른다(`lease_lost`). 아무도 회수하지 않았으면 `lease_expired`. release도 fence가 맞을 때만 푼다.
- [ ] lease 만료 시각과 유효 판단은 DB 시계 `clock_timestamp()`로 한다. `now()`는 트랜잭션 시작 시각이라 트랜잭션 안에서 멈춰 있고, 앱 서버 시계는 인스턴스마다 어긋난다.
- [ ] `field-merge`는 같은 필드 충돌만 409지만, 필드 경계가 의미 경계와 맞아야 한다. 서로 의존하는 필드를 따로 병합한 오류는 `no_lost_update`가 잡지 못한다.
- [ ] 판정 근거는 응답(200·409)이 아니라 DB에 남은 사실이다. `naive-overwrite`는 처리량·오류율이 가장 좋아 보이면서 가장 많이 잃는다.

## 로컬 재현 한계

사람의 편집 간격(분 단위)을 ms 단위로 압축하므로 충돌 빈도는 실제보다 훨씬 높다. 메커니즘 관찰용이며, `learn.yaml`의 `expected` 수치는 단순 모델 추정이라 실측(`measured`)과 다를 수 있다. 어긋나면 그 자체가 학습 대상이다.
