# nestjs-under-load 시나리오 카탈로그

> 설계 원칙·용어는 [DESIGN.md](./DESIGN.md) 참조. 단계 배치는 [ROADMAP.md](./ROADMAP.md).
>
> **공통 전제**
> - 모든 수치 해석은 "로컬 단일 머신, 처리 방식 간 상대 비교"로만 한다.
> - 기본 앱 인스턴스는 2대 이상. 1대에서만 맞는 처리 방식(메모리 락, 인스턴스 메모리 캐시 등)은 일부러 1대/2대를 둘 다 돌려 차이를 보인다.
> - 부하 모델: 경합·정합성 = **closed**(`constant-vus`/`ramping-vus` + think time), 지연·포화·용량 = **open**(`constant-arrival-rate`/`ramping-arrival-rate`, `dropped_iterations`는 실패로 집계).
> - **코드는 전부 AI가 작성한다.** 각 시나리오의 "학습 포인트"는 `learn.yaml`의 concepts·situations 요약이다. 사용자는 코드 실험실(DESIGN §10.4)에서 부하·상황별로 어떤 코드가 들어가야 하고 왜 그런지를 학습한다. 판정의 `expected`(예상)와 `measured`(실측)는 구분해 표시한다.
> - 각 시나리오의 불변식은 `invariants.sql`로 **DB에 남은 사실만으로** 자동 검사하고, 처리량보다 먼저 표시한다. 임계 구역 진입·이탈과 성공 처리는 시나리오 테이블 원장 행(요청 ID, fence, txid)으로 남기고(원장 쓰기 비용은 모든 strategy에 동일), k6 카운트는 보조 대조로만 쓴다. 클라이언트는 타임아웃났는데 서버는 커밋한 요청이 있으면 k6 기준 판정은 거짓 위반을 낸다. 샘플링·손실 가능한 이벤트 텔레메트리로 판정하지 않는다(DESIGN §3).
> - closed 모델 시나리오(G01, G04, G05, T01, T02, T08)에는 "지연은 해석 주의" 배지를 붙인다(coordinated omission, DESIGN §8).

## 목록

| 팩 | ID | 제목 | 단계 |
|---|---|---|---|
| 범용 | G01 | 같은 문서 동시 수정 | 1 |
| 범용 | G02 | 재고·좌석 차감 경합 | 0 (strategy 1~4), 1 (나머지) |
| 범용 | G03 | 핫 로우 처리량 천장 | 2 (`redis-atomic`은 4) |
| 범용 | G04 | 데드락 재현 | 2 |
| 범용 | G05 | Redis 분산 락 실패 모드 | 2 |
| 범용 | G06 | 중복 요청과 멱등키 | 2 |
| 범용 | G07 | 대량 쓰기 10만~100만 건 | 2 |
| 범용 | G08 | ORM에 대량 로드 후 flush | 2 |
| 범용 | G09 | N+1과 로딩 전략 | 4 |
| 범용 | G10 | 작업 큐 경합과 워커 사망 회수 | 4 |
| 범용 | G11 | DB 커넥션 고갈 | 3 |
| 범용 | G12 | PgBouncer 트랜잭션 모드 함정 | 3 |
| 범용 | G13 | 타임아웃·재시도·과부하 차단 | 3 |
| 범용 | G14 | 레이트 리밋 | 3 |
| 범용 | G15 | 이벤트 루프 블로킹 | 3 |
| 범용 | G16 | 용량 산정: 처리량-지연 곡선 | 3 |
| 범용 | G17 | 캐시 스탬피드와 무효화 경쟁 | 4 |
| 범용 | G18 | 아웃박스와 멱등 컨슈머 | 4 |
| 범용 | G19 | 인덱스·실행계획·페이지네이션 | 4 |
| 범용 | G20 | 무중단 스키마 변경 | 5 |
| 범용 | G21 | 장기 트랜잭션·vacuum·bloat | 5 |
| 범용 | G22 | 대용량 export 스트리밍 | 4 |
| 범용 | G23 | 읽기 복제본과 복제 지연 | 4 |
| 범용 | G24 | 그레이스풀 셧다운·롤링 재시작 | 5 |
| 범용 | G25 | 컨테이너 리소스 제한 | 3 |
| 범용 | G26 | 로그 볼륨 | 3 |
| 범용 | G27 | 배치 vs 스트리밍 집계 (Redis Streams) | 6 |
| 범용 | G28 | PostgreSQL 페일오버 | 6 |
| 범용 | G29 | 오토스케일링 반응 (k3d + HPA) | 6 |
| 범용 | G30 | 샤딩 (설계 글, 실행 없음) | 6 |
| 세무 | T01 | 세무사 둘 동시 신고서 수정·승인 | 2 |
| 세무 | T02 | 승인자 최소 1명 (write skew) | 2 |
| 세무 | T03 | 엑셀 수만 건 임포트 | 2 (strategy 4·7은 4) |
| 세무 | T04 | 마감 직전 제출 폭주 (통합 캡스톤) | 5 |
| 세무 | T05 | 수정신고 이력 | 4 |
| 세무 | T06 | 신고 이력 파티셔닝 | 4 |
| 세무 | T07 | 승인 즉시 타 화면 반영 (실시간) | 4 |
| 세무 | T08 | 사무소 격리(RLS) 컨텍스트 누수 | 3 |

합계: 범용 30(실행형 29 + 설계 글 1), 세무 8, 총 38.

세무 팩은 상태 전이·승인 규칙이 많은 업무 도메인 예시다. 범용 시나리오와 메커니즘이 겹치는 부분은 범용 쪽을 참조하고, 세무 팩은 도메인 규칙이 더해질 때만 새로 생기는 문제에 집중한다.

엔진 공통 기능으로 다루고 별도 시나리오로 두지 않는 것: 정합성 재조정 검사기, SLO/에러 버짓(카오스 판정 기준), 비용 상대 표현(G16·G29 결과에 부속).

---

## 범용 팩 (generic)

### G01 같은 문서 동시 수정

- **문제:** 두 사람이 같은 문서를 읽고 각자 고쳐 저장하면 늦게 저장한 쪽이 앞사람 수정을 덮어쓴다(lost update). 응답은 둘 다 200이다.
- **편집 모델:** 문서 전체 교체(PUT, field-merge만 PATCH). 클라이언트는 **화면을 열 때(GET) 받은 버전**을 저장 요청에 들고 온다. 버전은 **요청 본문의 `version`으로만** 전달한다(`If-Match` 미사용 — 헤더 의미론의 412/428을 따로 구현하지 않기 위함. 단 버전 누락은 428). 서버는 그 버전이 현재와 같을 때만 저장한다(MikroORM `findOneOrFail(..., { lockMode: LockMode.OPTIMISTIC, lockVersion })`). `lockVersion`은 메모리 비교일 뿐 락 SQL이 아니다(트랜잭션 불필요). 동시성 보장은 flush의 `UPDATE … WHERE version = ?` 0행 → `OptimisticLockError`가 한다. `lockVersion`이 undefined이면 검사가 생략되므로 컨트롤러가 버전 누락을 거절(428)하고 number로 변환해서 넘긴다(`!==` 엄격 비교 — 문자열 '3'과 3은 불일치). 낙관 락의 실패 지점은 두 곳(메모리 비교, flush 0행)이며 둘 다 409 `version_mismatch`로 응답하고, 후자는 `currentVersion`을 재조회한다. 409 응답 본문에 `currentVersion`과 현재 내용을 싣는다. 엔티티는 하나(`version`, `lockedBy`, `leaseUntil`, `fence` 컬럼 모두 포함)이고, 같은 테이블에 엔티티 클래스를 여러 개 두지 않는다(MikroORM `checkDuplicateTableNames`).
- **처리 방식:**
  1. `naive-overwrite` 읽기 → 수정 → 저장, 버전 조건 없이 쓰는 쓰기(`em.nativeUpdate(...)`처럼 WHERE에 version이 없는 경로, last-write-wins; 버전 컬럼은 올라가지만 아무도 비교하지 않는다) (broken). 구현 단계에서 SQL 로그로 실제 WHERE절을 확인한다
  2. `blind-retry` 409를 받으면 **같은 body로 버전만 새로 받아 다시 PUT** (broken: 상대 수정이 결국 유실되고 불변식 위반으로 잡힌다. 409를 "버전만 갱신하면 되는 일시 오류"로 오해한 전형)
  3. `optimistic-version` 위 편집 모델 그대로. 409를 받으면 올바른 재시도 = 다시 GET → 내 변경을 최신본에 다시 적용(병합 또는 사용자 결정) → **새 버전으로** PUT (fixed)
  4. `field-merge` 바뀐 필드만 조건부 UPDATE, 같은 필드 충돌만 409. **`PATCH`(변경 필드만 + base version)를 쓴다. 나머지 strategy는 `PUT`.** (tradeoff)
  5. `edit-lease` 편집 잠금(`locked_by`, `lease_until`, `fence`). acquire는 조건부 UPDATE + **DB 시계**(`clock_timestamp() + interval`; `now()`는 트랜잭션 시작 시각이라 쓰지 않는다)로 만료 시각을 계산하고(앱 서버 시계 금지) `fence`(bigint)를 acquire마다 +1 한다. save는 `WHERE id=? AND locked_by=? AND fence=? AND lease_until > clock_timestamp()` 조건부 UPDATE이고 0행이면 같은 요청에서 재조회해 `locked_by`가 다르면 `lease_lost`, 만료면 `lease_expired`로 거절한다. 잠금을 쥔 사람이 있으면 다른 사람의 acquire는 **서버 큐가 아니라 423 거절 → 클라이언트 재시도(폴링)**: FIFO 보장 없음, 굶주림·몰림 가능. 잠금을 쥔 채 종료되면 TTL 만료로 회수한다. 만료된 보유자의 늦은 save를 막는 fencing 토큰(`fence`, save가 들고 옴)은 구현 대상이다 (tradeoff)
- **응답 계약:** 불일치(`version_mismatch`)와 edit-lease의 save 실패(0행, lease 저장 실패)는 모두 **409**로 통일하고 본문 `reason`(`version_mismatch` | `lease_lost` | `lease_expired`)으로 구분한다. 버전 누락은 428. 423은 edit-lease의 **acquire 거절**(다른 사람이 보유 중, `Retry-After` 동봉)에만 쓰며, WebDAV(RFC 4918) 코드를 의도적으로 차용한다. 이유: 저장 실패는 "내가 알고 있던 상태가 현재와 다르다"는 같은 종류의 충돌이라 클라이언트가 같은 복구 절차(다시 GET → 재적용)를 타고, acquire 거절은 저장이 아니라 자원 점유라 별도 의미(재시도 대기)가 필요하다.
- **불변식:** 서버가 성공 처리한 수정마다 원장 행(요청 ID, 수정 토큰, txid)을 같은 트랜잭션에 남기고, 문서의 `edit_count` = 원장 성공 행 수, 원장의 모든 수정 토큰이 최종 문서 이력에 존재(lost update 0). **문서 이력**은 append-only `document_revision` 하위 테이블(수정 토큰 목록)에 저장하며, "재적용"과 lost update 판정은 이 이력으로 정의한다. k6 성공 응답 수는 보조 대조(차이 = 클라이언트 타임아웃 후 서버 커밋).
- **측정 지표:** 409 비율, 재시도 후 성공률, 성공 지연, 423 비율·잠금 대기 시간(edit-lease), lost update 수.
- **부하 모델:** closed(배지: 지연은 해석 주의). 같은 문서를 다투는 "사람 수"가 변수라서. 문서 수(1~100)와 Zipf로 충돌 밀도를 조절. edit-lease는 **편집 시간**(압축된 ms ↔ 실제 분 단위)을 변수로 두어, 잠금을 오래 쥘수록 처리량이 얼마나 떨어지는지(대가)를 보인다.
- **망가뜨리기:** 경합 창 지연 주입(`after-read`), 클라이언트 이탈(release 없음 → TTL 만료 회수)과 클라이언트 멈춤 후 늦은 저장(fence 불일치 → 409 lease_lost). 서버 인스턴스 kill은 lease에 영향 없음(확인용).
- **무대 장면:** `shared-document` — 충돌 시 종이 찢김, 409 받은 캐릭터가 다시 읽으러 감. 같은 버전을 두 번 받은 장면이 먼저 보여야 한다(DESIGN §10.3).
- **학습 포인트(learn.yaml concepts·situations 요약):** 5개 strategy, 409/423 응답 계약, 불변식. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **학습 체크리스트:**
  - 쓰기 경로 중 WHERE에 version을 거는 경로가 하나라도 빠지면(예: `em.nativeUpdate`는 version을 올리긴 하지만 비교하지 않는다) 낙관 락이 무력해진다.
  - `lockVersion`은 메모리 비교일 뿐 락 SQL이 아니다(트랜잭션 불필요). 동시성 보장은 flush의 `UPDATE … WHERE version = ?` 0행 → `OptimisticLockError`가 한다. `lockVersion`이 undefined이면 검사가 생략되므로 컨트롤러가 버전 누락을 거절(428)하고 number로 변환해서 넘긴다(`!==` 엄격 비교 — 문자열 '3'과 3은 불일치).
  - 낙관 락의 실패 지점은 두 곳(메모리 비교, flush 0행) — 둘 다 409 `version_mismatch`, 후자는 `currentVersion` 재조회.
  - 동시 UPDATE에서 PostgreSQL READ COMMITTED는 행 락을 기다린 뒤 **최신 행으로 WHERE를 다시 평가**(EvalPlanQual)해 `version = :v`가 거짓이 되면 0 rows가 된다. 그래서 조건부 UPDATE가 동시성 제어가 된다.
  - 트랜잭션 경계: 읽기는 자동 커밋, 저장은 `em.transactional`로 UPDATE와 원장·document_revision INSERT를 함께 커밋(자동 커밋은 읽기 SELECT와 lease acquire·release뿐). 읽기와 저장이 다른 트랜잭션이라 그 사이 틈이 생긴다.
  - 덮어쓰기는 SERIALIZABLE로도 막지 못한다. 읽기와 쓰기가 서로 다른 트랜잭션이고 그 사이에 사람의 편집 시간이 끼기 때문이다(DB가 보는 건 각 트랜잭션 안쪽뿐). 읽기·쓰기가 다른 트랜잭션이라 SERIALIZABLE로도 못 막는다. 한 트랜잭션 안이었다면 SERIALIZABLE은 40001로 중단시킨다.
  - 409를 받으면 버전만 갱신해 재시도하는 것은 해법이 아니다(`blind-retry`).
- **예측 질문:** ① 문서 1개·사람 20명에서 naive의 lost update가 반복마다 같은 수로 나올까? ② optimistic에서 사람 수를 늘리면 성공 처리량은 늘까 줄까? ③ edit-lease의 만료 시간이 짧으면 무엇이 깨지나? ④ 409를 받고 버전만 새로 받아 재PUT하면 무엇이 사라지나?
- **로컬 재현 한계:** 사람의 편집 간격(분 단위)을 ms 단위 think time으로 압축하므로 충돌 빈도는 실제보다 훨씬 높다. 메커니즘 관찰용.

### G02 재고·좌석 차감 경합

- **문제:** 재고를 읽고 앱에서 빼고 쓰면 동시에 들어온 요청들이 같은 값을 읽어 초과 판매(음수 재고)가 난다.
- **처리 방식:**
  1. `no-lock` 읽기-계산-쓰기 (broken)
  2. `app-memory-lock` 인스턴스 메모리 mutex (1대에선 맞고 2대에선 깨짐을 보이는 용도, broken)
  3. `row-lock` `SELECT ... FOR UPDATE`(MikroORM `LockMode.PESSIMISTIC_WRITE`), `lock_timeout` 설정 (fixed)
  4. `conditional-update` `UPDATE stock SET qty = qty - :n WHERE id = :id AND qty >= :n`, 영향 행 0이면 품절 (fixed, ORM 우회 표시)
  5. `redis-lock` `SET key token NX PX` + 소유자 확인 해제(Lua) (tradeoff, G05로 연결)
  6. `advisory-xact-lock` `pg_advisory_xact_lock(상품 ID)` 후 읽기-계산-쓰기, 트랜잭션 종료 시 자동 해제 (fixed, 세션형 advisory lock과의 차이는 G12)
  - 0단계는 strategy 1~4만, 5·6은 1단계.
  - 학습 체크리스트 추가: READ COMMITTED에서 `FOR UPDATE`·`UPDATE`가 잠금 대기 후 최신 행 버전으로 WHERE를 다시 검사하는 동작(EvalPlanQual) — `conditional-update`가 별도 락 없이 맞는 이유.
- **불변식:** 재고 ≥ 0, `초기 재고 − 현재 재고 = 주문 원장 수량 합`, 원장의 요청 ID별 결과(성공/품절) 행 수 = 서버가 처리한 요청 수. k6의 품절·성공 응답 수는 보조 대조(클라이언트 타임아웃 후 서버 커밋이 있으면 k6 쪽이 적게 나온다).
- **측정 지표:** 성공/품절/실패 수, 락 대기(`pg_locks` 대기 수, `wait_event_type=Lock`), 락 보유 시간 span, 처리량, p99.
- **부하 모델:** closed(정합성 관찰). 별도로 open 버전을 돌려 strategy별 지연을 비교(이때만 지연 수치 인용).
- **망가뜨리기:** 경합 창 지연 주입, `redis-lock`에서 Redis stop, 앱 인스턴스 1↔2 전환.
- **무대 장면:** `queue-at-counter` — 창구(행) 앞 줄, 락 보유자가 창구에 섬.
- **학습 포인트(learn.yaml concepts·situations 요약):** 6개 strategy, 품절 판정, 불변식 SQL. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 앱 1대에서 `app-memory-lock`은 통과할까? 2대에선? ② `row-lock`과 `conditional-update` 중 락 보유 시간이 짧은 쪽은 왜 그런가? ③ 상품 1개에 몰리면 처리량은 어디서 막힐까?
- **로컬 재현 한계:** 네트워크 왕복이 거의 0이라 락 보유 시간이 실제보다 짧다. 지연 주입으로 보정하되 "주입됨" 표시.

### G03 핫 로우 처리량 천장

- **문제:** 인기 상품 하나에 모든 요청이 몰리면 행 잠금이든 조건부 UPDATE든 그 행에서 직렬화되어 인스턴스를 늘려도 처리량이 오르지 않는다.
- **처리 방식:**
  1. `single-row` 조건부 UPDATE 단일 행 (기준선)
  2. `bucket-split` 재고를 K개 버킷 행으로 나누고 임의 버킷 차감, 부족하면 다른 버킷 시도 (fixed, 품절 판정 복잡도 증가)
  3. `redis-atomic` Redis `DECRBY`(음수면 되돌림 또는 Lua로 검사-감소) 후 DB는 비동기 반영(아웃박스/스트림) (tradeoff, **4단계** — 반영 워커·아웃박스(G18)가 갖춰진 뒤)
  4. `batched-apply` 요청을 짧은 창으로 모아 한 번에 차감 (tradeoff, 지연 증가)
- **불변식:** 버킷 합 ≥ 0, 비동기 반영 후 DB 재고 = Redis 재고(drain 후), 주문 수량 합 일치.
- **측정 지표:** 처리량 vs 앱 인스턴스 수(1/2/3), 행 락 대기, 버킷별 고갈 편차, 비동기 반영 지연, Redis 명령 지연.
- **부하 모델:** open(처리량 천장과 지연을 보려는 실험). 계단 도착률(2단계에서 쓰는 기본 계단 프로파일, 무릎 표시 차트는 3단계).
- **망가뜨리기:** `redis-atomic`에서 반영 워커 kill → 재시작 후 정합성, Redis 재시작(유실 범위: `appendfsync always` ≈ 무손실, `everysec` 최대 약 1초(최악 2초), `no`는 OS 플러시 주기. Redis 기본은 `appendonly no`라 마지막 RDB 스냅샷 이후 감소분이 유실된다 — 실행 설정에 명시).
- **무대 장면:** `queue-at-counter` — 창구가 1개 vs K개로 갈라짐.
- **학습 포인트(learn.yaml concepts·situations 요약):** 버킷 분할 로직, Redis 감소·되돌림, 비동기 반영과 재조정. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 인스턴스 1→3대에서 `single-row` 처리량은 몇 배? ② 버킷 K를 늘리면 무한히 좋아지나? ③ `redis-atomic`에서 Redis가 죽으면 어떤 불변식이 깨질 수 있나?
- **로컬 재현 한계:** 디스크 fsync 특성이 VM 가상 디스크에 좌우된다. 천장의 절대 높이는 의미 없고 인스턴스 수에 따른 모양만 본다.

### G04 데드락 재현

- **문제:** 두 트랜잭션이 행 A, B를 반대 순서로 잠그면 서로 기다리다 PG가 `deadlock_timeout` 후 한쪽을 `40P01`로 중단시킨다.
- **처리 방식:**
  1. `random-order` 요청이 준 순서대로 잠금 (broken)
  2. `retry-on-deadlock` 그대로 두고 40P01 재시도 (tradeoff)
  3. `sorted-order` ID 정렬 순서로 잠금 (fixed)
  4. `single-statement` 한 문장 UPDATE로 묶기 (fixed, 표현 가능한 경우만)
- **불변식:** 이체형 합계 보존(계좌 총합 불변), 중단된 트랜잭션의 부분 반영 0.
- **측정 지표:** `pg_stat_database.deadlocks` 차분, 40P01 수, 재시도 횟수, 락 대기 시간, 처리량.
- **부하 모델:** closed(배지: 지연은 해석 주의). 경합 쌍의 수가 변수.
- **망가뜨리기:** `deadlock_timeout` 변경(설정 파일 + reload), 경합 창 지연 주입.
- **무대 장면:** `queue-at-counter` 변형 — 두 창구 사이에서 서로 손을 뻗은 채 멈춤, PG가 한 명을 쫓아냄.
- **학습 포인트(learn.yaml concepts·situations 요약):** 잠금 순서 정렬, 재시도 정책, 불변식. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 데드락 감지까지 대기 시간은 무엇이 정하나? ② 재시도만으로 충분한 경우와 아닌 경우는? ③ 외래키 검사도 잠금을 잡는다는 걸 어떻게 확인할까?
- **로컬 재현 한계:** 재현 자체는 충실하다. 빈도는 경합 밀도 설정에 좌우된다.

### G05 Redis 분산 락 실패 모드

- **문제:** Redis 락은 "작업 시간 > TTL", GC 멈춤, 해제 순서 버그, eviction, Redis 다운에서 상호 배제가 깨진다. 락만 믿고 DB 정합성을 맡기면 위험하다.
- **처리 방식:**
  1. `setnx-del` `SET NX PX` + 무조건 `DEL`(남의 락 해제 가능) (broken)
  2. `owner-check-release` 토큰 비교 후 삭제(Lua) (부분 개선)
  3. `ttl-overrun` 작업 시간이 TTL을 넘도록 지연 주입 → 이중 보유 재현 (broken 시연)
  4. `release-before-commit` DB 커밋 전에 락 해제하는 순서 버그 (broken 시연)
  5. `fencing-token` `INCR`로 단조 토큰 발급, DB 쓰기를 `WHERE fence < :token` 조건부 UPDATE로 막음 (fixed)
  6. `advisory-xact-lock` 같은 자원을 Redis 대신 `pg_advisory_xact_lock`으로 보호 (fixed 비교 기준: 락과 데이터가 같은 DB 트랜잭션에 묶이면 TTL·해제 순서 문제가 사라짐)
  7. 정책 비교: Redis 다운 시 `fail-closed`(요청 거절) vs `fail-open`(락 없이 진행)
  8. 설정 비교: `maxmemory-policy` `allkeys-lru`(락 키 축출 가능) vs `noeviction`
- **불변식:** 같은 자원의 임계 구역 동시 진입 0 — 임계 구역 진입·이탈을 시나리오 테이블 원장 행(요청 ID, fence, txid, 진입·이탈 시각)으로 남기고 구간 겹침을 SQL로 검사한다(이벤트 텔레메트리로 판정하지 않음). DB 쓰기가 낮은 토큰으로 덮어쓰인 수 0.
- **측정 지표:** 이중 보유 감지 수, 펜싱 거절 수, Redis 명령 지연, 락 키 TTL 분포, evicted_keys, fail-open/closed별 성공률·정합성.
- **부하 모델:** closed(배지: 지연은 해석 주의).
- **망가뜨리기:** GC 멈춤 대용 지연 주입(`after-acquire`), Redis stop/start, 메모리 압박으로 eviction 유도, toxiproxy로 Redis 지연.
- **무대 장면:** `queue-at-counter` — 열쇠 하나를 두 명이 들고 창구에 동시에 서는 장면, 펜싱이면 DB 문지기가 낡은 번호를 돌려보냄.
- **학습 포인트(learn.yaml concepts·situations 요약):** 락 획득·해제 Lua, 펜싱 토큰 조건부 UPDATE, fail 정책, 원장 겹침 검사 SQL. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① owner-check만으로 TTL 초과 문제가 해결될까? ② 펜싱 토큰은 Redis 다운 중에 어떻게 동작해야 하나? ③ fail-open을 택해도 되는 업무는?
- **로컬 재현 한계:** Redis 단일 노드라 Redlock(다중 노드) 논쟁은 재현하지 않는다. 시계 드리프트도 재현 안 함(문서로만).

### G06 중복 요청과 멱등키

- **문제:** 더블 클릭, 클라이언트 재시도, 타임아웃 후 재전송으로 같은 요청이 여러 번 처리된다. 같은 키가 동시에 도착하면 단순 조회-후-삽입도 뚫린다.
- **처리 방식:**
  1. `none` 방지 없음 (broken)
  2. `check-then-insert` 키 조회 후 없으면 처리 (동시 도착에 뚫림, broken)
  3. `unique-constraint` 비즈니스 키 유니크 제약 + 위반 시 기존 결과 반환 (fixed, 범위 제한)
  4. `idempotency-key` 키 테이블 상태(`processing`/`completed`) + 응답 저장 + 요청 본문 해시 비교(불일치 422), **키 삽입을 본 작업과 같은 트랜잭션에** (fixed)
  5. `idempotency-key-separate-tx` 키를 별도 트랜잭션에 저장 (본 작업 실패 시 키만 남는 버그 시연)
  6. `redis-idempotency` Redis `SET NX`로 처리 중 표시 (tradeoff, Redis 다운 시)
- **불변식:** 같은 멱등키의 부작용(주문 생성) 1회, 같은 키 재요청은 같은 응답 본문, `processing`에 영구히 남은 키 0(타임아웃 회수 포함).
- **측정 지표:** 중복 생성 수, 동시 도착 시 409/대기 비율, 저장 응답 재사용 수, 키 테이블 크기.
- **부하 모델:** closed. 같은 키를 N개 VU가 동시에 보내는 버스트 패턴(k6 `per-vu-iterations` + 공유 키).
- **망가뜨리기:** 처리 중 app kill(키가 `processing`으로 남는지), Redis stop(`redis-idempotency`).
- **무대 장면:** `queue-at-counter` — 같은 번호표를 든 쌍둥이 캐릭터.
- **학습 포인트(learn.yaml concepts·situations 요약):** 키 상태기계, 같은 트랜잭션 처리, 동시 도착 처리, 회수. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 같은 키 두 요청이 동시에 오면 두 번째는 무엇을 받아야 하나? ② 키를 별도 트랜잭션에 넣으면 어떤 순서에서 깨지나? ③ 키 보존 기간은 무엇으로 정하나?
- **로컬 재현 한계:** 클라이언트 재시도 정책의 다양성은 k6 패턴 몇 개로 단순화한다.

### G07 대량 쓰기 10만~100만 건

- **문제:** 한 줄씩 저장하면 왕복·트랜잭션 비용이 쌓이고, 한 번에 다 하면 메모리가 터진다. 빠른 방법은 무엇을 포기하는지 알아야 한다.
- **처리 방식:**
  1. `row-by-row` 건마다 `persist` + `flush` (기준선)
  2. `single-flush` 전부 `persist` 후 한 번 `flush` (메모리 폭증 시연)
  3. `chunked-flush-clear` N건마다 `flush` + `em.clear()` (fixed)
  4. `insert-many` `em.insertMany`(UoW 우회) (tradeoff)
  5. `native-multirow` 멀티로우 `INSERT ... VALUES (...), (...)` — 바인드 파라미터 상한 65535를 넘지 않도록 청크 크기 계산 (tradeoff)
  6. `copy` `COPY ... FROM STDIN` 스트림 (tradeoff: ORM 훅·엔티티 검증·앱 측 ID 전략 포기). "한 행 오류면 전체 실패"는 기본 `ON_ERROR stop`일 때만이다. PG17은 `COPY FROM ... (ON_ERROR ignore, LOG_VERBOSITY verbose)`(text/csv 형식)로 오류 행을 건너뛰고 기록할 수 있어 두 모드를 비교한다. MikroORM에는 COPY API가 없으므로 `pg-copy-streams` + 원시 pg 클라이언트를 쓴다(Pool은 `driverOptions.onPoolCreated`로 얻음)
  7. `upsert` `INSERT ... ON CONFLICT DO UPDATE` — 같은 배치 안 중복 키가 있으면 "cannot affect row a second time" 오류, 배치 내 중복 제거 필요
  8. 변형 축: 보조 인덱스 0/2/5개, 제약(FK·CHECK) 유무
  9. 변형 축: 기본 키 UUIDv4 vs UUIDv7 / bigserial — 무작위 키의 B-tree 페이지 분할·WAL 증가(full page write) 비교
- **불변식:** 최종 행 수 = 입력 행 수(중복·누락 0), 체크섬(컬럼 해시 합) 일치, upsert는 키당 최신 값.
- **측정 지표:** 총 소요 시간, 행/초, 힙 최대, flush 횟수·시간, WAL 바이트(`pg_stat_wal`), 체크포인트 수, 인덱스 수별 시간 비율, 키 종류별 인덱스 크기·WAL 바이트, 이벤트 루프 지연.
- **부하 모델:** 단일 작업 실행(k6 `shared-iterations` 1회로 트리거 + 진행률 폴링). 동시 읽기 영향을 볼 때만 open 배경 부하 추가.
- **망가뜨리기:** 실행 중 app kill(어디까지 들어갔나, 재실행 시 중복), 디스크 대역폭은 통제 불가.
- **무대 장면:** `conveyor` — 상자(청크)가 벨트로 들어가고 메모리 게이지가 차오름.
- **학습 포인트(learn.yaml concepts·situations 요약):** 청크 로직, 파라미터 상한 계산, COPY 스트림, upsert 중복 제거. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 인덱스 5개면 2개 대비 시간이 얼마나 늘까(비율)? ② `single-flush`는 어디서 먼저 실패할까(힙 vs 시간)? ③ COPY로 바꾸면 무엇을 따로 구현해야 하나?
- **로컬 재현 한계:** VM 디스크 fsync 성능이 결과를 지배한다. 100만 건은 머신 사양에 따라 기본값을 조정(메타데이터에 기록).

### G08 ORM에 대량 로드 후 flush

- **문제:** 한 EntityManager에 엔티티를 많이 올리면 Identity Map이 커지고, flush의 변경 감지가 관리 중인 엔티티 전부를 비교해 몇 건만 바꿔도 느려진다.
- **처리 방식:**
  1. `load-all-flush` 10만 건 로드 → 일부 수정 → flush (broken)
  2. `fork-per-chunk` 청크마다 `em.fork()` (fixed)
  3. `readonly-load` 조회 전용 로드(`disableIdentityMap: true` 또는 Kysely ReadModel/DTO) 후 대상만 갱신 (fixed)
  4. `native-update` `em.nativeUpdate` 한 문장 (tradeoff)
  - 청크마다 flush + `em.clear()`는 G07 `chunked-flush-clear`와 같은 메커니즘이라 여기서는 따로 두지 않는다(G07 결과 참조). G08은 "로드한 뒤 일부만 바꾸는" 갱신 경로의 변경 감지 비용에 집중한다.
- **불변식:** 수정 대상 행만 정확히 변경(체크섬), 비대상 행 변경 0.
- **측정 지표:** Identity Map 크기 vs flush 시간 곡선, 힙 최대·GC pause, 쿼리 수, 요청 동안 이벤트 루프 지연.
- **부하 모델:** 단일 작업 + 로드 크기 스윕(1천/1만/10만). 동시 요청 영향은 open 배경 부하로.
- **망가뜨리기:** 컨테이너 메모리 limit 축소(OOMKilled vs 힙 OOM 구분, G25 연결).
- **무대 장면:** `conveyor` — 작업대 위 상자가 쌓일수록 검사원이 느려짐.
- **학습 포인트(learn.yaml concepts·situations 요약):** fork 전략, 조회 전용 로드, 수정 로직. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 1만→10만에서 flush 시간은 선형일까? ② `em.clear()`를 빼먹으면 메모리는 언제 반환되나? ③ 요청 스코프 em에서도 같은 문제가 생기는 경우는?
- **로컬 재현 한계:** 재현 충실. 절대 시간은 CPU 사양에 좌우.

### G09 N+1과 로딩 전략

- **문제:** 목록을 가져온 뒤 항목마다 연관을 로드하면 쿼리가 N+1번 나간다. 반대로 join으로 한 번에 가져오면 컬렉션 조인에서 행이 곱해지고 페이지네이션이 깨진다.
- **처리 방식:**
  1. `loop-load` 항목마다 `Reference.load()` / `Collection.init()` (broken)
  2. `populate-balanced` `populate` + v7 기본 `loadStrategy: 'balanced'`(to-one은 join, 컬렉션은 select-in) (기준선)
  3. `populate-joined` `populate` + `loadStrategy: 'joined'` (컬렉션 곱 폭증 관찰)
  4. `populate-select-in` `loadStrategy: 'select-in'` (fixed)
  5. `dataloader` MikroORM dataloader(`DataloaderType.REFERENCE`/`COLLECTION`/`ALL` 또는 boolean) (fixed)
  6. `read-model-dto` Kysely ReadModel로 필요한 컬럼만 DTO 조회 (fixed, 쓰기는 ORM, 복잡 조회는 Kysely 읽기 모델)
- **불변식:** 응답 본문이 모든 strategy에서 동일(정렬 고정 후 해시 비교).
- **측정 지표:** 요청당 쿼리 수, 전송 행 수, 응답 지연(처리량 쌍), 힙, `pg_stat_statements` 호출 수.
- **부하 모델:** open(지연 비교).
- **망가뜨리기:** toxiproxy로 DB 지연 1~5ms 추가 → N+1이 왕복 수에 비례해 악화되는 것 관찰.
- **무대 장면:** `generic-timeline` — 요청 하나에서 SQL 막대가 줄줄이 늘어서는 워터폴.
- **학습 포인트(learn.yaml concepts·situations 요약):** 로딩 전략별 구현, ReadModel 쿼리. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① DB가 로컬일 때 N+1이 생각보다 덜 느린 이유는? ② joined가 select-in보다 느려지는 조건은? ③ 기본값 `balanced`가 joined·select-in보다 나은 경우와 못한 경우는?
- **로컬 재현 한계:** 로컬 왕복이 매우 짧아 N+1 비용이 과소평가된다 → toxiproxy 지연으로 보정(표시).

### G10 작업 큐 경합과 워커 사망 회수

- **문제:** DB 테이블을 큐로 쓸 때 여러 워커가 같은 작업을 집거나, 서로 기다리거나, 작업 중 죽은 워커의 작업이 영원히 묶인다.
- **처리 방식:**
  1. `select-then-update` 조회 후 상태 갱신 (중복 처리, broken)
  2. `for-update` `FOR UPDATE` (워커가 줄 서서 직렬화)
  3. `skip-locked` `FOR UPDATE SKIP LOCKED`(MikroORM `LockMode.PESSIMISTIC_PARTIAL_WRITE`) (fixed)
  4. `skip-locked-lease` + `locked_until` 리스(visibility timeout), 만료 시 다른 워커가 회수 (fixed)
  5. 처리 멱등성: 작업 결과 테이블 유니크로 회수 후 재처리 중복 무해화
- **불변식:** 모든 작업 완료(누락 0), 부작용 중복 0, 리스 만료 후 회수까지 시간 상한 준수.
- **측정 지표:** 작업 처리율, enqueue→done 지연, 워커 대기(락 대기), 회수 수, 중복 감지 수, 큐 길이.
- **부하 모델:** open(작업 생산률 고정) + 워커 수 변수.
- **망가뜨리기:** 처리 중 워커 프로세스 SIGKILL, 리스보다 긴 처리 지연 주입(이중 처리 시연).
- **무대 장면:** `worker-pool` — 일꾼이 쓰러지면 상자에 타이머가 뜨고 만료 후 다른 일꾼이 집음.
- **학습 포인트(learn.yaml concepts·situations 요약):** 작업 획득 쿼리, 리스·회수, 멱등 처리. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① `for-update`에서 워커를 늘리면 처리율이 늘까? ② 리스 시간을 너무 짧게 잡으면? ③ SKIP LOCKED가 순서를 보장하지 않는 것이 문제가 되는 업무는?
- **로컬 재현 한계:** 워커 수가 컨테이너 수로 제한된다. 메커니즘은 충실.

### G11 DB 커넥션 고갈

- **문제:** 풀이 마르면 요청이 acquire에서 기다리다 타임아웃된다. 진짜 원인은 대개 "트랜잭션 안의 느린 외부 호출" 또는 "인스턴스 수 × 풀 크기 > `max_connections`"다.
- **처리 방식:**
  1. `external-in-tx` 트랜잭션 안에서 느린 외부 HTTP 호출(`fake-external` 스텁 + toxiproxy 지연) (broken)
  2. `external-out-of-tx` 외부 호출을 트랜잭션 밖으로, 결과 반영만 짧은 트랜잭션 (fixed)
  3. `oversubscribed` 인스턴스 3대 × 풀 크기가 `max_connections`를 넘도록 설정 (broken 시연)
  4. `pool-size-sweep` 풀 크기 2/5/10/20/40 스윕 → 처리량·지연 곡선 (분석)
  5. Little's law 대조: 필요한 동시 커넥션 예측 vs in-flight·active 게이지 실측(계산법은 G16 참조)
- **불변식:** 성공 요청의 부작용 정확히 1회(타임아웃 후 재시도 중복 없음).
- **측정 지표:** 풀 active/idle/waiting, acquire 대기 히스토그램, acquire 타임아웃 수, `pg_stat_activity` 상태별 수, `idle in transaction` 수, goodput, p99, PG 연결 거절 오류.
- **부하 모델:** open(포화 실험).
- **망가뜨리기:** 외부 스텁 지연 증가, 풀 크기 축소(RunConfig 변경 후 app restart), 역할 연결 상한 축소(`ALTER ROLE lab_app CONNECTION LIMIT n` + `pg_terminate_backend`, superuser에는 적용 안 됨), `idle_in_transaction_session_timeout` 적용.
- **무대 장면:** `gate-and-pool` — 의자(커넥션)에 앉은 채 전화(외부 호출)하는 캐릭터, 밖에 줄.
- **학습 포인트(learn.yaml concepts·situations 요약):** 트랜잭션 경계 재설계, 풀·타임아웃 설정 근거, Little's law 계산. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 풀을 키우면 항상 좋아질까? 어디서 꺾일까? ② 외부 호출 지연 200ms, 도착률 λ일 때 필요한 커넥션 수는? ③ `idle in transaction`은 어떤 코드에서 생기나?
- **로컬 재현 한계:** PG가 같은 머신이라 커넥션 수가 늘 때 CPU 경쟁이 섞인다(USE로 구분해 표시).

### G12 PgBouncer 트랜잭션 모드 함정

- **문제:** 트랜잭션 모드 풀링은 트랜잭션마다 서버 연결이 바뀌어 세션 상태에 의존하는 기능이 깨진다.
- **처리 방식(확인 목록):**
  1. 세션 advisory lock `pg_advisory_lock` → 다른 클라이언트 연결에 남음 vs `pg_advisory_xact_lock` (fixed)
  2. `SET` 세션 설정 누수 vs `SET LOCAL` (fixed)
  3. `LISTEN/NOTIFY` 수신 불가 → 전용 직결 연결 (fixed)
  4. prepared statement: Kysely·node-postgres는 기본으로 이름 없는 문장을 써서 트랜잭션 모드에서도 문제없다. 함정 재현은 pg 쿼리에 `name`을 지정해 이름 있는 prepared statement를 만든다. PgBouncer 1.21+ `max_prepared_statements`는 프로토콜 수준 prepared statement만 추적하고 SQL `PREPARE`는 지원하지 않는다(신뢰도 중상)
  5. 성능 비교: direct vs session 모드 vs transaction 모드, 앱 인스턴스 3대에서 서버 연결 수
- **불변식:** advisory lock으로 보호한 임계 구역 동시 진입 0, 세션 설정이 의도한 요청에만 적용.
- **측정 지표:** PgBouncer `cl_active`/`cl_waiting`/`sv_active`/`avg_wait_time`, PG 실제 연결 수, 처리량, 오류 종류별 수.
- **부하 모델:** closed(기능 깨짐 관찰), open(성능 비교).
- **망가뜨리기:** PgBouncer `default_pool_size` 축소, PgBouncer 재시작.
- **무대 장면:** `gate-and-pool` — 의자를 돌려 앉는 캐릭터, 의자에 남은 소지품(세션 상태)을 다음 사람이 집음.
- **학습 포인트(learn.yaml concepts·situations 요약):** 각 함정 재현 코드와 고친 코드. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 트랜잭션 모드에서 세션 advisory lock은 언제 풀리나? ② 서버 연결 수가 줄면 PG 쪽 무엇이 좋아지나? ③ ORM이 트랜잭션 밖에서 날리는 쿼리는 어떻게 다뤄지나?
- **로컬 재현 한계:** 기능 깨짐 재현은 충실. 성능 이득은 연결 수가 작은 로컬에선 작게 보일 수 있음. `SET` 누수가 데이터 노출로 이어지는 경우는 T08.

### G13 타임아웃·재시도·과부하 차단

- **문제:** 의존성이 느려지면 타임아웃 없는 요청이 쌓이고, 무작정 재시도가 부하를 몇 배로 키우며(재시도 폭풍), 장애가 사라져도 한참 회복되지 않는다.
- **처리 방식:**
  1. `no-timeout` 타임아웃 없음 (broken)
  2. `timeouts` 계층 타임아웃: 클라이언트 > 서버 요청 > 풀 acquire / `statement_timeout` / `lock_timeout` (fixed)
  3. `naive-retry` 즉시 3회 재시도 (broken)
  4. `backoff-jitter-budget` 지수 백오프 + 지터 + 재시도 예산 (fixed)
  5. `circuit-breaker` 연속 실패 시 차단·반개방 (fixed)
  6. `admission-control` 동시성·대기 큐 상한 초과분 즉시 429/503 + `Retry-After` (fixed, 상한 근거는 G16의 Little's law)
  7. `cancel-propagation` 클라이언트가 끊었는데 서버가 계속 일하는 문제: 요청 `AbortSignal`을 MikroORM 7.1 `em.fork({ signal })`에 넘겨 진행 중 쿼리를 취소 (fixed, 비교 기준은 취소 전파 없는 `timeouts`)
- **불변식:** 성공 응답의 부작용 1회(재시도로 인한 중복 0, G06 멱등과 결합). 취소된 요청의 부분 반영 0.
- **측정 지표:** goodput(성공·SLO 내 응답률), p99(성공/실패 분리), 풀 대기, 재시도 수/예산 소진, 브레이커 상태, 429/503 비율, 클라이언트 취소 후 서버가 계속 쓴 DB 시간(`pg_stat_activity`), **장애 제거 후 회복 시간**.
- **부하 모델:** open(과부하는 도착률이 고정일 때만 제대로 보인다).
- **망가뜨리기:** toxiproxy `latency`/`timeout` toxic을 PG·Redis에 걸었다가 제거, 일정 시각 예약.
- **무대 장면:** `gate-and-pool` — 문지기가 줄이 넘치면 돌려보냄, 재시도 캐릭터가 다시 몰려옴.
- **학습 포인트(learn.yaml concepts·situations 요약):** 재시도·예산·브레이커·admission 로직, 타임아웃 값 근거. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 재시도 3회면 의존성이 받는 부하는 최대 몇 배? ② 429로 버리는 것이 goodput을 높이는 이유는? ③ 회복 시간을 가장 크게 줄이는 설정은?
- **로컬 재현 한계:** 실제 네트워크 장애 양상(패킷 손실 패턴)은 toxiproxy toxic 종류로 근사.

### G14 레이트 리밋

- **문제:** 인스턴스별 메모리 리밋은 인스턴스 수만큼 한도가 늘어난다. 분산 리밋은 Redis에 의존하므로 Redis 장애 정책이 필요하다.
- **처리 방식:**
  1. `none` (기준선)
  2. `in-memory` 인스턴스별 토큰 버킷 (N대면 실효 한도 N배, broken)
  3. `redis-fixed-window` `INCR` + `EXPIRE` (경계 버스트 시연)
  4. `redis-token-bucket` Lua 원자 처리 (fixed)
  5. Redis 호출 서킷 브레이커 + fail-open/closed 정책 비교
- **불변식:** 키(사용자)별 허용 요청 수 ≤ 정책 한도(+허용 오차 명시).
- **측정 지표:** 429 비율, 키별 허용 수, 경계 시점 버스트, Redis 명령 지연, 리밋 판정이 더한 지연.
- **부하 모델:** open.
- **망가뜨리기:** Redis stop, toxiproxy로 Redis 지연.
- **무대 장면:** `gate-and-pool` — 게이트에 토큰 통.
- **학습 포인트(learn.yaml concepts·situations 요약):** 토큰 버킷 Lua, 정책. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 인스턴스 3대에서 in-memory 한도 100이면 실제로는? ② fixed window 경계에서 최대 몇 개가 통과하나? ③ Redis가 느려지면 리밋이 오히려 장애 원인이 되는 경로는?
- **로컬 재현 한계:** 충실.

### G15 이벤트 루프 블로킹

- **문제:** Node 메인 스레드에서 무거운 동기 작업(엑셀 파싱, 큰 JSON, 동기 암호화)을 하면 그 인스턴스의 **다른 모든 요청**이 멈춘다. libuv 스레드풀(기본 4)도 고갈될 수 있다.
- **처리 방식:**
  1. `main-thread` 메인 스레드에서 xlsx 파싱 (broken)
  2. `worker-threads` `worker_threads`로 분리 (fixed)
  3. `separate-process` 별도 워커 프로세스(큐로 전달) (fixed)
  4. 스레드풀 고갈: `crypto.pbkdf2`·`zlib`·`fs`를 동시에 다량 → `UV_THREADPOOL_SIZE` 4 vs 16 비교
- **불변식:** 파싱 결과 행 수·체크섬이 strategy 간 동일.
- **측정 지표:** 이벤트 루프 지연 p99, ELU, 동시에 일정 도착률을 건 **다른 엔드포인트**(`/health-ish` 경량 API)의 p99, 파싱 소요 시간, 힙.
- **부하 모델:** open — 경량 엔드포인트에 일정 도착률, 동시에 무거운 작업을 주기적으로 트리거.
- **망가뜨리기:** 파일 크기 증가, 컨테이너 CPU limit 축소(G25 연결).
- **무대 장면:** `generic-timeline` — 경량 요청 레인이 무거운 작업 동안 끊기는 모습.
- **학습 포인트(learn.yaml concepts·situations 요약):** 워커 분리 구조, 메시지 전달 계약. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 파싱 2초 동안 경량 엔드포인트 p99는 얼마나 될까(대략 모양)? ② worker_threads로 옮기면 CPU limit 1코어에서도 좋아질까? ③ 스레드풀을 쓰는 API는 무엇인가?
- **로컬 재현 한계:** 충실. CPU limit에 따라 효과 크기가 크게 달라짐(메타데이터로 관리).

### G16 용량 산정: 처리량-지연 곡선

- **문제:** "몇 명까지 버티나"를 알려면 계단 부하로 처리량-지연 곡선의 무릎을 찾고, 병목이 풀 → 행 락 → CPU로 옮겨 가는 것을 USE 근거로 설명해야 한다.
- **처리 방식(분석 절차):**
  1. 기준 시나리오(G02 `conditional-update`, G11 `external-out-of-tx` 등)에 `ramping-arrival-rate` 계단 부하
  2. 단계별 처리량, p99, 풀 대기, 락 대기, CPU·스로틀링 기록 → 무릎 지점 표시
  3. 병목 하나를 풀고(풀 크기↑, 버킷 분할, 인스턴스↑) 다시 측정 → 병목 이동 기록
  4. Little's law: 필요한 동시 커넥션 L = λ(도착률) × W(커넥션 보유 시간)로 풀 크기 예측 vs in-flight·active 실측(G11·G13이 이 계산을 참조)
  5. 비용 상대 표현: "인스턴스 2→3대(+50% 자원)에서 무릎 위치 변화" 형태로만 서술
- **불변식:** 기준 시나리오의 불변식 그대로.
- **측정 지표:** 목표 vs 실제 도착률, `dropped_iterations`, 단계별 p50/p99(표본 수), USE 지표 전체.
- **부하 모델:** open(계단). closed로 하면 coordinated omission 때문에 무릎이 가려진다.
- **망가뜨리기:** 없음(분석 시나리오). 필요 시 G13과 결합.
- **무대 장면:** `gate-and-pool` + HUD에 현재 계단 단계.
- **학습 포인트(learn.yaml concepts·situations 요약):** 병목 판정과 원인 서술, 다음 실험 선택. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 첫 병목은 무엇일까? ② 그것을 풀면 다음은? ③ 앱 인스턴스를 늘려도 무릎이 안 움직이는 경우는?
- **로컬 재현 한계:** 단일 머신이라 모든 컨테이너가 같은 CPU를 나눈다. 무릎의 절대 위치는 의미 없고 병목 이동 순서만 본다.

### G17 캐시 스탬피드와 무효화 경쟁

- **문제:** 인기 키가 만료되는 순간 요청이 한꺼번에 DB로 몰리고(스탬피드), 갱신과 무효화 순서가 꼬이면 오래된 값이 캐시에 다시 들어간다.
- **처리 방식:**
  1. `no-cache` (기준선)
  2. `cache-aside` 고정 TTL (스탬피드 시연)
  3. `single-flight` 인스턴스 내 / Redis 락 기반 분산 single-flight
  4. `early-refresh` 확률적 조기 갱신
  5. `swr` stale-while-revalidate
  6. `ttl-jitter` TTL 지터
  7. 무효화: `delete-then-update`(경쟁 시 stale 재적재, broken) → `update-then-delete-after-commit` → `delayed-double-delete` → `version-key`(키에 버전 포함)
  8. 핫 키·대형 키: 큰 값 직렬화 비용, Redis 단일 스레드 지연 관찰
- **불변식:** 커밋 후 허용 창(설정값)이 지난 뒤에도 stale을 읽은 수 0.
- **측정 지표:** 캐시 히트율, 만료 순간 DB 쿼리 스파이크, DB p99, stale 읽기 수와 지속 시간, Redis 명령 지연, 큰 값 GET 지연.
- **부하 모델:** open(스탬피드는 도착률 고정에서 보인다). Zipf 분포로 핫 키 생성.
- **망가뜨리기:** 인위적 일괄 만료, Redis stop(캐시 장애 시 DB 보호), 경합 창 지연 주입(무효화 경쟁).
- **무대 장면:** `cache-shelf` — 진열대가 비는 순간 창고로 몰려가는 군중.
- **학습 포인트(learn.yaml concepts·situations 요약):** single-flight, 조기 갱신, 무효화 순서, 버전 키. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 만료 순간 DB로 몇 개 요청이 갈까(인스턴스 수와의 관계)? ② 커밋 전에 삭제하면 어떤 순서에서 stale이 남나? ③ SWR이 맞지 않는 데이터는?
- **로컬 재현 한계:** 충실. Redis 네트워크 지연이 0에 가까워 캐시 이득이 과소/과대될 수 있음(toxiproxy로 보정 가능).

### G18 아웃박스와 멱등 컨슈머

- **문제:** DB 커밋과 메시지 발행은 원자적이지 않다. 커밋 후 발행 전 죽으면 유실, 발행 후 커밋 실패면 유령 메시지.
- **처리 방식:**
  1. `dual-write-commit-first` 커밋 후 Redis Streams `XADD` (유실 시연)
  2. `dual-write-publish-first` 발행 후 커밋 (유령 시연)
  3. `outbox` 같은 트랜잭션에 outbox 행 기록 + 릴레이(`SKIP LOCKED`로 집어 발행 후 표시) (fixed)
  4. `idempotent-consumer` 처리 이력 테이블 유니크(message_id)로 중복 무해화 (fixed)
- **불변식:** 커밋된 비즈니스 행마다 컨슈머 효과 정확히 1회(유실 0, 중복 효과 0), 커밋 안 된 행의 효과 0.
- **측정 지표:** 발행 지연(커밋→소비), outbox 백로그, 릴레이 처리율, 중복 수신 수(효과는 0이어야), Streams pending.
- **부하 모델:** open.
- **망가뜨리기:** 커밋과 발행 사이 app kill(지연 주입으로 창 확대), 릴레이 kill, 컨슈머 kill 후 재시작.
- **무대 장면:** `worker-pool` — 우편함(outbox)과 집배원(릴레이).
- **학습 포인트(learn.yaml concepts·situations 요약):** outbox 쓰기, 릴레이, 멱등 컨슈머. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① kill 시점에 따라 유실과 중복 중 무엇이 생기나? ② 아웃박스여도 중복은 생긴다 — 왜? ③ 순서 보장이 필요하면 무엇을 바꿔야 하나?
- **로컬 재현 한계:** 브로커가 Redis Streams 단일 노드. Kafka 등의 파티션 순서·리밸런싱은 다루지 않음.

### G19 인덱스·실행계획·페이지네이션

- **문제:** 수백만 행 테이블에서 인덱스 순서·커버링·부분 인덱스와 OFFSET 페이지네이션이 지연을 좌우한다. 테이블이 `shared_buffers`보다 작으면 차이가 잘 안 보인다.
- **처리 방식:**
  1. `no-index` (기준선)
  2. `wrong-composite-order` 복합 인덱스 컬럼 순서가 질의와 안 맞음
  3. `right-composite-order` (fixed)
  4. `covering` `INCLUDE`로 Index Only Scan (fixed, visibility map·vacuum 상태 영향)
  5. `partial` `WHERE status = 'open'` 부분 인덱스 (fixed)
  6. 페이지네이션: `offset` (깊은 페이지 악화) vs `keyset` 커서 (fixed)
  7. 일반 계획 vs 맞춤 계획: Zipf 분포 값(흔한 값/드문 값)에 같은 prepared 쿼리를 쓸 때 `plan_cache_mode` `auto` / `force_generic_plan` / `force_custom_plan` 비교 (흔한 값에 맞는 계획이 드문 값에 쓰이는 함정)
- **불변식:** 같은 질의 결과가 strategy 간 동일(해시).
- **측정 지표:** `EXPLAIN (ANALYZE, BUFFERS)`의 shared hit/read, 실행 시간, 계획 노드 종류, 페이지 깊이별 지연, 인덱스 크기, 쓰기 처리량 영향(인덱스 비용).
- **부하 모델:** open(읽기 지연). 쓰기 영향은 배경 쓰기 부하 추가.
- **망가뜨리기:** `shared_buffers` 축소 설정(재시작), 통계 미갱신 상태(ANALYZE 생략) 비교.
- **무대 장면:** `generic-timeline` + 계획 트리 시각화.
- **학습 포인트(learn.yaml concepts·situations 요약):** 인덱스 설계, keyset 쿼리, 계획 해석. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 1000페이지째 OFFSET은 1페이지 대비 무엇이 늘어나나? ② 커버링 인덱스인데 Heap Fetches가 남는 이유는? ③ 부분 인덱스를 플래너가 안 쓰는 조건은?
- **로컬 재현 한계:** 템플릿이 커서 `CREATE DATABASE ... STRATEGY FILE_COPY`로 복제한다. 테이블을 shared_buffers보다 크게 만들어야 하지만 OS 페이지 캐시(VM) 때문에 "디스크 읽기"가 실제 디스크가 아닐 수 있음(`osCacheControlled: false` 표시).

### G20 무중단 스키마 변경

- **문제:** 긴 트랜잭션이 테이블을 잡고 있을 때 `ALTER TABLE`이 `ACCESS EXCLUSIVE` 락을 기다리면, 그 뒤의 모든 SELECT까지 줄을 선다(lock queue). 일반 `CREATE INDEX`는 쓰기를 막는다.
- **처리 방식:**
  1. `alter-behind-long-tx` 장기 트랜잭션 뒤 ALTER (broken 시연)
  2. `lock-timeout-retry` `SET lock_timeout` + 재시도 (fixed)
  3. `create-index` vs `create-index-concurrently` (fixed, 트랜잭션 블록 불가·실패 시 INVALID 인덱스 정리). MikroORM은 `migrations.transactional: true`가 기본이라 해당 마이그레이션만 `transactional: false`로 두거나 오케스트레이터가 raw SQL로 실행한다
  4. `expand-contract` 컬럼 이름 변경을 새 컬럼 추가 → 이중 쓰기 → 백필 → 읽기 전환 → 구 컬럼 제거로 분할 (fixed)
- **불변식:** 변경 중 요청 실패 수(설정한 허용치 이내), 백필 후 신·구 컬럼 값 일치.
- **측정 지표:** 락 대기 차단 트리 길이, 대기 SELECT 수, 요청 p99·실패, ALTER 대기 시간, 인덱스 생성 시간.
- **부하 모델:** open(읽기·쓰기 혼합 일정 도착률) + 변경 작업 예약.
- **망가뜨리기:** 장기 트랜잭션 주입(오케스트레이터), 변경 도중 세션 kill.
- **무대 장면:** `queue-at-counter` — 공사 인부(ALTER)가 줄 맨 앞에 서자 뒤 손님이 전부 멈춤.
- **학습 포인트(learn.yaml concepts·situations 요약):** 마이그레이션 단계 설계, lock_timeout 재시도, 백필. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① ALTER가 기다리는 동안 새 SELECT는 왜 막히나? ② CONCURRENTLY는 무엇을 대가로 치르나? ③ expand/contract 중 롤백 지점은?
- **로컬 재현 한계:** 충실. 테이블 크기에 따른 시간만 다름.

### G21 장기 트랜잭션·vacuum·bloat

- **문제:** 오래 열린 트랜잭션은 vacuum이 dead tuple을 치우지 못하게 막아 테이블·인덱스가 부풀고 갱신이 느려진다. HOT update가 안 되면 인덱스까지 매번 갱신된다.
- **처리 방식:**
  1. `long-tx-present` 장기 트랜잭션(또는 `idle in transaction`) 상태에서 갱신 부하 (broken)
  2. `no-long-tx` + `idle_in_transaction_session_timeout` (fixed)
  3. `fillfactor` 낮춰 HOT update 여지 확보 (tradeoff)
  4. `indexed-column-update` 인덱스 걸린 컬럼 갱신(HOT 불가) vs 비인덱스 컬럼 갱신
- **불변식:** 데이터 값 정합성(갱신 결과 체크섬) — 성능 시나리오지만 값은 같아야 함.
- **측정 지표:** `n_dead_tup`, `n_tup_hot_upd / n_tup_upd`, 테이블·인덱스 크기, autovacuum 실행 시각·횟수, 갱신 p99, 가장 오래된 xmin 나이.
- **부하 모델:** open(갱신 일정 도착률), soak(장시간).
- **망가뜨리기:** 장기 트랜잭션 주입·해제, autovacuum 설정 변경.
- **무대 장면:** `generic-timeline` + 테이블 크기 게이지.
- **학습 포인트(learn.yaml concepts·situations 요약):** 갱신 패턴 설계, 원인 해석. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 장기 트랜잭션을 끝내면 테이블 크기는 줄어들까? ② HOT update의 두 조건은? ③ fillfactor를 낮추면 무엇이 나빠지나?
- **로컬 재현 한계:** soak 시간을 짧게 압축해야 한다. bloat 진행 속도는 실제와 다름.

### G22 대용량 export 스트리밍

- **문제:** 수십만 행을 메모리에 모아 xlsx를 만들면 힙이 터지고 첫 바이트가 늦다. 느린 클라이언트에 백프레셔 없이 쓰면 버퍼가 쌓인다.
- **처리 방식:**
  1. `load-all-build` 전체 조회 → 메모리에서 xlsx 생성 (broken)
  2. `cursor-stream-csv` DB 커서(`pg-query-stream` 등) → CSV 스트림, 백프레셔 존중 (fixed)
  3. `cursor-stream-xlsx` 커서 → exceljs `stream.xlsx.WorkbookWriter` (fixed. npm의 SheetJS는 갱신이 멈춰 쓰지 않는다)
  4. `ignore-backpressure` `write()` 반환값 무시 (broken 시연)
- **불변식:** 파일 행 수 = 질의 결과 행 수, 체크섬 일치.
- **측정 지표:** 힙 최대, TTFB, 총 시간, 동시에 걸린 경량 엔드포인트 p99와 이벤트 루프 지연, 커서 보유 중 트랜잭션 시간.
- **부하 모델:** 동시 export 수를 closed로 고정 + 경량 엔드포인트 open 배경 부하.
- **망가뜨리기:** 느린 클라이언트(toxiproxy `bandwidth` toxic을 클라이언트 경로에), 다운로드 중 연결 끊기(`reset_peer`).
- **무대 장면:** `conveyor` — 벨트 끝 트럭이 느리면 벨트가 멈추는지(백프레셔) 쌓이는지.
- **학습 포인트(learn.yaml concepts·situations 요약):** 스트림 파이프라인, 백프레셔 처리, 끊김 시 커서 정리. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 스트리밍이면 힙은 행 수와 무관할까? ② 느린 클라이언트가 DB에 주는 영향은(장기 트랜잭션, G21)? ③ 중간에 끊기면 커서는 누가 닫나?
- **로컬 재현 한계:** 느린 클라이언트를 toxiproxy로 근사. 실제 모바일 망 특성과 다름.

### G23 읽기 복제본과 복제 지연

- **문제:** 쓰기 직후 복제본에서 읽으면 방금 쓴 값이 안 보인다(read-your-writes 위반).
- **처리 방식:**
  1. `primary-only` 전부 주 DB (기준선). MikroORM은 `replicas`를 설정하면 `preferReadReplicas`가 기본 true라 읽기가 복제본으로 간다 → `preferReadReplicas: false` 또는 쿼리별 `connectionType: 'write'`로 고정
  2. `replica-reads` 읽기는 복제본(`connectionType: 'read'` 또는 기본값) (위반 시연)
  3. `pin-after-write` 쓰기 후 일정 시간 해당 사용자 읽기를 주 DB로 고정 (fixed, 시간 설정 근거 필요)
  4. `lsn-wait` 쓰기 후 `pg_current_wal_lsn()` 저장 → 복제본에서 `pg_last_wal_replay_lsn()`이 그 이상이 될 때까지 대기(상한 후 주 DB 폴백) (fixed)
  - 트랜잭션 안의 읽기는 설정과 무관하게 항상 primary로 간다(강제 primary 경로로 활용 가능)
- **불변식:** 쓰기 성공 직후 같은 사용자의 읽기가 자기 쓰기를 반영(위반 수 0, strategy 3·4).
- **측정 지표:** 복제 지연(`pg_stat_replication.replay_lag`), 위반 수, 주/복제 읽기 비율, LSN 대기 시간·폴백 수, 읽기 p99.
- **부하 모델:** closed(쓰기 후 즉시 읽기 사용자 흐름) + open 배경 읽기.
- **망가뜨리기:** `recovery_min_apply_delay`로 지연 확대, 복제본 중지.
- **무대 장면:** `broadcast` — 본점 장부와 지점 장부, 지점 장부가 늦게 갱신.
- **학습 포인트(learn.yaml concepts·situations 요약):** 라우팅 규칙, LSN 대기, 폴백. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 로컬 복제 지연은 평소 얼마나 작을까, 그래도 위반이 나올까? ② pin 시간은 무엇으로 정하나? ③ 복제본이 죽으면 각 strategy는?
- **로컬 재현 한계:** 로컬 복제 지연은 매우 작아 인위 지연이 필요(주입 표시).

### G24 그레이스풀 셧다운·롤링 재시작

- **문제:** 배포 중 인스턴스가 SIGTERM을 무시하거나 즉시 죽으면 진행 중 요청이 실패한다. 셸 형태 CMD는 PID 1이 셸이라 시그널이 앱에 안 간다.
- **처리 방식:**
  1. `shell-form-no-hooks` 셸 형태 CMD, 셧다운 훅 없음 (broken). 셸이 명령 하나뿐이면 셸이 그 명령으로 exec해 버려 재현이 안 될 수 있으므로 `sh -c "node main.js; echo exit"`처럼 두 명령으로 만든다(신뢰도 중)
  2. `exec-form-init` exec form + init, `enableShutdownHooks` (부분)
  3. `drain` 오픈소스 nginx에는 능동 헬스체크가 없으므로(수동 판정 `max_fails=1`, `fail_timeout=10s` 기본) readiness 실패에 기대지 않는다. SIGTERM → `server.close()`로 새 연결 거부 → nginx `proxy_next_upstream error`로 다음 인스턴스에 재전송(연결 거부는 upstream 전달 전이라 POST도 재전송) → in-flight drain → 풀 종료, `stop_grace_period` > drain 제한 (fixed). nginx↔app upstream keepalive의 idle 연결이 끊길 때의 동작은 따로 검증한다. 대안: 오케스트레이터가 SIGTERM 전에 upstream에서 빼고 `nginx -s reload`
  4. SSE 종료 이벤트와 `Last-Event-ID` 재연결은 T07 `redis-streams-replay`를 그대로 쓴다(T07 참조)
- **불변식:** 롤링 재시작(3대 순차) 동안 요청 실패 0, SSE 이벤트 누락 0.
- **측정 지표:** 재시작 구간 실패 수·상태 코드, 종료 소요 시간, drain된 요청 수, SSE 재연결 시간·누락 수.
- **부하 모델:** open(일정 도착률 유지 중 재시작).
- **망가뜨리기:** 롤링 재시작, SIGKILL과 비교.
- **무대 장면:** `broadcast` — 방 하나씩 불이 꺼지고 손님이 옆방으로 옮김.
- **학습 포인트(learn.yaml concepts·situations 요약):** 셧다운 순서, drain 로직, SSE 재연결 계약. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① nginx가 죽어 가는 인스턴스로 보낸 요청은 어떻게 되나? ② `stop_grace_period`보다 drain이 길면? ③ POST 요청은 nginx가 언제 재시도하고 언제 안 하나? (답: 연결 거부처럼 upstream에 전달되기 전 실패는 재전송, 이미 전달된 뒤 끊기면 `non_idempotent`를 켜지 않는 한 재전송 안 함)
- **로컬 재현 한계:** 오픈소스 nginx의 upstream 장애 감지는 수동형(`max_fails`/`fail_timeout`)뿐이라 능동 헬스체크 기반 배포 흐름은 재현하지 않는다.

### G25 컨테이너 리소스 제한

- **문제:** CPU limit은 CFS 쿼터로 구현되어 짧은 버스트에서 스로틀링 → 꼬리 지연이 생긴다. 메모리 limit보다 V8 힙 한도가 크면 힙 OOM 대신 컨테이너가 OOMKilled된다.
- **처리 방식:**
  1. `cpu-fractional` `cpus: 0.5` vs 1.0 vs 2.0, 같은 도착률에서 p99 비교
  2. `heap-gt-limit` 메모리 limit 512m, `--max-old-space-size`를 limit보다 크게 명시 (broken). Node 20+는 cgroup limit을 인식해 기본 힙이 limit의 약 50%라 "미설정"으로는 OOMKilled가 나지 않는다
  3. `heap-lt-limit` 힙 한도를 limit보다 여유 있게 작게 (fixed)
  4. `offheap-overrun` 힙 < limit이어도 Buffer 등 off-heap 메모리로 RSS가 limit을 넘으면 OOMKilled (broken 시연)
- **불변식:** 해당 없음(관찰 시나리오) — 단 처리 중이던 요청의 부작용 정합성은 기준 시나리오 불변식 적용.
- **측정 지표:** `container_cpu_cfs_throttled_seconds_total`, p99, GC pause, 힙, RSS, OOM 이벤트, 재시작 횟수.
- **부하 모델:** open.
- **망가뜨리기:** limit 변경(사용자가 재생성), 메모리 누수 주입 엔드포인트(힙 / off-heap Buffer).
- **무대 장면:** `gate-and-pool` + CPU 쿼터 게이지.
- **학습 포인트(learn.yaml concepts·situations 요약):** limit·힙 설정 근거와 해석. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 평균 CPU 사용률이 낮은데 스로틀링이 생기는 이유는? ② OOMKilled와 힙 OOM은 로그에서 어떻게 구분되나? ③ 힙 한도를 limit과 같게 두면 안 되는 이유는?
- **로컬 재현 한계:** Docker Desktop VM 위의 cgroup이라 스로틀링 지표 수집 가능 범위는 실험 필요(DESIGN §14 #3). limit 변경은 컨테이너 재생성이 필요해 사용자가 호스트에서 `docker compose up -d`로 바꾼다(오케스트레이터 권한 밖).

### G26 로그 볼륨

- **문제:** debug 레벨로 동기 출력하면 로그 쓰기가 요청 경로를 막고 이벤트 루프 지연을 키운다.
- **처리 방식:**
  1. `debug-sync` debug 레벨 + 동기 출력 (broken)
  2. `info-sync` info 레벨 + 동기
  3. `info-async` pino 비동기 destination 또는 transport(워커 스레드) (fixed, 크래시 시 마지막 로그 유실 위험)
- **불변식:** 해당 없음(관찰). 크래시 시나리오에서 유실 로그 수를 기록.
- **측정 지표:** p99, 이벤트 루프 지연, CPU, 로그 바이트/초, Loki 수집 지연, 크래시 시 유실 줄 수.
- **부하 모델:** open.
- **망가뜨리기:** 부하 중 SIGKILL(비동기 버퍼 유실 확인).
- **무대 장면:** `generic-timeline`.
- **학습 포인트(learn.yaml concepts·situations 요약):** 로깅 정책 결정과 해석. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 로그 레벨과 출력 방식 중 무엇이 더 큰 영향을 줄까? ② 비동기 로깅의 대가는? ③ 컨테이너 stdout 드라이버도 병목이 될까?
- **로컬 재현 한계:** Docker 로그 드라이버·Alloy 수집 경로가 운영과 다름.

### G27 배치 vs 스트리밍 집계 (Redis Streams)

- **문제:** 집계를 주기 배치로 하면 늦고, 스트리밍으로 하면 컨슈머 장애 시 누락·중복 처리를 따로 해야 한다.
- **처리 방식:**
  1. `periodic-batch` 주기 SQL 집계 (기준선)
  2. `stream-consumer-group` `XADD` → `XREADGROUP` → 처리 → `XACK` (fixed)
  3. `stream-reclaim` 죽은 컨슈머의 pending을 `XAUTOCLAIM`/`XCLAIM`으로 회수 (fixed)
- **불변식:** 최종 집계 = 원천 이벤트 기준 재계산 값(재조정 검사).
- **측정 지표:** 집계 신선도(이벤트→반영 지연), pending 수, 회수 수, 처리율, DB 부하 비교.
- **부하 모델:** open(이벤트 생산률 고정).
- **망가뜨리기:** 컨슈머 kill, Redis 재시작(AOF 설정별: `always` ≈ 무손실, `everysec` 최대 약 1초(최악 2초), `no`는 OS 플러시 주기. 기본 `appendonly no`면 마지막 RDB 이후 유실 — 실행 설정에 명시).
- **무대 장면:** `worker-pool`.
- **학습 포인트(learn.yaml concepts·situations 요약):** 컨슈머 로직, 회수, 재조정. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① XACK 전에 죽으면 그 메시지는? ② 집계를 멱등하게 만드는 방법은? ③ 배치가 더 나은 경우는?
- **로컬 재현 한계:** 단일 Redis. 파티셔닝·확장은 다루지 않음.

### G28 PostgreSQL 페일오버

- **문제:** 주 DB가 죽으면 복제본 승격과 앱 재연결이 필요하다. 비동기 복제면 커밋됐다고 응답한 쓰기가 사라질 수 있다.
- **처리 방식:**
  1. `manual-promote` `pg_promote()`로 승격, 앱은 재시작으로 재연결 (기준선)
  2. `proxy-switch` toxiproxy(또는 DNS 별칭) 업스트림을 새 주 DB로 전환 + 풀 재연결 (개선)
  3. `sync-replication` `synchronous_commit`/`synchronous_standby_names`로 동기 복제 비교 (tradeoff: 쓰기 지연)
- **불변식:** 성공 응답을 받은 쓰기가 새 주 DB에 존재(비동기 복제에서 위반 가능 — 그 수를 기록).
- **측정 지표:** 쓰기 불가 구간 길이, 실패 요청 수, 유실된 확인 쓰기 수, 재연결 시간, 쓰기 p99(동기 vs 비동기).
- **부하 모델:** open.
- **망가뜨리기:** 주 DB SIGKILL. 비동기 복제의 유실 창을 재현 가능한 크기로 키우려고 primary–replica 사이에 toxiproxy를 두고 WAL 전송 지연을 건다.
- **무대 장면:** `broadcast` — 본점 폐쇄, 지점이 본점이 됨.
- **학습 포인트(learn.yaml concepts·situations 요약):** 재연결·재시도 처리, 유실 검사. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 비동기 복제에서 유실 창은 무엇이 정하나? ② 앱 풀은 죽은 연결을 언제 알아차리나? ③ 동기 복제의 비용은?
- **로컬 재현 한계:** 자동 페일오버(Patroni 등)는 다루지 않는다. 수동 절차만.

### G29 오토스케일링 반응 (k3d + HPA)

- **문제:** 오토스케일은 즉시가 아니다. 지표 수집 주기 → 판단 → 파드 기동 → readiness까지의 지연 동안 기존 인스턴스가 버텨야 한다.
- **처리 방식:**
  1. `hpa-cpu` CPU 기준 HPA, 스파이크 부하
  2. `hpa-with-admission` + G13 admission control로 확장 전 구간 보호
  3. `pre-scaled` 미리 확장 (비교 기준)
- **불변식:** 기준 시나리오 불변식.
- **측정 지표:** 스파이크 시작 → 레플리카 증가 → ready까지 각 단계 시각, 그 구간 p99·실패, 상대 자원 사용량(레플리카·시간).
- **부하 모델:** open(스파이크).
- **망가뜨리기:** metrics-server 지연, 파드 기동 지연(readiness 지연 주입).
- **무대 장면:** `gate-and-pool` — 의자가 뒤늦게 추가됨.
- **학습 포인트(learn.yaml concepts·situations 요약):** 해석과 보호 전략. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 확장 지연의 가장 큰 구간은? ② 스케일 다운이 너무 빠르면? ③ admission control 없이 확장만 믿으면?
- **로컬 재현 한계:** **기본 docker compose 경로가 아닌 별도 확장 트랙**(`infra/k3d`). "반응 순서"만 보이고 시간 값은 주장하지 않는다.

### G30 샤딩 (설계 글, 실행 없음)

- **문제:** 단일 DB의 쓰기 한계를 넘으려면 데이터를 나눠야 하지만, 샤드 키 선택·샤드 간 트랜잭션·재분배가 설계를 지배한다.
- **처리 방식(글로 비교):** 해시 샤딩, 범위 샤딩, 디렉터리 기반, 테넌트(세무사무소) 단위 샤딩. 세무 팩 기준 "사무소 ID 샤드 키" 사례 서술.
- **불변식(설계상):** 샤드 간 트랜잭션이 필요한 불변식 목록과 대안(사가, 아웃박스 — G18 연결).
- **측정 지표:** 없음. 실행 시나리오가 아니다.
- **부하 모델:** 없음.
- **망가뜨리기:** 없음.
- **무대 장면:** 없음(정적 다이어그램).
- **학습 포인트(learn.yaml concepts·situations 요약):** 설계 글 전체(코드 없음, concepts 중심). 상황별 판단 근거를 코드 실험실 개념 카드로 읽는다.
- **예측 질문:** ① 세무 팩에서 샤드 키를 사무소로 하면 깨지는 기능은? ② 재분배 중 쓰기는 어떻게 하나?
- **로컬 재현 한계:** **단일 머신에서 샤딩 효과를 재현했다고 주장하지 않는다.** 라우팅 로직을 같은 PG의 DB 두 개로 시연할 수는 있으나 성능 주장 없이 "동작 시연"으로만 표기.

---

## 세무 팩 (tax)

공통 도메인: 세무사무소(office), 세무사(user, 역할: 작성자/검토자/승인자), 고객(client), 신고서(tax_return: 상태 `DRAFT → REVIEW → APPROVED → SUBMITTED`), 신고 버전(return_version), 첨부·임포트 작업.

### T01 세무사 둘 동시 신고서 수정·승인

- **문제:** 신고서를 고치는 요청과 승인하는 요청이 동시에 도착하면, 승인자가 본 적 없는 내용이 승인된 상태로 남거나 승인 뒤에 수정이 들어갈 수 있다. 작성자가 스스로 승인하는 경로도 막아야 한다. 수정끼리의 덮어쓰기(lost update)는 G01과 같은 메커니즘이라 G01 결과를 참조하고(`naive-overwrite`·`blind-retry`·`optimistic-version`·`field-merge`·`edit-lease`는 여기서 다시 만들지 않는다), T01은 **수정 vs 승인 동시 도착**과 **작성자≠승인자**에 집중한다. **수정 경로는 G01 `optimistic-version` 그대로이고 상태 술어만 추가한다.** 조건의 `version`은 신고서 행(`tax_return`)의 `version` 컬럼이다(`return_version`은 이력 테이블이며 비교 대상이 아니다). 승인 409 응답은 G01 계약(본문 `version`, 409, `reason`)과 일치시킨다.
- **처리 방식:**
  1. `approve-by-status-only` 승인이 `WHERE status = 'REVIEW'`만 확인 (broken: 승인 직전에 들어온 수정이 승인 내용에 섞임)
  2. `approve-with-version` 승인 요청이 자신이 검토한 버전(본문 `version` = `tax_return.version`)을 들고 와 `WHERE status = 'REVIEW' AND version = :v` 조건부 전이, 영향 행 0이면 409(`reason: version_mismatch`, 본문에 `currentVersion`과 최신 diff) (fixed)
  3. `edit-guard-by-status` 수정은 G01 `optimistic-version` 그대로 `WHERE status IN ('DRAFT','REVIEW') AND version = :v`로만 허용(상태 술어만 추가), 승인 후 수정은 상태 조건으로 거절 (fixed)
  4. `self-approval` 작성자≠승인자 검증 비교: 서비스 검증만 (경합·우회 경로에서 뚫림, broken) vs 같은 행 CHECK 제약(`approved_by <> prepared_by`) + 서비스 검증 (fixed)
- **불변식:** `approved_by ≠ prepared_by`, 승인된 버전 = 승인 요청이 들고 온 버전(원장: 승인 요청 ID·검토 버전·txid), 승인 시각 이후 내용 변경 0(버전 이력 기준), 상태 전이 순서 위반 0.
- **측정 지표:** 승인 409 비율, 승인 거절 사유별 수(버전 불일치/상태/자기 승인), 수정·승인 지연.
- **부하 모델:** closed(배지: 지연은 해석 주의). 신고서당 세무사 2~5명, 수정과 승인 행위 혼합.
- **망가뜨리기:** 경합 창 지연 주입(승인 직전, 수정의 읽기 후).
- **무대 장면:** `shared-document` — 신고서 위에 도장(승인) 찍히면 자물쇠. (시안이 보여주는 장면은 G01이며 T01 장면은 같은 무대 타입을 재사용한다.)
- **학습 포인트(learn.yaml concepts·situations 요약):** 상태기계, 조건부 전이, 제약. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 승인과 수정이 동시에 오면 어느 쪽이 이겨야 하고, 코드로 어떻게 보장하나? ② CHECK 제약과 서비스 검증 중 하나만 두면? ③ 승인 요청에 버전을 싣지 않으면 승인자는 무엇을 승인한 셈인가?
- **로컬 재현 한계:** 실제 편집 간격을 압축. 메커니즘 관찰용.

### T02 승인자 최소 1명 (write skew)

- **문제:** "신고서마다 담당 승인자 최소 1명" 규칙. 승인자 둘이 동시에 자기 배정을 빼면 각자 "다른 사람이 남아 있다"고 보고 빼서 0명이 된다. 서로 다른 행을 고쳐서 행 락으로 안 막힌다.
- **처리 방식:**
  1. `read-committed-check` READ COMMITTED에서 개수 확인 후 삭제 (broken)
  2. `repeatable-read` PG의 REPEATABLE READ(스냅샷 격리)도 write skew를 허용함을 확인 (broken)
  3. `serializable-retry` SERIALIZABLE + `40001` 재시도 (fixed, 재시도 비용)
  4. `parent-row-lock` 신고서 행을 `FOR UPDATE`로 잠그고 확인 (fixed)
  5. `materialized-count` 신고서 행에 `approver_count` 유지 + `CHECK (approver_count >= 1)` (fixed)
- **불변식:** 모든 신고서의 승인자 수 ≥ 1.
- **측정 지표:** 위반 수, 40001 수·재시도 횟수, 처리량, 락 대기.
- **부하 모델:** closed(동시 해제 쌍, 배지: 지연은 해석 주의).
- **망가뜨리기:** 경합 창 지연 주입(확인 후 삭제 전).
- **무대 장면:** `shared-document` 변형 — 두 명이 서로를 보며 동시에 퇴장.
- **학습 포인트(learn.yaml concepts·situations 요약):** 격리 수준별 구현, 재시도, 카운트 유지. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① REPEATABLE READ에서 왜 막히지 않나? ② SERIALIZABLE 재시도율은 경합 밀도에 따라 어떻게 변할까? ③ 부모 행 잠금과 SERIALIZABLE 중 무엇을 고를까?
- **로컬 재현 한계:** 충실.

### T03 엑셀 수만 건 임포트

- **문제:** 고객 거래 내역 엑셀 수만 행을 올린다. 통째로 읽으면 메모리가 터지고 이벤트 루프가 멈추며, 중간에 죽으면 어디까지 들어갔는지 모른 채 다시 올려 중복이 생긴다.
- **처리 방식:**
  1. `load-all-sync` 파일 전체 메모리 적재 + 요청 안에서 동기 처리 (broken)
  2. `stream-parse` 스트리밍 파싱(행 단위, exceljs `stream.xlsx.WorkbookReader`), 행 검증
  3. `chunked-commit-progress` 청크 단위 커밋 + **진행 기록(`import_jobs.last_row`)을 데이터와 같은 트랜잭션에** (fixed)
  4. `background-job` 업로드 즉시 작업 ID 반환, 백그라운드 워커 처리 + 진행률(SSE 또는 폴링) (fixed, **4단계** — 워커 컨테이너·SSE 구독기가 갖춰진 뒤)
  5. `resume-after-crash` 재시작 시 `last_row` 다음부터 이어서, 행 식별 키(파일 해시 + 행 번호) 유니크로 중복 차단 (fixed)
  6. `failed-rows-download` 검증 실패 행을 사유와 함께 파일로 재다운로드
  7. 파싱 위치 비교: 메인 스레드 vs worker_threads(2단계) vs 별도 워커 프로세스(**4단계**, G15 연결)
- **불변식:** kill 후 이어서 완료했을 때 **중복 0·누락 0**(성공 행 수 + 실패 행 수 = 원본 행 수, DB 행 = 성공 행), 진행 기록과 실제 커밋 행 일치.
- **측정 지표:** 총 시간, 힙 최대, 이벤트 루프 지연, 동시에 일정 도착률을 건 다른 API p99, 청크당 시간, 진행률 갱신 간격, 재개까지 시간.
- **부하 모델:** 임포트는 단일 작업(동시 임포트 수는 closed로 1/3/5), 배경 API는 open.
- **망가뜨리기:** 임포트 중 워커/앱 SIGKILL(여러 시점), DB 연결 끊기(toxiproxy `reset_peer`).
- **무대 장면:** `conveyor` — 상자(청크)마다 체크 표시, kill 시 벨트 멈춤 → 재개 시 체크된 곳 다음부터.
- **학습 포인트(learn.yaml concepts·situations 요약):** 스트림 파이프라인, 청크·진행 기록 트랜잭션, 재개, 중복 키, 실패 행 수집. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 진행 기록을 별도 트랜잭션에 쓰면 kill 시점에 따라 무엇이 깨지나? ② 청크 크기를 키우면 무엇이 좋아지고 나빠지나? ③ 메인 스레드 파싱 중 다른 API p99는?
- **로컬 재현 한계:** 업로드 대역폭은 로컬이라 사실상 무제한. 파일 크기는 머신 사양에 맞춰 조정.

### T04 마감 직전 제출 폭주 (통합 캡스톤)

- **배치:** 5단계. G06(멱등), G10(큐), G13(admission control·재시도), 스파이크 프로파일이 모두 갖춰진 뒤 하나의 업무 흐름으로 묶는 통합 시나리오다. 고유한 축은 **사무소별 공정성**(한 사무소의 폭주가 다른 사무소의 제출을 막지 않게)이다.
- **문제:** 신고 마감 직전 제출이 몰린다. 더블 클릭·재시도로 같은 신고가 두 번 제출되거나, 동기 처리로 응답이 밀려 타임아웃 → 재제출 악순환이 생긴다.
- **처리 방식:**
  1. `sync-no-dedupe` 동기 처리, 중복 방지 없음 (broken)
  2. `unique-submission` `(return_id, period)` 최종 제출 유니크 + 멱등키(G06) (fixed)
  3. `accept-then-process` 접수(접수번호 발급, 빠른 응답) 후 비동기 처리(G10 큐), 상태 조회 (fixed)
  4. `admission-control` 동시성 상한 초과 시 429 + `Retry-After`, 클라이언트 지터 재시도 (fixed)
  5. `per-office-limit` 사무소(테넌트)별 동시성·토큰 버킷 상한(G14 Redis 토큰 버킷 재사용) — 전역 admission만 있으면 큰 사무소 하나가 상한을 다 차지함을 보이고 비교 (fixed)
- **불변식:** 신고서·기간당 최종 제출 1건, 발급된 접수번호는 모두 최종 처리(누락 0), 제출 후 신고 내용 변경 0.
- **측정 지표:** 스파이크 구간 goodput(전체·사무소별), p99(성공/실패), 429 비율(사무소별), 중복 시도 수 vs 중복 생성 수(0), 접수→처리 지연, 회복 시간.
- **부하 모델:** open(스파이크 — `ramping-arrival-rate`로 마감 직전 급증, 사무소 크기는 Zipf). 중복 클릭은 일부 VU가 같은 키로 재전송.
- **망가뜨리기:** 스파이크 중 워커 kill, DB 지연 주입.
- **무대 장면:** `queue-at-counter` — 마감 시계 아래 창구, 접수번호표 기계.
- **학습 포인트(learn.yaml concepts·situations 요약):** 제출 유니크·멱등, 접수-처리 분리, admission, 사무소별 상한. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 동기 처리에서 응답 지연이 클라이언트 타임아웃을 넘으면 무엇이 늘어나나? ② 접수-후-처리로 바꾸면 사용자에게 무엇을 약속해야 하나? ③ 429가 늘면 goodput은?
- **로컬 재현 한계:** 실제 마감 트래픽 모양은 모른다. 스파이크 모양은 가정이며 화면에 가정값 표시.

### T05 수정신고 이력

- **문제:** 수정신고는 이전 값을 덮어쓰면 안 된다(감사·소명). 이력이 수백만 행이 되면 "현재 값" 조회와 이력 조회가 느려진다.
- **처리 방식:**
  1. `overwrite` 덮어쓰기 (broken: 이력 없음)
  2. `append-max-version` 버전 행 추가, 현재 값은 `max(version)`/`DISTINCT ON` 조회
  3. `append-current-flag` `is_current` + 부분 유니크 인덱스(`WHERE is_current`), 같은 트랜잭션에서 **이전 행 플래그 해제 → 새 행 삽입** 순서 (fixed. 유니크 인덱스는 DEFERRABLE로 만들 수 없어 순서를 바꾸면 즉시 위반)
  4. `current-plus-history` 현재 테이블 + 이력 테이블, 같은 트랜잭션 이중 쓰기 (fixed)
  5. 이력 페이지네이션: `(return_id, version DESC)` 인덱스 + keyset (G19 연결)
  6. 동시 수정신고: 버전 번호 충돌 → `(return_id, version)` 유니크 + 재시도
- **불변식:** 신고서별 버전 연속(1..n, 빈 번호·중복 0), 현재 행 정확히 1개, 현재 값 = 최신 버전 값, 과거 버전 내용 변경 0.
- **측정 지표:** 현재 값 조회 p99(처리량 쌍), 이력 조회 페이지 깊이별 지연, 쓰기 처리량, 테이블·인덱스 크기, `EXPLAIN (ANALYZE, BUFFERS)`.
- **부하 모델:** open(조회 지연), closed(동시 수정신고 경합).
- **망가뜨리기:** 경합 창 지연 주입(버전 계산 후 삽입 전), 이력 행 수 스윕(10만/100만/수백만).
- **무대 장면:** `generic-timeline` + 버전 스택.
- **학습 포인트(learn.yaml concepts·situations 요약):** 이력 모델, 버전 발급, 현재 플래그 전환. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① `max(version)` 조회는 이력이 늘면 어떻게 될까(인덱스 유무별)? ② 부분 유니크 인덱스가 막아 주는 버그는? ③ 동시 수정신고에서 버전 번호를 어떻게 발급하나?
- **로컬 재현 한계:** 수백만 행 시드 시간이 길다(템플릿 DB로 재사용, 복제는 `STRATEGY FILE_COPY`). shared_buffers보다 크게 만들어야 차이가 보임.

### T06 신고 이력 파티셔닝

- **문제:** 이력이 계속 쌓이면 오래된 데이터 삭제(DELETE + vacuum)가 무겁고, 날짜 범위 조회가 전체를 훑는다.
- **처리 방식:**
  1. `single-table` 단일 테이블 + `DELETE`로 보관 기간 정리 (기준선)
  2. `range-partition-month` 선언적 범위 파티셔닝(월별), 파티션 pruning 확인 (fixed)
  3. `drop-partition` 오래된 파티션 `DROP`/`DETACH` (fixed)
  4. `no-partition-key-query` 파티션 키 없는 쿼리 → 전 파티션 스캔 (함정 시연)
  - 유니크 제약은 파티션 키를 포함해야 하는 제약, 기본(DEFAULT) 파티션 운용 확인
- **불변식:** 보관 기간 내 행 수 일치(정리 전후), 정리 대상 외 행 손실 0.
- **측정 지표:** 범위 조회 지연, EXPLAIN의 스캔 파티션 수, 정리 작업 시간·WAL 바이트·락, 정리 중 다른 쿼리 p99.
- **부하 모델:** open(조회 + 쓰기 배경) + 정리 작업 예약.
- **망가뜨리기:** 정리 중 장기 트랜잭션 주입(DETACH 대기, G20 연결).
- **무대 장면:** `generic-timeline` + 월별 서랍.
- **학습 포인트(learn.yaml concepts·situations 요약):** 파티션 설계, 키 선택, 정리 절차. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 파티션 키 없는 조회는 단일 테이블보다 느려질 수 있을까? ② DROP과 DELETE의 WAL 양 차이는(모양)? ③ 신고서 ID 기준 조회가 많다면 파티션 키를 날짜로 해도 되나?
- **로컬 재현 한계:** 파티션 수와 데이터 크기를 축소. pruning 동작 자체는 충실.

### T07 승인 즉시 타 화면 반영 (실시간)

- **문제:** 승인하면 같은 신고서를 보고 있는 다른 세무사 화면에 즉시 떠야 한다. 인스턴스 메모리 이벤트는 같은 인스턴스에 붙은 사람에게만 간다(**인스턴스 2대 이상에서만 드러나는 문제**).
- **처리 방식:**
  1. `in-memory-emitter` 인스턴스 내 이벤트 → SSE (2대 이상에서 누락, broken)
  2. `redis-pubsub` Redis pub/sub 팬아웃 (fixed, 연결 끊긴 동안 이벤트는 유실)
  3. `pg-listen-notify` PG `LISTEN/NOTIFY` (fixed, PgBouncer 트랜잭션 모드에서 깨짐 — G12 연결)
  4. `redis-streams-replay` Streams + `Last-Event-ID`로 재연결 시 놓친 이벤트 재전송 (fixed)
  5. 발행 시점: 커밋 전 발행(롤백 시 유령 알림, broken) vs 커밋 후 발행 / 아웃박스(G18)
- **불변식:** 승인 이벤트마다 구독 중인 모든 클라이언트에 정확히 1회 도착(재연결 포함 누락 0), 롤백된 승인의 알림 0.
- **측정 지표:** 커밋→수신 지연 분포, 누락 수, 중복 수신 수, 인스턴스별 연결 수, Redis pub/sub·Streams 지연.
- **부하 모델:** closed(구독자 수 고정) + 승인 이벤트 open. SSE 구독 클라이언트는 별도 Node 구독기 컨테이너(`sse-subscriber`). xk6-sse는 커스텀 k6 빌드가 필요해 쓰지 않는다.
- **망가뜨리기:** 구독자가 붙은 인스턴스 kill(재연결), Redis stop, 롤링 재시작(G24 연결).
- **무대 장면:** `broadcast` — 방송탑에서 방(인스턴스)마다 신호, 끊긴 방은 재연결 후 놓친 방송 수신.
- **학습 포인트(learn.yaml concepts·situations 요약):** 발행 시점, 팬아웃, 재전송 계약. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① 인스턴스 1대에서 `in-memory-emitter`는 통과할까? ② pub/sub로 바꿔도 남는 누락 경로는? ③ Last-Event-ID 재전송 범위는 무엇으로 제한하나?
- **로컬 재현 한계:** 브라우저 수천 개 연결은 재현하지 않는다. 구독자 수를 줄여 메커니즘만 본다.

### T08 사무소 격리(RLS) 컨텍스트 누수

- **문제:** 사무소별 데이터를 RLS 정책(`USING (office_id = current_setting('app.office_id')::bigint)`)으로 격리할 때, 테넌트 컨텍스트를 세션 `SET`으로 넣으면 PgBouncer 트랜잭션 모드에서 서버 연결이 다른 클라이언트에 넘어가며 설정이 남는다. 다음 요청은 **다른 사무소의 데이터**를 정상 응답으로 받는다(G12의 `SET` 누수가 데이터 노출로 이어지는 경우).
- **처리 방식:**
  1. `app-filter-only` RLS 없이 앱 WHERE만 (기준선: 조건을 빠뜨린 쿼리 하나가 곧 노출)
  2. `session-set` 요청 시작에 `SET app.office_id = ...` (direct·session 모드에선 통과, transaction 모드에서 누수, broken)
  3. `set-local` 트랜잭션 안에서 `SET LOCAL` / `set_config('app.office_id', :id, true)` (fixed)
  4. `missing-context` 컨텍스트 없이 들어온 쿼리: `current_setting('app.office_id', true)`가 NULL → 0행(fail-closed) vs 기본값으로 대체(fail-open) 비교
  5. `owner-bypass` 테이블 소유자·superuser·`BYPASSRLS` 역할로 접속하면 RLS가 무시됨을 시연 → 비소유자 역할 `lab_app` + `FORCE ROW LEVEL SECURITY` (fixed)
- **불변식:** 조회 원장(요청 ID, 요청 사무소, 반환 행의 `office_id` 집합, txid)을 같은 트랜잭션에 남기고, 요청 사무소와 다른 `office_id`가 반환된 행 수 0. 컨텍스트 없는 요청의 반환 행 0(fail-closed strategy).
- **측정 지표:** 교차 노출 건수, DB 경로(direct / session / transaction)별 처리량, PgBouncer `sv_active`·`cl_waiting`, `set_config` 추가 비용(p99 차이).
- **부하 모델:** closed(배지: 지연은 해석 주의). 서로 다른 사무소 사용자를 섞어 동시에 조회·수정. 앱 인스턴스 2대 이상, DB 경로는 pgbouncer transaction 모드가 기본.
- **망가뜨리기:** PgBouncer `default_pool_size` 축소(서버 연결 재사용 빈도 증가), 경합 창 지연 주입(`SET` 후 쿼리 전), PgBouncer 재시작.
- **무대 장면:** `gate-and-pool` — 의자(서버 연결)에 앞사람 사무소 명찰이 남아 있고, 다음 사람이 그 명찰로 다른 사무소 서랍을 엶.
- **학습 포인트(learn.yaml concepts·situations 요약):** RLS 정책, 컨텍스트 주입 위치(트랜잭션 경계), 역할·권한 설계, 원장 검사 SQL. 부하·상황별로 어떤 코드가 들어가고 왜 그런지를 코드 실험실에서 비교한다.
- **예측 질문:** ① session 모드에서는 왜 누수가 안 보이나? ② `SET LOCAL`을 트랜잭션 밖에서 실행하면 어떻게 되나? ③ 마이그레이션·관리 작업용 역할과 앱 역할을 나누지 않으면 RLS가 어떻게 무력해지나?
- **로컬 재현 한계:** 누수 발생 빈도는 연결 수·풀 크기에 좌우된다. 메커니즘 재현은 충실하지만 운영의 노출 확률을 뜻하지 않는다.
