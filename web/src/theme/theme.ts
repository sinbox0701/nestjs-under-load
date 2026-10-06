import './tokens.css';
import './base.css';

export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'nul.theme';

/** 테마 선택은 편의 기능이라 저장소가 막혀도 동작해야 한다(DESIGN_SYSTEM §1.3). */
export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* 저장 실패는 무시 */
  }
}

/** 무대 캔버스용 팔레트(다크에서도 바꾸지 않는다). */
export const PALETTE = {
  ink: 0x1e222a,
  slate: 0x4b5262,
  mist: 0xb9c0ca,
  shell: 0xe2e4e8,
  paper: 0xf6f7f3,
  ok: 0x1f7f45,
  wait: 0xe2ae24,
  bad: 0xcc3b34,
  retry: 0xeb7a2c,
  info: 0x2f6bcb,
  skin: 0xf0c39c,
  wood: 0x94704f,
} as const;
