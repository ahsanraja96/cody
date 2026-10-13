import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

/**
 * Where the extension pages and worker may connect in production: only the Tabfold server, when
 * this build has one (WXT_TABFOLD_API, read from the environment or .env at build time). Payments
 * happen on Stripe's own pages, opened in a tab, so the extension never connects to Stripe. Free
 * makes no requests; the server answers CORS, so no host permissions are needed.
 */
function connectSources(): string {
  // WXT has loaded .env files into process.env by the time the manifest is built.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const sources = ["'self'"];
  const api = env.WXT_TABFOLD_API?.trim();
  if (api) {
    try {
      sources.push(new URL(api).origin);
    } catch {
      throw new Error(`WXT_TABFOLD_API is not a valid URL: ${api}`);
    }
  }
  return sources.join(' ');
}

/**
 * The site that shows shared folders (WXT_SHARE_ORIGIN, default https://tabfold.truewidgets.com). Its pages may
 * ask Tabfold to "Save to my Tabfold" (externally_connectable; no install warning). Match patterns
 * take no port, so a local test server's port is dropped.
 */
function shareMatches(): string[] {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const value = env.WXT_SHARE_ORIGIN?.trim() || 'https://tabfold.truewidgets.com';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`WXT_SHARE_ORIGIN is not a valid URL: ${value}`);
  }
  return [`${url.protocol}//${url.hostname}/*`];
}

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  // The end-to-end Pro test builds a separate copy pointed at a local server and a fake Stripe.
  outDir: (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.TABFOLD_OUT_DIR || '.output',
  imports: false,
  modules: ['@wxt-dev/module-react'],
  manifest: ({ mode }) => ({
    name: 'Tabfold',
    short_name: 'Tabfold',
    description:
      'Fold your tabs into one list, free the memory they used, and find any tab again. Folders, side panel, search and sync.',
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
      // The 4th suggested key, Chrome's maximum.
      'snooze-tab': {
        suggested_key: { default: 'Alt+Shift+Z' },
        description: 'Snooze this tab until tomorrow morning',
      },
    },
    externally_connectable: { matches: shareMatches() },
    // In production nothing may talk to the network except the Tabfold server (Pro).
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
