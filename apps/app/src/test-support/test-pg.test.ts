// env 가 없으면 접속 대상이 null 이라 통합 테스트가 접속을 시도하지 않는다는 것을 증명한다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { APP_TEST_PG_ENV, appTestPgUrl } from './test-pg';

describe('appTestPgUrl', () => {
  it('env 가 없거나 비어 있으면 null — 기본 포트로 폴백하지 않는다', () => {
    assert.equal(appTestPgUrl({}), null);
    assert.equal(appTestPgUrl({ [APP_TEST_PG_ENV]: '' }), null);
  });

  it('env 가 있으면 그 URL 을 쓴다', () => {
    assert.equal(appTestPgUrl({ [APP_TEST_PG_ENV]: 'postgresql://u:p@127.0.0.1:55497/postgres' })?.port, '55497');
  });
});
