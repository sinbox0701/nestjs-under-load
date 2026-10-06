/* eslint-disable @typescript-eslint/no-require-imports */
// reflect-metadata는 데코레이터 메타데이터보다 먼저 로드돼야 한다. 정적 import는 호이스팅되므로
// CJS require로 순서를 고정한다(DESIGN §5.1 main.ts). OTel tracing은 1단계에서 이 다음 줄에 붙인다.
require('reflect-metadata');

import('./bootstrap.js')
  .then((m) => m.bootstrap())
  .catch((err: unknown) => {
    console.error('[bootstrap] failed:', err);
    process.exit(1);
  });
