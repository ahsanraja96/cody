// End-to-end test of Pro and Pro AI: a build of the extension pointed at a fake ExtensionPay and at
// the real server code (server/supabase/functions/tabfold/app.ts) with an in-memory store and a
// fake model, driven in real Chromium. Run with `npm run e2e:pro`: it builds that copy into
// .output-pro first (SKIP_BUILD=1 reuses it). Screenshots go to e2e/screenshots/pro (or $SHOTS_DIR/pro).
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome } from './cdp.mjs';
import { handle } from '../server/supabase/functions/tabfold/app.ts';
import { createModel } from '../server/supabase/functions/tabfold/ai.ts';
import { MemoryStore } from '../tests/server/memoryStore.ts';

export const EXTPAY_PORT = 47811;
export const API_PORT = 47812;
const EXTPAY_ID = 'tabfold-test';
const EXT = path.resolve(process.env.TABFOLD_OUT_DIR ?? '.output-pro', 'chrome-mv3');
const SHOTS = path.resolve(process.env.SHOTS_DIR ?? 'e2e/screenshots', 'pro');
mkdirSync(SHOTS, { recursive: true });

if (!process.env.SKIP_BUILD) {
  const built = spawnSync('npx', ['wxt', 'build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      TABFOLD_OUT_DIR: path.dirname(EXT),
      WXT_EXTPAY_ID: EXTPAY_ID,
      WXT_EXTPAY_HOST: `http://127.0.0.1:${EXTPAY_PORT}`,
      WXT_TABFOLD_API: `http://127.0.0.1:${API_PORT}/tabfold`,
    },
  });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 10_000, step = 200) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  return last;
}
const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Fake ExtensionPay: keys, users, and the trial page that starts a trial when visited.
const users = new Map();
let keys = 0;
const extpay = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${EXTPAY_PORT}`);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, accept' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  const base = `/extension/${EXTPAY_ID}`;
  const key = url.searchParams.get('api_key') ?? '';
  if (req.method === 'POST' && url.pathname === `${base}/api/new-key`) {
    const created = `test-key-${++keys}`;
    users.set(created, { paid: false, email: null, trialStartedAt: null, installedAt: new Date().toISOString() });
    return res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(created));
  }
  if (url.pathname === `${base}/api/v2/user`) {
    const user = users.get(key);
    if (!user) return res.writeHead(404, cors).end('unknown key');
    return res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(user));
  }
  if (url.pathname === `${base}/trial`) {
    const user = users.get(key);
    if (user) Object.assign(user, { email: 'e2e@example.com', trialStartedAt: new Date().toISOString() });
    return res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Trial started</title><h1>Your trial has started</h1>');
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(`<title>ExtensionPay</title><h1>${url.pathname}</h1>`);
});

// ---------------------------------------------------------------------------------------------
// The Tabfold server: the real request handling, an in-memory store and a fake model.
const store = new MemoryStore();
const modelCalls = [];
const model = createModel(async (_system, user, schema) => {
  const kind = schema === undefined ? '' : JSON.stringify(schema);
  modelCalls.push(kind.includes('groups') ? 'organise' : kind.includes('summary') ? 'context' : 'name');
  if (kind.includes('groups')) {
    // Put the Stripe, Supabase and React pages in "Checkout app", the Lisbon page in "Holiday in Lisbon".
    const lines = user.split('\n').filter((l) => /^\d+\. /.test(l));
    const pick = (re) => lines.filter((l) => re.test(l)).map((l) => Number(l.split('.')[0]));
    return {
      groups: [
        { name: 'Checkout app', tabs: pick(/Stripe|Supabase|React/i) },
        { name: 'Holiday in Lisbon', tabs: pick(/Lisbon/i) },
      ],
    };
  }
  if (kind.includes('summary')) return { summary: 'Docs and dashboards for the checkout app.' };
  return { name: 'Checkout app · Stripe webhooks' };
});
const api = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const request = new Request(`http://127.0.0.1:${API_PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' ? undefined : body,
  });
  const response = await handle(request, {
    store,
    extpayUser: async (apiKey) => users.get(apiKey) ?? null,
    model,
    now: () => Date.now(),
    config: { extpayId: EXTPAY_ID, allowedOrigins: ['*'] },
  });
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
});

// Pages to fold.
const PAGES = {
  'stripe-webhooks': 'Webhooks | Stripe Documentation',
  supabase: 'Table editor · checkout-app · Supabase',
  react: 'useOptimistic – React',
  lisbon: 'Holiday flats in Lisbon',
  news: 'Hacker News',
};
const site = http.createServer((req, res) => {
  const name = (req.url ?? '/').slice(1) || 'home';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>${PAGES[name] ?? name}</title><h1>${name}</h1>`);
});

await Promise.all([
  new Promise((r) => extpay.listen(EXTPAY_PORT, '127.0.0.1', r)),
  new Promise((r) => api.listen(API_PORT, '127.0.0.1', r)),
  new Promise((r) => site.listen(0, '127.0.0.1', r)),
]);
const page = (name) => `http://127.0.0.1:${site.address().port}/${name}`;

// ---------------------------------------------------------------------------------------------
const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tabfold-pro-'));
const browser = await launchChrome({ extensionDir: EXT, userDataDir });
const extId = await browser.extensionId();
const ext = (p) => `chrome-extension://${extId}/${p}`;
const pages = [];
async function open(url, size) {
  const p = await browser.openPage(url, size);
  pages.push(p);
  return p;
}
const hasText = (p, text, timeout = 6000) =>
  p.waitFor((t) => document.body?.innerText.toLowerCase().includes(t.toLowerCase()), text, timeout);

const control = await open(ext('library.html'));
await control.evaluate(() => chrome.tabs.getCurrent().then((t) => chrome.tabs.update(t.id, { pinned: true })));
const send = (command) => control.evaluate((c) => new Promise((res) => chrome.runtime.sendMessage({ __tabfold: true, command: c }, res)), command);
const local = (key) => control.evaluate((k) => chrome.storage.local.get(k).then((r) => r[k]), key);
const idb = (storeName) =>
  control.evaluate(
    (s) =>
      new Promise((resolve) => {
        const req = indexedDB.open('tabfold');
        req.onsuccess = () => {
          const q = req.result.transaction(s).objectStore(s).getAll();
          q.onsuccess = () => {
            resolve(q.result);
            req.result.close();
          };
        };
      }),
    storeName,
  );

// Free to start with: the plans page offers the trial.
const plans = await open(ext('library.html#/pro'));
check('the plans page offers Pro and the Pro AI trial', (await hasText(plans, 'Tabfold Pro', 8000)) && (await hasText(plans, 'Start 7-day free trial', 4000)));
check('Pro is switched on in this build', !(await plans.evaluate(() => document.body.innerText.includes('switched on'))));
await plans.screenshot(path.join(SHOTS, 'plans.png'));

// Start the trial: ExtensionPay's trial page opens; Tabfold notices the trial by itself.
await plans.clickText('Start 7-day free trial');
const plan = await until(async () => {
  const p = await local('plan');
  return p?.tier === 'pro-ai' ? p : null;
}, 25_000, 500);
check('starting the trial gives Pro AI, noticed without the payment library', !!plan && !!plan.trial, JSON.stringify(plan?.trial ?? plan));
await sleep(500);
const popups = (await control.evaluate(() => chrome.windows.getAll({ populate: true }))).filter((w) => w.type === 'popup');
for (const w of popups) await control.evaluate((id) => chrome.windows.remove(id), w.id);

const settings = await open(ext('library.html#/settings'));
check('Settings › Your plan shows the trial', (await hasText(settings, 'Pro AI trial', 8000)) && (await hasText(settings, 'left', 2000)));
await settings.screenshot(path.join(SHOTS, 'settings-trial.png'));

// Fold some tabs: they sync to the account, and the fold gets a smart name.
await control.evaluate((urls) => chrome.windows.create({ url: urls, focused: false }), [page('stripe-webhooks'), page('supabase'), page('react')]);
await control.evaluate((urls) => chrome.windows.create({ url: urls, focused: false }), [page('lisbon'), page('news')]);
await sleep(1500);
const folded = await send({ type: 'fold' });
check('fold works on Pro AI', folded?.ok && folded.data.savedTabs === 5, JSON.stringify(folded?.data?.savedTabs ?? folded));
const named = await until(async () => (await idb('sessions')).find((s) => s.smartName), 15_000, 500);
check('the fold gets a smart name from the AI', named?.smartName === 'Checkout app · Stripe webhooks', named?.smartName);
const synced = await until(async () => {
  const account = store.accounts.get('e2e@example.com');
  const items = account ? store.sync.get(account)?.items ?? {} : {};
  return Object.keys(items).some((k) => k.startsWith('tf.c')) ? items : null;
}, 20_000, 500);
check('folded tabs sync to the Tabfold account', !!synced);
const cloudStatus = await until(async () => {
  const s = await local('cloudSyncStatus');
  return s?.state === 'synced' ? s : null;
}, 15_000, 500);
check('the account sync status says synced', cloudStatus?.syncedTabs === 5, JSON.stringify(cloudStatus));
const chromeStatus = await local('syncStatus');
check('Chrome sync pauses while the account syncs', chromeStatus?.state === 'off', JSON.stringify(chromeStatus));

// Organise with AI: preview, then group the list by project.
const list = await open(ext('library.html'));
check('the full list shows the smart name and the plan', (await hasText(list, 'Checkout app · Stripe webhooks', 8000)) && (await hasText(list, 'Pro AI', 2000)));
await list.clickText('Organise with AI');
check('Organise with AI shows the projects first', (await hasText(list, 'Group my list by project', 15_000)) && (await hasText(list, 'Holiday in Lisbon', 2000)));
await sleep(300);
await list.screenshot(path.join(SHOTS, 'organise.png'));
await list.clickText('Group my list by project');
const grouped = await until(async () => {
  const tabs = await idb('tabs');
  return tabs.filter((t) => t.project).length >= 4 ? tabs : null;
}, 10_000, 300);
check('applying puts the tabs in projects', !!grouped, grouped ? grouped.map((t) => `${t.project ?? '-'}`).join(', ') : 'none');
check('the list switches to By project', (await hasText(list, 'By project', 6000)) && (await hasText(list, 'Everything else', 4000)));
await sleep(300);
await list.screenshot(path.join(SHOTS, 'by-project.png'));
const runs = await local('aiRuns');
check('the run is counted (1 of 300)', runs?.used === 1 && runs?.limit === 300, JSON.stringify(runs));

// Copy as context and backups, through the worker.
const checkout = (await idb('tabs')).filter((t) => t.project === 'Checkout app');
const context = await send({ type: 'ai-context', tabRecordIds: checkout.map((t) => t.id), name: 'Checkout app' });
check('Copy as context gives Markdown with an AI summary', context?.ok && context.data.markdown.includes('## Checkout app') && context.data.markdown.includes('Docs and dashboards'), context?.data?.markdown?.split('\n')[2]);
const backups = await send({ type: 'backups-list' });
check('a backup of today exists', backups?.ok && backups.data.length === 1 && backups.data[0].tabCount === 5, JSON.stringify(backups?.data));
// Take the Lisbon tab out of the list (straight from the database), then bring it back from the backup.
await control.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open('tabfold');
      req.onsuccess = () => {
        const store = req.result.transaction('tabs', 'readwrite').objectStore('tabs');
        store.getAll().onsuccess = (e) => {
          const tab = e.target.result.find((t) => t.url.endsWith('/lisbon'));
          store.delete(tab.id).onsuccess = () => {
            req.result.close();
            resolve(true);
          };
        };
      };
    }),
);
await until(async () => !(await idb('tabs')).some((t) => t.url.endsWith('/lisbon')), 6000, 300);
const restored = await send({ type: 'backup-restore', day: backups.data[0].day });
check('restoring a backup brings back the removed tab, deleting nothing', restored?.ok && restored.data.restored === 1 && (await idb('tabs')).length === 5, JSON.stringify(restored?.data));

// The trial ends: the list, projects and backups stay; a one-time notice says so.
const inProjects = (await idb('tabs')).filter((t) => t.project).length;
for (const user of users.values()) if (user.trialStartedAt) user.trialStartedAt = new Date(Date.now() - 8 * DAY).toISOString();
await send({ type: 'plan-open', page: 'login' });
const ended = await until(async () => {
  const p = await local('plan');
  return p?.tier === 'free' ? p : null;
}, 25_000, 500);
check('when the trial ends the plan goes back to Free', !!ended);
for (const w of (await control.evaluate(() => chrome.windows.getAll())).filter((w) => w.type === 'popup')) {
  await control.evaluate((id) => chrome.windows.remove(id), w.id);
}
const afterList = await open(ext('library.html'));
check('a notice says the trial ended', await hasText(afterList, 'Your Pro AI trial has ended', 8000));
check(
  'projects stay after the trial',
  inProjects >= 3 && (await idb('tabs')).filter((t) => t.project).length === inProjects && (await local('projects'))?.projects?.length === 2,
);
await afterList.screenshot(path.join(SHOTS, 'trial-ended.png'));
const chromeBack = await until(async () => {
  await send({ type: 'sync-now' });
  const s = await local('syncStatus');
  return s?.state === 'synced' ? s : null;
}, 15_000, 1000);
check('Chrome sync takes over again', !!chromeBack, JSON.stringify(await local('syncStatus')));

// Remove Tabfold: take your tabs with you first (Reopen all; we never press Remove here).
const removeSettings = await open(ext('library.html#/settings'));
await hasText(removeSettings, 'Remove Tabfold', 6000);
await removeSettings.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim().startsWith('Remove Tabfold'))?.click());
check('Remove Tabfold… offers to take the tabs along first', (await hasText(removeSettings, 'Before you remove Tabfold', 6000)) && (await hasText(removeSettings, 'Save to bookmarks', 2000)));
await removeSettings.screenshot(path.join(SHOTS, 'remove.png'));
const reopened = await send({ type: 'reopen-everything' });
check('Reopen all reopens every folded tab', reopened?.ok && reopened.data.opened >= 5, JSON.stringify(reopened?.data));

check('the model was only asked for names, projects and summaries', modelCalls.length >= 3 && modelCalls.every((c) => ['organise', 'name', 'context'].includes(c)), modelCalls.join(','));
const pageErrors = pages.flatMap((p) => p.errors);
check('no errors in extension pages', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
for (const server of [extpay, api, site]) server.close();
rmSync(userDataDir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
