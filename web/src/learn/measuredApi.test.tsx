import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createApi, type Api } from '../api';
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

function apiWith(learnMeasured: Api['learnMeasured']): Api {
  return { ...createApi({ mock: true }), learnMeasured };
}

describe('CodeLab 실측 덧씌우기(measured API)', () => {
  it('API 셀이 있으면 해당 판정에 실측 run 배지와 출처 표시', async () => {
    const api = apiWith(async (scenario) => ({
      scenario,
      cells: [
        {
          strategy: 'locked',
          situation: 'calm',
          measured: { run: 'batch-9', summary: '위반 0 (3/3회)' },
        },
      ],
    }));
    render(<CodeLab scenarios={scenarios} api={api} />);
    await screen.findByTestId('editor');
    await waitFor(() => expect(screen.getByTestId('measured-source')).toHaveTextContent('API 1셀'));
    const panel = screen.getByRole('complementary', { name: '판정' });
    const row = within(panel)
      .getAllByRole('row')
      .find((r) => r.textContent?.includes('locked'))!;
    expect(within(row).getByText('실측 run#batch-9')).toBeInTheDocument();
  });

  it('API 실패 시 파일 값으로 돌아간다', async () => {
    const api = apiWith(() => Promise.reject(new Error('down')));
    render(<CodeLab scenarios={scenarios} api={api} />);
    await screen.findByTestId('editor');
    await waitFor(() => expect(screen.getByTestId('measured-source')).toHaveTextContent('파일 값'));
    const panel = screen.getByRole('complementary', { name: '판정' });
    expect(within(panel).queryByText(/batch-9/)).not.toBeInTheDocument();
  });

  it('"이 상황으로 실행" 은 #run 으로 시나리오·상황을 넘긴다', async () => {
    render(<CodeLab scenarios={scenarios} />);
    await screen.findByTestId('editor');
    expect(screen.getByTestId('run-situation')).toHaveAttribute(
      'href',
      '#run?scenario=t01-demo&situation=calm',
    );
  });
});
