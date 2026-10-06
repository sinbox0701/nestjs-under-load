// 하네스 테스트: run.mjs 인자 파싱·계획·메타데이터 생성, invariants.sql 문법(PG17 파서).
// 실행: pnpm test  (node --test "scripts/*.test.mjs")
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parse as parseSql } from 'libpg-query';

import {
  DEFAULTS,
  REPO_ROOT,
  buildMetadata,
  buildPlan,
  buildRunConfig,
  compareLedgerWithClient,
  computeSeedHash,
  defaultStrategyParams,
  durationToSeconds,
  extractComposeFacts,
  judgeInvariants,
  judgeValidity,
  k6CpuUsage,
  k6Env,
  loadManifest,
  makeBatchId,
  makeRunId,
  parseCliArgs,
  parseCpuMax,
  parseCpuStat,
  parseCsvRow,
  parseInvariantsSql,
  runSession,
  stamp,
  summarizeK6,
  templateDbName,
  warmupDiscardSql,
} from './run.mjs';

const { dir: G02_DIR, manifest: G02 } = loadManifest('g02-stock-decrement');

describe('parseCliArgs', () => {
  it('인자가 없으면 기본값', () => {
    const o = parseCliArgs([]);
    assert.equal(o.scenario, 'g02-stock-decrement');
    assert.equal(o.reps, 3);
    assert.deepEqual(o.instances, [2]);
    assert.equal(o.memoryLockSingle, true);
    assert.equal(o.dryRun, false);
    assert.equal(o.strategies, null);
  });

  it('옵션을 반영한다', () => {
    const o = parseCliArgs([
      '--strategies', 'row-lock,no-lock,row-lock',
      '--instances', '1,2',
      '--reps', '5',
      '--rate', '250',
      '--duration', '1m',
      '--warmup', '0s',
      '--inject-delay', 'after-read:50',
      '--inject-delay', 'after-lock:5',
      '--no-memory-lock-single',
      '--dry-run',
    ]);
    assert.deepEqual(o.strategies, ['row-lock', 'no-lock']);
    assert.deepEqual(o.instances, [1, 2]);
    assert.equal(o.reps, 5);
    assert.equal(o.rate, 250);
    assert.equal(o.duration, '1m');
    assert.equal(o.warmup, '0s');
    assert.deepEqual(o.injectDelay, [{ point: 'after-read', ms: 50 }, { point: 'after-lock', ms: 5 }]);
    assert.equal(o.memoryLockSingle, false);
    assert.equal(o.dryRun, true);
  });

  it('--help', () => {
    assert.deepEqual(parseCliArgs(['-h']), { help: true });
  });

  it('잘못된 값은 거부한다', () => {
    assert.throws(() => parseCliArgs(['--reps', '0']), /--reps/);
    assert.throws(() => parseCliArgs(['--rate', 'abc']), /--rate/);
    assert.throws(() => parseCliArgs(['--instances', '4']), /--instances/);
    assert.throws(() => parseCliArgs(['--duration', '30']), /--duration/);
    assert.throws(() => parseCliArgs(['--duration', '0s']), /--duration/);
    assert.throws(() => parseCliArgs(['--inject-delay', 'after-read']), /--inject-delay/);
    assert.throws(() => parseCliArgs(['--scenario', 'g99-nope']), /--scenario/);
    assert.throws(() => parseCliArgs(['--pre-vus', '100', '--max-vus', '10']), /--max-vus/);
    assert.throws(() => parseCliArgs(['--instrumentation', 'loud']), /--instrumentation/);
    assert.throws(() => parseCliArgs(['--bogus']), /Unknown option/);
    assert.throws(() => parseCliArgs(['extra']), /알 수 없는 인자/);
  });

  it('기본값 객체는 변경되지 않는다', () => {
    parseCliArgs(['--inject-delay', 'after-read:1']);
    assert.deepEqual(DEFAULTS.injectDelay, []);
  });
});

describe('buildPlan', () => {
  it('기본: 4 strategy × 앱 2대 × 3회 + app-memory-lock 앱 1대 × 3회', () => {
    const plan = buildPlan(parseCliArgs([]), G02);
    assert.equal(plan.length, 15);
    const memSingle = plan.filter((p) => p.strategy === 'app-memory-lock' && p.appInstances === 1);
    assert.deepEqual(memSingle.map((p) => p.repetition), [1, 2, 3]);
    assert.deepEqual(new Set(plan.map((p) => p.strategy)), new Set(['no-lock', 'app-memory-lock', 'row-lock', 'conditional-update']));
  });

  it('같은 케이스의 반복은 연속으로 배치된다', () => {
    const plan = buildPlan(parseCliArgs(['--strategies', 'row-lock', '--reps', '2']), G02);
    assert.deepEqual(plan, [
      { strategy: 'row-lock', appInstances: 2, repetition: 1 },
      { strategy: 'row-lock', appInstances: 2, repetition: 2 },
    ]);
  });

  it('--instances에 1이 있으면 메모리 락 대조 케이스를 중복 추가하지 않는다', () => {
    const plan = buildPlan(parseCliArgs(['--strategies', 'app-memory-lock', '--instances', '1,2', '--reps', '1']), G02);
    assert.deepEqual(plan.map((p) => p.appInstances), [1, 2]);
  });

  it('manifest에 없는 strategy는 거부', () => {
    assert.throws(() => buildPlan(parseCliArgs(['--strategies', 'redis-lock']), G02), /manifest에 없는 strategy/);
  });
});

describe('id·해시·RunConfig', () => {
  it('runId 형식', () => {
    const s = stamp(new Date('2026-10-07T01:02:03.456Z'));
    assert.equal(s, '2026-10-07T01-02-03Z');
    const batch = makeBatchId(s, 'g02-stock-decrement', 'row-lock', 2);
    assert.equal(makeRunId(batch, 3), '2026-10-07T01-02-03Z_g02_row-lock_i2_r3');
  });

  it('템플릿 DB 이름은 시드 옵션이 같으면 같고 다르면 다르다', () => {
    const a = computeSeedHash('g02-stock-decrement', { products: 5 }, 'sha256:x');
    const b = computeSeedHash('g02-stock-decrement', { products: 5 }, 'sha256:x');
    const c = computeSeedHash('g02-stock-decrement', { products: 6 }, 'sha256:x');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(templateDbName('g02-stock-decrement', a), /^tpl_g02_[0-9a-f]{12}$/);
  });

  it('strategy 파라미터는 manifest default에서 온다', () => {
    assert.deepEqual(defaultStrategyParams(G02, 'row-lock'), { lockTimeoutMs: 1000 });
    assert.deepEqual(defaultStrategyParams(G02, 'no-lock'), {});
  });

  it('RunConfig는 app의 runConfigSchema 필드를 채운다', () => {
    const opts = parseCliArgs(['--inject-delay', 'after-read:50']);
    const rc = buildRunConfig({ runId: 'r', batchId: 'b', repetition: 1, scenario: 'g02-stock-decrement', strategy: 'row-lock', strategyParams: { lockTimeoutMs: 1000 }, opts });
    assert.deepEqual(Object.keys(rc).sort(), ['batchId', 'injectDelay', 'instrumentation', 'pool', 'repetition', 'runId', 'scenario', 'strategy', 'strategyParams'].sort());
    assert.deepEqual(rc.injectDelay, [{ point: 'after-read', ms: 50 }]);
  });

  it('웜업은 웜업 전용 상품 범위만 친다', () => {
    const opts = parseCliArgs(['--products', '3', '--warmup-products', '2']);
    assert.equal(k6Env(opts, 'warmup', null).PRODUCT_MIN, '4');
    assert.equal(k6Env(opts, 'warmup', null).PRODUCT_MAX, '5');
    assert.equal(k6Env(opts, 'main', '/runs/x/summary.json').PRODUCT_MAX, '3');
    assert.equal(k6Env(opts, 'main', '/runs/x/summary.json').SUMMARY_PATH, '/runs/x/summary.json');
    assert.equal(k6Env(opts, 'warmup', null).SUMMARY_PATH, undefined);
  });

  it('k6 파라미터 키는 params.schema.json과 일치한다', () => {
    const schema = JSON.parse(readFileSync(path.join(G02_DIR, 'k6/params.schema.json'), 'utf8'));
    for (const k of Object.keys(k6Env(parseCliArgs([]), 'main', '/x'))) {
      assert.ok(k in schema.properties, `${k} 가 params.schema.json에 없음`);
    }
  });

  it('durationToSeconds', () => {
    assert.equal(durationToSeconds('10s'), 10);
    assert.equal(durationToSeconds('2m'), 120);
    assert.equal(durationToSeconds('500ms'), 0.5);
  });
});

describe('메타데이터', () => {
  const opts = parseCliArgs(['--inject-delay', 'after-read:50']);
  const md = buildMetadata({
    runId: 'r1', batchId: 'b1', sessionId: 's1', repetition: 1, scenario: 'g02-stock-decrement',
    strategy: 'row-lock', strategyParams: { lockTimeoutMs: 1000 }, appInstances: 2, opts,
    pgConf: { max_connections: '100', shared_buffers: '512MB' }, pgConfHash: 'sha256:abc',
    composeFacts: extractComposeFacts({ services: { app: { image: 'a:1', cpus: 1, mem_limit: '536870912' }, k6: { image: 'k6:1', cpus: 2 } } }),
  });

  it('DESIGN §7.3 필드를 모두 가진다', () => {
    for (const k of ['runId', 'batchId', 'repetition', 'scenario', 'strategy', 'git', 'images', 'profile', 'host', 'limits', 'topology', 'pool', 'postgres', 'timeouts', 'redis', 'data', 'load', 'k6Script', 'instrumentation', 'pgProbe', 'interventions', 'chaos', 'coldStart', 'osCacheControlled', 'validity', 'invariants', 'artifacts', 'startedAt', 'endedAt']) {
      assert.ok(k in md, `metadata.${k} 없음`);
    }
  });

  it('값이 조건을 반영한다', () => {
    assert.equal(md.profile, 'minimal');
    assert.deepEqual(md.strategy, { id: 'row-lock', params: { lockTimeoutMs: 1000 } });
    assert.equal(md.topology.appInstances, 2);
    assert.equal(md.load.model, 'open');
    assert.equal(md.load.executor, 'constant-arrival-rate');
    assert.equal(md.timeouts.lockMs, 1000);
    assert.equal(md.timeouts.k6RequestMs, 10000);
    assert.equal(md.postgres.maxConnections, 100);
    assert.deepEqual(md.interventions, [{ type: 'inject-delay', point: 'after-read', ms: 50 }]);
    assert.equal(md.limits.app.cpuset, 'none');
    assert.equal(md.images.k6, 'k6:1');
    assert.equal(md.artifacts.k6Summary, 'runs/r1/summary.json');
  });

  it('유효성: maxVUs 부족 + dropped면 무효', () => {
    const o = parseCliArgs(['--rate', '100', '--max-vus', '50', '--pre-vus', '10']);
    const v = judgeValidity(o, { droppedIterations: 3, httpReqs: 10 });
    assert.equal(v.valid, false);
    assert.equal(v.droppedCountedAsFailure, false);
    assert.equal(judgeValidity(parseCliArgs(['--max-vus', '1000']), { droppedIterations: 3, httpReqs: 10 }).valid, true);
  });

  it('k6 CPU: cgroup cpu.stat 전후 차이로 평균 사용률·스로틀 비율, 포화면 무효', () => {
    const before = parseCpuStat('usage_usec 1000000\nuser_usec 1\nsystem_usec 1\nnr_periods 100\nnr_throttled 0\nthrottled_usec 0\n');
    const after = parseCpuStat('usage_usec 11000000\nnr_periods 200\nnr_throttled 5\nthrottled_usec 9\n');
    assert.equal(parseCpuMax('200000 100000'), 2);
    assert.equal(parseCpuMax('max 100000'), null);
    assert.equal(parseCpuStat(''), null);
    const low = k6CpuUsage(before, after, 20_000, 2); // 10 CPU초 / 20초 / 2코어
    assert.equal(low.avgRatio, 0.25);
    assert.equal(low.throttledPeriodRatio, 0.05);
    const o = parseCliArgs(['--max-vus', '1000']);
    const ok = judgeValidity(o, { droppedIterations: 0, httpReqs: 10 }, low);
    assert.equal(ok.valid, true);
    assert.equal(ok.k6CpuAvgRatio, 0.25);
    const hot = k6CpuUsage(before, after, 6_000, 2); // 10/6/2 ≈ 0.833
    const bad = judgeValidity(o, { droppedIterations: 0, httpReqs: 10 }, hot);
    assert.equal(bad.valid, false);
    assert.match(bad.reasons[0], /k6 CPU 포화/);
    assert.equal(judgeValidity(o, { droppedIterations: 0, httpReqs: 10 }).checks.k6Cpu, 'not-measured');
  });
});

describe('k6·불변식 결과 해석', () => {
  it('summarizeK6', () => {
    const s = summarizeK6({
      metrics: {
        http_reqs: { values: { count: 100, rate: 10 } },
        dropped_iterations: { values: { count: 2 } },
        g02_orders_success: { values: { count: 60 } },
        g02_orders_sold_out: { values: { count: 38 } },
        'http_req_duration{phase:main}': { values: { med: 5, 'p(95)': 9, 'p(99)': 12, max: 30, count: 100 } },
      },
    });
    assert.equal(s.httpReqs, 100);
    assert.equal(s.droppedIterations, 2);
    assert.equal(s.success, 60);
    assert.equal(s.failed, 0);
    assert.deepEqual(s.latencyMs, { n: 100, p50: 5, p95: 9, p99: 12, max: 30 });
  });

  it('parseCsvRow', () => {
    assert.deepEqual(parseCsvRow('violations\n0\n'), { violations: 0 });
    assert.deepEqual(parseCsvRow('success,sold_out,total\n3,4,7\n'), { success: 3, sold_out: 4, total: 7 });
    assert.equal(parseCsvRow(''), null);
  });

  it('judgeInvariants: 위반 수 판정, info는 값만', () => {
    const r = judgeInvariants(G02, {
      no_negative_stock: { violations: 0 },
      sold_equals_decrement: { violations: 2 },
      no_oversell: null,
      ledger_counts: { success: 1, sold_out: 0, total: 1 },
    });
    const byId = Object.fromEntries(r.map((x) => [x.id, x]));
    assert.equal(byId['no-negative-stock'].passed, true);
    assert.equal(byId['sold-equals-decrement'].passed, false);
    assert.equal(byId['no-oversell'].passed, false); // 결과 없음 = 통과로 치지 않음
    assert.deepEqual(byId['ledger-matches-k6'].value, { success: 1, sold_out: 0, total: 1 });
  });

  it('원장 vs k6 대조', () => {
    const c = compareLedgerWithClient({ success: 10, sold_out: 5 }, { success: 9, soldOut: 5, failed: 1, droppedIterations: 0 });
    assert.equal(c.diff.success, 1);
    assert.match(c.note, /클라이언트 타임아웃/);
    assert.equal(compareLedgerWithClient(null, {}), null);
  });
});

describe('invariants.sql', () => {
  const text = readFileSync(path.join(G02_DIR, 'invariants.sql'), 'utf8');
  const sections = parseInvariantsSql(text);

  it('manifest invariants가 가리키는 구간이 모두 있다', () => {
    const names = sections.map((s) => s.name);
    for (const inv of G02.invariants) {
      const [file, name] = inv.sql.split('#');
      assert.equal(file, 'invariants.sql');
      assert.ok(names.includes(name), `invariants.sql#${name} 없음`);
    }
  });

  for (const s of parseInvariantsSql(readFileSync(path.join(REPO_ROOT, 'packs/generic/g02-stock-decrement/invariants.sql'), 'utf8'))) {
    it(`PG17 파서로 파싱된다: ${s.name}`, async () => {
      const ast = await parseSql(s.sql);
      assert.equal(ast.stmts.length, 1, '구간 하나 = 문장 하나');
      assert.ok(ast.stmts[0].stmt.SelectStmt, 'SELECT여야 한다(판정 쿼리는 읽기 전용)');
    });
  }

  it('파서 규약 오류를 잡는다', () => {
    assert.throws(() => parseInvariantsSql('-- name: a\nselect 1;\n-- name: a\nselect 2;'), /중복/);
    assert.throws(() => parseInvariantsSql('-- name: a\n-- 주석만\n'), /비어/);
  });
});

describe('팩 구조(폴더 규약)', () => {
  it('manifest strategy마다 strategy 파일이 있고 구현돼 있다', () => {
    const files = readdirSync(path.join(G02_DIR, 'strategies'));
    for (const s of G02.strategies) {
      const f = `${s.id}.strategy.ts`;
      assert.ok(files.includes(f), `strategies/${f} 없음`);
      const src = readFileSync(path.join(G02_DIR, 'strategies', f), 'utf8');
      assert.match(src, /readonly id = '([a-z-]+)'/);
      assert.equal(/readonly id = '([a-z-]+)'/.exec(src)[1], s.id);
      assert.ok(!src.includes('TODO: 직접 구현'), `${f}: 구현이 비어 있다(TODO 남음)`);
    }
  });

  it('strategy-registry의 id가 manifest와 같다', () => {
    const src = readFileSync(path.join(G02_DIR, 'strategy-registry.ts'), 'utf8');
    const ids = [...src.matchAll(/^\s+'([a-z-]+)': \{/gm)].map((m) => m[1]);
    assert.deepEqual(ids.sort(), G02.strategies.map((s) => s.id).sort());
  });

  it('k6 템플릿·params 스키마가 manifest 경로에 있다', () => {
    assert.ok(existsSync(path.join(G02_DIR, G02.k6.template)));
    assert.ok(existsSync(path.join(G02_DIR, G02.k6.paramsSchema)));
  });
});

describe('웜업 흔적 제거', () => {
  it('G02 discardSql: 본 실행 상품 범위 밖(웜업 상품)의 원장·상품만 지우고, PG17 파서로 파싱된다', async () => {
    const sql = warmupDiscardSql(G02, parseCliArgs(['--products', '7']));
    assert.match(sql, /delete from g02_order_ledger where product_id > 7;/);
    assert.match(sql, /delete from g02_product where id > 7;/);
    assert.doesNotMatch(sql, /\{\{/);
    await parseSql(sql);
    assert.equal(warmupDiscardSql({ load: {} }, parseCliArgs([])), null);
  });
});

describe('dry-run', () => {
  it('docker 없이 전 단계를 출력하고 파일을 쓰지 않는다', async () => {
    const lines = [];
    const before = existsSync(path.join(REPO_ROOT, 'runs')) ? readdirSync(path.join(REPO_ROOT, 'runs')).length : 0;
    const res = await runSession(parseCliArgs(['--dry-run', '--strategies', 'row-lock', '--reps', '2']), { log: (l) => lines.push(l) });
    const out = lines.join('\n');
    assert.equal(res.runs.length, 2);
    for (const marker of ['템플릿 DB 확인', '실행 DB 리셋', 'RunConfig 기록', 'readiness', 'k6 웜업', 'k6 본 실행', '불변식 검사', '메타데이터 저장']) {
      assert.ok(out.includes(marker), `단계 '${marker}' 출력 없음`);
    }
    assert.ok(out.includes('drop database if exists lab_run with (force)'));
    // 웜업 흔적 제거가 웜업 뒤·본 실행 앞
    assert.ok(out.indexOf('웜업 흔적 제거') > out.indexOf('k6 웜업'));
    assert.ok(out.indexOf('웜업 흔적 제거') < out.indexOf('k6 본 실행'));
    // 빌드 직후 기존 app 컨테이너 제거(새 이미지 반영)가 첫 app 기동보다 먼저
    assert.ok(out.indexOf('rm --stop --force app') > out.indexOf('build app'));
    assert.ok(out.indexOf('rm --stop --force app') < out.indexOf('--scale app='));
    assert.ok(out.includes('constant-arrival-rate') || out.includes('PHASE=main'));
    const after = existsSync(path.join(REPO_ROOT, 'runs')) ? readdirSync(path.join(REPO_ROOT, 'runs')).length : 0;
    assert.equal(after, before);
  });
});
