import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@/assets/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startTheme } from '@/ui/theme';
import { LibraryApp } from './LibraryApp';

startTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LibraryApp />
  </StrictMode>,
);
