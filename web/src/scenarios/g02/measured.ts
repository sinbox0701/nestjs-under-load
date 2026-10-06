/**
 * G02 실측 요약 — packs/generic/g02-stock-decrement/learn.yaml outcomes[].measured에서 옮긴 값(2026-10-07).
 * 웹에서 runs/를 못 읽어서(gitignore) 표만 둔다. learn.yaml과 어긋나면 g02.test.ts가 깨진다.
 */
import type { G02Situation, G02StrategyCode } from './model';

export type LearnVerdict = 'ok' | 'broken' | 'slow' | 'rejects';

export interface G02Measured {
  strategy: G02StrategyCode;
  situation: G02Situation;
  situationLabel: string;
  verdict: LearnVerdict;
  run: string;
  summary: string;
  throughputRps: number;
  p95Ms: number;
  failRatePct: number;
  violations: Record<string, number[]>;
  ledgerSuccess: number[];
  /**
   * 실패율이 0이 아닐 때 무엇을 셌는지(learn.yaml why에서 요약). 결과 카드 실패율 보조문.
   * 실패율이 0이면 비운다(g02.test.ts가 짝을 검사).
   */
  failWhy?: string;
}

const K6_DROP = (server: string, vus: string | null) =>
  `k6 dropped_iterations · 서버 거절 아님(${server}) · 규칙상 실패로 셈 — 응답이 늦어 VU 할당이 못 따라감${vus ? `(vus_max ${vus} < maxVUs 2000)` : ''}`;

export const G02_MEASURED: readonly G02Measured[] = [
  {
    strategy: 'no-lock',
    situation: 'spike-200-one-instance',
    situationLabel: '몰림 200 req/s · 서버 1대',
    verdict: 'broken',
    run: '2026-10-06T16-20-36Z_g02_no-lock_i1',
    summary:
      '위반 1/3회 발생(sold-equals-decrement 상품 1·0·0개, no-oversell 상품 1·0·0개) · 원장 성공 501·500·500건 / 총재고 500 · 처리량 200 req/s(200~200.1) · p95 2.84ms(2.83~2.97) · 실패율 0%(0~0) · 로컬 맥 상대 비교',
    throughputRps: 200,
    p95Ms: 2.84,
    failRatePct: 0,
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [1, 0, 0],
      'no-oversell': [1, 0, 0],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [501, 500, 500],
  },
  {
    strategy: 'no-lock',
    situation: 'spike-200-two-instances',
    situationLabel: '마감 직전 몰림 200 req/s · 서버 2대',
    verdict: 'broken',
    run: '2026-10-06T16-20-36Z_g02_no-lock_i2',
    summary:
      '위반 1/3회 발생(sold-equals-decrement 상품 0·0·1개, no-oversell 상품 0·0·1개) · 원장 성공 500·500·501건 / 총재고 500 · 처리량 200.1 req/s(200.1~200.1) · p95 2.93ms(2.89~3.21) · 실패율 0%(0~0) · 로컬 맥 상대 비교',
    throughputRps: 200.1,
    p95Ms: 2.93,
    failRatePct: 0,
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [0, 0, 1],
      'no-oversell': [0, 0, 1],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [500, 500, 501],
  },
  {
    strategy: 'no-lock',
    situation: 'contention-window-30-one-instance',
    situationLabel: '경합 창 30ms 주입 · 서버 1대',
    verdict: 'broken',
    run: '2026-10-06T16-42-09Z_g02_no-lock_i1',
    summary:
      '경합 창 30ms 주입됨 · 위반 3/3회 발생(sold-equals-decrement 상품 5·5·5개, no-oversell 상품 5·5·5개) · 원장 성공 1098·1101·1115건 / 총재고 500 · 처리량 200 req/s(200~200.1) · p95 33.81ms(33.68~34.3) · 실패율 0%(0~0) · 로컬 맥 상대 비교',
    throughputRps: 200,
    p95Ms: 33.81,
    failRatePct: 0,
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [5, 5, 5],
      'no-oversell': [5, 5, 5],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [1098, 1101, 1115],
  },
  {
    strategy: 'no-lock',
    situation: 'contention-window-30-two-instances',
    situationLabel: '경합 창 30ms 주입 · 서버 2대',
    verdict: 'broken',
    run: '2026-10-06T16-42-09Z_g02_no-lock_i2',
    summary:
      '경합 창 30ms 주입됨 · 위반 3/3회 발생(sold-equals-decrement 상품 5·5·5개, no-oversell 상품 5·5·5개) · 원장 성공 1083·1114·1097건 / 총재고 500 · 처리량 200.1 req/s(200~200.1) · p95 33.9ms(33.81~33.97) · 실패율 0%(0~0) · 로컬 맥 상대 비교',
    throughputRps: 200.1,
    p95Ms: 33.9,
    failRatePct: 0,
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [5, 5, 5],
      'no-oversell': [5, 5, 5],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [1083, 1114, 1097],
  },
  {
    strategy: 'row-lock',
    situation: 'spike-200-one-instance',
    situationLabel: '몰림 200 req/s · 서버 1대',
    verdict: 'ok',
    run: '2026-10-06T16-20-36Z_g02_row-lock_i1',
    summary:
      '위반 0 (3/3회) · 원장 성공 500·500·500건 / 총재고 500 · 처리량 200.1 req/s(200~200.1) · p95 2.67ms(2.62~2.86) · 실패율 0%(0~0) · 로컬 맥 상대 비교',
    throughputRps: 200.1,
    p95Ms: 2.67,
    failRatePct: 0,
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [0, 0, 0],
      'no-oversell': [0, 0, 0],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [500, 500, 500],
  },
  {
    strategy: 'row-lock',
    situation: 'spike-200-two-instances',
    situationLabel: '마감 직전 몰림 200 req/s · 서버 2대',
    verdict: 'ok',
    run: '2026-10-06T16-20-36Z_g02_row-lock_i2',
    summary:
      '위반 0 (3/3회) · 원장 성공 500·500·500건 / 총재고 500 · 처리량 200.1 req/s(200~200.1) · p95 2.62ms(2.5~2.86) · 실패율 0%(0~0) · 로컬 맥 상대 비교',
    throughputRps: 200.1,
    p95Ms: 2.62,
    failRatePct: 0,
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [0, 0, 0],
      'no-oversell': [0, 0, 0],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [500, 500, 500],
  },
  {
    strategy: 'row-lock',
    situation: 'contention-window-30-one-instance',
    situationLabel: '경합 창 30ms 주입 · 서버 1대',
    verdict: 'slow',
    run: '2026-10-06T16-42-09Z_g02_row-lock_i1',
    summary:
      '경합 창 30ms 주입됨 · 위반 0 (3/3회) · 원장 성공 500·500·500건 / 총재고 500 · 처리량 160.5 req/s(160.1~161.7) · p95 7298.96ms(7297.27~7782.41) · 실패율 19.77%(19.2~19.97) · 로컬 맥 상대 비교',
    throughputRps: 160.5,
    p95Ms: 7298.96,
    failRatePct: 19.77,
    failWhy: K6_DROP('503 0건', '약 850'),
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [0, 0, 0],
      'no-oversell': [0, 0, 0],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [500, 500, 500],
  },
  {
    strategy: 'row-lock',
    situation: 'contention-window-30-two-instances',
    situationLabel: '경합 창 30ms 주입 · 서버 2대',
    verdict: 'slow',
    run: '2026-10-06T16-42-09Z_g02_row-lock_i2',
    summary:
      '경합 창 30ms 주입됨 · 위반 0 (3/3회) · 원장 성공 500·500·500건 / 총재고 500 · 처리량 168.8 req/s(168.7~169.9) · p95 5383.44ms(5071.74~5454.59) · 실패율 15.6%(15.07~15.67) · 로컬 맥 상대 비교',
    throughputRps: 168.8,
    p95Ms: 5383.44,
    failRatePct: 15.6,
    failWhy: K6_DROP('503 0건', null),
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [0, 0, 0],
      'no-oversell': [0, 0, 0],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [500, 500, 500],
  },
  {
    strategy: 'conditional-update',
    situation: 'spike-200-one-instance',
    situationLabel: '몰림 200 req/s · 서버 1대',
    verdict: 'ok',
    run: '2026-10-06T16-20-36Z_g02_conditional-update_i1',
    summary:
      '위반 0 (3/3회) · 원장 성공 500·500·500건 / 총재고 500 · 처리량 200.1 req/s(200~200.1) · p95 2.53ms(2.5~2.78) · 실패율 0%(0~0) · 로컬 맥 상대 비교',
    throughputRps: 200.1,
    p95Ms: 2.53,
    failRatePct: 0,
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [0, 0, 0],
      'no-oversell': [0, 0, 0],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [500, 500, 500],
  },
  {
    strategy: 'conditional-update',
    situation: 'spike-200-two-instances',
    situationLabel: '마감 직전 몰림 200 req/s · 서버 2대',
    verdict: 'ok',
    run: '2026-10-06T16-20-36Z_g02_conditional-update_i2',
    summary:
      '위반 0 (3/3회) · 원장 성공 500·500·500건 / 총재고 500 · 처리량 200.1 req/s(200.1~200.1) · p95 2.51ms(2.48~2.57) · 실패율 0%(0~0) · 로컬 맥 상대 비교',
    throughputRps: 200.1,
    p95Ms: 2.51,
    failRatePct: 0,
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [0, 0, 0],
      'no-oversell': [0, 0, 0],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [500, 500, 500],
  },
  {
    strategy: 'conditional-update',
    situation: 'contention-window-30-one-instance',
    situationLabel: '경합 창 30ms 주입 · 서버 1대',
    verdict: 'ok',
    run: '2026-10-06T16-42-09Z_g02_conditional-update_i1',
    summary:
      '경합 창 30ms 주입됨 · 위반 0 (3/3회) · 원장 성공 500·500·500건 / 총재고 500 · 처리량 200.1 req/s(200.1~200.1) · p95 33.94ms(33.89~34.13) · 실패율 0%(0~0) · 로컬 맥 상대 비교',
    throughputRps: 200.1,
    p95Ms: 33.94,
    failRatePct: 0,
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [0, 0, 0],
      'no-oversell': [0, 0, 0],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [500, 500, 500],
  },
  {
    strategy: 'conditional-update',
    situation: 'contention-window-30-two-instances',
    situationLabel: '경합 창 30ms 주입 · 서버 2대',
    verdict: 'ok',
    run: '2026-10-06T16-42-09Z_g02_conditional-update_i2',
    summary:
      '경합 창 30ms 주입됨 · 위반 0 (3/3회) · 원장 성공 500·500·500건 / 총재고 500 · 처리량 200.1 req/s(200.1~200.1) · p95 33.75ms(33.72~33.83) · 실패율 0%(0~0) · 로컬 맥 상대 비교',
    throughputRps: 200.1,
    p95Ms: 33.75,
    failRatePct: 0,
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [0, 0, 0],
      'no-oversell': [0, 0, 0],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [500, 500, 500],
  },
  {
    strategy: 'app-memory-lock',
    situation: 'spike-200-one-instance',
    situationLabel: '몰림 200 req/s · 서버 1대',
    verdict: 'ok',
    run: '2026-10-06T16-20-36Z_g02_app-memory-lock_i1',
    summary:
      '위반 0 (3/3회) · 원장 성공 500·500·500건 / 총재고 500 · 처리량 200.1 req/s(200.1~200.1) · p95 2.79ms(2.62~2.94) · 실패율 0%(0~0) · 로컬 맥 상대 비교',
    throughputRps: 200.1,
    p95Ms: 2.79,
    failRatePct: 0,
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [0, 0, 0],
      'no-oversell': [0, 0, 0],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [500, 500, 500],
  },
  {
    strategy: 'app-memory-lock',
    situation: 'spike-200-two-instances',
    situationLabel: '마감 직전 몰림 200 req/s · 서버 2대',
    verdict: 'broken',
    run: '2026-10-06T16-20-36Z_g02_app-memory-lock_i2',
    summary:
      '위반 0 (3/3회) · 원장 성공 500·500·500건 / 총재고 500 · 처리량 200.1 req/s(200.1~200.1) · p95 2.72ms(2.61~2.76) · 실패율 0%(0~0) · 로컬 맥 상대 비교',
    throughputRps: 200.1,
    p95Ms: 2.72,
    failRatePct: 0,
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [0, 0, 0],
      'no-oversell': [0, 0, 0],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [500, 500, 500],
  },
  {
    strategy: 'app-memory-lock',
    situation: 'contention-window-30-one-instance',
    situationLabel: '경합 창 30ms 주입 · 서버 1대',
    verdict: 'slow',
    run: '2026-10-06T16-42-09Z_g02_app-memory-lock_i1',
    summary:
      '경합 창 30ms 주입됨 · 위반 0 (3/3회) · 원장 성공 500·500·500건 / 총재고 500 · 처리량 172.7 req/s(172.4~173.2) · p95 4672.62ms(4594.97~4852.42) · 실패율 13.68%(13.45~13.82) · 로컬 맥 상대 비교',
    throughputRps: 172.7,
    p95Ms: 4672.62,
    failRatePct: 13.68,
    failWhy: K6_DROP('503·에러 0건', '약 800'),
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [0, 0, 0],
      'no-oversell': [0, 0, 0],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [500, 500, 500],
  },
  {
    strategy: 'app-memory-lock',
    situation: 'contention-window-30-two-instances',
    situationLabel: '경합 창 30ms 주입 · 서버 2대',
    verdict: 'broken',
    run: '2026-10-06T16-42-09Z_g02_app-memory-lock_i2',
    summary:
      '경합 창 30ms 주입됨 · 위반 3/3회 발생(sold-equals-decrement 상품 5·5·5개, no-oversell 상품 5·5·5개) · 원장 성공 801·785·780건 / 총재고 500 · 처리량 200.1 req/s(200.1~200.1) · p95 107.1ms(105.68~119.29) · 실패율 0%(0~0) · 로컬 맥 상대 비교',
    throughputRps: 200.1,
    p95Ms: 107.1,
    failRatePct: 0,
    violations: {
      'no-negative-stock': [0, 0, 0],
      'sold-equals-decrement': [5, 5, 5],
      'no-oversell': [5, 5, 5],
      'no-duplicate-request-id': [0, 0, 0],
    },
    ledgerSuccess: [801, 785, 780],
  },
];
