// k6 클라이언트 본문 생성 단위 테스트(k6·도커 불필요): 팩 test 스크립트가 tsc 를 먼저 돌리므로 dist 의존 케이스도 skip 없이 돈다
// AC-3: blind-retry 는 409 뒤 fields 를 다시 계산하지 않는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { appendToken, blindRetryBody, buildPatchBody, buildPutBody, makeEditToken } from '../k6/client.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url)); // test/
const K6_DIR = path.join(DIR, '..', 'k6');

const first = { id: 1, version: 3, fields: { a: ['x'], b: [], c: [], d: [] } };
// 첫 시도(v3)와 재시도 사이에 앞사람이 a 에 'y' 를 커밋해 문서가 v4 가 됐다고 하자.
const latest = { id: 1, version: 4, fields: { a: ['x', 'y'], b: [], c: [], d: [] } };

describe('편집 본문', () => {
  it('makeEditToken 은 12자 16진 문자열', () => {
    assert.match(makeEditToken('123e4567-e89b-12d3-a456-426614174000'), /^[0-9a-f]{12}$/);
  });

  it('appendToken 은 원본을 바꾸지 않고 해당 필드 뒤에만 붙인다', () => {
    const out = appendToken(first.fields, 'a', 'T');
    assert.deepEqual(out.a, ['x', 'T']);
    assert.deepEqual(first.fields.a, ['x']);
  });

  it('PUT 본문: version·fields·editToken, lease 는 있을 때만', () => {
    assert.deepEqual(buildPutBody(first, 'b', 'T'), { version: 3, fields: { a: ['x'], b: ['T'], c: [], d: [] }, editToken: 'T' });
    assert.deepEqual(buildPutBody(first, 'b', 'T', { holder: 'h', fence: '7' }).lease, { holder: 'h', fence: '7' });
  });

  it('PATCH 본문: 바뀐 필드 하나만', () => {
    assert.deepEqual(buildPatchBody(first, 'a', 'T'), { version: 3, field: 'a', value: ['x', 'T'], editToken: 'T' });
  });
});

describe('AC-3 blind-retry: 409 뒤 fields 를 재계산하지 않는다', () => {
  const firstBody = buildPutBody(first, 'a', 'T');
  const retry = blindRetryBody(firstBody, latest.version);

  it('version 만 currentVersion 으로 바뀐다', () => {
    assert.equal(retry.version, 4);
    assert.equal(firstBody.version, 3);
  });

  it('fields 는 첫 본문과 같은 객체(재계산 없음)이고 앞사람 토큰 y 가 없다', () => {
    assert.equal(retry.fields, firstBody.fields);
    assert.deepEqual(retry.fields.a, ['x', 'T']);
    assert.ok(!retry.fields.a.includes('y'), '앞사람 수정이 빠진 옛 배열 → 저장하면 y 가 사라진다(lost update)');
    assert.equal(retry.editToken, firstBody.editToken);
  });

  it('대조: 올바른 재시도(optimistic)는 최신 doc 으로 다시 만들어 y 가 남는다', () => {
    const correct = buildPutBody(latest, 'a', 'T');
    assert.deepEqual(correct.fields.a, ['x', 'y', 'T']);
    assert.equal(correct.version, 4);
  });

  it('template.js 에서 blind-retry 경로는 409 와 재시도 사이에 GET 하지 않는다', () => {
    const src = readFileSync(path.join(K6_DIR, 'template.js'), 'utf8');
    const fn = src.slice(src.indexOf('function runBlindRetry'), src.indexOf('// optimistic-version:'));
    assert.ok(fn.includes('blindRetryBody('));
    assert.equal((fn.match(/openDoc\(/g) ?? []).length, 1, 'openDoc 는 첫 GET 한 번뿐');
    assert.ok(!fn.includes('buildPutBody(', fn.indexOf('blindRetryBody(')), '재시도 뒤 buildPutBody 재호출 없음');
  });
});

describe('AC-2 manifest strategies id = registry 키', () => {
  const manifest = parse(readFileSync(path.join(DIR, '..', 'manifest.yaml'), 'utf8'));
  const ids = manifest.strategies.map((s) => s.id);
  const registryFile = path.join(DIR, '..', 'dist', 'strategy-registry.js');

  it('manifest 에는 5개', () => {
    assert.deepEqual(ids, ['naive-overwrite', 'blind-retry', 'optimistic-version', 'field-merge', 'edit-lease']);
  });

  it('G01_STRATEGIES 키와 같다', async () => {
    const { G01_STRATEGIES } = await import(registryFile);
    assert.deepEqual(Object.keys(G01_STRATEGIES).sort(), [...ids].sort());
  });

  it('template.js 의 STRATEGIES 목록도 같다', () => {
    const src = readFileSync(path.join(K6_DIR, 'template.js'), 'utf8');
    const list = [...src.match(/const STRATEGIES = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(list, ids);
  });
});

describe('manifest strategy params = 레지스트리 params', () => {
  const manifest = parse(readFileSync(path.join(DIR, '..', 'manifest.yaml'), 'utf8'));
  const registryFile = path.join(DIR, '..', 'dist', 'strategy-registry.js');

  for (const s of manifest.strategies) {
    const defs = s.params ?? {};
    const defaults = Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, v.default]));

    it(`${s.id}: manifest 기본값이 resolveStrategy 검증을 통과하고 키·값이 레지스트리와 같다`, async () => {
      const { resolveStrategy } = await import(registryFile);
      const resolved = resolveStrategy(s.id, defaults).params;
      assert.deepEqual(Object.keys(resolved).sort(), Object.keys(defs).sort(), '레지스트리 파라미터 키 = manifest 키');
      assert.deepEqual(resolved, defaults, '레지스트리 기본값 = manifest 기본값');
      // 기본값 없이 부팅해도(RunConfig 가 비어 있어도) 같은 값이어야 한다.
      assert.deepEqual(resolveStrategy(s.id, undefined).params, defaults);
    });

    it(`${s.id}: manifest 에 없는 키는 레지스트리가 거절한다(strict)`, async () => {
      const { resolveStrategy } = await import(registryFile);
      assert.throws(() => resolveStrategy(s.id, { ...defaults, bogusKey: 1 }));
    });
  }
});
