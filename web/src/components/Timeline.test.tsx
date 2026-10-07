import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { prepare } from '../playback/prepare';
import { buildRows } from '../playback/rows';
import { buildRecording } from '../scenarios';
import { Timeline, type TimelineProps } from './Timeline';

const rec = buildRecording({ scenario: 'g01-shared-document', strategy: 'edit-lease', people: 3 });
const p = prepare(rec);
function props(o: Partial<TimelineProps> = {}): TimelineProps {
  const view = o.view ?? 'key';
  return {
    hasRec: true,
    prepared: p,
    scenario: 'g01-shared-document',
    strategyId: 'edit-lease',
    people: 3,
    P: p.rounds[0]!.end - 0.01,
    rows: buildRows(p.events, { view, off: new Set() }, { info: p.info }),
    view,
    off: new Set(),
    callout: null,
    onView: vi.fn(),
    onToggleGroup: vi.fn(),
    onPickRow: vi.fn(),
    ...o,
  };
}

describe('Timeline', () => {
  it('요청별 트랜잭션 띠 레인과 같은 이름의 범례', () => {
    const { container } = render(<Timeline {...props()} />);
    const legend = screen.getByLabelText('레인 범례');
    expect(within(legend).getByText('acquire·release = 자동 커밋 UPDATE')).toBeInTheDocument();
    expect(within(legend).getByText('편집 잠금 보유')).toBeInTheDocument();
    expect(container.querySelectorAll('.lane')).toHaveLength(3);
    const lane = screen.getByTestId('lane-0');
    expect(lane.querySelector('.bd-ls')).not.toBeNull();
    expect(lane.querySelector('.bd-ac')).not.toBeNull();
    // 범례에 쓴 클래스가 레인에도 그대로
    expect(legend.querySelector('.bd-ac')).not.toBeNull();
  });

  it('라이브 기록(g02 이벤트만, 띠 없음)의 범례에는 g01 전용 띠가 없다', () => {
    const g02 = buildRecording({ scenario: 'g02-stock-decrement', strategy: 'row-lock' });
    const { txBands: _b, txMarks: _m, ...bare } = g02;
    const lp = prepare(bare);
    render(
      <Timeline
        {...props({
          prepared: lp,
          scenario: 'g02-stock-decrement',
          strategyId: 'row-lock',
          rows: buildRows(lp.events, { view: 'key', off: new Set() }, { info: lp.info }),
          P: lp.total,
        })}
      />,
    );
    const legend = screen.getByLabelText('레인 범례');
    expect(within(legend).queryByText(/편집 = 사람 시간/)).toBeNull();
    expect(within(legend).queryByText(/acquire·release/)).toBeNull();
    expect(within(legend).queryByText('편집 잠금 보유')).toBeNull();
    expect(legend.querySelector('.bd-ed, .bd-ac, .bd-ls')).toBeNull();
  });

  it('반복은 ×N으로 묶고, 행마다 라운드 기준 실제 ms', () => {
    render(<Timeline {...props({ view: 'all' })} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.some((li) => /×\d/.test(li.textContent ?? ''))).toBe(true);
    expect(rows[0]!.textContent).toMatch(/^\+\d+\.\d/);
  });

  it('핵심만: 요청·편집 칩은 비활성, 필터 누르면 콜백', () => {
    const pr = props();
    render(<Timeline {...pr} />);
    expect(
      within(screen.getByRole('group', { name: '이벤트 종류 필터' })).getByRole('button', {
        name: '요청·응답',
      }),
    ).toBeDisabled();
    fireEvent.click(
      within(screen.getByRole('group', { name: '이벤트 종류 필터' })).getByRole('button', {
        name: '커밋',
      }),
    );
    expect(pr.onToggleGroup).toHaveBeenCalledWith('commit');
    fireEvent.click(screen.getByRole('radio', { name: '전체' }));
    expect(pr.onView).toHaveBeenCalledWith('all');
  });

  it('현재 행 강조, 아직 안 온 행은 흐리게, 행 클릭 → 그 시점으로', () => {
    const rows = buildRows(p.events, { view: 'key', off: new Set() }, { info: p.info });
    const pr = props({ P: rows[1]!.t });
    render(<Timeline {...pr} />);
    const now = screen.getAllByRole('listitem').find((li) => li.classList.contains('is-now'))!;
    expect(now).toHaveAttribute('aria-current', 'step');
    expect(document.querySelector('.log li.is-future')).not.toBeNull();
    fireEvent.click(within(now).getByRole('button'));
    expect(pr.onPickRow).toHaveBeenCalledWith(rows[1]);
  });

  it('잃어버린 수정 멈춤이면 덮어쓴 사람의 읽기 행이 원인(노랑)', () => {
    const r2 = buildRecording({ scenario: 'g01-shared-document', strategy: 'naive-overwrite' });
    const p2 = prepare(r2);
    const stop = p2.stops.find((s) => s.phase === 'custom:lost_update')!;
    render(
      <Timeline
        {...props({
          prepared: p2,
          strategyId: 'naive-overwrite',
          people: 2,
          P: stop.at,
          callout: stop,
          rows: buildRows(p2.events, { view: 'key', off: new Set() }, { info: p2.info }),
        })}
      />,
    );
    const cause = document.querySelector('.log li.is-cause');
    expect(cause?.textContent).toContain('읽기');
  });

  it('기록이 없으면 빈 레인과 안내', () => {
    render(<Timeline {...props({ hasRec: false })} />);
    expect(screen.getByText('실행하면 기록이 여기에 쌓입니다')).toBeInTheDocument();
  });

  it('핵심만/전체는 Seg: 방향키로 바꾸고 포커스 이동, 전역 단축키로 새지 않는다', () => {
    const pr = props();
    const { container } = render(<Timeline {...pr} />);
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    const group = screen.getByRole('radiogroup', { name: '표시 범위' });
    expect(group).toHaveClass('seg', 'seg--sm');
    const key = within(group).getByRole('radio', { name: '핵심만' });
    expect(key).toHaveAttribute('tabindex', '0');
    expect(within(group).getByRole('radio', { name: '전체' })).toHaveAttribute('tabindex', '-1');
    key.focus();
    fireEvent.keyDown(key, { key: 'ArrowRight' });
    expect(pr.onView).toHaveBeenCalledWith('all');
    expect(within(group).getByRole('radio', { name: '전체' })).toHaveFocus();
    expect(spy).not.toHaveBeenCalled();
    window.removeEventListener('keydown', spy);
    expect(container).toBeTruthy();
  });
});
