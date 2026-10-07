// learn.yaml 스키마·정합성 검증(도커 불필요). G02 learn.test 와 같은 규약을 G01 에 맞춘 것.
// - outcomes 가 strategy × situation 전 조합을 덮는지, focus 마커가 실제 소스에 있는지(고아 마커 없음),
//   sql 예시가 이 팩 코드가 실제로 보내는 문장과 같은 형태인지(가짜 DB 로 MikroORM 이 만든 SQL 을 가로채 대조) 확인한다.
// - 코드 실험실(web)은 strategies/*.strategy.ts 만 번들하므로 focus 도 그 파일만 가리킨다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { G01_STRATEGIES, resolveStrategy } from './helpers.mjs';

const require = createRequire(import.meta.url);
const PACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MikroORM } = require('@mikro-orm/postgresql');
const { Document } = require('../dist/entities/document.entity.js');
const { DocumentRevision } = require('../dist/entities/document-revision.entity.js');
const { EditLedger } = require('../dist/entities/edit-ledger.entity.js');
const { G01Controller } = require('../dist/api/g01.controller.js');

const learn = parse(readFileSync(path.join(PACK_DIR, 'learn.yaml'), 'utf8'));
const manifest = parse(readFileSync(path.join(PACK_DIR, 'manifest.yaml'), 'utf8'));
const strategyIds = manifest.strategies.map((s) => s.id);
const situationIds = learn.situations.map((s) => s.id);
const conceptIds = learn.concepts.map((c) => c.id);

const VERDICTS = new Set(['ok', 'broken', 'slow', 'rejects', 'n/a']);
const REQUIRED_CONCEPTS = [
  'lost-update',
  'optimistic-two-failure-points',
  'rc-recheck',
  'tx-boundary',
  'serializable-cannot-help',
  'status-409-vs-423',
  'fencing-token',
];
/** 버전을 비교하지 않는(또는 클라이언트가 우회하는) strategy. 나머지 셋은 어떤 상황에서도 lost update 가 없어야 한다. */
const LOSES_UPDATES = new Set(['naive-overwrite', 'blind-retry']);
/** blind-retry 는 서버 구현이 optimistic-version 과 같다(클래스 상속, id 만 다름). focus 는 그 파일의 마커를 가리킨다. */
const SHARED_SERVER = { 'blind-retry': 'optimistic-version' };
const LEARN_RE = /\/\/ @learn ([a-z0-9-]+) — \S/;

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

/** SQL 리터럴을 지워 형태만 비교한다: 'x' → '?', 숫자 → ?, 공백 정리, 끝 세미콜론 제거(G02 helpers 와 같은 규칙). */
function normalizeSql(sql) {
  return sql
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/\b\d+\b/g, '?')
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim()
    .toLowerCase();
}

describe('learn.yaml 기본 구조', () => {
  it('scenario·title 이 manifest 와 맞고, manifest strategy = 레지스트리 키', () => {
    assert.equal(learn.scenario, manifest.id);
    assert.ok(typeof learn.title === 'string' && learn.title.length > 0);
    assert.deepEqual([...strategyIds].sort(), Object.keys(G01_STRATEGIES).sort());
  });

  it('concepts: 필수 개념이 모두 있고 id 가 유일, body 는 3문장 이상', () => {
    assert.equal(new Set(conceptIds).size, conceptIds.length);
    for (const id of REQUIRED_CONCEPTS) assert.ok(conceptIds.includes(id), `concept ${id} 없음`);
    for (const c of learn.concepts) {
      assert.ok(c.label, `${c.id}: label`);
      const sentences = c.body.split(/(?<=[.다])\s/).filter((s) => s.trim());
      assert.ok(sentences.length >= 3, `${c.id}: body ${sentences.length}문장`);
    }
  });

  it('situations: 5개 이상, id 유일, closed 부하(vus)·인스턴스·chaos·문서 수가 있다', () => {
    assert.ok(learn.situations.length >= 5);
    assert.equal(new Set(situationIds).size, situationIds.length);
    for (const s of learn.situations) {
      assert.ok(s.label && s.note, `${s.id}: label·note`);
      assert.ok(Number.isInteger(s.instances) && s.instances >= 1, `${s.id}: instances`);
      assert.ok(manifest.load.models.includes(s.load?.model), `${s.id}: load.model`);
      if (s.load.model === 'closed') assert.ok(Number.isInteger(s.load.vus) && s.load.vus >= 1, `${s.id}: load.vus`);
      assert.ok(manifest.load.allowedProfiles.includes(s.load.shape), `${s.id}: load.shape 는 manifest allowedProfiles`);
      assert.ok(s.chaos !== undefined, `${s.id}: chaos(none 포함) 필요`);
      // 시드 규칙(seed/index.ts): 문서 1~100
      assert.ok(Number.isInteger(s.data?.documents) && s.data.documents >= 1 && s.data.documents <= 100, `${s.id}: data.documents`);
      assert.ok(['uniform', 'zipf'].includes(s.data.distribution?.kind), `${s.id}: data.distribution`);
      for (const [k, v] of Object.entries(s.scenarioParams ?? {})) {
        assert.ok(k in manifest.scenarioParams, `${s.id}: scenarioParams.${k} 는 manifest scenarioParams 키`);
        assert.ok(Number.isInteger(v) && v >= 0, `${s.id}: scenarioParams.${k}`);
      }
      // strategy 파라미터는 레지스트리(zod)가 받아 주는 값이어야 한다(부팅 실패 방지)
      for (const [k, v] of Object.entries(s.params ?? {})) {
        assert.ok(strategyIds.includes(k), `${s.id}: params.${k}`);
        assert.doesNotThrow(() => resolveStrategy(k, v), `${s.id}: params.${k}`);
      }
      if (s.injected !== undefined) {
        assert.deepEqual(Object.keys(s.injected), ['contentionWindowMs'], `${s.id}: injected 는 contentionWindowMs 만`);
        assert.ok(Number.isInteger(s.injected.contentionWindowMs) && s.injected.contentionWindowMs > 0, `${s.id}: injected.contentionWindowMs`);
        assert.equal(s.chaos, 'none', `${s.id}: 경합 창 주입은 chaos 와 섞지 않는다`);
      }
    }
  });

  it('필수 상황이 모두 있다(사람 2·문서 1 / 사람 20·문서 1 / Zipf 문서 100 / lease TTL < 편집 시간 / 경합 창 주입)', () => {
    const find = (pred) => learn.situations.some(pred);
    assert.ok(find((s) => s.load.vus === 2 && s.data.documents === 1));
    assert.ok(find((s) => s.load.vus === 20 && s.data.documents === 1));
    assert.ok(find((s) => s.data.documents === 100 && s.data.distribution.kind === 'zipf' && s.data.distribution.s > 0));
    assert.ok(find((s) => s.params?.['edit-lease']?.ttlMs < (s.scenarioParams?.editMs ?? manifest.scenarioParams.editMs.default)));
    assert.ok(find((s) => s.injected?.contentionWindowMs > 0));
  });
});

describe('outcomes', () => {
  it('AC-1 strategy × situation 전 조합을 정확히 한 번씩 덮는다', () => {
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

  it('필드: verdict 값, expected·why 채움, sql 있음, measured 는 null(실측 전) 또는 run id·요약·측정 조건이 있는 실측', () => {
    for (const o of learn.outcomes) {
      const k = `${o.strategy}×${o.situation}`;
      assert.ok(VERDICTS.has(o.verdict), `${k}: verdict ${o.verdict}`);
      assert.ok(typeof o.expected === 'string' && o.expected.length > 0, `${k}: expected`);
      assert.ok(typeof o.why === 'string' && o.why.length > 0, `${k}: why`);
      assert.ok(Array.isArray(o.sql) && o.sql.length > 0, `${k}: sql`);
      assert.ok('measured' in o, `${k}: measured 키 필요`);
      if (o.measured !== null) {
        // 실행기(measured 계산)가 채운 형태(DESIGN §5.4: 사람이 임의로 쓰지 않는다)
        const m = o.measured;
        assert.ok(typeof m.run === 'string' && m.run.includes(`_${o.strategy}_i`), `${k}: measured.run 은 이 strategy 의 batch id`);
        assert.ok(Array.isArray(m.runs) && m.runs.length > 0 && m.runs.every((r) => r.startsWith(m.run)), `${k}: measured.runs`);
        assert.ok(typeof m.summary === 'string' && m.summary.includes('p95'), `${k}: measured.summary`);
        assert.ok(typeof m.conditions === 'string' && m.conditions.includes('상대 비교'), `${k}: measured.conditions`);
        const s = learn.situations.find((x) => x.id === o.situation);
        assert.ok(m.run.endsWith(`_i${s.instances}`), `${k}: 앱 대수가 situation(${s.instances}대)과 같아야 함`);
      }
    }
  });

  it('outcomes.concepts 는 있는 개념만 가리키고, 모든 개념이 어느 판정에선가 쓰인다', () => {
    const used = new Set();
    for (const o of learn.outcomes) {
      for (const c of o.concepts ?? []) {
        assert.ok(conceptIds.includes(c), `${o.strategy}×${o.situation}: 모르는 concept ${c}`);
        used.add(c);
      }
    }
    for (const c of conceptIds) assert.ok(used.has(c), `concept ${c} 를 가리키는 판정이 없음`);
  });

  it('kind: broken 은 어떤 상황에서 broken, fixed 는 broken 이 없다', () => {
    for (const s of manifest.strategies) {
      const verdicts = learn.outcomes.filter((o) => o.strategy === s.id).map((o) => o.verdict);
      if (s.kind === 'broken') assert.ok(verdicts.includes('broken'), s.id);
      if (s.kind === 'fixed') assert.ok(!verdicts.includes('broken'), `${s.id}: 정합성 보장 방식이 broken`);
    }
  });

  it('lost update 는 naive-overwrite·blind-retry 만 낸다(모든 상황이 같은 문서 경합을 포함), 나머지 셋은 broken 이 없다', () => {
    for (const o of learn.outcomes) {
      if (LOSES_UPDATES.has(o.strategy)) assert.equal(o.verdict, 'broken', `${o.strategy}×${o.situation}`);
      else assert.notEqual(o.verdict, 'broken', `${o.strategy}×${o.situation}`);
    }
  });

  it('edit-lease: lease TTL 이 편집 시간보다 짧은 상황은 저장이 거절된다(rejects)', () => {
    for (const s of learn.situations.filter((x) => x.params?.['edit-lease']?.ttlMs !== undefined)) {
      const editMs = s.scenarioParams?.editMs ?? manifest.scenarioParams.editMs.default;
      if (s.params['edit-lease'].ttlMs >= editMs) continue;
      const o = learn.outcomes.find((x) => x.strategy === 'edit-lease' && x.situation === s.id);
      assert.equal(o.verdict, 'rejects', s.id);
    }
  });
});

describe('코드 마커', () => {
  it('AC-2 모든 focus 마커가 실제 소스에 있다(그 strategy 파일, blind-retry 는 서버 구현을 공유하는 optimistic-version 파일)', () => {
    for (const o of learn.outcomes) {
      assert.ok(Array.isArray(o.focus) && o.focus.length > 0, `${o.strategy}×${o.situation}: focus`);
      const allowed = [`strategies/${o.strategy}.strategy.ts`];
      if (SHARED_SERVER[o.strategy]) allowed.push(`strategies/${SHARED_SERVER[o.strategy]}.strategy.ts`);
      for (const f of o.focus) {
        assert.ok(allowed.includes(f.file), `${o.strategy}의 focus 가 다른 파일을 가리킴: ${f.file}`);
        assert.ok(existsSync(path.join(PACK_DIR, f.file)), `파일 없음: ${f.file}`);
        assert.ok(learnMarkers(f.file).has(f.marker), `${f.file}에 // @learn ${f.marker} 없음`);
      }
    }
  });

  it('소스의 @learn 마커는 모두 learn.yaml 어딘가에서 쓰인다(고아 마커 없음)', () => {
    const used = new Set(learn.outcomes.flatMap((o) => o.focus.map((f) => `${f.file}#${f.marker}`)));
    for (const file of strategyFiles) {
      for (const id of learnMarkers(file).keys()) assert.ok(used.has(`${file}#${id}`), `${file}#${id} 가 쓰이지 않음`);
    }
  });

  it('@learn 과 @event 는 한 줄에 같이 있지 않다', () => {
    for (const file of strategyFiles) {
      readFileSync(path.join(PACK_DIR, file), 'utf8')
        .split('\n')
        .forEach((line, i) => assert.ok(!(line.includes('@learn') && line.includes('@event')), `${file}:${i + 1} 마커 겹침`));
    }
  });
});

describe('choose', () => {
  it('pick·avoid 가 manifest strategy 이고 pick ∉ avoid', () => {
    assert.ok(learn.choose.length > 0);
    for (const c of learn.choose) {
      assert.ok(c.when && c.because, 'when·because');
      assert.ok(strategyIds.includes(c.pick), c.pick);
      for (const a of c.avoid ?? []) assert.ok(strategyIds.includes(a), a);
      assert.ok(!(c.avoid ?? []).includes(c.pick));
    }
  });

  it('kind: broken strategy 는 pick 으로 권하지 않는다', () => {
    const broken = new Set(manifest.strategies.filter((s) => s.kind === 'broken').map((s) => s.id));
    for (const c of learn.choose) assert.ok(!broken.has(c.pick), c.when);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 가짜 DB(도커 불필요): MikroORM 이 만든 최종 SQL 을 가로채 기록하고, 문서 한 행의 상태로 결과를 흉내 낸다.
// 행 잠금·EvalPlanQual 은 흉내 내지 않는다. 성공·충돌(0행) 분기를 모두 지나 "이 코드가 보낼 수 있는 문장"을 모으는 데만 쓴다.
// 컨트롤러를 통해 부르므로 GET(자동 커밋 읽기)과 409 응답 본문의 재조회 SQL 까지 모인다.
// ─────────────────────────────────────────────────────────────────────────────
async function createFakeOrm() {
  const orm = await MikroORM.init({
    entities: [Document, DocumentRevision, EditLedger],
    dbName: 'g01_fake',
    connect: false,
    allowGlobalContext: true,
  });
  const conn = orm.em.getConnection();
  const db = { sql: [], doc: null, updateRows: 1 };
  const docRow = () => ({
    id: 1,
    version: db.doc.version,
    field_a: [],
    field_b: [],
    field_c: [],
    field_d: [],
    field_versions: { a: 0, b: 0, c: 0, d: 0 },
    edit_count: 0,
    locked_by: db.doc.lockedBy,
    lease_until: db.doc.lockedBy ? new Date() : null,
    fence: db.doc.fence,
  });
  const result = (rows) => ({ affectedRows: rows.length, rows, row: rows[0], insertId: 0 });
  conn.begin = async () => ({ fake: true });
  conn.commit = async () => {};
  conn.rollback = async () => {};
  conn.execute = async (query, params = [], method = 'all') => {
    const sql = conn.prepareQuery(query, params).formatted;
    db.sql.push(sql);
    const one = (r) => (method === 'get' ? r : [r]);
    if (/^select "d0"\.\* from "g01_document" as "d0" where "d0"\."id" = \d+ limit 1$/.test(sql)) return one(docRow());
    if (/^select id, version, field_a/.test(sql)) return [{ ...docRow(), lease_active: db.doc.lockedBy !== null }];
    if (/^select version, \(field_versions ->> '[a-d]'\)::int as field_version from g01_document/.test(sql)) return [{ version: db.doc.version, field_version: db.doc.version }];
    if (/^select version from g01_document/.test(sql)) return [{ version: db.doc.version }];
    if (/^select locked_by, greatest\(/.test(sql)) return [{ locked_by: db.doc.lockedBy, remaining_ms: 10 }];
    if (/^select locked_by, fence::text as fence, lease_until > clock_timestamp\(\) as live, version/.test(sql)) {
      return [{ locked_by: db.doc.lockedBy, fence: db.doc.fence, live: false, version: db.doc.version }];
    }
    if (/^update "g01_document" set /.test(sql)) {
      const rows = db.updateRows ? [{ version: db.doc.version + 1, edit_count: 1, field_versions: {}, fence: db.doc.fence, lease_until: new Date() }] : [];
      return method === 'all' ? rows : result(rows); // QueryBuilder.execute('all') 는 행 배열을 받는다(acquire)
    }
    if (/^insert into "g01_(edit_ledger|document_revision)" /.test(sql)) return result([{ id: '1', txid: '1', created_at: new Date() }]);
    throw new Error(`fake db: 모르는 SQL: ${sql}`);
  };
  return {
    orm,
    db,
    /** 문서 상태를 정하고 SQL 기록을 비운다. updateRows=0 이면 조건부 UPDATE 가 0행(충돌·잠금 실패)이다. */
    reset({ version = 1, lockedBy = null, fence = '1', updateRows = 1 } = {}) {
      db.doc = { version, lockedBy, fence };
      db.updateRows = updateRows;
    },
  };
}

const TOKEN = 'abcdefghijkl';
const FIELDS = { a: [TOKEN], b: [], c: [], d: [] };
const res = () => ({ status() {}, setHeader() {} });
const runtime = { instance: 'app-1', contentionWindow: async () => ({ injected: false, durMs: 0 }) };

/** strategy 하나가 HTTP 흐름(GET·PUT·PATCH·lease)에서 보낼 수 있는 SQL 형태 전부. 성공·충돌 분기를 모두 지난다. */
async function generatedSql(fake, id) {
  const { cls, params } = resolveStrategy(id, undefined);
  const c = new G01Controller(fake.orm.em, new cls(), params, runtime, undefined);
  const put = (body) => c.put(1, randomUUID(), { editToken: TOKEN, fields: FIELDS, ...body }, res());
  const cases = [];
  cases.push([{}, () => c.get(1)]);
  if (id === 'edit-lease') {
    const lease = { holder: 'vu1-it0', fence: '1' };
    cases.push([{}, () => c.acquire(1, { holder: lease.holder }, res())]); // 잡음
    cases.push([{ lockedBy: 'vu2-it0', updateRows: 0 }, () => c.acquire(1, { holder: lease.holder }, res())]); // 423
    cases.push([{ lockedBy: lease.holder }, () => put({ version: 2, lease })]); // 보유자 저장
    cases.push([{ lockedBy: 'vu2-it0', fence: '2', updateRows: 0 }, () => put({ version: 2, lease })]); // lease_lost
    cases.push([{ lockedBy: lease.holder, updateRows: 0 }, () => put({ version: 2, lease })]); // lease_expired
    cases.push([{ lockedBy: lease.holder }, () => c.release(1, lease)]);
  } else {
    cases.push([{}, () => put({ version: 1 })]); // 성공
    cases.push([{ version: 2 }, () => put({ version: 1 })]); // optimistic: ① 메모리 비교 불일치
    cases.push([{ updateRows: 0 }, () => put({ version: 1 })]); // 조건부 UPDATE 0행(② 등)
    if (id === 'field-merge') {
      // 필드 이름이 SET 컬럼에 들어가므로(field_a~d) 네 필드 모두 지난다
      for (const field of ['a', 'b', 'c', 'd']) {
        const patch = (body) => c.patch(1, randomUUID(), { field, value: [TOKEN], editToken: TOKEN, ...body }, res());
        cases.push([{}, () => patch({ version: 1 })]);
        cases.push([{ updateRows: 0 }, () => patch({ version: 1 })]); // 같은 필드 충돌
      }
    }
  }
  const set = new Set();
  for (const [state, run] of cases) {
    fake.reset(state);
    fake.db.sql.length = 0;
    await run();
    for (const s of fake.db.sql) set.add(normalizeSql(s));
  }
  return set;
}

describe('sql 예시 = 이 코드가 실제로 보내는 문장(형태 비교, 가짜 DB)', () => {
  let fake;
  const generated = new Map();
  before(async () => {
    fake = await createFakeOrm();
    for (const id of Object.keys(G01_STRATEGIES)) generated.set(id, await generatedSql(fake, id));
  });
  after(async () => {
    await fake?.orm.close(true);
  });

  it('가짜 DB 가 분기를 실제로 지났다(성공 UPDATE·원장 INSERT·충돌 재조회가 모두 모였다)', () => {
    const has = (id, re) => [...generated.get(id)].some((s) => re.test(s));
    for (const id of Object.keys(G01_STRATEGIES)) {
      assert.ok(has(id, /^select id, version, field_a/), `${id}: GET`);
      assert.ok(has(id, /^update "g01_document" set /), `${id}: UPDATE`);
      assert.ok(has(id, /^insert into "g01_edit_ledger"/) && has(id, /^insert into "g01_document_revision"/), `${id}: 원장·이력`);
    }
    assert.ok(has('optimistic-version', /where "id" = \? and "version" = \? returning/), 'optimistic: flush WHERE version');
    assert.ok(!has('naive-overwrite', /"version" = \? /), 'naive: WHERE 에 version 이 없다');
    assert.ok(has('field-merge', /^select version, \(field_versions ->> '\?'\)::int/), 'field-merge: 같은 필드 충돌 재조회');
    assert.ok(has('edit-lease', /^select locked_by, greatest\(/), 'edit-lease: 423 재조회');
    assert.ok(has('edit-lease', /^select locked_by, fence::text/), 'edit-lease: 저장 실패 재조회');
  });

  it('outcomes.sql 의 모든 문장이 해당 strategy 가 실제로 보내는 문장 형태와 같다', () => {
    for (const o of learn.outcomes) {
      for (const s of o.sql) {
        assert.ok(generated.get(o.strategy).has(normalizeSql(s)), `${o.strategy}: 생성되지 않는 SQL\n  ${s}\n실제: ${[...generated.get(o.strategy)].join('\n        ')}`);
      }
    }
  });
});
