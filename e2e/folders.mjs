// End-to-end test of the Free plan's 0.6 features: folders, moving tabs between folders and kinds of
// site, snooze, Fold automatically, Same page twice, imports, the Ctrl+K palette, the free list's 500
// tabs ("Make room") and the ways to the plans page (Upgrade, live folders, sharing). Real Chromium
// with the built extension and its worker; nothing is faked. The full list and the popup are driven
// like a person would (clicks, keys, drag events) and the results are read from IndexedDB and
// chrome.storage. Worker commands are only used to set things up (folding real tabs, as the shortcut
// does) and where the UI can't be driven.
// Run `npm run build` first (the default build has no server: Free only), then `npm run e2e:folders`.
// Screenshots go to e2e/screenshots/folders (or $SHOTS_DIR/folders).
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome } from './cdp.mjs';

const EXT = path.resolve('.output/chrome-mv3');
const SHOTS = path.resolve(process.env.SHOTS_DIR ?? 'e2e/screenshots', 'folders');
mkdirSync(SHOTS, { recursive: true });

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

// ---------------------------------------------------------------------------------------------
// Pages to fold. Four sites on this computer: 127.0.0.1 is "Dev" in Tabfold's built-in list and the
// other loopback addresses are "Other", so there are real sites to move between kinds.
const PAGES = {
  'acme-pricing': 'Pricing – Acme',
  'acme-blog': 'Blog – Acme',
  'acme-careers': 'Careers – Acme',
  'garden-tools': 'Garden tools',
  'garden-seeds': 'Seeds catalogue',
  recipes: 'Weeknight recipes',
  travel: 'Lisbon travel guide',
  'api-docs': 'API reference',
  status: 'Status page',
  'read-later': 'Read later article',
  'idle-one': 'Idle page one',
  'idle-two': 'Idle page two',
};
const HOSTS = ['127.0.0.1', '127.0.0.2', '127.0.0.3', '127.0.0.4'];
const servers = [];
for (const host of HOSTS) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').slice(1).split('?')[0]) || 'home';
    const title = PAGES[name] ?? name.replace(/-/g, ' ');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  servers.push(server);
}
/** A page on one of the four sites (0: 127.0.0.1 … 3: 127.0.0.4). */
const site = (i, name) => `http://${HOSTS[i]}:${servers[i].address().port}/${name}`;

// ---------------------------------------------------------------------------------------------
const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tabfold-folders-'));
const filesDir = mkdtempSync(path.join(os.tmpdir(), 'tabfold-folders-files-'));
const browser = await launchChrome({ extensionDir: EXT, userDataDir });
const extId = await browser.extensionId();
const ext = (p) => `chrome-extension://${extId}/${p}`;
check('service worker starts', !!extId, extId);
const worker = await browser.attachWorker();
const pages = [];
async function open(url, size) {
  const p = await browser.openPage(url, size);
  pages.push(p);
  return p;
}
const pin = (p) => p.evaluate(() => chrome.tabs.getCurrent().then((t) => chrome.tabs.update(t.id, { pinned: true })));

// A pinned Tabfold page for commands and reading the database (pinned, so folds leave it open).
const control = await open(ext('library.html'));
await pin(control);
const send = (command) => control.evaluate((c) => new Promise((res) => chrome.runtime.sendMessage({ __tabfold: true, command: c }, res)), command);
const local = (key) => control.evaluate((k) => chrome.storage.local.get(k).then((r) => r[k]), key);
const idb = (store) =>
  control.evaluate(
    (s) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('tabfold');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const q = req.result.transaction(s).objectStore(s).getAll();
          q.onsuccess = () => {
            resolve(q.result);
            req.result.close();
          };
        };
      }),
    store,
  );
const liveFolders = async () => (await idb('folders')).filter((f) => !f.deletedAt).sort((a, b) => a.order - b.order);
const folderNamed = async (name) => (await liveFolders()).find((f) => f.name === name);
const tabTitled = async (title) => (await idb('tabs')).find((t) => t.title === title);
const foldedCount = async () => (await idb('sessions')).filter((s) => !s.deletedAt).reduce((n, s) => n + (s.tabCount || 0), 0);
const chromeTabs = () =>
  control.evaluate(() =>
    chrome.tabs.query({}).then((ts) => ts.map((t) => ({ id: t.id, url: t.url || t.pendingUrl, title: t.title, windowId: t.windowId, groupId: t.groupId, pinned: t.pinned }))),
  );
const newWindow = (urls) => control.evaluate((u) => chrome.windows.create({ url: u, focused: false }).then((w) => w.id), urls);
const titlesLoaded = (urls) =>
  until(async () => {
    const open = await chromeTabs();
    return urls.every((u) => open.some((t) => t.url === u && t.title && t.title !== u && !t.title.startsWith(new URL(u).host)));
  }, 15_000);

/**
 * Write folds straight into IndexedDB (sessions with matching tab counts), for states that would
 * take hundreds of real tabs. Pages showing the list are reloaded afterwards.
 */
async function seed(spec) {
  await control.evaluate(async (folds) => {
    const req = indexedDB.open('tabfold');
    const db = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction(['sessions', 'windows', 'tabs', 'meta'], 'readwrite');
    for (const fold of folds) {
      tx.objectStore('sessions').put({
        id: fold.id,
        name: fold.name,
        tags: [],
        pinned: 0,
        color: null,
        kind: 'session',
        source: 'save-all',
        createdAt: fold.createdAt,
        updatedAt: fold.createdAt,
        deletedAt: 0,
        deviceId: 'e2e-seed',
        version: 1,
        tabCount: fold.tabs.length,
        windowCount: 1,
        preview: fold.tabs.slice(0, 3).map((t) => ({ url: t.url, title: t.title })),
      });
      tx.objectStore('windows').put({ id: `${fold.id}w0`, sessionId: fold.id, name: '', order: 0, wasFocused: false, bounds: null, state: null });
      fold.tabs.forEach((t, i) =>
        tx.objectStore('tabs').put({
          id: `${fold.id}t${i}`,
          sessionId: fold.id,
          windowId: `${fold.id}w0`,
          url: t.url,
          title: t.title,
          favIconUrl: '',
          pinned: false,
          groupName: null,
          groupColor: null,
          groupCollapsed: false,
          order: i,
          savedAt: t.savedAt ?? fold.createdAt,
          keywords: [],
          urlTruncated: false,
          ...(t.folderId ? { folderId: t.folderId } : {}),
        }),
      );
    }
    // Search rebuilds when this moves.
    const meta = tx.objectStore('meta');
    const version = meta.get('searchVersion');
    version.onsuccess = () => meta.put({ key: 'searchVersion', value: (typeof version.result?.value === 'number' ? version.result.value : 0) + 1 });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, spec);
}

// ---------------------------------------------------------------------------------------------
// Driving pages

const textOf = (p) => p.evaluate(() => document.body?.innerText ?? '').catch(() => '');
const has = (p, text, timeout = 6000) => until(async () => (await textOf(p)).includes(text), timeout);
const lacks = (p, text, timeout = 6000) => until(async () => !(await textOf(p)).includes(text), timeout);
const shot = async (p, name) => {
  await p.send('Page.bringToFront').catch(() => undefined);
  await sleep(250);
  await Promise.race([p.screenshot(path.join(SHOTS, name)), sleep(5000)]);
};
/** Click the first visible, enabled element in `scope` whose text (first line) is `label`. */
const click = (p, label, scope = 'button, a, [role=option]') =>
  p.evaluate(([l, s]) => {
    const el = [...document.querySelectorAll(s)].find(
      (e) => (e.innerText ?? '').trim().split('\n')[0].trim() === l && !e.disabled && e.getBoundingClientRect().width > 0,
    );
    el?.click();
    return !!el;
  }, [label, scope]);
/** The same, in the dialog on top. */
const clickInDialog = (p, label) =>
  p.evaluate((l) => {
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    const el = [...(dialog?.querySelectorAll('button, a, [role=radio]') ?? [])].find((e) => (e.innerText ?? '').trim() === l && !e.disabled);
    el?.click();
    return !!el;
  }, label);
const dialogText = (p) => p.evaluate(() => [...document.querySelectorAll('dialog[open]')].at(-1)?.innerText ?? '').catch(() => '');
const dialogHas = (p, text, timeout = 6000) => until(async () => (await dialogText(p)).includes(text), timeout);
const noDialog = (p, timeout = 4000) => until(() => p.evaluate(() => !document.querySelector('dialog[open]')), timeout);
/** A menu item (in the newest open menu) by its label. */
const menuItem = (p, label) =>
  p.evaluate((l) => {
    const menu = [...document.querySelectorAll('[role=menu]')].at(-1);
    const el = [...(menu?.querySelectorAll('[role^=menuitem]') ?? [])].find((e) => (e.getAttribute('aria-label') ?? (e.innerText ?? '').trim().split('\n')[0].trim()) === l);
    el?.click();
    return !!el;
  }, label);
const menus = (p) => p.evaluate(() => document.querySelectorAll('[role=menu]').length);
/** Click a menu item, then wait for the submenu it opens. */
async function submenu(p, label) {
  const before = await menus(p);
  const ok = await menuItem(p, label);
  return ok && !!(await until(async () => (await menus(p)) > before, 3000));
}
/** The Undo button in the toast that says `message`. */
const toastUndo = (p, message) =>
  p.evaluate((m) => {
    const toast = [...document.querySelectorAll('[aria-live="polite"] > div')].find((d) => d.textContent.includes(m));
    const button = [...(toast?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Undo');
    button?.click();
    return !!button;
  }, message);

const KEY_CODES = { Enter: 13, Escape: 27, k: 75 };
async function press(p, key, { ctrl = false } = {}) {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const event = { key, code, windowsVirtualKeyCode: KEY_CODES[key] ?? 0, nativeVirtualKeyCode: KEY_CODES[key] ?? 0, modifiers: ctrl ? 2 : 0 };
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}
const typeText = (p, text) => p.send('Input.insertText', { text });
/** A real double-click (two presses) at the middle of the element `find` returns. */
async function doubleClick(p, find, arg) {
  const point = await p.evaluate(find, arg);
  if (!point) return false;
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  for (const clickCount of [1, 2]) {
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount });
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount });
  }
  return true;
}
/** A real click (left or right) at the point `find` returns. */
async function clickAt(p, find, arg, button = 'left') {
  const point = await p.evaluate(find, arg);
  if (!point) return false;
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount: 1 });
  return true;
}
/** Give a file to the page's (hidden) file input, as choosing it in Chrome's file dialog does. */
async function chooseFile(p, selector, file) {
  const { result } = await p.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
  if (!result?.objectId) return false;
  await p.send('DOM.setFileInputFiles', { files: [file], objectId: result.objectId });
  return true;
}
/**
 * Pick an option in the top dialog's <select> that has it, the way a person choosing it does (React
 * sees the change). Returns the option's text, or null.
 */
const choose = (p, value) =>
  p.evaluate((v) => {
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1) ?? document;
    const el = [...dialog.querySelectorAll('select:not([disabled])')].find((s) => [...s.options].some((o) => o.value === v));
    if (!el) return null;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === v ? [...el.options].find((o) => o.value === v).textContent : null;
  }, value);

// ---------------------------------------------------------------------------------------------
// The full list. Rows are `.tf-row` with "Open <title> (stays in the list)"; group headers are
// `h2 button[aria-expanded]`; the left column is nav "Folders and groups". The list is virtual, so
// a group is jumped to (from the left column) before reading or using its rows.

const ui = await open(ext('library.html'), { width: 1440, height: 1000 });
await pin(ui);
const focusUi = () => ui.send('Page.bringToFront').catch(() => undefined);
const go = async (hash) => {
  await ui.evaluate((h) => {
    location.hash = h;
  }, hash);
  await sleep(300);
};
/** Reload the full list (it reads what was written straight into the database). */
const reloadUi = async () => {
  await ui.evaluate(() => {
    window.__tfBeforeReload = true;
    history.replaceState(null, '', '#/');
  });
  await ui.send('Page.reload');
  await ui.waitFor(() => !window.__tfBeforeReload && document.readyState === 'complete', null, 10_000);
  await has(ui, 'Folded', 8000);
  await sleep(400);
};

/** Left column item: its name and count, or null. */
const sideItem = (name) =>
  ui.evaluate((n) => {
    const a = [...document.querySelectorAll('nav[aria-label="Folders and groups"] a')].find((x) => (x.querySelector('span[dir=auto]')?.textContent ?? x.innerText.split('\n')[0]) === n);
    return a ? { name: n, count: Number(a.querySelector('.tabular-nums')?.textContent.replace(/\D/g, '') ?? NaN) } : null;
  }, name);
/** Jump to a group from the left column (it opens and scrolls to the top). */
async function jump(name) {
  const ok = await ui.evaluate((n) => {
    const a = [...document.querySelectorAll('nav[aria-label="Folders and groups"] a')].find((x) => (x.querySelector('span[dir=auto]')?.textContent ?? x.innerText.split('\n')[0]) === n);
    a?.click();
    return !!a;
  }, name);
  await sleep(350);
  return ok;
}
/** A group's rows (titles) as the list shows them, after jumping to it ("Show N more" opened). */
async function groupRows(name) {
  await jump(name);
  const read = () =>
    ui.evaluate((n) => {
      const y = (el) => Number(/translateY\(([-\d.]+)px\)/.exec(el.style.transform)?.[1] ?? NaN);
      const head = [...document.querySelectorAll('h2 button[aria-expanded]')].find((b) => b.querySelector('span[dir=auto]')?.textContent === n);
      if (!head) return null;
      const item = head.closest('[style*="translateY"]');
      const items = [...item.parentElement.children].sort((a, b) => y(a) - y(b));
      const titles = [];
      let more = null;
      for (const it of items.slice(items.indexOf(item) + 1)) {
        if (it.querySelector('h2')) break;
        const open = it.querySelector('.tf-row [aria-label^="Open "]');
        if (open) titles.push(open.getAttribute('aria-label').replace(/^Open /, '').replace(/ \(stays in the list\)$/, ''));
        const button = [...it.querySelectorAll('button')].find((b) => /^Show [\d,]+ more$/.test(b.textContent.trim()));
        if (button) more = button;
      }
      more?.click();
      return { titles, more: !!more };
    }, name);
  let rows = await read();
  if (rows?.more) {
    await sleep(250);
    rows = await read();
  }
  return rows?.titles ?? null;
}
/** Open a row's ⋯ menu (after jumping to its group). */
async function rowMenu(title, group) {
  if (group) await groupRows(group);
  const ok = await ui.evaluate((t) => {
    const open = [...document.querySelectorAll('.tf-row [aria-label^="Open "]')].find((e) => e.getAttribute('aria-label') === `Open ${t} (stays in the list)`);
    const more = open?.closest('.tf-row')?.querySelector('[aria-label^="More for"]');
    more?.click();
    return !!more;
  }, title);
  return ok && !!(await until(() => menus(ui), 3000));
}
/** Open a group's ⋯ menu. */
async function groupMenu(name) {
  await jump(name);
  const ok = await ui.evaluate((n) => {
    const button = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === `More for ${n}`);
    button?.click();
    return !!button;
  }, name);
  return ok && !!(await until(() => menus(ui), 3000));
}
/** Start dragging a row and hold it over a target (dragstart, dragenter, dragover): does the target take it? */
async function dragOver(title, target) {
  return ui.evaluate(([t, tgt]) => {
    const open = [...document.querySelectorAll('.tf-row [aria-label^="Open "]')].find((e) => e.getAttribute('aria-label') === `Open ${t} (stays in the list)`);
    const row = open?.closest('[draggable=true]');
    if (!row) return { found: false };
    const el = tgt.side
      ? [...document.querySelectorAll('nav[aria-label="Folders and groups"] a')].find((a) => a.querySelector('span[dir=auto]')?.textContent === tgt.side)
      : [...document.querySelectorAll('h2 button[aria-expanded]')].find((b) => b.querySelector('span[dir=auto]')?.textContent === tgt.list);
    if (!el) return { found: false, row: true };
    const dataTransfer = new DataTransfer();
    window.__tfDrag = { row, el, dataTransfer };
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer });
    el.dispatchEvent(over);
    return { found: true, accepts: over.defaultPrevented };
  }, [title, target]);
}
/** Drop the dragged row where it is over. */
const drop = () =>
  ui.evaluate(() => {
    const { row, el, dataTransfer } = window.__tfDrag ?? {};
    if (!el) return false;
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
    window.__tfDrag = null;
    return true;
  });
async function dragRow(title, target) {
  const over = await dragOver(title, target);
  await sleep(150);
  if (over.found) await drop();
  return over;
}

async function openPopup() {
  const popup = await open(ext('popup.html'), { width: 400, height: 600 });
  await popup.waitForText('Fold', 8000);
  await sleep(500);
  return popup;
}
/** The popup as a background tab in a window, so "the tab you're on" is that window's page. */
async function openPopupIn(windowId) {
  const url = ext('popup.html');
  const before = new Set((await browser.targets()).map((t) => t.targetId));
  await control.evaluate(([w, u]) => chrome.tabs.create({ windowId: w, url: u, active: false }), [windowId, url]);
  const target = await until(async () => (await browser.targets()).find((t) => !before.has(t.targetId) && t.type === 'page' && t.url.startsWith(url)), 8000);
  const popup = await browser.attach(target.targetId, { width: 400, height: 600 });
  pages.push(popup);
  await popup.waitForText('Fold', 8000);
  await sleep(500);
  return popup;
}
/** The popup's "Folded · 16 of 500" label: its count text and whether it is amber. */
const popupFoldedLabel = (popup) =>
  popup.evaluate(() => {
    const h2 = [...document.querySelectorAll('h2')].find((h) => h.textContent.trim() === 'Folded');
    const count = h2?.nextElementSibling;
    return h2 ? { text: `Folded ${count?.textContent ?? ''}`.trim(), amber: !!count?.querySelector('.text-amber') } : null;
  });

/** The fold the popup shows a result for (60 s) is over: wait it out, so the popup is at rest. */
async function quietFolds() {
  const fold = await control.evaluate(() => chrome.storage.session.get('activeFold').then((r) => r.activeFold));
  const at = fold?.finishedAt ?? fold?.startedAt ?? 0;
  const wait = at + 62_000 - Date.now();
  if (wait > 0) {
    console.log(`  (waiting ${Math.ceil(wait / 1000)} s for the popup to stop showing the last fold)`);
    await sleep(wait);
  }
}

await until(async () => (await send({ type: 'room-list' }))?.ok, 15_000, 300);

// ---------------------------------------------------------------------------------------------
// Setup: tabs from Zoho Mail, Amazon and Hacker News (sites a test can't open) go straight into the
// database; real pages from the four local sites are opened and folded with the worker's fold.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t0 = Date.now();
await seed([
  {
    id: 'e2eseed1',
    name: 'Fold',
    createdAt: t0 - 2 * HOUR,
    tabs: [
      { url: 'https://mail.zoho.eu/zm/#mail/folder/inbox', title: 'Inbox – Zoho Mail' },
      { url: 'https://mail.zoho.com/zm/#mail/folder/sent', title: 'Sent – Zoho Mail' },
      { url: 'https://www.amazon.com/dp/B0E2ETEST', title: 'Standing desk – Amazon' },
      { url: 'https://news.ycombinator.com/item?id=1', title: 'Show HN: a tab manager' },
      { url: 'https://rlroadrescue.com/', title: 'Mobile Auto Repair' },
    ],
  },
]);
const W1 = [
  site(1, 'acme-pricing'),
  site(1, 'acme-blog'),
  site(2, 'garden-tools'),
  site(2, 'garden-seeds'),
  site(3, 'recipes'),
  site(3, 'travel'),
  site(0, 'api-docs'),
  site(0, 'status'),
];
const w1 = await newWindow(W1);
await titlesLoaded(W1);
let response = await send({ type: 'fold', windowId: w1 });
check('folding a window of 8 real tabs saves them', response?.ok && response.data.savedTabs === 8, JSON.stringify(response?.data?.savedTabs ?? response));
check('…and closes them', !(await chromeTabs()).some((t) => W1.includes(t.url)));
await reloadUi();
await focusUi();

// ---------------------------------------------------------------------------------------------
// 1. Zoho Mail is "Mail & chat", not "Other"
const mailSide = await sideItem('Mail & chat');
check('the left column has "Mail & chat" with the 2 Zoho Mail tabs', mailSide?.count === 2, JSON.stringify(mailSide));
const mailRows = await groupRows('Mail & chat');
check(
  'Zoho Mail (mail.zoho.eu and mail.zoho.com) shows under "Mail & chat"',
  mailRows?.includes('Inbox – Zoho Mail') && mailRows?.includes('Sent – Zoho Mail'),
  JSON.stringify(mailRows),
);
const otherRows = await groupRows('Other');
check('…and not under "Other"', !!otherRows && !otherRows.some((t) => t.includes('Zoho')) && otherRows.includes('Mobile Auto Repair'), JSON.stringify(otherRows));
check('the local test sites group as expected (127.0.0.1 is Dev)', (await groupRows('Dev'))?.includes('API reference'));
await shot(ui, 'list.png');

// ---------------------------------------------------------------------------------------------
// 2. Upgrade on Free: the full list's top bar and the popup's header open the plans page
const topUpgrade = await ui.evaluate(() => {
  const button = [...document.querySelectorAll('header button, button')].find((b) => b.innerText.trim() === 'Upgrade');
  button?.click();
  return !!button;
});
const onPlans = await until(() => ui.evaluate(() => location.hash === '#/pro'), 4000);
check('"Upgrade" in the full list’s top bar opens the plans page', topUpgrade && onPlans);
const planNames = await until(async () => {
  const names = await ui.evaluate(() => [...document.querySelectorAll('h2[id^="plan-"]')].map((h) => h.textContent.trim()));
  return names.length === 4 ? names : null;
}, 6000);
check(
  'the plans page shows the four plans',
  !!planNames && planNames[0].startsWith('Free') && planNames[1].startsWith('Pro') && planNames[2].startsWith('Pro AI') && planNames[3].startsWith('Teams'),
  JSON.stringify(planNames),
);
check('…with "$99 once, for life" and "Start a team"', (await has(ui, '$99 once, for life', 3000)) && (await has(ui, 'Start a team', 1000)));
await shot(ui, 'plans.png');
await go('#/');

let popup = await openPopup();
const popupUpgrade = await popup.evaluate(() => {
  const button = [...document.querySelectorAll('header button')].find((b) => b.innerText.trim() === 'Upgrade');
  button?.click();
  return !!button;
});
const plansTab = await until(async () => (await chromeTabs()).find((t) => t.url?.startsWith(ext('library.html')) && t.url.endsWith('#/pro')), 6000);
check('"Upgrade" in the popup’s header opens the plans page', popupUpgrade && !!plansTab, plansTab?.url);
await popup.close().catch(() => undefined);
for (const p of [control, ui]) await p.evaluate(() => location.hash === '#/pro' && (location.hash = '#/')).catch(() => undefined);
await sleep(400);

// ---------------------------------------------------------------------------------------------
// 3. Folders
await focusUi();
await ui.evaluate(() => document.querySelector('nav [aria-label="New folder"]')?.click());
check('the left column’s + opens the New folder field', !!(await until(() => ui.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Folder name'), 3000)));
check('…with "Enter to create · Esc to cancel"', await has(ui, 'Enter to create · Esc to cancel', 2000));
await typeText(ui, 'Client sites');
await press(ui, 'Enter');
let clientSites = await until(() => folderNamed('Client sites'));
check('Enter makes the folder', !!clientSites, JSON.stringify((await liveFolders()).map((f) => f.name)));
const newFolderCount = () =>
  ui.evaluate(() => [...document.querySelectorAll('nav[aria-label="Folders and groups"] button')].find((b) => b.innerText.startsWith('New folder'))?.innerText.replace(/\s+/g, ' ').trim());
check('the left column says "New folder · 1 of 3"', !!(await until(async () => (await newFolderCount())?.includes('1 of 3'), 4000)), await newFolderCount());
check('the empty folder says how to fill it', await has(ui, 'No tabs yet. Drag tabs here, or use a tab’s ⋯ › Move to.', 3000));

// Move to › folder, with Undo
check('a row’s ⋯ opens its menu', await rowMenu('Pricing – Acme', 'Other'));
await submenu(ui, 'Move to');
await menuItem(ui, 'Client sites');
check('Move to › Client sites puts the tab in the folder', await until(async () => (await tabTitled('Pricing – Acme'))?.folderId === clientSites.id));
check('toast: "Moved 1 tab to Client sites" with Undo', await has(ui, 'Moved 1 tab to Client sites', 3000));
await toastUndo(ui, 'Moved 1 tab to Client sites');
check('Undo takes it back out', await until(async () => !(await tabTitled('Pricing – Acme'))?.folderId));

// Drag a row onto the folder, in the list and in the left column
await groupRows('Other');
let over = await dragOver('Garden tools', { list: 'Client sites' });
check('dragging a row over a folder offers to take it', over.accepts, JSON.stringify(over));
check('…saying "Drop to move this tab here"', await has(ui, 'Drop to move this tab here', 2000));
await shot(ui, 'drag-to-folder.png');
await drop();
check('dropping a row on a folder in the list moves it there', await until(async () => (await tabTitled('Garden tools'))?.folderId === clientSites.id));
await groupRows('Other');
over = await dragRow('Seeds catalogue', { side: 'Client sites' });
check('dropping a row on a folder in the left column moves it there', over.accepts && (await until(async () => (await tabTitled('Seeds catalogue'))?.folderId === clientSites.id)), JSON.stringify(over));
check('the left column counts the folder’s 2 tabs', (await until(async () => (await sideItem('Client sites'))?.count === 2, 3000)));

// Rename by double-click: the list's folder header, then the left column
await jump('Client sites');
await doubleClick(
  ui,
  (n) => {
    const button = [...document.querySelectorAll('h2 button[aria-expanded]')].find((b) => b.querySelector('span[dir=auto]')?.textContent === n);
    if (!button) return null;
    button.scrollIntoView({ block: 'center' });
    const r = button.querySelector('span[dir=auto]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  },
  'Client sites',
);
check('double-clicking the folder’s header edits its name', !!(await until(() => ui.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Rename Client sites'), 3000)));
await typeText(ui, 'Clients');
await press(ui, 'Enter');
check('Enter renames it', await until(async () => (await idb('folders')).find((f) => f.id === clientSites.id)?.name === 'Clients'));
// Jumping scrolls the list (and moves the sticky left column): jump first, so both clicks land on the item.
await until(() => sideItem('Clients'), 3000);
await jump('Clients');
await sleep(300);
await doubleClick(
  ui,
  (n) => {
    const a = [...document.querySelectorAll('nav[aria-label="Folders and groups"] a')].find((x) => x.querySelector('span[dir=auto]')?.textContent === n);
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  },
  'Clients',
);
check('double-clicking the folder in the left column edits its name', !!(await until(() => ui.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Rename Clients'), 3000)));
await typeText(ui, 'Client work');
await press(ui, 'Enter');
check('…and Enter renames it there too', await until(async () => (await idb('folders')).find((f) => f.id === clientSites.id)?.name === 'Client work'));

// Colour
await groupMenu('Client work');
check('the folder’s ⋯ menu has Rename, Colour, Delete folder…', /Rename[\s\S]*Colour[\s\S]*Delete folder…/.test(await ui.evaluate(() => [...document.querySelectorAll('[role=menu]')].at(-1)?.innerText ?? '')));
await menuItem(ui, 'Green');
check('a colour swatch recolours the folder', await until(async () => (await folderNamed('Client work'))?.color === 'green'), (await folderNamed('Client work'))?.color);

// Out of its folder
await rowMenu('Seeds catalogue', 'Client work');
await submenu(ui, 'Move to');
check('a tab in a folder has "Out of its folder"', await menuItem(ui, 'Out of its folder'));
check('…which takes it out', await until(async () => !(await tabTitled('Seeds catalogue'))?.folderId));
check('toast: "Took 1 tab out of Client work"', await has(ui, 'Took 1 tab out of Client work', 3000));
await rowMenu('Pricing – Acme', 'Other');
await submenu(ui, 'Move to');
await menuItem(ui, 'Client work');
await until(async () => (await tabTitled('Pricing – Acme'))?.folderId === clientSites.id);

// The second folder from the heading's "New folder" (the left column's field on a wide window)
await jump('Client work');
await ui.evaluate(() => {
  const h1 = [...document.querySelectorAll('h1')].find((h) => h.textContent === 'Folded');
  [...(h1?.parentElement.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === 'New folder')?.click();
});
await until(() => ui.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Folder name'), 3000);
await typeText(ui, 'Recipes');
await press(ui, 'Enter');
const recipes = await until(() => folderNamed('Recipes'));
check('the heading’s "New folder" makes a second folder', !!recipes);
check('"New folder · 2 of 3"', !!(await until(async () => (await newFolderCount())?.includes('2 of 3'), 4000)), await newFolderCount());
await rowMenu('Weeknight recipes', 'Other');
await submenu(ui, 'Move to');
await menuItem(ui, 'Recipes');
await until(async () => (await tabTitled('Weeknight recipes'))?.folderId === recipes?.id);

// A folder made elsewhere (another tab or computer) while "New folder" is open: "Create and move" then
// shows "Free has 3 folders" (the worker refuses it when the page hasn't seen the new folder yet), and
// nothing is made or moved.
await rowMenu('Lisbon travel guide', 'Other');
await submenu(ui, 'Move to');
await menuItem(ui, 'New folder…');
check('Move to › New folder… asks for a name ("Create and move")', await dialogHas(ui, 'Create and move', 3000));
await typeText(ui, 'Travel');
const refusedBefore = (worker?.errors ?? []).filter((e) => e.includes('folder-create folder-limit')).length;
const raced = await ui.evaluate(
  () =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ __tabfold: true, command: { type: 'folder-create', name: 'Elsewhere' } }, (res) => {
        const button = [...document.querySelectorAll('dialog[open] button')].find((b) => b.innerText.trim() === 'Create and move' && !b.disabled);
        button?.click();
        resolve({ made: !!res?.ok, clicked: !!button });
      });
    }),
);
const limitShown = raced.made && raced.clicked && (await dialogHas(ui, 'Free has 3 folders', 4000));
const byWorker = (worker?.errors ?? []).filter((e) => e.includes('folder-create folder-limit')).length > refusedBefore;
check('with 3 folders, "Create and move" shows "Free has 3 folders"', limitShown, byWorker ? 'the worker refused folder-create' : 'the page saw the 3rd folder first');
await sleep(500);
check('…and makes nothing, moves nothing', (await liveFolders()).length === 3 && !(await folderNamed('Travel')) && !(await tabTitled('Lisbon travel guide'))?.folderId, (await liveFolders()).map((f) => f.name).join(', '));
await shot(ui, 'folder-limit.png');
await clickInDialog(ui, 'Not now');
await noDialog(ui);
check('"New folder · 3 of 3"', !!(await until(async () => (await newFolderCount())?.includes('3 of 3'), 4000)), await newFolderCount());

await ui.evaluate(() => document.querySelector('nav [aria-label="New folder"]')?.click());
check('the 4th folder from the left column shows "Free has 3 folders"', await dialogHas(ui, 'Free has 3 folders', 3000));
check('…with "Not now" and "Upgrade"', /Not now[\s\S]*Upgrade/.test(await dialogText(ui)));
await clickInDialog(ui, 'Not now');
await noDialog(ui);
response = await send({ type: 'folder-create', name: 'Fourth' });
check('the worker refuses a 4th folder on Free (folder-limit)', response && !response.ok && response.code === 'folder-limit' && response.details?.limit === 3, JSON.stringify(response));

// Delete a folder: confirm, its tabs stay and go back by site, Undo brings it back
await groupMenu('Elsewhere');
await menuItem(ui, 'Delete folder…');
await dialogHas(ui, 'Delete “Elsewhere”?', 3000);
await clickInDialog(ui, 'Delete folder');
await until(async () => !(await folderNamed('Elsewhere')));
await groupMenu('Client work');
await menuItem(ui, 'Delete folder…');
check('Delete folder… asks first: "Delete “Client work”?"', await dialogHas(ui, 'Delete “Client work”?', 3000));
check('…saying its 2 tabs stay in the list', (await dialogText(ui)).includes('Its 2 tabs stay in your list'));
await shot(ui, 'delete-folder.png');
await clickInDialog(ui, 'Delete folder');
const deleted = await until(async () => (await idb('folders')).find((f) => f.id === clientSites.id && f.deletedAt));
const backBySite = await until(async () => {
  const [a, b] = await Promise.all([tabTitled('Pricing – Acme'), tabTitled('Garden tools')]);
  return a && b && !a.folderId && !b.folderId && a.sessionId && b.sessionId;
});
check('the folder is deleted, its tabs stay in the list out of the folder', !!deleted && !!backBySite);
check('toast: "Deleted “Client work”. Its 2 tabs went back to their kind of site."', await has(ui, 'Deleted “Client work”. Its 2 tabs went back to their kind of site.', 3000));
check('…the tabs show by site again', (await groupRows('Other'))?.includes('Garden tools'));
await toastUndo(ui, 'Deleted “Client work”');
const undeleted = await until(async () => {
  const folder = (await idb('folders')).find((f) => f.id === clientSites.id);
  const [a, b] = await Promise.all([tabTitled('Pricing – Acme'), tabTitled('Garden tools')]);
  return folder && !folder.deletedAt && a?.folderId === folder.id && b?.folderId === folder.id ? folder : null;
});
check('Undo brings the folder back with its tabs', !!undeleted);
check('…as it was (name, colour, place)', undeleted?.name === 'Client work' && undeleted.color === 'green' && (await liveFolders())[0]?.id === clientSites.id, JSON.stringify(undeleted && { name: undeleted.name, color: undeleted.color }));

// The third folder: Move to › New folder… › Create and move
await rowMenu('Lisbon travel guide', 'Other');
await submenu(ui, 'Move to');
await menuItem(ui, 'New folder…');
await dialogHas(ui, 'Create and move', 3000);
await typeText(ui, 'Travel');
await clickInDialog(ui, 'Create and move');
const travel = await until(() => folderNamed('Travel'));
check('"Create and move" makes the folder and moves the tab into it', !!travel && (await until(async () => (await tabTitled('Lisbon travel guide'))?.folderId === travel.id)));
check('toast: "Moved 1 tab to Travel"', await has(ui, 'Moved 1 tab to Travel', 3000));
await noDialog(ui);
await shot(ui, 'folders.png');

// ---------------------------------------------------------------------------------------------
// 4. Kinds of site: Move to › Kind of site, dragging onto a site group; remembered for new tabs
await rowMenu('Blog – Acme', 'Other');
await submenu(ui, 'Move to');
await submenu(ui, 'Kind of site');
await shot(ui, 'menu-kind-of-site.png');
await menuItem(ui, 'Reading');
let siteKinds = await until(async () => {
  const kinds = await local('siteKinds');
  return kinds?.['127.0.0.2']?.kind === 'reading' ? kinds : null;
});
check('Move to › Kind of site › Reading remembers the site (127.0.0.2)', !!siteKinds, JSON.stringify(await local('siteKinds')));
check('toast: "Moved 127.0.0.2 to Reading. Its new tabs go there too."', await has(ui, 'Moved 127.0.0.2 to Reading. Its new tabs go there too.', 3000));
check('the tab now shows under Reading', (await groupRows('Reading'))?.includes('Blog – Acme'));

await groupRows('Dev');
over = await dragOver('Status page', { list: 'Shopping' });
check('dragging a row over a kind of site offers to move its site', over.accepts && (await has(ui, 'Drop to move 127.0.0.1 here', 2000)), JSON.stringify(over));
await drop();
siteKinds = await until(async () => {
  const kinds = await local('siteKinds');
  return kinds?.['127.0.0.1']?.kind === 'shopping' ? kinds : null;
});
check('dropping it on "Shopping" in the list moves the site there', !!siteKinds);
check('…with both of that site’s tabs', !!(await until(async () => {
  const rows = await groupRows('Shopping');
  return rows?.includes('Status page') && rows.includes('API reference');
}, 4000)));
await groupRows('Other');
over = await dragRow('Seeds catalogue', { side: 'Social' });
check('dropping a row on a kind of site in the left column moves its site', over.accepts && !!(await until(async () => (await local('siteKinds'))?.['127.0.0.3']?.kind === 'social')), JSON.stringify(over));

// A new tab from a moved site lands in the chosen kind
const careers = site(1, 'acme-careers');
const w2 = await newWindow([careers]);
await titlesLoaded([careers]);
response = await send({ type: 'fold', windowId: w2 });
check('a new tab from 127.0.0.2 folds…', response?.ok && response.data.savedTabs === 1);
check('…into Reading, the kind chosen for its site', !!(await until(async () => (await groupRows('Reading'))?.includes('Careers – Acme'), 5000)), JSON.stringify(await groupRows('Reading')));

// Settings › Your tabs › Sites you moved › Put back
await go('#/settings');
check('Settings lists "Sites you moved"', await has(ui, 'Sites you moved', 5000));
const movedList = await ui.evaluate(() => [...document.querySelectorAll('[aria-label^="Put "][aria-label$=" back"]')].map((b) => b.getAttribute('aria-label')));
check('…with the 3 sites and Put back', ['127.0.0.1', '127.0.0.2', '127.0.0.3'].every((h) => movedList.includes(`Put ${h} back`)), JSON.stringify(movedList));
await ui.evaluate(() => {
  const section = document.querySelector('[aria-label="Put 127.0.0.2 back"]');
  section?.scrollIntoView({ block: 'center' });
});
await shot(ui, 'settings-sites-you-moved.png');
await ui.evaluate(() => document.querySelector('[aria-label="Put 127.0.0.2 back"]')?.click());
check('Put back forgets the move', !!(await until(async () => !(await local('siteKinds'))?.['127.0.0.2'])));
check('toast: "Put 127.0.0.2 back"', await has(ui, 'Put 127.0.0.2 back', 3000));
await go('#/');
await noDialog(ui);
check('…and its tabs show under Other again', !!(await until(async () => (await groupRows('Other'))?.includes('Careers – Acme'), 4000)));

// ---------------------------------------------------------------------------------------------
// 5. The popup: folders first in Folded, "Folded · N of 500"
popup = await openPopup();
const total = await foldedCount();
const label = await until(async () => {
  const l = await popupFoldedLabel(popup);
  return l?.text.includes(`${total} of 500`) ? l : null;
}, 5000);
check(`the popup says "Folded · ${total} of 500" on Free`, !!label, JSON.stringify(await popupFoldedLabel(popup)));
const popupGroups = await popup.evaluate(() => [...document.querySelectorAll('[role=group][aria-label]')].map((g) => g.getAttribute('aria-label').split(',')[0]));
check('the popup lists the folders first', popupGroups.slice(0, 3).join('|') === 'Client work|Recipes|Travel' && popupGroups.length > 3, JSON.stringify(popupGroups));
await shot(popup, 'popup-folders.png');
await popup.close().catch(() => undefined);
await focusUi();

// ---------------------------------------------------------------------------------------------
// 12. Live folders and sharing are Pro: on Free they lead to the plans page
await groupMenu('Recipes');
check('"Open as a live group" is marked Pro', /Open as a live group\s*Pro/.test(await ui.evaluate(() => [...document.querySelectorAll('[role=menu]')].at(-1)?.innerText ?? '')));
await menuItem(ui, 'Open as a live group');
check('"Open as a live group" on Free opens the plans page', !!(await until(() => ui.evaluate(() => location.hash === '#/pro'), 3000)));
check('…and opens no tab group', (await control.evaluate(() => chrome.tabGroups.query({}))).length === 0);
await go('#/');
await groupMenu('Recipes');
await menuItem(ui, 'Share…');
check('"Share…" on Free opens the plans page', !!(await until(() => ui.evaluate(() => location.hash === '#/pro'), 3000)));
await go('#/');
response = await send({ type: 'live-open', folderId: recipes.id });
check('the worker refuses live folders on Free (needs-pro)', response && !response.ok && response.code === 'needs-pro', JSON.stringify(response));
response = await send({ type: 'share-create', folderId: recipes.id, live: false });
check('the worker refuses sharing on Free (needs-pro)', response && !response.ok && response.code === 'needs-pro', JSON.stringify(response));

// ---------------------------------------------------------------------------------------------
// 11. Ctrl+K palette
await focusUi();
await noDialog(ui);
await ui.evaluate(() => document.activeElement?.blur());
await press(ui, 'k', { ctrl: true });
const paletteInput = () =>
  ui.evaluate(() => {
    const input = document.querySelector('dialog[open] input[role=combobox]');
    return input ? { placeholder: input.placeholder, focused: document.activeElement === input } : null;
  });
const palette = await until(paletteInput, 3000);
check('Ctrl+K opens the palette ("Folders, actions, folded tabs")', palette?.placeholder === 'Folders, actions, folded tabs' && palette.focused, JSON.stringify(palette));
const options = () => ui.evaluate(() => [...document.querySelectorAll('dialog[open] [role=option]')].map((o) => o.querySelector('span[dir=auto]')?.textContent.trim()));
check('it lists the folders ("· open all" on Free) and the actions', !!(await until(async () => {
  const o = await options();
  return o.includes('Recipes · open all') && o.includes('Find duplicates') && o.includes('Make room') && o.includes('Import…');
}, 3000)), JSON.stringify(await options()));
await typeText(ui, 'trav');
check('typing filters to the matching folder', !!(await until(async () => {
  const o = await options();
  return o[0] === 'Travel · open all' && !o.includes('Recipes · open all') && !o.includes('Find duplicates');
}, 3000)), JSON.stringify(await options()));
await ui.evaluate(() => {
  const input = document.querySelector('dialog[open] input[role=combobox]');
  input.select();
});
await typeText(ui, 'garden');
check('…and to folded tabs', !!(await until(async () => (await options()).some((o) => o.includes('Garden tools') || o.includes('Seeds catalogue')), 5000)), JSON.stringify(await options()));
await shot(ui, 'palette.png');
await press(ui, 'Escape');
check('Esc closes the palette', !!(await noDialog(ui, 3000)));
await press(ui, 'k', { ctrl: true });
await until(paletteInput, 3000);
await typeText(ui, 'duplicates');
await until(async () => (await options())[0] === 'Find duplicates', 3000);
await press(ui, 'Enter');
check('Enter on "Find duplicates" opens Same page twice', await dialogHas(ui, 'Same page twice', 4000));
check('…which finds none yet', await dialogHas(ui, 'No page is saved twice', 4000));
await press(ui, 'Escape');
await noDialog(ui);
// Enter on a folder: on Free it opens all its tabs (a copy) as a Chrome tab group
await press(ui, 'k', { ctrl: true });
await until(paletteInput, 3000);
await typeText(ui, 'recipes');
await until(async () => (await options())[0] === 'Recipes · open all', 3000);
await press(ui, 'Enter');
const group = await until(async () => {
  const groups = await control.evaluate(() => chrome.tabGroups.query({}));
  const g = groups.find((x) => x.title === 'Recipes');
  if (!g) return null;
  const inside = (await chromeTabs()).filter((t) => t.groupId === g.id);
  return inside.length ? { g, inside } : null;
}, 6000);
check('Enter on "Recipes · open all" opens its tab as a "Recipes" tab group', !!group && group.inside.some((t) => t.url === site(3, 'recipes')), JSON.stringify(group?.inside.map((t) => t.url)));
check('…and the tab stays in the folder', (await tabTitled('Weeknight recipes'))?.folderId === recipes.id);
if (group) await control.evaluate((ids) => chrome.tabs.remove(ids), group.inside.map((t) => t.id));
await focusUi();

// ---------------------------------------------------------------------------------------------
// 7. Snooze
await rowMenu('Blog – Acme', 'Other');
await submenu(ui, 'Snooze');
const snoozeMenu = await ui.evaluate(() => [...document.querySelectorAll('[role=menu]')].at(-1)?.innerText ?? '');
check('Snooze › lists the times', ['Tomorrow morning', 'Next week', 'In a month', 'Pick a date and time…'].every((t) => snoozeMenu.includes(t)), snoozeMenu.replace(/\n/g, ' | '));
await shot(ui, 'menu-snooze.png');
await menuItem(ui, 'Next week');
const snoozed1 = await until(async () => (await tabTitled('Blog – Acme'))?.snoozeUntil);
check('Snooze › Next week snoozes the tab until next Monday 9:00', !!snoozed1 && new Date(snoozed1).getDay() === 1 && new Date(snoozed1).getHours() === 9, snoozed1 && new Date(snoozed1).toString());
check('toast: "Snoozed 1 tab until …" with Undo', await has(ui, 'Snoozed 1 tab until', 3000));
check('the Snoozed section shows it: "1 tab · come back on their own", Wake now', (await has(ui, '1 tab · come back on their own', 3000)) && (await has(ui, 'Wake now', 1000)));
check('the left column has "Snoozed"', (await sideItem('Snoozed'))?.count === 1, JSON.stringify(await sideItem('Snoozed')));
await rowMenu('Careers – Acme', 'Other');
await submenu(ui, 'Snooze');
await menuItem(ui, 'Tomorrow morning');
await until(async () => (await tabTitled('Careers – Acme'))?.snoozeUntil);
// The same menu on a right-click
await groupRows('Other');
await clickAt(
  ui,
  (t) => {
    const open = [...document.querySelectorAll('.tf-row [aria-label^="Open "]')].find((e) => e.getAttribute('aria-label') === `Open ${t} (stays in the list)`);
    if (!open) return null;
    open.scrollIntoView({ block: 'center' });
    const r = open.getBoundingClientRect();
    return { x: r.x + 60, y: r.y + r.height / 2 };
  },
  'Mobile Auto Repair',
  'right',
);
check('right-clicking a row opens the same menu', !!(await until(async () => (await menus(ui)) > 0, 3000)) && (await ui.evaluate(() => document.querySelector('[role=menu]')?.getAttribute('aria-label'))) === 'More for Mobile Auto Repair');
await submenu(ui, 'Snooze');
await menuItem(ui, 'Tomorrow morning');
await until(async () => (await tabTitled('Mobile Auto Repair'))?.snoozeUntil);
check('3 tabs snoozed', (await idb('tabs')).filter((t) => t.snoozeUntil).length === 3 && (await has(ui, '3 tabs · come back on their own', 3000)));
await rowMenu('Seeds catalogue', 'Social');
await submenu(ui, 'Snooze');
await menuItem(ui, 'Pick a date and time…');
check(
  'Snooze › Pick a date and time… asks "Snooze until…" (tomorrow 9:00 to start)',
  (await dialogHas(ui, 'Snooze until…', 3000)) && (await dialogText(ui)).includes('It reopens in the background tomorrow 9:00'),
);
await clickInDialog(ui, 'Snooze');
check('the 4th on Free shows "Free has 3 snoozed tabs at a time"', await dialogHas(ui, 'Free has 3 snoozed tabs at a time', 3000));
check('…and doesn’t snooze it', !(await tabTitled('Seeds catalogue'))?.snoozeUntil);
await shot(ui, 'snooze-limit.png');
await clickInDialog(ui, 'See snoozed tabs');
await noDialog(ui);
response = await send({ type: 'snooze', until: Date.now() + DAY, tabRecordIds: [(await tabTitled('Seeds catalogue')).id] });
check('the worker refuses a 4th snooze on Free (snooze-limit)', response && !response.ok && response.code === 'snooze-limit', JSON.stringify(response));
await shot(ui, 'snoozed.png');

// Wake now
const blogUrl = site(1, 'acme-blog');
const woke = await ui.evaluate(() => {
  const row = [...document.querySelectorAll('[role=listitem]')].find((r) => r.querySelector('[aria-label="Open Blog – Acme (stays snoozed)"]'));
  const button = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === 'Wake now');
  button?.click();
  return !!button;
});
check('Wake now reopens the tab in Chrome', woke && !!(await until(async () => (await chromeTabs()).some((t) => t.url === blogUrl), 6000)));
check('…and takes it out of the list', !!(await until(async () => !(await tabTitled('Blog – Acme')), 4000)));
check('toast: "Opened 1 tab in the background"', await has(ui, 'Opened 1 tab in the background', 3000));
check('the Snoozed section has 2 left', await has(ui, '2 tabs · come back on their own', 3000));

// Snoozing an OPEN tab folds and closes it: from the popup's search ("Snooze this tab"), …
const readLater = site(3, 'read-later');
const w5 = await newWindow([readLater]);
await titlesLoaded([readLater]);
const tabPopup = await openPopupIn(w5);
await tabPopup.evaluate(() => document.querySelector('input[type=search]')?.focus());
await typeText(tabPopup, 'snooze');
check('the popup’s search offers "Snooze this tab" for the tab you’re on', await has(tabPopup, 'Snooze this tab', 4000));
await click(tabPopup, 'Snooze this tab');
await has(tabPopup, 'Tomorrow morning', 2000);
await click(tabPopup, 'Tomorrow morning');
check('…which folds it, snoozed', !!(await until(async () => (await tabTitled('Read later article'))?.snoozeUntil, 4000)));
check('…and closes it', !!(await until(async () => !(await chromeTabs()).some((t) => t.url === readLater), 4000)));
await tabPopup.close().catch(() => undefined);
await focusUi();
await ui.evaluate(() => {
  const row = [...document.querySelectorAll('[role=listitem]')].find((r) => r.querySelector('[aria-label="Open Read later article (stays snoozed)"]'));
  [...(row?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === 'Wake now')?.click();
});
await until(async () => (await chromeTabs()).some((t) => t.url === readLater) && !(await tabTitled('Read later article')), 6000);

// …or from the page's right-click "Snooze this tab" (and Alt+Shift+Z), which snooze the tab by its
// id like the `snooze` command. It comes back by itself when its time comes, and the popup says so.
const openTab = (await chromeTabs()).find((t) => t.url === readLater);
response = await send({ type: 'snooze', until: Date.now() + 6000, tabIds: [openTab.id] });
check('snoozing an open tab folds it…', response?.ok && response.data.snoozed === 1 && !!(await until(async () => (await tabTitled('Read later article'))?.snoozeUntil, 3000)), JSON.stringify(response));
check('…and closes it', !!(await until(async () => !(await chromeTabs()).some((t) => t.url === readLater), 4000)));
const cameBack = await until(async () => (await chromeTabs()).some((t) => t.url === readLater) && !(await tabTitled('Read later article')), 20_000, 400);
check('when its time comes, it reopens and leaves the list', !!cameBack);
const back = await local('snoozeBack');
check('…and the toolbar counts it', back?.tabRecordIds?.length === 1, JSON.stringify(back?.tabRecordIds?.length));
popup = await openPopup();
check('the popup says "1 tab came back from snooze"', await has(popup, '1 tab came back from snooze', 4000));
await shot(popup, 'popup-snooze-back.png');
check('…once: seeing it clears it', !!(await until(async () => !(await local('snoozeBack')), 4000)));
await popup.close().catch(() => undefined);
await focusUi();

// ---------------------------------------------------------------------------------------------
// 8. Fold automatically
await go('#/settings');
check('Settings has "Fold automatically"', await has(ui, 'Fold automatically', 5000));
await ui.evaluate(() => document.getElementById('auto-h')?.scrollIntoView({ block: 'start' }));
await click(ui, 'Add a rule', 'dialog[open] button');
check('"Add a rule" opens "New rule" (When, Which, Into)', (await dialogHas(ui, 'New rule', 3000)) && /When[\s\S]*Which[\s\S]*Into/.test(await dialogText(ui)));
check('Free can save the "not looked at" rule ("Save rule")', (await dialogText(ui)).includes('Save rule'));
await clickInDialog(ui, 'Save rule');
let rules = await until(async () => {
  const s = await local('settings');
  return s?.autoFold?.length === 1 ? s.autoFold : null;
});
check('the rule is saved and on: tabs not looked at for 3 days, into their kind of site', rules?.[0]?.enabled && rules[0].when.type === 'idle' && rules[0].when.days === 3 && rules[0].into.type === 'site', JSON.stringify(rules));
check('Settings shows "Tabs I haven’t looked at for 3 days"', await has(ui, 'Tabs I haven’t looked at for 3 days', 3000));
await click(ui, 'Add a rule', 'dialog[open] button');
await dialogHas(ui, 'New rule', 3000);
await choose(ui, '7');
await clickInDialog(ui, 'Save rule');
rules = await until(async () => {
  const s = await local('settings');
  return s?.autoFold?.length === 2 ? s.autoFold : null;
});
check('a second rule is saved switched off (Free runs one)', !!rules && rules[1].enabled === false && rules[1].when.days === 7, JSON.stringify(rules?.map((r) => r.enabled)));
check('toast: "Saved, switched off: Free runs one rule at a time."', await has(ui, 'Saved, switched off: Free runs one rule at a time.', 3000));
await click(ui, 'Add a rule', 'dialog[open] button');
await dialogHas(ui, 'New rule', 3000);
const timeOption = await choose(ui, 'time');
check('"Every day at (Pro)" shows "Upgrade to save"', timeOption === 'Every day at (Pro)' && (await dialogHas(ui, 'Upgrade to save', 2000)), JSON.stringify(timeOption));
check('…and says what Free has', (await dialogText(ui)).includes('Free has one rule'));
await choose(ui, 'idle');
check('back to "Not looked at for", it can be saved again', await dialogHas(ui, 'Save rule', 2000));
const intoPro = await choose(ui, recipes.id);
check('"Into" a folder is Pro: "Recipes (Pro)", "Upgrade to save"', intoPro === 'Recipes (Pro)' && (await dialogHas(ui, 'Upgrade to save', 2000)), JSON.stringify(intoPro));
await shot(ui, 'rule-upgrade.png');
await clickInDialog(ui, 'Upgrade to save');
check('"Upgrade to save" opens the plans page and saves nothing', !!(await until(() => ui.evaluate(() => location.hash === '#/pro'), 3000)) && (await local('settings')).autoFold.length === 2);
const alarm = await control.evaluate(() => chrome.alarms.get('tabfold-autofold'));
check('the rules run every 5 minutes (an alarm)', alarm?.periodInMinutes === 5, JSON.stringify(alarm));

// Make the rule fire now: tabs open for a second count as "not looked at" once the rule says 1 second
for (const t of (await chromeTabs()).filter((x) => x.url?.startsWith('http'))) await control.evaluate((id) => chrome.tabs.remove(id), t.id);
const idleUrls = [site(3, 'idle-one'), site(3, 'idle-two')];
await newWindow(idleUrls);
await titlesLoaded(idleUrls);
const ruleId = rules[0].id;
await control.evaluate((id) =>
  chrome.storage.local.get('settings').then((r) =>
    chrome.storage.local.set({ settings: { ...r.settings, autoFold: r.settings.autoFold.map((x) => (x.id === id ? { ...x, when: { type: 'idle', days: 1 / 86400 } } : x)) } }),
  ),
ruleId);
await sleep(2500);
response = await send({ type: 'autofold-run', ruleId });
check('the rule folds the tabs not looked at (autofold-run)', response?.ok && response.data.folded === 2, JSON.stringify(response));
check('…closing them', !!(await until(async () => !(await chromeTabs()).some((t) => idleUrls.includes(t.url)), 4000)));
check('…into the list by their kind of site', !!(await tabTitled('Idle page one')) && !(await tabTitled('Idle page one')).folderId);
const notice = await local('autoFoldNotice');
check('the worker leaves the "Folded 2 tabs" notice', notice?.folded === 2 && notice.ruleId === ruleId, JSON.stringify(notice && { folded: notice.folded }));
await go('#/');
check('the full list says "Folded 2 tabs at …"', await has(ui, 'Folded 2 tabs at', 5000));
popup = await openPopup();
check('the popup says "Folded 2 tabs at …" too', await has(popup, 'Folded 2 tabs at', 4000));
const dismissedLine = await popup.evaluate(() => {
  const line = [...document.querySelectorAll('[role=status]')].find((d) => d.textContent.startsWith('Folded 2 tabs at'));
  const button = line?.querySelector('[aria-label="Dismiss"]');
  button?.click();
  return !!button;
});
check('…and × there puts the notice away', dismissedLine && !!(await until(async () => !(await local('autoFoldNotice')), 3000)));
await popup.close().catch(() => undefined);
await focusUi();
await control.evaluate((id) =>
  chrome.storage.local.get('settings').then((r) =>
    chrome.storage.local.set({ settings: { ...r.settings, autoFold: r.settings.autoFold.map((x) => (x.id === id ? { ...x, when: { type: 'idle', days: 3 } } : x)) } }),
  ),
ruleId);
await go('#/settings');
check('Settings says when the rule last ran and what it folded', await has(ui, 'folded 2 tabs', 4000));
await ui.evaluate(() => document.getElementById('auto-h')?.scrollIntoView({ block: 'start' }));
await shot(ui, 'settings-fold-automatically.png');

// ---------------------------------------------------------------------------------------------
// 9. Same page twice (Settings › Find duplicates): the newest copy stays, with its folder
const travelNow = await folderNamed('Travel');
await seed([
  {
    id: 'e2edups',
    name: 'Copies',
    createdAt: t0 - 3 * HOUR,
    tabs: [
      { url: 'https://docs.example.org/setup', title: 'Setup guide', savedAt: t0 - 3 * HOUR, folderId: travelNow.id },
      { url: 'https://docs.example.org/setup', title: 'Setup guide', savedAt: t0 - 2 * HOUR },
      { url: 'https://docs.example.org/setup', title: 'Setup guide', savedAt: t0 - HOUR },
      { url: 'https://blog.example.net/release-notes', title: 'Release notes', savedAt: t0 - 2 * HOUR },
      { url: 'https://blog.example.net/release-notes', title: 'Release notes', savedAt: t0 - 30 * 60_000, folderId: recipes.id },
    ],
  },
]);
await reloadUi();
await go('#/settings');
await has(ui, 'Find duplicates', 5000);
await click(ui, 'Find duplicates', 'dialog[open] button');
check('Find duplicates lists the copies ("3 copies", "2 copies")', (await dialogHas(ui, '3 copies', 4000)) && (await dialogText(ui)).includes('2 copies'));
await shot(ui, 'duplicates.png');
check('…offering "Remove 3 copies"', await clickInDialog(ui, 'Remove 3 copies'));
const dupsLeft = await until(async () => {
  const tabs = await idb('tabs');
  const setup = tabs.filter((t) => t.url === 'https://docs.example.org/setup');
  const notes = tabs.filter((t) => t.url === 'https://blog.example.net/release-notes');
  return setup.length === 1 && notes.length === 1 ? { setup: setup[0], notes: notes[0] } : null;
}, 5000);
check('one copy of each page is left', !!dupsLeft);
check('the newest copy stays', dupsLeft?.setup.savedAt === t0 - HOUR && dupsLeft?.notes.savedAt === t0 - 30 * 60_000);
check('…with its folder (Recipes), or the folder an older copy was in (Travel)', dupsLeft?.notes.folderId === recipes.id && dupsLeft?.setup.folderId === travelNow.id, JSON.stringify(dupsLeft && [dupsLeft.setup.folderId, dupsLeft.notes.folderId]));
check('toast: "Removed 3 copies. The newest of each stays."', await has(ui, 'Removed 3 copies. The newest of each stays.', 3000));
await go('#/');
await noDialog(ui);

// ---------------------------------------------------------------------------------------------
// 10. Imports: OneTab text, a Toby JSON file, a Session Buddy JSON file, a list of links
// Room for folders first: Free has 3, so two go (as a person would make room).
for (const name of ['Recipes', 'Travel']) await send({ type: 'folder-delete', id: (await folderNamed(name)).id });
/** A source on the import dialog's first step ("OneTab", "Toby"…). */
const chooseSource = (name) =>
  ui.evaluate((n) => {
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    const button = [...(dialog?.querySelectorAll('button') ?? [])].find((b) => b.innerText.split('\n').map((l) => l.trim()).includes(n));
    button?.click();
    return !!button;
  }, name);
const importedTabs = async (urls) => (await idb('tabs')).filter((t) => urls.includes(t.url));
async function importResult() {
  const text = await until(async () => {
    const t = await dialogText(ui);
    return /Imported \d/.test(t) ? t : null;
  }, 10_000);
  return text ?? (await dialogText(ui));
}
async function finishImport() {
  await clickInDialog(ui, 'Done');
  await noDialog(ui);
  await sleep(300);
}

await go('#/settings');
await has(ui, 'Import…', 5000);
await click(ui, 'Import…', 'dialog[open] button');
await dialogHas(ui, 'Bring your tabs from…', 4000);
const sources = await dialogText(ui);
check(
  'Settings › Import… offers OneTab, Toby, Workona, Session Buddy, Chrome bookmarks, A list of links',
  ['Bring your tabs from…', 'OneTab', 'Toby', 'Workona', 'Session Buddy', 'Chrome bookmarks', 'A list of links'].every((s) => sources.includes(s)),
  sources.replace(/\n/g, ' | '),
);
await shot(ui, 'import-sources.png');
await chooseSource('OneTab');
await dialogHas(ui, 'From OneTab', 3000);
const ONETAB = [
  'https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API | IndexedDB API - Web APIs | MDN',
  'https://web.dev/articles/indexeddb | Work with IndexedDB | web.dev',
  '',
  'https://www.theverge.com/tech | Tech - The Verge',
  'https://en.wikipedia.org/wiki/Tab_(interface) | Tab (interface) - Wikipedia',
].join('\n');
await ui.evaluate(() => [...document.querySelectorAll('dialog[open]')].at(-1).querySelector('textarea')?.focus());
await typeText(ui, ONETAB);
await clickInDialog(ui, 'Import');
let result = await importResult();
check('OneTab: "Imported 4 tabs"', result.includes('Imported 4 tabs') && !result.includes('into'), result.replace(/\n/g, ' | '));
const onetabTabs = await importedTabs(['https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API', 'https://web.dev/articles/indexeddb', 'https://www.theverge.com/tech', 'https://en.wikipedia.org/wiki/Tab_(interface)']);
check('…by site, no folders (OneTab groups have no names)', onetabTabs.length === 4 && onetabTabs.every((t) => !t.folderId) && onetabTabs.some((t) => t.title === 'Tab (interface) - Wikipedia'));
await finishImport();

const tobyFile = path.join(filesDir, 'toby.json');
writeFileSync(
  tobyFile,
  JSON.stringify({
    version: 3,
    lists: [
      {
        title: 'Reading list',
        cards: [
          { title: 'How to Do Great Work', url: 'https://paulgraham.com/greatwork.html', customTitle: '', customDescription: '' },
          { title: 'The Pragmatic Engineer', url: 'https://blog.pragmaticengineer.com/', customTitle: 'Pragmatic Engineer newsletter', customDescription: '' },
          { title: 'A bookmarklet', url: 'javascript:void(0)', customTitle: '', customDescription: '' },
        ],
        labels: [],
      },
      { title: 'Empty list', cards: [], labels: [] },
    ],
  }),
);
await go('#/import');
await dialogHas(ui, 'Bring your tabs from…', 4000);
await chooseSource('Toby');
await dialogHas(ui, 'Choose the file…', 3000);
await chooseFile(ui, 'dialog[open] input[type=file]', tobyFile);
result = await importResult();
check('Toby JSON: "Imported 2 tabs into 1 folder"', result.includes('Imported 2 tabs into 1 folder'), result.replace(/\n/g, ' | '));
check('…the bookmarklet skipped', result.includes('1 entry'), result.replace(/\n/g, ' | '));
const readingList = await folderNamed('Reading list');
const tobyTabs = await importedTabs(['https://paulgraham.com/greatwork.html', 'https://blog.pragmaticengineer.com/']);
check('…the list became a folder with its tabs (custom titles kept)', readingList?.source === 'import' && tobyTabs.length === 2 && tobyTabs.every((t) => t.folderId === readingList.id) && tobyTabs.some((t) => t.title === 'Pragmatic Engineer newsletter'), JSON.stringify(tobyTabs.map((t) => t.title)));
await shot(ui, 'import-toby.png');
await finishImport();

const buddyFile = path.join(filesDir, 'session-buddy.json');
writeFileSync(
  buddyFile,
  JSON.stringify({
    collections: [
      {
        title: 'Research',
        created: t0 - 10 * DAY,
        windows: [
          {
            tabs: [
              { url: 'https://arxiv.org/abs/1706.03762', title: 'Attention Is All You Need', pinned: false },
              { url: 'https://distill.pub/2016/augmented-rnns/', title: 'Attention and Augmented Recurrent Neural Networks' },
            ],
          },
        ],
      },
      {
        title: 'Trip planning',
        created: t0 - 5 * DAY,
        windows: [
          {
            tabs: [
              { url: 'https://www.visitportugal.com/en', title: 'Visit Portugal' },
              { url: 'https://www.cp.pt/passageiros/en', title: 'CP - Comboios de Portugal' },
            ],
          },
        ],
      },
    ],
  }),
);
await go('#/import');
await dialogHas(ui, 'Bring your tabs from…', 4000);
await chooseSource('Session Buddy');
await dialogHas(ui, 'Choose the file…', 3000);
await chooseFile(ui, 'dialog[open] input[type=file]', buddyFile);
result = await importResult();
check('Session Buddy JSON: "Imported 4 tabs into 1 folder"', result.includes('Imported 4 tabs into 1 folder'), result.replace(/\n/g, ' | '));
check('…"1 collection went by site (Free has 3 folders)"', result.includes('1 collection went by site (Free has 3 folders)'));
const research = await folderNamed('Research');
const researchTabs = await importedTabs(['https://arxiv.org/abs/1706.03762', 'https://distill.pub/2016/augmented-rnns/']);
const tripTabs = await importedTabs(['https://www.visitportugal.com/en', 'https://www.cp.pt/passageiros/en']);
check('…"Research" became the 3rd folder, "Trip planning" went by site', !!research && researchTabs.every((t) => t.folderId === research.id) && tripTabs.length === 2 && tripTabs.every((t) => !t.folderId) && !(await folderNamed('Trip planning')) && (await liveFolders()).length === 3);
await shot(ui, 'import-session-buddy.png');
await finishImport();

await go('#/import');
await dialogHas(ui, 'Bring your tabs from…', 4000);
await chooseSource('A list of links');
await dialogHas(ui, 'From a list of links', 3000);
await ui.evaluate(() => [...document.querySelectorAll('dialog[open]')].at(-1).querySelector('textarea')?.focus());
await typeText(ui, ['## Frontend', 'https://react.dev/learn Quick Start – React', '- [Vite guide](https://vite.dev/guide/)', 'https://tailwindcss.com/docs/installation', 'not a link'].join('\n'));
await clickInDialog(ui, 'Import');
result = await importResult();
check('a list of links: "Imported 3 tabs"', result.includes('Imported 3 tabs') && !result.includes('into'), result.replace(/\n/g, ' | '));
const linkTabs = await importedTabs(['https://react.dev/learn', 'https://vite.dev/guide/', 'https://tailwindcss.com/docs/installation']);
check('…with their titles, by site, the line without a link skipped', linkTabs.length === 3 && linkTabs.every((t) => !t.folderId) && linkTabs.some((t) => t.title === 'Vite guide') && result.includes('1 entry'), JSON.stringify(linkTabs.map((t) => t.title)));
await finishImport();

// Chrome bookmarks asks Chrome for the bookmarks permission when picked. Headless Chrome never
// answers that prompt (the request stays pending), so that import isn't driven here; Tabfold holds
// no bookmarks permission until it asks.
check(
  'Tabfold doesn’t hold the bookmarks permission until Chrome bookmarks asks for it',
  !(await control.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))),
);

// ---------------------------------------------------------------------------------------------
// 6. The free list's 500 tabs
await quietFolds();
const count = await foldedCount();
const ARCHIVE_AGES = [150, 120, 90, 70];
const toSeed = 495 - count;
const sizes = [100, 100, 100, toSeed - 300];
await seed(
  sizes.map((size, n) => ({
    id: `e2earchive${n}`,
    name: 'Archive',
    createdAt: t0 - ARCHIVE_AGES[n] * DAY,
    tabs: Array.from({ length: size }, (_, i) => ({ url: `https://archive.example.com/${n}/${i}`, title: `Archived page ${n}-${i}` })),
  })),
);
check('495 tabs folded (seeded)', (await foldedCount()) === 495, String(await foldedCount()));
await reloadUi();
const heading = await ui.evaluate(() => {
  const h1 = [...document.querySelectorAll('h1')].find((h) => h.textContent === 'Folded');
  const count = h1?.nextElementSibling?.querySelector('.tabular-nums');
  return count ? { text: count.textContent, amber: count.classList.contains('text-amber') } : null;
});
check('the heading says "495 of 500 tabs", in amber', heading?.text === '495 of 500 tabs' && heading.amber, JSON.stringify(heading));

const W4 = Array.from({ length: 10 }, (_, i) => site(i % 4, `fold-${i + 1}`));
const w4 = await newWindow(W4);
await titlesLoaded(W4);
popup = await openPopup();
check('the popup says "5 spaces left in your free list"', await has(popup, '5 spaces left in your free list', 5000));
const nearLabel = await popupFoldedLabel(popup);
check('…and "Folded · 495 of 500" in amber', nearLabel?.text.includes('495 of 500') && nearLabel.amber, JSON.stringify(nearLabel));
await shot(popup, 'popup-near.png');
await popup.close().catch(() => undefined);

await seed([{ id: 'e2elater', name: 'Later', createdAt: t0 - DAY, tabs: Array.from({ length: 5 }, (_, i) => ({ url: `https://later.example.com/${i}`, title: `Later page ${i}` })) }]);
await reloadUi();
check('at 500: "Your free list is full: 500 of 500 tabs"', await has(ui, 'Your free list is full: 500 of 500 tabs', 5000));
check('…with "Make room" and "Upgrade"', await ui.evaluate(() => {
  const banner = [...document.querySelectorAll('[role=status]')].find((d) => d.textContent.includes('Your free list is full'));
  const labels = [...(banner?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim());
  return labels.includes('Make room') && labels.includes('Upgrade');
}));
await shot(ui, 'list-full.png');
popup = await openPopup();
check('the popup shows "Your free list is full" with Upgrade and Make room', (await has(popup, 'Your free list is full', 5000)) && (await has(popup, 'Make room', 1000)));
check('…and Fold is paused', await popup.evaluate(() => !![...document.querySelectorAll('button')].find((b) => b.innerText.includes('Fold tabs') && b.disabled)));
await shot(popup, 'popup-full.png');
await popup.evaluate(() => {
  const card = [...document.querySelectorAll('section[role=status]')].find((d) => d.textContent.includes('Your free list is full'));
  [...(card?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Make room')?.click();
});
const roomTab = await until(async () => (await chromeTabs()).find((t) => t.url?.startsWith(ext('library.html')) && t.url.endsWith('#/room')), 6000);
check('its "Make room" opens Make room in the full list (#/room)', !!roomTab, roomTab?.url);
await popup.close().catch(() => undefined);
for (const p of [control, ui]) await p.evaluate(() => location.hash === '#/room' && (location.hash = '#/')).catch(() => undefined);
await noDialog(ui);
await focusUi();

// Make room: the oldest folds first; remove the 5 newest to get back under the limit
await go('#/room');
check('Make room (#/room) opens: "500 of 500 tabs", "No room yet"', (await dialogHas(ui, 'Make room', 4000)) && (await dialogHas(ui, '500 of 500 tabs', 4000)) && (await dialogText(ui)).includes('No room yet'));
const roomRows = await ui.evaluate(() => [...document.querySelectorAll('dialog[open] [aria-label^="Remove the fold from"]')].map((b) => b.getAttribute('aria-label')));
check('…listing the folds oldest first', roomRows.length >= 5 && roomRows[0].endsWith('100 tabs'), JSON.stringify(roomRows.slice(0, 3)));
await shot(ui, 'make-room.png');
await ui.evaluate(() => [...document.querySelectorAll('dialog[open] [aria-label^="Remove the fold from"]')].find((b) => b.getAttribute('aria-label').endsWith(', 5 tabs'))?.click());
check('removing the 5-tab fold makes "Room for 5 more"', (await dialogHas(ui, 'Room for 5 more', 4000)) && (await foldedCount()) === 495);
await clickInDialog(ui, 'Done');
await noDialog(ui);

// A fold that doesn't fit: refused, nothing closed
response = await send({ type: 'fold', windowId: w4 });
check('folding 10 tabs with room for 5 is refused (list-full)', response && !response.ok && response.code === 'list-full' && response.details?.needed === 10 && response.details?.room === 5, JSON.stringify(response));
await sleep(800);
const stillOpen = (await chromeTabs()).filter((t) => W4.includes(t.url));
check('…and nothing is closed or saved', stillOpen.length === 10 && (await foldedCount()) === 495, `${stillOpen.length} open, ${await foldedCount()} folded`);
popup = await openPopup();
check('the popup says "This fold needs room for 10 tabs"', await has(popup, 'This fold needs room for 10 tabs', 5000));
check('…"Your free list has room for 5. Make room, or upgrade for unlimited."', await has(popup, 'Your free list has room for 5. Make room, or upgrade for unlimited.', 1000));
await shot(popup, 'popup-needs-room.png');
await popup.close().catch(() => undefined);
await reloadUi();
check('the full list says "This fold needs room for 10 tabs" too', await has(ui, 'This fold needs room for 10 tabs', 5000));
await shot(ui, 'list-needs-room.png');

// Make room: remove a fold, Undo, remove again; then the fold fits
await go('#/room');
await dialogHas(ui, '495 of 500 tabs', 4000);
const removeOldest = () =>
  ui.evaluate(() => {
    const button = document.querySelector('dialog[open] [aria-label^="Remove the fold from"]');
    button?.click();
    return button?.getAttribute('aria-label') ?? null;
  });
const removed = await removeOldest();
check('Make room › Remove takes the oldest fold out', !!removed && (await dialogHas(ui, 'Removed ·', 4000)) && (await until(async () => (await foldedCount()) === 395, 4000)), `${removed}: ${await foldedCount()}`);
check('…"Room for 105 more"', await dialogHas(ui, 'Room for 105 more', 3000));
await ui.evaluate(() => {
  const tag = [...document.querySelectorAll('dialog[open] [role=status]')].find((s) => s.textContent.startsWith('Removed'));
  [...(tag?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Undo')?.click();
});
check('Undo puts it back', !!(await until(async () => (await foldedCount()) === 495, 4000)) && (await dialogHas(ui, 'Room for 5 more', 3000)));
const removedAgain = await removeOldest();
check('Remove again', !!removedAgain && !!(await until(async () => (await foldedCount()) === 395, 4000)));
await clickInDialog(ui, 'Done');
await noDialog(ui);
response = await send({ type: 'fold', windowId: w4 });
check('then the fold works', response?.ok && response.data.savedTabs === 10, JSON.stringify(response?.data?.savedTabs ?? response));
check('…closing the 10 tabs', !!(await until(async () => !(await chromeTabs()).some((t) => W4.includes(t.url)), 6000)) && (await foldedCount()) === 405);
check('the full list says "Folded 10 tabs"', await has(ui, 'Folded 10 tabs', 5000));
check(
  '…and stops saying "This fold needs room for 10 tabs" (it fitted)',
  await lacks(ui, 'This fold needs room for 10 tabs', 5000),
  (await textOf(ui)).includes('This fold needs room') ? 'the card from the refused fold is still there' : '',
);

// An import stops at the limit and says what was left out
await go('#/import');
await dialogHas(ui, 'Bring your tabs from…', 4000);
await chooseSource('A list of links');
await dialogHas(ui, 'From a list of links', 3000);
await ui.evaluate(() => [...document.querySelectorAll('dialog[open]')].at(-1).querySelector('textarea')?.focus());
await typeText(ui, Array.from({ length: 100 }, (_, i) => `https://links.example.org/page-${i + 1} Saved link ${i + 1}`).join('\n'));
await clickInDialog(ui, 'Import');
result = await importResult();
check('importing 100 links with room for 95: "Imported 95 tabs" · "5 left out (free list full)"', result.includes('Imported 95 tabs') && result.includes('5 left out (free list full)'), result.replace(/\n/g, ' | '));
check('…the list is at 500', (await foldedCount()) === 500, String(await foldedCount()));
await shot(ui, 'import-left-out.png');
await finishImport();

// Snoozing an open tab needs room too: refused, the tab stays open
const oneMore = site(3, 'one-more');
await newWindow([oneMore]);
await titlesLoaded([oneMore]);
response = await send({ type: 'snooze', until: Date.now() + DAY, tabIds: [(await chromeTabs()).find((t) => t.url === oneMore).id] });
check('with the list full, snoozing an open tab is refused (list-full)', response && !response.ok && response.code === 'list-full', JSON.stringify(response));
await sleep(500);
check('…and the tab stays open', (await chromeTabs()).some((t) => t.url === oneMore) && (await foldedCount()) === 500);

// ---------------------------------------------------------------------------------------------
// 13. No errors in extension pages. A refused command (a Free limit, a Pro feature) is logged by the
// worker as "command failed <code>"; those are expected here, anything else is not.
const EXPECTED_REFUSALS = /^\[tabfold\] command failed \S+ (folder-limit|snooze-limit|list-full|needs-pro)$/;
const pageErrors = pages.flatMap((p) => p.errors);
const workerErrors = (worker?.errors ?? []).filter((e) => !EXPECTED_REFUSALS.test(e));
check('no errors in extension pages', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
check(
  'no unexpected errors in the worker',
  workerErrors.length === 0,
  workerErrors.length ? workerErrors.slice(0, 3).join(' | ') : `${(worker?.errors.length ?? 0) - workerErrors.length} expected refusals logged`,
);

await browser.close();
for (const server of servers) server.close();
rmSync(userDataDir, { recursive: true, force: true });
rmSync(filesDir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
