// End-to-end smoke test: loads the built extension into real Chromium and drives the main flows
// (fold, undo, the grouped list, reopening, Open all, keywords, sync, crash recovery) through the
// popup, the full list and the same messages the pages send.
// Run `npm run build` first, then `npm run e2e`. Screenshots go to e2e/screenshots (or $SHOTS_DIR).
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome } from './cdp.mjs';

const EXT = path.resolve('.output/chrome-mv3');
const SHOTS = path.resolve(process.env.SHOTS_DIR ?? 'e2e/screenshots');
mkdirSync(SHOTS, { recursive: true });

const PAGES = {
  'stripe-webhooks': 'Webhooks | Stripe Documentation',
  'stripe-cli': 'Test locally with the Stripe CLI',
  supabase: 'Table editor · checkout-app · Supabase',
  react: 'useOptimistic – React',
  lisbon: 'Holiday flats in Lisbon',
  news: 'Hacker News',
  docs: 'Route Handlers | Next.js',
  music: 'Lo-fi beats to code to',
};

const server = http.createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? '/').slice(1).split('?')[0]) || 'home';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${PAGES[name] ?? name}</title><h1>${PAGES[name] ?? name}</h1>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const site = (name) => `http://127.0.0.1:${server.address().port}/${name}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 10_000, step = 150) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  return last;
}

const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tabfold-e2e-'));
const pages = [];
let browser = await launchChrome({ extensionDir: EXT, userDataDir });
const extId = await browser.extensionId();
const ext = (p) => `chrome-extension://${extId}/${p}`;
check('service worker starts', !!extId, extId);

/** Case-insensitive text check (headings are uppercased by CSS, which innerText reflects). */
const hasText = (page, text, timeout = 6000) =>
  page.waitFor((t) => document.body?.innerText.toLowerCase().includes(t.toLowerCase()), text, timeout);

async function open(url, size) {
  const page = await browser.openPage(url, size);
  pages.push(page);
  return page;
}

const onboardingTarget = await until(async () => (await browser.targets()).find((t) => t.url.includes('onboarding.html')), 10_000);
check('the welcome tab opens on first install', !!onboardingTarget);

if (onboardingTarget) {
  const onboarding = await browser.attach(onboardingTarget.targetId, { width: 1440, height: 800 });
  pages.push(onboarding);
  check('welcome tab explains the three things', await onboarding.waitForText('Fold your tabs', 6000));
  await onboarding.screenshot(path.join(SHOTS, 'welcome.png'));
}

let worker = await browser.attachWorker();
let control = await open(ext('library.html'));
// Folds close Tabfold's own pages too; pinned tabs stay, so the page driving the test stays.
const pinControl = () => control.evaluate(() => chrome.tabs.getCurrent().then((t) => chrome.tabs.update(t.id, { pinned: true })));
await pinControl();
const api = {
  send: (command) => control.evaluate((c) => new Promise((res) => chrome.runtime.sendMessage({ __tabfold: true, command: c }, res)), command),
  tabs: () =>
    control.evaluate(() =>
      chrome.tabs.query({}).then((ts) =>
        ts.map((t) => ({ id: t.id, url: t.url || t.pendingUrl, title: t.title, windowId: t.windowId, discarded: t.discarded, pinned: t.pinned })),
      ),
    ),
  counts: () =>
    control.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('tabfold');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(['sessions', 'windows', 'tabs', 'snapshots'], 'readonly');
            const out = {};
            let left = 4;
            for (const store of ['sessions', 'windows', 'tabs', 'snapshots']) {
              const c = tx.objectStore(store).count();
              c.onsuccess = () => {
                out[store] = c.result;
                if (--left === 0) {
                  db.close();
                  resolve(out);
                }
              };
            }
          };
        }),
    ),
  snapshots: () =>
    control.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open('tabfold');
          req.onsuccess = () => {
            const q = req.result.transaction('snapshots').objectStore('snapshots').getAll();
            q.onsuccess = () => {
              resolve(q.result.map((s) => `${s.reason}:${s.tabCount}`));
              req.result.close();
            };
          };
        }),
    ),
  storage: (area, key) => control.evaluate(([a, k]) => chrome.storage[a].get(k).then((r) => r[k]), [area, key]),
  newWindow: (urls) => control.evaluate((u) => chrome.windows.create({ url: u, focused: false }).then((w) => w.id), urls),
};
const webTabs = async () => (await api.tabs()).filter((t) => t.url?.startsWith('http'));
const screen = { left: 0, top: 0, width: 1440, height: 900 };

// ---------------------------------------------------------------------------------------------
// Fold from the popup: every tab saves and closes, the pinned one stays
await api.newWindow([site('stripe-webhooks'), site('supabase'), site('react')]);
await api.newWindow([site('lisbon'), site('news')]);
await until(async () => (await webTabs()).filter((t) => t.title && Object.values(PAGES).includes(t.title)).length >= 5);
const newsTab = (await webTabs()).find((t) => t.url.endsWith('/news'));
await control.evaluate((id) => chrome.tabs.update(id, { pinned: true }), newsTab.id);

const popup = await open(ext('popup.html'), { width: 400, height: 580 });
check('popup offers to fold the 4 unpinned tabs', await popup.waitForText('Fold 4 tabs', 8000));
check('popup shows memory in use', await hasText(popup, 'In use', 4000));
await popup.screenshot(path.join(SHOTS, 'popup-light.png'));
await popup.colorScheme('dark');
await sleep(300);
await popup.screenshot(path.join(SHOTS, 'popup-dark.png'));
await popup.colorScheme('light');
await popup.clickText('Fold 4 tabs');
const fold1 = await until(async () => {
  const f = await api.storage('session', 'activeFold');
  return f?.phase === 'done' ? f : null;
}, 20_000, 200);
check('fold finishes and reports its outcome', fold1?.outcome?.savedTabs === 4, fold1 ? `${fold1.phase}, saved ${fold1.outcome?.savedTabs}` : 'no fold');
check('fold reads free memory before and after', typeof fold1?.outcome?.memory?.freeBefore === 'number' && typeof fold1?.outcome?.memory?.freeAfter === 'number');
let open1 = await webTabs();
check('folded tabs closed, the pinned tab stayed', open1.length === 1 && open1[0].pinned, open1.map((t) => t.url).join(', '));
const stillOwn = (await api.tabs()).filter((t) => t.url?.startsWith(ext('')));
check('the fold closed the welcome tab, not the pinned or asking Tabfold pages', !stillOwn.some((t) => t.url.includes('onboarding.html')) && stillOwn.length === 2, stillOwn.map((t) => t.url.split('/').pop()).join(', '));
let counts = await api.counts();
check('the 4 tabs are in the list', counts.tabs === 4, JSON.stringify(counts));
check('popup shows memory freed and Undo', await popup.waitForText('freed', 6000) && (await popup.waitForText('Undo', 2000)));
check('popup lists the folded tabs grouped by kind of site', (await hasText(popup, 'Folded', 4000)) && (await hasText(popup, 'Dev', 2000)));
await popup.screenshot(path.join(SHOTS, 'popup-folded.png'));

// Undo brings the tabs back and empties the list
await popup.clickText('Undo');
await until(async () => (await webTabs()).length >= 5, 10_000);
open1 = await webTabs();
counts = await api.counts();
check('undo reopened the tabs and emptied the list', open1.length === 5 && counts.tabs === 0, `${open1.length} open, ${counts.tabs} in the list`);
await popup.close();

// Fold again through the command (as the shortcut does)
let response = await api.send({ type: 'fold' });
check('fold command works', response?.ok && response.data.savedTabs === 4, JSON.stringify(response?.error ?? response?.data?.savedTabs));
const sessionId = response.data.sessionId;
await sleep(600);

// Chrome sync gets the newest folded tabs (written a few seconds after a change)
const syncKeys = await until(async () => {
  const all = await control.evaluate(() => chrome.storage.sync.get(null));
  return Object.keys(all).some((k) => k.startsWith('tf.c')) ? Object.keys(all) : null;
}, 15_000, 500);
check('folded tabs are shared through Chrome sync', !!syncKeys, (syncKeys ?? []).join(', '));
const sync = await api.storage('local', 'syncStatus');
check('sync status says synced', sync?.state === 'synced' && sync.syncedTabs >= 4, JSON.stringify(sync));

// ---------------------------------------------------------------------------------------------
// The full list: grouped, open one tab, remove with Undo, Open all as a tab group, reopen a fold
const list = await open(ext('library.html'));
check('full list shows Recent folds', await hasText(list, 'Recent folds', 8000));
check('full list groups the tabs', await list.waitForText('Dev', 4000));
await sleep(400);
await list.screenshot(path.join(SHOTS, 'list-light.png'));
await list.colorScheme('dark');
await sleep(300);
await list.screenshot(path.join(SHOTS, 'list-dark.png'));
await list.colorScheme('light');

const openedOne = await list.evaluate(() => {
  const row = [...document.querySelectorAll('[aria-label^="Open "]')].find((e) => /React/.test(e.getAttribute('aria-label') ?? ''));
  if (!row) return false;
  row.click();
  return true;
});
await sleep(800);
open1 = await webTabs();
counts = await api.counts();
check('clicking a folded tab opens it and keeps it in the list', openedOne && open1.some((t) => t.url.endsWith('/react')) && counts.tabs === 4, `${openedOne}, ${counts.tabs} in list`);

const removed = await list.evaluate(() => {
  const button = document.querySelector('[aria-label="Remove from list"]');
  if (!button) return false;
  button.click();
  return true;
});
await sleep(500);
counts = await api.counts();
check('× removes a tab from the list', removed && counts.tabs === 3, `${counts.tabs} in list`);
await list.clickText('Undo');
await sleep(600);
counts = await api.counts();
check('Undo puts the removed tab back', counts.tabs === 4, `${counts.tabs} in list`);

const tabIds = await control.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open('tabfold');
      req.onsuccess = () => {
        const q = req.result.transaction('tabs').objectStore('tabs').getAll();
        q.onsuccess = () => {
          resolve(q.result.map((t) => t.id));
          req.result.close();
        };
      };
    }),
);
response = await api.send({ type: 'open-tabs', tabRecordIds: tabIds, asGroup: { name: 'Dev', color: 'blue' } });
await sleep(1500);
const groups = await control.evaluate(() => chrome.tabGroups.query({}));
check('Open all opens a group as a Chrome tab group', response?.ok && response.data.opened === 4 && groups.some((g) => g.title === 'Dev' && g.color === 'blue'), JSON.stringify(groups.map((g) => g.title)));
await control.evaluate(() => chrome.tabs.query({ groupId: chrome.tabGroups.TAB_GROUP_ID_NONE }).then(() => chrome.tabGroups.query({})).then(async (gs) => {
  for (const g of gs) {
    const ts = await chrome.tabs.query({ groupId: g.id });
    await chrome.tabs.remove(ts.map((t) => t.id));
  }
}));
await sleep(500);

// Reopen the whole fold as its original windows, lazily, with real titles
const reactNow = (await webTabs()).filter((t) => t.url.endsWith('/react'));
if (reactNow.length) await control.evaluate((ids) => chrome.tabs.remove(ids), reactNow.map((t) => t.id));
response = await api.send({ type: 'restore', sessionId, mode: 'original', screen });
check('reopening a fold opens its 4 tabs with no failures', response?.ok && response.data.opened === 4 && response.data.failed.length === 0, JSON.stringify(response?.data ?? response));
await sleep(1500);
open1 = await webTabs();
const restored = open1.filter((t) => !t.pinned);
check('the fold comes back as its 2 windows', new Set(restored.map((t) => t.windowId)).size === 2, `${restored.length} tabs`);
check('background tabs sleep after loading, with their real titles', restored.filter((t) => t.discarded).length >= 2 && restored.every((t) => t.title && !t.title.startsWith('127.0.0.1')), restored.map((t) => `${t.title}${t.discarded ? ' (asleep)' : ''}`).join(', '));

// Suspend inactive still works
response = await api.send({ type: 'suspend-inactive' });
check('idle tabs can be put to sleep', response?.ok, JSON.stringify(response?.data ?? response));

// ---------------------------------------------------------------------------------------------
// Keywords (right-click path) and search
const stripeTab = (await webTabs()).find((t) => t.url.endsWith('/stripe-webhooks'));
await control.evaluate((ids) => chrome.storage.session.set({ pendingKeywordSave: { tabIds: ids, at: Date.now() } }), [stripeTab.id]);
const picker = await open(ext('popup.html'), { width: 400, height: 580 });
check('right-click keyword view opens', await picker.waitForText('Fold with keywords', 6000));
await sleep(300);
await picker.screenshot(path.join(SHOTS, 'popup-keywords.png'));
await picker.close();
response = await api.send({ type: 'save', scope: 'tabs', tabIds: [stripeTab.id], close: true, duplicates: 'keep', keywordsByTabId: { [stripeTab.id]: ['payments', 'retries'] } });
check('fold a tab with keywords', response?.ok && response.data.savedTabs === 1, JSON.stringify(response?.data ?? response));

const search = await open(ext('popup.html'), { width: 400, height: 580 });
await hasText(search, 'Folded', 6000);
await search.type('input[type=search]', 'retries');
check('search finds a tab by a keyword not in its title or address', await search.waitForText('Stripe Documentation', 8000));
await search.type('input[type=search]', '#payments');
check('"#keyword" search works', await search.waitForText('Stripe Documentation', 8000));
await search.type('input[type=search]', 'stripe');
await sleep(400);
await search.screenshot(path.join(SHOTS, 'popup-search.png'));

// ---------------------------------------------------------------------------------------------
// Settings, How it works, Import, Welcome
await list.goto(ext('library.html#/settings'));
check('settings shows the sync switch', await list.waitForText('Sync folded tabs with Chrome', 6000));
await sleep(300);
await list.screenshot(path.join(SHOTS, 'settings.png'));
await list.goto(ext('library.html#/how'));
check('How it works explains folding and sleep', await list.waitForText('How Tabfold frees memory', 6000));
await list.screenshot(path.join(SHOTS, 'how.png'));
await list.goto(ext('library.html#/import'));
check('Import from OneTab opens', await list.waitForText('OneTab', 6000));

const pageErrors = [...pages.flatMap((p) => p.errors), ...(worker?.errors ?? []).map((e) => `worker: ${e}`)];
check('no errors in extension pages', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

// ---------------------------------------------------------------------------------------------
// Crash recovery: restart with the same profile. Chromium opens a blank page, so the last
// session is missing and Tabfold should offer it back.
await sleep(5500); // let the debounced background snapshot settle
const beforeRestart = (await webTabs()).length;
console.log('  snapshots before restart:', (await api.snapshots()).join(', '));
await browser.close();
browser = await launchChrome({ extensionDir: EXT, userDataDir });
await browser.extensionId();
control = await open(ext('library.html'));
const offer = await until(() => api.storage('local', 'recoveryOffer'), 20_000, 500);
check('after a restart, recovery is offered', !!offer, offer ? `${offer.tabCount} tabs` : `none; snapshots: ${(await api.snapshots()).join(', ')}`);
if (offer) {
  const popupRecovery = await open(ext('popup.html'), { width: 400, height: 580 });
  await popupRecovery.waitForText('Chrome closed unexpectedly');
  await popupRecovery.screenshot(path.join(SHOTS, 'popup-recovery.png'));
  response = await api.send({ type: 'restore-snapshot', snapshotId: offer.snapshotId, mode: 'original', screen });
  await sleep(1000);
  const back = (await webTabs()).length;
  check('recovery restores the last session', response?.ok && back >= beforeRestart - 1, `${back} of ${beforeRestart} tabs`);
  check('recovery offer is cleared', !(await api.storage('local', 'recoveryOffer')));
}

// ---------------------------------------------------------------------------------------------
// Incognito: off by default; with "Allow in Incognito" and the setting on, Incognito tabs fold,
// stay out of Chrome sync, show a mark, and reopen only in Incognito. Recent folds can be deleted.
const incognitoUrls = [site('stripe-cli'), site('music')];
const extensions = await open(`chrome://extensions/?id=${extId}`);
await sleep(800);
await extensions.evaluate(() => new Promise((r) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, r)));
await sleep(500);
await extensions.evaluate((id) => new Promise((r) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, incognitoAccess: true }, r)), extId);
// Chrome reloads the extension: its pages close and the worker restarts.
await sleep(4000);
pages.splice(0, pages.length);
control = await open(ext('library.html'));
await pinControl();
check('Chrome lets Tabfold into Incognito', await control.evaluate(() => chrome.extension.isAllowedIncognitoAccess()));
await control.evaluate((u) => chrome.windows.create({ url: u, incognito: true }), incognitoUrls);
await until(async () => (await api.tabs()).filter((t) => incognitoUrls.includes(t.url)).length === 2, 10_000);
const incognitoOpen = async () => (await control.evaluate(() => chrome.tabs.query({}))).filter((t) => t.incognito && t.url?.startsWith('http'));

response = await api.send({ type: 'fold' });
check('with the setting off, a fold leaves Incognito tabs open and says so', (await incognitoOpen()).length === 2 && response?.data?.stayedOpen?.incognito === 2, JSON.stringify(response?.data?.stayedOpen));

await control.evaluate(() => chrome.storage.local.get('settings').then((r) => chrome.storage.local.set({ settings: { ...(r.settings ?? {}), foldIncognito: true } })));
const incognitoPopup = await open(ext('popup.html'), { width: 400, height: 580 });
check('the popup counts the Incognito tabs to fold', await incognitoPopup.waitForText('Fold 2 tabs', 8000));
await incognitoPopup.clickText('Fold 2 tabs');
const fold2 = await until(async () => {
  const f = await api.storage('session', 'activeFold');
  return f?.phase === 'done' && f.startedAt > Date.now() - 30_000 && f.outcome?.savedTabs === 2 ? f : null;
}, 20_000, 200);
check('with the setting on, the fold saves and closes the Incognito tabs', !!fold2 && (await incognitoOpen()).length === 0, fold2 ? `saved ${fold2.outcome.savedTabs}` : 'no fold');
const marked = await control.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open('tabfold');
      req.onsuccess = () => {
        const q = req.result.transaction('tabs').objectStore('tabs').getAll();
        q.onsuccess = () => {
          resolve(q.result.filter((t) => t.incognito).map((t) => t.url));
          req.result.close();
        };
      };
    }),
);
check('Incognito tabs are saved marked as Incognito', marked.length === 2 && incognitoUrls.every((u) => marked.includes(u)), marked.join(', '));
await sleep(6000); // Chrome sync runs a few seconds after a change
const syncText = JSON.stringify(await control.evaluate(() => chrome.storage.sync.get(null)));
check('Incognito tabs never go to Chrome sync', syncText.includes('127.0.0.1') && !syncText.includes('stripe-cli') && !syncText.includes('/music'));

const incognitoList = await open(ext('library.html'));
check('the full list marks Incognito tabs', !!(await incognitoList.waitFor(() => document.querySelectorAll('[aria-label="Incognito"]').length >= 2, null, 8000)));
await incognitoList.screenshot(path.join(SHOTS, 'list-incognito.png'));
const clickedIncognito = await incognitoList.evaluate(() => {
  const row = [...document.querySelectorAll('[aria-label^="Open "]')].find((e) => /Stripe CLI.* in Incognito/.test(e.getAttribute('aria-label') ?? ''));
  row?.click();
  return !!row;
});
await until(async () => (await control.evaluate(() => chrome.tabs.query({}))).some((t) => t.url?.endsWith('/stripe-cli')), 8000);
const cliTabs = (await control.evaluate(() => chrome.tabs.query({}))).filter((t) => t.url?.endsWith('/stripe-cli'));
check('an Incognito tab reopens only in Incognito', clickedIncognito && cliTabs.length === 1 && cliTabs[0].incognito, JSON.stringify(cliTabs.map((t) => t.incognito)));

await incognitoList.goto(ext('library.html#/settings'));
check('settings has "Fold Incognito windows too"', await incognitoList.waitForText('Fold Incognito windows too', 6000));
await sleep(300);
await incognitoList.screenshot(path.join(SHOTS, 'settings-incognito.png'));

await incognitoList.goto(ext('library.html'));
await hasText(incognitoList, 'Recent folds', 8000);
const before = (await api.counts()).tabs;
const deleted = await incognitoList.evaluate(() => {
  const button = document.querySelector('[aria-label^="Delete the fold from"]');
  button?.click();
  return button?.getAttribute('aria-label') ?? null;
});
await sleep(600);
const afterDelete = (await api.counts()).tabs;
check('deleting a fold from Recent folds removes its tabs', !!deleted && afterDelete < before, `${deleted}: ${before} → ${afterDelete}`);
// The Undo in the "Deleted the fold…" toast (another toast may still offer to undo the fold itself).
await incognitoList.evaluate(() => {
  const toast = [...document.querySelectorAll('[role=status], [role=alert], div')].find((e) => /^Deleted the fold/.test(e.textContent ?? '') && e.querySelector('button'));
  [...(toast?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes('Undo'))?.click();
});
await sleep(600);
check('Undo brings the deleted fold back', (await api.counts()).tabs === before);
const lateErrors = [...pages.flatMap((p) => p.errors)];
check('no errors in extension pages after the reload', lateErrors.length === 0, lateErrors.slice(0, 3).join(' | '));

await browser.close();
server.close();
rmSync(userDataDir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
