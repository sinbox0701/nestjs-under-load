import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodeLab } from './CodeLab';
import type { CodeEditorProps } from './CodeEditor';
import { buildScenarios } from './loader';

// Monaco는 jsdom에서 돌지 않는다 → 에디터는 받은 props를 글자로 드러내는 가짜로 바꾼다.
vi.mock('./CodeEditor', () => ({
  default: (p: CodeEditorProps) => (
    <div data-testid="editor">
      <pre data-testid="editor-main" data-path={p.main.modelPath}>
        {p.main.highlights.map((h) => `${h.marker}@${h.line}-${h.endLine}:${h.tone}`).join(',')}
      </pre>
      {p.compare && <pre data-testid="editor-compare" data-path={p.compare.modelPath} />}
    </div>
  ),
}));

const LEARN = `
scenario: t01-demo
title: 데모 경합
concepts:
  - { id: c-lost, label: 잃어버린 갱신, body: 덮어쓴다 }
  - { id: c-lock, label: 행 잠금, body: 기다린다 }
situations:
  - { id: calm, label: 동시 2명 · 서버 1대, load: { model: closed, vus: 2 }, instances: 1, chaos: none }
  - { id: busy, label: 200 req/s · 서버 2대, load: { model: open, rate: 200 }, instances: 2, chaos: none }
  - { id: wide, label: 경합 창 30ms 주입 · 서버 2대, load: { model: open, rate: 200 }, instances: 2, chaos: none, injected: { contentionWindowMs: 30 } }
outcomes:
  - { strategy: naive, situation: calm, verdict: broken, expected: 위반 가능, measured: null, why: 상수를 쓴다,
      focus: [{ file: strategies/naive.strategy.ts, marker: write }], sql: ["update t set v = $1"], concepts: [c-lost] }
  - { strategy: naive, situation: busy, verdict: broken, expected: 위반 다수, measured: { run: r7, violations: 12 }, why: 더 많이 겹친다,
      focus: [{ file: strategies/naive.strategy.ts, marker: read }], sql: [] }
  - { strategy: locked, situation: calm, verdict: ok, expected: 위반 0, measured: null, why: 줄을 선다,
      focus: [{ file: strategies/locked.strategy.ts, marker: lock }], sql: ["select ... for update"] }
  - { strategy: locked, situation: busy, verdict: slow, expected: p95 증가, measured: null, why: 잠금 대기,
      focus: [{ file: strategies/locked.strategy.ts, marker: lock }], sql: [] }
  - { strategy: naive, situation: wide, verdict: broken, expected: 위반 다수,
      measured: { run: 2026-10-06T16-50-01Z_g02_naive_i2, injected: { contentionWindowMs: 30 }, summary: 경합 창 30ms 주입됨 · 위반 3/3회 },
      why: 창이 넓다, focus: [{ file: strategies/naive.strategy.ts, marker: read }], sql: [] }
  - { strategy: locked, situation: wide, verdict: ok, expected: 위반 0, measured: null, why: 줄을 선다,
      focus: [{ file: strategies/locked.strategy.ts, marker: lock }], sql: [] }
choose:
  - { when: 늘 맞아야 한다, pick: locked, because: DB가 줄 세운다, avoid: [naive] }
`;
const NAIVE = [
  '// @learn read — 읽기',
  'const v = read();',
  '// @learn write — 쓰기',
  'write(v + 1);',
].join('\n');
const LOCKED = ['x();', '// @learn lock — 잠금', 'lock();'].join('\n');

const scenarios = buildScenarios(
  {},
  {
    'demo/t01/learn.yaml': LEARN,
    'demo/t01/strategies/naive.strategy.ts': NAIVE,
    'demo/t01/strategies/locked.strategy.ts': LOCKED,
  },
);

async function setup() {
  const r = render(<CodeLab scenarios={scenarios} />);
  await screen.findByTestId('editor');
  return r;
}

describe('CodeLab', () => {
  it('탐색기·상황 바·판정 표·에디터 강조를 그린다', async () => {
    await setup();
    expect(screen.getByRole('navigation', { name: '탐색기' })).toHaveTextContent(
      'naive.strategy.ts',
    );
    expect(screen.getByRole('radio', { name: '동시 2명 · 서버 1대' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // 첫 strategy(naive) × 첫 상황(calm) → write 마커 줄 3–4, broken=bad
    expect(screen.getByTestId('editor-main')).toHaveTextContent('write@3-4:bad');
    const panel = screen.getByRole('complementary', { name: '판정' });
    expect(within(panel).getByText('상수를 쓴다')).toBeInTheDocument();
    expect(within(panel).getByText('update t set v = $1')).toBeInTheDocument();
    // 관련 concept은 outcome.concepts만
    expect(within(panel).getByText('잃어버린 갱신')).toBeInTheDocument();
    expect(within(panel).queryByText('행 잠금')).not.toBeInTheDocument();
    expect(screen.getByText('예시 데이터(fixture)')).toBeInTheDocument();
  });

  it('상황을 바꾸면 판정·강조·실측 배지가 바뀐다', async () => {
    await setup();
    fireEvent.click(screen.getByRole('radio', { name: '200 req/s · 서버 2대' }));
    expect(screen.getByTestId('editor-main')).toHaveTextContent('read@1-2:bad');
    const panel = screen.getByRole('complementary', { name: '판정' });
    // naive × busy는 실측(run r7), locked × busy는 예상
    expect(within(panel).getAllByText('실측 run#r7').length).toBeGreaterThan(0);
    expect(within(panel).getByText('violations 12')).toBeInTheDocument();
    expect(within(panel).getByText('예상이었던 것:')).toBeInTheDocument();
    const lockedRow = within(panel)
      .getAllByRole('row')
      .find((r) => r.textContent?.includes('locked'))!;
    expect(within(lockedRow).getByText('느림')).toBeInTheDocument();
    expect(within(lockedRow).getByText('예상')).toBeInTheDocument();
  });

  it('경합 창 주입 상황: 상황 바와 실측에 "주입됨", 긴 run id는 줄이고 전체는 툴팁', async () => {
    await setup();
    expect(screen.queryByText('주입됨')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '경합 창 30ms 주입 · 서버 2대' }));
    expect(screen.getByText('200 req/s · 서버 2대 · 경합 창 +30ms')).toBeInTheDocument();
    const panel = screen.getByRole('complementary', { name: '판정' });
    const naiveRow = within(panel)
      .getAllByRole('row')
      .find((r) => r.textContent?.includes('naive'))!;
    const badge = within(naiveRow).getByText('실측 run#10-06 16:50:01');
    expect(badge.closest('[title]')).toHaveAttribute(
      'title',
      expect.stringContaining('실측 run#2026-10-06T16-50-01Z_g02_naive_i2'),
    );
    expect(within(naiveRow).getByText('주입됨')).toBeInTheDocument();
    // 상황 바(1) + 표의 naive 행(1) + 선택한 naive 근거 상자(1)
    expect(screen.getAllByText('주입됨').length).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: /매트릭스/ }));
    const matrix = screen.getByRole('region', { name: '전체 판정 매트릭스' });
    expect(
      within(matrix).getByRole('button', { name: /naive × 경합 창.*\(실측·주입됨\)/ }),
    ).toBeInTheDocument();
  });

  it('판정 표에서 strategy를 고르면 그 파일 탭이 열리고 강조가 따라간다', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: /locked/, pressed: false }));
    expect(screen.getByRole('tab', { name: /locked\.strategy\.ts/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('editor-main')).toHaveTextContent('lock@2-3:ok');
  });

  it('나란히 비교를 켜면 두 번째 strategy가 diff 오른쪽에 온다', async () => {
    await setup();
    fireEvent.click(screen.getByRole('checkbox', { name: /나란히 비교/ }));
    expect(screen.getByTestId('editor-compare')).toHaveAttribute(
      'data-path',
      'demo/t01/strategies/locked.strategy.ts',
    );
  });

  it('매트릭스 칸을 누르면 그 조합으로 이동한다', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: /매트릭스/ }));
    const matrix = screen.getByRole('region', { name: '전체 판정 매트릭스' });
    fireEvent.click(
      within(matrix).getByRole('button', { name: 'locked × 200 req/s · 서버 2대: 느림' }),
    );
    expect(screen.getByRole('radio', { name: '200 req/s · 서버 2대' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByTestId('editor-main')).toHaveTextContent('lock@2-3:wait');
    expect(
      within(matrix).getByRole('button', { name: /naive × 200.*\(실측\)/ }),
    ).toBeInTheDocument();
  });

  it('키보드: ] 다음 상황, j 다음 strategy, ? 도움말·Esc 닫기', async () => {
    await setup();
    act(() => {
      fireEvent.keyDown(window, { key: ']' });
    });
    expect(screen.getByRole('radio', { name: '200 req/s · 서버 2대' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    act(() => {
      fireEvent.keyDown(window, { key: 'j' });
    });
    expect(screen.getByTestId('editor-main')).toHaveTextContent('lock@2-3:wait');
    act(() => {
      fireEvent.keyDown(window, { key: '?' });
    });
    const dlg = screen.getByRole('dialog', { name: /단축키/ });
    fireEvent.keyDown(dlg, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('결정 가이드: 고를 코드와 현재 상황 판정을 보인다', async () => {
    await setup();
    const guide = screen.getByRole('region', { name: '결정 가이드' });
    expect(guide).toHaveTextContent('늘 맞아야 한다');
    expect(within(guide).getByText('맞음')).toBeInTheDocument();
    fireEvent.click(within(guide).getByRole('button', { name: 'locked' }));
    expect(screen.getByRole('tab', { name: /locked\.strategy\.ts/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
