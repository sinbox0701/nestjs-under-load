import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, type Api, type RunsAccepted, type ScenarioInfo, type StackProfile } from '../../api';
import {
  INJECT_POINTS,
  PROBE_DEFAULT,
  buildRequest,
  caseCount,
  formFromQuery,
  hasInjection,
  initialForm,
  paramDefaults,
  validate,
  type FormState,
} from './form';
import { Seg } from '../../components/lib/Seg';
import { SessionProgress } from './SessionProgress';
import './run.css';

export interface RunSetupProps {
  api: Api;
  /** 초기값을 채울 URL 쿼리(`?scenario=…&situation=…`). 기본은 현재 주소. */
  search?: string;
  /** 진행 중 세션으로 가는 링크. 기본 `#session=<id>`. */
  sessionHref?: (sessionId: string) => string;
}

const MODEL_HINT = {
  open: '도착률 고정 (open) — 서버가 느려져도 초당 요청 수는 그대로 들어온다. 서버가 못 따라가면 요청이 밀린다.',
  closed:
    '동시 사용자 고정 (closed) — 사용자 수만 정해 두고, 응답을 받아야 다음 요청을 보낸다. 서버가 느려지면 요청 수도 줄어든다.',
} as const;

function Field(p: {
  label: string;
  id: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="rs-field">
      <label htmlFor={p.id}>{p.label}</label>
      {p.children}
      {p.hint && <span className="rs-hint">{p.hint}</span>}
      {p.error && (
        <span className="rs-err" role="alert">
          {p.error}
        </span>
      )}
    </div>
  );
}

/** 화면 2 — 실행 설정. 폼을 채워 POST /runs 하고 세션 진행을 보여 준다. */
export function RunSetup({ api, search, sessionHref }: RunSetupProps) {
  const [scenarios, setScenarios] = useState<ScenarioInfo[] | null>(null);
  const [loadError, setLoadError] = useState('');
  // 스택 프로필. 못 읽으면 null 로 두고 안내를 띄우지 않는다.
  const [stackProfiles, setStackProfiles] = useState<StackProfile[] | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState<RunsAccepted | null>(null);
  const [errors, setErrors] = useState<{ path: string; message: string }[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [watchId, setWatchId] = useState<string | null>(null);
  const [fail, setFail] = useState('');
  const searchRef = useRef(search);

  useEffect(() => {
    let alive = true;
    api
      .getHealth()
      .then((h) => alive && setStackProfiles(h.stack?.profiles ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);

  useEffect(() => {
    let alive = true;
    api
      .getScenarios()
      .then((list) => {
        if (!alive) return;
        const q = searchRef.current ?? globalThis.location?.search ?? '';
        const r = formFromQuery(list, q);
        setScenarios(list);
        setForm({
          ...r.form,
          strategyParams: paramDefaults(
            list.find((s) => s.id === r.form.scenario),
            r.form.strategies,
            {},
          ),
        });
        if (r.situationLabel) setNote(`코드 실험실의 상황 "${r.situationLabel}" 값으로 채웠다.`);
        else if (r.situationMissing)
          setNote(`상황 "${r.situationMissing}" 을 찾지 못해 시나리오 기본값으로 채웠다.`);
      })
      .catch(
        () =>
          alive &&
          setLoadError('시나리오 목록을 불러오지 못했다. 오케스트레이터가 켜져 있는지 확인한다.'),
      );
    return () => {
      alive = false;
    };
  }, [api]);

  const sc = scenarios?.find((s) => s.id === form?.scenario);
  const errs = useMemo(() => (form ? validate(form) : {}), [form]);
  if (loadError)
    return (
      <p className="rs rs-err" role="alert">
        {loadError}
      </p>
    );
  if (!form || !scenarios) return <p className="rs">불러오는 중…</p>;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));
  const bind = (k: keyof FormState) => ({
    id: `rs-${k}`,
    value: String(form[k] as string),
    onChange: (e: { target: { value: string } }) => set(k, e.target.value as never),
  });

  const pickScenario = (id: string) => {
    const next = initialForm(scenarios.find((s) => s.id === id));
    setForm({
      ...next,
      prediction: form.prediction,
      strategyParams: paramDefaults(
        scenarios.find((s) => s.id === id),
        next.strategies,
        {},
      ),
    });
    setNote('');
  };
  const toggleStrategy = (id: string) => {
    const on = form.strategies.includes(id);
    const strategies = on ? form.strategies.filter((s) => s !== id) : [...form.strategies, id];
    setForm({
      ...form,
      strategies,
      strategyParams: paramDefaults(sc, strategies, form.strategyParams),
    });
  };
  const pickLevel = (level: FormState['instrumentation']) =>
    setForm({
      ...form,
      instrumentation: level,
      probeEnabled: PROBE_DEFAULT[level].enabled,
      probeIntervalMs: String(PROBE_DEFAULT[level].intervalMs),
    });

  const invalid = Object.keys(errs).length > 0;
  const blockedByPrediction = errs.prediction !== undefined;
  const submit = async () => {
    if (invalid || submitting) return;
    setSubmitting(true);
    setErrors([]);
    setBusyId(null);
    setFail('');
    try {
      const r = await api.postRun(buildRequest(form));
      setAccepted(r);
      setWatchId(r.sessionId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const id = (e.body as { sessionId?: string } | null)?.sessionId;
        setBusyId(id ?? '');
      } else if (e instanceof ApiError && e.validationErrors) setErrors(e.validationErrors);
      else setFail('실행을 시작하지 못했다. 잠시 뒤 다시 시도한다.');
    } finally {
      setSubmitting(false);
    }
  };

  const href = (id: string) =>
    sessionHref ? sessionHref(id) : `#session=${encodeURIComponent(id)}`;
  const injected = hasInjection(form);
  const closed = form.model === 'closed';

  return (
    <div className="rs">
      <h1 className="rs-title">실행 설정</h1>
      {note && (
        <p className="rs-note" role="status">
          {note}
        </p>
      )}

      <form
        className="rs-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="panel rs-set">
          <legend className="panel__h">1. 무엇을 비교하나</legend>
          <Field label="시나리오" id="rs-scenario">
            <select
              id="rs-scenario"
              value={form.scenario}
              onChange={(e) => pickScenario(e.target.value)}
            >
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </Field>
          <div className="rs-field" role="group" aria-labelledby="rs-strategies-l">
            <span id="rs-strategies-l" className="rs-lbl">
              strategy (여러 개 고르면 차례로 실행)
            </span>
            <div className="rs-checks">
              {sc?.strategies.map((s) => {
                const sel = form.strategies.includes(s.id);
                return (
                  <label key={s.id} className={sel ? 'rs-check is-sel' : 'rs-check'}>
                    <input type="checkbox" checked={sel} onChange={() => toggleStrategy(s.id)} />
                    <span>{s.label}</span>
                    <span
                      className={`badge ${s.kind === 'broken' ? 't-bad' : s.kind === 'fixed' ? 't-ok' : 't-wait'}`}
                    >
                      {s.kind === 'broken'
                        ? '위반 시연'
                        : s.kind === 'fixed'
                          ? '고친 방식'
                          : '절충'}
                    </span>
                  </label>
                );
              })}
            </div>
            {errs.strategies && (
              <span className="rs-err" role="alert">
                {errs.strategies}
              </span>
            )}
          </div>
          <Field
            label="앱 대수"
            id="rs-appInstances"
            error={errs.appInstances}
            hint={`쉼표로 여러 값 (예: 1,2). 이 시나리오는 최소 ${sc?.minAppInstances ?? 1}대에서 의미가 있다.`}
          >
            <input type="text" inputMode="numeric" {...bind('appInstances')} />
          </Field>
          <label className="rs-inline">
            <input
              type="checkbox"
              checked={form.includeMemoryLockSingle}
              onChange={(e) => set('includeMemoryLockSingle', e.target.checked)}
            />
            메모리 락을 1대로도 함께 실행 (1대에선 맞게 보이는 걸 보여 주는 대조)
          </label>
          <Field
            label="반복 횟수"
            id="rs-reps"
            error={errs.reps}
            hint="같은 조건을 몇 번 돌려 중앙값과 범위를 본다 (1~20)"
          >
            <input type="text" inputMode="numeric" {...bind('reps')} />
          </Field>
        </fieldset>

        <fieldset className="panel rs-set">
          <legend className="panel__h">2. 부하</legend>
          <div className="rs-field">
            <span id="rs-model-l" className="rs-lbl">
              부하 방식
            </span>
            <Seg<FormState['model']>
              label="부하 방식"
              value={form.model}
              onChange={(m) => set('model', m)}
              items={(['open', 'closed'] as const).map((m) => ({
                value: m,
                label: m === 'open' ? '도착률 고정' : '동시 사용자 고정',
                title: MODEL_HINT[m],
                disabled: sc ? !sc.load.models.includes(m) : false,
              }))}
            />
            <span className="rs-hint">{MODEL_HINT[form.model]}</span>
            {form.model === 'closed' && (
              <p className="rs-caution" role="note">
                <span className="badge t-wait">지연 해석 주의</span> 동시 사용자 고정에서는 서버가
                느려지면 요청도 덜 보내져(coordinated omission) 지연이 실제보다 낮게 보일 수 있다.
                지연을 처리 능력으로 읽지 말고, 지연 비교는 같은 방식끼리만 한다.
              </p>
            )}
          </div>
          {closed ? (
            <>
              <Field label="동시 사용자 수 (vus)" id="rs-vus" error={errs.vus}>
                <input type="text" inputMode="numeric" {...bind('vus')} />
              </Field>
              <div className="rs-field">
                <span className="rs-lbl" id="rs-think-l">
                  생각 시간 (ms, 최소~최대)
                </span>
                <div className="rs-pair">
                  <input
                    aria-labelledby="rs-think-l"
                    type="text"
                    inputMode="numeric"
                    {...bind('thinkMin')}
                    id="rs-thinkMin"
                  />
                  <span aria-hidden="true">~</span>
                  <input
                    aria-label="생각 시간 최대(ms)"
                    type="text"
                    inputMode="numeric"
                    {...bind('thinkMax')}
                    id="rs-thinkMax"
                  />
                </div>
                <span className="rs-hint">요청 하나를 끝낸 사용자가 다음 요청까지 쉬는 시간</span>
                {errs.think && (
                  <span className="rs-err" role="alert">
                    {errs.think}
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <Field label="도착률 (요청/초, rate)" id="rs-rate" error={errs.rate}>
                <input type="text" inputMode="numeric" {...bind('rate')} />
              </Field>
              <Field
                label="미리 띄울 VU (preAllocatedVUs)"
                id="rs-preAllocatedVUs"
                error={errs.preAllocatedVUs}
              >
                <input type="text" inputMode="numeric" {...bind('preAllocatedVUs')} />
              </Field>
              <Field
                label="최대 VU (maxVUs)"
                id="rs-maxVUs"
                error={errs.maxVUs}
                hint="도착률을 못 맞추면 여기까지 늘린다. 넘으면 요청이 버려진다(dropped)."
              >
                <input type="text" inputMode="numeric" {...bind('maxVUs')} />
              </Field>
            </>
          )}
          <Field
            label="실행 시간 (duration)"
            id="rs-duration"
            error={errs.duration}
            hint="예: 30s, 2m"
          >
            <input type="text" {...bind('duration')} />
          </Field>
          <Field
            label="예열 시간 (warmup)"
            id="rs-warmup"
            error={errs.warmup}
            hint="이 시간의 측정은 결과에서 뺀다"
          >
            <input type="text" {...bind('warmup')} />
          </Field>
        </fieldset>

        <fieldset className="panel rs-set">
          <legend className="panel__h">3. 데이터</legend>
          <Field label="상품 수" id="rs-products" error={errs.products}>
            <input type="text" inputMode="numeric" {...bind('products')} />
          </Field>
          <Field label="상품당 재고" id="rs-stockPerProduct" error={errs.stockPerProduct}>
            <input type="text" inputMode="numeric" {...bind('stockPerProduct')} />
          </Field>
          <Field label="예열용 상품 수" id="rs-warmupProducts" error={errs.warmupProducts}>
            <input type="text" inputMode="numeric" {...bind('warmupProducts')} />
          </Field>
          <div className="rs-field">
            <span id="rs-dist-l" className="rs-lbl">
              주문이 몰리는 모양
            </span>
            <Seg<FormState['distKind']>
              label="주문이 몰리는 모양"
              value={form.distKind}
              onChange={(k) => set('distKind', k)}
              items={[
                { value: 'uniform', label: '고르게' },
                { value: 'zipf', label: '인기 상품에 쏠림' },
              ]}
            />
            <span className="rs-hint">
              {form.distKind === 'zipf'
                ? '일부 상품에 요청이 집중된다(zipf). 같은 행을 동시에 건드릴 확률이 올라간다.'
                : '모든 상품이 같은 확률로 주문된다(uniform).'}
            </span>
          </div>
          {form.distKind === 'zipf' && (
            <Field
              label="쏠림 정도 (s)"
              id="rs-zipfS"
              error={errs.zipfS}
              hint="클수록 인기 상품에 더 몰린다"
            >
              <input type="text" inputMode="decimal" {...bind('zipfS')} />
            </Field>
          )}
          <Field label="난수 시드" id="rs-seed" hint="같은 시드면 같은 데이터가 만들어진다">
            <input type="text" inputMode="numeric" {...bind('seed')} />
          </Field>
        </fieldset>

        <fieldset className="panel rs-set">
          <legend className="panel__h">4. 관측과 개입</legend>
          <div className="rs-field">
            <span id="rs-instr-l" className="rs-lbl">
              계측 수준
            </span>
            <Seg<FormState['instrumentation']>
              label="계측 수준"
              value={form.instrumentation}
              onChange={pickLevel}
              items={[
                { value: 'off', label: '끔' },
                { value: 'metrics', label: '지표' },
                { value: 'full', label: '전체' },
              ]}
            />
            <span className="rs-hint">
              켤수록 많이 보이지만 서버가 그만큼 일을 더 한다. 수준이 다른 실행끼리의 속도 비교는
              조건 차이로 표시된다.
            </span>
            {form.instrumentation === 'full' && stackProfiles && !stackProfiles.includes('trace') && (
              <span className="rs-hint" role="note" data-testid="no-trace-hint">
                <span className="badge t-wait">경고</span> 추적 저장소가 없다(trace 프로필 꺼짐).
                전체 계측의 추적이 버려지지만 실행은 무효가 아니다. 추적을 보려면 trace 프로필로
                스택을 띄운다.
              </span>
            )}
          </div>
          <label className="rs-inline">
            <input
              type="checkbox"
              checked={form.probeEnabled}
              onChange={(e) => set('probeEnabled', e.target.checked)}
            />
            PG 프로브 (DB 안의 잠금 대기·트랜잭션을 주기적으로 들여다본다)
          </label>
          {form.probeEnabled && (
            <Field label="프로브 간격 (ms)" id="rs-probeIntervalMs" error={errs.probeIntervalMs}>
              <input type="text" inputMode="numeric" {...bind('probeIntervalMs')} />
            </Field>
          )}
          <div className="rs-field">
            <span className="rs-lbl">경합 창 주입 (일부러 늘린 대기)</span>
            <span className="rs-hint">
              읽고 쓰는 사이에 대기를 넣어 경합이 일어나는 구간을 넓힌다. 넣으면 결과에 "주입됨"이
              붙어 자연 발생과 구분된다.
            </span>
            {form.injectDelay.map((d, i) => (
              <div className="rs-pair" key={i}>
                <select
                  aria-label={`주입 지점 ${i + 1}`}
                  value={d.point}
                  onChange={(e) =>
                    set(
                      'injectDelay',
                      form.injectDelay.map((x, j) =>
                        j === i ? { ...x, point: e.target.value } : x,
                      ),
                    )
                  }
                >
                  {INJECT_POINTS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`주입 지연 ${i + 1} (ms)`}
                  type="text"
                  inputMode="numeric"
                  value={d.ms}
                  onChange={(e) =>
                    set(
                      'injectDelay',
                      form.injectDelay.map((x, j) => (j === i ? { ...x, ms: e.target.value } : x)),
                    )
                  }
                />
                <span aria-hidden="true">ms</span>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    set(
                      'injectDelay',
                      form.injectDelay.filter((_, j) => j !== i),
                    )
                  }
                >
                  빼기
                </button>
                {errs[`inject${i}`] && (
                  <span className="rs-err" role="alert">
                    {errs[`inject${i}`]}
                  </span>
                )}
              </div>
            ))}
            <button
              type="button"
              className="btn"
              onClick={() =>
                set('injectDelay', [...form.injectDelay, { point: INJECT_POINTS[0].id, ms: '30' }])
              }
            >
              지연 추가
            </button>
          </div>
        </fieldset>

        <fieldset className="panel rs-set rs-wide">
          <legend className="panel__h">5. 예측 (필수)</legend>
          <Field
            label="결과가 어떻게 나올 것 같은지 한 줄로"
            id="rs-prediction"
            error={blockedByPrediction ? errs.prediction : undefined}
            hint="예: no-lock 은 2대에서 재고가 음수가 될 것이다. 실행 뒤 이 예측과 결과를 견준다."
          >
            <textarea
              id="rs-prediction"
              rows={2}
              required
              value={form.prediction}
              onChange={(e) => set('prediction', e.target.value)}
            />
          </Field>
          <Field label="실행 이름 (선택)" id="rs-label">
            <input type="text" {...bind('label')} />
          </Field>
        </fieldset>

        <section className="panel rs-sum rs-wide" aria-label="설정 요약">
          <h2 className="panel__h">요약</h2>
          <ul className="rs-sumlist">
            <li>
              {form.strategies.length}개 strategy × 앱 {form.appInstances || '—'}대 ={' '}
              {caseCount(form)}개 케이스
              {form.includeMemoryLockSingle ? ' (+ 메모리 락 1대 대조)' : ''}, 각 {form.reps || '—'}
              회
            </li>
            <li>
              {closed
                ? `동시 사용자 ${form.vus || '—'}명 고정`
                : `초당 ${form.rate || '—'}건 도착률 고정`}
              {' · '}
              {form.duration} (예열 {form.warmup})
            </li>
            <li>
              계측{' '}
              {form.instrumentation === 'off'
                ? '끔'
                : form.instrumentation === 'metrics'
                  ? '지표'
                  : '전체'}
              {' · '}PG 프로브 {form.probeEnabled ? `${form.probeIntervalMs}ms` : '끔'}
            </li>
          </ul>
          <div className="rs-badges">
            {injected && <span className="badge t-wait">주입됨</span>}
            {closed && <span className="badge t-info">동시 사용자 고정</span>}
            {!closed && <span className="badge t-info">도착률 고정</span>}
          </div>
          <div className="rs-actions">
            <button type="submit" className="btn is-sel" disabled={invalid || submitting}>
              {submitting ? '보내는 중…' : '실행'}
            </button>
            {blockedByPrediction && <span className="rs-hint">예측을 적으면 실행할 수 있다</span>}
            {!blockedByPrediction && invalid && (
              <span className="rs-hint">빨간 글씨로 표시된 입력을 고친다</span>
            )}
          </div>

          {busyId !== null && (
            <p className="rs-busy" role="alert">
              <span className="badge t-wait">진행 중</span> 이미 실행 중인 세션이 있다.{' '}
              {busyId ? (
                <a
                  href={href(busyId)}
                  onClick={(e) => {
                    e.preventDefault();
                    setAccepted(null);
                    setWatchId(busyId);
                    setBusyId(null);
                    globalThis.history?.replaceState(null, '', href(busyId));
                  }}
                >
                  진행 중인 세션 보기
                </a>
              ) : (
                '끝난 뒤 다시 실행한다.'
              )}
            </p>
          )}
          {errors.length > 0 && (
            <ul className="rs-err" role="alert">
              {errors.map((e) => (
                <li key={e.path + e.message}>
                  {e.path}: {e.message}
                </li>
              ))}
            </ul>
          )}
          {fail && (
            <p className="rs-err" role="alert">
              {fail}
            </p>
          )}
        </section>
      </form>

      {watchId && (
        <SessionProgress key={watchId} api={api} sessionId={watchId} accepted={accepted} />
      )}
    </div>
  );
}
