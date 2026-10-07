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

  it('테마: 셸 버튼 → T 키 → 셸 버튼이 하나의 상태로 일관되게 순환한다', () => {
    location.hash = '';
    localStorage.removeItem('nul.theme');
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    render(<Shell />);
    const btn = () => screen.getByRole('button', { name: /^테마:/ });
    expect(screen.getAllByRole('button', { name: /^테마:/ })).toHaveLength(1);
    expect(btn()).toHaveTextContent('시스템');
    fireEvent.click(btn()); // system → light
    expect(btn()).toHaveTextContent('라이트');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    fireEvent.keyDown(window, { key: 't' }); // light → dark
    expect(btn()).toHaveTextContent('다크');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    fireEvent.click(btn()); // dark → system
    expect(btn()).toHaveTextContent('시스템');
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    fireEvent.keyDown(window, { key: 'T' }); // system(밝음) → dark
    expect(btn()).toHaveTextContent('다크');
    fireEvent.keyDown(window, { key: 't' }); // dark → light
    expect(btn()).toHaveTextContent('라이트');
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
