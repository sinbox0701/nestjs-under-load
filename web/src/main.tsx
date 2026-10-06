import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/theme';
import { Shell } from './Shell';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
