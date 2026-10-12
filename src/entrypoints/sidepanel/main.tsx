import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@/assets/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startTheme } from '@/ui/theme';

/**
 * Tabfold in Chrome's side panel (1.0, Fi-Panel boards): stays open while you browse. Placeholder
 * until the screens are built.
 */
startTheme();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main className="p-4 text-text">Tabfold</main>
  </StrictMode>,
);
