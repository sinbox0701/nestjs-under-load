// 앱 PG 통합 테스트의 접속 대상. APP_TEST_DATABASE_URL 을 줬을 때만 접속한다(기본값 없음 —
// 실행 중인 compose 스택의 55432 에 자동으로 붙지 않는다). CREATE DATABASE 권한이 필요하다.
// 일회용 예:
//   docker run -d --rm --name nul-app-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55497:5432 postgres:17
//   → APP_TEST_DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55497/postgres
export const APP_TEST_PG_ENV = 'APP_TEST_DATABASE_URL';

/** env 가 있으면 접속 URL, 없으면 null(테스트는 접속 시도 없이 skip). */
export function appTestPgUrl(env: NodeJS.ProcessEnv = process.env): URL | null {
  const raw = env[APP_TEST_PG_ENV];
  return raw ? new URL(raw) : null;
}

/** env 가 없을 때의 skip 사유. */
export const APP_TEST_PG_SKIP = `${APP_TEST_PG_ENV} 미지정`;
