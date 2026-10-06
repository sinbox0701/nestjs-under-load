#!/bin/sh
# 최초 initdb 때 한 번 실행된다(docker-entrypoint-initdb.d).
# - lab_app: 실험 대상 app이 쓰는 비superuser 역할(DB 생성 권한 없음). 실행 DB(lab_run)·템플릿 DB의 소유자가 된다.
#   연결 상한은 실행 중 `ALTER ROLE lab_app CONNECTION LIMIT n`으로 바꿔 볼 수 있다(새 연결부터 적용, DESIGN §14 #15).
# - pg_stat_statements 확장은 postgres DB에 만든다(reset은 run.mjs가 superuser로 호출).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v lab_app_password="${LAB_APP_PASSWORD:-lab_app_local}" <<'SQL'
CREATE ROLE lab_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'lab_app_password';
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SQL
