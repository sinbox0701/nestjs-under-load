import { useSyncExternalStore } from 'react';

/** 지금 실제로 적용된 테마(data-theme 우선, 없으면 시스템 설정). Monaco 테마 동기화용. */
function read(): 'light' | 'dark' {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function subscribe(cb: () => void): () => void {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener('change', cb);
  return () => {
    mo.disconnect();
    mq?.removeEventListener('change', cb);
  };
}

export function useResolvedTheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribe, read, () => 'light');
}
