import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { App } from './App';
import { createApi, type Api } from './api';
import { Seg } from './components/lib/Seg';
import { CompareRoute } from './screens/compare';
import { HistoryScreen } from './screens/history';
import { LiveScreen } from './screens/live';
import { MetricsScreen } from './screens/metrics';
import { RunSetup } from './screens/run';
import { applyTheme, readTheme, type ThemeChoice } from './theme/theme';

// 코드 실험실(Monaco 포함)은 고를 때만 불러온다.
const CodeLab = lazy(() => import('./learn/CodeLab').then((m) => ({ default: m.CodeLab })));

type View = 'stage' | 'run' | 'live' | 'metrics' | 'history' | 'compare' | 'lab';
const TABS: { value: View; label: string }[] = [
  { value: 'stage', label: '무대' },
  { value: 'run', label: '실행 설정' },
  { value: 'live', label: '서버 속' },
  { value: 'metrics', label: '지표' },
  { value: 'history', label: '실행 기록' },
  { value: 'compare', label: '비교' },
  { value: 'lab', label: '코드 실험실' },
];
const VIEWS = new Set<string>(TABS.map((t) => t.value));
const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};
const THEME_LABEL: Record<ThemeChoice, string> = {
  system: '시스템',
  light: '라이트',
  dark: '다크',
};

/**
 * 해시 라우팅: `#<화면>[?쿼리]`. 예) `#run?scenario=…&situation=…`, `#compare?batches=a,b&axis=…`.
 * 해시가 없으면 무대. 실행 설정이 만드는 `#session=<id>` 같은 옛 형태는 서버 속으로 보낸다.
 */
function parseHash(hash: string): { view: View; query: string } {
  const raw = hash.replace(/^#/, '');
  const i = raw.indexOf('?');
  const name = i < 0 ? raw : raw.slice(0, i);
  const query = i < 0 ? '' : raw.slice(i);
  if (VIEWS.has(name)) return { view: name as View, query };
  if (name.startsWith('session=')) return { view: 'live', query: `?${raw}` };
  return { view: 'stage', query: '' };
}

/** 역사 화면이 돌려주는 경로형 주소(`/compare?batches=…`)를 해시 주소로 바꾼다. */
function toHash(url: string): string {
  return `#${url.replace(/^\/+/, '')}`;
}

// 목 모드: 오케스트레이터 없이 화면을 본다(`VITE_MOCK=1` 로 dev 를 띄우거나 주소에 `?mock`).
const useMock = () =>
  import.meta.env.VITE_MOCK === '1' || new URLSearchParams(location.search).has('mock');

/** 화면 머리 출처 배지. 무대는 가상 기록, 서버 속·비교는 실제 실행값이다. */
function SourceBadge({ kind }: { kind: 'sim' | 'measured' }) {
  return (
    <div className="shellnav">
      <span
        className={kind === 'sim' ? 'badge t-neutral' : 'badge t-info'}
        data-testid="source-badge"
      >
        {kind === 'sim' ? '시뮬레이션' : '실측'}
      </span>
      <span className="small dim">
        {kind === 'sim'
          ? '규칙대로 만든 가상 기록 — 실측이 아니다'
          : '오케스트레이터가 실제로 돌린 실행의 값'}
      </span>
    </div>
  );
}

/** 지표: run 이 주소에 없으면 가장 최근 실행을 쓴다. */
function MetricsTab({ api, run }: { api: Api; run: string | null }) {
  const [latest, setLatest] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (run) return;
    let alive = true;
    api.listRuns({ limit: 1 }).then(
      (l) => alive && setLatest(l.items[0]?.runId ?? null),
      () => alive && setLatest(null),
    );
    return () => {
      alive = false;
    };
  }, [api, run]);
  const runId = run ?? latest;
  if (runId === undefined) return <p className="shellnav__loading dim">실행 불러오는 중…</p>;
  if (!runId)
    return (
      <p className="shellnav__loading dim" role="status">
        아직 실행한 기록이 없다. 실행 설정에서 먼저 실행한다.
      </p>
    );
  return <MetricsScreen runId={runId} api={api} />;
}

export function Shell() {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const mock = useMock();
  const api = useMemo(() => createApi({ mock }), [mock]);

  // 테마 버튼은 여기 하나다. 무대의 T 단축키가 html 속성을 바꾸면 버튼 표시도 따라가게 지켜본다.
  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(readTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    const on = () => {
      setRoute(parseHash(location.hash));
      setTheme(readTheme());
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const go = (v: View) => {
    location.hash = `#${v}`;
  };
  const { view, query } = route;
  const q = new URLSearchParams(query);

  return (
    <>
      <nav className="shellnav nul" aria-label="화면 전환" style={{ flexWrap: 'wrap' }}>
        <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
          <Seg<View> label="화면" items={TABS} value={view} onChange={go} />
        </div>
        <button
          type="button"
          className="btn shellnav__tools"
          onClick={() => setTheme(NEXT_THEME[readTheme()])}
        >
          테마: {THEME_LABEL[theme]}
        </button>
      </nav>
      {view === 'stage' && (
        <>
          <SourceBadge kind="sim" />
          <App />
        </>
      )}
      {view === 'run' && (
        <RunSetup
          key={query}
          api={api}
          search={query}
          // session 은 읽지 않는다: 서버 속 화면(LiveScreen)이 현재 세션을 구독하므로 링크 형태만 유지한다.
          sessionHref={(id) => `#live?session=${encodeURIComponent(id)}`}
        />
      )}
      {view === 'live' && (
        <LiveScreen api={api} {...(q.get('run') ? { runId: q.get('run')! } : {})} />
      )}
      {view === 'metrics' && (
        <>
          <SourceBadge kind="measured" />
          <MetricsTab key={query} api={api} run={q.get('run')} />
        </>
      )}
      {view === 'history' && (
        <HistoryScreen api={api} onNavigate={(url) => (location.hash = toHash(url))} />
      )}
      {view === 'compare' && (
        <>
          <SourceBadge kind="measured" />
          <CompareRoute key={query} api={api} search={query} />
        </>
      )}
      {view === 'lab' && (
        <Suspense fallback={<p className="shellnav__loading dim">코드 실험실 불러오는 중…</p>}>
          <CodeLab api={api} />
        </Suspense>
      )}
    </>
  );
}
