import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResultCard } from './ResultCard';

describe('ResultCard', () => {
  it('위반이 있으면 빠르지만 틀림 배지를 단다', () => {
    render(<ResultCard counters={{ violations: 1, conflicts: 0, retries: 0 }} metrics={null} />);
    expect(screen.getByText('빠르지만 틀림 · 순위 제외')).toBeInTheDocument();
  });

  it('위반이 없으면 정합성 통과', () => {
    render(<ResultCard counters={{ violations: 0, conflicts: 2, retries: 2 }} metrics={null} />);
    expect(screen.getByText('정합성 통과')).toBeInTheDocument();
    expect(screen.getByText('409 2 · 재시도 2')).toBeInTheDocument();
  });
});
