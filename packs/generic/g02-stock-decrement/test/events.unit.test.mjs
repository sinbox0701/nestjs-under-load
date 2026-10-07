// 컨트롤러가 LAB_EVENT_SINK 없이 만들어져도 NOOP_EVENT_SINK 를 strategy 에 넘기는지 확인한다(DB 불필요).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import './helpers.mjs';

const require = createRequire(import.meta.url);
const { G02Controller } = require('../dist/api/g02.controller.js');
const { NOOP_EVENT_SINK } = require('@under-load/contracts');

function makeController(events) {
  let seen;
  const strategy = {
    id: 'fake',
    async execute(_cmd, ctx) {
      seen = ctx;
      return 'success';
    },
  };
  const em = { fork: () => ({}) };
  const runtime = { instance: 'app-1', contentionWindow: async () => {} };
  const controller = new G02Controller(em, strategy, {}, runtime, events);
  return { controller, ctx: () => seen };
}

const res = { status() {} };

test('LAB_EVENT_SINK 가 없으면 NOOP_EVENT_SINK 를 넘긴다', async () => {
  const { controller, ctx } = makeController(undefined);
  await controller.createOrder(randomUUID(), { productId: 1, qty: 1 }, res);
  assert.equal(ctx().events, NOOP_EVENT_SINK);
});

test('주입된 sink 가 있으면 그대로 넘긴다', async () => {
  const fake = { enabled: true, emit() {} };
  const { controller, ctx } = makeController(fake);
  await controller.createOrder(randomUUID(), { productId: 1, qty: 1 }, res);
  assert.equal(ctx().events, fake);
});
