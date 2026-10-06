# nestjs-under-load 설계서 (가칭)

> 상태: 설계 초안 v0.1 (2026-10-06) · 관련 문서: [SCENARIOS.md](./SCENARIOS.md) · [ROADMAP.md](./ROADMAP.md) · [EXPERIMENT_TEMPLATE.md](./EXPERIMENT_TEMPLATE.md)
>
> 이 문서에서 "확인 필요"로 표시한 항목은 구현 전에 공식 문서나 소규모 실험으로 확정한다. 전체 목록과 해소 결과는 문서 끝 §14(2026-10-06 갱신: 대부분 해소, #2·#3은 실험 필요).

---

## 1. 비전

동시 요청이 몰릴 때 서버와 DB 안에서 실제로 무슨 일이 일어나는지 눈으로 볼 수 있게 만드는 **공개 실험실**이다. 내려받아 `docker compose up` 한 번으로 띄우고, 같은 API에 처리 방식만 바꿔 가며 같은 조건에서 돌려 보고, 무엇이 망가지고 왜 고쳐지는지 직접 확인할 수 있어야 한다. 코드는 전부 AI가 작성하고, 사용자는 "코드 실험실" 화면에서 부하·상황별로 어떤 코드가 들어가야 하고 왜 그런지를 학습한다.

- 대상: 백엔드 개발자. 작성자의 학습 기록을 겸한다. 락·격리 수준·커넥션 풀·ORM 내부 동작·과부하·캐시·비동기 처리를 "말로 아는" 상태에서 "돌려 보고 설명할 수 있는" 상태로 옮긴다.
- 형태: 범용 실행 엔진 + 시나리오 팩. 팩은 폴더 하나 단위로 계속 추가할 수 있다. 첫 팩은 **범용 팩(generic)** 과 **세무 팩(tax)**.
- 학습 루프: 코드 실험실에서 상황별 처리 코드와 판정 이유를 읽고(학습 데이터 `learn.yaml`, §6.5), 실험마다 **예측 → 실행 → 원인 설명**을 사용자가 직접 기록한다. 결과는 실험 노트(가설/조건/결과/원인/언제 쓰고 쓰지 말지)로 남기고, 일부러 망가뜨려 본다.

## 2. 비목표

| 비목표 | 이유 |
|---|---|
| 운영 용량 주장 | 로컬 단일 머신의 절대 수치는 다른 환경에 옮겨지지 않는다. 처리 방식 간 **상대 비교**만 말한다. |
| 원격 배포·멀티 테넌트 | 로컬 전용이다. 사용자가 편집한 스크립트를 실행하는 구조라서 외부에 노출하면 원격 코드 실행 통로가 된다(§13). |
| 샤딩 재현 | 단일 머신에서 샤딩 효과를 재현했다고 주장하지 않는다. 샤딩은 설계 글로만 다룬다(SCENARIOS G30). |
| k6 Studio 대체 | 녹화, HAR 변환, 시각적 테스트 빌더, 상관관계 규칙은 만들지 않는다(§10.2). |
| 범용 APM 제품 | 시계열은 Grafana에 맡긴다. 서버 속 패널은 Grafana가 못 하는 것만 그린다(§9.4). |
| 오토스케일링·페일오버의 실운영 재현 | 확장 트랙에서 "순서와 반응"만 보인다(G28·G29). |

## 3. 설계 원칙

1. **정합성이 1급 지표다.** 모든 실행은 처리량보다 불변식 검사 결과를 먼저 보여 준다(재고 음수, lost update, 중복, 이력 연속성 등). 불변식이 깨진 실행의 처리량은 "빠르지만 틀림"으로 표시하고 순위에서 뺀다.
   - **불변식은 DB에 남은 사실로만 판정한다.** 임계 구역 진입·이탈과 성공 처리는 시나리오 테이블의 원장 행(요청 ID, fence, txid)으로 남기고, k6 카운트는 보조 대조로만 쓴다(클라이언트는 타임아웃났는데 서버는 커밋한 경우 k6 기준이면 거짓 위반이 나온다). 원장 쓰기 비용은 모든 strategy에 동일하게 붙인다. 샘플링되거나 버려질 수 있는 이벤트 텔레메트리(§9.1)로 판정하지 않는다.
2. **측정 규율.** 웜업 제외, 실행마다 DB 초기화, 시드 고정, 3회 반복 범위 표시, 리소스 limit 고정, 부하 발생기 포화 시 무효 판정, 실행 메타데이터 자동 저장. 지연은 항상 **어떤 처리량에서**와 짝지어 표시하고, 퍼센타일은 표본 수와 함께, 성공·실패 지연은 따로 낸다(§8).
3. **관측자 효과 통제.** 계측 수준 스위치(`off` / `metrics` / `full`)를 두고, 비교는 같은 수준끼리만 허용한다. 수준별 오버헤드는 1회 측정해 문서에 공개한다. 인위적 지연 주입 같은 개입은 화면과 리포트에 "주입됨"으로 표시한다.
4. **실험 대상과 실험 도구를 분리한다.** 이벤트 전송, 실행 제어, 메타데이터 저장은 실험 대상 Redis/PG를 거치지 않는다. Redis를 끄는 실험에서 관측까지 같이 꺼지면 안 된다.
5. **코드는 전부 AI가 작성하고, 사람은 학습·판단한다.** 처리 코드(strategy)·불변식 SQL·인프라·화면·생성기 모두 AI가 쓴다. 사람의 몫은 코드 실험실에서 "이 부하·상황에는 왜 이 코드가 들어가는가"를 학습하고, 실험 노트에 예측·원인을 직접 쓰는 것이다. 학습 데이터의 예상(`expected`)과 실측(`measured`)은 구분해 표시한다. 경계는 §5.4에 표로 고정하고 README에 공개한다.
6. **같은 API, 다른 처리 방식.** 나쁜 버전과 고친 버전은 엔드포인트가 같고, 실행 설정으로 주입된 strategy만 다르다. 그래야 k6 스크립트와 불변식을 그대로 재사용해 같은 조건에서 비교할 수 있다.
7. **가장 가벼운 경로.** 엔진은 시나리오 2~3개를 엔진 없이 개별 구현한 뒤 공통부를 추출한다. 폴더 규약만 처음부터 고정한다.

### 3.1 정직한 표기 문구 예시

README, 리포트 하단, 화면 푸터에 아래 문구를 그대로 쓴다. 숫자를 인용할 때도 이 맥락을 붙인다.

- 기본 문구: "이 결과는 **로컬 단일 머신**(Docker Desktop VM, CPU·메모리 limit 고정)에서 **처리 방식 간 상대 비교**를 위해 측정한 값입니다. 운영 환경의 처리 용량을 뜻하지 않습니다."
- 비교 문구: "같은 머신·같은 limit·같은 계측 수준에서 strategy A가 B보다 p99가 낮았다(3회 범위 표시)."
- 금지 문구 예: "초당 N건을 처리하는 시스템", "100만 건을 X초에 넣을 수 있다", "대규모 트래픽 대응 완료".
- 주입·개입 표시: "경합 창에 인위 지연 50ms 주입됨" 같은 문구를 해당 실행 결과 옆에 붙인다.

---

## 4. 아키텍처

### 4.1 서비스 구성 (docker compose)

모든 서비스는 하나의 `infra/compose/docker-compose.yml`(+ 프로필별 override)에 있다. 리소스 limit은 **기본값(조정 가능)** 이며 실제 값은 실행 메타데이터에 기록된다. 수치는 초기 설정값일 뿐 성능 주장이 아니다.

| 서비스 | 역할 | 기본 limit (초기값) | 비고 |
|---|---|---|---|
| `app` ×N | NestJS + MikroORM 실험 대상. 부팅 시 오케스트레이터에서 RunConfig(팩·시나리오·strategy·파라미터)를 받아온다(§5.3) | cpus 1.0, mem 512m, `--max-old-space-size`는 limit보다 작게 | `docker compose up --scale app=3`으로 최대 수를 미리 만들고 활성 수는 오케스트레이터가 stop/start로 조절, 기본 활성 2 (1대에선 메모리 락도 맞는 것처럼 보이므로). DB 접속은 비superuser 역할 `lab_app` |
| `nginx` | app 앞단 로드밸런서(round-robin 기본, least_conn 선택) | cpus 0.5, mem 128m | nginx 1.27.3+ 오픈소스: upstream `zone` + `server app:3000 resolve;` + `resolver 127.0.0.11 valid=2s;`로 app 인스턴스를 주기 재해석(§14 #1). `proxy_next_upstream error`(§12) |
| `postgres` | 주 DB. 설정 파일 고정 마운트(`infra/postgres/postgresql.conf`), named volume | cpus 2.0, mem 2g | `shared_preload_libraries = pg_stat_statements`, `track_io_timing = on`, `log_lock_waits = on` |
| `postgres-replica` | 스트리밍 복제본(프로필 `replica`) | cpus 1.0, mem 1g | 지연 실험은 `recovery_min_apply_delay` 또는 toxiproxy |
| `pgbouncer` | 커넥션 풀러(프로필 `pgbouncer`), session/transaction 모드 전환 | cpus 0.5, mem 128m | app의 DB 경로를 `direct` / `pgbouncer`로 선택 |
| `redis` | 분산 락, 멱등 저장, 캐시, 레이트 리밋, pub/sub, Streams | cpus 1.0, mem 512m | `maxmemory-policy`는 시나리오별 설정(락 용도는 `noeviction`) |
| `toxiproxy` | app↔postgres/redis 사이 지연·끊김·대역폭 장애 주입 | cpus 0.5, mem 128m | API 포트는 내부망 전용. 경유 여부(RunConfig `proxy: on/off`)는 메타데이터에 기록, 비교는 같은 값끼리 |
| `fake-external` | 느린 외부 API 흉내 스텁(G11·G13). toxiproxy 뒤에 둠 | cpus 0.25, mem 64m | 추가 서비스(요청 목록 밖이지만 G11 재현에 필요) |
| `k6` | 부하 발생기. **상주 컨테이너**: 작은 실행기가 오케스트레이터에서 스크립트·env를 받아 `k6 run`을 자식 프로세스로 실행하고 결과를 공유 볼륨에 쓴다(컨테이너 생성 불필요, §13) | cpus 2.0, **app·DB와 겹치지 않는 cpuset** | lab-net + obs-net에만 연결(둘 다 `internal: true`, egress 없음). `-o experimental-prometheus-rw`, summary JSON, HTML 리포트 export |
| `prometheus` | 지표 저장. scrape 1~5초, remote-write 수신, exemplar 저장 | cpus 1.0, mem 1g | `--web.enable-remote-write-receiver`, `--enable-feature=exemplar-storage,native-histograms` |
| `grafana` | 시계열 대시보드, 웹 UI에 임베드 | cpus 0.5, mem 512m | `allow_embedding = true`, 익명 Viewer(읽기 전용), 프로비저닝된 대시보드. 익명 Viewer는 annotations를 쓸 수 없으므로 주석은 오케스트레이터가 서비스 계정 토큰으로 쓴다 |
| `tempo` | 분산 추적 저장(OTLP 수신) | cpus 0.5, mem 512m | 샘플링 비율은 app 쪽 sampler로 제어 |
| `loki` | 로그 저장 | cpus 0.5, mem 512m | Loki 3: trace_id는 라벨이 아닌 structured metadata로(카디널리티) |
| `alloy` | 로그 수집기(docker 로그 → Loki) | cpus 0.25, mem 256m | Promtail은 2026-03-02 EOL → Grafana Alloy `discovery.docker` + `loki.source.docker`. docker.sock 읽기 마운트 필요(§13) |
| `postgres_exporter` | PG 지표 | cpus 0.25, mem 128m | `pg_monitor` 권한의 전용 역할로 접속 |
| `redis_exporter` | Redis 지표, 락 키 개수 | cpus 0.25, mem 128m | `--count-keys`(예: `db0=lock:*`), `--check-keys`, `--check-streams`. TTL은 DB 평균만 → 키별 TTL은 프로브 |
| `pgbouncer_exporter` | PgBouncer `SHOW POOLS`/`SHOW STATS` 지표(프로필 `pgbouncer`) | cpus 0.25, mem 64m | 별도 서비스 |
| `nginx-prometheus-exporter` | nginx `stub_status` 지표 | cpus 0.25, mem 64m | 별도 서비스 |
| `cadvisor` | 컨테이너 CPU/메모리/CFS 스로틀링/OOM | cpus 0.5, mem 256m | rootfs·docker.sock 읽기 마운트 필요(§13). macOS Docker Desktop에서 수집 가능한 지표 범위는 실험 필요(§14 #3) |
| `orchestrator` | 실행 제어 평면: 초기화·웜업·실행·수집·불변식·메타데이터·리포트, 이벤트 허브, PG 관측 프로브, RunConfig 배포 | cpus 1.0, mem 512m | Docker Engine API는 `socket-proxy` 경유, 컨테이너 restart/stop/start/kill만(§13). 0단계 `run.mjs`를 승격한 것 |
| `socket-proxy` | Docker 소켓 프록시. 허용 API: 컨테이너 조회·restart·stop·start·kill | cpus 0.1, mem 32m | docker.sock 마운트. 컨테이너 생성·exec·이미지 API는 막는다 |
| `web` | 화면 11개(React + Vite 정적 빌드, nginx로 서빙) | cpus 0.25, mem 128m | 오케스트레이터 WebSocket/REST만 호출 |
| `sse-subscriber` | SSE 구독기(별도 Node 프로세스, 4단계 T07·G24) | cpus 0.5, mem 128m | xk6-sse는 커스텀 k6 빌드가 필요해 쓰지 않는다(§14 #23) |

**cpuset 배치 원칙:** k6, (app+nginx), (postgres+pgbouncer), (관측 스택)을 서로 다른 CPU 집합에 고정해 부하 발생기와 실험 대상이 CPU를 다투지 않게 한다. Docker Desktop VM의 vCPU 수가 부족하면 cpuset 대신 `cpus`만 쓰고 메타데이터에 `cpuset: none`을 남긴다. Docker Desktop의 cpuset은 VM vCPU를 고정할 뿐 물리 코어 고정이 아니다. Apple Silicon은 P/E 코어 성능 차이가 결과 편차로 섞일 수 있어 메타데이터에 남기고, Linux 네이티브 Docker에서는 cpuset이 실제 호스트 코어를 뜻하므로 의미가 다르다. 실제 격리 효과는 실험 필요(§14 #2).

**최소 사양:** 권장 Docker 8 vCPU / 10GB 이상. 부족하면 `minimal` 프로필(app×2, nginx, postgres, k6, prometheus, grafana)로 띄우고 메타데이터에 `profile: minimal`을 남긴다. 다른 프로필의 결과와는 비교하지 않는다.

### 4.2 네트워크 그림

```
                     호스트 (127.0.0.1 바인딩만)
   ┌──────────────┬───────────────┬─────────────────┐
   │ :8080 web    │ :4000 orch API│ :3001 grafana   │  (:8081 nginx → 수동 호출용, 선택)
   └──────┬───────┴───────┬───────┴────────┬────────┘
          │               │                │
 ═════════╪═══ ctl-net (internal 아님: 호스트 포트 공개 서비스만) ═══╪══════
          │               │                │
        [web] ──ws/rest──▶[orchestrator]───┼──▶[socket-proxy]──docker.sock (restart/stop/start/kill만)
                           │   ▲  event-hub (HTTP batch 수신), RunConfig 배포, k6 실행기 제어
                           │   │
 ══════════════════════════╪═══╪═══ lab-net (실험 대상, internal: true) ══
                           │   │
   [k6 상주]   ──HTTP──▶ [nginx] ──▶ [app-1] [app-2] ... [app-N]
        │                              │  │        │
        │                              │  └──(proxy=on)──────▶[toxiproxy]
        │                              │                         │    │
        │                              ▼                         ▼    ▼
        │                     ┌─[pgbouncer]?──▶[postgres]──WAL──▶[postgres-replica]
        │                     │                                  
        │                     └──────────────▶[redis]
        │
 ═══════╪════════════════ obs-net (관측, internal: true) ════════════════
        │
        └─remote-write─▶[prometheus]◀─scrape─ app /metrics, nginx stub_status,
                             ▲                 postgres_exporter, redis_exporter,
                             │                 cadvisor, orchestrator /metrics
                        [grafana]──▶[tempo]◀─OTLP─ app
                             └────▶[loki]◀──[alloy]◀── docker 로그 (docker.sock 읽기)
```

- app·nginx·postgres·redis·toxiproxy는 `lab-net`, 관측 스택은 `obs-net`. **`lab-net`과 `obs-net`은 둘 다 `internal: true`** 라서 외부 egress가 없다. k6는 이 두 망에만 붙는다(부하는 lab-net, remote-write는 obs-net).
- `internal: true` 망에서는 호스트 포트를 공개할 수 없으므로, 호스트 포트가 필요한 서비스(web, orchestrator API, grafana, nginx)만 internal이 아닌 `ctl-net`에 추가로 연결한다. 그 밖에 여러 망에 걸쳐야 하는 서비스(app, exporter, orchestrator)만 다중 연결한다.
- 오케스트레이터의 PG 관측 프로브는 **풀 밖의 전용 커넥션 1개**(`lab_observer` 역할)를 쓴다. 이 커넥션과 exporter(postgres_exporter 등)의 연결은 `max_connections` 예산에 포함되므로 메타데이터에 `observerConnections`로 기록한다(`reserved_connections`는 PG16+의 실제 GUC 이름이라 피한다).

### 4.3 컴포넌트 책임 요약

```
engine/        : 실험 대상 앱 런타임(호스트 앱) + 공통 라이브러리
                 - 팩 로더, strategy 레지스트리, 이벤트 방출기, 계측(지표·추적·SQL 샘플)
                 - 경합 창 지연 주입 훅, 그레이스풀 셧다운, 관리 엔드포인트(/_lab/*)
orchestrator/  : 실행 수명주기, DB 템플릿 관리, k6 실행, 불변식 검사, 메타데이터, 리포트,
                 이벤트 허브(수신→링버퍼→WS 팬아웃→NDJSON 저장), PG 락 프로브, Grafana 주석
packs/         : 시나리오 본체(엔티티, 마이그레이션, 시드, 컨트롤러, strategies, 불변식 SQL,
                 k6 템플릿, 무대 장면 설정, 학습 체크리스트)
web/           : 화면 11개(코드 실험실 포함), 무대 렌더러, k6 편집기
```

---

## 5. 리포 구조

### 5.1 모노레포 폴더 트리

pnpm workspace. 백엔드 컨벤션(레이어 책임, zod typed config, legacy ORM 데코레이터, exception factory, 마이그레이션 관리)은 [nestjs-architecture](https://github.com/sinbox0701/nestjs-architecture)의 컨벤션을 따른다.

```
nestjs-under-load/
├─ package.json / pnpm-workspace.yaml / .nvmrc (Node 24)
├─ README.md                      # 정직한 표기 문구, "누가 짰나" 표, 빠른 시작
├─ scripts/run.mjs                # 0단계 최소 실행기(오케스트레이터의 원형). RunConfig는 runs/_active/run-config.json 파일로 배포
├─ apps/app/                      # 0단계 실험 대상 NestJS 앱(engine/host의 원형). 팩은 워크스페이스 패키지(@under-load/<id>)로 import
├─ engine/
│  ├─ host/                       # NestJS 호스트 앱 (실험 대상 app 이미지)
│  │  ├─ src/main.ts              # reflect-metadata → tracing → bootstrap (CJS require 순서 유지)
│  │  ├─ src/bootstrap.ts         # enableShutdownHooks, 팩 로딩
│  │  ├─ src/config/              # zod 스키마: 정적 env(오케스트레이터 주소 등) + RunConfig
│  │  └─ Dockerfile               # exec form ENTRYPOINT + init(tini 또는 --init)
│  ├─ core/                       # 공통 라이브러리 (팩이 import)
│  │  ├─ strategy/                # ScenarioStrategy 인터페이스, 레지스트리, 주입 토큰
│  │  ├─ events/                  # LabEvent 스키마, 방출기, 샘플러, 배치 전송기
│  │  ├─ instrumentation/         # prom-client 지표, OTel 추적, ORM 쿼리 훅, 풀 계측, ELD/GC
│  │  ├─ invariants/              # 불변식 정의 타입, 공통 검사기(재조정)
│  │  ├─ chaos-hooks/             # 경합 창 지연 주입, 인위 장애 훅
│  │  └─ lab-admin/               # /_lab/health, /_lab/ready, /_lab/drain
│  └─ manifest-schema/            # manifest JSON Schema + 검증기
├─ orchestrator/                  # NestJS 앱 (제어 평면)
│  ├─ src/runs/                   # 실행 수명주기 상태기계
│  ├─ src/db-template/            # 템플릿 DB 생성·복제·리셋
│  ├─ src/k6/                     # 템플릿 렌더링, 컨테이너 실행, 결과 수집
│  ├─ src/event-hub/              # 이벤트 수신·팬아웃·저장
│  ├─ src/pg-probe/               # pg_stat_activity·pg_locks·차단 트리 폴링
│  ├─ src/chaos/                  # 망가뜨리기 (docker kill/stop, toxiproxy API, PG 설정 변경)
│  ├─ src/reports/                # 비교·리포트 생성
│  └─ src/metadata/               # 실행 메타데이터 저장 (SQLite 또는 파일, §7.4)
├─ packs/
│  ├─ generic/
│  │  ├─ pack.yaml                # 팩 메타(이름, 설명, 시나리오 목록, 공통 엔티티)
│  │  ├─ g01-concurrent-edit/     # 시나리오 폴더 (§6), 폴더마다 learn.yaml 포함
│  │  ├─ g02-stock-decrement/     # 0단계 구현됨(워크스페이스 패키지)
│  │  └─ ...
│  └─ tax/
│     ├─ pack.yaml
│     ├─ t01-return-concurrent-edit/
│     └─ ...
├─ web/                           # React + Vite + TS, PixiJS, Monaco
│  ├─ src/screens/                # 화면 11개(코드 실험실 포함)
│  ├─ src/stage/                  # 무대 렌더러, 장면 타입별 구현
│  └─ src/api/                    # 오케스트레이터 클라이언트
├─ loadtest/
│  ├─ lib/                        # k6 공용 헬퍼: 분포(균등/Zipf), traceparent 생성, actor 태깅, think time
│  ├─ profiles/                   # 부하 모양 프리셋: constant, ramp, spike, stress, soak, step(계단)
│  └─ README.md                   # open/closed 모델, coordinated omission 설명
├─ infra/
│  ├─ compose/                    # docker-compose.yml + override (replica, pgbouncer, extension)
│  ├─ postgres/                   # postgresql.conf, pg_hba.conf, 초기화 SQL(역할·확장)
│  ├─ pgbouncer/ nginx/ redis/ toxiproxy/
│  ├─ prometheus/                 # prometheus.yml, 규칙(SLO 번레이트)
│  ├─ grafana/                    # provisioning, dashboards/*.json
│  ├─ tempo/ loki/ alloy/
│  └─ k3d/                        # 확장 트랙(G29) 전용, 기본 실행 경로 아님
└─ docs/
   ├─ DESIGN.md / SCENARIOS.md / ROADMAP.md / EXPERIMENT_TEMPLATE.md
   ├─ overhead.md                 # 계측 수준별 오버헤드 측정 결과
   └─ experiments/                # 실험 노트: <YYYY-MM-DD>-<scenario>-<slug>.md
```

### 5.2 백엔드 컨벤션 차용 (nestjs-architecture 기준)

- NestJS 11 + SWC, MikroORM v7 + `@mikro-orm/decorators/legacy`, zod typed config, pnpm, Jest(unit/integration/e2e), exception factory 패턴.
- 쓰기는 MikroORM Unit of Work가 기본. **단, nestjs-under-load은 "ORM 우회가 왜 빠르고 무엇을 포기하는가"를 실험하는 곳이라** 네이티브 SQL·COPY·`nativeUpdate` 쓰기를 strategy로 허용한다. 우회 strategy는 manifest에 `bypassesOrm: true`로 표시하고 화면에 배지로 보인다.
- 추적은 OTel(trace 전용, `main.ts`의 CJS require 순서 유지), 지표는 prom-client로 분리한다(nestjs-architecture도 OTel을 trace 전용으로 쓴다).
- 로거는 pino(G26 로그 볼륨 실험에서 동기/비동기 전환이 필요하므로).

### 5.3 실행 형태

- 실험 대상 `app` 이미지는 `engine/host` + 모든 팩을 포함해 한 번 빌드한다(0단계는 `apps/app` + 워크스페이스 패키지 팩). 어느 시나리오·strategy를 켤지는 RunConfig로 정한다.
- **0단계 단순화:** 오케스트레이터가 없으므로 RunConfig는 `runs/_active/run-config.json` 파일을 `scripts/run.mjs`가 쓰고 app이 부팅 시 읽는다. 이유: 0단계에는 `GET /internal/run-config`를 서빙할 서비스가 없고, 파일 한 개가 가장 가벼우며 1단계에서 엔드포인트로 승격해도 RunConfig 스키마는 그대로다.
- **app 컨테이너는 재생성하지 않고 restart만 한다.** 오케스트레이터가 RunConfig를 확정한 뒤 app을 restart하면, app은 부팅 시 오케스트레이터의 `GET /internal/run-config`(lab-net 전용)에서 RunConfig를 받아온다. 정적 env는 오케스트레이터 주소와 인스턴스 이름 정도뿐이다. 그래서 오케스트레이터에 컨테이너 생성 권한이 필요 없다(§13).
- 실행 중 strategy 핫 스위칭은 하지 않는다(섞인 상태로 측정되는 것을 막고, 프로세스 상태도 매번 같게 시작).
- CPU·메모리 limit 변경(G25 등)은 컨테이너 재생성이 필요하므로 오케스트레이터가 하지 않는다. 사용자가 호스트에서 compose 값을 바꿔 `docker compose up -d`로 직접 재생성하고, 실제 limit은 메타데이터에 자동 기록된다.

### 5.4 "누가 짰나" 경계

| 영역 | 작성 | 비고 |
|---|---|---|
| 코드 전부 (`packs/**/strategies`, `invariants.sql`, 엔티티·마이그레이션·시드, `engine/**`, `orchestrator/**`, `infra/**`, `web/**`, k6 템플릿, 스크립트) | **AI** | 사람은 코드 실험실로 읽고 학습한다 |
| `packs/**/learn.yaml`의 `expected`·`why`·`choose` | **AI** | 실측 전 예상은 `expected`로 표시 |
| `learn.yaml`의 `measured` | **오케스트레이터(실측 후 채움)** | 실행 id·수치. 사람도 AI도 임의로 쓰지 않는다 |
| `docs/experiments/**` | **사용자** | 학습 기록: 예측 → 실측 → 원인. 예측은 실행 전에 커밋 |

커밋 규칙: AI가 작성한 커밋은 `Co-Authored-By` 트레일러를 단다. `docs/experiments/**`는 사용자가 쓰는 영역이라 트레일러가 붙은 커밋이 있으면 CI가 경고한다(스크립트는 AI가 작성).

---

## 6. 시나리오 팩 규약

### 6.1 시나리오 폴더 하나에 들어가는 것

```
packs/<pack>/<scenario-id>/
├─ manifest.yaml            # 아래 스키마
├─ README.md                # 문제 설명, 예측 질문, 학습 체크리스트(사람이 읽는 버전)
├─ entities/                # MikroORM 엔티티 (legacy 데코레이터)
├─ migrations/              # 이 시나리오 테이블 마이그레이션
├─ seed/                    # 결정적 시드 생성기 (seed 값 → 같은 데이터)
├─ api/                     # 컨트롤러 + DTO (strategy에 위임만 한다)
├─ strategies/              # 처리 방식별 구현 1파일 1strategy
│  ├─ naive-overwrite.strategy.ts
│  ├─ optimistic-version.strategy.ts
│  └─ edit-lease.strategy.ts
├─ invariants.sql           # 불변식 검사 쿼리 (위반 행 수를 반환)
├─ learn.yaml               # 코드 실험실 학습 데이터 (§6.5)
├─ k6/
│  ├─ template.js.eta       # 실행 설정으로 채우는 k6 템플릿
│  └─ params.schema.json    # 템플릿 파라미터 스키마 (화면 2 폼 자동 생성)
├─ stage/
│  └─ scene.yaml            # 무대 장면 타입과 매핑 규칙
└─ module.ts                # Nest 동적 모듈: 엔티티 등록 + strategy provider 팩토리
```

### 6.2 manifest 스키마 예시

```yaml
id: g02-stock-decrement
pack: generic
title: 재고·좌석 차감 경합
summary: 같은 상품 재고를 여러 요청이 동시에 차감할 때 음수/초과 판매가 생기는 조건과 고치는 방법
tags: [lock, contention, redis]
minAppInstances: 2              # 1대면 메모리 락도 맞게 보이므로 최소 2

data:
  entities: [Product, Stock, OrderLine]
  seed:
    generator: seed/index.ts
    defaults: { products: 1000, stockPerProduct: 100 }
    distribution: { kind: zipf, s: 1.1 }   # uniform | zipf (화면 2에서 변경)

api:
  - { method: POST, path: /g02/orders, body: OrderCreateDto, idempotent: false }
  - { method: GET,  path: /g02/products/:id/stock }

strategies:
  - id: no-lock
    label: 락 없음 (읽고-계산하고-쓰기)
    kind: broken                # broken | fixed | tradeoff
    bypassesOrm: false
    params: {}
  - id: app-memory-lock
    label: 인스턴스 메모리 mutex (1대 통과, 2대 위반 시연)
    kind: broken
    params: {}
  - id: row-lock
    label: 행 잠금 SELECT ... FOR UPDATE
    kind: fixed
    params:
      lockTimeoutMs: { type: integer, default: 1000 }
  - id: conditional-update
    label: 조건부 UPDATE (stock >= qty)
    kind: fixed
    bypassesOrm: true           # nativeUpdate 사용
  - id: redis-lock
    label: Redis 락 (SET NX PX + 소유자 확인 해제)
    kind: tradeoff
    requires: [redis]
    params:
      ttlMs: { type: integer, default: 3000 }
  - id: advisory-xact-lock
    label: pg_advisory_xact_lock(상품 ID) — 트랜잭션 종료 시 자동 해제
    kind: fixed
    bypassesOrm: true

invariants:
  - id: no-negative-stock
    severity: critical
    sql: invariants.sql#no_negative_stock      # 위반 행 수 반환, 0이어야 통과
  - id: sold-equals-decrement
    severity: critical
    sql: invariants.sql#sold_equals_decrement  # 초기재고 - 현재재고 = 주문수량 합(DB 주문 원장 기준)
  - id: ledger-matches-k6
    severity: info
    sql: invariants.sql#ledger_vs_client       # 보조 대조: 원장 성공 행 수 vs k6 성공 수(차이는 클라 타임아웃 후 서버 커밋)

load:
  model: closed                 # open | closed  (이유를 README에 명시)
  executor: constant-vus        # k6 executor 이름 그대로
  defaults: { vus: 50, duration: 60s, thinkTimeMs: [50, 200] }
  warmup: { duration: 15s }
  allowedProfiles: [constant, ramp, spike]

chaosHooks:
  - contention-window-delay     # strategy 안 lab.contentionWindow('after-read') 지점
  - redis-stop
  - pg-lock-timeout-change

stage:
  sceneType: queue-at-counter   # §10.3 장면 타입
  entityLabel: 상품
  representativeActors: 8

k6:
  template: k6/template.js.eta
  paramsSchema: k6/params.schema.json

checklist:
  - 락 없음에서 불변식 위반이 몇 회 반복 중 몇 회 나왔고, 왜 매번 다른가
  - 행 잠금에서 대기 시간이 어디(pg_locks / wait_event)에서 보이는가
  - 조건부 UPDATE가 행 잠금보다 짧게 잠그는 이유
  - Redis 락이 DB 정합성을 보장하지 못하는 경우(G05로 연결)
  - READ COMMITTED에서 FOR UPDATE·UPDATE가 잠금 대기 후 최신 행 버전으로 WHERE를 다시 검사하는 동작(EvalPlanQual)이 conditional-update를 왜 맞게 만드는가
```

### 6.3 strategy 교체 방법 (같은 API, 설정으로 주입)

- 인터페이스(개념): `ScenarioStrategy<Command, Result>` 하나에 `execute(cmd, ctx)`. `ctx`에는 `em`(요청별 fork), 이벤트 방출기, 경합 창 훅, strategy 파라미터가 들어간다.
- 컨트롤러는 `SCENARIO_STRATEGY` 토큰만 주입받고 `strategy.execute()`를 호출한다. 어떤 구현인지 모른다.
- `module.ts`의 provider 팩토리가 부팅 시 받아온 RunConfig의 `scenario`, `strategy`, `strategyParams`를 읽어 구현을 고르고, 파라미터는 manifest의 `params` 스키마로 부팅 시 검증한다(zod로 변환). 검증 실패 시 부팅 실패.
- 교체 = 오케스트레이터가 RunConfig를 바꾸고 app을 restart(§5.3). 엔드포인트·DTO·k6 스크립트·불변식은 그대로다.
- 경합 창 지연 주입: strategy 코드의 이름 붙은 지점(`lab.contentionWindow('after-read')`)에서 RunConfig `injectDelay: after-read:50` 같은 설정이 있을 때만 대기한다. 주입 여부는 이벤트(`injected_delay`)와 메타데이터에 남고 화면에 "주입됨"으로 표시한다.

### 6.4 팩 로딩

- `engine/host`는 부팅 시 RunConfig `scenario`의 `module.ts`만 동적 import한다. 다른 시나리오의 엔티티는 등록하지 않는다(메타데이터 탐색 비용, Identity Map 오염 방지).
- 마이그레이션은 시나리오별 폴더를 MikroORM `migrations.path`로 지정해 템플릿 DB 생성 시 오케스트레이터가 실행한다. MikroORM은 `migrations.transactional: true`가 기본이라 트랜잭션 블록 안에서 못 도는 문장(`CREATE INDEX CONCURRENTLY` 등, G20)은 해당 마이그레이션만 `transactional: false`로 두거나 오케스트레이터가 raw SQL로 실행한다.

### 6.5 학습 데이터 규약 (`learn.yaml`)

코드 실험실(§10.4)이 읽는 시나리오별 학습 데이터다. 전체 예시는 `packs/**/learn.yaml`.

- `concepts[]`: 이 시나리오에서 배우는 개념(`id`, `label`, `body` 3~5문장). 용어 툴팁과 공유한다.
- `situations[]`: 부하·환경 조합(`id`, `label`, `load{model,vus|rate,shape}`, `instances`, `chaos`, `note`). 예: 동시 2명·서버 1대 / 마감 직전 200 req/s·서버 2대 / DB 지연 50ms 주입.
  - 선택 `injected: { contentionWindowMs }`: 모든 strategy의 같은 경합 창 지점(`after-read`, 읽기 후 쓰기 전. 읽기가 없는 strategy는 첫 쓰기 문장 전)에 넣는 인위 지연(ms). 실행은 RunConfig `injectDelay: [{ point: after-read, ms }]`로 하고, 판정·실측 화면에 "주입됨"으로 표시한다(실측에는 `measured.injected`).
- `outcomes[]`: strategy × situation 판정. `verdict`(`ok|broken|slow|rejects|n/a`), `expected`(예상), `measured`(실측, 없으면 `null`), `why`, `focus[]`(`{file, marker}`), `sql[]`, 선택 `concepts: [id]`(해당 판정과 관련된 개념만 카드로 표시, 없으면 시나리오 전체 개념).
- `choose[]`: "이 상황이면 이 코드" 결정 가이드(`when`, `pick`, `because`, `avoid[]`).
- **코드 마커:** 소스에 `// @learn <marker-id> — <한 줄 설명>` 주석. 화면은 마커로 줄을 찾아 강조하고 줄 번호는 데이터에 쓰지 않는다. 계측용 `// @event <phase>`와 별개이며 한 줄에 둘 다 가능하다.
- **expected vs measured:** 화면은 "예상" 배지와 "실측 run#" 배지를 구분해 보인다. 실행 결과가 생기면 오케스트레이터가 해당 outcome의 `measured`에 run id와 수치를 채운다. 예상과 실측이 어긋나면 그 자체가 학습 대상이다.

---

## 7. 실행 오케스트레이터

오케스트레이터는 0단계의 `scripts/run.mjs`(템플릿 DB 복제 → app restart → 웜업 → 본 실행 → 불변식 → 메타데이터, 3회)를 그대로 승격한 것이다. 흐름은 같고 API·화면·관측이 붙는다.

### 7.1 흐름

```
[설정 확정] → [초기화] → [웜업] → [본 실행] → [수집] → [불변식 검사] → [메타데이터 저장] → [리포트]
      │            │          │          │          │            │                │
      │            │          │          │          │            └─ 실패해도 저장(무효/위반 표시)
      └─ 3회 반복이면 초기화~메타데이터를 반복, 리포트는 3회 묶음으로 1장
```

1. **설정 확정**: 화면 2 입력 → `RunConfig` 생성 → k6 스크립트 렌더링 → 스크립트 해시 계산(편집됨 여부 판정).
2. **초기화**
   - RunConfig 게시 → 활성 app 인스턴스 restart(인스턴스 수는 stop/start로 조절) → app이 RunConfig를 받아 부팅 → readiness 확인.
   - DB: 템플릿 DB(`tpl_<scenario>_<seedHash>`)가 없으면 마이그레이션 + 시드 후 생성. 실행 DB는 `DROP DATABASE IF EXISTS lab_run WITH (FORCE)` → `CREATE DATABASE lab_run TEMPLATE tpl_...`. 템플릿에는 접속이 없어야 한다. 기본 `STRATEGY WAL_LOG`는 큰 템플릿에서 WAL이 폭증하고 복제본으로도 전송되므로, 큰 템플릿(T05, G19)은 `STRATEGY FILE_COPY`(앞뒤 체크포인트 강제)를 쓴다.
   - `VACUUM ANALYZE` → `CHECKPOINT` → `SELECT pg_stat_statements_reset()` → `SELECT pg_stat_reset()`(현재 DB 카운터) → 공유 통계 `pg_stat_reset_shared(...)`. PG17 대상: `archiver`, `bgwriter`, `checkpointer`, `io`, `recovery_prefetch`, `slru`, `wal`.
   - Redis: `FLUSHALL`(시나리오가 Redis를 쓸 때), 설정(`maxmemory-policy`) 적용.
   - 선택: `coldStart: true`면 PG 재시작으로 shared_buffers를 비운다. VM의 OS 페이지 캐시는 통제 불가 → 메타데이터에 `osCacheControlled: false`.
   - toxiproxy 독성 초기화, 계측 수준 적용.
3. **웜업**: 본 실행과 같은 부하 모양의 짧은 구간을 **별도 k6 실행**으로 돌리고 결과를 버린다. k6 summary JSON과 HTML 리포트는 한 실행 안의 모든 구간을 합쳐 집계하므로, 웜업을 같은 실행에 넣으면 그 값에 웜업이 섞인다. 같은 실행에 넣어야 하는 경우에는 `thresholds`에 `http_req_duration{phase:main}`을 선언해 서브메트릭을 강제로 만들고, 리포트는 그 서브메트릭과 Prometheus 값만 쓴다(summary/HTML 전체값은 웜업 포함이라고 표시). 경계는 Grafana 주석으로도 남긴다.
4. **본 실행**: k6 상주 컨테이너의 실행기에 스크립트를 넘겨 실행. 오케스트레이터는 phase 경계마다 Grafana 주석(`/api/annotations`)을 쓰고, 망가뜨리기 예약이 있으면 정해진 시각에 실행한다.
5. **수집**: k6 summary JSON, HTML 리포트, Prometheus 범위 질의 스냅샷(주요 지표를 JSON으로 동결), 이벤트 NDJSON, pg_stat_statements 상위 N, pg_stat_database/pg_stat_user_tables 차분.
6. **불변식 검사**: 시나리오 `invariants.sql` + 엔진 공통 검사(재조정: 원장 합계, 이력 연속성 등 시나리오가 선언한 공통 규칙). 판정 근거는 DB에 남은 행뿐이다(§3 원칙 1). k6 카운트는 보조 대조로 함께 표시하고, 차이가 있으면 "클라이언트 타임아웃 후 서버 커밋" 가능성을 표시한다. 결과는 1급 지표.
7. **메타데이터 저장**(§7.3), **리포트 생성**(3회 묶음, §7.5).

### 7.2 3회 반복과 유효성 판정

- 기본 3회 반복. 리포트는 중앙값과 최솟값~최댓값 범위를 같이 보여 주고, 3회 개별 값도 숨기지 않는다. 범위가 설정 임계(기본값은 측정해 보고 정함)보다 넓으면 "불안정" 배지.
- **무효 판정 (결과에서 제외, 사유 표시)**
  - k6 컨테이너 CPU 사용률이 limit 대비 임계 이상(cAdvisor `container_cpu_usage_seconds_total`로 계산). 부하 발생기가 포화되면 측정한 것은 SUT가 아니라 k6다.
  - open model에서 실제 도착률이 목표 도착률에 못 미침 + k6 CPU 포화 동반.
  - 실행 중 관측 스택 컨테이너 재시작, 스크레이프 누락 구간 존재.
- **실패로 집계 (유효한 결과)**
  - open model의 `dropped_iterations` > 0: k6가 VU를 못 구해 요청을 못 보낸 것. **`maxVUs` ≥ λ(목표 도착률) × 요청 타임아웃일 때만** SUT가 제때 응답하지 못한 결과로 보고 실패 요청 수에 더해 goodput 계산에 반영한다. 그보다 작으면 원인이 `maxVUs` 부족일 수 있으므로 "설정 부족"으로 무효 처리한다. `maxVUs`는 메타데이터에 남긴다.
  - HTTP 4xx/5xx, k6 check 실패, 타임아웃.
- 지연 표기: `p50/p95/p99 (n=표본 수) @ 실제 처리량 X req/s`, 성공·실패 분리.

### 7.3 실행 메타데이터 스키마

```jsonc
{
  "runId": "2026-10-06T10-12-03Z_g02_row-lock_r2",
  "batchId": "b_7f3a",            // 3회 묶음
  "repetition": 2,
  "scenario": "g02-stock-decrement",
  "strategy": { "id": "row-lock", "params": { "lockTimeoutMs": 1000 } },
  "git": { "sha": "abc1234", "dirty": false },
  "images": { "app": "nestjs-under-load/app@sha256:...", "postgres": "postgres:17.x", "k6": "grafana/k6:x.y" },
  "profile": "default",            // default | minimal
  "host": { "dockerNcpu": 8, "dockerMemBytes": 0, "os": "darwin", "cpu": "apple-silicon(P/E)", "dockerDesktopVersion": "..." },
  "limits": { "app": { "cpus": 1.0, "mem": "512m", "cpuset": "2-3" }, "k6": { "cpus": 2.0, "cpuset": "0-1" } },
  "topology": { "appInstances": 2, "lb": "round-robin", "dbPath": "direct", "proxy": "off", "replica": false },
  "pool": { "min": 2, "max": 10, "acquireTimeoutMs": 2000 },
  "postgres": { "configHash": "sha256:...", "maxConnections": 100, "sharedBuffers": "512MB", "observerConnections": 3, "appRoleConnectionLimit": null },
  "timeouts": { "k6RequestMs": 10000, "serverRequestMs": 5000, "poolAcquireMs": 2000, "statementMs": 3000, "lockMs": 1000, "idleInTxMs": 10000 },
  "redis": { "maxmemoryPolicy": "noeviction" },
  "data": { "seed": 42, "seedHash": "...", "rows": { "products": 1000 }, "distribution": "zipf(1.1)" },
  "load": { "model": "closed", "executor": "constant-vus", "profile": "constant", "vus": 50, "maxVUs": null, "duration": "60s", "warmup": "15s(별도 실행)", "thinkTimeMs": [50, 200] },
  "k6Script": { "hash": "sha256:...", "edited": false },
  "instrumentation": "metrics",
  "pgProbe": { "enabled": true, "intervalMs": 1000 },
  "interventions": [ { "type": "inject-delay", "point": "after-read", "ms": 50 } ],
  "chaos": [ { "at": "30s", "action": "redis-stop" } ],
  "coldStart": false, "osCacheControlled": false,
  "validity": { "valid": true, "k6CpuMaxRatio": 0.41, "reasons": [] },
  "invariants": [ { "id": "no-negative-stock", "violations": 0 } ],
  "artifacts": { "k6Summary": "runs/<runId>/summary.json", "k6Html": "runs/<runId>/report.html", "events": "runs/<runId>/events.ndjson", "promSnapshot": "runs/<runId>/prom.json" },
  "startedAt": "...", "endedAt": "..."
}
```

- 저장소: 오케스트레이터 전용 SQLite 파일 + `runs/<runId>/` 아티팩트 폴더(named volume, 호스트 마운트 선택). 실험 대상 PG에 저장하지 않는다(원칙 4).
- 비교 가능 조건: `scenario`, `profile`, `limits`, `topology`, `pool`, `postgres.configHash`, `redis`, `images`, `timeouts`, `data.seedHash`, `load`, `instrumentation`, `pgProbe`, `proxy`, `interventions`, `chaos`, `coldStart`, `k6Script.hash`가 같아야 한다. 다르면 비교 화면이 차이 항목을 빨간색으로 띄우고 "비교 불가(조건 다름)"로 표시한다. `git.sha`가 다르면 비교는 허용하되 "코드 버전 다름" 경고를 띄운다. strategy만 다른 것이 정상 비교다.

### 7.4 오케스트레이터 API (요약)

| 메서드 | 경로 | 용도 |
|---|---|---|
| GET | `/scenarios` | 팩·시나리오·manifest 목록 |
| GET | `/internal/run-config` | app 부팅 시 RunConfig 조회(lab-net 내부 전용) |
| POST | `/runs` | RunConfig로 배치 실행 시작(반복 횟수 포함) |
| GET | `/runs/:id` | 상태·메타데이터·결과 |
| POST | `/runs/:id/chaos` | 실행 중 망가뜨리기 즉시 실행 |
| POST | `/runs/:id/abort` | 중단(중단 조건 충족 시 자동 호출도) |
| POST | `/k6/render` | 설정 → 스크립트 미리보기 |
| GET | `/compare?runs=a,b` | 비교 데이터 |
| WS | `/ws/runs/:id` | 이벤트·PG 프로브·진행 상태 스트림 |
| POST | `/ingest/events` | app → 이벤트 배치 수신(lab-net 내부 전용) |

### 7.5 리포트

- 맨 위: 정합성 결과(통과/위반 수) → 유효성 판정 → 처리량·지연(성공/실패 분리, 표본 수, 처리량 쌍) → 포화 지표(풀 대기, 락 대기, CPU 스로틀링) → 3회 범위.
- k6 HTML 리포트는 `K6_WEB_DASHBOARD=true` + `K6_WEB_DASHBOARD_EXPORT=<path>`(공유 볼륨 경로)로 생성해 링크한다. HTML·summary는 그 k6 실행 전체를 집계하므로 웜업은 별도 실행으로 뺀다(§7.1).
- 하단에 §3.1 정직한 표기 문구 자동 삽입.

---

## 8. 부하 모델 규율

| 구분 | 쓰는 곳 | k6 executor | 핵심 |
|---|---|---|---|
| **open model** | 지연·포화·용량·과부하·타임아웃 실험 | `constant-arrival-rate`, `ramping-arrival-rate` | 도착률 고정. `preAllocatedVUs`/`maxVUs` 지정. `dropped_iterations`는 실패로 집계 |
| **closed model** | 경합·정합성 시나리오 | `constant-vus`, `ramping-vus`, `per-vu-iterations` | 동시 인원 고정 + think time. 같은 행을 다투는 "사람 수"가 독립 변수 |

- **coordinated omission:** closed model에서는 서버가 느려지면 다음 요청도 늦게 나가서, 느린 구간의 요청 수가 줄고 지연 분포가 실제보다 좋게 보인다. 지연·포화를 말하는 실험은 반드시 open model로 돌리고, closed model 결과에는 "경합 관찰용, 지연 수치는 해석 주의" 배지를 붙인다. `loadtest/README.md`에 그림과 함께 설명한다.
- 부하 모양 프리셋: 일정(constant), 램프(ramp), 스파이크(spike), 스트레스(stress: 계단 상승), 소크(soak: 장시간), 계단(step: 용량 산정용). open/closed 양쪽 버전을 둔다.
- 데이터 분포: 대상 ID 선택을 균등/Zipf로 설정. Zipf 생성기는 k6 내장 기능이 아니므로 `loadtest/lib`에 결정적 시드로 구현한다.
- actor 태깅: 모든 요청에 `X-Lab-Actor: <vu>-<iter>` 헤더. 대표 actor는 `traceparent`의 sampled 플래그를 켜서 보낸다(§9.3).
- Prometheus 출력: k6 `experimental-prometheus-rw`. `K6_PROMETHEUS_RW_TREND_STATS` 기본값은 `p(99)`뿐이라, 네이티브 히스토그램(`K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true` + Prometheus `--enable-feature=native-histograms`)을 쓴다.
- 실행 전 `k6 inspect --execution-requirements`로 필요한 VU 수와 실행 시간을 확인하고 `maxVUs`를 메타데이터에 남긴다.

---

## 9. 관측

### 9.1 이벤트 프로토콜 (처리 단계 이벤트)

**목적:** 요청 하나가 어떤 단계를 거쳤는지(도착→락 대기→락 획득→충돌→재시도→저장→실패)를 무대·타임라인·서버 속 패널에 보낸다. 지표(집계)와 달리 **개별 사건**이다. 샘플링되고 버퍼가 차면 버려지므로 **불변식 판정에는 쓰지 않는다**(§3 원칙 1).

> 버전: 1단계는 v0(초안)으로 시작하고, 무대 단계(5단계) 전까지 실제 시나리오를 겪으며 고친 뒤 v1로 확정한다. 아래 예시는 확정 목표 형태다.

```jsonc
{
  "v": 1,
  "runId": "...",
  "ts": 1759745523123456,          // epoch 마이크로초 (app 인스턴스 시계, 정렬은 인스턴스 내 seq 보조)
  "seq": 10233,                    // 인스턴스별 단조 증가
  "instance": "app-2",
  "reqId": "r_8f2c",               // 요청 단위
  "traceId": "4bf92f...",          // 있으면 Tempo와 연결
  "actor": "17-3",                 // X-Lab-Actor
  "entity": { "type": "Stock", "id": "123" },
  "phase": "lock_wait",
  "durMs": null,                   // 구간 종료 이벤트일 때 소요 시간
  "attrs": { "lockMode": "FOR UPDATE", "attempt": 1 },
  "sampled": true,                 // 대표 표본 여부
  "injected": false                // 인위 지연 등 개입이 걸린 이벤트
}
```

- **phase 목록(공통):** `arrived`, `rejected`(429/503 즉시 거절), `lock_wait`, `lock_acquired`, `lock_released`, `lock_timeout`, `conflict`(버전 불일치·유니크 위반·40001), `retry`, `db_read`, `db_write`, `committed`, `rolled_back`, `failed`, `responded`, `enqueued`, `dequeued`, `lease_expired`, `published`, `consumed`, `cache_hit`, `cache_miss`, `injected_delay`, `sql`(샘플 SQL). 시나리오는 `custom:<name>`으로 확장 가능(무대 매핑에 선언 필요).
- **전송:** app은 메모리 버퍼에 모아 100ms 또는 N건마다 `POST /ingest/events`(lab-net)로 배치 전송한다. 버퍼가 차면 **버리고 버린 개수를 카운터로 남긴다**(앱을 막지 않는다). 실험 대상 Redis를 쓰지 않는다.
- **샘플링:**
  - 대표 actor(기본 8명, 설정 가능): 모든 phase를 전송. 무대·워터폴용.
  - 나머지: phase별 카운트만 1초 단위로 집계해 전송(무대의 "대기열 길이" 같은 군중 표현용).
  - `sql` 이벤트: 대표 actor 요청만, 파라미터 값은 마스킹하고 형태만.
- **계측 수준 스위치(RunConfig `instrumentation`):**

| 수준 | 지표(prom-client) | OTel 추적 | 이벤트 | SQL 샘플 | PG 락 프로브 |
|---|---|---|---|---|---|
| `off` | 최소(RED만) | 끔 | 끔 | 끔 | 끔 |
| `metrics` | 전체 | 끔 | 집계 카운트만 | 끔 | 저빈도 |
| `full` | 전체 | 비율 샘플 + 대표 actor | 대표 전체 + 집계 | 대표 요청 | 고빈도 |

- 오버헤드 측정: 기준 시나리오(G02 row-lock, open model 고정 도착률)로 수준별 p50/p99·CPU를 **저경합(상품 다수, 균등)과 고경합(상품 1개) 두 기준**으로 측정해 `docs/overhead.md`에 공개한다. 비교는 같은 수준끼리만.
- **PG 락 프로브의 관측자 효과:** `pg_locks` 조회 자체가 lock manager의 락을 잡는다(PG17 문서). 고빈도 프로브는 측정 대상인 락 경합을 건드릴 수 있으므로, 락 시나리오의 실험 노트에는 프로브 on/off 대조 실행을 포함한다. 프로브 설정은 메타데이터 `pgProbe`에 남는다.

### 9.2 지표 목록 (RED/USE)

**부하 발생기 (k6 → Prometheus remote write, cAdvisor)**

| 지표 | 출처 |
|---|---|
| VU 수, 목표 vs 실제 도착률, `iterations`, `dropped_iterations` | k6 |
| `http_req_duration`(성공/실패 태그 분리), `http_req_failed`, `checks` | k6 |
| k6 컨테이너 CPU 사용률/limit, 메모리 | cAdvisor |

**앱 RED + 런타임 (prom-client, 앱 `/metrics`)**

| 지표 | 수집 방법 |
|---|---|
| 요청 수·에러 수·지연 히스토그램 (route, method, status, strategy 라벨) | Nest 인터셉터에서 기록. 히스토그램 exemplar에 traceId(prom-client `enableExemplars` + OpenMetrics content type으로 노출해야 exemplar가 나간다) |
| in-flight 요청 게이지 | 인터셉터 진입/종료 |
| 이벤트 루프 지연 p50/p99 | `perf_hooks.monitorEventLoopDelay` |
| 이벤트 루프 사용률(ELU) | `performance.eventLoopUtilization()` |
| GC pause 히스토그램(종류별) | `PerformanceObserver`(`gc` 엔트리), 또는 prom-client 기본 지표 |
| 힙 사용/총량, RSS, 외부 메모리 | prom-client `collectDefaultMetrics` |
| libuv 스레드풀 크기(설정값) | `UV_THREADPOOL_SIZE` env를 정보 지표로 |
| 즉시 거절 수(429/503), 동시성 상한 대기 큐 길이 | 과부하 차단 미들웨어 |
| 재시도 횟수, 재시도 예산 소진, 서킷 브레이커 상태 | 공통 재시도/브레이커 래퍼 |
| 이벤트 버퍼 드롭 수 | 이벤트 방출기 |

**ORM (MikroORM)**

| 지표 | 수집 방법 |
|---|---|
| 쿼리 수·지연(유형별: select/insert/update/delete) | `loggerFactory`로 커스텀 로거 + `debug: ['query']`, `LogContext.took`에서 소요 시간. 디버그 로깅 경로라 오버헤드가 있으므로 `full` 수준에서만 켠다. `onQuery`는 SQL 변환용 훅이라 계측에 쓰지 않는다. 대안: `pg` 자동 계측 span 집계 |
| flush 횟수·flush 시간, flush당 변경 엔티티 수 | `EventSubscriber`의 `beforeFlush`/`afterFlush`, `onFlush`에서 changeset 수 |
| Identity Map 크기(요청 종료 시점) | `em.getUnitOfWork().getIdentityMap().keys().length`. `@internal` API라 MikroORM 버전을 고정한다 |
| 트랜잭션 시작/커밋/롤백, 트랜잭션 지속 시간 | `afterTransactionStart`/`afterTransactionCommit`/`afterTransactionRollback` 훅 |

**커넥션 풀**

| 지표 | 수집 방법 |
|---|---|
| total / idle / active / waiting | `pg` Pool의 `totalCount`/`idleCount`/`waitingCount`. Pool 인스턴스는 `driverOptions: { onPoolCreated: (pool) => … }`로 받는다 |
| acquire 대기 시간 히스토그램, acquire 타임아웃 수 | `pool.connect` 래핑, 또는 Kysely `onReserveConnection` 훅 |
| PgBouncer `SHOW POOLS`/`SHOW STATS` (cl_active, cl_waiting, sv_active, avg_wait_time 등) | pgbouncer 관리 콘솔 → `pgbouncer_exporter`(별도 서비스) |

**PostgreSQL (postgres_exporter + 오케스트레이터 PG 프로브)**

| 지표 | 출처 뷰/함수 |
|---|---|
| 상태별 연결 수, `idle in transaction` 수, 최장 트랜잭션 시간 | `pg_stat_activity` |
| wait_event_type / wait_event별 대기 세션 수 | `pg_stat_activity` (postgres_exporter 기본 수집기에 없음 → custom query 또는 프로브) |
| 락 대기 수, 모드별 락 수, **차단 트리** | `pg_locks` + `pg_blocking_pids(pid)` (프로브, 차단 트리는 서버 속 패널 전용. 프로브 빈도의 관측자 효과는 §9.1) |
| 커밋/롤백, 교착 수, temp 파일 수·바이트, 캐시 히트율(`blks_hit`/`blks_read`) | `pg_stat_database` |
| 테이블별 `n_dead_tup`, `n_tup_hot_upd`, `n_tup_upd`, seq/idx scan, autovacuum 시각 | `pg_stat_user_tables` |
| 인덱스 사용 | `pg_stat_user_indexes` |
| WAL 바이트 | `pg_stat_wal` (PG14+) |
| 쿼리별 호출 수·총/평균 시간·rows·shared_blks | `pg_stat_statements` |
| 체크포인트·버퍼 쓰기 | `pg_stat_checkpointer`(PG17) / `pg_stat_bgwriter`, `pg_stat_io`(PG16+) |
| 복제 지연(replay_lag, LSN 차이) | `pg_stat_replication`, `pg_last_wal_replay_lsn()` |

postgres_exporter 기본 수집기: `stat_activity`, `stat_database`, `stat_user_tables`, `locks`, `wal`은 켜져 있고, `stat_statements`, `long_running_transactions`, `stat_checkpointer`, `stat_activity_autovacuum`, `process_idle`은 꺼져 있다. 필요한 것만 플래그로 켠다.

**Redis (redis_exporter)**: 명령 수·지연(`INFO commandstats`), 메모리 사용·`maxmemory`·evicted_keys, 연결 수, 락 키 패턴 개수(`--count-keys`), 특정 키(`--check-keys`), Streams 길이·pending 수(`--check-streams`), keyspace hit/miss. TTL은 DB 평균만 나오므로 키별 TTL 분포는 프로브.

**큐/워커**: 대기 작업 수, 처리 중 수, 리스 만료 회수 수, 중복 처리 감지 수, 작업 지연(enqueue→done) 히스토그램.

**컨테이너 (cAdvisor)**: CPU 사용, `container_cpu_cfs_throttled_periods_total`/`_seconds_total`, 메모리 사용·working set, OOM 이벤트(`container_oom_events_total`), 재시작 횟수. macOS에서 수집 가능 범위는 실험 필요(§14 #3, 불가 시 Docker Engine stats API로 대체).

**nginx**: `stub_status`(active/reading/writing/waiting) → `nginx-prometheus-exporter`(별도 서비스). upstream별 응답 분포는 access log → Loki.

**로그(Loki)**: pino JSON, `trace_id`는 Loki 3 structured metadata로 붙인다. Grafana에서 trace ↔ log 상호 링크.

**SLO**: 엔드포인트별 SLI(성공률, 지연 임계 이하 비율), 번레이트 규칙 1~2개(Prometheus recording/alert rule). 카오스 실험의 중단 조건과 판정 기준으로 쓴다.

### 9.3 추적 (Tempo)

- OTel NodeSDK, 자동 계측(http, express, nestjs-core, pg, ioredis/redis). 샘플러 `parentbased_traceidratio`, 비율은 설정(`OTEL_TRACES_SAMPLER_ARG`).
- 대표 actor는 k6가 sampled 플래그가 켜진 `traceparent`를 직접 만들어 보내 → parent-based 샘플러가 항상 기록. 무대에서 고른 actor의 워터폴을 Tempo에서 바로 열 수 있다.
- 커스텀 span: `lock.wait`, `lock.hold`, `orm.flush`, `tx`, `retry.attempt`, `chunk.process`.

### 9.4 서버 속 패널 vs Grafana 역할 분리

| 서버 속 패널(화면 4)이 그리는 것 | Grafana(화면 5)가 그리는 것 |
|---|---|
| 락 **차단 트리**(누가 누구를 막는지, 실시간) | 모든 시계열(RED, USE, 런타임, 풀, PG, Redis, 컨테이너) |
| 요청 하나의 구간 분해(이벤트 + Tempo span 합성 워터폴) | 실행 간 시계열 겹쳐 보기 |
| 실시간 이벤트 타임라인(대표 actor) | 부하 발생기 유효성 패널 |
| 샘플 SQL 스트림(대표 요청만, 전량 아님) | SLO 번레이트 |
| 정합성 검사 결과(실행 중 주기 검사 + 최종) | 로그 탐색(Loki), 추적 탐색(Tempo) |

실시간 SQL을 전량 보여 주는 것은 불가능하고 그 자체가 관측자 효과를 키운다. 패널 상단에 "샘플: 대표 요청 N명분"을 항상 표시한다.

### 9.5 Grafana 대시보드 구성 (프로비저닝)

1. **실행 개요**: 맨 위 정합성 패널(불변식별 위반 수) → 유효성(k6 CPU, 목표 vs 실제 도착률, dropped_iterations) → 처리량·지연(성공/실패) → phase 주석.
2. **RED (엔드포인트별)**: rate, error ratio, 지연 히스토그램 히트맵, exemplar → Tempo.
3. **USE: 앱**: CPU·스로틀링, 메모리·힙·GC, ELD·ELU, in-flight, 풀 active/idle/waiting, acquire 대기.
4. **USE: PostgreSQL**: 연결 상태, wait_event, 락 대기, 교착, 커밋/롤백, 캐시 히트, temp, WAL, dead tuple, 체크포인트, 복제 지연.
5. **USE: Redis**: 명령 지연, 메모리·eviction, 연결, 락 키 수, Streams.
6. **부하 발생기 유효성**: k6 CPU/메모리, VU, 도착률 목표 vs 실제, dropped_iterations.
7. **큐/워커·아웃박스**: 백로그, 처리율, 리스 회수, 중복 감지.
8. **SLO**: SLI, 번레이트, 에러 버짓 소진.
9. **컨테이너**: cAdvisor 전체.

모든 대시보드는 `runId` 변수로 필터되고, 웹 UI는 `/d-solo/...` 패널 URL 또는 kiosk 모드로 임베드한다.

---

## 10. 화면

시각 디자인: 2화면 휴대용 게임기 감성의 오리지널 디자인(상표·실존 에셋 금지) — 세부는 `design/DESIGN_SYSTEM.md`.

### 10.1 화면 11개 명세

| # | 화면 | 목적 | 주요 요소 | 데이터 출처 |
|---|---|---|---|---|
| 1 | 시나리오 목록 | 팩·시나리오 탐색 | 팩 탭, 카드(제목, 태그, strategy 수, 부하 모델, 진행 상태: 예측 작성/실행/노트 완료) | `GET /scenarios`, 실험 노트 존재 여부 |
| 2 | 실행 설정 | 같은 조건에서 strategy만 바꿔 실행 | strategy 선택(복수 선택 시 순차 배치), 인원/도착률, 부하 모양(일정/램프/스파이크/스트레스/소크/계단), 데이터 크기·분포, 앱 인스턴스 수, DB 경로(direct/pgbouncer), 계측 수준, 경합 창 지연 주입, 반복 횟수, **예측 입력란(실행 전 필수)** | manifest `params`·`k6/params.schema.json`으로 폼 자동 생성 → `POST /k6/render`, `POST /runs` |
| 3 | 라이브 무대 | 처리 단계를 직관적으로 보기 | 게임풍 2D 장면, 대표 actor 캐릭터, 군중 카운터, 상단 HUD(처리량, 정합성 실시간 상태, "주입됨" 배지), actor 클릭 → 화면 4 워터폴 | `WS /ws/runs/:id` 이벤트 |
| 4 | 서버 속 패널 | Grafana가 못 하는 내부 상태 | 락 차단 트리, 트랜잭션 목록(지속 시간, 상태, wait_event), 풀 게이지, 힙·ELD 미니 차트, 샘플 SQL 스트림, 요청 워터폴(이벤트+span), 이벤트 타임라인(텍스트) | WS(이벤트, PG 프로브), Tempo API(trace 조회) |
| 5 | 지표 패널 | 시계열 | Grafana 대시보드 임베드(실행 개요/RED/USE 탭), runId 자동 필터, 시간 범위 = 실행 구간 | Grafana iframe |
| 6 | 망가뜨리기 | 장애 주입과 회복 관찰 | 버튼: app 인스턴스 kill/SIGTERM, Redis stop/start, PG 연결 축소(`lab_app` 역할 `CONNECTION LIMIT`)·풀 크기 축소, toxiproxy 지연·끊김·대역폭, 롤링 재시작, 예약 실행(시각 지정), **중단 조건**(SLO 번레이트, 불변식 위반 시 자동 중단) | `POST /runs/:id/chaos`, toxiproxy API(오케스트레이터 경유) |
| 7 | 실행 기록 | 과거 실행 조회 | 목록(시나리오, strategy, 유효/무효, 불변식, 3회 범위), k6 HTML 리포트 링크, 메타데이터 보기, 아티팩트 다운로드 | 메타데이터 SQLite, `runs/<id>/` |
| 8 | 비교 | strategy 간 상대 비교 | 정합성 먼저, 그다음 처리량·지연(3회 범위 막대, 표본 수, 처리량 쌍), 포화 지표, **조건 차이 경고**, 이벤트 phase 분포 비교 | `GET /compare` |
| 9 | 실험 노트 | 예측→결과→원인 기록 | EXPERIMENT_TEMPLATE 폼, 실행 결과 자동 첨부(링크·수치), 예측과 결과 대조, 마크다운으로 `docs/experiments/`에 저장 | 메타데이터 + 사용자 입력 → 파일 |
| 11 | 코드 실험실 | 부하·상황별로 어떤 코드가 들어가야 하고 왜 그런지 학습 | §10.4 참조 | `learn.yaml`, 팩 소스, `GET /runs`(measured) |
| 10 | k6 스크립트 | 실행될 스크립트 확인·수정 | 템플릿 렌더 결과 보기, Monaco 편집기, 템플릿 대비 diff, "편집됨" 표시와 해시, 되돌리기 | `POST /k6/render`, 편집본은 RunConfig에 포함 |

### 10.2 템플릿 기반 k6 스크립트 생성·보기·편집

- 생성: 시나리오의 `k6/template.js.eta` + `loadtest/profiles/*` + `loadtest/lib/*`를 화면 2 설정으로 렌더링. 템플릿 엔진은 Eta(가벼운 JS 템플릿) — 대안 Handlebars, 확정은 구현 시.
- 보기/편집: 화면 10에서 렌더 결과를 보고 수정할 수 있다. 편집본은 스크립트 해시가 달라지므로 메타데이터에 `edited: true`가 남고, 비교 화면에서 "비교 불가(스크립트 다름)" 경고가 뜬다.
- 검증: 실행 전 `k6 inspect --execution-requirements`로 문법·옵션과 필요 VU 수·실행 시간을 확인한다.
- **k6 Studio와 겹치는 부분은 만들지 않는다:** 브라우저 녹화, HAR → 스크립트 변환, 시각적 요청 빌더, 상관관계·검증 규칙 편집, 범용 스크립트 디버거. 이유: 이미 잘 만들어진 공식 도구가 있고, nestjs-under-load의 가치는 "시나리오 템플릿 파라미터 → 같은 조건 재현"에 있지 범용 스크립트 저작에 있지 않다. 사용자가 Studio에서 만든 스크립트를 붙여 넣는 것은 막지 않는다(편집본으로 취급).

### 10.4 코드 실험실 (화면 11)

IDE처럼 생긴 학습 화면. 코드는 AI가 썼고, 사용자는 "이 부하·상황에서 어떤 코드가 왜 들어가는가"를 읽는다.

- **탐색기:** 시나리오 폴더 트리(strategies/, invariants.sql, api/, k6/ 등). 파일을 열면 에디터에 표시.
- **상황 선택 바:** `learn.yaml`의 `situations` 칩(인원·서버 대수·카오스 조합). 상황을 바꾸면 판정 패널과 강조 줄이 따라 바뀐다.
- **에디터(Monaco, 읽기 전용):** `// @learn` 마커 줄을 강조하고 한 줄 설명을 표시. strategy 두 개를 **나란히 비교**(diff 아님, 같은 상황에서의 두 구현)할 수 있다.
- **판정 패널:** 선택한 strategy × 상황의 `verdict` 배지, `expected`(예상 배지)와 `measured`(실측 run# 배지, 없으면 "미실측"), `why`, 실행되는 SQL, 관련 `concepts` 카드, `choose` 가이드("이 상황이면 이 코드 / 피할 코드").
- **매트릭스 보기:** strategy × situation 표에 verdict 색. 셀을 누르면 해당 상황·strategy로 이동. 예상과 실측이 다른 셀에 표시.
- **무대 화면과의 탭 연결:** 판정 패널에서 "이 상황으로 실행"(화면 2에 situation 값을 채워 이동), 무대(화면 3)의 장면에서 "코드 보기"로 해당 strategy의 마커 줄로 이동.
- **실측 흐름:** 오케스트레이터가 실행을 마치면 해당 outcome의 `measured`를 run id·수치로 채운다. 화면은 파일(`learn.yaml`) 또는 `GET /learn/:scenario`로 읽고, 쓰는 쪽은 오케스트레이터뿐이다.

### 10.3 게임풍 무대

- **선택: PixiJS (v8, `@pixi/react`)**
  - 무대는 물리·충돌·입력이 필요한 게임이 아니라 **이벤트 스트림을 상태로 받아 그리는 시각화**다. PixiJS는 렌더러만 제공해 이 모델에 맞고, React 화면 안에 붙이기 쉽다.
  - Phaser는 씬·물리·입력·오디오까지 갖춘 게임 프레임워크라 이 용도에는 무겁고, 자체 게임 루프와 React 상태 관리가 겹친다.
  - 위험: 애니메이션 트윈·씬 전환을 직접 만들어야 한다 → GSAP 또는 간단한 자체 트윈으로 해결. GSAP는 무료 Standard License(OSI 승인 라이선스 아님, 경쟁 제품 제작 금지 조항)라 npm 의존성으로만 쓰고 리포에 vendor 복사하지 않는다(신뢰도 중).
- **실제 이벤트 기반:** 캐릭터 이동은 이벤트 phase 전이로만 일어난다. 가짜 애니메이션(시간 경과만으로 움직이기) 금지. 이동 연출은 기록된 이벤트 사이의 보간이며, 이벤트 없이 단독으로 상태를 바꾸지 않는다. 이벤트 지연 도착에 대비해 0.5~1초 재생 버퍼를 두고 `ts`·`seq` 순으로 재생한다(버퍼 길이 표시).
- **대표 표본 렌더링:** 대표 actor(기본 8명)만 캐릭터로 그리고, 나머지는 집계 카운트를 숫자·막대(대기열 길이)로 표시한다. 화면 상단에 "N명 중 8명 표시"를 고정 노출한다.
- **장면 타입(scene.yaml의 `sceneType`)**

| 장면 타입 | 비유 | 쓰는 시나리오 예 |
|---|---|---|
| `queue-at-counter` | 창구 앞 줄서기, 창구 = 행/락 | G02, G03, G05, T04 |
| `shared-document` | 한 책상에 놓인 문서를 여럿이 고침, 충돌 시 종이 찢김 | G01, T01, T02 |
| `conveyor` | 컨베이어 벨트 위 상자(청크), 진행률 | G07, G08, T03, G22 |
| `worker-pool` | 작업대와 일꾼, 일꾼 쓰러짐(사망) → 다른 일꾼이 회수 | G10, G18, G27 |
| `gate-and-pool` | 입구 게이트(429) + 한정된 의자(커넥션) | G11, G12, G13, G14, G16, T08 |
| `cache-shelf` | 진열대(캐시)와 창고(DB), 진열대 비면 몰림 | G17 |
| `broadcast` | 방송탑과 여러 방(인스턴스) | T07, G24 |
| `generic-timeline` | 장면 없는 레인 타임라인(기본값) | 나머지 |

- **무대 표현 원칙 (원인이 보이게):**
  - 원인 장면을 반드시 보인다. 예: G01은 두 캐릭터가 **같은 버전을 각각 받는 장면**이 먼저 나오고, 그 뒤 저장 충돌이 이어진다. 결과(종이 찢김)만 있고 원인이 없으면 학습이 안 된다.
  - 행위자별로 커밋을 분리해 그린다(A의 커밋, B의 커밋을 서로 다른 레인·색으로).
  - 코드 거터(§10.3.2)에 행위자별 커서를 동시에 표시한다(A▶, B▶가 각자 현재 줄에 선다).
  - 요청별 트랜잭션 경계 띠: 저장은 `em.transactional`로 UPDATE와 원장·document_revision INSERT를 함께 커밋하는 트랜잭션이고, 자동 커밋은 읽기 SELECT와 lease acquire·release뿐이다. 읽기와 저장이 다른 트랜잭션임을 띠로 보인다.
  - 격리 수준 배지: 지금 처리 방식이 쓰는 격리 수준(예: READ COMMITTED)을 장면에 고정 표시한다.
  - 실행 전 예측 입력: 시나리오의 예측 질문에 사용자가 답을 적고 실행하면, 결과 화면에서 예측과 실제를 나란히 보인다.
  - 시안 단계에서 보여주는 장면은 G01(같은 문서 동시 수정)이다. T01·T02는 같은 `shared-document` 타입을 쓰되 G01 처리 방식을 다시 그리지 않는다.
- 장면 매핑: `scene.yaml`이 `phase → 동작`(예: `lock_wait → 줄에 합류`, `conflict → 종이 찢김`)을 선언한다. 매핑이 없는 phase는 말풍선 텍스트로만 표시.

---


#### 10.3.1 재생 방식 (읽을 수 있는 속도)

실제 처리는 밀리초 단위라 실시간으로 그리면 읽을 수 없다. 무대와 타임라인은 **기록 재생**으로 동작한다. 실행 중에는 이벤트를 시각과 함께 쌓고, 화면은 그 기록을 시간 배율을 바꿔 재생한다(실행이 끝난 뒤 다시 보기도 같은 경로).

- 재생 컨트롤: 재생/일시정지, 속도 1/400·1/160·1/80·1/40(라벨 "아주 느리게/느리게/보통/빠르게"), 한 단계씩(다음 이벤트), 타임라인 스크러버. 키보드 Space=재생/정지, →=한 단계.
- 핵심 순간 자동 멈춤(기본 ON): 충돌, 잃어버린 수정, 락 대기 시작, 불변식 위반, 원인(같은 버전 수신), 첫 423, 보유자 이탈·멈춤, TTL 만료에서 멈추고 장면 강조 + 한 줄 설명.
- 타임라인: 같은 종류 반복은 "×N"으로 묶고, 핵심 이벤트만 기본 표시(전체 보기 토글), 종류 필터, 현재 위치 행 강조, 행마다 실제 경과 시간(ms).
- 화면에 재생 배율과 실제 시간을 함께 표시한다("실제 12ms를 느리게(1/160)로 재생 중"). 처음 열면 느리게(1/160) + 자동 멈춤 ON.
- 실행 중 재생(라이브)과 기록 재생의 관계: 실행 중에는 라이브 뒤를 버퍼 지연으로 따라가고, 1/160 등 배속은 기록 재생(실행 종료 후 또는 일시정지 후 되감기)에서만 쓴다.
- 재생은 표시 계층의 일이다. 측정·불변식 판정은 재생 속도와 무관하다(§3 원칙 1, 판정은 DB 원장 기준).
- 빈 구간 빨리 감기(기본 ON): 이벤트가 없는 구간(이동·대기 연출)은 짧게 접고, 이벤트 전후만 선택한 배율로 재생한다. 스크러버에 접힌 구간을 다른 무늬로 표시하고 "실제 n ms 압축"을 보여 준다. 끄면 실제 시간 비율 그대로.

#### 10.3.2 코드 패널 (서버 코드와 함께 보기)

무대 옆(좁은 화면에선 아래)에 선택한 처리 방식의 서버 코드(서비스·리포지토리)를 보여 주고, 재생 중 이벤트가 나올 때 그 이벤트를 낸 줄을 강조한다.

- 매핑: 계측 이벤트에 `codeRef`(시나리오 팩 기준 상대 경로 + 줄 번호, 예: `packs/generic/g01-shared-document/strategies/optimistic-version.strategy.ts:42`)를 싣는다. 줄 번호는 빌드 시 소스에서 마커 주석(`// @event lock_acquired`)을 찾아 생성해 코드 수정에도 어긋나지 않게 한다.
- 소스 제공: 웹 빌드 때 각 시나리오 팩의 strategy 소스를 읽기 전용 번들로 포함한다(실행 중 서버 파일 시스템을 읽지 않는다 — §13 로컬 전용·최소 노출).
- 함께 보이는 것: 그 순간 나간 SQL(샘플, §9.4), 영향 행 수(예: `UPDATE … WHERE id=$1 AND version=$2` → 0 rows), 한 줄 설명.
- 비교: 두 처리 방식을 나란히 놓고 차이 줄을 강조한다(덮어쓰기 vs 버전 감지 등).
- 원칙: 패널의 코드는 **실제로 실행되는 그 코드**여야 한다(시안 단계의 예시 코드는 "예시" 표기). 학습자가 코드에서 원인을 찾을 수 있게 하는 것이 목적이다.

## 11. 망가뜨리기 훅 (엔진 공통)

| 훅 | 구현 | 관찰 포인트 |
|---|---|---|
| app 인스턴스 kill (SIGKILL) / SIGTERM | Docker Engine API | 진행 중 요청 실패 수, 정합성, 재연결 |
| 롤링 재시작 | 인스턴스 순차 stop → start, 각 단계 readiness 대기 | 실패 0 여부(G24) |
| Redis stop/start, 응답 지연 | Docker API / toxiproxy | fail-open vs fail-closed |
| PG 커넥션 축소 | `max_connections`는 재시작 필요 → 대신 app 전용 비superuser 역할에 `ALTER ROLE lab_app CONNECTION LIMIT n`(superuser에는 적용되지 않음, 새 연결부터 적용) + 기존 초과분은 `pg_terminate_backend`, 또는 RunConfig 풀 크기 변경 후 app restart. 0단계에서 실제 동작을 먼저 확인한다(신뢰도 중상) | 풀 대기, 타임아웃 |
| 네트워크 지연·끊김·대역폭 | toxiproxy toxics: `latency`, `timeout`, `bandwidth`, `reset_peer`, `slow_close`, `limit_data` | 타임아웃·재시도·브레이커 |
| 경합 창 지연 주입 | §6.3 | 경합 재현 확률 |
| 장기 트랜잭션 주입 | 오케스트레이터가 별도 세션에서 `BEGIN; SELECT ...;` 유지 | vacuum, lock queue(G20, G21) |
| 복제 지연 | `recovery_min_apply_delay` 또는 toxiproxy | read-your-writes(G23) |

모든 개입은 메타데이터 `chaos`/`interventions`와 Grafana 주석에 남는다. 중단 조건(불변식 critical 위반, SLO 번레이트 초과, 실행 시간 초과)이 충족되면 자동 중단한다.

---

## 12. 공통 앱 기능 (엔진이 제공, 시나리오가 켜고 끔)

- **타임아웃 계층:** HTTP 클라이언트(k6) 타임아웃 > 서버 요청 타임아웃 > 풀 acquire 타임아웃 / `statement_timeout` / `lock_timeout`, 그리고 `idle_in_transaction_session_timeout`. 값은 RunConfig에 있고 메타데이터에 기록.
- **과부하 차단:** 동시성 상한·대기 큐 상한 초과 시 즉시 429/503(`Retry-After`). 시나리오가 켤 때만 동작.
- **재시도 래퍼:** 지수 백오프 + 지터, 재시도 예산(비율 상한), 재시도 대상 오류 분류(40001, 40P01, 락 타임아웃, 연결 오류).
- **서킷 브레이커:** Redis·외부 호출용. 상태를 지표로 노출.
- **그레이스풀 셧다운:** 오픈소스 nginx에는 능동 헬스체크가 없다(수동 판정 `max_fails=1`, `fail_timeout=10s` 기본). 그래서 readiness 실패만으로는 nginx가 인스턴스를 빼지 않는다. 순서: `enableShutdownHooks` → SIGTERM → `server.close()`로 새 연결 거부 → nginx `proxy_next_upstream error`로 다음 인스턴스에 재전송(연결 거부는 upstream에 요청이 전달되기 전이라 POST도 재전송된다) → in-flight drain(제한 시간) → SSE 종료 이벤트 → 풀 종료. POST가 이미 upstream에 전달된 뒤 끊기면 `non_idempotent`를 켜지 않는 한 재전송되지 않는다. nginx↔app upstream keepalive의 idle 연결이 끊길 때의 동작은 따로 검증한다. 대안: 오케스트레이터가 SIGTERM 전에 upstream 설정(공유 볼륨)에서 해당 인스턴스를 빼고 `nginx -s reload`(nginx 컨테이너에 HUP 시그널 kill — 소켓 프록시 허용 범위 안). Dockerfile은 exec form + init으로 PID 1 시그널 문제를 막고, compose `stop_grace_period`를 drain 제한보다 길게.

---

## 13. 보안

- **로컬 전용.** 모든 호스트 포트는 `127.0.0.1:` 접두로 바인딩한다(`ports: ["127.0.0.1:8080:80"]`). `0.0.0.0` 바인딩 금지. 인증은 두지 않으므로 외부 노출 = 무방비.
- **위험 구조 명시:** 사용자가 편집한 k6 스크립트를 실행하고, 오케스트레이터가 Docker API로 컨테이너를 제어한다. 컨테이너 **생성** 권한은 Docker 호스트(VM)의 root와 같다(호스트 경로를 마운트한 특권 컨테이너를 만들 수 있으므로). 소켓 프록시의 API 화이트리스트로 생성 API를 허용하면 이 위험은 거의 줄지 않는다. 그래서 설계 자체를 바꿨다.
  - app은 재생성하지 않고 restart만 하고, 부팅 시 오케스트레이터에서 RunConfig를 받아온다(§5.3).
  - k6는 상주 컨테이너로 두고 스크립트를 받아 실행한다(§4.1).
  - 그 결과 소켓 프록시에는 컨테이너 조회·restart·stop·start·kill만 허용한다(생성·exec·이미지·볼륨 API 차단).
- **소켓·호스트 마운트를 가진 컨테이너(전체 목록):**

| 컨테이너 | 마운트 | 이유 |
|---|---|---|
| `socket-proxy`(orchestrator가 경유) | docker.sock | restart/stop/start/kill 화이트리스트 |
| `alloy` | docker.sock(읽기) | `discovery.docker` + `loki.source.docker`로 컨테이너 로그 수집 |
| `cadvisor` | rootfs·`/sys`·`/var/lib/docker` 등(읽기 전용) | 컨테이너 지표 수집 |

  orchestrator 자신은 소켓을 직접 마운트하지 않는다. 이 밖의 컨테이너에는 소켓·호스트 경로 마운트를 두지 않는다(`runs/` 아티팩트 호스트 마운트는 선택).
- **완화:**
  - 오케스트레이터 API는 `Origin` 헤더를 `http://127.0.0.1:<web>`/`http://localhost:<web>`만 허용(브라우저 경유 DNS 리바인딩·CSRF 방지). `Host` 헤더도 화이트리스트.
  - `/ingest/events`는 lab-net 내부에서만 접근(호스트 포트 미공개).
  - `/internal/run-config`와 k6 실행기 API도 lab-net 내부 전용이다.
  - toxiproxy·pgbouncer 관리 포트, Prometheus, Tempo, Loki는 호스트에 공개하지 않는다. Grafana만 127.0.0.1로 공개(익명 Viewer, 편집 권한 없음). 주석 쓰기는 오케스트레이터만 서비스 계정 토큰으로.
  - 비밀번호는 `.env.example`의 로컬 기본값만, 실제 비밀 정보 없음. README 첫 화면에 "공용 네트워크·서버에 띄우지 말 것" 경고.
- k6 스크립트 자체는 k6 런타임(goja) 안에서 돌아 파일 시스템 접근이 제한되지만 네트워크는 어디든 호출할 수 있다. k6 컨테이너는 `lab-net`(부하)과 `obs-net`(remote-write)에만 붙이고, 두 망 모두 `internal: true`라 인터넷 egress가 없다. 호스트 포트가 필요한 서비스만 internal이 아닌 `ctl-net`에 추가 연결한다(§4.2).

---

## 14. 확인 필요 목록

> 2026-10-06 갱신. "해소"는 공식 문서·소스로 확정해 본문에 반영한 항목이다. 신뢰도가 표시된 항목은 구현 첫 사용 시 소규모 실험으로 한 번 더 확인한다.

| # | 항목 | 결과 | 상태 |
|---|---|---|---|
| 1 | nginx가 `--scale`로 늘어난 app 인스턴스를 재해석하는 방식 | nginx 1.27.3+ 오픈소스는 upstream `zone` + `server app:3000 resolve;` + `resolver 127.0.0.11 valid=2s;`로 주기 재해석. 이전 버전은 시작 시 한 번만 해석해 재생성 후 502 → `nginx -s reload` 필요(§4.1) | 해소 |
| 2 | Docker Desktop(macOS)에서 cpuset 고정의 실제 격리 효과 | cpuset은 VM vCPU 고정일 뿐 물리 코어 고정이 아니다. Apple Silicon P/E 편차는 메타데이터에 기록(§4.1) | 실험 필요 |
| 3 | cAdvisor가 macOS Docker Desktop에서 컨테이너별 CPU·CFS 스로틀링·OOM 지표를 내는지 | rootfs·docker.sock 마운트가 필요(§13). 지표 범위는 기동 후 확인, 안 되면 Docker stats API | 실험 필요 |
| 4 | Promtail 지원 종료 일정과 Alloy 설정 방식 | Promtail EOL 2026-03-02. Alloy `discovery.docker` + `loki.source.docker`(docker.sock 마운트)(§4.1) | 해소 |
| 5 | MikroORM v7에서 pg Pool 인스턴스 접근과 acquire 래핑 지점 | `driverOptions: { onPoolCreated: (pool) => … }`로 pg Pool(`totalCount`/`idleCount`/`waitingCount`). acquire 시간은 `pool.connect` 래핑 또는 Kysely `onReserveConnection`(§9.2) | 해소 |
| 6 | MikroORM v7 Identity Map 크기 조회 API, 쿼리 로거 훅 지점 | `em.getUnitOfWork().getIdentityMap().keys().length`(`@internal`, 버전 고정). 쿼리 훅 = `loggerFactory` + `debug: ['query']`, `LogContext.took`(디버그 로깅 오버헤드 주의). `onQuery`는 SQL 변환용(§9.2) | 해소 |
| 7 | `pg_stat_reset_shared` 대상 이름 | PG17: `archiver`, `bgwriter`, `checkpointer`, `io`, `recovery_prefetch`, `slru`, `wal`(§7.1) | 해소 |
| 8 | postgres_exporter 기본 수집기 범위 | 기본 on: `stat_activity`, `stat_database`, `stat_user_tables`, `locks`, `wal` / off: `stat_statements`, `long_running_transactions`, `stat_checkpointer`, `stat_activity_autovacuum`, `process_idle`. wait_event는 custom query 또는 프로브(§9.2) | 해소 |
| 9 | redis_exporter 키 패턴 카운트 옵션명 | `--count-keys`(예: `db0=lock:*`), `--check-keys`, `--check-streams`. TTL은 DB 평균만 → 키별은 프로브(§4.1, §9.2) | 해소 |
| 10 | PgBouncer 지표 수집 | `pgbouncer_exporter` 별도 서비스(§4.1) | 해소 |
| 11 | k6 Prometheus 트렌드 집계, 웹 대시보드 export, `k6 inspect` | `K6_PROMETHEUS_RW_TREND_STATS` 기본 `p(99)` → `K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true` + Prometheus `--enable-feature=native-histograms`. HTML은 `K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=<볼륨 경로>`. `k6 inspect --execution-requirements`(§7.5, §8) | 해소 |
| 12 | GSAP 라이선스 | 무료 Standard License(OSI 아님, 경쟁 제품 금지). npm 의존성으로만, vendor 금지(§10.3) | 해소(신뢰도 중) |
| 13 | Docker 소켓 프록시로 compose 재생성 API를 허용하는 최소 범위 | 방향 변경: 생성 권한 = root 동등이라 재생성을 버리고 restart-only + 부팅 시 RunConfig 조회. 프록시는 restart/stop/start/kill만(§5.3, §13) | 해소(설계 변경) |
| 14 | k6 컨테이너 인터넷 egress 차단 방식 | lab-net·obs-net `internal: true`, 호스트 포트 서비스만 ctl-net 추가 연결(§4.2, §13) | 해소 |
| 15 | PG 커넥션 축소를 재시작 없이 하는 방법 | `max_connections`는 재시작 필요 → 비superuser `lab_app`에 `ALTER ROLE ... CONNECTION LIMIT`(새 연결부터) + `pg_terminate_backend`, 또는 RunConfig 풀 크기(§11). 0단계에서 동작 확인 | 해소(신뢰도 중상) |
| 16 | nginx stub_status 지표 수집 | `nginx-prometheus-exporter` 별도 서비스(§4.1) | 해소 |
| 17 | 템플릿 DB 복제 시 WAL 영향과 `STRATEGY` | 기본 `WAL_LOG`는 큰 템플릿에서 WAL 폭증·복제본 전송 → 큰 템플릿(T05, G19)은 `STRATEGY FILE_COPY`(앞뒤 체크포인트 강제)(§7.1) | 해소 |
| 18 | MikroORM 기본 `loadStrategy`, dataloader 옵션, 조회 전용 find 옵션 (G08·G09) | v7 기본 `balanced`. dataloader는 `DataloaderType.REFERENCE`/`COLLECTION`/`ALL` 또는 boolean. 조회 전용은 `disableIdentityMap: true` | 해소 |
| 19 | MikroORM 읽기 복제본 설정 (G23) | `replicas: [...]`, `preferReadReplicas`(기본 true), `connectionType: 'read' \| 'write'`. 트랜잭션 안 읽기는 항상 primary | 해소 |
| 20 | PgBouncer prepared statement와 node-postgres/MikroORM (G12) | Kysely·node-postgres는 이름 없는 문장을 써서 트랜잭션 모드에서 문제없음. 함정 재현은 pg 쿼리에 `name`을 지정. PgBouncer 1.21+ `max_prepared_statements`는 프로토콜 수준 prepared statement만 지원, SQL `PREPARE`는 미지원 | 해소(신뢰도 중상) |
| 21 | Node의 cgroup 메모리 limit 인식과 기본 힙 한도 (G25) | Node 20+는 cgroup limit을 인식하고 기본 힙 ≈ limit의 50% | 해소 |
| 22 | 스트리밍 xlsx 라이브러리 (T03·G22) | exceljs `stream.xlsx.WorkbookWriter`/`WorkbookReader`. npm의 SheetJS는 갱신이 멈춰 쓰지 않는다 | 해소 |
| 23 | k6에서 SSE 구독 방법 (T07·G24) | xk6-sse는 커스텀 k6 빌드가 필요 → 별도 Node 구독기 컨테이너(`sse-subscriber`) | 해소 |
| 24 | 오픈소스 nginx의 upstream 장애 감지 (G24) | 능동 헬스체크 없음. `max_fails=1`, `fail_timeout=10s` 기본. 연결 거부는 `proxy_next_upstream error`로 재전송, 이미 전달된 POST는 재전송 안 함(`non_idempotent` 예외)(§12) | 해소 |
| 25 | Redis 재시작 시 AOF 설정별 유실 범위 (G03·G27) | `appendfsync always` ≈ 무손실, `everysec` 최대 약 1초(최악 2초), `no`는 OS 플러시 주기(Linux 약 30초). Redis 기본은 `appendonly no`라 마지막 RDB 스냅샷 이후가 유실 | 해소 |
