import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ServerSnapshot } from '../events/types';
import { buildRecording } from '../scenarios';
import { ServerInside, type ServerInsideProps } from './ServerInside';

const g01 = buildRecording({ scenario: 'g01-shared-document', strategy: 'optimistic-version' });
const snap = (o: Partial<ServerSnapshot> = {}): ServerSnapshot => ({
  version: 8,
  rowLock: null,
  sessions: [],
  pool: { size: 10, crowd: 1 },
  ...o,
});
const props = (o: Partial<ServerInsideProps> = {}): ServerInsideProps => ({
  hasRec: true,
  scenario: 'g01-shared-document',
  strategyId: 'optimistic-version',
  meta: g01.meta,
  snap: snap(),
  lastSql: null,
  ...o,
});

describe('ServerInside', () => {
  it('READ COMMITTED 배지(용어 툴팁) + "왜?" 펼치기', () => {
    render(<ServerInside {...props()} />);
    const rc = screen.getByText('READ COMMITTED');
    expect(rc).toHaveClass('term');
    expect(rc.getAttribute('data-tip')).toContain('PostgreSQL 기본 격리 수준');
    const why = screen.getByText('왜? 격리 수준을 올리면 덮어쓰기가 막힐까');
    fireEvent.click(why);
    expect(screen.getByText(/40001 serialization_failure/)).toBeInTheDocument();
  });

  it('행 락 보유·대기 트리, 풀(대기 세션은 노랑 빗금), 세션 목록: active · Lock / idle in transaction 구분', () => {
    const { container } = render(
      <ServerInside
        {...props({
          snap: snap({
            rowLock: { holder: 'B', waiters: ['A'] },
            sessions: [
              { actor: 'B', pid: 4101, state: 'active', since: 0, until: null },
              {
                actor: 'A',
                pid: 4100,
                state: 'lock_wait',
                sql: 'update "document" …',
                since: 0,
                until: null,
              },
            ],
          }),
          lastSql: { actor: 'A', sql: 'update "document" set "version" = $5' },
        })}
      />,
    );
    expect(screen.getByText('보유')).toBeInTheDocument();
    expect(screen.getByText('대기')).toBeInTheDocument();
    expect(screen.getByText('active · Lock')).toBeInTheDocument();
    expect(screen.getByText('idle in transaction')).toBeInTheDocument();
    expect(screen.getByText('3/10')).toBeInTheDocument();
    expect(container.querySelectorAll('.pool i.lk')).toHaveLength(1);
    expect(container.querySelectorAll('.pool i.on')).toHaveLength(2);
    expect(container.querySelector('.sql .hl')?.textContent).toBe('"version" = $5');
    expect(screen.getByText(/× 7 · 트랜잭션 없음/)).toBeInTheDocument();
  });

  it('편집 잠금: DB 칼럼 잠금 · 문 밖 재시도(서버 큐 아님) · 멈춘 보유자', () => {
    render(
      <ServerInside
        {...props({
          strategyId: 'edit-lease',
          snap: snap({
            lease: { holder: 'A', fence: 12, expired: false, holderState: 'paused' },
            outside: ['B'],
          }),
        })}
      />,
    );
    expect(
      screen.getByText('문 밖 · 클라이언트 쪽 재시도 (서버 큐 아님 · 순서 보장 없음)'),
    ).toBeInTheDocument();
    expect(screen.getByText('423')).toBeInTheDocument();
    expect(screen.getByText('멈춤')).toBeInTheDocument();
  });

  it('기록 전에는 실행 전', () => {
    render(<ServerInside {...props({ hasRec: false })} />);
    expect(screen.getAllByText('실행 전').length).toBeGreaterThan(0);
  });
});
