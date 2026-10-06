/**
 * G02 재고 차감 경합 — 대표 시뮬레이션 기록.
 * 실제 실행 결과(runs/)는 gitignore라 웹에서 못 읽는다. 대신 learn.yaml의 상황 정의·실측 경향을 참고해
 * 대표 요청 4개를 결정적으로 시뮬레이션한다. 화면에는 notice로 "시뮬레이션 기록(실측 아님)"을 고지한다.
 * 코드 패널은 팩의 실제 strategy 소스를 번들하고, codeRef는 소스의 `// @event <phase>` 마커 줄을 가리킨다.
 */
import { phaseInfo } from '../../events/phases';
import type { CodeSource, Recording, RunEvent, RunSummary, Verdict } from '../../events/types';
import { G02_MEASURED, type G02Measured } from './measured';
import {
  G02_ACTORS,
  G02_STOCK0,
  G02_STRATEGIES,
  PACK_DIR,
  situationOf,
  type G02Options,
  type G02StrategyCode,
} from './model';
import { simulate } from './sim';

export * from './model';
export { G02_MEASURED, type G02Measured, type LearnVerdict } from './measured';

const sources = import.meta.glob<string>(
  '../../../../packs/generic/g02-stock-decrement/strategies/*.strategy.ts',
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
);

function sourceOf(code: G02StrategyCode): string {
  const hit = Object.entries(sources).find(([k]) => k.endsWith(`/${code}.strategy.ts`));
  if (!hit) throw new Error(`G02: ${code}.strategy.ts 원문을 번들에서 찾지 못함`);
  return hit[1];
}

/**
 * `// @event <phase…>` 마커 → 줄 번호(1부터). 같은 phase가 여러 줄이면 첫 줄,
 * 단 injected_delay는 경합 창 주입 지점(after-read) 줄을 쓴다.
 */
export function eventMarkers(source: string): Record<string, number> {
  const out: Record<string, number> = {};
  source.split('\n').forEach((line, idx) => {
    const m = /\/\/ @event ([^—]+)$/.exec(line);
    if (!m) return;
    for (const ph of m[1]!.trim().split(/\s+/)) {
      const prefer = ph === 'injected_delay' && line.includes("'after-read'");
      if (out[ph] === undefined || prefer) out[ph] = idx + 1;
    }
  });
  return out;
}

const CODE_CACHE = new Map<G02StrategyCode, CodeSource>();

/** 처리 방식별 코드(한 번 만들어 캐시 — 같은 code면 같은 객체라 화면 memo가 유지된다). */
export function g02Code(code: G02StrategyCode): CodeSource {
  let hit = CODE_CACHE.get(code);
  if (!hit) CODE_CACHE.set(code, (hit = makeG02Code(code)));
  return hit;
}

function makeG02Code(code: G02StrategyCode): CodeSource {
  const source = sourceOf(code);
  const path = `${PACK_DIR}/strategies/${code}.strategy.ts`;
  const cls = /export class (\w+)/.exec(source)?.[1];
  return {
    path,
    lang: 'ts',
    source,
    example: false,
    label: path,
    markers: eventMarkers(source),
    ...(cls ? { className: cls } : {}),
  };
}

export function measuredFor(
  strategy: G02StrategyCode,
  instances: 1 | 2,
  injected: boolean,
): G02Measured {
  const situation = situationOf(instances, injected);
  const m = G02_MEASURED.find((x) => x.strategy === strategy && x.situation === situation);
  if (!m) throw new Error(`G02: 실측 표에 ${strategy} × ${situation} 없음`);
  return m;
}

/** 원장 기반 판정(invariants.sql과 같은 정의, 대표 상품 1개). */
export function judgeLedger(
  ledger: Recording['ledger'],
  stock0: number,
  finalStock: number,
): Verdict {
  const sold = (ledger ?? [])
    .filter((x) => x.result === 'success')
    .reduce((s, x) => s + (x.qty ?? 0), 0);
  const decrement = stock0 - finalStock;
  const ids = (ledger ?? []).map((x) => x.requestId);
  const checks = {
    'no-negative-stock': finalStock < 0 ? 1 : 0,
    'sold-equals-decrement': Math.max(0, sold - decrement),
    'no-oversell': Math.max(0, sold - stock0),
    'no-duplicate-request-id': ids.length - new Set(ids).size,
  };
  const violations =
    checks['sold-equals-decrement'] +
    checks['no-negative-stock'] +
    checks['no-duplicate-request-id'];
  return {
    violations,
    ok: Object.values(checks).every((v) => v === 0),
    checks,
    detail: `원장 성공 ${sold}건 · 실제 차감 ${decrement} (재고 ${stock0} → ${finalStock})${
      checks['no-oversell'] ? ` · 초과 판매 ${checks['no-oversell']}` : ''
    }`,
  };
}

/** G02 phase 표시 덮어쓰기(scene.yaml phase 매핑에 해당). */
export const G02_PHASES: NonNullable<Recording['phases']> = {
  'custom:sold_out': {
    label: '품절 409',
    tone: 'wait',
    group: 'conflict',
    key: true,
    autoStop: false,
  },
  'custom:lost_update': { label: '잃어버린 갱신' },
};

export function buildG02Recording(opts: G02Options): Recording {
  const strategy = opts.strategy;
  const instances = opts.instances ?? 1;
  const injected = opts.injected ?? false;
  const st = G02_STRATEGIES.find((x) => x.code === strategy);
  if (!st) throw new Error(`G02: 모르는 처리 방식 ${strategy}`);
  const sim = simulate(strategy, instances, injected);
  const code = g02Code(strategy);
  const measured = measuredFor(strategy, instances, injected);
  const verdict = judgeLedger(sim.ledger, G02_STOCK0, sim.finalStock);

  const events: RunEvent[] = sim.events.map((e, k) => {
    const line = e.marker ? code.markers?.[e.marker] : undefined;
    const ev: RunEvent = { ...e, id: `g02#${k + 1}` };
    if (line !== undefined) ev.codeRef = `${code.path}:${line}`;
    else delete ev.marker;
    if (phaseInfo(e.phase).key) ev.mergeKey = e.actor; // 사람별 커밋·락을 따로 보인다
    return ev;
  });
  const last = events[events.length - 1]!;
  const sold = sim.ledger.filter((x) => x.result === 'success').length;
  const soldOut = sim.ledger.filter((x) => x.result === 'sold_out').length;
  const lockWaits = events.filter((e) => e.phase === 'lock_wait').length;
  const runs = measured.violations['sold-equals-decrement']!;
  const measuredBadRuns = runs.filter((x) => x > 0).length;

  const summary: RunSummary = {
    measured: {
      throughputRps: measured.throughputRps,
      p95Ms: measured.p95Ms,
      failPct: measured.failRatePct,
      p95Label: 'p95 지연',
      p95Sub: `${runs.length}회 중앙값 · 로컬 맥 상대 비교`,
      throughputSub:
        measuredBadRuns > 0
          ? `${runs.length}회 중앙값 · 실측 위반 ${measuredBadRuns}/${runs.length}회 — 빠르지만 틀림`
          : `${runs.length}회 중앙값`,
      failSub: measured.failWhy ?? `${runs.length}회 중앙값 · 서버 거절·k6 드롭 없음`,
      run: measured.run,
      condition: measured.situationLabel,
      source: `learn.yaml 실측 ${runs.length}회 중앙값`,
    },
    loadModel: 'open',
    // 품절은 정상 응답(409 품절)이라 충돌·실패에 섞지 않고 soldOut으로 따로 센다.
    conflicts: 0,
    rejected423: 0,
    retries: 0,
    soldOut,
    violations: verdict.violations,
    invariant: '불변식: 원장 성공 수량 = 실제 차감량 · 재고보다 많이 팔지 않음',
    invariantSub: verdict.ok ? '원장 성공 수량 = 실제 차감량 (일치)' : verdict.detail,
  };

  // 판정 방향: 시뮬레이션(이 기록의 원장) vs 실측(learn.yaml 3회 중 위반이 난 회수)
  const simBroken = !verdict.ok;
  const differs =
    simBroken && measuredBadRuns === 0
      ? `실측 ${runs.length}회 위반 0 — 이 장면은 드물게 나는 겹침을 고른 시뮬레이션이다${
          measured.verdict === 'broken' ? ' (막는 장치가 없어 learn.yaml 판정은 broken)' : ''
        }.`
      : !simBroken && measuredBadRuns > 0
        ? `실측 ${runs.length}회 중 ${measuredBadRuns}회 위반 — 이 장면은 겹치지 않은 순서를 고른 시뮬레이션이다.`
        : undefined;

  return {
    meta: {
      runId: `sim_g02_${strategy}_i${instances}${injected ? '_cw30' : ''}`,
      pack: 'generic',
      scenario: 'g02-stock-decrement',
      scenarioTitle: '재고 차감 경합',
      strategy: { id: strategy, label: st.label, kind: st.kind },
      sceneType: 'queue-at-counter',
      actors: [...G02_ACTORS],
      totalActors: G02_ACTORS.length,
      isolation: 'READ COMMITTED',
      route: 'POST /g02/orders',
      durationMs: Math.ceil(last.t + 4),
      autoStopDelayMs: 0,
      actorLabels: Object.fromEntries(G02_ACTORS.map((a) => [a, a])),
      actorInstances: Object.fromEntries(
        G02_ACTORS.map((a, i) => [a, `app-${instances === 1 ? 1 : (i % 2) + 1}`]),
      ),
      options: { strategy, instances, injected, situation: measured.situation },
    },
    events,
    code,
    txBands: sim.bands,
    txMarks: sim.marks,
    summary,
    ledger: sim.ledger,
    verdict,
    notice: {
      kind: 'simulated',
      label: '시뮬레이션 기록(실측 아님)',
      text:
        `대표 요청 ${G02_ACTORS.length}개(같은 상품, 재고 ${G02_STOCK0})가 처리되는 순서를 learn.yaml 상황 「${measured.situationLabel}」에 맞춰 ` +
        `시뮬레이션한 기록이다. 이벤트 시각·순서는 실측이 아니고, 위반 판정은 이 기록의 원장으로 했다(성공 ${sold}건, 품절 ${soldOut}건, 락 대기 ${lockWaits}회). ` +
        `결과 카드의 처리량·p95·실패율은 learn.yaml 실측 중앙값(run ${measured.run})이다.` +
        (differs ? ` ${differs}` : ''),
      reference: { run: measured.run, summary: measured.summary, verdict: measured.verdict },
      ...(differs ? { differs } : {}),
    },
    phases: G02_PHASES,
  };
}
