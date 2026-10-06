import { STAGE_H, STAGE_W } from './model';

/** 무대 하단 줄 높이(배율과 무관한 고정값, §3.2). */
export const FOOT_H = 30;
/** 자동 멈춤 때 뜨는 트랜잭션 띠 요약 높이(고정, 늘 미리 비워 둔다). */
export const TXSUM_H = 58;
/** 넓은 화면 기준 폭(≥1120px이면 높이로도 제한). */
export const WIDE_MIN = 1120;

export interface ScaleInput {
  /** 무대 상자 가용 폭(CSS px). */
  availWidth: number;
  devicePixelRatio: number;
  /** 넓은 화면(≥1120)일 때만: 높이 제한 계산에 쓰는 값. */
  height?: {
    viewportHeight: number;
    /** 무대 상자의 문서 기준 위쪽(CSS px). */
    stageTop: number;
    /** 무대 아래 재생 바 높이(CSS px). */
    transportHeight: number;
  };
}

export interface StageScale {
  /** 논리 1px당 기기 픽셀 수(정수). */
  n: number;
  /** CSS 배율 = n / DPR. */
  K: number;
}

/**
 * 기기 픽셀 기준 정수 배율(DESIGN_SYSTEM §3.2).
 * n = floor(가용폭 × DPR / 256) (최대 4×DPR), K = n / DPR.
 * 넓은 화면에서는 nh = floor((뷰포트 − 무대 위 − 하단 줄 30 − 재생 바 − 띠 요약 58 − 4) × DPR / 192)로도 제한한다.
 *
 * 버그 수정판: **아래 시트(자동 멈춤 설명) 높이는 넣지 않는다.** 시트는 배율 < 2일 때만 뜨므로, 넣으면
 * "시트가 떠서 배율이 줄고 → 배율이 작아 시트가 계속 뜨는" 순환으로 ×1에 갇힌다. 그래서 이 함수는
 * 시트를 입력으로 받지 않는다. 띠 요약(58)은 고정 높이라 늘 미리 빼 둔다(멈출 때 배율이 바뀌지 않게).
 */
export function stageScale(input: ScaleInput): StageScale {
  const dpr = input.devicePixelRatio > 0 ? input.devicePixelRatio : 1;
  let n = Math.max(
    1,
    Math.min(Math.floor(4 * dpr), Math.floor((input.availWidth * dpr) / STAGE_W)),
  );
  if (input.height) {
    const h = input.height;
    const room = h.viewportHeight - h.stageTop - FOOT_H - h.transportHeight - TXSUM_H - 4;
    const nh = Math.floor((room * dpr) / STAGE_H);
    // 높이가 모자라도 기기 픽셀 1배(DPR 정수부, 최소 1)보다 작게는 줄이지 않는다.
    const floorN = Math.min(Math.max(1, Math.floor(dpr)), n);
    n = Math.max(floorN, Math.min(n, nh));
  }
  return { n, K: n / dpr };
}

/** 표시용 배율 글자(예: ×2, ×1.5). */
export function fmtScale(K: number): string {
  return `×${Number(K.toFixed(2))}`;
}
