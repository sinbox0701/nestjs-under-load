/** 비교·기록 화면이 같이 쓰는 순수 계산. 화면 문구는 여기서 만들지 않는다(숫자·판정만). */
import type { BatchSummary, Spread } from '../../api';

/** DESIGN §3.1 기본 문구(그대로). 화면 하단에 항상 둔다. */
export const HONESTY_TEXT =
  '이 결과는 로컬 단일 머신(Docker Desktop VM, CPU·메모리 limit 고정)에서 처리 방식 간 상대 비교를 위해 측정한 값입니다. 운영 환경의 처리 용량을 뜻하지 않습니다.';

export type InvState = 'violated' | 'passed' | 'unknown';

export interface InvSummary {
  state: InvState;
  /** critical 불변식 위반 수 합(측정된 반복만). */
  violations: number;
  /** 위반이 나온 반복 번호(1부터). */
  failedReps: number[];
}

/** critical 불변식만 판정에 쓴다. info 는 판정에 넣지 않는다. 하나라도 위반이면 violated. */
export function invariantSummary(b: BatchSummary): InvSummary {
  const crit = b.invariants.filter((i) => i.severity === 'critical');
  let violations = 0;
  const failed = new Set<number>();
  let measured = 0;
  let total = 0;
  for (const inv of crit) {
    inv.passed.forEach((p, i) => {
      total += 1;
      if (p === null) return;
      measured += 1;
      if (p === false) failed.add(i + 1);
    });
    for (const v of inv.violations) if (v !== null) violations += v;
  }
  const state: InvState =
    failed.size > 0 ? 'violated' : total > 0 && measured === total ? 'passed' : 'unknown';
  return { state, violations, failedReps: [...failed].sort((a, z) => a - z) };
}

/** 무효 반복 사유(반복 번호와 함께). */
export function invalidReps(b: BatchSummary): { rep: number; reasons: string[] }[] {
  return b.validity.invalidReasons.flatMap((reasons, i) =>
    reasons.length > 0 ? [{ rep: i + 1, reasons }] : [],
  );
}

export function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 중앙값(최소–최대). 값이 없으면 "—". */
export function fmtSpread(s: Spread, unit = '', digits = 0): string {
  if (!s) return '—';
  const u = unit ? ` ${unit}` : '';
  return `${fmtNum(s.median, digits)}${u} (${fmtNum(s.min, digits)}–${fmtNum(s.max, digits)})`;
}

export interface RankEntry {
  batch: BatchSummary;
  /** 1부터. 제외된 배치는 null. */
  rank: number | null;
  inv: InvSummary;
  /** 위반이 있는데 처리량이 깨끗한 배치 이상이다 → "빠르지만 틀림". */
  fastButWrong: boolean;
  /** 순위에서 빠진 사유. 순위가 있으면 빈 배열. */
  excludedReasons: string[];
}

/** 처리량 순위. 유효 반복이 하나도 없는 배치·처리량이 없는 배치는 순위에서 뺀다(사유 표기). */
export function rankBatches(batches: BatchSummary[]): RankEntry[] {
  const entries: RankEntry[] = batches.map((batch) => {
    const inv = invariantSummary(batch);
    const reasons: string[] = [];
    if (batch.validity.validReps === 0) {
      const why = [...new Set(batch.validity.invalidReasons.flat())];
      reasons.push(why.length > 0 ? why.join(', ') : '유효한 반복 없음');
    } else if (!batch.throughputRps) {
      reasons.push('처리량 측정값 없음');
    }
    return { batch, rank: null, inv, fastButWrong: false, excludedReasons: reasons };
  });
  const ranked = entries
    .filter((e) => e.excludedReasons.length === 0)
    .sort((a, z) => z.batch.throughputRps!.median - a.batch.throughputRps!.median);
  ranked.forEach((e, i) => (e.rank = i + 1));
  const bestClean = Math.max(
    -Infinity,
    ...ranked.filter((e) => e.inv.state !== 'violated').map((e) => e.batch.throughputRps!.median),
  );
  for (const e of ranked) {
    e.fastButWrong = e.inv.state === 'violated' && e.batch.throughputRps!.median >= bestClean;
  }
  return entries;
}

export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
