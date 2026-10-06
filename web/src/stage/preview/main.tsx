/** 무대 단독 미리보기 진입점(개발용, 빌드 입력 아님): `pnpm dev` 후 /src/stage/preview/index.html. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../theme/theme';
import { Preview } from './Preview';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
