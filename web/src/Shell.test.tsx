import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Shell } from './Shell';

describe('Shell', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubEnv('VITE_MOCK', '1');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    location.hash = '';
  });

  it('탭 7개, 무대=시뮬레이션·비교=실측 배지', async () => {
    location.hash = '';
    render(<Shell />);
    expect(
      within(screen.getByRole('radiogroup', { name: '화면' })).getAllByRole('radio'),
    ).toHaveLength(7);
    expect(screen.getByTestId('source-badge')).toHaveTextContent('시뮬레이션');
    fireEvent.click(screen.getByRole('radio', { name: '비교' }));
    await waitFor(() => expect(screen.getByTestId('source-badge')).toHaveTextContent('실측'));
  });

  it('#run?scenario&situation 으로 열면 실행 설정이 열린다', async () => {
    location.hash = '#run?scenario=g02-stock-decrement&situation=none';
    render(<Shell />);
    expect(screen.getByRole('radio', { name: '실행 설정' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await act(async () => {});
    // 세션 해시(옛 형태)는 서버 속으로
    act(() => {
      location.hash = '#session=s1';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByRole('radio', { name: '서버 속' })).toHaveAttribute('aria-checked', 'true');
  });
});
