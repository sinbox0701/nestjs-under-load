/* eslint-disable @typescript-eslint/no-require-imports */
// require 순서: reflect-metadata → tracing → bootstrap. 정적 import 는 호이스팅되므로 CJS require 로 순서를 고정한다
// (DESIGN §5.1 main.ts). OTel 은 http·express·pg 를 불러오기 전에 켜져야 계측이 붙는다(full 일 때만 SDK 로드).
require('reflect-metadata');
const { startTracingFromEnv } = require('./tracing') as typeof import('./tracing');
startTracingFromEnv();

import('./bootstrap.js')
  .then((m) => m.bootstrap())
  .catch((err: unknown) => {
    console.error('[bootstrap] failed:', err);
    process.exit(1);
  });
