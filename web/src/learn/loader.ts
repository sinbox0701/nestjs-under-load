import { parse } from 'yaml';
import { parseMarkers, type MarkerHit } from './markers';
import {
  VERDICTS,
  type Choice,
  type Concept,
  type FileOrigin,
  type FocusRef,
  type LabFile,
  type LearnDoc,
  type Measured,
  type Outcome,
  type Scenario,
  type Situation,
  type StrategyInfo,
  type Verdict,
} from './types';

/** packs/ 기준 경로 → 원문. 예: { 'generic/g02-stock-decrement/learn.yaml': '...' } */
export type RawFiles = Record<string, string>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v == null ? d : String(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function normalizeMeasured(v: unknown): Measured | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string' || typeof v === 'number') return { run: null, text: String(v) };
  if (!isObj(v)) return null;
  const run = v.run ?? v.runId ?? v.id;
  const injectedMs =
    isObj(v.injected) && typeof v.injected.contentionWindowMs === 'number'
      ? v.injected.contentionWindowMs
      : undefined;
  const rest = Object.entries(v).filter(([k]) => !['run', 'runId', 'id', 'injected'].includes(k));
  const summary = v.summary ?? v.text;
  const text =
    typeof summary === 'string'
      ? summary
      : rest
          .map(([k, val]) => `${k} ${typeof val === 'object' ? JSON.stringify(val) : val}`)
          .join(' · ');
  return {
    run: run == null ? null : String(run),
    text,
    ...(injectedMs !== undefined ? { injectedMs } : {}),
  };
}

function normalizeVerdict(v: unknown): Verdict {
  return VERDICTS.includes(v as Verdict) ? (v as Verdict) : 'n/a';
}

function normalizeFocus(v: unknown): FocusRef[] {
  return arr(v)
    .filter(isObj)
    .map((f) => ({ file: str(f.file), marker: str(f.marker) }))
    .filter((f) => f.file && f.marker);
}

/** YAML 객체를 LearnDoc으로 맞춘다. 필수(scenario)가 없으면 던진다. 나머지는 빈 값으로 채운다. */
export function normalizeLearn(raw: unknown): LearnDoc {
  if (!isObj(raw) || typeof raw.scenario !== 'string') {
    throw new Error('learn.yaml: scenario가 없다');
  }
  const concepts: Concept[] = arr(raw.concepts)
    .filter(isObj)
    .map((c) => ({ id: str(c.id), label: str(c.label, str(c.id)), body: str(c.body) }));
  const situations: Situation[] = arr(raw.situations)
    .filter(isObj)
    .map((s) => ({
      id: str(s.id),
      label: str(s.label, str(s.id)),
      load: isObj(s.load) ? (s.load as Situation['load']) : undefined,
      instances: typeof s.instances === 'number' ? s.instances : undefined,
      chaos: s.chaos === 'none' || isObj(s.chaos) ? (s.chaos as Situation['chaos']) : undefined,
      injected:
        isObj(s.injected) && typeof s.injected.contentionWindowMs === 'number'
          ? { contentionWindowMs: s.injected.contentionWindowMs }
          : undefined,
      note: typeof s.note === 'string' ? s.note : undefined,
    }))
    .filter((s) => s.id);
  const outcomes: Outcome[] = arr(raw.outcomes)
    .filter(isObj)
    .map((o) => ({
      strategy: str(o.strategy),
      situation: str(o.situation),
      verdict: normalizeVerdict(o.verdict),
      expected: str(o.expected),
      measured: normalizeMeasured(o.measured),
      why: str(o.why),
      focus: normalizeFocus(o.focus),
      sql: arr(o.sql).map((q) => str(q)),
      concepts: Array.isArray(o.concepts) ? o.concepts.map((c) => str(c)) : undefined,
    }))
    .filter((o) => o.strategy && o.situation);
  const choose: Choice[] = arr(raw.choose)
    .filter(isObj)
    .map((c) => ({
      when: str(c.when),
      pick: str(c.pick),
      because: str(c.because),
      avoid: arr(c.avoid).map((a) => str(a)),
    }));
  return {
    scenario: raw.scenario,
    title: str(raw.title, raw.scenario),
    concepts,
    situations,
    outcomes,
    choose,
  };
}

export function parseLearnYaml(text: string): LearnDoc {
  return normalizeLearn(parse(text));
}

/* ───────── 조회 ───────── */

export function outcomeFor(doc: LearnDoc, strategy: string, situation: string): Outcome | null {
  return doc.outcomes.find((o) => o.strategy === strategy && o.situation === situation) ?? null;
}

export type Evidence =
  | { kind: 'measured'; run: string | null; text: string; injectedMs?: number }
  | { kind: 'expected'; text: string }
  | { kind: 'none' };

/** 실측이 있으면 실측, 없으면 예상. 화면은 둘을 다른 배지로 그린다. */
export function evidenceOf(o: Outcome | null): Evidence {
  if (!o) return { kind: 'none' };
  if (o.measured) return { kind: 'measured', ...o.measured };
  if (o.expected) return { kind: 'expected', text: o.expected };
  return { kind: 'none' };
}

export interface FocusHit extends FocusRef {
  hit: MarkerHit | null;
}

/** outcome의 focus 마커를 실제 소스 줄로 바꾼다. 파일·마커가 없으면 hit=null. */
export function resolveFocus(files: LabFile[], focus: FocusRef[]): FocusHit[] {
  const cache = new Map<string, Map<string, MarkerHit>>();
  return focus.map((f) => {
    const file = files.find((x) => x.path === f.file);
    if (!file) return { ...f, hit: null };
    let markers = cache.get(file.path);
    if (!markers) {
      markers = parseMarkers(file.source);
      cache.set(file.path, markers);
    }
    return { ...f, hit: markers.get(f.marker) ?? null };
  });
}

export const VERDICT_META: Record<Verdict, { label: string; icon: string; tone: string }> = {
  ok: { label: '맞음', icon: '✓', tone: 'ok' },
  broken: { label: '깨짐', icon: '✕', tone: 'bad' },
  slow: { label: '느림', icon: '⧗', tone: 'wait' },
  rejects: { label: '거절', icon: '⊘', tone: 'retry' },
  'n/a': { label: '해당 없음', icon: '–', tone: 'neutral' },
};

/** 장애·지연이 인위로 주입된 상황인가(chaos 또는 경합 창 주입). 화면에 "주입됨" 배지를 붙인다. */
export function isInjected(s: Situation): boolean {
  return (s.chaos != null && s.chaos !== 'none') || (s.injected?.contentionWindowMs ?? 0) > 0;
}

/**
 * 실측 run id를 배지에 들어갈 길이로 줄인다. 전체 id는 툴팁(title)으로 보인다.
 * `2026-10-06T16-20-36Z_g02_row-lock_i2` → `10-06 16:20:36` (strategy·대수는 표의 행·상황이 이미 말해 준다)
 */
export function shortRunId(run: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(run);
  if (m) return `${m[1]}-${m[2]} ${m[3]}:${m[4]}:${m[5]}`;
  return run.length > 16 ? `${run.slice(0, 15)}…` : run;
}

export function situationSummary(s: Situation): string {
  const parts: string[] = [];
  if (s.load) {
    const l = s.load;
    if (l.model === 'closed' && l.vus != null) parts.push(`동시 ${l.vus}명`);
    else if (l.rate != null) parts.push(`${l.rate} req/s`);
    if (l.shape) parts.push(l.shape);
  }
  if (s.instances != null) parts.push(`서버 ${s.instances}대`);
  if (s.chaos && s.chaos !== 'none') {
    const tp = isObj(s.chaos.toxiproxy) ? s.chaos.toxiproxy : null;
    parts.push(tp && typeof tp.latencyMs === 'number' ? `DB 지연 ${tp.latencyMs}ms` : '장애 주입');
  }
  if (s.injected?.contentionWindowMs) parts.push(`경합 창 +${s.injected.contentionWindowMs}ms`);
  return parts.join(' · ');
}

/* ───────── 조립 ───────── */

function strategyId(path: string): string | null {
  const m = /^strategies\/([^/]+)\.strategy\.ts$/.exec(path);
  return m ? m[1]! : null;
}

function readManifest(
  text: string | undefined,
): Map<string, { label: string; kind: string | null }> {
  const out = new Map<string, { label: string; kind: string | null }>();
  if (!text) return out;
  try {
    const raw = parse(text) as unknown;
    if (!isObj(raw)) return out;
    for (const s of arr(raw.strategies).filter(isObj)) {
      out.set(str(s.id), { label: str(s.label, str(s.id)), kind: s.kind ? str(s.kind) : null });
    }
  } catch {
    /* manifest는 라벨용이라 실패해도 무시 */
  }
  return out;
}

function filesUnder(files: RawFiles, dir: string, origin: FileOrigin): LabFile[] {
  const prefix = `${dir}/`;
  return Object.entries(files)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, source]) => ({ path: k.slice(prefix.length), source, origin }));
}

const FILE_ORDER = [
  'learn.yaml',
  'strategies/',
  'entities/',
  'invariants.sql',
  'k6/',
  'manifest.yaml',
];
function fileRank(p: string): number {
  const i = FILE_ORDER.findIndex((x) => (x.endsWith('/') ? p.startsWith(x) : p === x));
  return i < 0 ? FILE_ORDER.length : i;
}

/**
 * 실제 packs와 fixture를 합친다.
 * - learn.yaml + strategies: packs의 learn.yaml이 읽히면 packs 쪽, 아니면(없음·파싱 실패) fixture 쪽 한 벌.
 * - 그 밖의 파일(entities, invariants.sql, k6, manifest): packs에 있으면 packs, 없으면 fixture.
 */
export function buildScenarios(pack: RawFiles, fixture: RawFiles): Scenario[] {
  const dirs = new Set<string>();
  for (const k of [...Object.keys(pack), ...Object.keys(fixture)]) {
    if (k.endsWith('/learn.yaml')) dirs.add(k.slice(0, -'/learn.yaml'.length));
  }
  const out: Scenario[] = [];
  for (const dir of [...dirs].sort()) {
    const warnings: string[] = [];
    const packFiles = filesUnder(pack, dir, 'packs');
    const fixFiles = filesUnder(fixture, dir, 'fixture');
    let doc: LearnDoc | null = null;
    let learnOrigin: FileOrigin = 'packs';
    const packLearn = packFiles.find((f) => f.path === 'learn.yaml');
    if (packLearn) {
      try {
        doc = parseLearnYaml(packLearn.source);
      } catch (e) {
        warnings.push(`packs의 learn.yaml을 읽지 못해 fixture로 대체: ${(e as Error).message}`);
      }
    }
    if (!doc) {
      const fixLearn = fixFiles.find((f) => f.path === 'learn.yaml');
      if (!fixLearn) continue;
      try {
        doc = parseLearnYaml(fixLearn.source);
        learnOrigin = 'fixture';
      } catch (e) {
        warnings.push(`fixture learn.yaml 오류: ${(e as Error).message}`);
        continue;
      }
    }
    const learnSet = (f: LabFile) => f.path === 'learn.yaml' || strategyId(f.path) !== null;
    const primary = learnOrigin === 'packs' ? packFiles : fixFiles;
    const files: LabFile[] = primary.filter(learnSet);
    const seen = new Set(files.map((f) => f.path));
    for (const f of [...packFiles, ...fixFiles]) {
      if (learnSet(f) || seen.has(f.path)) continue;
      files.push(f);
      seen.add(f.path);
    }
    files.sort((a, b) => fileRank(a.path) - fileRank(b.path) || a.path.localeCompare(b.path));

    const manifest = readManifest(files.find((f) => f.path === 'manifest.yaml')?.source);
    const ids: string[] = [];
    for (const o of doc.outcomes) if (!ids.includes(o.strategy)) ids.push(o.strategy);
    for (const f of files) {
      const id = strategyId(f.path);
      if (id && !ids.includes(id)) ids.push(id);
    }
    const strategies: StrategyInfo[] = ids.map((id) => {
      const path = `strategies/${id}.strategy.ts`;
      const m = manifest.get(id);
      return {
        id,
        label: m?.label ?? id,
        kind: m?.kind ?? null,
        file: files.some((f) => f.path === path) ? path : null,
      };
    });

    for (const o of doc.outcomes) {
      for (const h of resolveFocus(files, o.focus)) {
        if (!h.hit)
          warnings.push(`마커 없음: ${h.file} @learn ${h.marker} (${o.strategy} × ${o.situation})`);
      }
    }

    out.push({
      dir,
      pack: dir.split('/')[0] ?? dir,
      doc,
      learnOrigin,
      strategies,
      files,
      warnings: [...new Set(warnings)],
    });
  }
  return out;
}

export function languageOf(path: string): string {
  if (path.endsWith('.ts')) return 'typescript';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'javascript';
  if (path.endsWith('.sql')) return 'sql';
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'yaml';
  if (path.endsWith('.json')) return 'json';
  return 'plaintext';
}

/* ───────── 에디터 강조 ───────── */

export type Tone = 'ok' | 'bad' | 'wait' | 'retry' | 'info';

export function toneOf(v: Verdict | undefined): Tone {
  switch (v) {
    case 'ok':
      return 'ok';
    case 'broken':
      return 'bad';
    case 'slow':
      return 'wait';
    case 'rejects':
      return 'retry';
    default:
      return 'info';
  }
}

export interface Highlight {
  marker: string;
  /** 마커 주석 줄 */
  line: number;
  /** 강조 끝 줄 */
  endLine: number;
  /** 마커 설명 */
  text: string;
  tone: Tone;
  /** 호버에 같이 보일 판정 이유 */
  why: string;
}

/** 한 파일에서 outcome focus에 해당하는 강조 줄들. */
export function highlightsFor(
  files: LabFile[],
  outcome: Outcome | null,
  path: string,
): Highlight[] {
  if (!outcome) return [];
  const tone = toneOf(outcome.verdict);
  return resolveFocus(
    files,
    outcome.focus.filter((f) => f.file === path),
  ).flatMap((h) =>
    h.hit
      ? [
          {
            marker: h.marker,
            line: h.hit.line,
            endLine: h.hit.endLine,
            text: h.hit.text,
            tone,
            why: outcome.why,
          },
        ]
      : [],
  );
}
