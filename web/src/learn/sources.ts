import { buildScenarios, type RawFiles } from './loader';

/*
 * 빌드 시 레포의 packs/<pack>/<scenario>/ 파일을 원문(raw) 그대로 번들한다.
 * 깊이를 고정(*\/*)해 node_modules·dist를 훑지 않는다. 개발 서버는 vite server.fs.allow로 레포 루트를 연다.
 */
const packGlob = import.meta.glob<string>(
  [
    '../../../packs/*/*/learn.yaml',
    '../../../packs/*/*/manifest.yaml',
    '../../../packs/*/*/invariants.sql',
    '../../../packs/*/*/strategies/*.strategy.ts',
    '../../../packs/*/*/entities/*.ts',
    '../../../packs/*/*/k6/template.js',
  ],
  { query: '?raw', import: 'default', eager: true },
);

const fixtureGlob = import.meta.glob<string>(
  ['./fixtures/*/*/learn.yaml', './fixtures/*/*/strategies/*.strategy.ts'],
  { query: '?raw', import: 'default', eager: true },
);

function rebase(files: Record<string, string>, prefix: string): RawFiles {
  const out: RawFiles = {};
  for (const [k, v] of Object.entries(files)) {
    const i = k.indexOf(prefix);
    if (i >= 0) out[k.slice(i + prefix.length)] = v;
  }
  return out;
}

export const packFiles = rebase(packGlob, '/packs/');
export const fixtureFiles = rebase(fixtureGlob, '/fixtures/');
export const scenarios = buildScenarios(packFiles, fixtureFiles);
