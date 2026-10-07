#!/bin/sh
# 최초 initdb 때 한 번 실행된다(docker-entrypoint-initdb.d).
# - lab_app: 실험 대상 app이 쓰는 비superuser 역할(DB 생성 권한 없음). 실행 DB(lab_run)·템플릿 DB의 소유자가 된다.
#   연결 상한은 실행 중 `ALTER ROLE lab_app CONNECTION LIMIT n`으로 바꿔 볼 수 있다(새 연결부터 적용, DESIGN §14 #15).
# - lab_observer: 오케스트레이터 PG 관측 프로브 전용(풀 밖 커넥션 1개, DESIGN §4.2). pg_monitor 만 가진다.
# - exporter: postgres_exporter 전용. pg_monitor 만 가진다.
#   두 역할의 연결은 max_connections 예산에 들어가므로 상한을 둔다(메타데이터 observerConnections).
# - pg_stat_statements 확장은 postgres DB에 만든다(reset은 run.mjs가 superuser로 호출).
# 이미 있는 pgdata 볼륨에는 이 스크립트가 다시 돌지 않는다. 오케스트레이터가 시작할 때 같은 역할을 멱등으로 보장한다(T-108).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v lab_app_password="${LAB_APP_PASSWORD:-lab_app_local}" \
  -v lab_observer_password="${LAB_OBSERVER_PASSWORD:-lab_observer_local}" \
  -v exporter_password="${EXPORTER_PASSWORD:-exporter_local}" <<'SQL'
CREATE ROLE lab_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'lab_app_password';
CREATE ROLE lab_observer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 2 PASSWORD :'lab_observer_password';
GRANT pg_monitor TO lab_observer;
CREATE ROLE exporter LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 3 PASSWORD :'exporter_password';
GRANT pg_monitor TO exporter;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SQL
