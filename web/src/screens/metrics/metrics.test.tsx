import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MetricsScreen } from './MetricsScreen';
import { grafanaUrl } from './grafana';

describe('grafanaUrl', () => {
  it('AC-3: /d/<uid>/… ?var-run_id&from&to&kiosk 형식', () => {
    const u = new URL(
      grafanaUrl({ uid: 'nul-red', runId: 'r 1', fromMs: 1000, toMs: 2000 }),
      'http://x',
    );
    expect(u.pathname).toMatch(/\/d\/nul-red\/[^/]+$/);
    expect(u.searchParams.get('var-run_id')).toBe('r 1');
    expect(u.searchParams.get('from')).toBe('1000');
    expect(u.searchParams.get('to')).toBe('2000');
    expect(u.search.endsWith('&kiosk')).toBe(true);
  });
});

describe('MetricsScreen', () => {
  it('탭을 누르면 iframe 이 그 UID 대시보드로 바뀐다', () => {
    render(<MetricsScreen runId="r1" fromMs={10} toMs={20} />);
    expect(screen.getByTitle('Grafana 개요').getAttribute('src')).toContain('/d/nul-run-overview/');
    fireEvent.click(screen.getByRole('tab', { name: 'RED' }));
    const src = screen.getByTitle('Grafana RED').getAttribute('src')!;
    expect(src).toMatch(/\/d\/nul-red\/.*var-run_id=r1&from=10&to=20&kiosk$/);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      '개요',
      'RED',
      'USE-앱',
      'USE-PG',
      '부하',
    ]);
  });
});
