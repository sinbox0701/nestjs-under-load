import type { ThemeChoice } from '../theme/theme';

const TABS = ['시나리오', '실행', '비교', '기록', '지표'] as const;

export interface TopBarProps {
  current: (typeof TABS)[number];
  theme: ThemeChoice;
  onThemeChange: (t: ThemeChoice) => void;
}

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<ThemeChoice, string> = { system: '시스템', light: '라이트', dark: '다크' };

export function TopBar({ current, theme, onThemeChange }: TopBarProps) {
  return (
    <header className="panel topbar">
      <strong className="topbar__brand">nestjs-under-load</strong>
      <nav aria-label="화면">
        <ul className="topbar__tabs">
          {TABS.map((t) => (
            <li key={t}>
              <a
                href="#"
                className={t === current ? 'btn is-sel' : 'btn'}
                aria-current={t === current ? 'page' : undefined}
                onClick={(e) => e.preventDefault()}
              >
                {t}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <button type="button" className="btn" onClick={() => onThemeChange(NEXT[theme])}>
        테마: {LABEL[theme]}
      </button>
    </header>
  );
}
