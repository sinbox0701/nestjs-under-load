# compose 스택

공용 네트워크·서버에 띄우지 말 것. 로컬 전용이다(호스트 포트는 전부 127.0.0.1 바인딩).

```
docker compose -f infra/compose/docker-compose.yml up -d --build                       # 기본
docker compose -f infra/compose/docker-compose.yml --profile obs up -d                 # + 관측
docker compose -f infra/compose/docker-compose.yml --profile obs --profile trace up -d # + 추적·로그
node infra/compose/check-config.mjs                                                    # 포트·망·소켓 마운트 정적 검사
```

## 프로필별 limit 합계(Docker Desktop 메모리 약 10.7GiB 기준, 상한값 합)

| 프로필 | 서비스 | cpus | mem |
|---|---|---|---|
| 기본 | app×3(활성 2 기본), nginx, postgres, redis, k6, orchestrator, socket-proxy, web | 8.45 (활성 app 2대면 7.45) | 5.78GiB (활성 2대면 5.28GiB) |
| obs | prometheus, grafana, postgres/redis/nginx exporter, cadvisor | 2.75 | 2.06GiB |
| trace | tempo, loki, alloy | 1.25 | 1.25GiB |
| 기본+obs | | 11.2 | 7.84GiB |
| 전부 | | 12.45 | 9.09GiB |

프로필이 다르면 결과를 비교하지 않는다(메타데이터 `stack.profiles`).

## cpuset(D9)

기본값은 vCPU 14개 기준이다: k6 `0-1` · app+nginx `2-5` · postgres+redis `6-8` · 관측 `9-11` · 제어 `12-13`. `.env` 의 `CPUSET_*` 로 바꾸고, 비우면 cpuset 없음이다.

## 망

lab-net·obs-net·sock-net 은 `internal: true`. ctl-net 에는 호스트 포트를 여는 web(8080)·orchestrator(4000)·nginx(8081)·grafana(3001)·postgres(55432)만 붙는다.
docker.sock 은 socket-proxy·alloy·cadvisor 만 마운트한다. socket-proxy 는 컨테이너 조회와 start/stop/restart/kill 만 통과시키고 create·exec·이미지 API 는 403 이다.
