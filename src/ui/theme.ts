import { getSettings, watchSettings, type ThemeSetting } from '@/lib/settings';

export function applyTheme(theme: ThemeSetting): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/** Apply the saved theme and keep following it; colours update live when it changes. */
export function startTheme(): () => void {
  getSettings().then((s) => applyTheme(s.theme)).catch(() => undefined);
  return watchSettings((s) => applyTheme(s.theme));
}
