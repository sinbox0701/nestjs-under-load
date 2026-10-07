import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApi, type Api, type Session, type WsMessage } from '../../api';
import { fixtures } from '../../api/mock-fixtures';
import { SessionProgress } from './SessionProgress';

afterEach(cleanup);

describe('SessionProgress', () => {
  it('AC-2 마지막 status 가 8/9 여도 세션이 done 이면 "완료 9/9" 로 확정한다', async () => {
    let session: Session = { ...fixtures.session, state: 'running' };
    let push: (m: WsMessage) => void = () => undefined;
    const api: Api = {
      ...createApi({ mock: true }),
      getSession: async () => session,
      subscribeRun: (_id, onMessage) => {
        push = onMessage;
        return () => undefined;
      },
    };
    render(<SessionProgress api={api} sessionId="s1" accepted={null} />);
    await waitFor(() => expect(push).not.toBe(undefined));
    const status = (done: number): WsMessage => ({
      type: 'status',
      runId: 'r',
      at: 0,
      data: { sessionId: 's1', step: 'main', state: 'running', repetition: 3, progress: { done, total: 9 } },
    });
    act(() => push(status(8)));
    expect(await screen.findByText('8/9 (89%)')).toBeInTheDocument();
    expect(screen.getByText('실행 중')).toBeInTheDocument();

    session = { ...session, state: 'done' };
    act(() => push({ type: 'end', runId: 'r', at: 1, data: { valid: true, reasons: [] } }));
    expect(await screen.findByText('9/9 (100%)')).toBeInTheDocument();
    expect(screen.getByText('완료')).toBeInTheDocument();
    expect(screen.queryByText('실행 중')).toBeNull();
  });
});
