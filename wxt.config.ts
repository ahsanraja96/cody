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
    permissions: ['tabs', 'tabGroups', 'storage', 'unlimitedStorage', 'alarms', 'contextMenus', 'favicon'],
    action: { default_title: 'Tabfold' },
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+F' },
        description: 'Open Tabfold',
      },
      'save-all': {
        suggested_key: { default: 'Ctrl+Shift+S', mac: 'Command+Shift+S' },
        description: 'Save all tabs and free memory',
      },
      // Ctrl/Cmd+Shift+W is Chrome's own "close window" shortcut, so saving a window uses Alt+Shift+W.
      'save-window': {
        suggested_key: { default: 'Alt+Shift+W' },
        description: 'Save this window',
      },
      'save-tab': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Save this tab',
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
