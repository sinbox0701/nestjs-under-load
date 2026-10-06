import type { RecordingNotice, RunSummary } from '../../events/types';

/** 지연 표시: 1초 미만은 소수 둘째 자리까지(예 2.53ms). */
export function fmtDur(ms: number): { n: string; u: string } {
  if (ms < 1000) return { n: String(+ms.toFixed(2)), u: 'ms' };
  if (ms < 60000) return { n: String(+(ms / 1000).toFixed(1)), u: 's' };
  return { n: String(+(ms / 60000).toFixed(1)), u: '분' };
}
export const fmtTput = (v: number) =>
  v >= 10 ? String(+v.toFixed(1)) : v >= 1 ? v.toFixed(1) : v.toFixed(2);

/**
 * 불변식 보조문: 재생 위치까지의 판정과 맞춘다.
 * 끝에서는 기록 전체 판정(invariantSub), 중간에서는 "재생 위치까지 위반 N건/없음".
 */
export function invariantLine(
  s: RunSummary | null,
  v: number | null,
  atEnd: boolean,
  g01: boolean,
) {
  const base =
    s?.invariant ??
    (g01
      ? '불변식: 원장의 성공 수정 토큰이 모두 최종 이력에 있다'
      : '불변식: 원장 성공 수량 = 실제 차감량');
  if (v === null || !s) return base;
  if (atEnd) return s.invariantSub ?? base;
  return `${base} — 재생 위치까지 ${v > 0 ? `위반 ${v}건` : '위반 없음'}`;
}

/** 부하 모델 해석 주의(closed는 G01, open은 G02 — 기록 요약이 정한다). */
export function loadNote(s: RunSummary | null, g01: boolean): string {
  const m = s?.loadModel ?? (g01 ? 'closed' : 'open');
  return m === 'closed'
    ? '지연은 해석 주의(closed 모델 · VU 고정)'
    : '부하는 도착률 고정(open 모델) · k6 드롭은 실패로 셈';
}

/** 페이지 아래 고지: 기록 종류(실측·시뮬레이션)와 실측 지표 유무에 따라 다르게 말한다. */
export function resultFooter(
  hasRec: boolean,
  notice: RecordingNotice | null,
  summary: RunSummary | null,
): string {
  const env = '로컬 단일 머신(Docker Desktop VM, CPU·메모리 limit 고정)';
  const scope = '처리 방식 간 상대 비교용이며 운영 환경의 처리 용량을 뜻하지 않습니다.';
  if (!hasRec)
    return `결과의 처리량·지연은 ${env}에서 잰 값으로, ${scope} 아직 기록이 없습니다 — 실행하기를 누르면 기록을 만듭니다.`;
  const m = summary?.measured ?? null;
  if (!notice || notice.kind === 'measured')
    return `이 기록은 실제 실행${m ? ` (run ${m.run})` : notice?.reference?.run ? ` (run ${notice.reference.run})` : ''}입니다. 숫자는 ${env}에서 측정한 값으로, ${scope}`;
  if (m)
    return `처리량·p95·실패율은 ${env}에서 측정한 ${m.source}(run ${m.run} · ${m.condition})이고, ${scope} 무대의 이벤트와 위반·품절 수는 ${notice.label}입니다.`;
  return `이 화면의 이벤트와 위반 수는 ${notice.label}이고, 아직 실측이 없어 처리량·p95·실패율은 보이지 않습니다. 실측 값은 ${env}에서 재며, ${scope}`;
}
