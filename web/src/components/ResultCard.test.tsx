import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RecordingNotice, RunSummary } from '../events/types';
import { buildRecording } from '../scenarios';
import { fmtDur, invariantLine, loadNote, resultFooter } from './lib/result';
import { ResultCard, type ResultCardProps } from './ResultCard';

const g01Summary: RunSummary = {
  measured: null,
  loadModel: 'closed',
  conflicts: 3,
  rejected423: 2,
  retries: 4,
  violations: 0,
  invariant: '불변식: 원장의 성공 수정 토큰이 모두 최종 이력에 있다',
  invariantSub: '원장의 성공 수정 토큰 = 최종 이력 (일치)',
};
const simNotice: RecordingNotice = {
  kind: 'simulated',
  label: '시뮬레이션 기록(실측 아님)',
  text: '생성 규칙으로 만든 기록이다.',
};
const base: ResultCardProps = {
  scenario: 'g01-shared-document',
  hasRec: true,
  running: false,
  violations: 0,
  counts: { conflicts: 1, rejects: 0, retries: 2, soldOut: 0 },
  atEnd: false,
  state: '일시정지',
  pred: null,
  summary: g01Summary,
  endLine: null,
  notice: simNotice,
};

describe('ResultCard', () => {
  it('정합성 위반 수가 맨 먼저(시뮬레이션 영역), 처리량·p95·실패율은 실측 영역', () => {
    render(<ResultCard {...base} violations={1} />);
    const labels = screen.getAllByText(/· 전체|정합성 위반/).map((e) => e.textContent);
    expect(labels[0]).toContain('정합성 위반');
    expect(screen.getByText('빠르지만 틀림 · 순위 제외')).toBeInTheDocument();
    expect(screen.getByTestId('zone-sim')).toHaveTextContent('시뮬레이션 · 재생 위치 기준');
    expect(within(screen.getByTestId('zone-sim')).getByText('시뮬레이션 기록(실측 아님)'));
    expect(screen.getByTestId('zone-meas')).toHaveTextContent('실측 · 기록 전체');
    expect(screen.getByText('처리량 · 전체')).toBeInTheDocument();
    // 재생 위치까지 센 409·423·재시도는 시뮬레이션 영역에
    expect(screen.getByTestId('sim-stat')).toHaveTextContent('409 1 · 423 0 · 재시도 2');
  });

  it('G01: 처리량·p95·실패율은 "— (실측 없음)", 배지도 실측 없음', () => {
    render(<ResultCard {...base} />);
    const meas = screen.getByTestId('zone-meas');
    expect(within(meas).getByText('실측 없음')).toBeInTheDocument();
    const nums = document.querySelectorAll('.res__m .res__num');
    expect(nums).toHaveLength(3);
    for (const n of nums) expect(n).toHaveTextContent('—(실측 없음)');
    expect(screen.queryByTestId('meas-src')).toBeNull();
  });

  it('G02 메모리 락 2대 몰림: 실측 중앙값·run id·조건, 품절은 시뮬레이션 영역, 판정 차이 문장', () => {
    const rec = buildRecording({
      scenario: 'g02-stock-decrement',
      strategy: 'app-memory-lock',
      instances: 2,
    });
    render(
      <ResultCard
        {...base}
        scenario="g02-stock-decrement"
        summary={rec.summary!}
        notice={rec.notice!}
        violations={1}
        counts={{ conflicts: 0, rejects: 0, retries: 0, soldOut: 1 }}
      />,
    );
    const m = rec.summary!.measured!;
    expect(within(screen.getByTestId('zone-meas')).getByText('learn.yaml 실측 3회 중앙값'));
    expect(screen.getByTestId('meas-src')).toHaveTextContent(m.run);
    expect(screen.getByTestId('meas-src')).toHaveTextContent('마감 직전 몰림 200 req/s · 서버 2대');
    expect(screen.getByTestId('sim-stat')).toHaveTextContent('품절 1');
    expect(screen.getByTestId('differs')).toHaveTextContent(
      '실측 3회 위반 0 — 이 장면은 드물게 나는 겹침을 고른 시뮬레이션',
    );
    // 노티스 본문도 렌더된다
    expect(screen.getByText(rec.notice!.text)).toBeInTheDocument();
    // 실패율 보조문은 품절이 아니라 실측 설명
    const fail = screen.getByText('실패율 · 전체').closest('.res__m')!;
    expect(fail).not.toHaveTextContent('품절');
    expect(fail).toHaveTextContent(m.failSub);
    expect(screen.getByText(/open 모델/)).toBeInTheDocument();
    expect(screen.queryByText(/closed 모델/)).toBeNull();
  });

  it('G02 행 잠금 주입: 실패율 보조문은 k6 드롭 설명, p95는 초 단위', () => {
    const rec = buildRecording({
      scenario: 'g02-stock-decrement',
      strategy: 'row-lock',
      instances: 1,
      injected: true,
    });
    render(
      <ResultCard
        {...base}
        scenario="g02-stock-decrement"
        summary={rec.summary!}
        notice={rec.notice!}
      />,
    );
    const fail = screen.getByText('실패율 · 전체').closest('.res__m')!;
    expect(fail).toHaveTextContent('19.8');
    expect(fail).toHaveTextContent('k6 dropped_iterations');
    expect(screen.queryByTestId('differs')).toBeNull();
  });

  it('위반이 없으면 정합성 통과, 불변식 보조문은 재생 위치까지의 판정', () => {
    render(<ResultCard {...base} />);
    expect(screen.getByText('정합성 통과')).toBeInTheDocument();
    expect(screen.getByText(/재생 위치까지 위반 없음/)).toBeInTheDocument();
  });

  it('기록 전이면 숫자는 —, 실행 전 배지', () => {
    render(
      <ResultCard
        {...base}
        hasRec={false}
        violations={null}
        counts={null}
        summary={null}
        notice={null}
      />,
    );
    expect(screen.getByTestId('violations')).toHaveTextContent('—');
    expect(screen.getByText('실행 전')).toBeInTheDocument();
  });

  it('예측 vs 실제: 재생 중엔 지금, 끝에서 적중/빗나감 + 요약 한 줄', () => {
    const { rerender } = render(<ResultCard {...base} pred={2} violations={1} />);
    expect(screen.getByTestId('pred')).toHaveTextContent('예측 2 · 지금 1');
    rerender(<ResultCard {...base} pred={2} violations={2} atEnd endLine="4라운드 중 위반 2건" />);
    expect(screen.getByTestId('pred')).toHaveTextContent('예측 2 · 실제 2 ✓ 적중');
    expect(screen.getByRole('status')).toHaveTextContent('4라운드 중 위반 2건');
    rerender(<ResultCard {...base} pred={0} violations={2} atEnd />);
    expect(screen.getByTestId('pred')).toHaveTextContent('✕ 빗나감');
  });

  it('위반이 늘 때만 깜박인다(되감기에는 반응하지 않음)', () => {
    const { rerender } = render(<ResultCard {...base} violations={0} />);
    expect(screen.getByTestId('res-primary')).not.toHaveClass('is-flash');
    rerender(<ResultCard {...base} violations={1} />);
    expect(screen.getByTestId('res-primary')).toHaveClass('is-flash');
  });
});

describe('결과 카드 문구 함수', () => {
  it('p95는 1초 미만 소수 둘째 자리', () => {
    expect(fmtDur(2.53)).toEqual({ n: '2.53', u: 'ms' });
    expect(fmtDur(33.81)).toEqual({ n: '33.81', u: 'ms' });
    expect(fmtDur(107)).toEqual({ n: '107', u: 'ms' });
    expect(fmtDur(7300)).toEqual({ n: '7.3', u: 's' });
  });

  it('불변식 보조문: 중간엔 재생 위치까지, 끝에선 기록 전체 판정', () => {
    const s = {
      ...g01Summary,
      violations: 2,
      invariantSub: '원장엔 커밋된 토큰이 최종 이력엔 없음',
    };
    expect(invariantLine(s, null, false, true)).toBe(s.invariant);
    expect(invariantLine(s, 0, false, true)).toBe(`${s.invariant} — 재생 위치까지 위반 없음`);
    expect(invariantLine(s, 1, false, true)).toBe(`${s.invariant} — 재생 위치까지 위반 1건`);
    expect(invariantLine(s, 2, true, true)).toBe('원장엔 커밋된 토큰이 최종 이력엔 없음');
  });

  it('closed 모델 문구는 G01(closed)에서만', () => {
    expect(loadNote(g01Summary, true)).toMatch(/closed 모델/);
    expect(loadNote({ ...g01Summary, loadModel: 'open' }, false)).toMatch(/open 모델/);
    expect(loadNote(null, false)).not.toMatch(/closed/);
  });

  it('푸터: 기록 종류·실측 여부에 따라 다르다', () => {
    const g02 = buildRecording({ scenario: 'g02-stock-decrement', strategy: 'no-lock' });
    const g01 = buildRecording({ scenario: 'g01-shared-document', strategy: 'naive-overwrite' });
    expect(resultFooter(false, null, null)).toMatch(/아직 기록이 없습니다/);
    const f2 = resultFooter(true, g02.notice!, g02.summary!);
    expect(f2).toMatch(/learn\.yaml 실측 3회 중앙값/);
    expect(f2).toContain(g02.summary!.measured!.run);
    expect(f2).toMatch(/위반·품절 수는 시뮬레이션 기록\(실측 아님\)/);
    const f1 = resultFooter(true, g01.notice!, g01.summary!);
    expect(f1).toMatch(/아직 실측이 없어 처리량·p95·실패율은 보이지 않습니다/);
    expect(f1).not.toMatch(/측정한/);
    expect(resultFooter(true, { kind: 'measured', label: '실측 기록', text: '' }, null)).toMatch(
      /실제 실행/,
    );
  });
});
