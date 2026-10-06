import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RunEvent } from '../events/types';
import { prepare } from '../playback/prepare';
import { buildRecording, codeFor } from '../scenarios';
import { CodePanel, type CodePanelProps } from './CodePanel';
import { phaseIcon } from './lib/model';

const rec = buildRecording({ scenario: 'g01-shared-document', strategy: 'optimistic-version' });
const p = prepare(rec);
const conflict = p.events.find((e) => e.phase === 'conflict')!;
function props(o: Partial<CodePanelProps> = {}): CodePanelProps {
  return {
    hasRec: true,
    scenario: 'g01-shared-document',
    strategyId: 'optimistic-version',
    meta: rec.meta,
    code: rec.code!,
    codeOf: (id) => codeFor('g01-shared-document', id),
    extra: rec.extraCode?.[0] ?? null,
    event: conflict,
    roundStart: 0,
    cursors: [],
    phase: (e: RunEvent) => {
      const i = p.info(e.phase);
      return { label: i.label, tone: i.tone, icon: phaseIcon(e.phase, i) };
    },
    compare: false,
    compareWith: 'naive-overwrite',
    onToggleCompare: vi.fn(),
    onCompareWith: vi.fn(),
    ...o,
  };
}
const curCol = () => document.querySelector('[data-side="cur"]')!;

describe('CodePanel', () => {
  it('이벤트 줄: 3px 막대 + 줄번호 반전 + 이벤트 색, 같이 실행된 줄, SQL 상자, 한 줄 설명', async () => {
    render(<CodePanel {...props()} />);
    const hit = curCol().querySelector('.cl.is-hit')!;
    expect(hit).toHaveClass('tone-bad');
    expect(hit.textContent).toContain('ConflictException');
    expect(curCol().querySelectorAll('.cl.is-hit2').length).toBeGreaterThan(0);
    expect(screen.getByTestId('sqlbox').textContent).toContain('rollback');
    expect(
      screen.getByText(/OptimisticVersionStrategy\.update\(\) · \d+번 줄/),
    ).toBeInTheDocument();
    // 용어 툴팁(점선 밑줄)
    expect(document.querySelector('.code-ev .term')).not.toBeNull();
    // shiki 하이라이트가 붙는다
    await waitFor(() => expect(hit.querySelector('code span[style]')).not.toBeNull(), {
      timeout: 5000,
    });
  });

  it('A▶ B▶ 다중 커서: 각자 마지막 이벤트 줄', () => {
    const a = p.events.find((e) => e.actor === 'A' && e.phase === 'db_read')!;
    const b = p.events.find((e) => e.actor === 'B' && e.phase === 'conflict') ?? conflict;
    render(
      <CodePanel
        {...props({
          cursors: [
            { actor: 'A', event: a },
            { actor: b.actor, event: b },
          ],
        })}
      />,
    );
    const marks = [...curCol().querySelectorAll('.cur i')].map((i) => i.textContent);
    expect(marks).toEqual(expect.arrayContaining(['A', b.actor]));
  });

  it('나란히 비교: 공통 줄 접기, 차이 줄은 그 처리 방식 상태 색, 펼치기', () => {
    const { rerender } = render(<CodePanel {...props({ compare: true, event: null })} />);
    expect(document.querySelectorAll('[data-side]')).toHaveLength(2);
    expect(curCol().querySelector('.cl.dl-ok')).not.toBeNull(); // 고침 = 초록
    expect(document.querySelector('[data-side="other"] .cl.dl-bad')).not.toBeNull(); // 고장 = 빨강
    const folds = screen.getAllByRole('button', { name: /공통 \d+줄 접음/ });
    const before = curCol().querySelectorAll('.cl').length;
    fireEvent.click(folds[0]!);
    expect(
      curCol().querySelectorAll('.cl').length +
        document.querySelectorAll('[data-side="other"] .cl').length,
    ).toBeGreaterThan(before);
    // 강조 줄이 접힌 곳이면 자동으로 편다
    rerender(<CodePanel {...props({ compare: true, event: conflict })} />);
    expect(curCol().querySelector('.cl.is-hit')).not.toBeNull();
  });

  it('맹목 재시도 vs 버전 감지: 클라이언트 줄만 다르다', () => {
    const r = buildRecording({ scenario: 'g01-shared-document', strategy: 'blind-retry' });
    render(
      <CodePanel
        {...props({
          strategyId: 'blind-retry',
          code: r.code!,
          compare: true,
          compareWith: 'optimistic-version',
          event: null,
        })}
      />,
    );
    const changed = [...curCol().querySelectorAll('.cl.dl-bad code')].map(
      (c) => c.textContent ?? '',
    );
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((t) => !t.includes('ConflictException'))).toBe(true);
  });

  it('G02: 팩 원문을 보여 주고 @event 마커 줄을 강조', () => {
    const r = buildRecording({ scenario: 'g02-stock-decrement', strategy: 'row-lock' });
    const p2 = prepare(r);
    const wait = p2.events.find((e) => e.phase === 'lock_wait')!;
    render(
      <CodePanel
        {...props({
          scenario: 'g02-stock-decrement',
          strategyId: 'row-lock',
          meta: r.meta,
          code: r.code!,
          extra: null,
          event: wait,
          codeOf: (id) => codeFor('g02-stock-decrement', id),
        })}
      />,
    );
    expect(screen.getByText('팩 원문')).toBeInTheDocument();
    expect(curCol().querySelector('.cl.is-hit')!.textContent).toContain('@event lock_wait');
    expect(screen.getByTestId('sqlbox').textContent).toContain('for update');
  });

  it('복사 버튼', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CodePanel {...props()} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '복사' })));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('OptimisticVersionStrategy'));
    expect(screen.getByRole('button', { name: '복사됨 ✓' })).toBeInTheDocument();
  });

  it('375px: 강조 줄 ±5줄 미니 보기 + 전체 코드 보기', () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes('max-width: 759px'),
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      render(<CodePanel {...props()} />);
      expect(curCol().querySelectorAll('.cl')).toHaveLength(11);
      fireEvent.click(screen.getByRole('button', { name: '전체 코드 보기' }));
      expect(curCol().querySelectorAll('.cl').length).toBeGreaterThan(11);
    } finally {
      window.matchMedia = mm;
    }
  });

  it('화면 읽기 알림: 재생 중엔 끄고(off), 자동 멈춤에 섰을 때만 polite', () => {
    const { rerender } = render(<CodePanel {...props()} />);
    expect(document.querySelector('.code-ev')).toHaveAttribute('aria-live', 'off');
    rerender(<CodePanel {...props({ announce: true })} />);
    expect(document.querySelector('.code-ev')).toHaveAttribute('aria-live', 'polite');
  });

  it('편집 잠금: TTL 30초 연장(renew) 가정과 이 코드엔 연장 경로 없음을 밝힌다', () => {
    const lease = buildRecording({
      scenario: 'g01-shared-document',
      strategy: 'edit-lease',
      edit: 3,
    });
    render(
      <CodePanel
        {...props({ strategyId: 'edit-lease', meta: lease.meta, code: lease.code!, event: null })}
      />,
    );
    const note = screen.getByTestId('lease-renew-note');
    expect(note).toHaveTextContent('클라이언트가 만료 전에 잠금을 연장(renew)한다고 가정');
    expect(note).toHaveTextContent('이 코드엔 연장 경로가 없다');
    expect(note).toHaveTextContent('지금 편집 시간 5분');
    expect(note.getAttribute('title')).toMatch(/연장\(renew\) 요청·엔드포인트는 이 코드에 없다/);
  });

  it('다른 처리 방식에는 연장 문구가 없다', () => {
    render(<CodePanel {...props()} />);
    expect(screen.queryByTestId('lease-renew-note')).toBeNull();
  });

  it('코드는 캐시된다(같은 처리 방식이면 같은 객체 → 비교 LCS memo 유지)', () => {
    expect(codeFor('g01-shared-document', 'naive-overwrite')).toBe(
      codeFor('g01-shared-document', 'naive-overwrite'),
    );
    expect(codeFor('g02-stock-decrement', 'no-lock')).toBe(
      codeFor('g02-stock-decrement', 'no-lock'),
    );
    const codeOf = vi.fn((id: string) => codeFor('g01-shared-document', id));
    const { rerender } = render(<CodePanel {...props({ compare: true, codeOf })} />);
    rerender(<CodePanel {...props({ compare: true, codeOf, roundStart: 1 })} />);
    rerender(<CodePanel {...props({ compare: true, codeOf, roundStart: 2 })} />);
    // 프레임마다 불려도 같은 객체 → codeLines·lcsDiff memo의 의존값이 바뀌지 않는다
    const got = codeOf.mock.results.map((r) => r.value);
    expect(got.length).toBeGreaterThan(1);
    for (const g of got) expect(g).toBe(got[0]);
  });
});
