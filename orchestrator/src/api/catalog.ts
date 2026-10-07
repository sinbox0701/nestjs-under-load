// 시나리오 카탈로그: `<repo>/packs/<pack>/<id>/manifest.yaml` 을 읽어 ScenarioDef(내부)와 ScenarioInfo(공개)를 만든다.
// learn.yaml 은 situations 와 measured 계산용으로만 읽는다.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import type { ScenarioInfo } from '@under-load/contracts';
import YAML from 'yaml';

import type { ScenarioCatalog, ScenarioDef } from '../ports.js';

type Bag = Record<string, unknown>;

/** learn.yaml 의 situation(measured 대응에 쓰는 부분만 느슨하게). */
export type LearnSituation = Bag & { id: string };

export interface PackCatalog extends ScenarioCatalog {
  infos(): ScenarioInfo[];
  info(id: string): ScenarioInfo | undefined;
  /** learn.yaml 의 situations. 파일이 없으면 null. */
  learnSituations(id: string): LearnSituation[] | null;
}

const isBag = (v: unknown): v is Bag => typeof v === 'object' && v !== null && !Array.isArray(v);
const asBag = (v: unknown): Bag => (isBag(v) ? v : {});
const asStr = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v === '') throw new Error(`manifest 의 ${what} 가 비어 있다`);
  return v;
};

/** manifest strategies[].params 정의에서 기본값만 뽑는다(`{ lockTimeoutMs: { type, default: 1000 } }` → `{ lockTimeoutMs: 1000 }`). */
function paramDefaults(params: Bag): Bag {
  const out: Bag = {};
  for (const [k, def] of Object.entries(params)) if (isBag(def) && 'default' in def) out[k] = def.default;
  return out;
}

function readYaml(file: string): Bag {
  return asBag(YAML.parse(readFileSync(file, 'utf8')));
}

type Entry = { def: ScenarioDef; info: ScenarioInfo };

function buildEntry(repoDir: string, manifestFile: string): Entry {
  const m = readYaml(manifestFile);
  const id = asStr(m.id, 'id');
  const pack = asStr(m.pack, 'pack');
  const dir = path.dirname(manifestFile);
  const rel = path.relative(repoDir, dir).split(path.sep).join('/');
  const strategies = (Array.isArray(m.strategies) ? m.strategies : []).map(asBag);
  const invariants = (Array.isArray(m.invariants) ? m.invariants : []).map(asBag);
  const load = asBag(m.load);
  const seed = asBag(asBag(m.data).seed);
  const k6 = asBag(m.k6);
  const warmup = asBag(load.warmup);
  const discard = typeof warmup.discardSql === 'string' && warmup.discardSql.trim() !== '' ? warmup.discardSql.trim() : null;

  const def: ScenarioDef = {
    id,
    pack,
    title: asStr(m.title, 'title'),
    minAppInstances: typeof m.minAppInstances === 'number' ? m.minAppInstances : 1,
    // k6 컨테이너는 팩 폴더를 `/packs/...` 로 본다(C7 script 예시).
    k6Script: `/${rel}/${asStr(k6.template, 'k6.template')}`,
    invariantsSqlPath: path.join(dir, 'invariants.sql'),
    invariants: invariants.map((i) => ({
      id: asStr(i.id, 'invariants[].id'),
      severity: i.severity === 'info' ? 'info' : 'critical',
      sql: asStr(i.sql, 'invariants[].sql'),
    })),
    discardSql: discard,
    strategies: strategies.map((s) => ({ id: asStr(s.id, 'strategies[].id'), params: paramDefaults(asBag(s.params)) })),
    seedDefaults: asBag(seed.defaults),
  };

  const learnFile = path.join(dir, 'learn.yaml');
  const situations = existsSync(learnFile) ? readYaml(learnFile).situations : undefined;
  const info: ScenarioInfo = {
    id,
    pack,
    title: def.title,
    minAppInstances: def.minAppInstances,
    strategies: strategies.map((s) => ({
      id: asStr(s.id, 'strategies[].id'),
      label: asStr(s.label, 'strategies[].label'),
      kind: s.kind === 'fixed' || s.kind === 'tradeoff' ? s.kind : 'broken',
      bypassesOrm: s.bypassesOrm === true,
      requires: Array.isArray(s.requires) ? s.requires.map(String) : [],
      params: asBag(s.params),
    })),
    // 1단계는 open·closed 둘 다 실행한다. 기본값은 manifest 그대로.
    load: { models: ['open', 'closed'], defaults: asBag(load.defaults) },
    seedDefaults: def.seedDefaults,
    ...(Array.isArray(situations) ? { situations: situations.map(asBag) } : {}),
  };
  return { def, info };
}

/** `<repoDir>/packs/<pack>/<id>/manifest.yaml` 전부를 읽는다. 시작할 때 한 번 읽고 메모리에 둔다. */
export function loadPackCatalog(repoDir: string): PackCatalog {
  const packsDir = path.join(repoDir, 'packs');
  const entries = new Map<string, Entry>();
  if (existsSync(packsDir)) {
    for (const pack of readdirSync(packsDir, { withFileTypes: true })) {
      if (!pack.isDirectory()) continue;
      const packDir = path.join(packsDir, pack.name);
      for (const sc of readdirSync(packDir, { withFileTypes: true })) {
        const manifest = path.join(packDir, sc.name, 'manifest.yaml');
        if (!sc.isDirectory() || !existsSync(manifest)) continue;
        const e = buildEntry(repoDir, manifest);
        if (entries.has(e.def.id)) throw new Error(`시나리오 id 중복: ${e.def.id}`);
        entries.set(e.def.id, e);
      }
    }
  }
  const sorted = [...entries.values()].sort((a, b) => a.def.id.localeCompare(b.def.id));
  return {
    list: () => sorted.map((e) => e.def),
    get: (id) => entries.get(id)?.def,
    infos: () => sorted.map((e) => e.info),
    info: (id) => entries.get(id)?.info,
    learnSituations: (id) => {
      const s = entries.get(id)?.info.situations;
      return s ? (s as LearnSituation[]) : null;
    },
  };
}
