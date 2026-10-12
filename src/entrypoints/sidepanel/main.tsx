import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@/assets/styles.css';
import './panel.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startTheme } from '@/ui/theme';
import { PanelApp } from './PanelApp';

/** Tabfold in Chrome's side panel (1.0, Fi-Panel boards): stays open while you browse. */
startTheme();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PanelApp />
  </StrictMode>,
);
