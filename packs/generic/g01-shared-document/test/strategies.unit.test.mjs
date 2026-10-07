// 도커 없이 도는 단위 테스트: 레지스트리, 타입 강제(AC-2), 학습·계측 마커.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { G01_STRATEGIES, resolveStrategy } from './helpers.mjs';

const require = createRequire(import.meta.url);
const PACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { OptimisticVersionStrategy } = require('../dist/strategies/optimistic-version.strategy.js');

describe('G01 strategy-registry', () => {
  it('1단계 A 묶음 3개를 등록한다', () => {
    assert.deepEqual(Object.keys(G01_STRATEGIES), ['naive-overwrite', 'optimistic-version', 'blind-retry']);
    for (const id of Object.keys(G01_STRATEGIES)) {
      const { cls } = resolveStrategy(id, undefined);
      assert.equal(new cls().id, id);
    }
  });

  it('blind-retry 서버 구현은 optimistic-version과 같다(id만 다름)', () => {
    const { cls } = resolveStrategy('blind-retry', {});
    const s = new cls();
    assert.ok(s instanceof OptimisticVersionStrategy);
    assert.equal(s.save, OptimisticVersionStrategy.prototype.save);
  });

  it('모르는 id·받지 않는 파라미터는 부팅 실패', () => {
    assert.throws(() => resolveStrategy('row-lock', undefined), /알 수 없는 strategy/);
    assert.throws(() => resolveStrategy('toString', undefined), /알 수 없는 strategy/);
    assert.throws(() => resolveStrategy('naive-overwrite', { ttlMs: 10 }), /파라미터를 받지 않습니다/);
    assert.deepEqual(resolveStrategy('naive-overwrite', {}).params, {});
  });
});

// AC-2: 검사할 코드는 디스크에 두지 않고 메모리 파일로 넘긴다(test/ 안의 .ts는 node --test 가 테스트로 실행하므로).
// SaveCommand.version 은 number 만 받는다. 문자열 '3'을 숫자로 바꾸고 누락을 428로 거절하는 일은 호출 측(컨트롤러) 몫이다.
const VERSION_TYPE_CHECK = `
import { OptimisticVersionStrategy } from '../strategies/optimistic-version.strategy';
import type { SaveCommand, StrategyContext } from '../support/strategy.types';

declare const ctx: StrategyContext;
const base = { requestId: 'r', documentId: 1, fields: { a: [], b: [], c: [], d: [] }, editToken: 'abcdefghijkl' };

const ok: SaveCommand = { ...base, version: 3 };
void new OptimisticVersionStrategy().save(ok, ctx);

// @ts-expect-error 문자열 version은 strategy에 넘길 수 없다
const fromBody: SaveCommand = { ...base, version: '3' };
void fromBody;

// @ts-expect-error version 누락도 타입에서 막힌다
const missing: SaveCommand = { ...base };
void missing;
`;

/** 메모리 파일 하나를 팩 tsconfig 로 타입 검사해 진단 메시지를 돌려준다. */
function typeDiagnostics(source) {
  const ts = require('typescript');
  const config = ts.getParsedCommandLineOfConfigFile(path.join(PACK_DIR, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  const virtual = path.join(PACK_DIR, 'test', '__version-type.check.ts');
  const host = ts.createCompilerHost(config.options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (f, lang, ...rest) => (path.resolve(f) === virtual ? ts.createSourceFile(f, source, lang) : getSourceFile(f, lang, ...rest));
  host.fileExists = (f) => path.resolve(f) === virtual || fileExists(f);
  const program = ts.createProgram([virtual], { ...config.options, noEmit: true }, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('AC-2 version 타입', () => {
  it('SaveCommand.version은 number만 — 문자열·누락은 컴파일 오류(@ts-expect-error가 모두 소비됨)', () => {
    // 쓰이지 않은 @ts-expect-error 가 있으면 "Unused '@ts-expect-error' directive" 가 나온다.
    assert.deepEqual(typeDiagnostics(VERSION_TYPE_CHECK), []);
  });

  it('검사기가 실제로 잡는지: @ts-expect-error 를 빼면 오류 2개(문자열·누락)', () => {
    const diags = typeDiagnostics(VERSION_TYPE_CHECK.replace(/\/\/ @ts-expect-error.*\n/g, ''));
    assert.equal(diags.length, 2, diags.join('\n'));
    assert.match(diags[0], /'string' is not assignable to type 'number'/);
    assert.match(diags[1], /'version' is missing/);
  });
});

describe('학습·계측 마커', () => {
  const src = (f) => readFileSync(path.join(PACK_DIR, 'strategies', f), 'utf8');

  it('naive: nativeUpdate 줄과 where-id-only 마커', () => {
    const s = src('naive-overwrite.strategy.ts');
    for (const m of ['@learn where-id-only', '@learn native-bypasses-version', '@learn ledger-same-tx', '@event db_write', '@event committed rolled_back']) {
      assert.ok(s.includes(m), m);
    }
  });

  it('optimistic: lockMode·lockVersion·flush 0행·두 실패 지점 마커', () => {
    const s = src('optimistic-version.strategy.ts');
    for (const m of [
      '@learn lock-optimistic',
      '@learn lock-version-strict',
      '@learn flush-where-version',
      '@learn two-failure-points',
      '@event db_read',
      '@event db_write',
      '@event conflict',
      '@event committed rolled_back',
    ]) {
      assert.ok(s.includes(m), m);
    }
  });

  it('committed는 transactional 반환 뒤, rolled_back은 catch에서 낸다', () => {
    for (const f of ['naive-overwrite.strategy.ts', 'optimistic-version.strategy.ts']) {
      const s = src(f);
      const txEnd = s.indexOf('}); // @event committed rolled_back');
      assert.ok(txEnd > 0 && s.indexOf("emit('committed'") > txEnd, `${f}: committed`);
      assert.ok(s.indexOf("emit('rolled_back'") > s.indexOf('} catch (err) {'), `${f}: rolled_back`);
    }
  });
});
