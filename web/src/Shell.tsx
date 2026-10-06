import { Suspense, lazy, useEffect, useState } from 'react';
import { App } from './App';
import { applyTheme, readTheme, type ThemeChoice } from './theme/theme';

// 코드 실험실(Monaco 포함)은 고를 때만 불러온다.
const CodeLab = lazy(() => import('./learn/CodeLab').then((m) => ({ default: m.CodeLab })));

type View = 'stage' | 'lab';
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
const fromHash = (): View => (location.hash === '#lab' ? 'lab' : 'stage');

export function Shell() {
  const [view, setView] = useState<View>(fromHash);
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);

  // 무대 화면(App)은 자기 테마 버튼을 갖는다. 실험실에서 바로 열어도 저장된 테마가 적용되게 여기서도 맞춘다.
  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    const on = () => setView(fromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const go = (v: View) => {
    history.replaceState(null, '', v === 'lab' ? '#lab' : location.pathname + location.search);
    if (v === 'lab') setTheme(readTheme());
    setView(v);
  };

  return (
    <>
      <nav className="shellnav" aria-label="화면 전환">
        <div className="seg" role="tablist">
          {(
            [
              ['stage', '무대'],
              ['lab', '코드 실험실'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={view === v ? 'btn is-sel' : 'btn'}
              onClick={() => go(v)}
            >
              {label}
            </button>
          ))}
        </div>
        {view === 'lab' && (
          <button
            type="button"
            className="btn shellnav__tools"
            onClick={() => setTheme(NEXT_THEME[readTheme()])}
          >
            테마: {THEME_LABEL[theme]}
          </button>
        )}
      </nav>
      {view === 'stage' ? (
        <App />
      ) : (
        <Suspense fallback={<p className="shellnav__loading dim">코드 실험실 불러오는 중…</p>}>
          <CodeLab />
        </Suspense>
      )}
    </>
  );
}
