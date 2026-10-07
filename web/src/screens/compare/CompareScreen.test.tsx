import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtures } from '../../api/mock-fixtures';
import type { BatchSummary, CompareResult } from '../../api';
import { CompareView } from './CompareScreen';

afterEach(cleanup);

const clone = <T,>(x: T): T => structuredClone(x);
const base = (): CompareResult => clone(fixtures.compare);

describe('CompareView', () => {
  it('AC-1: 불변식 섹션이 처리량 섹션보다 앞에 있고 유효성이 그 사이, 실패가 마지막', () => {
    const { container } = render(<CompareView result={base()} />);
    const order = [...container.querySelectorAll('[data-section]')].map((e) =>
      e.getAttribute('data-section'),
    );
    expect(order).toEqual(['invariants', 'validity', 'throughput', 'failures']);
    const inv = container.querySelector('[data-section="invariants"]')!;
    const tp = container.querySelector('[data-section="throughput"]')!;
    expect(inv.compareDocumentPosition(tp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('비교 가능이면 axis·git 경고를 보이고 §3.1 문구가 하단에 있다', () => {
    render(<CompareView result={base()} />);
    expect(screen.getByText('비교 축')).toBeInTheDocument();
    expect(screen.getByTestId('warning')).toHaveTextContent('코드 버전 다름');
    expect(screen.queryByTestId('not-comparable')).toBeNull();
    expect(screen.getByTestId('honesty')).toHaveTextContent(
      '운영 환경의 처리 용량을 뜻하지 않습니다',
    );
    expect(screen.getAllByText(/처리량 [12]위/)).toHaveLength(2);
  });

  it('AC-2: blocking diff 가 있으면 비교 불가와 경로 목록, 순위 없음', () => {
    const r = base();
    r.comparable = false;
    r.diffs.push({ path: 'load.vus', values: [50, 20], kind: 'blocking' });
    render(<CompareView result={r} />);
    const ban = screen.getByTestId('not-comparable');
    expect(ban).toHaveTextContent('비교 불가(조건 다름)');
    expect(ban).toHaveTextContent('load.vus');
    expect(ban).toHaveTextContent('50 ≠ 20');
    expect(screen.getByTestId('no-rank')).toBeInTheDocument();
    expect(screen.queryByText(/처리량 [12]위/)).toBeNull();
  });

  it('AC-3: open 배치는 실패 = HTTP n + dropped m 을 보인다', () => {
    const r = base();
    const b = r.batches[0]!;
    b.loadModel = 'open';
    b.failures = {
      http: [12, 0, 3],
      dropped: [340, 0, 20],
      droppedCountedAsFailure: [true, true, true],
      total: [352, 0, 23],
    };
    render(<CompareView result={r} />);
    const col = document.querySelector(
      `[data-section="failures"] [data-batch="${b.batchId}"]`,
    ) as HTMLElement;
    expect(within(col).getAllByTestId('failure-rep')[0]).toHaveTextContent(
      '실패 = HTTP 12 + dropped 340 = 352',
    );
    expect(col).toHaveTextContent('합계 HTTP 15 + dropped 360');
  });

  it('AC-4: 무효 실행은 순위 제외+사유, 위반 실행은 빠르지만 틀림', () => {
    const r = base();
    const [a, b] = r.batches as [BatchSummary, BatchSummary];
    a.validity = { validReps: 0, invalidReasons: [['워밍업 미달'], ['k6 비정상 종료'], []] };
    a.throughputRps = { median: 3000, min: 2900, max: 3100 };
    render(<CompareView result={r} />);
    const tp = document.querySelector('[data-section="throughput"]') as HTMLElement;
    const colA = tp.querySelector(`[data-batch="${a.batchId}"]`) as HTMLElement;
    expect(within(colA).getByTestId('excluded')).toHaveTextContent('순위 제외');
    expect(within(colA).getByTestId('excluded')).toHaveTextContent('워밍업 미달');
    expect(within(colA).queryByText(/처리량 \d위/)).toBeNull();
    const val = document.querySelector('[data-section="validity"]') as HTMLElement;
    expect(val).toHaveTextContent('r1: 워밍업 미달');
    // b 는 fixture 상 r1 위반 → 단독 순위, 깨끗한 배치가 없으므로 빠르지만 틀림.
    const colB = tp.querySelector(`[data-batch="${b.batchId}"]`) as HTMLElement;
    expect(within(colB).getByText('빠르지만 틀림')).toBeInTheDocument();
    expect(within(colB).getByText('처리량 1위')).toBeInTheDocument();
  });

  it('깨끗한 배치가 더 빠르면 위반 배치에 빠르지만 틀림을 붙이지 않는다', () => {
    const r = base();
    const [a, b] = r.batches as [BatchSummary, BatchSummary];
    a.throughputRps = { median: 2000, min: 1990, max: 2010 };
    b.throughputRps = { median: 1500, min: 1400, max: 1600 };
    render(<CompareView result={r} />);
    expect(screen.queryByText('빠르지만 틀림')).toBeNull();
    expect(
      screen.getByText(/정합성 위반 1건/, { selector: '[data-section="throughput"] .badge' }),
    ).toBeInTheDocument();
  });
});
