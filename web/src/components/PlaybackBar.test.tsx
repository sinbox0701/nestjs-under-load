import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlaybackBar, type PlaybackBarProps } from './PlaybackBar';

const rounds = [
  { index: 0, start: 0, end: 100, baseVersion: 7, endVersion: 9 },
  { index: 1, start: 100, end: 200, baseVersion: 9, endVersion: 11 },
];
function props(o: Partial<PlaybackBarProps> = {}): PlaybackBarProps {
  return {
    hasRec: true,
    runStep: null,
    rounds,
    P: 116,
    total: 200,
    playing: false,
    paused: false,
    speed: 0.25,
    ff: true,
    auto: true,
    autoCause: true,
    folded: [{ a: 20, b: 60 }],
    ticks: [{ t: 50, tone: 'bad' }],
    endSummary: '2라운드 중 위반 1건 · 409 0 · 423 0',
    onPlayToggle: vi.fn(),
    onFirst: vi.fn(),
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onSeek: vi.fn(),
    onSpeed: vi.fn(),
    onToggleFF: vi.fn(),
    onToggleAuto: vi.fn(),
    onToggleCause: vi.fn(),
    ...o,
  };
}

describe('PlaybackBar', () => {
  it('속도 라벨 4개(기본 느리게), 1/N 툴팁만', () => {
    const p = props();
    render(<PlaybackBar {...p} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['아주 느리게', '느리게', '보통', '빠르게']);
    expect(screen.getByRole('radio', { name: '느리게' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '아주 느리게' })).toHaveAttribute(
      'title',
      '실제의 1/400 속도',
    );
    fireEvent.click(screen.getByRole('radio', { name: '빠르게' }));
    expect(p.onSpeed).toHaveBeenCalledWith(1);
  });

  it('시계는 R1/4 형식(라운드 기준), 기준 문장', () => {
    render(<PlaybackBar {...props()} />);
    expect(screen.getByText('R2/2 · +16.0ms / 100.0ms')).toBeInTheDocument();
    expect(screen.getByText('실제의 1/160 속도로 재생 · 빈 구간 접음')).toBeInTheDocument();
  });

  it('큰 버튼: 재생 → 일시정지 → 계속 → 다시 보기, 기록이 없으면 비활성', () => {
    const { rerender } = render(<PlaybackBar {...props()} />);
    expect(screen.getByRole('button', { name: '재생 (Space)' })).toBeEnabled();
    rerender(<PlaybackBar {...props({ playing: true })} />);
    expect(screen.getByRole('button', { name: '일시정지 (Space)' })).toBeInTheDocument();
    rerender(<PlaybackBar {...props({ paused: true })} />);
    expect(screen.getByRole('button', { name: '계속 (Space)' })).toBeInTheDocument();
    rerender(<PlaybackBar {...props({ P: 200 })} />);
    expect(screen.getByRole('button', { name: '다시 보기 (Space)' })).toBeInTheDocument();
    expect(screen.getByText('2라운드 중 위반 1건 · 409 0 · 423 0')).toBeInTheDocument();
    rerender(<PlaybackBar {...props({ hasRec: false })} />);
    expect(screen.getByRole('button', { name: '재생 (Space)' })).toBeDisabled();
    expect(screen.getByLabelText('재생 위치')).toBeDisabled();
    expect(screen.getByText('기록 없음')).toBeInTheDocument();
  });

  it('실행 중에는 R n/4와 비활성', () => {
    render(<PlaybackBar {...props({ runStep: 2 })} />);
    expect(screen.getByRole('button', { name: '실행 중 (Space)' })).toBeDisabled();
    expect(screen.getByText('실행 중 R2/2')).toBeInTheDocument();
  });

  it('스크러버: 빗금 구간·라운드 경계·눈금, 이동, 빈 구간 툴팁', () => {
    const p = props();
    const { container } = render(<PlaybackBar {...p} />);
    expect(container.querySelectorAll('.gz')).toHaveLength(1);
    expect(container.querySelectorAll('.rd')).toHaveLength(1);
    expect(container.querySelector('.tk.bad')).toHaveStyle({ left: '25%' });
    const range = screen.getByLabelText('재생 위치');
    fireEvent.change(range, { target: { value: '42' } });
    expect(p.onSeek).toHaveBeenCalledWith(42);
    range.getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;
    fireEvent.mouseMove(range, { clientX: 40 });
    expect(range).toHaveAttribute('title', '실제 40.0ms 압축 (빈 구간 빨리 감기)');
    fireEvent.mouseMove(range, { clientX: 150 });
    expect(range).toHaveAttribute('title', 'R2 · 실제 +50.0ms');
  });

  it('자동 멈춤·원인에서도·빈 구간 토글', () => {
    const p = props();
    render(<PlaybackBar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /자동 멈춤/ }));
    fireEvent.click(screen.getByLabelText('원인에서도'));
    fireEvent.click(screen.getByRole('button', { name: /빈 구간 빨리 감기/ }));
    expect(p.onToggleAuto).toHaveBeenCalled();
    expect(p.onToggleCause).toHaveBeenCalled();
    expect(p.onToggleFF).toHaveBeenCalled();
  });
});
