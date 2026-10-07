import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { contextFromHeaders, getRequestContext, parseTraceparent, RequestContextModule } from './index';

const TID = '4bf92f3577b34da6a3ce929d0e0e4736';

test('traceparent 플래그 비트로 sampled 를 정한다', () => {
  assert.deepEqual(parseTraceparent(`00-${TID}-00f067aa0ba902b7-01`), { traceId: TID, sampled: true });
  assert.deepEqual(parseTraceparent(`00-${TID}-00f067aa0ba902b7-00`), { traceId: TID, sampled: false });
  assert.deepEqual(parseTraceparent(`00-${TID}-00f067aa0ba902b7-03`), { traceId: TID, sampled: true });
  assert.equal(parseTraceparent('garbage'), null);
  assert.equal(parseTraceparent(`ff-${TID}-00f067aa0ba902b7-01`), null);
  assert.equal(parseTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`), null);
  assert.equal(parseTraceparent(undefined), null);
});

test('헤더가 없으면 actor 는 "-", sampled 는 false, reqId 는 만들어진다', () => {
  const c = contextFromHeaders({});
  assert.equal(c.actor, '-');
  assert.equal(c.sampled, false);
  assert.match(c.reqId, /^r_[0-9a-f]{8}$/);
  assert.equal(c.traceId, undefined);
});

test('Nest 미들웨어: 핸들러(비동기 포함)가 요청 컨텍스트를 본다', async () => {
  @Controller()
  class C {
    @Get('x/y')
    async h(): Promise<unknown> {
      await new Promise((r) => setTimeout(r, 5));
      return getRequestContext();
    }
  }
  @Module({ imports: [RequestContextModule], controllers: [C] })
  class M {}

  const app = await NestFactory.create(M, { logger: false });
  await app.listen(0, '127.0.0.1');
  try {
    const { port } = app.getHttpServer().address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/x/y`, {
      headers: { 'x-lab-actor': '17-3', 'x-request-id': 'r_abc', traceparent: `00-${TID}-00f067aa0ba902b7-01` },
    });
    assert.deepEqual(await res.json(), { actor: '17-3', reqId: 'r_abc', traceId: TID, sampled: true });
    assert.equal(getRequestContext(), undefined);
  } finally {
    await app.close();
  }
});

