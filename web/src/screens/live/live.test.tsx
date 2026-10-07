import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Api, ProbeData, WireEventV0, WsMessage } from '../../api';
import { fixtures } from '../../api/mock-fixtures';
import { LiveScreen } from './LiveScreen';
import { MEASURED_BADGE, STAGE_BADGE } from './badges';
import { blockTree, initialLive, liveReduce } from './state';

const RUN = 'run-A';
const at = 1;
const pool = (runId: string, total: number, idle: number, waiting: number): WsMessage => ({
  type: 'pool',
  runId,
  at,
  data: { instance: 'app-1', total, idle, waiting },
});
const ev = (runId: string, seq: number, actor: string, phase = 'arrived'): WireEventV0 => ({
  v: 0,
  runId,
  ts: 1_000_000 + seq * 1000,
  seq,
  instance: 'app-1',
  actor,
  phase,
  attrs: { strategy: 'row-lock' },
  sampled: true,
});
const events = (runId: string, evs: WireEventV0[]): WsMessage => ({
  type: 'events',
  runId,
  at,
  data: evs,
});
const sess = (pid: number, state: string, wet: string | null, xact: number) => ({
  pid,
  appName: 'lab',
  state,
  waitEventType: wet,
  waitEvent: wet ? 'transactionid' : null,
  xactAgeMs: xact,
  query: null,
});
// 2단 차단: 814 가 813 을, 813 이 812 를 막는다.
const probe2: ProbeData = {
  sessions: [
    sess(812, 'active', 'Lock', 5),
    sess(813, 'active', 'Lock', 9),
    sess(814, 'idle in transaction', null, 30),
  ],
  blocking: [
    { pid: 812, blockedBy: [813] },
    { pid: 813, blockedBy: [814] },
  ],
  lockWaiters: 2,
};

function harness() {
  let push: (m: WsMessage) => void = () => {};
  const api = {
    subscribeRun: (_id: string, cb: (m: WsMessage) => void) => {
      push = cb;
      return () => {};
    },
  } as unknown as Api;
  return { api, send: (m: WsMessage) => act(() => push(m)) };
}

describe('blockTree', () => {
  it('2단 차단은 깊이 0·1·2', () => {
    expect(blockTree(probe2).map((n) => [n.pid, n.depth])).toEqual([
      [814, 0],
      [813, 1],
      [812, 2],
    ]);
  });
  it('교착(순환)이어도 끝난다', () => {
    const t = blockTree({
      sessions: [],
      blocking: [
        { pid: 1, blockedBy: [2] },
        { pid: 2, blockedBy: [1] },
      ],
      lockWaiters: 2,
    });
    expect(t.length).toBeLessThanOrEqual(2);
  });
});

describe('liveReduce', () => {
  it('새 runId 의 첫 메시지가 오면 이전 실행 상태를 모두 비운다', () => {
    let s = liveReduce(initialLive, events(RUN, [ev(RUN, 1, 'a')]));
    s = liveReduce(s, pool(RUN, 10, 2, 3));
    expect(s.events).toHaveLength(1);
    s = liveReduce(s, pool('run-B', 5, 5, 0));
    expect(s.runId).toBe('run-B');
    expect(s.events).toHaveLength(0);
    expect(s.pools['app-1']).toEqual({ total: 5, idle: 5, waiting: 0 });
  });
});

describe('LiveScreen', () => {
  it('AC-1: probe 2단 차단이 들여쓰기 2단으로 렌더된다', () => {
    const { api, send } = harness();
    render(<LiveScreen api={api} />);
    send({ type: 'probe', runId: RUN, at, data: probe2 });
    const items = within(screen.getByRole('tree', { name: '락 차단 트리' })).getAllByRole(
      'treeitem',
    );
    expect(items.map((li) => li.getAttribute('data-depth'))).toEqual(['0', '1', '2']);
    expect(items[2]!.style.paddingLeft).toBe('32px');
    expect(items[2]!.textContent).toContain('pid 812');
  });

  it('AC-2: pool {total:10, idle:2, waiting:3} → 활성 8·대기 3', () => {
    const { api, send } = harness();
    render(<LiveScreen api={api} />);
    send(pool(RUN, 10, 2, 3));
    const li = screen.getByLabelText('인스턴스별 커넥션 풀').querySelector('li')!;
    expect(li.querySelector('[data-k=active]')!.textContent).toBe('활성 8');
    expect(li.querySelector('[data-k=waiting]')!.textContent).toBe('대기 3');
  });

  it('AC-4: 실측 배지는 대표 N명, 무대 배지와 문구가 다르다', () => {
    const { api, send } = harness();
    render(<LiveScreen api={api} />);
    send(events(RUN, [ev(RUN, 1, 'a'), ev(RUN, 2, 'b'), ev(RUN, 3, 'a')]));
    expect(screen.getByTestId('measured-badge').textContent).toBe('실측 · 샘플 대표 2명');
    expect(MEASURED_BADGE(2)).not.toBe(STAGE_BADGE);
    expect(MEASURED_BADGE(2)).not.toContain('시뮬레이션');
  });

  it('runId 가 바뀌면 타임라인과 풀이 초기화된다', () => {
    const { api, send } = harness();
    render(<LiveScreen api={api} />);
    send(events(RUN, [ev(RUN, 1, 'a'), ev(RUN, 2, 'b')]));
    send(pool(RUN, 10, 2, 3));
    expect(screen.getByTestId('measured-badge').textContent).toContain('2명');
    send(events('run-B', [ev('run-B', 1, 'z')]));
    expect(screen.getByTestId('measured-badge').textContent).toContain('1명');
    expect(screen.getByText('풀 상태 대기 중')).toBeInTheDocument();
    expect(screen.getByText('run run-B')).toBeInTheDocument();
  });

  it('contracts fixture 메시지를 그대로 받아도 그려진다', () => {
    const { api, send } = harness();
    render(<LiveScreen api={api} />);
    for (const m of fixtures.wsMessages) send(m);
    expect(screen.getByRole('tree', { name: '락 차단 트리' }).textContent).toContain('pid 813');
    expect(screen.getByTestId('measured-badge').textContent).toMatch(/대표 \d+명/);
  });
});
