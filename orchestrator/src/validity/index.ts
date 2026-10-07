// k6 결과 유효성 판정(DESIGN §7.2). run.mjs judgeValidity·k6CpuUsage 이식: 순수 함수라 I/O 없음.
import type { K6JobStatus } from '@under-load/contracts';

import type { ValidityInput, ValidityVerdict } from '../ports.js';

/** k6 CPU 포화 임계(limit 대비 평균 사용률, 스로틀된 CFS 주기 비율). */
export const K6_CPU_LIMITS = Object.freeze({ avgRatio: 0.8, throttledPeriodRatio: 0.2 });

/** k6 기간 문자열(`1m30s`, `500ms` 같은 복합 포함) → 초. 형식이 틀리면 throw. */
export function durationToSeconds(d: string): number {
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/gy;
  const unit = { ms: 0.001, s: 1, m: 60, h: 3600 } as const;
  let total = 0;
  let end = 0;
  for (let m = re.exec(d); m; m = re.exec(d)) {
    total += Number(m[1]) * unit[m[2] as keyof typeof unit];
    end = re.lastIndex;
  }
  if (end === 0 || end !== d.length) throw new Error(`기간 형식 오류: ${d}`);
  return total;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** 실행기가 잰 전후 cpu.stat 차이 → 평균 사용률(limit 대비)·스로틀 비율. 계산할 수 없으면 null. */
export function k6CpuUsage(k6: K6JobStatus): Record<string, unknown> | null {
  const { before, after, cpuMaxCores } = k6.cpu;
  if (!before || !after || !k6.endedAt) return null;
  const wallMs = Date.parse(k6.endedAt) - Date.parse(k6.startedAt);
  if (!(wallMs > 0)) return null;
  const usageSec = (after.usageUsec - before.usageUsec) / 1e6;
  const periods = after.nrPeriods - before.nrPeriods;
  return {
    method: 'cgroup-v2 cpu.stat delta(k6 기동 포함 job 전체 구간 평균)',
    cores: cpuMaxCores,
    wallSec: round(wallMs / 1000),
    usageSec: round(usageSec),
    avgRatio: cpuMaxCores ? round(usageSec / (wallMs / 1000) / cpuMaxCores) : null,
    throttledPeriodRatio: periods > 0 ? round((after.nrThrottled - before.nrThrottled) / periods) : 0,
  };
}

export function judgeValidity(input: ValidityInput): ValidityVerdict {
  const { request, summary, k6, scrapeGaps } = input;
  const reasons: string[] = [];

  const k6Cpu = k6CpuUsage(k6);
  const avgRatio = (k6Cpu?.avgRatio as number | null | undefined) ?? null;
  const throttled = (k6Cpu?.throttledPeriodRatio as number | undefined) ?? 0;
  if (k6Cpu && ((avgRatio !== null && avgRatio >= K6_CPU_LIMITS.avgRatio) || throttled >= K6_CPU_LIMITS.throttledPeriodRatio)) {
    reasons.push(
      `k6 CPU 포화: 평균 ${avgRatio}×limit(임계 ${K6_CPU_LIMITS.avgRatio}), 스로틀 주기 ${throttled}(임계 ${K6_CPU_LIMITS.throttledPeriodRatio}) → 측정 대상이 SUT가 아니라 k6`,
    );
  }

  const { load } = request;
  let droppedCountedAsFailure: boolean | null = null;
  if (load.model === 'open') {
    const needed = (load.rate ?? 0) * durationToSeconds(load.requestTimeout);
    droppedCountedAsFailure = load.maxVUs !== null && load.maxVUs >= needed;
    if (summary.dropped > 0 && !droppedCountedAsFailure) {
      reasons.push(`dropped_iterations=${summary.dropped}, maxVUs(${load.maxVUs}) < rate×timeout(${needed}) → 설정 부족`);
    }
  }

  if (summary.requests === 0) reasons.push('k6 요청 0건');
  if (scrapeGaps !== null && scrapeGaps > 0) reasons.push(`스크레이프 누락 ${scrapeGaps}구간 → 관측값 신뢰 불가`);

  return {
    valid: reasons.length === 0,
    reasons,
    k6CpuAvgRatio: avgRatio,
    droppedCountedAsFailure,
    failuresTotal: summary.httpFailures + (droppedCountedAsFailure ? summary.dropped : 0),
    k6Cpu,
  };
}
