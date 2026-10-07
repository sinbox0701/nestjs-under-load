import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, type Api, type RunRequest } from '../../api';
import runRequestFixture from '../../../../engine/contracts/fixtures/run-request.json';
import { RunSetup } from './RunSetup';

afterEach(cleanup);

function mockApi(over: Partial<Api> = {}) {
  const base = createApi({ mock: true });
  const postRun = vi.fn(base.postRun);
  const api: Api = { ...base, postRun, ...over };
  return { api, postRun };
}

const keys = (o: object) => Object.keys(o).sort();
const runBtn = () => screen.getByRole('button', { name: '실행' });

async function ready(api: Api, search = '') {
  render(<RunSetup api={api} search={search} />);
  await screen.findByLabelText('시나리오');
}

describe('RunSetup', () => {
  it('AC-1 예측이 비면 실행 버튼이 비활성, 채우면 RunRequest fixture 와 같은 키로 POST', async () => {
    const { api, postRun } = mockApi();
    await ready(api);
    expect(runBtn()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/결과가 어떻게/), {
      target: { value: '위반될 것이다' },
    });
    expect(runBtn()).toBeEnabled();
    fireEvent.click(runBtn());
    await waitFor(() => expect(postRun).toHaveBeenCalledTimes(1));
    const body = postRun.mock.calls[0]![0] as RunRequest;
    const fx = runRequestFixture as unknown as RunRequest;
    expect(keys(body)).toEqual(keys(fx));
    expect(keys(body.load)).toEqual(keys(fx.load));
    expect(keys(body.data)).toEqual(keys(fx.data));
    expect(keys(body.data.seedOptions)).toEqual(keys(fx.data.seedOptions));
    expect(body.prediction).toBe('위반될 것이다');
    await screen.findByLabelText('세션 진행');
  });

  it('AC-2 closed 면 rate·maxVUs 가 숨고 vus·생각 시간이 보인다', async () => {
    const { api } = mockApi();
    await ready(api);
    fireEvent.click(screen.getByRole('radio', { name: '도착률 고정' }));
    expect(screen.getByLabelText(/도착률 \(요청/)).toBeInTheDocument();
    expect(screen.getByLabelText(/최대 VU/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/동시 사용자 수/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: '동시 사용자 고정' }));
    expect(screen.queryByLabelText(/도착률 \(요청/)).toBeNull();
    expect(screen.queryByLabelText(/최대 VU/)).toBeNull();
    expect(screen.getByLabelText(/동시 사용자 수/)).toBeInTheDocument();
    expect(screen.getByText(/생각 시간/)).toBeInTheDocument();
  });

  it('open 본문은 vus 가 null 이고 rate 계열을 채운다', async () => {
    const { api, postRun } = mockApi();
    await ready(api);
    fireEvent.click(screen.getByRole('radio', { name: '도착률 고정' }));
    fireEvent.change(screen.getByLabelText(/결과가 어떻게/), { target: { value: 'x' } });
    fireEvent.click(runBtn());
    await waitFor(() => expect(postRun).toHaveBeenCalled());
    const { load } = postRun.mock.calls[0]![0] as RunRequest;
    expect(load.model).toBe('open');
    expect(load.vus).toBeNull();
    expect(load.rate).toBe(100);
    expect(load.maxVUs).toBe(200);
  });

  it('AC-3 주입 지연이 있으면 "주입됨" 배지가 보인다', async () => {
    const { api } = mockApi();
    await ready(api);
    expect(screen.queryByText('주입됨')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '지연 추가' }));
    expect(screen.getByText('주입됨')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('주입 지연 1 (ms)'), { target: { value: '0' } });
    expect(screen.queryByText('주입됨')).toBeNull();
  });

  it('AC-4 409 busy 면 진행 중 세션 링크를 보여 준다', async () => {
    const { api } = mockApi({
      postRun: () => Promise.reject(new ApiError(409, { reason: 'busy', sessionId: 'sess-9' })),
    });
    await ready(api);
    fireEvent.change(screen.getByLabelText(/결과가 어떻게/), { target: { value: 'x' } });
    fireEvent.click(runBtn());
    const link = await screen.findByRole('link', { name: '진행 중인 세션 보기' });
    expect(link).toHaveAttribute('href', '#session=sess-9');
  });

  it('400 이면 오류 목록을 보여 준다', async () => {
    const { api } = mockApi({
      postRun: () =>
        Promise.reject(new ApiError(400, { errors: [{ path: 'reps', message: '범위 밖' }] })),
    });
    await ready(api);
    fireEvent.change(screen.getByLabelText(/결과가 어떻게/), { target: { value: 'x' } });
    fireEvent.click(runBtn());
    expect(await screen.findByText(/reps: 범위 밖/)).toBeInTheDocument();
  });

  it('URL 쿼리의 scenario·situation 으로 초기값을 채운다', async () => {
    const base = createApi({ mock: true });
    const api: Api = {
      ...base,
      getScenarios: async () => {
        const [s] = await base.getScenarios();
        return [
          {
            ...s!,
            situations: [
              {
                id: 'spike',
                label: '몰림 200 req/s',
                load: { model: 'open', rate: 200, duration: '45s' },
                instances: 3,
              },
            ],
          },
        ];
      },
    };
    await ready(api, '?scenario=g02-stock-decrement&situation=spike');
    expect(screen.getByRole('radio', { name: '도착률 고정' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByLabelText(/도착률 \(요청/)).toHaveValue('200');
    expect(screen.getByLabelText(/실행 시간/)).toHaveValue('45s');
    expect(screen.getByLabelText('앱 대수')).toHaveValue('3');
    expect(screen.getByRole('status')).toHaveTextContent('몰림 200 req/s');
  });

  it('strategy 를 모두 끄면 실행할 수 없다', async () => {
    const { api } = mockApi();
    await ready(api);
    fireEvent.change(screen.getByLabelText(/결과가 어떻게/), { target: { value: 'x' } });
    const boxes = screen.getAllByRole('checkbox').slice(0, 2);
    for (const b of boxes) if ((b as HTMLInputElement).checked) fireEvent.click(b);
    expect(runBtn()).toBeDisabled();
  });
});
