// End-to-end test of the Tabfold 1.0 features on the Free plan: the side panel, Fold into a folder,
// folding back a folder's tab group, Close the copies, Tidy into groups, window names, the window
// cap rule, starred folders and notes, the weekly summary, open tabs in search and Ctrl+K, and the
// 1.0 settings (the toolbar button, account deletion, the policy links). Real Chromium with the
// built extension and its worker; no worker reply is faked. The side panel (sidepanel.html opened
// as a tab), the popup and the full list are driven like a person would (clicks, keys, drag
// events) and the results are read from IndexedDB, chrome.storage, chrome.tabs and chrome.tabGroups.
// Worker commands are only used to set things up, and chrome.storage only where the UI can't be
// driven (Chrome's tab strip, last week's numbers).
// Run `npm run build` first (the default build has no server: Free only), then `npm run e2e:v10`.
// Screenshots go to e2e/screenshots/v10 (or $SHOTS_DIR/v10).
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome } from './cdp.mjs';

const EXT = path.resolve('.output/chrome-mv3');
const SHOTS = path.resolve(process.env.SHOTS_DIR ?? 'e2e/screenshots', 'v10');
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Ask `fn` until it answers something truthy (a page that is navigating or closing answers nothing). */
async function until(fn, timeout = 10_000, step = 150) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
    } catch {
      last = undefined;
    }
    if (last) return last;
    await sleep(step);
  }
  return last;
}

// ---------------------------------------------------------------------------------------------
// Pages. Four sites on this computer: 127.0.0.1 is "Dev" in Tabfold's built-in list, the other
// loopback addresses are "Other" (127.0.0.2 becomes "Mail & chat" for Tidy into groups).
const PAGES = {
  'acme-pricing': 'Pricing – Acme',
  'acme-careers': 'Careers – Acme',
  'garden-tools': 'Garden tools',
  'api-docs': 'API reference',
  'lisbon-flats': 'Holiday flats in Lisbon',
  'tram-map': 'Lisbon tram map',
  'side-news': 'Side project news',
  brief: 'Client brief',
  mockups: 'Homepage mockups',
  invoice: 'Invoice template',
  'style-guide': 'Brand style guide',
  scratch: 'Scratch page',
  paper: 'Attention paper notes',
  release: 'Release notes',
  recipes: 'Weeknight recipes',
  bread: 'Sourdough starter',
  status: 'Status page',
  kickoff: 'Kickoff agenda',
  compare: 'Compare plans',
  notes: 'Meeting notes',
  'dev-one': 'Build dashboard',
  'dev-two': 'Pull requests',
  'mail-one': 'Team inbox',
  'mail-two': 'Sent mail',
  'other-one': 'Weather today',
  timeline: 'Project timeline',
  'invoice-march': 'Invoice March',
  'long-read': 'Long read on cities',
  essay: 'Essay on attention',
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
const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tabfold-v10-'));
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

// A pinned Tabfold page for setup and for reading Chrome's and Tabfold's state.
const control = await open(ext('library.html'));
await pin(control);
const send = (command) => control.evaluate((c) => new Promise((res) => chrome.runtime.sendMessage({ __tabfold: true, command: c }, res)), command);
const local = (key) => control.evaluate((k) => chrome.storage.local.get(k).then((r) => r[k]), key);
const session = (key) => control.evaluate((k) => chrome.storage.session.get(k).then((r) => r[k]), key);
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
/** Folded tabs (in live folds) at this address. */
const recordsAt = async (url) => {
  const live = new Set((await idb('sessions')).filter((s) => !s.deletedAt).map((s) => s.id));
  return (await idb('tabs')).filter((t) => t.url === url && live.has(t.sessionId));
};
/** Folded tabs (in live folds) in a folder. */
const recordsIn = async (folderId) => {
  const live = new Set((await idb('sessions')).filter((s) => !s.deletedAt).map((s) => s.id));
  return (await idb('tabs')).filter((t) => t.folderId === folderId && live.has(t.sessionId));
};
const chromeTabs = () =>
  control.evaluate(() =>
    chrome.tabs.query({}).then((ts) => ts.map((t) => ({ id: t.id, url: t.url || t.pendingUrl, title: t.title, windowId: t.windowId, active: t.active, groupId: t.groupId }))),
  );
const tabsOf = (windowId) =>
  control.evaluate(
    (w) =>
      chrome.tabs
        .query({ windowId: w })
        .then((ts) => ts.sort((a, b) => a.index - b.index).map((t) => ({ id: t.id, url: t.url || t.pendingUrl, title: t.title, active: t.active, groupId: t.groupId, pinned: t.pinned }))),
    windowId,
  );
const tabActive = (id) => control.evaluate((t) => chrome.tabs.get(t).then((x) => x.active, () => false), id);
const activate = (id) => control.evaluate((t) => chrome.tabs.update(t, { active: true }).then(() => true), id);
const newWindow = (urls) => control.evaluate((u) => chrome.windows.create({ url: u, focused: false }).then((w) => w.id), urls);
const addTab = (windowId, url) => control.evaluate(([w, u]) => chrome.tabs.create({ windowId: w, url: u, active: false }).then((t) => t.id), [windowId, url]);
const windowOpen = (id) => control.evaluate((w) => chrome.windows.get(w).then(() => true, () => false), id);
const closeWindow = (id) => control.evaluate((w) => chrome.windows.remove(w).catch(() => undefined), id);
const groupsIn = (windowId) => control.evaluate((w) => chrome.tabGroups.query({ windowId: w }), windowId);
const titlesLoaded = (urls) =>
  until(async () => {
    const open = await chromeTabs();
    return urls.every((u) => open.some((t) => t.url === u && t.title && t.title !== u && !t.title.startsWith(new URL(u).host)));
  }, 15_000);

/** Open a Tabfold page as a tab in a window (so its "This window" is that window). */
async function openIn(windowId, url, size) {
  const before = new Set((await browser.targets()).map((t) => t.targetId));
  await control.evaluate(([w, u]) => chrome.tabs.create({ windowId: w, url: u, active: true }), [windowId, url]);
  const target = await until(async () => (await browser.targets()).find((t) => !before.has(t.targetId) && t.type === 'page' && t.url.startsWith(url.split('#')[0])), 8000);
  const page = await browser.attach(target.targetId, size);
  pages.push(page);
  await page.waitFor(() => document.readyState === 'complete', null, 8000);
  return page;
}
async function openPopupIn(windowId) {
  const popup = await openIn(windowId, ext('popup.html'), { width: 400, height: 600 });
  await popup.waitForText('Fold', 8000);
  await sleep(500);
  return popup;
}

/**
 * A window's name as Tabfold's pages show it to `page`: its given name, "This window" for the page's
 * own, else "Window N" by its place among the open windows.
 */
const windowNameIn = (page, windowId) =>
  page.evaluate(async (id) => {
    const [{ windowNames = {} }, me, all] = await Promise.all([
      chrome.storage.session.get('windowNames'),
      chrome.windows.getCurrent(),
      chrome.windows.getAll({ windowTypes: ['normal'] }),
    ]);
    if (windowNames[id]) return windowNames[id];
    if (id === me.id) return 'This window';
    const others = all.filter((w) => w.id !== me.id && !w.incognito);
    return `Window ${others.findIndex((w) => w.id === id) + 2}`;
  }, windowId);

// ---------------------------------------------------------------------------------------------
// Driving pages

const textOf = (p) => p.evaluate(() => document.body?.innerText ?? '').catch(() => '');
/** Case-insensitive (section labels are uppercased by CSS, which innerText reflects). */
const has = (p, text, timeout = 6000) => until(async () => (await textOf(p)).toLowerCase().includes(text.toLowerCase()), timeout);
const lacks = (p, text, timeout = 6000) => until(async () => !(await textOf(p)).toLowerCase().includes(text.toLowerCase()), timeout);
const front = async (p) => {
  await p.send('Page.bringToFront').catch(() => undefined);
  await sleep(250);
};
const shot = async (p, name) => {
  await front(p);
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
/** Click the element with this aria-label. */
const clickLabel = (p, label) =>
  p.evaluate((l) => {
    const el = [...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === l && !e.disabled);
    el?.click();
    return !!el;
  }, label);
const exists = (p, selector) => p.evaluate((s) => !!document.querySelector(s), selector);
/** The middle of the visible element with this aria-label, scrolled into view. */
const pointOf = (p, label) =>
  p.evaluate((l) => {
    const el = [...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === l && e.getBoundingClientRect().width > 0);
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, label);
async function mouseAt(p, point, clickIt = true) {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  if (!clickIt) return;
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}
/**
 * A real mouse click on the element with this aria-label. The pointer then moves to the page's
 * corner, so menus and results that open later don't open under it (their items take focus on hover).
 */
async function realClick(p, label) {
  const point = await pointOf(p, label);
  if (!point) return false;
  await mouseAt(p, point);
  // (The click may have closed the page: the popup closes itself after some of its buttons.)
  await mouseAt(p, { x: 1, y: 1 }, false).catch(() => undefined);
  return true;
}
const dialogText = (p) => p.evaluate(() => [...document.querySelectorAll('dialog[open]')].at(-1)?.innerText ?? '').catch(() => '');
const dialogHas = (p, text, timeout = 6000) => until(async () => (await dialogText(p)).includes(text), timeout);
const clickInDialog = (p, label) =>
  p.evaluate((l) => {
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    const el = [...(dialog?.querySelectorAll('button, a, [role=radio]') ?? [])].find((e) => (e.innerText ?? '').trim() === l && !e.disabled);
    el?.click();
    return !!el;
  }, label);
const noDialog = (p, timeout = 4000) => until(() => p.evaluate(() => !document.querySelector('dialog[open]')), timeout);
/** A menu item (in the newest open menu) by its aria-label or the first line of its text. */
const menuItem = (p, label) =>
  p.evaluate((l) => {
    const menu = [...document.querySelectorAll('[role=menu]')].at(-1);
    const el = [...(menu?.querySelectorAll('[role^=menuitem]') ?? [])].find(
      (e) => (e.getAttribute('aria-label') ?? (e.innerText ?? '').trim().split('\n')[0].trim()) === l && !e.disabled,
    );
    el?.click();
    return !!el;
  }, label);
const menus = (p) => p.evaluate(() => document.querySelectorAll('[role=menu]').length);
const menuText = (p) => p.evaluate(() => [...document.querySelectorAll('[role=menu]')].map((m) => m.innerText).join('\n')).catch(() => '');
/** The items of the newest menu: aria-label, or the first line of their text. */
const menuItems = (p) =>
  p.evaluate(() => {
    const menu = [...document.querySelectorAll('[role=menu]')].at(-1);
    return [...(menu?.querySelectorAll('[role^=menuitem]') ?? [])].map((e) => e.getAttribute('aria-label') ?? (e.innerText ?? '').trim().split('\n')[0].trim());
  });
/** Click a menu item, then wait for the submenu it opens. */
async function submenu(p, label) {
  const before = await menus(p);
  const ok = await menuItem(p, label);
  return ok && !!(await until(async () => (await menus(p)) > before, 3000));
}
/** The toasts' text. */
const toasts = (p) => p.evaluate(() => [...document.querySelectorAll('[aria-live="polite"] > div')].map((d) => d.innerText.replace(/\s+/g, ' ').trim())).catch(() => []);
/** A toast that says `message` (and, with `undo`, offers Undo). */
const toastWith = (p, message, { undo = false, timeout = 6000 } = {}) =>
  until(
    () =>
      p.evaluate(
        ([m, u]) =>
          [...document.querySelectorAll('[aria-live="polite"] > div')].some(
            (d) => d.textContent.includes(m) && (!u || [...d.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Undo')),
          ),
        [message, undo],
      ),
    timeout,
  );
/** The Undo button in the toast that says `message`. */
const toastUndo = (p, message) =>
  p.evaluate((m) => {
    const toast = [...document.querySelectorAll('[aria-live="polite"] > div')].find((d) => d.textContent.includes(m));
    const button = [...(toast?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Undo');
    button?.click();
    return !!button;
  }, message);

const KEY_CODES = { Enter: 13, Escape: 27, Backspace: 8, k: 75 };
async function press(p, key, { ctrl = false } = {}) {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const event = { key, code, windowsVirtualKeyCode: KEY_CODES[key] ?? 0, nativeVirtualKeyCode: KEY_CODES[key] ?? 0, modifiers: ctrl ? 2 : 0 };
  await p.send('Input.dispatchKeyEvent', { type: key === 'Backspace' ? 'rawKeyDown' : 'keyDown', ...event });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}
const typeText = (p, text) => p.send('Input.insertText', { text });
/** Focus the field with this aria-label (and select what's in it). */
const focusField = (p, label) =>
  p.evaluate((l) => {
    const el = document.querySelector(`[aria-label="${l}"]`);
    el?.focus();
    el?.select?.();
    return !!el && document.activeElement === el;
  }, label);
const focused = (p) => p.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
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

// The full list. Group headers are `h2 button[aria-expanded]`; the left column is nav "Folders and
// groups"; the list is virtual, so a group is jumped to (from the left column) before using it.
const sideNames = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll('nav[aria-label="Folders and groups"] a')].map((a) => ({
      name: a.querySelector('span[dir=auto]')?.textContent ?? a.innerText.split('\n')[0],
      starred: !!a.querySelector('[role=img][aria-label="Starred"]'),
    })),
  );
async function jump(p, name) {
  const ok = await p.evaluate((n) => {
    const a = [...document.querySelectorAll('nav[aria-label="Folders and groups"] a')].find((x) => (x.querySelector('span[dir=auto]')?.textContent ?? x.innerText.split('\n')[0]) === n);
    a?.click();
    return !!a;
  }, name);
  await sleep(350);
  return ok;
}
/** Open a folder's ⋯ menu in the full list. */
async function groupMenu(p, name) {
  await jump(p, name);
  const ok = await p.evaluate((n) => {
    const button = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === `More for ${n}`);
    button?.click();
    return !!button;
  }, name);
  return ok && !!(await until(() => menus(p), 3000));
}
/** The full list's group headers, top first (the virtual list's order). */
const listHeads = (p) =>
  p.evaluate(() => {
    const y = (el) => Number(/translateY\(([-\d.]+)px\)/.exec(el.closest('[style*="translateY"]')?.style.transform ?? '')?.[1] ?? NaN);
    return [...document.querySelectorAll('h2 button[aria-expanded]')]
      .map((b) => ({ name: b.querySelector('span[dir=auto]')?.textContent ?? b.innerText.split('\n')[0], y: y(b), starred: !!b.querySelector('[role=img][aria-label="Starred"]') }))
      .sort((a, b) => a.y - b.y);
  });
const go = async (p, hash) => {
  await p.evaluate((h) => {
    location.hash = h;
  }, hash);
  await sleep(300);
};

// The side panel: "Open now" has a section per window ("This window, 4 tabs"), its tabs ("Switch to
// …", "Close …"); "Folded" has a group per folder and kind of site ("Recipes, 2 tabs, collapsed").
const panelWindows = (p) => p.evaluate(() => [...document.querySelectorAll('section[aria-label="Open now"] > section')].map((s) => s.getAttribute('aria-label')));
const panelRows = (p, windowName) =>
  p.evaluate((n) => {
    const s = [...document.querySelectorAll('section[aria-label="Open now"] > section')].find((x) => x.getAttribute('aria-label').startsWith(`${n}, `));
    return s ? [...s.querySelectorAll('[aria-label^="Switch to "]')].map((b) => b.getAttribute('aria-label').slice('Switch to '.length)) : null;
  }, windowName);
const panelFolded = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll('section[aria-label="Folded"] [role=group]')].map((g) => ({
      label: g.getAttribute('aria-label'),
      starred: !!g.querySelector('[role=img][aria-label="Starred"]'),
      text: g.innerText,
    })),
  );
const panelFooter = (p) => p.evaluate(() => document.querySelector('footer')?.innerText.replace(/\s+/g, ' ').trim() ?? '');

/** The fold the popup shows a result for (60 s) is over: wait it out, so the popup is at rest. */
async function quietFolds() {
  const fold = await session('activeFold');
  const at = fold?.finishedAt ?? fold?.startedAt ?? 0;
  const wait = at + 62_000 - Date.now();
  if (wait > 0) {
    console.log(`  (waiting ${Math.ceil(wait / 1000)} s for the popup to stop showing the last fold)`);
    await sleep(wait);
  }
}

await until(async () => (await send({ type: 'room-list' }))?.ok, 15_000, 300);
const homeWindow = await control.evaluate(() => chrome.windows.getCurrent().then((w) => w.id));
// The full list, in the first window (pinned, so folds leave it open).
const ui = await open(ext('library.html'), { width: 1440, height: 1000 });
await pin(ui);
const focusUi = () => front(ui);
/** Worker errors a step expects (a refused command). */
const expectedWorkerErrors = new Set();

try {
  // -------------------------------------------------------------------------------------------
  // 1. The side panel on a fresh profile: the empty state, Open now (live), switch, ×, the footer
  const P1 = [site(1, 'acme-pricing'), site(2, 'garden-tools'), site(0, 'api-docs')];
  const w1 = await newWindow(P1);
  await titlesLoaded(P1);
  const panel = await openIn(w1, ext('sidepanel.html'), { width: 360, height: 860 });
  const focusPanel = () => front(panel);
  check('the side panel page opens (sidepanel.html as a tab, 360×860)', (await has(panel, 'Open now', 8000)) && (await has(panel, 'Open the full list', 3000)));
  check(
    'a fresh profile: "Nothing folded yet. Fold this window to free its memory; your tabs wait here."',
    await has(panel, 'Nothing folded yet. Fold this window to free its memory; your tabs wait here.', 5000),
  );
  const emptyFold = () =>
    panel.evaluate(() => {
      const b = [...document.querySelectorAll('section[aria-label="Folded"] button')].find((x) => x.innerText.trim() === 'Fold this window');
      return b ? !b.disabled : null;
    });
  check('…with "Fold this window"', (await until(emptyFold, 5000)) === true);
  check('the footer: "Open the full list" · "0 of 500 tabs"', !!(await until(async () => /Open the full list.*0 of 500 tabs/.test(await panelFooter(panel)), 5000)), await panelFooter(panel));
  await shot(panel, 'panel-empty.png');

  const normalWindows = async () => (await control.evaluate(() => chrome.windows.getAll({ windowTypes: ['normal'] }))).length;
  const windows = await until(async () => {
    const list = await panelWindows(panel);
    return list.length === (await normalWindows()) ? list : null;
  }, 5000);
  check('Open now lists every open window, this one first ("This window, 4 tabs")', windows?.[0] === 'This window, 4 tabs', JSON.stringify(windows));
  const rows = await panelRows(panel, 'This window');
  check('…with this window’s tabs', ['Pricing – Acme', 'Garden tools', 'API reference'].every((t) => rows?.includes(t)), JSON.stringify(rows));

  const flats = site(3, 'lisbon-flats');
  await addTab(w1, flats);
  check('a tab opened in this window shows up right away', !!(await until(async () => (await panelRows(panel, 'This window'))?.includes('Holiday flats in Lisbon'), 8000)));
  const w2 = await newWindow([site(3, 'tram-map')]);
  const w2Name = await windowNameIn(panel, w2);
  check(`a window opened elsewhere shows up ("${w2Name}, 1 tab")`, !!(await until(async () => (await panelWindows(panel)).includes(`${w2Name}, 1 tab`), 8000)), JSON.stringify(await panelWindows(panel)));
  await panel.evaluate((n) => {
    const s = [...document.querySelectorAll('section[aria-label="Open now"] > section')].find((x) => x.getAttribute('aria-label').startsWith(`${n}, `));
    s?.querySelector('button[aria-expanded]')?.click();
  }, w2Name);
  await addTab(w2, site(3, 'side-news'));
  check(
    '…and so does a tab opened in it',
    !!(await until(async () => {
      const r = await panelRows(panel, w2Name);
      return r?.includes('Lisbon tram map') && r.includes('Side project news');
    }, 8000)),
    JSON.stringify(await panelRows(panel, w2Name)),
  );
  await shot(panel, 'panel-open-now.png');

  const garden = (await tabsOf(w1)).find((t) => t.url === site(2, 'garden-tools'));
  await focusPanel();
  await realClick(panel, 'Switch to Garden tools');
  check('clicking a tab in the panel switches to it', !!(await until(() => tabActive(garden.id), 5000)));
  await focusPanel();
  // × shows on the row's hover or keyboard focus: Tab onto the row, then click it.
  await panel.evaluate(() => document.querySelector('[aria-label="Switch to Holiday flats in Lisbon"]')?.focus());
  await until(() => pointOf(panel, 'Close Holiday flats in Lisbon'), 3000);
  const closedFlats = await realClick(panel, 'Close Holiday flats in Lisbon');
  check('× on a tab closes it', closedFlats && !!(await until(async () => !(await chromeTabs()).some((t) => t.url === flats), 5000)));
  check('…and it leaves the list', !!(await until(async () => !(await panelRows(panel, 'This window'))?.includes('Holiday flats in Lisbon'), 5000)));

  await panel.evaluate(() => [...document.querySelectorAll('section[aria-label="Folded"] button')].find((x) => x.innerText.trim() === 'Fold this window')?.click());
  const foldedP1 = await until(async () => {
    for (const u of P1) if ((await recordsAt(u)).length !== 1) return false;
    return !(await chromeTabs()).some((t) => P1.includes(t.url));
  }, 10_000);
  check('"Fold this window" folds its 3 tabs and closes them', !!foldedP1);
  check('toast: "Folded 3 tabs" with Undo', !!(await toastWith(panel, 'Folded 3 tabs', { undo: true })), JSON.stringify(await toasts(panel)));
  check('the footer counts them: "3 of 500 tabs"', !!(await until(async () => (await panelFooter(panel)).includes('3 of 500 tabs'), 5000)), await panelFooter(panel));
  const kinds = await until(async () => {
    const f = await panelFolded(panel);
    return f.some((g) => g.label.startsWith('Dev, 1 tab')) && f.some((g) => g.label.startsWith('Other, 2 tabs')) ? f : null;
  }, 5000);
  check('Folded shows them by kind of site (Dev 1, Other 2)', !!kinds, JSON.stringify((await panelFolded(panel)).map((g) => g.label)));
  await shot(panel, 'panel-folded.png');

  // -------------------------------------------------------------------------------------------
  // 2. Fold into a folder: the popup's ▾ › New folder…, › a folder; "Free has 3 folders"
  const split = (p) =>
    p.evaluate(() => {
      const b = document.querySelector('button[aria-label="Fold into a folder"]');
      return !!b && !b.disabled;
    });
  const P3 = [site(1, 'brief'), site(2, 'mockups')];
  const w3 = await newWindow(P3);
  await titlesLoaded(P3);
  let popup = await openPopupIn(w3);
  check('the popup’s Fold is a split button: ▾ "Fold into a folder"', !!(await until(() => split(popup), 6000)));
  await clickLabel(popup, 'Fold into a folder');
  check(
    '▾ opens "Fold into a folder" · "This window · 2 tabs", with "New folder…"',
    !!(await until(async () => {
      const t = await menuText(popup);
      return t.includes('Fold into a folder') && t.includes('This window · 2 tabs') && t.includes('New folder…');
    }, 3000)),
    (await menuText(popup)).replace(/\n/g, ' | '),
  );
  await menuItem(popup, 'New folder…');
  check(
    '"New folder…" asks for its name: "Enter to fold into it · Esc to go back"',
    !!(await until(() => exists(popup, '[aria-label="New folder’s name"]'), 3000)) && !!(await has(popup, 'Enter to fold into it · Esc to go back', 2000)),
  );
  await focusField(popup, 'New folder’s name');
  await typeText(popup, 'Client sites');
  await shot(popup, 'popup-new-folder.png');
  await press(popup, 'Enter');
  const clientSites = await until(() => folderNamed('Client sites'), 8000);
  check(
    'Enter makes the folder "Client sites" and folds this window into it',
    !!clientSites && !!(await until(async () => (await recordsIn(clientSites.id)).filter((r) => P3.includes(r.url)).length === 2, 8000)),
  );
  check('…closing its tabs', !!(await until(async () => !(await chromeTabs()).some((t) => P3.includes(t.url)), 6000)));
  check('the popup says "Into Client sites"', !!(await has(popup, 'Into Client sites', 6000)));
  await shot(popup, 'popup-into-folder.png');
  await popup.close().catch(() => undefined);

  const P4 = [site(3, 'invoice'), site(1, 'style-guide')];
  const w4 = await newWindow(P4);
  await titlesLoaded(P4);
  popup = await openPopupIn(w4);
  await until(() => split(popup), 6000);
  await clickLabel(popup, 'Fold into a folder');
  check('▾ lists the folder with its tabs ("Client sites, 2 tabs")', !!(await until(() => exists(popup, '[role=menuitem][aria-label="Client sites, 2 tabs"]'), 3000)), JSON.stringify(await menuItems(popup)));
  await shot(popup, 'popup-fold-into.png');
  await menuItem(popup, 'Client sites, 2 tabs');
  check(
    '▾ › Client sites folds this window into the folder',
    !!(await until(async () => (await recordsIn(clientSites.id)).filter((r) => P4.includes(r.url)).length === 2, 8000)) &&
      !!(await until(async () => !(await chromeTabs()).some((t) => P4.includes(t.url)), 6000)),
  );
  check('the full list says "Folded 2 tabs into Client sites"', !!(await toastWith(ui, 'Folded 2 tabs into Client sites')), JSON.stringify(await toasts(ui)));
  await popup.close().catch(() => undefined);

  // Fold into › New folder… once the window has nothing left to fold (its last page was closed in
  // Chrome's tab strip meanwhile): no folder is made.
  const scratch = site(2, 'scratch');
  const w5 = await newWindow([scratch]);
  await titlesLoaded([scratch]);
  popup = await openPopupIn(w5);
  await until(() => split(popup), 6000);
  await clickLabel(popup, 'Fold into a folder');
  await until(() => menuItem(popup, 'New folder…'), 3000);
  await until(() => exists(popup, '[aria-label="New folder’s name"]'), 3000);
  await focusField(popup, 'New folder’s name');
  await typeText(popup, 'Scratch');
  await control.evaluate((u) => chrome.tabs.query({}).then((ts) => chrome.tabs.remove(ts.filter((t) => (t.url || t.pendingUrl) === u).map((t) => t.id))), scratch);
  await until(async () => !(await chromeTabs()).some((t) => t.url === scratch), 4000);
  await sleep(500);
  await focusField(popup, 'New folder’s name');
  const workerErrorsBefore = worker?.errors.length ?? 0;
  await press(popup, 'Enter');
  await sleep(3000);
  // The worker may refuse this fold (nothing to fold): that refusal is expected.
  for (const e of (worker?.errors ?? []).slice(workerErrorsBefore)) if (/^\[tabfold\] command failed fold [\w-]+$/.test(e)) expectedWorkerErrors.add(e);
  const scratchFolder = await folderNamed('Scratch');
  check(
    'Fold into › New folder… with nothing left to fold makes no folder',
    !scratchFolder,
    scratchFolder ? `a "Scratch" folder was made with ${(await recordsIn(scratchFolder.id)).length} tabs` : '',
  );
  // Free has 3 folders: an empty "Scratch" would take one of them, so it goes.
  if (scratchFolder) await send({ type: 'folder-delete', id: scratchFolder.id });
  await popup.close().catch(() => undefined);

  // The full list: a window card's ⋯ › Fold into… › New folder… "Research"
  const P6 = [site(3, 'paper'), site(2, 'release')];
  const w6 = await newWindow(P6);
  await titlesLoaded(P6);
  await focusUi();
  const w6Name = await windowNameIn(ui, w6);
  await until(() => exists(ui, `[aria-label="More for ${w6Name}"]`), 6000);
  await clickLabel(ui, `More for ${w6Name}`);
  await until(() => menus(ui), 3000);
  check(
    'a window card’s ⋯ in the full list: Fold into…, Tidy into groups, Rename window',
    JSON.stringify(await menuItems(ui)) === JSON.stringify(['Fold into…', 'Tidy into groups', 'Rename window']),
    JSON.stringify(await menuItems(ui)),
  );
  await submenu(ui, 'Fold into…');
  check(
    '…Fold into › lists the folders and "New folder…"',
    !!(await until(async () => {
      const items = await menuItems(ui);
      return items.includes('Client sites, 4 tabs') && items.includes('New folder…');
    }, 3000)),
    JSON.stringify(await menuItems(ui)),
  );
  await shot(ui, 'list-fold-into.png');
  await menuItem(ui, 'New folder…');
  await until(() => exists(ui, '[aria-label="New folder’s name"]'), 3000);
  await focusField(ui, 'New folder’s name');
  await typeText(ui, 'Research');
  await press(ui, 'Enter');
  const research = await until(() => folderNamed('Research'), 8000);
  check(
    '…New folder… "Research" folds that window into the new folder',
    !!research && !!(await until(async () => (await recordsIn(research.id)).filter((r) => P6.includes(r.url)).length === 2, 8000)),
  );
  check('…and the window closes', !!(await until(async () => !(await windowOpen(w6)), 6000)));
  check('toast: "Folded 2 tabs into Research"', !!(await toastWith(ui, 'Folded 2 tabs into Research')), JSON.stringify(await toasts(ui)));

  // The side panel: the window's ⋯ › Fold into… › New folder… "Recipes"
  const P7 = [site(1, 'recipes'), site(2, 'bread')];
  for (const u of P7) await addTab(w1, u);
  await titlesLoaded(P7);
  await focusPanel();
  await until(async () => (await panelRows(panel, 'This window'))?.includes('Sourdough starter'), 6000);
  await clickLabel(panel, 'More for This window');
  await until(() => menus(panel), 3000);
  check('the panel’s window ⋯: Fold into…, Tidy into groups, Rename window', JSON.stringify(await menuItems(panel)) === JSON.stringify(['Fold into…', 'Tidy into groups', 'Rename window']), JSON.stringify(await menuItems(panel)));
  await menuItem(panel, 'Fold into…');
  check(
    '…Fold into… swaps in the folders: "Fold “This window” into", Client sites, Research, New folder…',
    !!(await until(async () => {
      const items = await menuItems(panel);
      return items[0] === 'Fold “This window” into' && items.includes('Client sites, 4 tabs') && items.includes('Research, 2 tabs') && items.includes('New folder…');
    }, 3000)),
    JSON.stringify(await menuItems(panel)),
  );
  await menuItem(panel, 'New folder…');
  await until(() => exists(panel, '[aria-label="New folder’s name"]'), 3000);
  await focusField(panel, 'New folder’s name');
  await typeText(panel, 'Recipes');
  await press(panel, 'Enter');
  const recipes = await until(() => folderNamed('Recipes'), 8000);
  check(
    '…New folder… "Recipes" folds this window’s tabs into it',
    !!recipes && !!(await until(async () => (await recordsIn(recipes.id)).filter((r) => P7.includes(r.url)).length === 2, 8000)),
  );
  check('the panel says "Folded 2 tabs into Recipes" with Undo', !!(await toastWith(panel, 'Folded 2 tabs into Recipes', { undo: true })), JSON.stringify(await toasts(panel)));
  await shot(panel, 'panel-fold-into.png');

  // With 3 folders on Free, ▾ › New folder… says so
  popup = await openPopupIn(w2);
  await until(() => split(popup), 6000);
  await clickLabel(popup, 'Fold into a folder');
  await until(() => menuItem(popup, 'New folder…'), 3000);
  check(
    'with 3 folders on Free, ▾ › New folder… says "Free has 3 folders" (Not now, Upgrade)',
    !!(await until(async () => {
      const t = await menuText(popup);
      return t.includes('Free has 3 folders') && t.includes('Not now') && t.includes('Upgrade');
    }, 3000)),
    (await menuText(popup)).replace(/\n/g, ' | '),
  );
  await shot(popup, 'popup-folder-limit.png');
  await click(popup, 'Not now', '[role=menu] button');
  check('"Not now" goes back to the folders', !!(await until(async () => (await menuItems(popup)).includes('New folder…'), 3000)));
  check('…and nothing is made or folded', (await liveFolders()).length === 3 && (await tabsOf(w2)).filter((t) => t.url?.startsWith('http')).length === 2);
  await press(popup, 'Escape');
  await popup.close().catch(() => undefined);

  // -------------------------------------------------------------------------------------------
  // 1 (cont.). Drag an open tab onto a folder in the side panel: it folds into it (toast, Undo)
  const statusUrl = site(0, 'status');
  await addTab(w1, statusUrl);
  await titlesLoaded([statusUrl]);
  await focusPanel();
  await until(async () => (await panelRows(panel, 'This window'))?.includes('Status page'), 6000);
  const over = await panel.evaluate(([title, folder]) => {
    const row = document.querySelector(`[aria-label="Switch to ${title}"]`)?.closest('[draggable=true]');
    const group = [...document.querySelectorAll('section[aria-label="Folded"] [role=group]')].find((g) => g.getAttribute('aria-label').startsWith(`${folder}, `));
    const target = group?.firstElementChild;
    if (!row || !target) return { found: false, row: !!row, target: !!target };
    const dataTransfer = new DataTransfer();
    window.__tfDrag = { row, target, dataTransfer };
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
    const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer });
    target.dispatchEvent(ev);
    return { found: true, accepts: ev.defaultPrevented };
  }, ['Status page', 'Research']);
  check('dragging an open tab over a folder offers to fold it in', over.accepts, JSON.stringify(over));
  check('…"Drop to fold into Research"', !!(await has(panel, 'Drop to fold into Research', 3000)));
  await shot(panel, 'panel-drag.png');
  await panel.evaluate(() => {
    const { row, target, dataTransfer } = window.__tfDrag ?? {};
    if (!target) return false;
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
    window.__tfDrag = null;
    return true;
  });
  check('dropping it folds the tab into Research', !!(await until(async () => (await recordsIn(research.id)).some((r) => r.url === statusUrl), 8000)));
  check('…and closes it', !!(await until(async () => !(await chromeTabs()).some((t) => t.url === statusUrl), 6000)));
  check('toast: "Folded 1 tab into Research" with Undo', !!(await toastWith(panel, 'Folded 1 tab into Research', { undo: true })), JSON.stringify(await toasts(panel)));
  await toastUndo(panel, 'Folded 1 tab into Research');
  check(
    'Undo reopens it and takes it out of the folder',
    !!(await until(async () => (await chromeTabs()).some((t) => t.url === statusUrl) && !(await recordsAt(statusUrl)).length, 8000)),
  );

  // -------------------------------------------------------------------------------------------
  // 8. Stars and notes: ⋯ › Star (first everywhere), Add a note (counter, Enter, empty removes)
  await focusUi();
  await until(async () => (await sideNames(ui)).some((s) => s.name === 'Recipes'), 6000);
  await groupMenu(ui, 'Recipes');
  check('a folder’s ⋯ starts with Star and Add a note', JSON.stringify((await menuItems(ui)).slice(0, 2)) === JSON.stringify(['Star', 'Add a note']), JSON.stringify(await menuItems(ui)));
  await menuItem(ui, 'Star');
  check('⋯ › Star stars the folder (starredAt)', !!(await until(async () => (await folderNamed('Recipes'))?.starredAt > 0, 5000)));
  const side = await until(async () => {
    const s = await sideNames(ui);
    return s[0]?.name === 'Recipes' && s[0].starred ? s : null;
  }, 5000);
  check('…it comes first in the left column, with a star', !!side, JSON.stringify(await sideNames(ui)));
  await jump(ui, 'Recipes');
  const heads = await until(async () => {
    const h = await listHeads(ui);
    return h[0]?.name === 'Recipes' ? h : null;
  }, 4000);
  check('…and first in the list, starred', !!heads && heads[0].starred, JSON.stringify((await listHeads(ui)).slice(0, 4)));

  const NOTE = 'Try the sourdough first';
  await groupMenu(ui, 'Recipes');
  await menuItem(ui, 'Add a note');
  check('⋯ › Add a note opens the note field', !!(await until(async () => (await focused(ui)) === 'Note for Recipes', 3000)), await focused(ui));
  await typeText(ui, NOTE);
  check(`…which counts "${[...NOTE].length} / 140"`, !!(await has(ui, `${[...NOTE].length} / 140`, 2000)));
  check('…"Enter to save · Esc to cancel · Empty it to remove the note"', !!(await has(ui, 'Enter to save · Esc to cancel · Empty it to remove the note', 2000)));
  await shot(ui, 'list-note.png');
  await press(ui, 'Enter');
  check('Enter saves the note', !!(await until(async () => (await folderNamed('Recipes'))?.note === NOTE, 5000)), JSON.stringify((await folderNamed('Recipes'))?.note));
  await jump(ui, 'Recipes');
  check('…and shows it under the folder’s header', !!(await until(() => exists(ui, `[aria-label="Note: ${NOTE}. Edit the note"]`), 4000)));
  await groupMenu(ui, 'Recipes');
  check('the menu then says "Unstar" and "Edit the note"', JSON.stringify((await menuItems(ui)).slice(0, 2)) === JSON.stringify(['Unstar', 'Edit the note']), JSON.stringify(await menuItems(ui)));
  await press(ui, 'Escape');
  await shot(ui, 'list-star-note.png');

  await focusPanel();
  const panelStar = await until(async () => {
    const f = await panelFolded(panel);
    return f[0]?.label.startsWith('Recipes, ') && f[0].starred && f[0].text.includes(NOTE) ? f : null;
  }, 6000);
  check('the side panel lists the starred folder first, with its star and its note', !!panelStar, JSON.stringify((await panelFolded(panel)).map((g) => [g.label, g.starred])));
  await shot(panel, 'panel-star-note.png');

  popup = await openPopupIn(w2);
  const popupGroups = await until(async () => {
    const g = await popup.evaluate(() => [...document.querySelectorAll('[role=group][aria-label]')].map((x) => x.getAttribute('aria-label').split(',')[0]));
    return g.includes('Research') ? g : null;
  }, 6000);
  check('the popup lists it first too', popupGroups?.[0] === 'Recipes', JSON.stringify(popupGroups));
  await until(() => split(popup), 6000);
  await clickLabel(popup, 'Fold into a folder');
  const intoOrder = await until(async () => {
    const items = await menuItems(popup);
    return items.length > 1 ? items : null;
  }, 3000);
  check('…and first in Fold into ("Recipes, starred, 2 tabs")', intoOrder?.[0] === 'Recipes, starred, 2 tabs', JSON.stringify(intoOrder));
  await press(popup, 'Escape');
  await popup.close().catch(() => undefined);

  // Empty the note: it goes
  await focusUi();
  await jump(ui, 'Recipes');
  await clickLabel(ui, `Note: ${NOTE}. Edit the note`);
  check('clicking the note edits it in place', !!(await until(async () => (await focused(ui)) === 'Note for Recipes', 3000)));
  await focusField(ui, 'Note for Recipes');
  await press(ui, 'Backspace');
  const emptied = await until(() => ui.evaluate(() => document.querySelector('[aria-label="Note for Recipes"]')?.value === ''), 2000);
  check('…"0 / 140" once emptied', !!emptied && !!(await has(ui, '0 / 140', 2000)));
  await press(ui, 'Enter');
  check('Enter on an empty note removes it', !!(await until(async () => !(await folderNamed('Recipes'))?.note, 5000)), JSON.stringify((await folderNamed('Recipes'))?.note));
  check('…from under the header', !!(await until(async () => !(await exists(ui, '[aria-label^="Note: "]')), 4000)));

  // -------------------------------------------------------------------------------------------
  // 3. Fold back: a folder opened as a tab group goes back into the folder, with what was added
  const w7 = await newWindow(['about:blank']);
  const ui2 = await openIn(w7, ext('library.html'), { width: 1440, height: 900 });
  await has(ui2, 'Recent folds', 8000);
  await until(async () => (await sideNames(ui2)).some((s) => s.name === 'Client sites'), 6000);
  await groupMenu(ui2, 'Client sites');
  check('a folder’s ⋯ has "Open all (a copy) as a tab group"', (await menuItems(ui2)).includes('Open all (a copy) as a tab group'), JSON.stringify(await menuItems(ui2)));
  await menuItem(ui2, 'Open all (a copy) as a tab group');
  const group = await until(async () => (await groupsIn(w7)).find((g) => g.title === 'Client sites'), 8000);
  check('it opens the folder as a "Client sites" tab group in this window', !!group);
  const groupTabs = async () => (group ? (await tabsOf(w7)).filter((t) => t.groupId === group.id) : []);
  check('…with the folder’s 4 tabs', !!(await until(async () => (await groupTabs()).length === 4, 8000)), String((await groupTabs()).length));
  check('…linked to the folder for folding back (groupFolders)', !!(await until(async () => group && (await session('groupFolders'))?.[group.id] === clientSites.id, 5000)));
  // A page added to the group since (Chrome's tab strip can't be driven: it's put in the group directly).
  const kickoff = site(2, 'kickoff');
  const kickoffId = await addTab(w7, kickoff);
  if (group) await control.evaluate(([g, t]) => chrome.tabs.group({ groupId: g, tabIds: [t] }), [group.id, kickoffId]);
  await titlesLoaded([kickoff]);
  popup = await openPopupIn(w7);
  check('the popup says "Its “Client sites” group folds back into the folder"', !!(await has(popup, 'Its “Client sites” group folds back into the folder', 6000)));
  await shot(popup, 'popup-fold-back.png');
  await popup.close().catch(() => undefined);
  const groupUrls = (await groupTabs()).map((t) => t.url);
  await focusUi();
  await front(ui2);
  const foldThis = await ui2.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^Fold this window, \d+ tabs?$/.test(x.getAttribute('aria-label') ?? ''));
    b?.click();
    return b?.getAttribute('aria-label') ?? null;
  });
  check(`folding the window (${foldThis}) puts all of the group’s tabs in the folder, once each`, groupUrls.length === 5 && !!(await until(async () => {
    const recs = await recordsIn(clientSites.id);
    return groupUrls.every((u) => recs.filter((r) => r.url === u).length === 1);
  }, 10_000)), JSON.stringify(groupUrls.length));
  check('…and closes them', !!(await until(async () => (await groupTabs()).length === 0, 6000)));
  const backToast = await until(async () => (await toasts(ui2)).find((t) => /Folded \d+ tabs · \d+ went back into Client sites/.test(t)), 6000);
  check('toast: "Folded N tabs · N went back into Client sites"', !!backToast, backToast ?? JSON.stringify(await toasts(ui2)));
  await shot(ui2, 'list-fold-back.png');
  await closeWindow(w7);

  // -------------------------------------------------------------------------------------------
  // 4. Close the copies: the same page twice, then three times; the one looked at last stays; Undo
  const compare = site(1, 'compare');
  const notesUrl = site(2, 'notes');
  const w8 = await newWindow([compare, notesUrl]);
  const copy2 = await addTab(w8, compare);
  await titlesLoaded([compare, notesUrl]);
  popup = await openPopupIn(w8);
  check('the popup: "1 page is open twice · Close the copies"', !!(await has(popup, '1 page is open twice', 6000)) && !!(await has(popup, 'Close the copies', 1000)));
  await shot(popup, 'popup-copies.png');
  await popup.close().catch(() => undefined);
  check('…the full list too', !!(await has(ui, '1 page is open twice', 6000)));
  await focusPanel();
  check('…and the side panel', !!(await has(panel, '1 page is open twice', 6000)));
  await addTab(w8, compare);
  check('a third copy: "1 page is open more than once" (panel)', !!(await has(panel, '1 page is open more than once', 6000)));
  await focusUi();
  check('…(full list)', !!(await has(ui, '1 page is open more than once', 6000)));
  // The person looks at the second copy, then moves on to another tab in that window.
  const notesId = (await tabsOf(w8)).find((t) => t.url === notesUrl).id;
  await activate(notesId);
  await sleep(400);
  await activate(copy2);
  await sleep(400);
  await activate(notesId);
  await sleep(400);
  const w8Name = await windowNameIn(ui, w8);
  await clickLabel(ui, `More for ${w8Name}`);
  check('the window’s ⋯ offers "Close the copies" (1 page)', !!(await until(() => exists(ui, '[role=menuitem][aria-label="Close the copies, 1 page"]'), 3000)), JSON.stringify(await menuItems(ui)));
  await press(ui, 'Escape');
  await shot(ui, 'list-copies.png');
  await click(ui, 'Close the copies');
  const kept = await until(async () => {
    const t = (await tabsOf(w8)).filter((x) => x.url === compare);
    return t.length === 1 ? t : null;
  }, 6000);
  check('"Close the copies" closes the 2 extra copies', !!kept);
  check('…keeping the one looked at last', kept?.[0].id === copy2, JSON.stringify({ kept: kept?.[0].id, lookedAtLast: copy2 }));
  check('toast: "Closed 2 copies" with Undo', !!(await toastWith(ui, 'Closed 2 copies', { undo: true })), JSON.stringify(await toasts(ui)));
  await toastUndo(ui, 'Closed 2 copies');
  check('Undo reopens them', !!(await until(async () => (await tabsOf(w8)).filter((x) => x.url === compare).length === 3, 6000)));
  // Straight away again: the copy looked at last is still the second one (the two copies Undo
  // reopened in the background haven't been looked at since).
  await sleep(500);
  await click(ui, 'Close the copies');
  const keptAgain = await until(async () => {
    const t = (await tabsOf(w8)).filter((x) => x.url === compare);
    return t.length === 1 ? t : null;
  }, 6000);
  check('Undo, then "Close the copies" again: it still keeps the one looked at last', !!keptAgain && keptAgain[0].id === copy2, JSON.stringify({ kept: keptAgain?.[0].id, lookedAtLast: copy2 }));
  await closeWindow(w8);

  // -------------------------------------------------------------------------------------------
  // 5. Tidy into groups: a window's tabs become Chrome tab groups by kind of site; Undo
  await send({ type: 'site-kind-set', host: HOSTS[1], kind: 'mail' });
  const T = [site(0, 'dev-one'), site(1, 'mail-one'), site(0, 'dev-two'), site(1, 'mail-two'), site(2, 'other-one')];
  const w9 = await newWindow(T);
  await titlesLoaded(T);
  await focusUi();
  const w9Name = await windowNameIn(ui, w9);
  await clickLabel(ui, `More for ${w9Name}`);
  await until(() => menus(ui), 3000);
  await menuItem(ui, 'Tidy into groups');
  const tidied = await until(async () => {
    const g = await groupsIn(w9);
    return g.length === 2 ? g : null;
  }, 6000);
  const titles = (tidied ?? []).map((g) => `${g.title}:${g.color}`).sort();
  check('Tidy into groups makes Chrome tab groups titled by kind (Dev blue, Mail & chat yellow)', JSON.stringify(titles) === JSON.stringify(['Dev:blue', 'Mail & chat:yellow']), JSON.stringify(titles));
  const byGroup = async () => {
    const tabs = await tabsOf(w9);
    const name = (t) => (tidied ?? []).find((g) => g.id === t.groupId)?.title ?? '-';
    return Object.fromEntries(tabs.map((t) => [t.title, name(t)]));
  };
  const grouping = await byGroup();
  check(
    '…each with its kind’s tabs; a kind with one tab stays loose',
    grouping['Build dashboard'] === 'Dev' && grouping['Pull requests'] === 'Dev' && grouping['Team inbox'] === 'Mail & chat' && grouping['Sent mail'] === 'Mail & chat' && grouping['Weather today'] === '-',
    JSON.stringify(grouping),
  );
  check('toast: "Grouped 4 tabs into 2 groups" with Undo', !!(await toastWith(ui, 'Grouped 4 tabs into 2 groups', { undo: true })), JSON.stringify(await toasts(ui)));
  await focusPanel();
  await panel.evaluate((n) => {
    const s = [...document.querySelectorAll('section[aria-label="Open now"] > section')].find((x) => x.getAttribute('aria-label').startsWith(`${n}, `));
    const toggle = s?.querySelector('button[aria-expanded]');
    if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
  }, await windowNameIn(panel, w9));
  check('the side panel shows the groups', !!(await until(() => exists(panel, '[role=group][aria-label="Tab group Mail & chat, 2 tabs"]'), 4000)));
  await shot(panel, 'panel-tidy.png');
  await focusUi();
  await toastUndo(ui, 'Grouped 4 tabs into 2 groups');
  check('Undo takes the tabs out of the groups', !!(await until(async () => (await groupsIn(w9)).length === 0 && (await tabsOf(w9)).every((t) => t.groupId === -1), 6000)));
  await closeWindow(w9);
  await closeWindow(w2);

  // -------------------------------------------------------------------------------------------
  // 6. Window names: rename in the full list and the panel; the name shows everywhere; a named
  // window's fold takes its name; reopening it names the new window
  const N = [site(1, 'acme-careers'), site(2, 'timeline'), site(3, 'invoice-march')];
  const w10 = await newWindow(N);
  await titlesLoaded(N);
  await focusUi();
  const w10Name = await windowNameIn(ui, w10);
  await until(() => exists(ui, `[aria-label="More for ${w10Name}"]`), 6000);
  await ui.evaluate((n) => [...document.querySelectorAll('span[title="Click the name to rename"]')].find((s) => s.textContent === n)?.click(), w10Name);
  check('clicking a window card’s name edits it ("Window name")', !!(await until(async () => (await focused(ui)) === 'Window name', 3000)), String(await focused(ui)));
  check('…"Enter to save · Esc to cancel"', !!(await has(ui, 'Enter to save · Esc to cancel', 2000)));
  await typeText(ui, 'Client work');
  await shot(ui, 'list-rename.png');
  await press(ui, 'Enter');
  check('Enter names the window "Client work"', !!(await until(async () => (await session('windowNames'))?.[w10] === 'Client work', 5000)), JSON.stringify(await session('windowNames')));
  check(
    '…remembered with its pages for restarts (namedWindows)',
    !!(await until(async () => (await local('namedWindows'))?.some((n) => n.name === 'Client work' && n.windowId === w10 && n.urls.length === N.length), 5000)),
    JSON.stringify((await local('namedWindows'))?.map((n) => [n.name, n.urls.length])),
  );
  check('…its card says "Client work"', !!(await until(() => exists(ui, '[aria-label="Switch to Client work, 3 tabs"]'), 4000)));
  await focusPanel();
  check('…so does the side panel', !!(await until(async () => (await panelWindows(panel)).includes('Client work, 3 tabs'), 5000)), JSON.stringify(await panelWindows(panel)));
  popup = await openPopupIn(w1);
  check('…and the popup', !!(await until(() => exists(popup, '[aria-label="Switch to Client work, 3 tabs"]'), 5000)));
  await popup.close().catch(() => undefined);

  const R = [site(3, 'long-read'), site(2, 'essay')];
  const w11 = await newWindow(R);
  await titlesLoaded(R);
  await focusPanel();
  const w11Name = await windowNameIn(panel, w11);
  await until(async () => (await panelWindows(panel)).includes(`${w11Name}, 2 tabs`), 6000);
  await panel.evaluate((n) => [...document.querySelectorAll('section[aria-label="Open now"] span[title="Click to rename"]')].find((s) => s.textContent === n)?.click(), w11Name);
  check('clicking a window’s name in the side panel edits it', !!(await until(async () => (await focused(panel)) === 'Window name', 3000)), String(await focused(panel)));
  await typeText(panel, 'Reading list');
  await press(panel, 'Enter');
  check('Enter names it there too ("Reading list")', !!(await until(async () => (await session('windowNames'))?.[w11] === 'Reading list', 5000)));
  await focusUi();
  check('…and the full list shows it', !!(await until(() => exists(ui, '[aria-label="Switch to Reading list, 2 tabs"]'), 5000)));
  await closeWindow(w11);

  await clickLabel(ui, 'Fold Client work, 3 tabs');
  const namedFold = await until(async () => (await idb('sessions')).find((s) => !s.deletedAt && s.name === 'Client work'), 8000);
  check('folding the "Client work" window names its fold "Client work"', !!namedFold && !!(await until(async () => !(await windowOpen(w10)), 6000)));
  check(
    'Recent folds shows "Client work"',
    !!(await until(() => ui.evaluate(() => document.querySelector('section[aria-labelledby="rf-h"]')?.innerText.includes('Client work')), 5000)),
  );
  await shot(ui, 'list-recent-named.png');
  const reopenedLabel = await ui.evaluate(() => {
    const b = [...document.querySelectorAll('section[aria-labelledby="rf-h"] button')].find((x) => (x.getAttribute('aria-label') ?? '').startsWith('Reopen the fold “Client work”'));
    b?.click();
    return b?.getAttribute('aria-label') ?? null;
  });
  const clientWork = await until(async () => {
    const names = await session('windowNames');
    const id = Object.keys(names ?? {}).find((k) => names[k] === 'Client work' && Number(k) !== w10);
    if (!id) return null;
    const tabs = await tabsOf(Number(id));
    return N.every((u) => tabs.some((t) => t.url === u)) ? Number(id) : null;
  }, 12_000);
  check('Reopen brings the window back, named "Client work"', !!clientWork, `${reopenedLabel}; ${JSON.stringify(await session('windowNames'))}`);
  await focusUi();
  check('…its card says so', !!(await until(() => exists(ui, '[aria-label="Switch to Client work, 3 tabs"]'), 5000)));

  // -------------------------------------------------------------------------------------------
  // 10. Search and Ctrl+K: open tabs first (with the window's name), Enter switches
  await titlesLoaded(N);
  const tabIn = async (url) => (await tabsOf(clientWork)).find((t) => t.url === url)?.id;
  const careersId = await tabIn(N[0]);
  const timelineId = await tabIn(N[1]);
  await activate(timelineId);
  await focusUi();
  const SEARCH = 'Search open and folded tabs by title, address or keyword';
  await realClick(ui, SEARCH);
  await typeText(ui, 'acme');
  const heading = await until(async () => {
    const t = await textOf(ui);
    return /\d+ results? for “acme”/.test(t) && /1 open · \d+ folded/.test(t) ? t : null;
  }, 6000);
  check('the full list’s search: "N results for “acme”" · "1 open · N folded"', !!heading);
  const searchGroups = await ui.evaluate(() => [...document.querySelectorAll('#search-results > [role=group]')].map((g) => g.getAttribute('aria-label')));
  check('…"Open now" first', searchGroups[0]?.startsWith('Open now') && searchGroups.length > 1, JSON.stringify(searchGroups));
  check('…the open tab with its window’s name ("Careers – Acme, open in Client work")', await exists(ui, '[role=option][aria-label="Careers – Acme, open in Client work"]'));
  check('…and "Switch"', !!(await until(() => exists(ui, '[aria-label="Switch to Careers – Acme"]'), 2000)));
  await shot(ui, 'list-search.png');
  await ui.evaluate(() => document.querySelector('input[type=search]')?.focus());
  check('…selected first', (await ui.evaluate(() => document.querySelector('#search-results [role=option][aria-selected=true]')?.getAttribute('aria-label'))) === 'Careers – Acme, open in Client work');
  await press(ui, 'Enter');
  check('Enter switches to the open tab', !!(await until(() => tabActive(careersId), 5000)));
  await focusUi();
  await ui.evaluate(() => document.querySelector('input[type=search]')?.focus());
  await press(ui, 'Escape');
  await lacks(ui, 'results for “acme”', 3000);

  await activate(timelineId);
  await focusPanel();
  await realClick(panel, SEARCH);
  await typeText(panel, 'acme');
  const panelResults = await until(async () => {
    const r = await panel.evaluate(() => ({
      groups: [...document.querySelectorAll('[role=listbox] > [role=group]')].map((g) => g.getAttribute('aria-label')),
      first: document.querySelector('[role=listbox] [role=option]')?.getAttribute('aria-label') ?? null,
      selected: document.querySelector('[role=listbox] [role=option][aria-selected=true]')?.getAttribute('aria-label') ?? null,
    }));
    return r.groups.length === 2 ? r : null;
  }, 6000);
  check('the panel’s search: "Open now" first, then "Folded"', JSON.stringify(panelResults?.groups) === JSON.stringify(['Open now', 'Folded']), JSON.stringify(panelResults));
  check('…the open tab first (selected), with its window’s name', panelResults?.first === 'Careers – Acme, open in Client work' && panelResults.selected === panelResults.first, JSON.stringify(panelResults));
  check('…"↵ switch"', /↵\s*switch/.test(await textOf(panel)));
  await shot(panel, 'panel-search.png');
  await panel.evaluate(() => document.querySelector('input[type=search]')?.focus());
  await press(panel, 'Enter');
  check('Enter switches to it', !!(await until(() => tabActive(careersId), 5000)));
  await focusPanel();
  await panel.evaluate(() => document.querySelector('input[type=search]')?.focus());
  await press(panel, 'Escape');

  await activate(careersId);
  await focusUi();
  await ui.evaluate(() => document.activeElement?.blur());
  await press(ui, 'k', { ctrl: true });
  check('Ctrl+K opens the palette', !!(await until(() => exists(ui, 'dialog[open] input[role=combobox]'), 3000)));
  await typeText(ui, 'timeline');
  const palette = await until(async () => {
    const t = await dialogText(ui);
    return /switch to tab/i.test(t) && t.includes('Project timeline') && t.includes('Client work') ? t : null;
  }, 5000);
  check('…typing finds the open tab under "Switch to tab", with its window’s name', !!palette, (await dialogText(ui)).replace(/\n/g, ' | '));
  check('…"↵ switch · ↑↓ move · esc close"', /↵\s*switch\s*·\s*↑↓\s*move\s*·\s*esc\s*close/i.test(await dialogText(ui)), (await dialogText(ui)).replace(/\n/g, ' | '));
  await shot(ui, 'palette-switch.png');
  await press(ui, 'Enter');
  check('…Enter switches to it', !!(await until(() => tabActive(timelineId), 5000)));
  await noDialog(ui);

  // -------------------------------------------------------------------------------------------
  // 11. Settings: no account to delete when signed out; Privacy and Terms; the toolbar button
  await focusUi();
  await go(ui, '#/settings');
  check('Settings has "Toolbar button opens": The popup / The side panel', !!(await has(ui, 'Toolbar button opens', 6000)) && !!(await until(() => exists(ui, 'dialog[open] [role=radiogroup][aria-label="Toolbar button opens"]'), 2000)));
  check('…"The side panel stays open while you browse."', !!(await has(ui, 'The side panel stays open while you browse.', 2000)));
  check('Free, signed out: no "Delete my Tabfold account…"', !(await textOf(ui)).includes('Delete my Tabfold account'));
  const policy = await ui.evaluate(() => [...document.querySelectorAll('nav[aria-label="Tabfold’s policies"] a')].map((a) => [a.textContent.trim(), a.href]));
  check(
    '"Privacy" and "Terms" link to https://tabfold.truewidgets.com/privacy and /terms',
    JSON.stringify(policy) === JSON.stringify([['Privacy', 'https://tabfold.truewidgets.com/privacy'], ['Terms', 'https://tabfold.truewidgets.com/terms']]),
    JSON.stringify(policy),
  );
  const toolbar = () =>
    control.evaluate(async () => ({ popup: await chrome.action.getPopup({}), panel: (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick }));
  check('to start, the toolbar button opens the popup', (await toolbar()).popup.endsWith('/popup.html') && !(await toolbar()).panel, JSON.stringify(await toolbar()));
  await click(ui, 'The side panel', 'dialog[open] [role=radio]');
  check('"The side panel" is saved (toolbarOpens)', !!(await until(async () => (await local('settings'))?.toolbarOpens === 'side-panel', 4000)));
  const sideMode = await until(async () => {
    const s = await toolbar();
    return s.popup === '' && s.panel === true ? s : null;
  }, 5000);
  check('…and Chrome opens the side panel from the toolbar button (no popup, openPanelOnActionClick)', !!sideMode, JSON.stringify(await toolbar()));
  await ui.evaluate(() => document.querySelector('[aria-label="Toolbar button opens"]')?.scrollIntoView({ block: 'center' }));
  await shot(ui, 'settings-toolbar.png');
  await click(ui, 'The popup', 'dialog[open] [role=radio]');
  const popupMode = await until(async () => {
    const s = await toolbar();
    return s.popup.endsWith('/popup.html') && s.panel === false ? s : null;
  }, 5000);
  check('"The popup" puts the popup back', !!popupMode && (await local('settings'))?.toolbarOpens === 'popup', JSON.stringify(await toolbar()));

  // The popup's "Open in side panel"
  popup = await openPopupIn(w1);
  const before = new Set((await browser.targets()).map((t) => t.targetId));
  await front(popup);
  const opened = await realClick(popup, 'Open in side panel');
  const sideTarget = await until(async () => (await browser.targets()).find((t) => !before.has(t.targetId) && t.url.startsWith(ext('sidepanel.html'))), 5000);
  check('the popup’s "Open in side panel" opens Tabfold in Chrome’s side panel', opened && !!sideTarget, sideTarget ? sideTarget.type : 'no side panel target');
  await popup.close().catch(() => undefined);

  // -------------------------------------------------------------------------------------------
  // 9. The weekly summary (last week's numbers, as the worker keeps them in weeklyStats)
  await go(ui, '#/');
  await noDialog(ui);
  await quietFolds();
  const weeks = await control.evaluate(() => {
    const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const now = new Date();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const last = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7);
    return { thisWeek: key(monday), lastWeek: key(last) };
  });
  const seedWeek = (numbers) =>
    control.evaluate(
      async ([key, n]) => {
        const { weeklyStats = {} } = await chrome.storage.local.get('weeklyStats');
        await chrome.storage.local.set({ weeklyStats: { ...weeklyStats, [key]: n } });
        await chrome.storage.local.remove('weeklySummarySeen');
      },
      [weeks.lastWeek, numbers],
    );
  await seedWeek({ folded: 1, freedBytes: 480 * 1024 * 1024, cameBack: 1 });
  await focusUi();
  const weeklyCard = () => ui.evaluate(() => document.querySelector('section[aria-label="Last week"]')?.innerText.replace(/\s+/g, ' ').trim() ?? null);
  check(
    'the full list: "Last week you folded 1 tab and freed about 480 MB. 1 came back when you needed it."',
    !!(await until(async () => (await weeklyCard()) === 'Last week you folded 1 tab and freed about 480 MB. 1 came back when you needed it.', 6000)),
    String(await weeklyCard()),
  );
  const WEEK = 'Last week you folded 340 tabs and freed about 12 GB. 28 came back when you needed them.';
  await seedWeek({ folded: 340, freedBytes: 12 * 1024 ** 3, cameBack: 28 });
  check(`…"${WEEK}"`, !!(await until(async () => (await weeklyCard()) === WEEK, 6000)), String(await weeklyCard()));
  await shot(ui, 'list-weekly.png');
  popup = await openPopupIn(w1);
  const weeklyLine = () => popup.evaluate(() => document.querySelector('[role=note]')?.innerText.replace(/\s+/g, ' ').trim() ?? null);
  check('the popup says it under Fold', !!(await until(async () => (await weeklyLine()) === WEEK, 6000)), String(await weeklyLine()));
  await shot(popup, 'popup-weekly.png');
  await clickLabel(popup, 'Hide this week’s summary');
  check('× puts it away for this week (weeklySummarySeen)', !!(await until(async () => (await local('weeklySummarySeen')) === weeks.thisWeek, 4000)), String(await local('weeklySummarySeen')));
  check('…the popup line goes', !!(await until(async () => (await weeklyLine()) === null, 3000)));
  check('…and the full list’s card', !!(await until(async () => (await weeklyCard()) === null, 5000)));
  await popup.close().catch(() => undefined);
  popup = await openPopupIn(w1);
  await sleep(1500);
  check('…it doesn’t come back in a new popup this week', (await weeklyLine()) === null);
  await popup.close().catch(() => undefined);

  // -------------------------------------------------------------------------------------------
  // 7. Fold automatically: "A window has more than 5 tabs" (Free's one rule)
  for (const w of await control.evaluate(() => chrome.windows.getAll({ windowTypes: ['normal'] }).then((ws) => ws.map((x) => x.id)))) {
    if (w !== homeWindow && w !== w1) await closeWindow(w);
  }
  await focusUi();
  await go(ui, '#/settings');
  await has(ui, 'Fold automatically', 6000);
  await ui.evaluate(() => document.getElementById('auto-h')?.scrollIntoView({ block: 'start' }));
  await click(ui, 'Add a rule', 'dialog[open] button');
  await dialogHas(ui, 'New rule', 3000);
  const capOption = await choose(ui, 'window-cap');
  check('New rule › When offers "A window has more than"', capOption === 'A window has more than', JSON.stringify(capOption));
  check(
    '…with "Number of tabs" and Which "The ones I haven’t looked at longest"',
    !!(await until(() => exists(ui, 'dialog[open] [aria-label="Number of tabs"]'), 2000)) && (await dialogText(ui)).includes('The ones I haven’t looked at longest'),
  );
  await focusField(ui, 'Number of tabs');
  await typeText(ui, '5');
  check('…Free can save it ("Save rule")', !!(await dialogHas(ui, 'Save rule', 2000)) && !(await dialogText(ui)).includes('Upgrade to save'));
  await shot(ui, 'rule-window-cap.png');
  await clickInDialog(ui, 'Save rule');
  const rule = await until(async () => (await local('settings'))?.autoFold?.find((r) => r.when.type === 'window-cap'), 5000);
  check('the rule is saved and on: more than 5 tabs, into their kind of site', rule?.enabled && rule.when.max === 5 && rule.into.type === 'site', JSON.stringify(rule));
  check(
    'Settings lists "A window has more than 5 tabs" · "Folds the ones you haven’t looked at longest"',
    !!(await has(ui, 'A window has more than 5 tabs', 3000)) && !!(await has(ui, 'Folds the ones you haven’t looked at longest', 1000)),
  );
  await shot(ui, 'settings-rules.png');
  await go(ui, '#/');
  await noDialog(ui);

  const CAP = Array.from({ length: 7 }, (_, i) => site((i % 3) + 1, `cap-${i + 1}`));
  const w12 = await newWindow([CAP[0]]);
  for (const u of CAP.slice(1, 5)) await addTab(w12, u);
  await titlesLoaded(CAP.slice(0, 5));
  await sleep(4500);
  check('5 tabs (the cap) stay open', (await tabsOf(w12)).length === 5, String((await tabsOf(w12)).length));
  // Look at them in this order: page 3 is the one not looked at longest, then page 1.
  const capIds = Object.fromEntries((await tabsOf(w12)).map((t) => [t.url, t.id]));
  for (const i of [2, 0, 4, 1, 3]) {
    await activate(capIds[CAP[i]]);
    await sleep(200);
  }
  const noticeBefore = (await local('autoFoldNotice'))?.at ?? 0;
  await addTab(w12, CAP[5]);
  await addTab(w12, CAP[6]);
  const capped = await until(async () => {
    const t = await tabsOf(w12);
    return t.length === 5 ? t : null;
  }, 15_000);
  check('with 7 tabs, a few seconds later the window is back to 5', !!capped, String((await tabsOf(w12)).length));
  check(
    '…the 2 looked at longest ago were folded (pages 3 and 1)',
    !!capped && !capped.some((t) => t.url === CAP[2] || t.url === CAP[0]) && (await recordsAt(CAP[2])).length === 1 && (await recordsAt(CAP[0])).length === 1,
    JSON.stringify(capped?.map((t) => t.url.split('/').pop())),
  );
  const notice = await until(async () => {
    const n = await local('autoFoldNotice');
    return n && n.at > noticeBefore ? n : null;
  }, 5000);
  check('…the notice says "your 5-tab rule"', notice?.label === 'your 5-tab rule' && notice.folded === 2, JSON.stringify(notice && { label: notice.label, folded: notice.folded }));
  const capToast = await until(async () => (await toasts(ui)).find((t) => /Folded 2 tabs .*\(your 5-tab rule\)/.test(t)), 6000);
  check('the full list: "Folded 2 tabs … (your 5-tab rule)" with Undo', !!capToast && !!(await toastWith(ui, '(your 5-tab rule)', { undo: true, timeout: 1000 })), capToast ?? JSON.stringify(await toasts(ui)));
  await shot(ui, 'list-cap-toast.png');
  popup = await openPopupIn(w1);
  check('the popup says so too', !!(await has(popup, '(your 5-tab rule)', 5000)));
  await shot(popup, 'popup-cap.png');
  await popup.close().catch(() => undefined);
  await focusUi();
  const undone = await toastUndo(ui, '(your 5-tab rule)');
  check('Undo reopens the 2 tabs', undone && !!(await until(async () => (await tabsOf(w12)).length === 7, 8000)), String((await tabsOf(w12)).length));
  await sleep(10_000);
  const after = await tabsOf(w12);
  const noticeAfter = await local('autoFoldNotice');
  check(
    '…and they stay open: the rule doesn’t fold them again (10 s later)',
    after.length === 7 && CAP.every((u) => after.some((t) => t.url === u)),
    `${after.length} tabs open${noticeAfter && notice && noticeAfter.at > notice.at ? `; the rule folded ${noticeAfter.folded} again` : ''}`,
  );
} catch (error) {
  check('the test ran to the end', false, error?.stack ?? String(error));
}

// ---------------------------------------------------------------------------------------------
// 12. No errors in extension pages. A refused command (a Free limit) is logged by the worker as
// "command failed <code>"; those are expected here, anything else is not.
const EXPECTED_REFUSALS = /^\[tabfold\] command failed \S+ (folder-limit|list-full|needs-pro)$/;
const pageErrors = pages.flatMap((p) => p.errors);
const workerErrors = (worker?.errors ?? []).filter((e) => !EXPECTED_REFUSALS.test(e) && !expectedWorkerErrors.has(e));
check('no errors in extension pages', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
check('no unexpected errors in the worker', workerErrors.length === 0, workerErrors.slice(0, 3).join(' | '));

await browser.close();
for (const server of servers) server.close();
rmSync(userDataDir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
