// learn.yaml 스키마·정합성 검증(도커 불필요).
// - focus 마커가 실제 소스에 있는지, outcomes가 strategy × situation 전 조합을 덮는지,
//   sql 예시가 MikroORM이 실제로 만드는 문장과 같은 형태인지 확인한다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { parse } from 'yaml';

import { G02_STRATEGIES, PACK_DIR, cmd, createFakeOrm, makeCtx, makeStrategy, normalizeSql } from './helpers.mjs';

const learn = parse(readFileSync(path.join(PACK_DIR, 'learn.yaml'), 'utf8'));
const manifest = parse(readFileSync(path.join(PACK_DIR, 'manifest.yaml'), 'utf8'));
const strategyIds = manifest.strategies.map((s) => s.id);
const situationIds = learn.situations.map((s) => s.id);

const VERDICTS = new Set(['ok', 'broken', 'slow', 'rejects', 'n/a']);
const REQUIRED_CONCEPTS = ['lost-update', 'row-lock', 'rc-recheck', 'conditional-update', 'process-local-lock', 'lock-timeout', 'hot-row'];
const LEARN_RE = /\/\/ @learn ([a-z0-9-]+) — \S/;
const EVENT_RE = /\/\/ @event ([^—]+)/;
const PHASES = new Set([
  'arrived', 'lock_wait', 'lock_acquired', 'lock_timeout', 'lock_released',
  'db_read', 'db_write', 'injected_delay', 'committed', 'rolled_back', 'responded',
]);

/** 파일별 @learn 마커 → 줄 */
function learnMarkers(rel) {
  const lines = readFileSync(path.join(PACK_DIR, rel), 'utf8').split('\n');
  const out = new Map();
  lines.forEach((line, i) => {
    const m = LEARN_RE.exec(line);
    if (m) {
      assert.ok(!out.has(m[1]), `${rel}: @learn ${m[1]} 중복`);
      out.set(m[1], i + 1);
    }
  });
  return out;
}

const strategyFiles = readdirSync(path.join(PACK_DIR, 'strategies'))
  .filter((f) => f.endsWith('.strategy.ts'))
  .map((f) => `strategies/${f}`);

describe('learn.yaml 기본 구조', () => {
  it('scenario·title이 manifest와 맞다', () => {
    assert.equal(learn.scenario, manifest.id);
    assert.ok(typeof learn.title === 'string' && learn.title.length > 0);
  });

  it('concepts: 필수 개념이 모두 있고 id가 유일, body는 3문장 이상', () => {
    const ids = learn.concepts.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of REQUIRED_CONCEPTS) assert.ok(ids.includes(id), `concept ${id} 없음`);
    for (const c of learn.concepts) {
      assert.ok(c.label, `${c.id}: label`);
      const sentences = c.body.split(/(?<=[.다])\s/).filter((s) => s.trim());
      assert.ok(sentences.length >= 3, `${c.id}: body ${sentences.length}문장`);
    }
  });

  it('situations: 5개 이상, id 유일, 인스턴스·부하·chaos가 있다', () => {
    assert.ok(learn.situations.length >= 5);
    assert.equal(new Set(situationIds).size, situationIds.length);
    for (const s of learn.situations) {
      assert.ok(s.label, `${s.id}: label`);
      assert.ok(Number.isInteger(s.instances) && s.instances >= 1, `${s.id}: instances`);
      assert.ok(['open', 'closed'].includes(s.load?.model), `${s.id}: load.model`);
      assert.ok(s.chaos !== undefined, `${s.id}: chaos(none 포함) 필요`);
      if (s.params) for (const k of Object.keys(s.params)) assert.ok(strategyIds.includes(k), `${s.id}: params.${k}`);
    }
  });

  it('필수 상황이 모두 있다(동시 2명·1대 / 200 req/s·2대 / Zipf / DB 지연 / lock_timeout 짧게)', () => {
    const find = (pred) => learn.situations.some(pred);
    assert.ok(find((s) => s.load.vus === 2 && s.instances === 1));
    assert.ok(find((s) => s.load.rate === 200 && s.instances === 2));
    assert.ok(find((s) => s.data?.distribution?.kind === 'zipf'));
    assert.ok(find((s) => s.chaos?.toxiproxy?.latencyMs > 0));
    assert.ok(find((s) => s.params?.['row-lock']?.lockTimeoutMs < 1000));
  });
});

describe('outcomes', () => {
  it('strategy × situation 전 조합을 정확히 한 번씩 덮는다', () => {
    const seen = new Map();
    for (const o of learn.outcomes) {
      assert.ok(strategyIds.includes(o.strategy), `모르는 strategy ${o.strategy}`);
      assert.ok(situationIds.includes(o.situation), `모르는 situation ${o.situation}`);
      const k = `${o.strategy}×${o.situation}`;
      assert.ok(!seen.has(k), `중복 ${k}`);
      seen.set(k, o);
    }
    for (const st of strategyIds) for (const si of situationIds) assert.ok(seen.has(`${st}×${si}`), `빠짐: ${st}×${si}`);
    assert.equal(learn.outcomes.length, strategyIds.length * situationIds.length);
  });

  it('필드: verdict 값, expected·why 채움, measured는 null(실측 전) 또는 run id·요약·측정 조건이 있는 실측', () => {
    for (const o of learn.outcomes) {
      const k = `${o.strategy}×${o.situation}`;
      assert.ok(VERDICTS.has(o.verdict), `${k}: verdict ${o.verdict}`);
      assert.ok(typeof o.expected === 'string' && o.expected.length > 0, `${k}: expected`);
      assert.ok(typeof o.why === 'string' && o.why.length > 0, `${k}: why`);
      assert.ok('measured' in o, `${k}: measured 키 필요`);
      if (o.measured !== null) {
        // scripts/measured.mjs가 채운 형태(DESIGN §5.4: 사람이 임의로 쓰지 않는다)
        const m = o.measured;
        assert.ok(typeof m.run === 'string' && m.run.includes(`_${o.strategy}_i`), `${k}: measured.run은 이 strategy의 batch id`);
        assert.ok(Array.isArray(m.runs) && m.runs.length > 0 && m.runs.every((r) => r.startsWith(m.run)), `${k}: measured.runs`);
        assert.ok(typeof m.summary === 'string' && m.summary.includes('p95'), `${k}: measured.summary`);
        assert.ok(typeof m.conditions === 'string' && m.conditions.includes('상대 비교'), `${k}: measured.conditions`);
        const s = learn.situations.find((x) => x.id === o.situation);
        assert.ok(m.run.endsWith(`_i${s.instances}`), `${k}: 앱 대수가 situation(${s.instances}대)과 같아야 함`);
      }
      assert.ok(Array.isArray(o.sql) && o.sql.length > 0, `${k}: sql`);
    }
  });

  it('kind: broken strategy는 어떤 상황에서 broken, kind: fixed는 broken이 없다', () => {
    for (const s of manifest.strategies) {
      const verdicts = learn.outcomes.filter((o) => o.strategy === s.id).map((o) => o.verdict);
      if (s.kind === 'broken') assert.ok(verdicts.includes('broken'), `${s.id}`);
      if (s.kind === 'fixed') assert.ok(!verdicts.includes('broken'), `${s.id}: 정합성 보장 방식이 broken`);
    }
  });

  it('app-memory-lock: 서버 1대 상황은 ok, 2대 상황은 broken', () => {
    for (const o of learn.outcomes.filter((x) => x.strategy === 'app-memory-lock')) {
      const s = learn.situations.find((x) => x.id === o.situation);
      assert.equal(o.verdict, s.instances === 1 ? 'ok' : 'broken', o.situation);
    }
  });
});

describe('코드 마커', () => {
  it('모든 focus 마커가 실제 소스에 있다(그 strategy 파일 또는 support)', () => {
    for (const o of learn.outcomes) {
      assert.ok(Array.isArray(o.focus) && o.focus.length > 0, `${o.strategy}×${o.situation}: focus`);
      for (const f of o.focus) {
        assert.ok(existsSync(path.join(PACK_DIR, f.file)), `파일 없음: ${f.file}`);
        assert.ok(learnMarkers(f.file).has(f.marker), `${f.file}에 // @learn ${f.marker} 없음`);
        assert.ok(f.file === `strategies/${o.strategy}.strategy.ts` || f.file.startsWith('support/'), `${o.strategy}의 focus가 다른 strategy 파일을 가리킴: ${f.file}`);
      }
    }
  });

  it('소스의 @learn 마커는 모두 learn.yaml 어딘가에서 쓰인다(고아 마커 없음)', () => {
    const used = new Set(learn.outcomes.flatMap((o) => o.focus.map((f) => `${f.file}#${f.marker}`)));
    for (const file of strategyFiles) {
      for (const id of learnMarkers(file).keys()) assert.ok(used.has(`${file}#${id}`), `${file}#${id}가 쓰이지 않음`);
    }
  });

  it('@learn과 @event는 한 줄에 같이 있지 않고, @event phase는 알려진 값이다', () => {
    for (const file of strategyFiles) {
      const lines = readFileSync(path.join(PACK_DIR, file), 'utf8').split('\n');
      const phases = new Set();
      lines.forEach((line, i) => {
        assert.ok(!(line.includes('@learn') && line.includes('@event')), `${file}:${i + 1} 마커 겹침`);
        const m = EVENT_RE.exec(line);
        if (m) for (const p of m[1].trim().split(/\s+/)) {
          assert.ok(PHASES.has(p) || p.startsWith('custom:'), `${file}:${i + 1} 모르는 phase ${p}`);
          phases.add(p);
        }
      });
      for (const p of ['arrived', 'committed', 'rolled_back']) assert.ok(phases.has(p), `${file}: @event ${p} 없음`);
      assert.ok(!readFileSync(path.join(PACK_DIR, file), 'utf8').includes('TODO'), `${file}: TODO 남음`);
    }
  });
});

describe('choose', () => {
  it('pick·avoid가 manifest strategy이고 pick ∉ avoid', () => {
    assert.ok(learn.choose.length > 0);
    for (const c of learn.choose) {
      assert.ok(c.when && c.because, 'when·because');
      assert.ok(strategyIds.includes(c.pick), c.pick);
      for (const a of c.avoid ?? []) assert.ok(strategyIds.includes(a), a);
      assert.ok(!(c.avoid ?? []).includes(c.pick));
    }
  });

  it('kind: broken strategy는 pick으로 권하지 않는다', () => {
    const broken = new Set(manifest.strategies.filter((s) => s.kind === 'broken').map((s) => s.id));
    for (const c of learn.choose) assert.ok(!broken.has(c.pick), c.when);
  });
});

describe('sql 예시 = MikroORM이 실제로 만드는 문장(형태 비교, 가짜 DB)', () => {
  let fake;
  const generated = new Map();
  before(async () => {
    fake = await createFakeOrm({ latencyMs: 0 });
    for (const id of Object.keys(G02_STRATEGIES)) {
      const set = new Set();
      for (const [stock, qty] of [[10, 1], [0, 1]]) {
        fake.db.products.clear();
        fake.db.sql.length = 0;
        fake.seed(stock);
        const { strategy, params } = makeStrategy(id);
        await strategy.execute(cmd(1, qty), makeCtx(fake.orm.em, { params }));
        for (const s of fake.db.sql) set.add(normalizeSql(s));
      }
      generated.set(id, set);
    }
  });
  after(async () => {
    await fake?.orm.close(true);
  });

  it('outcomes.sql의 모든 문장이 해당 strategy가 실제로 보내는 문장 형태와 같다', () => {
    for (const o of learn.outcomes) {
      for (const s of o.sql) {
        assert.ok(generated.get(o.strategy).has(normalizeSql(s)), `${o.strategy}: 생성되지 않는 SQL\n  ${s}\n실제: ${[...generated.get(o.strategy)].join('\n        ')}`);
      }
    }
  });
});
