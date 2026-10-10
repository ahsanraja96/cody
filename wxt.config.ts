import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  imports: false,
  modules: ['@wxt-dev/module-react'],
  manifest: ({ mode }) => ({
    name: 'Tabfold',
    short_name: 'Tabfold',
    description:
      'Save and restore tabs and whole windows, free memory, and find any tab by title, address or keyword.',
    // Minimal permissions: no host permissions and no content scripts. Tabfold never reads web pages.
    // system.memory reads the computer's free memory before and after a fold (no install warning).
    permissions: ['tabs', 'tabGroups', 'storage', 'unlimitedStorage', 'alarms', 'contextMenus', 'favicon', 'system.memory'],
    action: { default_title: 'Tabfold' },
    // "save-tab" keeps the id earlier versions used, so a shortcut a person changed keeps working.
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+F' },
        description: 'Open Tabfold',
      },
      fold: {
        suggested_key: { default: 'Ctrl+Shift+S', mac: 'Command+Shift+S' },
        description: 'Fold all tabs',
      },
      'save-tab': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Fold this tab',
      },
    },
    // In production nothing may talk to the network. Dev mode needs the Vite server, so WXT manages CSP there.
    ...(mode === 'production'
      ? {
          content_security_policy: {
            extension_pages:
              "default-src 'self'; script-src 'self'; object-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; worker-src 'self'",
          },
        }
      : {}),
  }),
  vite: () => ({
    plugins: [tailwindcss()],
    worker: { format: 'es' },
  }),
});
