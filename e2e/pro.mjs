// End-to-end test of Pro, Pro AI, Pro for life and Teams: a build of the extension pointed at the
// real server code (server/supabase/functions/tabfold/app.ts) with an in-memory store, a fake Stripe
// (tests/server/fakeStripe.ts: its REST API, checkout and billing pages, signed webhooks), a mailer
// that keeps the sign-in codes, a fake model, and the public share site (web/), driven in real
// Chromium.
// Run with `npm run e2e:pro`: it builds that copy into .output-pro first (SKIP_BUILD=1 reuses it).
// Screenshots go to e2e/screenshots/pro (or $SHOTS_DIR/pro).
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome } from './cdp.mjs';
import { handle } from '../server/supabase/functions/tabfold/app.ts';
import { createModel } from '../server/supabase/functions/tabfold/ai.ts';
import { createStripe } from '../server/supabase/functions/tabfold/stripe.ts';
import { MemoryStore } from '../tests/server/memoryStore.ts';
import { memoryMailer } from '../tests/server/memoryMailer.ts';
import { serveWeb, startFakeStripe } from '../tests/server/fakeStripe.ts';

export const API_PORT = 47812;
export const STRIPE_PORT = 47813;
export const SHARE_PORT = 47814;
const API = `http://127.0.0.1:${API_PORT}/tabfold`;
const SHARE_SITE = `http://127.0.0.1:${SHARE_PORT}`;
const EXT = path.resolve(process.env.TABFOLD_OUT_DIR ?? '.output-pro', 'chrome-mv3');
const SHOTS = path.resolve(process.env.SHOTS_DIR ?? 'e2e/screenshots', 'pro');
mkdirSync(SHOTS, { recursive: true });

if (!process.env.SKIP_BUILD) {
  const built = spawnSync('npx', ['wxt', 'build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, TABFOLD_OUT_DIR: path.dirname(EXT), WXT_TABFOLD_API: API, WXT_SHARE_ORIGIN: SHARE_SITE },
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

// ---------------------------------------------------------------------------------------------
// The Tabfold server: the real request handling, an in-memory store, a fake Stripe, a mailer that
// keeps the codes, and a fake model.
const WEBHOOK_SECRET = 'whsec_e2e_test';
const store = new MemoryStore();
const mailer = memoryMailer();
const modelCalls = [];
/** The numbered tab lines the model was sent ("3. [site] title"), only from the <tabs> block. */
const tabLines = (user) => (user.split('<tabs>')[1] ?? '').split('\n').filter((l) => /^\d+\. /.test(l));
const pick = (lines, re) => lines.filter((l) => re.test(l)).map((l) => Number(l.split('.')[0]));
const model = createModel(async (_system, user, schema) => {
  const kind = schema === undefined ? '' : JSON.stringify(schema);
  const lines = tabLines(user);
  // The tidy-up's schema also has a "summary", so look for the list names first.
  if (kind.includes('suggestions')) {
    modelCalls.push('tidy');
    // The kitchen tabs nobody opened in a month belong in a new folder.
    return { suggestions: [{ summary: `${pick(lines, /kitchen|tiles|oven|worktop/i).length} tabs about the kitchen`, folder: 0, name: 'Kitchen renovation', tabs: pick(lines, /kitchen|tiles|oven|worktop/i) }] };
  }
  if (kind.includes('matches')) {
    modelCalls.push('ask');
    return { matches: pick(lines, /Lisbon/i).map((tab) => ({ tab, reason: 'Flats for the Lisbon trip' })) };
  }
  modelCalls.push(kind.includes('groups') ? 'organise' : kind.includes('summary') ? 'context' : 'name');
  if (kind.includes('groups')) {
    // Put the Stripe, Supabase and React pages in "Checkout app", the Lisbon page in "Holiday in Lisbon".
    return {
      groups: [
        { name: 'Checkout app', tabs: pick(lines, /Stripe|Supabase|React/i) },
        { name: 'Holiday in Lisbon', tabs: pick(lines, /Lisbon/i) },
      ],
    };
  }
  if (kind.includes('summary')) return { summary: 'Docs and dashboards for the checkout app.' };
  return { name: 'Checkout app · Stripe webhooks' };
});
const serverLog = [];
const deps = {
  store,
  payments: null,
  mailer,
  model,
  now: () => Date.now(),
  config: { allowedOrigins: ['*'], publicUrl: API, shareBaseUrl: SHARE_SITE, automaticTax: false, codeSecret: 'e2e-code-secret' },
  log: (message) => serverLog.push(message),
};
const api = await serveWeb((request) => handle(request, deps), { port: API_PORT });
const stripe = await startFakeStripe({ port: STRIPE_PORT, webhookSecret: WEBHOOK_SECRET, webhookUrl: `${API}/stripe/webhook` });
deps.payments = createStripe({ secretKey: 'sk_test_e2e', webhookSecret: WEBHOOK_SECRET, apiBase: stripe.url });

// Pages to fold.
const PAGES = {
  'stripe-webhooks': 'Webhooks | Stripe Documentation',
  supabase: 'Table editor · checkout-app · Supabase',
  react: 'useOptimistic – React',
  lisbon: 'Holiday flats in Lisbon',
  news: 'Hacker News',
  docs: 'Route Handlers | Next.js',
};
const site = http.createServer((req, res) => {
  const name = (req.url ?? '/').slice(1) || 'home';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>${PAGES[name] ?? name}</title><h1>${name}</h1>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const page = (name) => `http://127.0.0.1:${site.address().port}/${name}`;

// The public share site (web/), as Netlify serves it: /s/<id> is s.html; config.js points at the
// test server and this browser's Tabfold.
const WEB = path.resolve('web');
const siteConfig = { API_URL: API, EXTENSION_ID: '', STORE_URL: 'https://chromewebstore.google.com/' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const shareSite = http.createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', SHARE_SITE);
  if (pathname === '/config.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'] }).end(`window.TABFOLD_CONFIG = ${JSON.stringify(siteConfig)};`);
    return;
  }
  const file = path.join(WEB, pathname.startsWith('/s/') ? 's.html' : path.normalize(pathname.slice(1) || 'index.html'));
  if (!file.startsWith(WEB + path.sep) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => shareSite.listen(SHARE_PORT, '127.0.0.1', r));

const accountOf = (email) => [...store.accounts.values()].find((a) => a.email === email);
const OWNER = 'e2e@example.com';
const BUYER = 'new@example.com';

// ---------------------------------------------------------------------------------------------
const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tabfold-pro-'));
const browser = await launchChrome({ extensionDir: EXT, userDataDir });
const extId = await browser.extensionId();
siteConfig.EXTENSION_ID = extId;
const ext = (p) => `chrome-extension://${extId}/${p}`;
const pages = [];
async function open(url, size) {
  const p = await browser.openPage(url, size);
  pages.push(p);
  return p;
}
const pin = (p) => p.evaluate(() => chrome.tabs.getCurrent().then((t) => chrome.tabs.update(t.id, { pinned: true })));

const control = await open(ext('library.html'));
await pin(control);
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
const plan = () => local('plan');
const waitPlan = (test, timeout = 20_000) => until(async () => {
  const p = await plan();
  return p && test(p) ? p : null;
}, timeout, 400);

// One pinned Tabfold page for the screens (pinned, so folding leaves it open).
const ui = await open(ext('library.html#/pro'));
await pin(ui);
const go = (hash) => ui.evaluate((h) => { location.hash = h; }, hash);
const textOf = (p) => p.evaluate(() => document.body?.innerText ?? '').catch(() => '');
const has = (p, text, timeout = 8000) => until(async () => (await textOf(p)).includes(text), timeout, 200);
/** Click the first enabled button or link (in `scope`) whose text is exactly `label`. */
const click = (p, label, scope = 'button, a, [role=radio]') =>
  p.evaluate(([l, s]) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.innerText.trim() === l && !e.disabled);
    if (!el) return false;
    el.click();
    return true;
  }, [label, scope]);
const shot = async (p, name) => {
  await p.send('Page.bringToFront').catch(() => undefined);
  await sleep(250);
  await Promise.race([p.screenshot(path.join(SHOTS, name)), sleep(5000)]);
};
const findTarget = (test, timeout = 15_000) => until(async () => (await browser.targets()).find((t) => t.type === 'page' && test(t.url)), timeout, 250);
const gone = (targetId, timeout = 15_000) => until(async () => !(await browser.targets()).some((t) => t.targetId === targetId), timeout, 250);

async function typeEmail(p, email) {
  await p.evaluate(() => {
    const el = document.querySelector('dialog[open] input[type=email]');
    el.focus();
    el.select();
  });
  await p.send('Input.insertText', { text: email });
}
async function typeDigits(p, digits) {
  for (const d of digits) {
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: d, code: `Digit${d}`, text: d, windowsVirtualKeyCode: 48 + Number(d) });
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: d, code: `Digit${d}`, windowsVirtualKeyCode: 48 + Number(d) });
    await sleep(30);
  }
}
/**
 * In an open sign-in dialog: ask for a code (or, with `sentSince`, wait for the one the dialog sent
 * by itself after that many emails) and type the newest one.
 */
async function enterCode(p, email, { sentSince } = {}) {
  const before = sentSince ?? mailer.sent.length;
  await p.send('Page.bringToFront');
  if (sentSince === undefined) {
    await typeEmail(p, email);
    await click(p, 'Email me a code', 'dialog[open] button');
  }
  const asked = await has(p, 'Check your email');
  const code = await until(() => (mailer.sent.length > before ? mailer.lastCode(email) : null), 8000);
  await sleep(300);
  if (code) await typeDigits(p, code);
  return !!asked && !!code;
}
async function signOut(p) {
  await go('#/settings');
  await has(p, 'Signed in as');
  await click(p, 'Sign out', 'section button, section a');
  await has(p, 'Sign out on this computer?');
  await click(p, 'Sign out', 'dialog[open][aria-labelledby="account-h"] button');
  return waitPlan((x) => x.email === null, 10_000);
}
/** Pay on the fake Stripe page that Tabfold opened; `email` only when signed out. */
async function pay(email) {
  const target = await findTarget((url) => url.includes(`127.0.0.1:${STRIPE_PORT}/pay/`));
  if (!target) return null;
  const checkoutPage = await browser.attach(target.targetId);
  pages.push(checkoutPage);
  const prefilled = await checkoutPage.evaluate(() => {
    const field = document.querySelector('input[name=email]');
    return field?.readOnly ? field.value : null;
  });
  await checkoutPage.evaluate((address) => {
    const field = document.querySelector('input[name=email]');
    if (address && !field.readOnly) field.value = address;
    document.querySelector('form').submit();
  }, email ?? null);
  return { checkoutPage, target, prefilled };
}

// ---------------------------------------------------------------------------------------------
// 1. Free, then the 7-day Pro AI trial with an emailed code.
check('the plans page offers Pro and the Pro AI trial', (await has(ui, 'Tabfold Pro')) && (await has(ui, 'Start 7-day free trial', 4000)));
check('Pro is switched on in this build', !(await textOf(ui)).includes('switched on'));
check('a Free computer that never signed in asks Stripe nothing', stripe.requests.length === 0);
await shot(ui, 'plans.png');
await click(ui, 'Start 7-day free trial');
check('the trial asks for an email', await has(ui, 'Start your free trial'));
check('typing the emailed code finishes it', await enterCode(ui, OWNER));
check('toast: Pro AI trial started', await has(ui, 'Pro AI trial started · 7 days'));
const trialPlan = await waitPlan((p) => p.tier === 'pro-ai' && !!p.trial);
check('the plan is the Pro AI trial, signed in as the email', trialPlan?.email === OWNER && trialPlan.trialUsed === true, JSON.stringify(trialPlan?.trial));
check('the code was emailed for the trial', mailer.sent.at(-1)?.purpose === 'trial');
const profileKey = await control.evaluate(() => chrome.storage.sync.get('tabfold_profile').then((r) => r.tabfold_profile));
check('a Chrome profile key was registered', typeof profileKey === 'string' && [...store.devices.values()].some((d) => d.kind === 'profile'));
await go('#/settings');
check('Settings › Your plan shows the trial and who is signed in', (await has(ui, 'Pro AI trial')) && (await has(ui, `Signed in as ${OWNER}`, 3000)));
await shot(ui, 'settings-trial.png');
await go('#/pro');

// 2. Fold some tabs: they sync to the account, and the fold gets a smart name.
await control.evaluate((urls) => chrome.windows.create({ url: urls, focused: false }), [page('stripe-webhooks'), page('supabase'), page('react')]);
await control.evaluate((urls) => chrome.windows.create({ url: urls, focused: false }), [page('lisbon'), page('news')]);
await sleep(1500);
const folded = await send({ type: 'fold' });
check('fold works on Pro AI', folded?.ok && folded.data.savedTabs === 5, JSON.stringify(folded?.data?.savedTabs ?? folded));
const named = await until(async () => (await idb('sessions')).find((s) => s.smartName), 15_000, 500);
check('the fold gets a smart name from the AI', named?.smartName === 'Checkout app · Stripe webhooks', named?.smartName);
const synced = await until(async () => {
  const account = accountOf(OWNER);
  const items = account ? store.sync.get(account.id)?.items ?? {} : {};
  return Object.keys(items).some((k) => k.startsWith('tf.c')) ? items : null;
}, 20_000, 500);
check('folded tabs sync to the Tabfold account', !!synced);
const cloudStatus = await until(async () => {
  const s = await local('cloudSyncStatus');
  return s?.state === 'synced' ? s : null;
}, 15_000, 500);
check('the account sync status says synced', cloudStatus?.syncedTabs === 5, JSON.stringify(cloudStatus));
check('Chrome sync pauses while the account syncs', (await local('syncStatus'))?.state === 'off');

// 3. Organise with AI: preview, then put the tabs into folders.
const list = await open(ext('library.html'));
check('the full list shows the smart name and the plan', (await has(list, 'Checkout app · Stripe webhooks')) && (await has(list, 'Pro AI', 2000)));
await click(list, 'Organise with AI');
check('Organise with AI shows the folders first', (await has(list, 'Put them in folders', 15_000)) && (await has(list, 'Holiday in Lisbon', 2000)));
await shot(list, 'organise.png');
await click(list, 'Put them in folders');
const liveFolders = async () => (await idb('folders')).filter((f) => !f.deletedAt);
const folderNamed = async (name) => (await liveFolders()).find((f) => f.name === name);
const grouped = await until(async () => {
  const [folders, tabs] = [await liveFolders(), await idb('tabs')];
  return folders.length === 2 && tabs.filter((t) => t.folderId).length === 4 ? { folders, tabs } : null;
}, 10_000, 300);
check(
  'applying makes the two folders and puts 4 tabs in them',
  !!grouped && grouped.folders.every((f) => f.source === 'ai'),
  grouped ? grouped.folders.map((f) => `${f.name}: ${grouped.tabs.filter((t) => t.folderId === f.id).length}`).join(', ') : 'none',
);
check('toast: Put 4 tabs into 2 folders', await has(list, 'Put 4 tabs into 2 folders.'));
check('the list shows the folders first, then the tabs not in a folder', (await has(list, 'Tabs not in a folder')) && !(await textOf(list)).includes('By project'));
await shot(list, 'folders.png');
const runs = await local('aiRuns');
check('the run is counted (1 of 300)', runs?.used === 1 && runs?.limit === 300, JSON.stringify(runs));
const checkoutFolder = await folderNamed('Checkout app');

// 4. Copy as context and backups, through the worker.
const checkoutTabs = (await idb('tabs')).filter((t) => t.folderId === checkoutFolder?.id);
const context = await send({ type: 'ai-context', tabRecordIds: checkoutTabs.map((t) => t.id), name: 'Checkout app' });
check('Copy as context gives Markdown with an AI summary', context?.ok && context.data.markdown.includes('## Checkout app') && context.data.markdown.includes('Docs and dashboards'));
const backups = await send({ type: 'backups-list' });
check('a backup of today exists', backups?.ok && backups.data.length === 1 && backups.data[0].tabCount === 5, JSON.stringify(backups?.data));
await control.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open('tabfold');
      req.onsuccess = () => {
        const tabs = req.result.transaction('tabs', 'readwrite').objectStore('tabs');
        tabs.getAll().onsuccess = (e) => {
          const tab = e.target.result.find((t) => t.url.endsWith('/lisbon'));
          tabs.delete(tab.id).onsuccess = () => {
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

// 4b. Ask your tabs (Pro AI): a question in search gets "Ask", and the AI's best matches.
const search = async (p, text) => {
  await p.send('Page.bringToFront');
  await p.evaluate(() => {
    const field = document.querySelector('input[type=search]');
    field.focus();
    field.select();
  });
  await p.send('Input.insertText', { text });
};
await search(list, 'where were the flats for our trip');
check('a question in search offers Ask', !!(await until(() => list.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Ask')), 4000)));
await click(list, 'Ask');
const bestMatches = await until(() => list.evaluate(() => document.querySelector('ul[aria-label="Best matches"]')?.innerText ?? ''), 15_000);
check('Ask shows Best matches: the Lisbon tab, with why', !!bestMatches && bestMatches.includes('Holiday flats in Lisbon') && bestMatches.includes('Flats for the Lisbon trip'), bestMatches);
await shot(list, 'ask.png');
await list.evaluate(() => {
  const field = document.querySelector('input[type=search]');
  field.focus();
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});
await until(async () => !(await textOf(list)).includes('Best matches'), 4000);

// 4c. The weekly tidy-up (Pro AI): tabs nobody opened in a month get a folder, with one click.
const MONTH_AGO = Date.now() - 40 * 24 * 60 * 60_000;
const KITCHEN = ['Kitchen worktops compared', 'Wall tiles for the kitchen', 'Built-in oven reviews', 'Kitchen lighting ideas', 'Kitchen sink taps', 'Kitchen floor tiles'];
await control.evaluate(
  ([titles, at]) =>
    new Promise((resolve) => {
      const req = indexedDB.open('tabfold');
      req.onsuccess = () => {
        const tx = req.result.transaction(['sessions', 'windows', 'tabs'], 'readwrite');
        tx.objectStore('sessions').put({
          id: 'kitchen', name: 'Kitchen', tags: [], pinned: 0, color: null, kind: 'session', source: 'save-all', createdAt: at, updatedAt: at,
          deletedAt: 0, deviceId: 'e2e', version: 1, tabCount: titles.length, windowCount: 1, preview: [],
        });
        tx.objectStore('windows').put({ id: 'kitchenw', sessionId: 'kitchen', name: '', order: 0, wasFocused: false, bounds: null, state: null });
        titles.forEach((title, i) =>
          tx.objectStore('tabs').put({
            id: `kitchen${i}`, sessionId: 'kitchen', windowId: 'kitchenw', url: `https://kitchen.example/${i}`, title, favIconUrl: '', pinned: false,
            groupName: null, groupColor: null, groupCollapsed: false, order: i, savedAt: at, keywords: [], urlTruncated: false,
          }),
        );
        tx.oncomplete = () => {
          req.result.close();
          resolve(true);
        };
      };
    }),
  [KITCHEN, MONTH_AGO],
);
const tidy = await send({ type: 'tidy-run' });
const suggestion = tidy?.data?.suggestions?.find((x) => x.kind === 'fold-into');
check('the tidy-up suggests a folder for the month-old kitchen tabs', tidy?.ok && suggestion?.tabRecordIds.length === 6 && suggestion.action === 'Make a folder ‘Kitchen renovation’', JSON.stringify(tidy?.data ?? tidy));
await list.send('Page.reload');
check('the full list shows Your weekly tidy-up', (await has(list, 'Your weekly tidy-up', 10_000)) && (await has(list, '6 tabs about the kitchen haven’t been opened in a month', 3000)));
await shot(list, 'tidy.png');
await click(list, 'Make a folder ‘Kitchen renovation’');
const kitchen = await until(async () => {
  const folder = await folderNamed('Kitchen renovation');
  return folder && (await idb('tabs')).filter((t) => t.folderId === folder.id).length === 6 ? folder : null;
}, 8000, 300);
check('one click makes the folder and moves the 6 tabs', !!kitchen);
check('the card goes away', !!(await until(async () => !(await textOf(list)).includes('Your weekly tidy-up'), 5000)));

// 4d. A live folder (Pro): opens as a Chrome tab group; tabs added to the group join the folder;
// "Fold the group" closes them and keeps them in the folder.
const folderMenu = async (p, folder, item) => {
  await p.send('Page.bringToFront');
  const opened = await p.evaluate((name) => {
    const button = [...document.querySelectorAll(`[aria-label="More for ${name}"]`)].find((b) => b.getBoundingClientRect().width > 0);
    button?.click();
    return !!button;
  }, folder);
  await sleep(250);
  return opened && (await p.evaluate((label) => {
    const entry = [...document.querySelectorAll('[role=menuitem]')].find((e) => e.innerText.trim().startsWith(label));
    entry?.click();
    return !!entry;
  }, item));
};
await folderMenu(list, 'Checkout app', 'Open as a live group');
const group = await until(async () => (await control.evaluate(() => chrome.tabGroups.query({ title: 'Checkout app' })))[0], 10_000, 300);
const groupTabs = group ? await control.evaluate((id) => chrome.tabs.query({ groupId: id }), group.id) : [];
check('Open as a live group opens the folder as a tab group', !!group && groupTabs.length === 3, `${groupTabs.length} tabs`);
check('the folder says it’s live, with Go to window', (await has(list, 'Live · ', 6000)) && (await has(list, 'Go to window', 2000)) && (await has(list, 'Fold the group', 2000)));
await shot(list, 'live.png');
if (group) {
  await control.evaluate(async ([windowId, groupId, url]) => {
    const tab = await chrome.tabs.create({ windowId, url, active: false });
    await chrome.tabs.group({ groupId, tabIds: [tab.id] });
  }, [group.windowId, group.id, page('docs')]);
}
const joined = await until(async () => (await idb('tabs')).find((t) => t.url === page('docs') && t.folderId === checkoutFolder?.id), 10_000, 300);
check('a tab added to the group joins the folder', !!joined);
await list.send('Page.bringToFront');
await click(list, 'Fold the group');
check('Fold the group closes the group’s tabs', !!(await until(async () => (await control.evaluate(() => chrome.tabGroups.query({ title: 'Checkout app' }))).length === 0, 10_000, 300)));
const afterLive = (await idb('tabs')).filter((t) => t.folderId === checkoutFolder?.id);
check('…and keeps them in the folder (4 now)', afterLive.length === 4, `${afterLive.length}`);
check('the folder isn’t live any more', !!(await until(async () => !(await textOf(list)).includes('Go to window'), 5000)));

// 4e. Share a folder (Pro): a public page anyone can open, "Save to my Tabfold", Stop sharing.
await folderMenu(list, 'Checkout app', 'Share…');
check('Share… asks first', (await has(list, 'Share “Checkout app”')) && (await has(list, 'Create link', 2000)));
await click(list, 'Create link', 'dialog[open] button');
const shared = await until(async () => (await folderNamed('Checkout app'))?.shareId, 10_000, 300);
check('Create link shares the folder', !!shared && (await has(list, 'Stop sharing', 5000)));
await shot(list, 'share.png');
const info = await send({ type: 'share-info', folderId: checkoutFolder?.id });
check('the link is on the share site', info?.ok && info.data?.url === `${SHARE_SITE}/s/${shared}`, info?.data?.url ?? JSON.stringify(info));
const publicPage = await open(`${SHARE_SITE}/s/${shared}`);
check('the public page shows the folder and its pages', (await has(publicPage, 'Checkout app', 10_000)) && (await has(publicPage, 'Route Handlers | Next.js', 4000)) && (await has(publicPage, 'Webhooks | Stripe Documentation', 2000)));
check('…with Open all and Copy links', (await has(publicPage, 'Open all 4')) && (await has(publicPage, 'Copy links', 2000)));
await shot(publicPage, 'share-public.png');
const foldersBefore = (await liveFolders()).length;
await publicPage.evaluate(() => document.getElementById('save')?.click());
check('Save to my Tabfold saves it from the page', await has(publicPage, 'Saved to your Tabfold.', 10_000));
const savedCopy = await until(async () => {
  const folders = await liveFolders();
  return folders.length === foldersBefore + 1 ? folders.find((f) => f.name === 'Checkout app' && f.id !== checkoutFolder?.id) : null;
}, 8000, 300);
check('…as a new folder with the 4 tabs', !!savedCopy && (await idb('tabs')).filter((t) => t.folderId === savedCopy.id).length === 4);
const viewed = await send({ type: 'share-info', folderId: checkoutFolder?.id });
check('the server counts the public page’s views', viewed?.ok && viewed.data?.views >= 1, JSON.stringify(viewed?.data));
await list.send('Page.bringToFront');
await click(list, 'Stop sharing', 'dialog[open] button');
check('Stop sharing says the link no longer works', await has(list, 'Stopped sharing “Checkout app”. The link no longer works.'));
await publicPage.send('Page.reload');
check('the public page then says the link doesn’t work any more', await has(publicPage, 'This link doesn’t work any more', 10_000));
await publicPage.close().catch(() => undefined);
await list.evaluate(() => document.querySelector('dialog[open]')?.close());

// 5. Keep Pro AI: Stripe Checkout in a tab, billing from the trial's end, the tab turns into the welcome page.
await go('#/pro');
check('during the trial the plans page offers Keep Pro AI', (await has(ui, 'Keep Pro AI')) && (await has(ui, 'You won’t be charged until', 3000)));
await shot(ui, 'plans-trial.png');
await click(ui, 'Keep Pro AI');
check('the plans page waits for Stripe', (await has(ui, 'Finish paying in the Stripe tab')) && (await has(ui, 'Waiting for Stripe…', 2000)));
await shot(ui, 'plans-waiting.png');
const paid = await pay(null);
check('Stripe Checkout opened in a tab, with the account’s email fixed', paid?.prefilled === OWNER, paid?.prefilled ?? 'no checkout tab');
const welcomeTarget = await findTarget((url) => url.includes('library.html#/pro/welcome'), 20_000);
check('after paying, the checkout tab turns into Tabfold’s welcome page', !!welcomeTarget && welcomeTarget.targetId === paid?.target.targetId);
const welcome = paid?.checkoutPage;
check('the welcome page says Pro AI is on', !!welcome && (await has(welcome, 'You’re on Tabfold Pro AI', 20_000)) && (await has(welcome, 'Organise my tabs', 2000)));
if (welcome) await shot(welcome, 'welcome.png');
const paidPlan = await waitPlan((p) => p.status === 'active' && p.interval === 'year');
const trialEnd = trialPlan?.trial?.endsAt ?? 0;
check('the plan is Pro AI yearly, first charged when the trial ends', paidPlan?.tier === 'pro-ai' && !paidPlan.trial && Math.abs((paidPlan.renewsAt ?? 0) - trialEnd) < 5 * 60_000, JSON.stringify({ renewsAt: paidPlan?.renewsAt, trialEnd }));
const subscriptionId = [...stripe.subscriptions.keys()][0];
check('Stripe has a trialing subscription with the trial’s end', stripe.subscriptions.get(subscriptionId)?.status === 'trialing');
check('the waiting banner went away', !(await textOf(ui)).includes('Finish paying in the Stripe tab'));
if (welcome) await welcome.close().catch(() => undefined);

// 6. Settings › Your plan: paid, a failed payment, Update card, cancelling.
await ui.send('Page.bringToFront');
await go('#/settings');
check('Settings shows the paid plan and Manage billing', (await has(ui, 'Renews')) && (await has(ui, 'Manage billing', 2000)));
await shot(ui, 'settings-paid.png');
await stripe.setSubscription(subscriptionId, { status: 'past_due' });
await send({ type: 'plan-refresh', force: true });
check('a failed payment shows in Settings (Stripe’s webhook)', await has(ui, 'Payment didn’t go through'));
await shot(ui, 'settings-past-due.png');
await click(ui, 'Update card');
const cardTarget = await findTarget((url) => url.includes(`127.0.0.1:${STRIPE_PORT}/portal/`));
check('Update card opens Stripe’s card form', !!cardTarget);
if (cardTarget) {
  const cardPage = await browser.attach(cardTarget.targetId);
  await has(cardPage, 'Save card');
  await cardPage.evaluate(() => [...document.querySelectorAll('form')].find((f) => f.action.includes('/card'))?.submit());
  check('saving the card closes Stripe’s tab', await gone(cardTarget.targetId));
}
await stripe.setSubscription(subscriptionId, { status: 'trialing' });
await send({ type: 'plan-refresh', force: true });
check('the plan is back to normal', await has(ui, 'Renews'));
await click(ui, 'Manage billing');
const portalTarget = await findTarget((url) => url.includes(`127.0.0.1:${STRIPE_PORT}/portal/`));
check('Manage billing opens Stripe’s billing page', !!portalTarget);
if (portalTarget) {
  const portal = await browser.attach(portalTarget.targetId);
  await has(portal, 'Cancel plan');
  await portal.evaluate(() => [...document.querySelectorAll('form')].find((f) => f.action.includes('/cancel'))?.submit());
  await has(portal, 'Return to Tabfold');
  await portal.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.innerText.includes('Return to Tabfold'))?.click());
  check('returning from Stripe’s billing page closes its tab', await gone(portalTarget.targetId));
}
await send({ type: 'plan-refresh', force: true });
check('a cancelled plan stays on until it ends, with Keep Pro AI', (await has(ui, 'Keep Pro AI')) && !!(await waitPlan((p) => p.cancelAt !== null, 5000)));
await shot(ui, 'settings-cancelled.png');

// 7. Sign out and back in on this computer.
const signedOut = await signOut(ui);
check('signing out leaves Free, with no “plan ended” notice', signedOut?.tier === 'free' && !(await local('planEnded')));
check('Settings offers “Already paid? Sign in”', await has(ui, 'Already paid? Sign in'));
check('Chrome sync takes over while signed out', !!(await until(async () => {
  await send({ type: 'sync-now' });
  return (await local('syncStatus'))?.state === 'synced';
}, 15_000, 1000)));
await click(ui, 'Already paid? Sign in');
check('the sign-in dialog asks for the email', await has(ui, 'Sign in to Tabfold Pro'));
check('signing in with a code', await enterCode(ui, OWNER));
check('toast: Signed in · Pro AI, yearly', await has(ui, 'Signed in · Pro AI, yearly'));
check('the plan follows the email back', !!(await waitPlan((p) => p.email === OWNER && p.tier === 'pro-ai')));

// 8. The subscription ends after the trial's days are over: the list, folders and backups stay; a
// one-time notice says so. (Cancelled while the free trial still ran, the trial would carry on.)
const foldersWhilePaid = (await liveFolders()).length;
const inFolders = (await idb('tabs')).filter((t) => t.folderId).length;
store.accounts.get(accountOf(OWNER).id).trialStartedAt = Date.now() - 8 * 24 * 60 * 60_000;
await stripe.setSubscription(subscriptionId, { status: 'canceled' }, { event: 'customer.subscription.deleted' });
await send({ type: 'plan-refresh', force: true });
check('when the subscription ends the plan goes back to Free (still signed in)', !!(await waitPlan((p) => p.tier === 'free' && p.email === OWNER)));
await list.send('Page.bringToFront');
check('a notice says Pro AI ended', await has(list, 'Your Pro AI plan has ended'));
check(
  'folders stay after the plan ends, even past Free’s 3',
  foldersWhilePaid === 4 && (await liveFolders()).length === 4 && (await idb('tabs')).filter((t) => t.folderId).length === inFolders,
  `${foldersWhilePaid} folders, ${inFolders} tabs in them`,
);
check('…and the full list asks for Upgrade again', !!(await until(() => list.evaluate(() => [...document.querySelectorAll('button, a')].some((b) => b.innerText.trim() === 'Upgrade')), 5000)));
await shot(list, 'plan-ended.png');

// 9. A new buyer on a signed-out computer: closing checkout charges nothing; paying signs in.
await ui.send('Page.bringToFront');
await signOut(ui);
await go('#/pro');
await click(ui, 'Monthly', '[role=radio]');
await click(ui, 'Get Pro');
const cancelTarget = await findTarget((url) => url.includes(`127.0.0.1:${STRIPE_PORT}/pay/`));
if (cancelTarget) {
  const cancelPage = await browser.attach(cancelTarget.targetId);
  await cancelPage.evaluate(() => [...document.querySelectorAll('a')].find((a) => a.innerText.includes('Cancel and go back'))?.click());
  check('cancelling on Stripe closes its tab', await gone(cancelTarget.targetId));
}
check('…and says nothing was charged', await has(ui, 'Checkout closed. Nothing was charged.'));
check('the plans page is back to normal', (await has(ui, 'Get Pro')) && !(await textOf(ui)).includes('Waiting for Stripe…'));
await click(ui, 'Get Pro');
const bought = await pay(BUYER);
check('a signed-out checkout lets Stripe ask for the email', !!bought && bought.prefilled === null);
check('the new buyer lands on the welcome page', !!bought && (await has(bought.checkoutPage, 'You’re on Tabfold Pro', 20_000)) && !(await textOf(bought.checkoutPage)).includes('Organise my tabs'));
check('…signed in as the email they paid with, on Pro monthly', !!(await waitPlan((p) => p.email === BUYER && p.tier === 'pro' && p.interval === 'month')));
if (bought) await bought.checkoutPage.close().catch(() => undefined);

// 10. Paying with someone else's email doesn't reach their account from this computer.
await ui.send('Page.bringToFront');
await signOut(ui);
await go('#/pro');
await click(ui, 'Monthly', '[role=radio]');
await click(ui, 'Get Pro');
const squatter = await pay(OWNER);
const needs = squatter && (await has(squatter.checkoutPage, 'Sign in to switch Pro on here', 20_000));
check('paying with an email that has an account asks this computer to sign in first', !!needs);
check('…and this computer stays signed out until then', (await plan())?.email === null);
if (squatter) await shot(squatter.checkoutPage, 'welcome-sign-in.png');
if (squatter) {
  const sentSince = mailer.sent.length;
  await click(squatter.checkoutPage, 'Sign in');
  check('“Sign in” sends the code to that email', await enterCode(squatter.checkoutPage, OWNER, { sentSince }));
  check('with the code, Pro switches on here', !!(await waitPlan((p) => p.email === OWNER && p.tier === 'pro')));
  await squatter.checkoutPage.close().catch(() => undefined);
}

// 10b. Pro for life: one payment, no renewal.
const LIFER = 'life@example.com';
await ui.send('Page.bringToFront');
await signOut(ui);
await go('#/pro');
check('the plans page offers Pro for life', await has(ui, '$99 once, for life'));
await click(ui, '$99 once, for life');
const lifetime = await pay(LIFER);
check('Pro for life opens Stripe Checkout as a one-time payment', !!lifetime && [...stripe.sessions.values()].some((x) => x.mode === 'payment'));
check('the welcome page says Pro, for life', !!lifetime && (await has(lifetime.checkoutPage, 'You’re on Tabfold Pro, for life', 20_000)));
if (lifetime) await shot(lifetime.checkoutPage, 'welcome-lifetime.png');
check('…signed in, Pro for life with no renewal', !!(await waitPlan((p) => p.email === LIFER && p.lifetime === true && p.tier === 'pro' && !p.renewsAt)));
if (lifetime) await lifetime.checkoutPage.close().catch(() => undefined);
await ui.send('Page.bringToFront');
await go('#/settings');
check('Settings › Your plan says Pro for life', (await has(ui, 'Pro for life')) && (await has(ui, 'One payment, no renewal', 3000)));
await shot(ui, 'settings-lifetime.png');

// 10c. Start a team: a name and how many people, Stripe Checkout per person, "Your team is ready".
const TEAM_OWNER = 'team@example.com';
await signOut(ui);
await go('#/pro');
await click(ui, 'Start a team');
check('Start a team asks for the team’s name and how many people', (await has(ui, 'Team name')) && (await has(ui, 'People', 2000)));
await ui.evaluate(() => document.querySelector('dialog[open] input:not([type=number])')?.focus());
await ui.send('Input.insertText', { text: 'Truewidgets' });
await shot(ui, 'team-start.png');
await click(ui, 'Continue', 'dialog[open] button');
const teamPaid = await pay(TEAM_OWNER);
check('the welcome page says Your team is ready', !!teamPaid && (await has(teamPaid.checkoutPage, 'Your team is ready', 20_000)) && (await has(teamPaid.checkoutPage, 'Invite people', 2000)));
check('the team pays per person on Stripe (3 people)', [...stripe.subscriptions.values()].some((x) => x.items.data[0].quantity === 3));
if (teamPaid) await shot(teamPaid.checkoutPage, 'welcome-team.png');
const teamPlan = await waitPlan((p) => p.email === TEAM_OWNER && p.team?.name === 'Truewidgets');
check('the plan is the team’s: Pro AI, owner, 3 people', teamPlan?.tier === 'pro-ai' && teamPlan.team.role === 'owner' && teamPlan.team.seats === 3, JSON.stringify(teamPlan?.team));
if (teamPaid) await teamPaid.checkoutPage.close().catch(() => undefined);
await ui.send('Page.bringToFront');
await go('#/settings');
check('Settings › Your plan shows the team', await has(ui, 'Team · Truewidgets · 3 people'));

// 11. Remove Tabfold: take your tabs with you first (Reopen all; we never press Remove here).
await ui.send('Page.bringToFront');
await go('#/settings');
await has(ui, 'Remove Tabfold');
await ui.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim().startsWith('Remove Tabfold'))?.click());
check('Remove Tabfold… offers to take the tabs along first', (await has(ui, 'Before you remove Tabfold')) && (await has(ui, 'Save to bookmarks', 2000)));
await shot(ui, 'remove.png');
const reopened = await send({ type: 'reopen-everything' });
check('Reopen all reopens every folded tab', reopened?.ok && reopened.data.opened >= 5, JSON.stringify(reopened?.data));

check('the model was only asked for names, folders, summaries, Ask and the tidy-up', modelCalls.length >= 5 && modelCalls.every((c) => ['organise', 'name', 'context', 'ask', 'tidy'].includes(c)), modelCalls.join(','));
check('every Stripe webhook was accepted', stripe.deliveries.length > 0 && stripe.deliveries.every((d) => d.status === 200), JSON.stringify(stripe.deliveries.filter((d) => d.status !== 200)));
check('the server logged no failures', serverLog.length === 0, serverLog.slice(0, 3).join(' | '));
const pageErrors = pages.flatMap((p) => p.errors);
check('no errors in extension pages', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
await Promise.all([stripe.close(), api.close(), new Promise((r) => site.close(r)), new Promise((r) => shareSite.close(r))]);
rmSync(userDataDir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
