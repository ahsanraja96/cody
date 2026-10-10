// End-to-end smoke test: loads the built extension into real Chromium and drives the main flows
// through the same messages the popup sends, plus the popup and library UIs.
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

async function open(url, size) {
  const page = await browser.openPage(url, size);
  pages.push(page);
  return page;
}

const onboardingTarget = await until(async () => (await browser.targets()).find((t) => t.url.includes('onboarding.html')), 10_000);
check('onboarding opens on first install', !!onboardingTarget);

let worker = await browser.attachWorker();
let control = await open(ext('library.html'));
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
// Save all & free memory, keeping a pinned tab open
await api.newWindow([site('stripe-webhooks'), site('supabase'), site('react')]);
await api.newWindow([site('lisbon'), site('news')]);
await until(async () => (await webTabs()).filter((t) => t.title && Object.values(PAGES).includes(t.title)).length >= 5);
const newsTab = (await webTabs()).find((t) => t.url.endsWith('/news'));
await control.evaluate((id) => chrome.tabs.update(id, { pinned: true }), newsTab.id);

let response = await api.send({ type: 'save', scope: 'all', close: true, audible: 'keep' });
check('save all returns ok', response?.ok, response?.error ?? '');
const saved = response.data;
check('save all saved 4 tabs and kept the pinned one', saved.savedTabs === 4 && saved.keptOpen.pinned === 1, `saved ${saved.savedTabs}, kept ${saved.keptOpen.pinned}`);
await sleep(800);
let open1 = await webTabs();
check('saved tabs were closed, the pinned tab stayed', open1.length === 1 && open1[0].pinned, open1.map((t) => t.url).join(', '));
let counts = await api.counts();
check('database has 1 session, 2 windows, 4 tabs', counts.sessions === 1 && counts.windows === 2 && counts.tabs === 4, JSON.stringify(counts));
check('a safety snapshot was taken before closing', counts.snapshots >= 1, `${counts.snapshots} snapshots`);
const lastAction = await api.storage('session', 'lastAction');
check('undo is offered for about 10 seconds', lastAction?.id === saved.actionId && lastAction.expiresAt - Date.now() > 5000);

// A popup opened after a save made elsewhere (here: a message, like a shortcut) offers Undo with the seconds left
const popupSaved = await open(ext('popup.html'), { width: 400, height: 580 });
await popupSaved.waitForText('Undo');
await popupSaved.screenshot(path.join(SHOTS, 'popup-after-save.png'));
check('popup offers Undo with the seconds left after a save', await popupSaved.evaluate(() => /Saved \d+ tabs\s*·\s*\d+s left/.test(document.body.innerText)));
await popupSaved.close();

// Undo brings the tabs back and removes the session
response = await api.send({ type: 'undo', actionId: saved.actionId });
check('undo succeeds', response?.ok && response.data.undone, JSON.stringify(response));
await until(async () => (await webTabs()).length >= 5);
open1 = await webTabs();
counts = await api.counts();
check('undo reopened the tabs and removed the session', open1.length === 5 && counts.sessions === 0, `${open1.length} open, ${counts.sessions} sessions`);

// Save again, then restore lazily as original windows
response = await api.send({ type: 'save', scope: 'all', close: true, audible: 'keep' });
const sessionId = response.data.sessionId;
await sleep(800);
response = await api.send({ type: 'restore', sessionId, mode: 'original', screen });
check('restore opened 4 tabs with no failures', response?.ok && response.data.opened === 4 && response.data.failed.length === 0, JSON.stringify(response?.data ?? response));
await sleep(1200);
open1 = await webTabs();
const restored = open1.filter((t) => !t.pinned);
check('restore reopened 4 tabs', restored.length === 4, `${restored.length}`);
check('lazy restore left background tabs unloaded', restored.filter((t) => t.discarded).length >= 2, `${restored.filter((t) => t.discarded).length} discarded`);
check('restore rebuilt 2 windows', new Set(restored.map((t) => t.windowId)).size === 2);
check('restored tabs keep their real addresses', restored.every((t) => t.url.startsWith('http://127.0.0.1')));

response = await api.send({ type: 'restore', sessionId, mode: 'original', screen });
check('restoring an open session offers to switch to it', response?.data?.alreadyOpenWindowId !== undefined);

// Suspend inactive
await control.evaluate((urls) => Promise.all(urls.map((url) => chrome.tabs.create({ url, active: false }))), [site('docs'), site('stripe-cli')]);
await until(async () => (await webTabs()).some((t) => t.title === PAGES.docs));
response = await api.send({ type: 'suspend-inactive' });
check('suspend inactive discards background tabs', response?.ok && response.data.suspended >= 1, JSON.stringify(response?.data ?? response));
open1 = await webTabs();
check('suspended tabs stay in place with their address', open1.some((t) => t.discarded && t.url.endsWith('/docs')));

// Single tab with keywords, kept open
const stripeTab = (await webTabs()).find((t) => t.url.endsWith('/stripe-webhooks'));
response = await api.send({ type: 'save', scope: 'tabs', tabIds: [stripeTab.id], close: false, keywordsByTabId: { [stripeTab.id]: ['payments', 'retries'] } });
check('save a tab with keywords', response?.ok && response.data.savedTabs === 1, JSON.stringify(response?.data ?? response));

// Two different saves in quick succession both run
const [one, two] = await Promise.all([
  api.send({ type: 'save', scope: 'tabs', tabIds: [newsTab.id], close: false }),
  api.send({ type: 'save', scope: 'tabs', tabIds: [stripeTab.id], close: false }),
]);
check('two different saves in a row both run', one?.data?.sessionId && two?.data?.sessionId && one.data.sessionId !== two.data.sessionId);

// ---------------------------------------------------------------------------------------------
// Popup: home, search by keyword, keyword picker, light and dark
const popup = await open(ext('popup.html'), { width: 400, height: 580 });
await popup.waitForText('Save all & free memory');
await sleep(300);
await popup.screenshot(path.join(SHOTS, 'popup-light.png'));
await popup.colorScheme('dark');
await sleep(300); // let the 150 ms colour transition finish
await popup.screenshot(path.join(SHOTS, 'popup-dark.png'));
await popup.colorScheme('light');

await popup.type('input[type=search]', 'retries');
const keywordHit = await popup.waitFor(() => [...document.querySelectorAll('[role=option]')].map((e) => e.innerText).join('\n'), undefined, 8000);
check('popup search finds a tab by a keyword not in its title or address', /Stripe Documentation/.test(keywordHit ?? ''), (keywordHit ?? '').replace(/\s+/g, ' ').slice(0, 100));
await popup.type('input[type=search]', '#payments');
const hashHit = await popup.waitFor(() => [...document.querySelectorAll('[role=option]')].map((e) => e.innerText).join('\n'), undefined, 8000);
check('"#keyword" search works', /Stripe Documentation/.test(hashHit ?? ''));
await popup.type('input[type=search]', 'stripe');
await popup.waitFor(() => document.querySelectorAll('[role=option]').length > 1, undefined, 8000);
await popup.screenshot(path.join(SHOTS, 'popup-search.png'));
await popup.type('input[type=search]', 'zzqqxx');
check('empty search state', await popup.waitForText('No tabs match', 8000));

const supabaseTab = (await webTabs()).find((t) => t.url.endsWith('/supabase'));
await control.evaluate((ids) => chrome.storage.session.set({ pendingKeywordSave: { tabIds: ids, at: Date.now() } }), [supabaseTab.id]);
const picker = await open(ext('popup.html'), { width: 400, height: 580 });
await picker.waitForText('Suggested from this tab');
const suggestions = await picker.evaluate(() => [...document.querySelectorAll('button[aria-pressed]')].map((b) => b.innerText));
check('keyword picker suggests words from the title and address', suggestions.some((s) => /supabase|checkout/i.test(s)), suggestions.join(', '));
await picker.evaluate(() => document.querySelector('button[aria-pressed]').click());
await picker.type('input[aria-label="Add a keyword"]', 'retr');
await sleep(250);
await picker.screenshot(path.join(SHOTS, 'popup-keywords.png'));
check('keyword input autocompletes from keywords already used', await picker.waitForText('used on 1 tab', 4000));

// ---------------------------------------------------------------------------------------------
// Library
const library = await open(ext(`library.html#/session/${sessionId}`));
await library.waitForText('Restore as original windows');
await sleep(500);
await library.screenshot(path.join(SHOTS, 'library-light.png'));
await library.colorScheme('dark');
await sleep(300);
await library.screenshot(path.join(SHOTS, 'library-dark.png'));
await library.colorScheme('light');
await library.goto(ext('library.html#/search/payments'));
const librarySearch = await library.waitFor(() => [...document.querySelectorAll('[role=option], [role=listitem]')].map((e) => e.innerText).join('\n'), undefined, 8000);
check('library search finds the tab by keyword', /Stripe Documentation/.test(librarySearch ?? ''));
await library.screenshot(path.join(SHOTS, 'library-search.png'));
await library.viewport(1280, 1900);
await library.goto(ext('library.html#/settings'));
await library.waitForText('Suspend inactive tabs automatically');
await sleep(300);
await library.screenshot(path.join(SHOTS, 'settings.png'));
await library.viewport(1440, 900);
await library.goto(ext('library.html#/snapshots'));
await library.waitForText('Take snapshot now');
await library.screenshot(path.join(SHOTS, 'snapshots.png'));

if (onboardingTarget) {
  const onboarding = await browser.attach(onboardingTarget.targetId, { width: 1000, height: 820 });
  pages.push(onboarding);
  await onboarding.waitForText('Save everything in one click');
  await onboarding.screenshot(path.join(SHOTS, 'onboarding.png'));
}

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
  await popupRecovery.waitForText('Restore your last session?');
  await popupRecovery.screenshot(path.join(SHOTS, 'popup-recovery.png'));
  response = await api.send({ type: 'restore-snapshot', snapshotId: offer.snapshotId, mode: 'original', screen });
  await sleep(1000);
  const back = (await webTabs()).length;
  check('recovery restores the last session', response?.ok && back >= beforeRestart - 1, `${back} of ${beforeRestart} tabs`);
  check('recovery offer is cleared', !(await api.storage('local', 'recoveryOffer')));
}

await browser.close();
server.close();
rmSync(userDataDir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
