import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from './lib/config';
import { KeysOverlay, RunControls, TopBar } from './TopBar';

describe('TopBar', () => {
  it('가짜 데이터 고지 칩, 단축키 — 화면 탭·테마 버튼은 셸 몫이라 없다', () => {
    const onKeys = vi.fn();
    render(
      <TopBar
        onKeys={onKeys}
        fakeNote="시뮬레이션 기록(실측 아님)"
      />,
    );
    expect(screen.getByText('시뮬레이션 기록(실측 아님)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /단축키/ }));
    expect(onKeys).toHaveBeenCalled();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: /테마/ })).toBeNull();
  });
});

describe('RunControls', () => {
  const setup = () => {
    const onCfg = vi.fn();
    const onRun = vi.fn();
    const onPred = vi.fn();
    render(
      <RunControls
        cfg={defaultConfig()}
        onCfg={onCfg}
        pred={null}
        onPred={onPred}
        running={false}
        onRun={onRun}
        onStop={vi.fn()}
      />,
    );
    return { onCfg, onRun, onPred };
  };

  it('처리 방식: 태그 배지, 준비 중은 건너뛰고 ←→로 이동', () => {
    const { onCfg } = setup();
    const group = screen.getByRole('radiogroup', { name: '처리 방식' });
    const merge = screen.getByRole('radio', { name: /필드 병합/ });
    expect(merge).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(merge);
    expect(onCfg).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: /덮어쓰기/ })).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onCfg).toHaveBeenLastCalledWith(expect.objectContaining({ strategy: 'edit-lease' }));
  });

  it('편집 시간 슬라이더는 편집 잠금에서만 진하게', () => {
    setup();
    expect(screen.getByLabelText('편집 시간 (사람) · 압축 ↔ 실제').closest('.field')).toHaveClass(
      'is-off',
    );
  });

  it('시나리오 G02로 바꾸면 그 시나리오 기본 설정', () => {
    const { onCfg } = setup();
    fireEvent.click(screen.getByRole('radio', { name: /재고 차감 경합/ }));
    expect(onCfg).toHaveBeenCalledWith(
      expect.objectContaining({ scenario: 'g02-stock-decrement', strategy: 'no-lock' }),
    );
  });

  it('예측 입력과 실행하기(진입점 하나)', () => {
    const { onRun, onPred } = setup();
    fireEvent.change(screen.getByPlaceholderText('—'), { target: { value: '3' } });
    expect(onPred).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole('button', { name: /실행하기/ }));
    expect(onRun).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /실행 중단/ })).toBeDisabled();
  });
});

describe('KeysOverlay', () => {
  it('dialog로 열리고 닫기 버튼에 포커스', () => {
    const onClose = vi.fn();
    render(<KeysOverlay onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: '단축키' })).toBeInTheDocument();
    expect(screen.getByText('속도: 아주 느리게 · 느리게 · 보통 · 빠르게')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /닫기/ })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: /닫기/ }));
    expect(onClose).toHaveBeenCalled();
  });

  it('Tab·Shift+Tab은 창 안에서만 돈다(포커스 트랩)', () => {
    render(<KeysOverlay onClose={vi.fn()} />);
    const close = screen.getByRole('button', { name: /닫기/ });
    const dialog = screen.getByRole('dialog');
    const tab = fireEvent.keyDown(close, { key: 'Tab' });
    expect(tab).toBe(false); // preventDefault
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(close).toHaveFocus();
    // 창 밖에 포커스가 있었어도 Shift+Tab은 창 안으로
    (document.body as HTMLElement).focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(close).toHaveFocus();
  });
});

describe('RunControls 실행 중 잠금', () => {
  it('실행 중엔 시나리오·처리 방식·옵션·편집 시간이 비활성, 클릭·방향키로 바뀌지 않는다', () => {
    const onCfg = vi.fn();
    render(
      <RunControls
        cfg={{ ...defaultConfig(), strategy: 'edit-lease' }}
        onCfg={onCfg}
        pred={null}
        onPred={vi.fn()}
        running
        onRun={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    const strat = screen.getByRole('radiogroup', { name: '처리 방식' });
    for (const b of strat.querySelectorAll('button')) expect(b).toBeDisabled();
    for (const g of screen.getAllByRole('radiogroup'))
      expect(g).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('slider')).toBeDisabled();
    fireEvent.click(screen.getAllByRole('radio', { name: /낙관|버전/ })[0]!);
    fireEvent.keyDown(strat, { key: 'ArrowRight' });
    expect(onCfg).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /실행 중단/ })).toBeEnabled();
  });

  it('편집 잠금 힌트: 연장(renew) 가정과 연장 경로 없음', () => {
    render(
      <RunControls
        cfg={{
          ...defaultConfig(),
          strategy: 'edit-lease',
          options: { ...defaultConfig().options, edit: 2 },
        }}
        onCfg={vi.fn()}
        pred={null}
        onPred={vi.fn()}
        running={false}
        onRun={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/연장\(renew\)한다고 가정 — 이 코드엔 연장 경로 없음/).length).toBe(
      1,
    );
  });
});
