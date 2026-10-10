import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@/assets/styles.css';
import './popup.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startTheme } from '@/ui/theme';
import { PopupApp } from './PopupApp';

startTheme();
const params = new URLSearchParams(location.search);
if (params.get('mode') === 'window') document.documentElement.dataset.mode = 'window';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
);
