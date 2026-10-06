import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

const key = (k: string) => act(() => void fireEvent.keyDown(window, { key: k }));

describe('App(무대 화면 배치)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('실행하기 → 기록 만들기 → 재생, 키보드로 단계·멈춤·비교·도움말', async () => {
    render(<App />);
    // 기록 전: 재생 바 비활성, 결과는 —
    expect(screen.getByRole('button', { name: '재생 (Space)' })).toBeDisabled();
    expect(screen.getByTestId('violations')).toHaveTextContent('—');

    // Enter = 실행하기(진입점 하나). R1..R4 동안 실행 중.
    key('Enter');
    expect(screen.getByRole('button', { name: /실행 중단/ })).toBeEnabled();
    await act(async () => void vi.advanceTimersByTime(260 * 4 + 10));
    expect(screen.getByRole('button', { name: /실행 중단/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: '일시정지 (Space)' })).toBeInTheDocument();
    expect(screen.getAllByText(/시뮬레이션 기록\(실측 아님\)/).length).toBeGreaterThan(0);

    // Space 일시정지 → → 단계 이동
    key(' ');
    expect(screen.getByRole('button', { name: '재생 (Space)' })).toBeInTheDocument();
    key('ArrowRight');
    key('ArrowRight');
    expect(screen.getByTestId('violations')).not.toHaveTextContent('—');
    const timeline = screen.getByRole('region', { name: '이벤트 타임라인' });
    expect(within(timeline).getByRole('listitem', { current: 'step' })).toBeInTheDocument();

    // 1~4 속도
    key('4');
    expect(screen.getByRole('radio', { name: '빠르게' })).toHaveAttribute('aria-checked', 'true');
    // C 코드 비교
    key('c');
    expect(screen.getByRole('button', { name: /비교/ })).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelectorAll('[data-side]')).toHaveLength(2);
    // ? 도움말, Esc 닫기
    key('?');
    expect(screen.getByRole('dialog', { name: '단축키' })).toBeInTheDocument();
    key('Escape');
    expect(screen.queryByRole('dialog')).toBeNull();
    // End까지 → 끝 요약 한 줄
    for (let i = 0; i < 80; i++) key('ArrowRight');
    expect(screen.getByRole('button', { name: '다시 보기 (Space)' })).toBeInTheDocument();
    expect(screen.getAllByText(/4라운드 중 위반 \d+건/).length).toBeGreaterThan(0);
  });

  it('실행(기록 만드는 중)에는 설정·S 키가 잠기고, 만든 기록은 실행 시작 때 설정 그대로', async () => {
    render(<App />);
    const strat = () => screen.getByRole('radiogroup', { name: '처리 방식' });
    const checked = () => within(strat()).getByRole('radio', { checked: true }).textContent;
    const before = checked();
    key('Enter');
    expect(within(strat()).getAllByRole('radio')[0]).toBeDisabled();
    key('s');
    expect(checked()).toBe(before);
    fireEvent.click(within(strat()).getAllByRole('radio')[2]!);
    expect(checked()).toBe(before);
    await act(async () => void vi.advanceTimersByTime(260 * 4 + 10));
    // 실행이 끝나면 다시 바꿀 수 있다
    expect(within(strat()).getAllByRole('radio')[0]).toBeEnabled();
    key('s');
    expect(checked()).not.toBe(before);
  });

  it('G01 결과 카드: 처리량·p95·실패율은 — (실측 없음), G02는 실측 중앙값 + 대표 요청 끝 줄', async () => {
    render(<App />);
    key('Enter');
    await act(async () => void vi.advanceTimersByTime(260 * 4 + 10));
    key(' ');
    const nums = () =>
      [...document.querySelectorAll('.res__m .res__num')].map((n) => n.textContent);
    expect(nums()).toEqual(['—(실측 없음)', '—(실측 없음)', '—(실측 없음)']);
    expect(screen.getByTestId('foot')).toHaveTextContent('아직 실측이 없어');
    // G02로 바꾸면 같은 화면에서 기록을 다시 만든다
    fireEvent.click(screen.getByRole('radio', { name: /재고 차감 경합/ }));
    expect(nums()[1]).toMatch(/^\d+(\.\d{1,2})?ms$/);
    expect(screen.getByTestId('zone-meas')).toHaveTextContent('learn.yaml 실측 3회 중앙값');
    expect(screen.getByTestId('foot')).toHaveTextContent('learn.yaml 실측 3회 중앙값');
    for (let i = 0; i < 80; i++) key('ArrowRight');
    expect(screen.getAllByText(/대표 요청 4개 중 위반 \d+건 · 품절 \d+/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/1라운드 중/)).toBeNull();
  });
});
