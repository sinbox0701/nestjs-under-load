import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../api';
import { fixtures } from '../../api/mock-fixtures';
import type { Api, BatchSummary, RunRow } from '../../api';
import { HistoryScreen } from './HistoryScreen';
import { autoAxis, groupByBatch } from './logic';

afterEach(cleanup);

const row = (batchId: string, rep: number, o: Partial<RunRow> = {}): RunRow => ({
  ...fixtures.runRow,
  runId: `${batchId}_r${rep}`,
  batchId,
  repetition: rep,
  ...o,
});

function fakeApi(rows: RunRow[]): Api {
  const api = createApi({ mock: true });
  return {
    ...api,
    listRuns: async () => ({ items: rows, next: null }),
    getBatch: async (id) =>
      ({
        ...fixtures.batch,
        batchId: id,
        runIds: rows.filter((r) => r.batchId === id).map((r) => r.runId),
      }) as BatchSummary,
  };
}

describe('HistoryScreen', () => {
  it('mock 으로 배치 목록·요약·§3.1 문구를 보인다', async () => {
    render(<HistoryScreen api={createApi({ mock: true })} />);
    expect(await screen.findByText(/g02-stock-decrement · row-lock/)).toBeInTheDocument();
    expect(await screen.findByText('유효 3/3회')).toBeInTheDocument();
    expect(screen.getByText(/불변식 위반 1건/)).toBeInTheDocument();
    expect(screen.getByTestId('honesty')).toHaveTextContent('처리 방식 간 상대 비교');
  });

  it('실행을 펼쳐 메타데이터와 아티팩트 링크를 본다', async () => {
    render(<HistoryScreen api={createApi({ mock: true })} apiBase="/api" />);
    fireEvent.click(await screen.findByRole('button', { name: /실행 1건 펼치기/ }));
    const link = screen.getByRole('link', { name: 'k6 HTML 리포트' });
    expect(link.getAttribute('href')).toMatch(/^\/api\/runs\/.+\/artifacts\/report\.html$/);
    fireEvent.click(screen.getByRole('button', { name: /메타데이터 보기/ }));
    expect(await screen.findByTestId('metadata')).toHaveTextContent('schemaVersion');
  });

  it('AC-5: 두 배치를 고르면 /compare?batches=a,b 로 이동하고 대수만 다르면 axis 를 붙인다', async () => {
    const nav = vi.fn();
    const rows = [row('b2', 1, { appInstances: 2 }), row('b1', 1, { appInstances: 1 })];
    render(<HistoryScreen api={fakeApi(rows)} onNavigate={nav} />);
    const boxes = await screen.findAllByRole('checkbox');
    const go = screen.getByRole('button', { name: /개 비교/ });
    expect(go).toBeDisabled();
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    await waitFor(() => expect(go).toBeEnabled());
    fireEvent.click(go);
    expect(nav).toHaveBeenCalledWith('/compare?batches=b2,b1&axis=topology.appInstances');
  });

  it('대수 외에도 다르면 axis 를 붙이지 않는다', () => {
    const a = groupByBatch([row('a', 1, { appInstances: 1 })])[0]!;
    const b = groupByBatch([row('b', 1, { appInstances: 2, model: 'open' })])[0]!;
    expect(autoAxis(a, b)).toBeNull();
    const c = groupByBatch([row('c', 1, { appInstances: 1, instrumentation: 'full' })])[0]!;
    expect(autoAxis(a, c)).toBe('instrumentation');
  });
});

describe('HistoryScreen unstable 배지 문구', () => {
  it('AC-3 문구가 반복 수를 반영한다', async () => {
    const api = createApi({ mock: true });
    render(
      <HistoryScreen
        api={{ ...api, getBatch: async () => ({ ...fixtures.batch, reps: 5, badges: ['unstable'] }) as BatchSummary }}
      />,
    );
    expect(await screen.findByText('5회 편차 큼')).toBeInTheDocument();
  });
});
