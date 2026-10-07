# nestjs-under-load 로드맵

> 기준: 하루 2~3시간, 주 5~6일(주당 약 12~18시간). 기간은 범위로만 적고, 각 단계 끝에 실제 소요를 기록해 다음 단계 추정을 고친다.
> **기간 주의:** 아래 합계는 낙관적 추정이다. 현실적으로 1.5~2배(60~90주)가 걸릴 수 있다. 0단계 실측으로 전체를 다시 추정한다.
> 시나리오 상세는 [SCENARIOS.md](./SCENARIOS.md), 구조는 [DESIGN.md](./DESIGN.md).

## 한눈에

| 단계 | 이름 | 포함 시나리오 | 대략 기간 | 선행 |
|---|---|---|---|---|
| 0 | 최소 경로 + 코드 실험실 | G02 (`no-lock`, `row-lock`, `conditional-update`, `app-memory-lock`) | 1~2주 | 없음 |
| 1 | 기반 | G01, G02 나머지 | 5~7주 | 0 |
| 2 | 쓰기·락 | T03(strategy 1~3·5·6) → **엔진 추출** → G03(`redis-atomic` 제외), G04, G05, G06, G07, G08, T01, T02 | 9~12주 | 1 |
| 3 | 과부하·확장 | G11, G12, G13, G14, G15, G16, G25, G26, T08 | 8~10주 | 2 (엔진), G06(재시도 중복 방지) |
| 4 | 읽기·비동기 | G09, G10, G17, G18, G19, G22, G23, T05, T06, T07 + G03 `redis-atomic`, T03 `background-job`·별도 워커 프로세스 | 10~13주 | 2, 3(G13 타임아웃·G15 워커 분리) |
| 5 | 운영·화면·도구 | G20, G21, G24, **T04(통합 캡스톤)** + 라이브 무대, 요청 워터폴, k6 편집, 실험 노트 화면, README GIF | 8~10주 | 4 |
| 6 | 확장 트랙(선택) | G27, G28, G29, G30 | 4~6주 | 4(G18·G23), 5(G24) |
| | **합계** | 0~5단계 | **41~54주** (현실적으로 60~90주 가능) | |
| | | 6단계 포함 | **45~60주** | |

**원칙(2026-10-07):** 코드는 전부 AI가 작성한다. 사용자는 코드 실험실 화면으로 "부하·상황별로 어떤 코드가 들어가야 하고 왜 그런지"를 학습한다. 각 시나리오에는 `learn.yaml`(예상 `expected`, 실측 후 `measured`)이 산출물로 붙는다. 실험 노트는 계속 사용자의 학습 기록(예측 → 실측 → 원인)이다.

각 시나리오에는 **실험 노트 1개 이상**(예측은 실행 전 커밋)이 완료 조건으로 붙는다. 노트 없는 시나리오는 완료가 아니다.

---

## 0단계 — 최소 경로 (1~2주)

**목표:** 관측 스택 없이 "같은 조건에서 strategy만 바꿔 3회 돌리고 DB로 정합성을 판정한다"는 핵심 루프를 가장 짧게 끝까지 통과시키고, 그 결과를 코드 실험실 화면에서 학습할 수 있게 한다. 실제 소요로 전체 일정을 다시 추정한다.

**포함 기능**
- compose(최소): app×2, nginx, postgres, k6 상주 컨테이너(+선택 prometheus/grafana). 모든 포트 127.0.0.1 바인딩. 이 구성이 `minimal` 프로필의 원형이다.
- 실행은 `scripts/run.mjs` 한 개(오케스트레이터 대신): RunConfig를 `runs/_active/run-config.json` 파일로 배포(0단계 단순화), 템플릿 DB 복제 → app restart(부팅 시 RunConfig 조회) → k6 웜업(별도 실행) → 본 실행 → `invariants.sql` → `summary.json` + 메타데이터 JSON → 3회 반복. 오케스트레이터는 1단계에서 이 스크립트를 승격한다.
- 원장 기반 불변식: 주문 원장 행(요청 ID, txid)으로 판정, k6 카운트는 보조 대조.
- 폴더 규약(manifest, strategies/, invariants.sql, k6/)을 여기서부터 고정.
- 확인: 비superuser `lab_app`에 `ALTER ROLE ... CONNECTION LIMIT` 적용 시점(새 연결부터)과 `pg_terminate_backend` 동작(DESIGN §14 #15), Docker Desktop cpuset·cAdvisor 수집 범위(#2·#3).

**AI 구현 범위**
- G02 4개 strategy(`apps/app` + 워크스페이스 패키지 `packs/generic/g02-stock-decrement`)를 AI가 구현하고 `// @learn` 마커를 단다.
- `packs/generic/g02-stock-decrement/learn.yaml`: concepts, situations(동시 2명·서버 1대 / 마감 직전 스파이크·서버 2대 / DB 지연 주입 등), outcomes(strategy×situation, `expected`), choose.
- 코드 실험실 화면(`web/`, DESIGN §10.4): 탐색기, 상황 선택 바, 마커 강조 에디터, 판정 패널, 매트릭스.
- 실측으로 `measured` 채우기: `run.mjs` 실행 결과(run id·수치)를 `learn.yaml`의 해당 outcome에 반영하고, 예상과 다른 셀을 표시한다.

**시나리오:** G02 `no-lock`·`row-lock`·`conditional-update`·`app-memory-lock`

**완료 기준**
- [ ] `node scripts/run.mjs` 한 번으로 4개 strategy × 3회가 돌고, 실행마다 메타데이터 JSON과 불변식 결과가 남는다.
- [ ] `no-lock`이 앱 2대에서 위반 1회 이상, `row-lock`·`conditional-update`는 3회 모두 위반 0, `app-memory-lock`은 앱 1대 통과·2대 위반.
- [ ] G02 4개 strategy 구현과 `learn.yaml`(4 strategy × 상황)이 있고, 코드 실험실 화면에서 상황을 바꾸며 마커 강조 코드와 판정을 볼 수 있다.
- [ ] 실측 후 `learn.yaml`의 `measured`가 채워지고, 화면이 "예상"과 "실측 run#"을 구분해 보인다.
- [ ] 2주차에 G02 실험 노트 1편을 사용자가 쓴다(예측 커밋 → 실측 → 원인). 노트는 사용자의 학습 기록이다.
- [ ] 실제 소요 주 수를 기록하고 1~6단계 기간을 다시 추정해 이 문서를 고친다.

**의존:** 없음.

---

## 1단계 — 기반 (5~7주)

**목표:** 0단계 루프에 측정 규율·관측·최소 화면을 붙인 실험실. 엔진 없이 시나리오 2개(G01, G02 전체)를 개별 구현한다(구현은 AI, 학습 데이터 `learn.yaml` 포함).

**포함 기능**
- compose: 0단계 구성 + redis, prometheus, grafana, tempo, loki, alloy, postgres_exporter, redis_exporter, nginx-prometheus-exporter, cadvisor, socket-proxy, orchestrator, web. 모든 포트 127.0.0.1 바인딩, lab-net·obs-net `internal: true`.
- 오케스트레이터 v0(`run.mjs` 승격): 템플릿 DB 생성·복제 리셋, `VACUUM ANALYZE`·`CHECKPOINT`·`pg_stat_statements_reset()`, app restart + RunConfig 배포, 웜업 분리(별도 실행), k6 실행, 3회 반복, 유효성 판정(k6 CPU, 목표 vs 실제 도착률, `dropped_iterations`와 `maxVUs`), 메타데이터 저장, 불변식 검사, Grafana 주석(서비스 계정 토큰).
- 계측: 앱 RED 히스토그램, ELD·ELU·GC·힙, ORM flush·쿼리, 풀 상태(`onPoolCreated`), OTel 추적. 계측 수준 스위치 3단계.
- 이벤트 프로토콜 v0(초안) + 이벤트 허브 + 텍스트 타임라인. v1 확정은 무대 단계(5단계) 전까지 미룬다.
- 화면: 2 실행 설정(폼 하드코딩 허용), 4 서버 속 패널(텍스트 타임라인 + 락 차단 트리 + 풀 게이지), 5 Grafana 임베드, 7 실행 기록, 8 비교(정합성 먼저), 11 코드 실험실(0단계 산출물을 승격·연결).
- Grafana 대시보드: 실행 개요, RED, USE-앱, USE-PG, 부하 발생기 유효성.
- `loadtest/lib`: Zipf/균등 분포, actor 태깅, traceparent, think time. open/closed 프로파일.
- `docs/overhead.md` 1차 측정(저경합·고경합 2기준).

**시나리오:** G01, G02 나머지(`redis-lock`, `advisory-xact-lock`). 엔진 없이 개별 구현, 폴더 규약(`learn.yaml` 포함)만 따름

**완료 기준 (측정 가능)**
- [x] `docker compose up` 후 화면 2에서 G02 `no-lock`·`row-lock`·`conditional-update`를 3회씩 실행 → 비교 화면에 불변식 결과가 처리량보다 위에 나온다.
- [x] G02 `no-lock`이 앱 2대·closed 모델에서 불변식 위반을 1회 이상 기록하고, `row-lock`·`conditional-update`는 3회 모두 위반 0.
- [x] G02 `app-memory-lock`이 앱 1대에서 통과·2대에서 위반하는 것을 한 비교 화면으로 보인다.
- [x] 같은 설정 3회 실행의 메타데이터에 §7.3 필드가 전부 채워지고, 조건이 다른 두 실행을 비교하면 "비교 불가" 경고가 뜬다.
- [x] k6 cpus를 일부러 낮춰 포화시킨 실행이 "무효"로 판정된다.
- [x] open model 실행에서 `dropped_iterations`가 실패 수에 합산되어 표시된다.
- [x] 계측 수준 `off`/`metrics`/`full`의 p50/p99·CPU 차이가 저경합·고경합 두 기준으로 `docs/overhead.md`에 기록된다.
- [ ] G01 실험 노트 1개, G02 실험 노트 1개 추가(0단계 노트와 별도, 락 strategy는 PG 락 프로브 on/off 대조 포함).

**1단계 완료 메모**
- 기준 1~6은 `node scripts/acceptance/phase1.mjs`(기준 5는 `--only c5`)로 오케스트레이터 API만 써서 실측했고, 증거는 `runs/_acceptance/`(로컬 전용)에 있다. 기준 7은 [overhead.md](./overhead.md)에 있다.
- 기준 8(실험 노트 G01·G02 각 1편)은 사용자의 학습 기록이라 **아직 비워 둔다.** 노트 재료는 `node scripts/acceptance/phase1.mjs --only probe,g01`(G02 PG 락 프로브 켜기/끄기 대조, G01 처리 방식 5개)로 만든다. 예측은 실행 전에 커밋한다.
- **실제 소요 기록:** ___주 (구현은 AI가 2026-10-07 하루에 병렬로 끝냈다. 학습·실험 노트에 든 시간은 사용자가 여기에 적는다.) 이 값으로 2~5단계 기간 추정을 다시 고친다.

**의존:** 0단계(`run.mjs`, 폴더 규약, 실측 기반 재추정).

---

## 2단계 — 쓰기·락 (10~13주)

**목표:** 세 번째 시나리오를 개별 구현한 직후 엔진을 추출하고, 쓰기·락·정합성 시나리오를 채운다.

**순서**
1. **T03 엑셀 임포트**를 엔진 없이 개별 구현(2~3주). 세 번째 개별 구현 시나리오. 이 단계에서는 strategy 1~3·5·6과 파싱 위치 비교 중 메인 스레드 vs worker_threads만 만든다. `background-job`(SSE 진행률)과 별도 워커 프로세스는 워커 컨테이너가 생기는 4단계에서 붙인다.
2. **엔진 추출(1~2주)** — 시나리오 G01·G02·T03의 공통부를 `engine/core`로 뽑는다: strategy 레지스트리·주입, manifest 스키마·검증, 이벤트 방출기, 불변식 러너, 경합 창 지연 주입 훅, 팩 로더. G01·G02·T03을 엔진 위로 옮겨 기존 결과가 재현되는지 확인.
3. 이후 시나리오는 엔진 위에서: G03(`redis-atomic` 제외), G04, G05, G06, G07, G08, T01, T02.

**포함 기능**
- manifest 기반 화면 2 폼 자동 생성, 화면 1 시나리오 목록.
- k6 템플릿 렌더링(편집 없이 보기만), 스크립트 해시 기록.
- 데이터 분포 설정(균등/Zipf), 경합 창 지연 주입 + "주입됨" 표시.
- 기본 계단(step) 도착률 프로파일(G03용). 무릎 표시 차트는 3단계.
- 엔진 공통 재조정 검사기(합계 보존, 행 수 대조).
- 단일 작업형 실행(G07·G08·T03): 진행률 이벤트, 작업 중 kill 예약.

**완료 기준**
- [ ] 엔진 추출 후 G01·G02·T03의 strategy별 불변식 결과(통과/위반 여부)가 추출 전과 같다.
- [ ] 새 시나리오 추가가 "폴더 1개 + manifest" 외에 엔진 코드 수정 없이 된다(G03 이후 시나리오에서 엔진 변경 diff 0을 목표로, 변경이 생기면 사유 기록).
- [ ] T03: 임포트 중 SIGKILL을 서로 다른 3개 시점에 걸고 재개 → 3회 모두 중복 0·누락 0 자동 판정 통과.
- [ ] T03: 메인 스레드 파싱 vs worker_threads에서 배경 API p99와 ELD p99 차이를 비교 화면에 표시.
- [ ] G04: `random-order`에서 `pg_stat_database.deadlocks` 증가, `sorted-order`에서 증가 0.
- [ ] G05: `ttl-overrun`에서 원장 기준 임계 구역 겹침 > 0, `fencing-token`에서 낮은 토큰 덮어쓰기 0.
- [ ] G06: 같은 키 동시 버스트에서 `idempotency-key` 중복 생성 0, `check-then-insert` 중복 > 0.
- [ ] G07: 7개 strategy 모두 행 수·체크섬 불변식 통과(실패 strategy는 실패 사유 표시), WAL 바이트·힙 최대 비교 표.
- [ ] T01: `approve-by-status-only`에서 승인 버전 ≠ 검토 버전 위반 재현, `approve-with-version`에서 0.
- [ ] T02: `repeatable-read`에서 위반 재현, `serializable-retry`·`parent-row-lock`에서 위반 0.
- [ ] 시나리오별 실험 노트 1개 이상.

**의존:** 1단계 오케스트레이터·계측. G05·G06은 Redis 필요.

---

## 3단계 — 과부하·확장 (8~10주)

**목표:** 장애 주입과 과부하 차단, 용량 곡선.

**포함 기능**
- toxiproxy(app↔PG/Redis/fake-external), `fake-external` 스텁, PgBouncer 프로필 + `pgbouncer_exporter`.
- 화면 6 망가뜨리기: kill/SIGTERM, Redis stop, 풀 축소·`lab_app` 연결 상한 축소, toxiproxy toxic, 예약 실행, 중단 조건.
- 엔진 공통: 타임아웃 계층, 재시도 래퍼(백오프·지터·예산), 서킷 브레이커, admission control.
- SLO: 엔드포인트별 SLI, 번레이트 규칙 1~2개 → 카오스 중단 조건 연결. SLO 대시보드.
- 계단 부하 무릎 표시 차트(프로파일은 2단계), Little's law 계산 패널.
- 컨테이너 대시보드(cAdvisor 수집 가능 범위 확인 후).

**시나리오:** G11, G12, G13, G14, G15, G16, G25, G26, T08

**완료 기준**
- [ ] G13: toxiproxy 지연 toxic을 걸었다 제거한 실행에서 strategy별 **회복 시간**이 자동 계산되어 비교된다.
- [ ] G13: `naive-retry` 대비 `backoff-jitter-budget`의 의존성 요청 증폭 비율이 표시된다.
- [ ] G11: `external-in-tx`에서 `idle in transaction`/풀 waiting 증가, `external-out-of-tx`에서 감소가 같은 도착률에서 비교된다. Little's law 예측값과 in-flight 실측값이 한 화면에.
- [ ] G12: 4개 함정 각각 "깨짐 재현 → 고친 코드 통과"가 불변식 또는 체크로 판정된다.
- [ ] G13: `cancel-propagation`에서 클라이언트 취소 후 서버가 계속 쓴 DB 시간이 `timeouts` 대비 줄어든다.
- [ ] G14: 앱 3대 `in-memory` 실효 한도 초과가 불변식 위반으로 잡힌다.
- [ ] T08: pgbouncer transaction 모드에서 `session-set` 교차 노출 > 0, `set-local`·`owner-bypass` 수정본에서 0.
- [ ] G16: 계단 부하 실행에서 무릎 지점과 그 시점의 포화 자원(USE)이 리포트에 기록되고, 병목 1개 해소 후 재실행 비교가 있다.
- [ ] G25: CFS 스로틀링 지표와 p99를 같은 패널에 표시(수집 불가 시 대체 지표와 한계를 문서화).
- [ ] 망가뜨리기 중 SLO 번레이트 초과 시 자동 중단이 1회 이상 실제로 동작.
- [ ] 시나리오별 실험 노트 1개 이상.

**의존:** 2단계 엔진, G06(재시도 중복 방지 결합).

---

## 4단계 — 읽기·비동기 (9~12주)

**목표:** 읽기 경로(인덱스·캐시·복제본)와 비동기 경로(큐·아웃박스·실시간).

**포함 기능**
- postgres-replica 프로필, 복제 지연 패널.
- 워커 컨테이너(큐·릴레이·컨슈머, T03 백그라운드 임포트, G03 비동기 반영), 큐/워커 대시보드.
- Redis Streams, pub/sub, SSE 구독기(`sse-subscriber`, 별도 Node 컨테이너).
- 대량 이력 시드 + 템플릿 DB 재사용(수백만 행 시드 시간 절약).
- EXPLAIN (ANALYZE, BUFFERS) 수집·렌더 패널.

**시나리오:** G09, G10, G17, G18, G19, G22, G23, T05, T06, T07 + 2단계에서 미룬 G03 `redis-atomic`, T03 `background-job`·별도 워커 프로세스

**완료 기준**
- [ ] G10: 처리 중 워커 SIGKILL 후 모든 작업 완료·부작용 중복 0 판정.
- [ ] G18: 커밋-발행 사이 kill에서 `dual-write-*`는 유실 또는 유령 > 0, `outbox`+`idempotent-consumer`는 유실 0·중복 효과 0.
- [ ] G17: 일괄 만료 시 `cache-aside`의 DB 쿼리 스파이크와 `single-flight`의 스파이크가 같은 차트에 겹쳐 표시. 무효화 순서 strategy별 stale 읽기 수.
- [ ] G23: 지연 주입 하에서 `replica-reads` 위반 > 0, `lsn-wait` 위반 0.
- [ ] T05: 이력 10만/100만/수백만 행에서 현재 값 조회 p99 곡선(처리량 쌍) + 버전 연속성 불변식 통과.
- [ ] T06: EXPLAIN에서 pruning 확인(스캔 파티션 수), DROP vs DELETE 정리 비교.
- [ ] T07: 앱 1대에서 `in-memory-emitter` 통과·2대에서 누락 > 0, `redis-streams-replay`는 인스턴스 kill 후 재연결 포함 누락 0.
- [ ] G03: `redis-atomic`에서 반영 워커 kill 후 drain하면 DB 재고 = Redis 재고. Redis 재시작 유실은 AOF 설정별로 기록.
- [ ] T03: `background-job` 진행률이 SSE 구독기로 수신되고, 별도 워커 프로세스 kill 후 재개에서 중복 0·누락 0.
- [ ] 시나리오별 실험 노트 1개 이상.

**의존:** 2단계(엔진), 3단계(G13 타임아웃, G15 워커 분리 패턴). G03 `redis-atomic`은 G18 아웃박스·릴레이 이후.

---

## 5단계 — 운영·화면·도구 (7~9주)

**목표:** 운영형 시나리오와 남은 화면을 완성하고, 남이 받아 돌릴 수 있는 상태로 만든다.

**포함 기능**
- **화면 3 라이브 무대**(PixiJS): 장면 타입 8종 중 최소 `queue-at-counter`, `shared-document`, `conveyor`, `gate-and-pool`, `worker-pool`, `broadcast`, `generic-timeline` 구현, 나머지는 `generic-timeline`으로 대체. 대표 actor만 렌더, 재생 버퍼.
- **요청 워터폴**: 이벤트 + Tempo span 합성, 무대에서 actor 클릭 → 워터폴.
- **화면 10 k6 스크립트 편집**: Monaco, diff, 편집됨 해시, `k6 inspect` 사전 검증.
- **화면 9 실험 노트**: 템플릿 폼, 실행 결과 자동 첨부, `docs/experiments/`에 마크다운 저장.
- README: 빠른 시작, 정직한 표기 문구, "누가 짰나" 표, 무대 GIF, 보안 경고.
- 그레이스풀 셧다운·롤링 재시작 오케스트레이션(SIGTERM → `server.close()` → nginx `proxy_next_upstream error`).
- 이벤트 프로토콜 v1 확정(무대 구현 전에).

**시나리오:** G20, G21, G24, T04(통합 캡스톤: G06 멱등 + G10 큐 + G13 admission + 스파이크 프로파일 + 사무소별 상한)

**완료 기준**
- [ ] G24: 앱 3대 순차 재시작을 일정 도착률 부하 중 실행 → `drain` strategy(SIGTERM → `server.close()`로 새 연결 거부 → nginx `proxy_next_upstream error` 재전송 → in-flight drain → 풀 종료) 3회 모두 실패 0, SSE(T07 `redis-streams-replay`) 누락 0. 이미 전달된 POST가 끊긴 경우는 재전송되지 않음(`non_idempotent` 예외)을 실험 노트에 기록.
- [ ] T04: 스파이크 중 최종 제출 중복 0·접수번호 누락 0, `per-office-limit`에서 작은 사무소의 goodput이 전역 `admission-control` 대비 유지된다.
- [ ] G20: 장기 트랜잭션 뒤 ALTER에서 차단 트리 길이·대기 SELECT 수가 서버 속 패널에 보이고, `lock-timeout-retry`에서 요청 실패가 허용치 이내.
- [ ] G21: 장기 트랜잭션 유무에 따른 `n_dead_tup`·테이블 크기 차이가 soak 실행 리포트에 기록.
- [ ] 무대: 쌓인 이벤트 NDJSON(v1, 또는 v0 기록을 v1로 변환한 것)을 **재생 모드**로 틀어 같은 장면이 나온다(실시간이 아닌 기록 재생도 지원).
- [ ] 무대에서 actor 클릭 → 그 요청의 워터폴(이벤트+span)이 열린다.
- [ ] k6 편집본으로 실행한 결과가 비교 화면에서 "스크립트 다름"으로 표시된다.
- [ ] 새 사용자가 README만 보고 clone → `docker compose up` → G02 실행까지 막힘 없이 된다(다른 머신 또는 깨끗한 환경에서 1회 검증).
- [ ] 시나리오별 실험 노트 1개 이상.

**의존:** 4단계까지의 이벤트·실행 데이터(무대 재생 검증용). T04는 G06·G10·G13·G14가 모두 끝난 뒤.

---

## 6단계 — 확장 트랙 (선택, 4~6주)

**시나리오:** G27(Redis Streams 집계), G28(PG 페일오버), G29(k3d + HPA, `infra/k3d` 별도 경로), G30(샤딩 설계 글)

**완료 기준**
- [ ] G27: 컨슈머 kill 후 `stream-reclaim`으로 최종 집계 = 재계산 값.
- [ ] G28: primary–replica 사이 toxiproxy로 지연 창을 만든 비동기 복제에서 확인 쓰기 유실 수가 측정·표시되고, 동기 복제에서 0.
- [ ] G29: 스파이크 시작 → 레플리카 증가 → ready 각 시각이 타임라인으로 표시(시간 값 주장 없이 순서만).
- [ ] G30: 설계 글 1편(`docs/experiments/` 또는 `docs/essays/`), "단일 머신 재현 아님" 문구 포함.

**의존:** G18, G23, G24.

---

## 엔진 추출 시점 (명시)

- **폴더 규약(manifest, strategies/, invariants.sql, k6/, stage/)은 0단계 첫 시나리오부터 고정**한다.
- **엔진 코드 추출은 2단계 초, 시나리오 3개(G01, G02, T03)를 개별 구현한 직후**에 한다. 성격이 다른 셋(동시 수정 / 경합 차감 / 단일 대량 작업)을 겪은 뒤라야 공통부가 맞게 잡힌다.
- 추출 후 첫 두 시나리오(G03, G04)에서 엔진 변경이 생기면 한 번 더 다듬고, 그 이후로는 엔진 변경에 사유를 남긴다.

## 위험과 대응

| 위험 | 대응 |
|---|---|
| 화면·인프라에 시간을 다 써서 핵심 코드가 늦어짐 | 단계마다 "시나리오 + 실험 노트"를 완료 조건으로 고정. 화면은 단계별 최소분만 |
| macOS Docker Desktop 지표 한계(cAdvisor, cpuset) | 0단계에서 확인 필요 #2·#3 실험, 안 되면 대체 수집·한계 문서화 |
| 머신 사양 부족 | `minimal` 프로필(DESIGN §4.1), 메타데이터 `profile: minimal`, 다른 프로필과 비교 금지 |
| 범위가 커서 중간에 멈춤 | 6단계는 선택. 1~5단계 중에도 단계 끝마다 실제 소요를 기록하고 다음 단계 범위 재조정 |
| 기간 추정 오차 | 0단계 실측으로 전체 재추정(현실적으로 1.5~2배 가능), 이후 각 단계 종료 시 실제 주 수 기록 → 남은 단계 추정 보정 |
