import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@/assets/styles.css';
import '../library/library.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startTheme } from '@/ui/theme';
import { Onboarding } from './Onboarding';

startTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Onboarding />
  </StrictMode>,
);
