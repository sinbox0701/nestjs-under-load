# 1단계 인터페이스 계약

로드맵 1단계를 병렬로 구현하기 전에 고정한 계약이다. 정본은 `engine/contracts`(zod 스키마·fixture)이고, 이 문서와 다르면 정본을 따르되 이 문서를 같이 고친다.

## 계약 C1–C10

정본은 `engine/contracts/src/*.ts`(zod)와 `engine/contracts/fixtures/*` 입니다. 오케스트레이터가 이 절을 `docs/CONTRACTS-phase1.md` 로 저장하는 것을 권합니다.

### C1. RunConfig 전달 (0단계 파일 → 1단계 엔드포인트)

**전달 방식**
- app 의 정적 env 에 `ORCHESTRATOR_URL=http://orchestrator:4001` 을 둡니다. 값이 있으면 HTTP, 없으면 0단계 파일(`RUN_CONFIG_PATH`)을 읽습니다. run.mjs 대체 경로라서 계속 유지합니다.
- `GET {ORCHESTRATOR_URL}/internal/run-config?instance=<INSTANCE_NAME>` 의 응답:
  - `200 RunConfig`
  - `204` = 대기 모드(`/_lab` 만 응답)
  - 부팅할 때 1초 간격으로 최대 30번 다시 시도하고, 그래도 실패하면 exit 1 합니다.

**RunConfig v1 스키마**
```jsonc
{ "schemaVersion": 1,                       // 없으면 0단계 파일(기본값으로 채움)
  "task": "serve",                          // serve | prepare-template
  "runId": "...", "batchId": "...", "repetition": 1,
  "scenario": "g02-stock-decrement", "strategy": "row-lock", "strategyParams": { "lockTimeoutMs": 1000 },
  "instrumentation": "metrics",             // off | metrics | full
  "injectDelay": [ { "point": "after-read", "ms": 30 } ],
  "pool": { "min": 2, "max": 10, "acquireTimeoutMs": 2000 },
  "timeouts": { "serverRequestMs": 5000, "statementMs": 3000, "idleInTxMs": 10000 },
  "events": { "endpoint": "http://orchestrator:4001/ingest/events", "representativeActors": 8,
              "flushMs": 100, "batchMax": 500, "bufferMax": 10000 },
  "tracing": { "endpoint": "http://tempo:4318/v1/traces", "rootSampleRatio": 0.1 },
  "redis": { "host": "redis", "port": 6379 },          // 시나리오가 안 쓰면 null
  "prepareTemplate": { "database": "tpl_g02_ab12…", "seedOptions": { "products": 5 } }  // task=prepare-template 일 때만
}
```

**ready 응답**: `GET /_lab/ready` → `{ instance, runId, task, scenario, strategy, instrumentation, bootedAt, prepared?: { database, durationMs } }`
- `task=prepare-template` 이면 마이그레이션과 시드가 끝난 뒤에 200 을 돌려줍니다.

### C2. 오케스트레이터 REST/WS

**포트와 접근 제한**
- 공개 포트 `4000`: ctl-net 에 붙고 호스트 `127.0.0.1:4000` 으로 열립니다. 웹은 `/api/*`, `/ws/*` 프록시를 거칩니다.
- 내부 포트 `4001`: lab-net 에만 붙고 호스트 포트는 없습니다.
- 공개 포트 가드: `Origin` 이 있으면 `http://{127.0.0.1|localhost}:{8080|5173}` 만 허용하고, 나머지는 403 입니다. `Host` 는 `127.0.0.1:4000 | localhost:4000 | orchestrator:4000` 만 허용합니다.

**공개 포트 4000**

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| GET | `/health` | – | `{ok, version, gitSha}` |
| GET | `/scenarios` | – | `ScenarioInfo[]` = `{id, pack, title, minAppInstances, strategies:[{id,label,kind,bypassesOrm,requires,params}], load:{models:['open','closed'], defaults}, seedDefaults, situations?}` |
| POST | `/k6/render` | `{request: RunRequest, strategy}` | `{templatePath, env: Record<string,string>, scriptHash}`(1단계는 렌더 없이 env 만) |
| POST | `/runs` | `RunRequest` | `202 {sessionId, batches:[{batchId, strategy, appInstances, runIds}]}` · `400 {errors}` · `409 {reason:'busy', sessionId}` |
| GET | `/sessions/:id` | – | `{sessionId, state: queued\|running\|done\|aborted\|failed, request, current:{runId, step}\|null, batches: BatchSummary[], startedAt, endedAt}` |
| GET | `/runs` | `?scenario&strategy&batchId&limit&before` | `{items: RunRow[], next}` |
| GET | `/runs/:id` | – | `{row: RunRow, metadata: RunMetadata\|null, steps:[{name, at}]}` |
| GET | `/runs/:id/artifacts/:name` | name ∈ `metadata.json, summary.json, report.html, events.ndjson, agg.ndjson, prom.json, probe.ndjson` | 파일 |
| GET | `/batches/:id` | – | `BatchSummary` |
| POST | `/runs/:id/abort` | – | `202`(그 실행이 속한 세션 전체 중단) |
| POST | `/runs/:id/chaos` | – | `501`(3단계) |
| GET | `/compare` | `?batches=a,b[,..]&axis=<path>` | `CompareResult` |
| GET | `/learn/:scenario/measured` | – | `{scenario, cells:[{strategy, situation, measured}]}`(learn.yaml `measured` 와 같은 모양, 메타데이터에서 계산) |
| WS | `/ws/runs/:runId` | `runId` 자리에 `current` 를 쓰면 진행 중인 실행을 따라감 | `WsMessage` 스트림 |

**내부 포트 4001**: `GET /internal/run-config`, `POST /ingest/events`(C4)

**RunRequest**
```jsonc
{ "scenario": "g02-stock-decrement",
  "strategies": ["no-lock","row-lock"],            // 순차 배치
  "strategyParams": { "row-lock": { "lockTimeoutMs": 1000 } },
  "appInstances": [2],                              // 케이스 = strategies × appInstances
  "includeMemoryLockSingle": true,                  // run.mjs 동작 보존
  "reps": 3,                                        // 1..20
  "load": { "model": "closed", "profile": "constant", "vus": 50, "rate": null,
            "preAllocatedVUs": null, "maxVUs": null, "duration": "30s", "warmup": "10s",
            "thinkTimeMs": [0, 0], "requestTimeout": "10s" },
  "data": { "seed": 42, "seedOptions": { "products": 5, "warmupProducts": 5, "stockPerProduct": 100 },
            "distribution": { "kind": "uniform" } },  // 또는 {kind:"zipf", s:1.1}
  "scenarioParams": { "qty": 1 },                   // k6 시나리오 전용 값
  "instrumentation": "metrics",
  "pgProbe": { "enabled": true, "intervalMs": 5000 },  // 생략하면 수준 기본값(C6)
  "injectDelay": [],
  "prediction": "no-lock이 2대에서 위반할 것이다",  // 필수, 1자 이상(화면 2 예측 입력란)
  "label": null }
```

**RunRow**: `{runId, batchId, sessionId, repetition, scenario, strategy, appInstances, model, instrumentation, status: running|done|failed|aborted, valid: boolean|null, invariantsPassed: boolean|null, violationsTotal: number|null, startedAt, endedAt}`

**BatchSummary** (Spread = `{median, min, max} | null`)
```jsonc
{ "batchId": "...", "scenario": "...", "strategy": "...", "appInstances": 2, "loadModel": "closed",
  "reps": 3, "runIds": [...],
  "invariants": [ { "id": "sold-equals-decrement", "severity": "critical", "violations": [1,0,0], "passed": [false,true,true] } ],
  "validity": { "validReps": 3, "invalidReasons": [[],[],[]] },
  "throughputRps": "Spread",
  "latencyMs": { "success": { "p50": "Spread", "p95": "Spread", "p99": "Spread", "n": [..] },
                 "failed":  { "p95": "Spread", "n": [..] } },   // k6 expected_response:true/false 서브메트릭
  "failures": { "http": [..], "dropped": [..], "droppedCountedAsFailure": [true,..], "total": [..] },
  "interventions": [...], "badges": ["closed-latency-caution","injected","unstable"] }
```

**CompareResult**
```jsonc
{ "comparable": false, "axis": "topology.appInstances",
  "diffs": [ { "path": "topology.appInstances", "values": [1,2], "kind": "axis" },
             { "path": "load.vus", "values": [50,20], "kind": "blocking" },
             { "path": "git.sha", "values": ["a","b"], "kind": "warning" } ],
  "codeVersionDiffers": true, "batches": ["BatchSummary"...], "honestyNote": "§3.1 기본 문구" }
```
- **blocking**: §7.3 비교 조건 경로가 다를 때입니다. `strategy` 는 제외합니다.
- **axis**: 그 경로가 `axis` 로 지정된 경우입니다. axis 로 쓸 수 있는 경로는 `topology.appInstances | instrumentation | pgProbe.enabled | interventions` 뿐입니다.
- **warning**: `git.sha` 가 다를 때입니다.
- `comparable` 은 blocking 이 하나도 없을 때만 true 입니다.

**WsMessage**: `{type, runId, at /*epoch ms*/, data}`

| type | data |
|---|---|
| `status` | `{sessionId, step, state, repetition, progress:{done,total}}` |
| `events` | `WireEventV0[]` |
| `agg` | `AggWindow` |
| `pool` | `{instance, total, idle, waiting}` |
| `probe` | `{sessions:[{pid, appName, state, waitEventType, waitEvent, xactAgeMs, query /*≤200자, 리터럴 마스킹*/}], blocking:[{pid, blockedBy:number[]}], lockWaiters}` |
| `invariants` | `InvariantResult[]` |
| `end` | `{valid, reasons}` |

### C3. 실행 메타데이터 스키마 v1 (§7.3 전체 + 0단계 확장)

```jsonc
{ "schemaVersion": 1, "runId": "", "batchId": "", "sessionId": "", "repetition": 1, "scenario": "",
  "strategy": { "id": "", "params": {} },
  "git": { "sha": "", "dirty": false },
  "images": { "app": "sha256:..", "postgres": "", "k6": "", "nginx": "", "redis": "" },   // Docker inspect ImageID
  "profile": "default",                      // default | minimal
  "stack": { "profiles": ["obs"] },          // 신규: 함께 뜬 관측 프로필(비교 조건)
  "host": { "dockerNcpu": 14, "dockerMemBytes": 0, "os": "", "arch": "", "cpu": "", "dockerDesktopVersion": "" },
  "limits": { "app": {"cpus":1,"mem":"512m","cpuset":"none"}, "nginx": {}, "postgres": {}, "k6": {} },  // inspect 실측값
  "topology": { "appInstances": 2, "lb": "round-robin", "dbPath": "direct", "proxy": "off", "replica": false },
  "pool": { "min": 2, "max": 10, "acquireTimeoutMs": 2000 },
  "postgres": { "configHash": "sha256:(pg_settings 비기본값)", "maxConnections": 100, "sharedBuffers": "512MB",
                "observerConnections": 2, "appRoleConnectionLimit": -1 },
  "timeouts": { "k6RequestMs": 10000, "serverRequestMs": 5000, "poolAcquireMs": 2000, "statementMs": 3000, "lockMs": 1000, "idleInTxMs": 10000 },
  "redis": { "used": true, "maxmemoryPolicy": "noeviction" },
  "data": { "seed": 42, "seedHash": "", "templateDb": "", "seedOptions": {}, "rows": {}, "distribution": "zipf(1.1)", "scenarioParams": {} },
  "load": { "model": "closed", "executor": "constant-vus", "profile": "constant", "vus": 50, "rate": null,
            "timeUnit": null, "preAllocatedVUs": null, "maxVUs": null, "duration": "30s",
            "warmup": "10s(별도 실행)", "thinkTimeMs": [0,0] },
  "k6Script": { "hash": "", "edited": false },
  "instrumentation": "metrics", "pgProbe": { "enabled": true, "intervalMs": 5000 },
  "interventions": [ { "type": "inject-delay", "point": "after-read", "ms": 30 } ], "chaos": [],
  "coldStart": false, "osCacheControlled": false,
  "validity": { "valid": true, "reasons": [], "k6CpuAvgRatio": 0.41, "droppedCountedAsFailure": true,
                "checks": { "k6Cpu": {}, "scrapeGaps": { "gaps": 0 } } },
  "invariants": [ { "id": "", "severity": "critical", "violations": 0, "passed": true } ],
  "ledgerVsClient": {}, "k6": {}, "prediction": "", "steps": [],
  "artifacts": { "runConfig": "", "k6Summary": "", "k6Html": "", "events": "", "agg": "", "probe": "", "promSnapshot": "", "metadata": "" },
  "startedAt": "", "endedAt": "" }
```

**null 을 허용하는 경우** (`completeness.ts` 가 검사하고, 그 밖의 null 은 "미채움"으로 보고합니다)

| 경로 | null 허용 조건 |
|---|---|
| `load.vus` | open 일 때 |
| `load.rate` · `timeUnit` · `preAllocatedVUs` · `maxVUs` | closed 일 때 |
| `timeouts.lockMs` | strategy 에 lock 파라미터가 없을 때 |
| `redis.maxmemoryPolicy` | `used: false` 일 때 |
| `validity.checks.scrapeGaps` | obs 프로필이 없을 때 → `"not-measured"` 문자열 |

**저장**
- SQLite: `runs/_meta/lab.sqlite`, Node 24 내장 `node:sqlite`. 테이블은 `sessions`, `batches`, `runs`(행 컬럼 + `metadata_json`)입니다.
- 파일: `runs/<runId>/metadata.json` 을 0단계와 같은 배치로 남깁니다(measured.mjs 호환).

### C4. 이벤트 프로토콜 v0 (NDJSON 한 줄 = 이벤트 하나, `ndjson.ts` 호환)

**필수 필드**: `v:0`, `runId`, `ts`(epoch µs 정수), `seq`(인스턴스별 0부터 단조 증가), `instance`, `actor`(X-Lab-Actor, 없으면 `"-"`), `phase`(DESIGN §9.1 공통 23개 | `custom:<name>`)

**선택 필드**: `reqId`(X-Request-Id), `traceId`, `entity{type, id:string}`, `durMs`, `attrs`(평면 스칼라 맵, `strategy` 포함), `sampled`, `injected`, `sql`(마스킹), `rows`, `note`. `codeRef` 는 v0 에서 보내지 않고, 웹이 `strategy 파일 + // @event <phase>` 마커로 줄을 찾습니다.

**AggWindow** (별도 `agg.ndjson`, `ndjson.ts` 는 읽지 않음): `{v:0, runId, instance, windowStart /*epoch ms*/, windowMs:1000, counts: Record<phase, number>, dropped /*누적*/}`

**IngestBatch** (`POST /ingest/events`, 최대 1MB)
- 요청 본문: `{v:0, runId, instance, sentAt, dropped, events: WireEventV0[], agg: AggWindow[], pool?: {total, idle, waiting}}`
- 응답: `204` · runId 가 현재 실행과 다르면 `409`(app 은 그 배치를 버리고 dropped 에 셈)

**대표 표본 판정**: k6 는 `__VU <= REP_ACTORS`(기본 8)이면 `traceparent` 플래그 `01`, 아니면 `00` 을 보냅니다. app 은 플래그 비트로 `sampled` 를 정합니다(OTel 이 꺼져 있어도 헤더를 직접 파싱).

**웹 호환**: `ndjson.ts` 가 `v ∈ {0,1}` 을 받도록 바꿉니다. 같은 fixture `engine/contracts/fixtures/events.v0.ndjson` 을 contracts 테스트(zod)와 web 테스트가 둘 다 통과해야 합니다.

### C5. 앱 Prometheus 지표 이름

app 이 부팅할 때 기본 라벨 `run_id`, `scenario`, `strategy`, `instrumentation` 을 붙입니다. `instance` 는 스크레이프 대상에서 옵니다.

| 지표 | 타입·라벨 | 수준 |
|---|---|---|
| `lab_http_request_duration_seconds` | histogram{method, route, status}, 버킷 1ms–10s, full 이면 exemplar traceId | off+ |
| `lab_http_requests_in_flight` | gauge{route} | off+ |
| prom-client 기본 지표(`nodejs_eventloop_lag_p50_seconds`, `_p99_seconds`, `nodejs_gc_duration_seconds{kind}`, `nodejs_heap_size_used_bytes`, `_total_bytes`, `process_resident_memory_bytes`, `nodejs_external_memory_bytes`, `process_cpu_seconds_total`) | 기본 | metrics+ |
| `lab_eventloop_utilization` | gauge 0..1(직전 스크레이프 이후) | metrics+ |
| `lab_uv_threadpool_size` | gauge | metrics+ |
| `lab_db_pool_connections` | gauge{state=total\|idle\|waiting} | metrics+ |
| `lab_db_pool_acquire_duration_seconds` / `lab_db_pool_acquire_timeouts_total` | histogram / counter | metrics+ |
| `lab_orm_flush_duration_seconds` / `lab_orm_flush_changesets` | histogram / histogram | metrics+ |
| `lab_orm_transactions_total{result}` / `lab_orm_transaction_duration_seconds{result}` | commit\|rollback | metrics+ |
| `lab_orm_query_duration_seconds{type}` / `lab_orm_identity_map_size` | select\|insert\|update\|delete\|other / histogram | full |
| `lab_events_emitted_total{kind}` / `lab_events_dropped_total` / `lab_events_batches_failed_total` | counter | metrics+ |
| `lab_injected_delay_total{point}` / `lab_injected_delay_seconds_total{point}` | counter | off+ |
| `lab_instrumentation_info{level}` | gauge =1 | off+ |
| (오케) `lab_orch_ingest_events_total`, `lab_orch_ingest_rejected_total{reason}`, `lab_orch_ws_clients` | | 항상 |

**그 밖의 고정값**
- k6: remote-write 에 `--tag run_id=<id>`, `phase=<warmup|main>` 을 붙입니다. 네이티브 히스토그램이 켜져 있습니다. 실제 이름(`k6_http_req_duration_seconds` 등)은 T-117 이 실행 한 번으로 확인합니다.
- Grafana 주석 태그: `nul`, `run:<runId>`, `batch:<batchId>`, `phase:<reset|warmup|main|invariants>`.
- 대시보드 UID: `nul-run-overview`, `nul-red`, `nul-use-app`, `nul-use-pg`, `nul-loadgen`. 변수는 `run_id`, 시간 범위는 `from`/`to` 입니다.

### C6. 계측 수준 스위치 값

| 값 | prom 지표 | OTel | 이벤트 | SQL 샘플 | ORM 쿼리 로거 | PG 프로브 기본 |
|---|---|---|---|---|---|---|
| `off` | RED + 주입 카운터 + info | 끔(SDK 미시작) | 끔 | 끔 | 끔 | 끔 |
| `metrics` | C5 의 metrics+ | 끔 | agg 만 | 끔 | 끔 | 5000ms |
| `full` | 전체 | parentbased(대표=01) + root 0.1 | 대표 전체 + agg | 대표 요청만 | 켬 | 1000ms |

`RunRequest.pgProbe` 로 프로브만 따로 켜고 끌 수 있습니다(G02 노트의 프로브 on/off 대조용). 비교 조건에도 들어갑니다.

### C7. k6 실행기 API (k6 컨테이너, lab-net `:7070`, 호스트 포트 없음)

**엔드포인트**
- `POST /jobs {runId, phase, script:"/packs/.../k6/template.js", env, tags, prometheusRw:boolean, htmlExport:"/runs/<id>/report.html"|null, summaryPath}`
  - → `202 {jobId}`
  - 실행 중이면 `409`
- `GET /jobs/:id` → `{state: running|done|failed|aborted, exitCode, startedAt, endedAt, cpu:{before, after, cpuMaxCores}}`
  - cpu 값은 cgroup v2 `cpu.stat` 와 `cpu.max` 를 파싱한 것으로, run.mjs 의 `parseCpuStat` 와 같습니다.
- `POST /jobs/:id/abort` → k6 에 SIGINT
- `POST /inspect {script, env}` → `k6 inspect --execution-requirements` 의 JSON
- `GET /health`

**k6 env 공통 키**: `BASE_URL, PHASE, RUN_ID, MODEL(open|closed), RATE, VUS, DURATION, PRE_VUS, MAX_VUS, THINK_MIN_MS, THINK_MAX_MS, DIST(uniform|zipf), ZIPF_S, SEED, REP_ACTORS, REQUEST_TIMEOUT, SUMMARY_PATH`

**시나리오 전용 키**
- G02: `PRODUCT_MIN, PRODUCT_MAX, QTY`
- G01: `DOC_MIN, DOC_MAX, EDIT_MS, STRATEGY, LEASE_RETRY_MS`

### C8. 오케스트레이터 내부 포트 (`orchestrator/src/ports.ts`, 이름만 고정)

`DockerControl`, `DbAdmin`, `InvariantRunner`, `K6Runner`, `MetadataStore`, `RunConfigBoard`(게시/조회), `EventHub`, `ProbeSource`, `ObsClient`(annotate/snapshot/scrapeGaps), `RunEngine`(start/abort/status), `Clock`.

각 모듈 티켓은 이 인터페이스를 구현하고, 테스트는 가짜 구현으로 합니다. 배선은 T-138 이 합니다.

### C9. 팩 쪽 EventSink 계약 (팩은 app 을 import 하지 않음)

- contracts 가 `LAB_EVENT_SINK = 'LAB_EVENT_SINK'`(문자열 DI 토큰)와 `EventSink { enabled; emit(phase, fields?: {entity?, attrs?, durMs?, injected?, sql?, rows?, note?}) }`, `NOOP_EVENT_SINK` 를 내보냅니다.
- G02/G01 `StrategyContext.events: EventSink` 입니다. 컨트롤러는 `@Optional() @Inject(LAB_EVENT_SINK)` 로 받고, 없으면 NOOP 을 씁니다.
- 요청 정보(actor/reqId/sampled/traceId)는 sink 가 AsyncLocalStorage 에서 읽습니다.

### C10. G01 HTTP 계약 (id `g01-shared-document` 가정, D5)

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| GET | `/g01/documents/:id` | – | `{id, version, fields:{a:string[],b:string[],c:string[],d:string[]}, fieldVersions:{a..d}, editCount, lease:{lockedBy, leaseUntil, fence}|null}` |
| PUT | `/g01/documents/:id` | `{version, fields, editToken, lease?:{holder, fence}}` | `200 {version}` · `409 {reason:'version_mismatch', currentVersion, current}` · `409 {reason:'lease_lost'|'lease_expired'}` · `428 {reason:'version_required'}` |
| PATCH | `/g01/documents/:id` | `{version, field, value, editToken}`(field-merge) | `200` · `409` |
| POST | `/g01/documents/:id/lease` | `{holder}` | `200 {fence, leaseUntil}` · `423 {reason:'locked', lockedBy}` + `Retry-After` |
| DELETE | `/g01/documents/:id/lease` | `{holder, fence}` | `204` |

- **편집 모델**: 클라이언트가 읽은 필드 배열 뒤에 자기 `editToken`(12자)을 붙여 저장합니다.
- **불변식**
  - `no_lost_update`: 원장 success 토큰 중 최종 문서 필드에 없는 수 = 0
  - `edit_count_matches_ledger`
  - `revision_matches_ledger`: `g01_document_revision` 행 수 = 원장 success 행 수
  - `no_duplicate_request_id`
  - info `ledger_counts`
- **blind-retry**: 서버 구현은 optimistic-version 과 같고, 클라이언트(k6) 동작만 다릅니다.

---


## 확정 결정 D1–D13

2026-10-07 아래 표의 「권장」 열로 확정했다.

| # | 항목 | 결정 |
|---|---|---|
| D1 | Docker 메모리는 7.65GiB 인데 §4.1 limit 합계는 약 9.1GiB(활성 app 2대 기준 약 8.6GiB)입니다. | (a) Docker Desktop 을 10GB 이상으로 올리는 것이 1순위(DESIGN 권장치)입니다. (b) 그래도 프로필은 나눕니다: 기본 = app·nginx·pg·redis·k6·orchestrator·socket-proxy·web, `obs` = prometheus·grafana·exporter 3·cadvisor, `trace` = tempo·loki·alloy. 메타데이터 `stack.profiles` 를 비교 조건에 넣습니다. |
| D2 | 오케스트레이터가 git sha/dirty 와 팩 정의를 읽으려면 레포를 **읽기 전용 마운트**해야 합니다. §13 의 "그 밖의 컨테이너에는 호스트 경로 마운트 없음"과 충돌합니다. | 레포 ro 마운트(`/repo:ro`) + 이미지에 git 설치, 그리고 §13 문구 수정(T-143). 대안은 이미지에 굽고 `GIT_SHA` 를 빌드 인자로 넘기는 것인데, 이 경우 plain `docker compose up` 에서는 sha 가 unknown 이 됩니다. |
| D3 | 템플릿 DB 준비는 지금 컨테이너 생성(`compose run`)으로 합니다. | app `task: prepare-template` 모드(C1)로 바꿉니다. run.mjs 경로는 그대로 둡니다. |
| D4 | T-101 에 네트워크 설치가 필요합니다. 구현자 worktree 에서는 금지입니다. | 사용자 승인 후 메인 트리에서 오케스트레이터가 `pnpm install` 을 실행합니다. 대상 패키지: prom-client, @opentelemetry/{api, sdk-node, sdk-trace-node, exporter-trace-otlp-proto, instrumentation-http, -express, -nestjs-core, -pg, -ioredis, resources, semantic-conventions}, ioredis, pg, ws, @types/pg, @types/ws. 네이티브 빌드가 필요 없도록 SQLite 는 `node:sqlite` 를 씁니다(Node 24 에서 ExperimentalWarning 이 나오는 점은 감수). |
| D5 | G01 id 가 `g01-shared-document`(web·§10.3.2)와 `g01-concurrent-edit`(§5.1) 둘입니다. | `g01-shared-document`(바꿀 곳이 적습니다). DESIGN §5.1 은 T-143 에서 고칩니다. |
| D6 | 완료 기준 3번(app-memory-lock 1대/2대를 한 비교 화면에)과 4번(조건이 다르면 "비교 불가")이 충돌합니다. | `axis` 를 명시하면 그 차이만 "비교 축"으로 표시합니다(C2). |
| D7 | 게이트 범위 | T-101 에서 루트 `typecheck`/`test` 가 app·orchestrator·contracts·팩 단위 테스트·loadtest·k6 실행기·web vitest 를 다 덮게 합니다. PG·Redis 통합 테스트는 도커가 없으면 skip 합니다. web vitest 를 넣으면 게이트가 느려지는데, 이를 받아들일지 정해 주세요. |
| D8 | 완료 기준 2번은 closed 모델에서 no-lock 이 위반하는 것인데, 지연 주입 없이 재현될지 불확실합니다(0단계 open 200rps 에서도 1/3). | 상품 수를 적게, think 0, vus 50 으로 먼저 시도합니다. 실패하면 `after-read:30` 주입을 허용하되 "주입됨"으로 표시합니다. 허용 여부를 정해 주세요. |
| D9 | cpuset(vCPU 14개로 가능)을 켜면 0단계 결과와는 조건이 달라집니다. cAdvisor 가 macOS 에서 컨테이너별 CPU 를 내는지는 미확인입니다(§14 #2·#3). | cpuset 을 켜고 메타데이터에 기록합니다. k6 포화 판정은 cAdvisor 와 무관하게 실행기가 직접 읽는 cgroup 값으로 합니다(C7). |
| D10 | socket-proxy 이미지(tecnativa `ALLOW_START/STOP/RESTARTS` 와 wollomatic 정규식 allowlist 중 선택) | T-115 AC 로 고정합니다: 컨테이너 create 는 403, kill/restart 는 허용. |
| D11 | 이미 있는 `pgdata` 볼륨에는 새 init 스크립트(`lab_observer`, exporter 역할)가 돌지 않습니다. | 오케스트레이터가 시작할 때 역할을 멱등으로 보장합니다(T-108). |
| D12 | 단일 머신의 한계: k6·SUT·관측 스택이 같은 VM 을 쓰고, Apple P/E 코어 편차가 있으며, PG 프로브와 `pg_locks` 가 관측자 효과를 낼 수 있습니다. | 결과는 상대 비교로만 말하고, 프로필·계측 수준이 다르면 비교 불가로 표시합니다. 이벤트는 판정에 쓰지 않습니다. 화면에서는 "실측"과 "시뮬레이션(무대)" 배지를 분리합니다. |
| D13 | `learn.yaml measured` 를 오케스트레이터가 직접 쓰려면 레포 쓰기 마운트가 필요합니다. | 오케스트레이터는 `/learn/:scenario/measured` 로 덧씌울 값만 제공합니다. 파일 기록은 호스트에서 `scripts/measured.mjs` 로 합니다(T-142). §5.4 문구 수정이 필요합니다. |

---

