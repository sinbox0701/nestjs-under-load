import { describe, expect, it } from 'vitest';
import {
  buildScenarios,
  evidenceOf,
  normalizeMeasured,
  outcomeFor,
  parseLearnYaml,
  resolveFocus,
  situationSummary,
} from './loader';
import { findMarker, parseMarkers } from './markers';
import { fixtureFiles, packFiles, scenarios } from './sources';

const SRC = [
  'async run() {', // 1
  '  // @event db_read', // 2
  '  // @learn read-it — 락 없이 읽는다', // 3
  '  const p = await em.findOne(', // 4
  '    Product,', // 5
  '    id,', // 6
  '  );', // 7
  '  p.stock = p.stock - 1; // @learn inline - 같은 줄 마커', // 8
  '  // @learn no-desc', // 9
  '', // 10
  '  await em.flush();', // 11
  '}',
].join('\n');

describe('parseMarkers', () => {
  it('마커 다음 코드 문장의 줄 범위를 찾는다(여러 줄 호출 포함)', () => {
    const m = parseMarkers(SRC);
    expect(m.get('read-it')).toEqual({
      id: 'read-it',
      line: 3,
      endLine: 7,
      text: '락 없이 읽는다',
    });
  });
  it('코드 뒤에 붙은 마커는 그 줄만 가리킨다', () => {
    expect(findMarker(SRC, 'inline')).toMatchObject({ line: 8, endLine: 8, text: '같은 줄 마커' });
  });
  it('설명 없는 마커와 빈 줄 건너뛰기', () => {
    expect(findMarker(SRC, 'no-desc')).toMatchObject({ line: 9, endLine: 11, text: '' });
  });
  it('@event 주석은 마커가 아니다', () => {
    expect([...parseMarkers(SRC).keys()]).toEqual(['read-it', 'inline', 'no-desc']);
  });
  it('없는 마커는 null', () => {
    expect(findMarker(SRC, 'nope')).toBeNull();
  });
});

const YAML = `
scenario: s1
title: 테스트
concepts: [{ id: c1, label: 개념, body: 본문 }]
situations:
  - { id: a, label: 상황A, load: { model: closed, vus: 2 }, instances: 1, chaos: none }
  - { id: b, label: 상황B, load: { model: open, rate: 200, shape: spike }, instances: 2, chaos: { toxiproxy: { latencyMs: 50 } } }
outcomes:
  - strategy: x
    situation: a
    verdict: broken
    expected: 깨질 수 있음
    measured: null
    why: 이유
    focus: [{ file: strategies/x.strategy.ts, marker: read-it }]
    sql: [select 1]
  - strategy: x
    situation: b
    verdict: weird
    expected: 예상
    measured: { run: r42, oversell: 3 }
    why: 이유2
  - strategy: y
    situation: a
    verdict: ok
    expected: ''
    measured: "3회 중 0회 위반"
    why: ''
choose:
  - { when: 언제, pick: y, because: 왜, avoid: [x] }
`;

describe('learn.yaml 정규화', () => {
  const doc = parseLearnYaml(YAML);
  it('outcomes를 strategy × situation으로 찾는다', () => {
    expect(outcomeFor(doc, 'x', 'a')?.verdict).toBe('broken');
    expect(outcomeFor(doc, 'y', 'b')).toBeNull();
  });
  it('모르는 verdict는 n/a, 빠진 필드는 빈 값', () => {
    const o = outcomeFor(doc, 'x', 'b')!;
    expect(o.verdict).toBe('n/a');
    expect(o.focus).toEqual([]);
    expect(o.sql).toEqual([]);
  });
  it('scenario가 없으면 던진다', () => {
    expect(() => parseLearnYaml('title: x')).toThrow(/scenario/);
  });
  it('상황 요약 문장', () => {
    expect(situationSummary(doc.situations[0]!)).toBe('동시 2명 · 서버 1대');
    expect(situationSummary(doc.situations[1]!)).toBe(
      '200 req/s · spike · 서버 2대 · DB 지연 50ms',
    );
  });
});

describe('실측 vs 예상', () => {
  const doc = parseLearnYaml(YAML);
  it('measured가 null이면 예상', () => {
    expect(evidenceOf(outcomeFor(doc, 'x', 'a'))).toEqual({
      kind: 'expected',
      text: '깨질 수 있음',
    });
  });
  it('measured 객체는 run id와 수치로', () => {
    expect(evidenceOf(outcomeFor(doc, 'x', 'b'))).toEqual({
      kind: 'measured',
      run: 'r42',
      text: 'oversell 3',
    });
  });
  it('measured 문자열은 run 없이 실측', () => {
    expect(evidenceOf(outcomeFor(doc, 'y', 'a'))).toEqual({
      kind: 'measured',
      run: null,
      text: '3회 중 0회 위반',
    });
  });
  it('outcome이 없으면 none', () => {
    expect(evidenceOf(null)).toEqual({ kind: 'none' });
    expect(normalizeMeasured('')).toBeNull();
  });
});

describe('buildScenarios: packs 우선, 없으면 fixture', () => {
  const learn = YAML;
  const xSrc = SRC;
  it('packs learn.yaml이 있으면 packs의 learn·strategies를 쓴다', () => {
    const [s] = buildScenarios(
      {
        'p/s1/learn.yaml': learn,
        'p/s1/strategies/x.strategy.ts': xSrc,
        'p/s1/invariants.sql': 'select 1',
      },
      {
        'p/s1/learn.yaml': 'scenario: other',
        'p/s1/strategies/x.strategy.ts': '// fixture',
      },
    );
    expect(s!.learnOrigin).toBe('packs');
    expect(s!.files.find((f) => f.path === 'strategies/x.strategy.ts')?.origin).toBe('packs');
    expect(s!.strategies.map((x) => x.id)).toEqual(['x', 'y']);
    expect(s!.strategies[1]!.file).toBeNull();
  });
  it('packs learn.yaml이 없거나 깨졌으면 fixture 한 벌 + packs의 나머지 파일', () => {
    const [s] = buildScenarios(
      {
        'p/s1/learn.yaml': ': : :\n  - [',
        'p/s1/strategies/x.strategy.ts': '// TODO stub',
        'p/s1/invariants.sql': 'select 1',
      },
      { 'p/s1/learn.yaml': learn, 'p/s1/strategies/x.strategy.ts': xSrc },
    );
    expect(s!.learnOrigin).toBe('fixture');
    expect(s!.warnings.some((w) => w.includes('fixture로 대체'))).toBe(true);
    const x = s!.files.find((f) => f.path === 'strategies/x.strategy.ts')!;
    expect(x.origin).toBe('fixture');
    expect(x.source).toBe(xSrc);
    expect(s!.files.find((f) => f.path === 'invariants.sql')?.origin).toBe('packs');
    expect(s!.files[0]!.path).toBe('learn.yaml');
  });
  it('focus 마커를 줄로 풀고, 못 찾으면 경고', () => {
    const [s] = buildScenarios(
      {},
      { 'p/s1/learn.yaml': learn, 'p/s1/strategies/x.strategy.ts': '// 마커 없음' },
    );
    expect(s!.warnings).toContain('마커 없음: strategies/x.strategy.ts @learn read-it (x × a)');
    const hits = resolveFocus(
      [{ path: 'strategies/x.strategy.ts', source: xSrc, origin: 'fixture' }],
      outcomeFor(s!.doc, 'x', 'a')!.focus,
    );
    expect(hits[0]!.hit?.line).toBe(3);
  });
});

describe('번들된 G02 fixture', () => {
  it('fixture 파일이 glob으로 번들된다', () => {
    expect(Object.keys(fixtureFiles)).toContain('generic/g02-stock-decrement/learn.yaml');
  });
  it('fixture G02: 4 strategy × 모든 상황 판정이 있고 focus 마커가 모두 풀린다', () => {
    const [g02] = buildScenarios({}, fixtureFiles);
    expect(g02!.learnOrigin).toBe('fixture');
    const ids = ['no-lock', 'app-memory-lock', 'row-lock', 'conditional-update'];
    expect(g02!.strategies.map((s) => s.id)).toEqual(ids);
    for (const st of ids) {
      for (const si of g02!.doc.situations) expect(outcomeFor(g02!.doc, st, si.id)).not.toBeNull();
    }
    expect(g02!.warnings).toEqual([]);
  });
  it('실제 packs learn.yaml이 있으면 화면은 packs를 쓴다', () => {
    const g02 = scenarios.find((s) => s.dir === 'generic/g02-stock-decrement')!;
    const hasPack = 'generic/g02-stock-decrement/learn.yaml' in packFiles;
    expect(g02.learnOrigin).toBe(hasPack ? 'packs' : 'fixture');
  });
});
