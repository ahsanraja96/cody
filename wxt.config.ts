import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

/**
 * Where the extension pages and worker may connect in production: only ExtensionPay (payments and
 * sign-in) and the Tabfold server, when this build has one (WXT_TABFOLD_API, read from the
 * environment or .env at build time). Free makes no requests; both answer CORS, so no host
 * permissions are needed.
 */
function connectSources(): string {
  // WXT has loaded .env files into process.env by the time the manifest is built.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const sources = ["'self'"];
  // WXT_EXTPAY_HOST is only set by the end-to-end test (a fake ExtensionPay).
  for (const [name, value] of [
    ['WXT_EXTPAY_HOST', env.WXT_EXTPAY_HOST?.trim() || 'https://extensionpay.com'],
    ['WXT_TABFOLD_API', env.WXT_TABFOLD_API?.trim()],
  ] as const) {
    if (!value) continue;
    try {
      sources.push(new URL(value).origin);
    } catch {
      throw new Error(`${name} is not a valid URL: ${value}`);
    }
  }
  return sources.join(' ');
}

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  // The end-to-end Pro test builds a separate copy with a fake ExtensionPay and server.
  outDir: (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.TABFOLD_OUT_DIR || '.output',
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
    // Asked for only when the person chooses "Save them to Chrome bookmarks" (before removing Tabfold).
    optional_permissions: ['bookmarks'],
    action: { default_title: 'Tabfold' },
    // "save-tab" keeps the id earlier versions used, so a shortcut a person changed keeps working.
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+F' },
        description: 'Open Tabfold',
      },
      fold: {
        suggested_key: { default: 'Ctrl+Shift+S', mac: 'Command+Shift+S' },
        description: 'Fold tabs (asks which windows when several are open)',
      },
      'save-tab': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Fold this tab',
      },
    },
    // In production nothing may talk to the network except ExtensionPay and the Tabfold server (Pro).
    // Dev mode needs the Vite server, so WXT manages CSP there.
    ...(mode === 'production'
      ? {
          content_security_policy: {
            extension_pages: `default-src 'self'; script-src 'self'; object-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src ${connectSources()}; worker-src 'self'`,
          },
        }
      : {}),
  }),
  vite: () => ({
    plugins: [tailwindcss()],
    worker: { format: 'es' },
  }),
});
