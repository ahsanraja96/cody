// The Chrome Web Store images for Tabfold: five 1280 × 800 screenshots and the 440 × 280 small promo
// tile, saved to store/images/ (not committed: store/.gitignore). Run from the repository root:
//
//   node store/screenshots.mjs                    builds a store-like copy into store/.build, then shoots
//   node store/screenshots.mjs --use-build        uses .output/chrome-mv3 as it is (run `npm run build` first)
//   node store/screenshots.mjs --use-build=<dir>  uses another build
//   node store/screenshots.mjs --out=<dir>        writes somewhere else than store/images
//
// It starts Chromium with a fresh profile (launchChrome from e2e/cdp.mjs; set CHROME_PATH if it
// can't find one), writes realistic demo data into the extension (three folders, one starred with a
// note, folded tabs of every kind of site, a few folds over the last two weeks), opens two named
// windows of real-looking pages (their requests are answered locally, so nothing goes to the
// internet), and photographs: 1 the full list, 2 the popup shown large on a quiet background, 3 the
// side panel next to a page, 4 folders and dragging a tab onto one, 5 the plans page. Each shot waits
// for its content; a screen that isn't there yet (the 1.0 side panel, say) is skipped and the summary
// at the end says so. Exit code 1 only when Chromium or the build fails.
//
// The build uses a placeholder server address (WXT_TABFOLD_API, unless you set your own) so the plans
// page shows the store copy's plans. It never signs in, so nothing calls that address.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome } from '../e2e/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};
const OUT = path.resolve(typeof flag('out') === 'string' ? flag('out') : path.join(ROOT, 'store/images'));
const useBuild = flag('use-build');
const EXT = useBuild
  ? path.resolve(typeof useBuild === 'string' ? useBuild : path.join(ROOT, '.output/chrome-mv3'))
  : path.join(ROOT, 'store/.build/chrome-mv3');
mkdirSync(OUT, { recursive: true });

const saved = [];
const skipped = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 10_000, step = 200) {
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
// The build

if (!useBuild) {
  console.log('Building Tabfold into store/.build …');
  const built = spawnSync('npx', ['wxt', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      TABFOLD_OUT_DIR: path.join(ROOT, 'store/.build'),
      WXT_TABFOLD_API: process.env.WXT_TABFOLD_API || 'https://your-project-id.supabase.co/functions/v1/tabfold',
    },
  });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
if (!existsSync(path.join(EXT, 'manifest.json'))) {
  console.error(`No extension at ${EXT}: run \`npm run build\` first, or leave out --use-build.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Demo data

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();

const FOLDERS = [
  {
    id: 'demofolder01',
    name: 'Checkout app',
    color: 'blue',
    starredAt: NOW - 3 * DAY,
    note: 'Ship the webhook retries before Friday',
    tabs: [
      ['https://github.com/acme-shop/checkout/pull/412', 'Retry failed webhooks with backoff · Pull Request #412 · acme-shop/checkout'],
      ['https://docs.stripe.com/webhooks', 'Receive Stripe events in your webhook endpoint | Stripe Documentation'],
      ['https://supabase.com/dashboard/project/checkout/editor', 'Table editor · checkout · Supabase'],
      ['https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', 'Fetch API - Web APIs | MDN'],
      ['https://vercel.com/acme-shop/checkout/deployments', 'Deployments – checkout – Vercel'],
      ['https://linear.app/acme/issue/CHK-88', 'CHK-88 Webhook retries drop events after deploy'],
      ['https://stackoverflow.com/questions/58210051', 'How to verify a webhook signature with the raw body in Express? - Stack Overflow'],
    ],
  },
  {
    id: 'demofolder02',
    name: 'Holiday in Lisbon',
    color: 'green',
    note: 'Flights booked · still need a flat in Alfama',
    tabs: [
      ['https://www.airbnb.com/rooms/alfama-terrace', 'Sunny flat with a terrace in Alfama - Lisbon'],
      ['https://www.booking.com/hotel/pt/memmo-alfama.html', 'Memmo Alfama, Lisbon – Updated prices'],
      ['https://www.timeout.com/lisbon/restaurants/best-restaurants-in-lisbon', 'The 30 best restaurants in Lisbon right now'],
      ['https://www.google.com/maps/place/Miradouro+de+Santa+Luzia', 'Miradouro de Santa Luzia - Google Maps'],
      ['https://www.lonelyplanet.com/portugal/lisbon/alfama', 'Alfama travel guide - Lisbon'],
    ],
  },
  {
    id: 'demofolder03',
    name: 'Kitchen renovation',
    color: 'orange',
    tabs: [
      ['https://www.ikea.com/us/en/cat/countertops-700603/', 'Countertops - IKEA'],
      ['https://www.pinterest.com/search/pins/?q=green%20kitchen%20tiles', 'Green kitchen tiles - Pinterest'],
      ['https://www.youtube.com/watch?v=kitchen-fitting', 'How to fit a kitchen worktop in a weekend - YouTube'],
      ['https://www.houzz.com/photos/kitchen-ideas', 'Kitchen design ideas - Houzz'],
    ],
  },
];

/** Folded tabs grouped by kind of site (no folder), newest first within each fold. */
const LOOSE = [
  ['https://github.com/vercel/next.js/discussions/61234', 'Route handlers and streaming · vercel/next.js · Discussion'],
  ['https://react.dev/reference/react/useOptimistic', 'useOptimistic – React'],
  ['https://docs.google.com/document/d/q4-plan', 'Q4 planning – Google Docs'],
  ['https://www.notion.so/acme/Launch-checklist', 'Launch checklist'],
  ['https://www.figma.com/design/checkout-flow', 'Checkout flow v3 – Figma'],
  ['https://mail.google.com/mail/u/0/#inbox', 'Inbox (12) - sam@acme.shop - Gmail'],
  ['https://app.slack.com/client/T01/C02', 'design-review (Channel) - Acme - Slack'],
  ['https://news.ycombinator.com/item?id=41234567', 'Show HN: A tiny local-first sync engine | Hacker News'],
  ['https://www.linkedin.com/jobs/view/senior-frontend', 'Senior Frontend Engineer | LinkedIn'],
  ['https://www.youtube.com/watch?v=design-systems', 'Design systems at scale – Config 2026 - YouTube'],
  ['https://claude.ai/chat/naming-ideas', 'Naming ideas for the checkout redesign - Claude'],
  ['https://www.amazon.com/dp/B0C-standing-desk', 'Electric standing desk, 140 × 70 cm : Amazon.com'],
  ['https://www.theverge.com/2026/10/9/browser-tabs', 'Why we all have too many tabs open | The Verge'],
  ['https://medium.com/@acme/local-first', 'What local-first software gets right | Medium'],
  ['https://en.wikipedia.org/wiki/Alfama', 'Alfama - Wikipedia'],
  ['https://www.nytimes.com/2026/10/08/travel/lisbon.html', '36 Hours in Lisbon - The New York Times'],
  ['https://arstechnica.com/gadgets/2026/10/browser-memory', 'How much memory does a browser tab really use? | Ars Technica'],
];

/** Two windows of open pages, named, for the open windows and the side panel. */
const OPEN_WINDOWS = [
  {
    name: 'Client work',
    pages: [
      ['https://github.com/acme-shop/checkout/issues/431', 'Payment sheet flickers on Safari · Issue #431 · acme-shop/checkout'],
      ['https://docs.stripe.com/payments/checkout', 'Stripe Checkout | Stripe Documentation'],
      ['https://www.figma.com/design/checkout-flow', 'Checkout flow v3 – Figma'],
      ['https://linear.app/acme/view/sprint-42', 'Sprint 42 · Acme'],
      ['https://docs.stripe.com/payments/checkout', 'Stripe Checkout | Stripe Documentation'],
    ],
  },
  {
    name: 'Weekend',
    pages: [
      ['https://lisbon-notes.example/alfama-in-three-days', 'Three slow days in Alfama · Lisbon notes'],
      ['https://www.tapairportugal.com/en/book', 'Book flights to Lisbon | TAP Air Portugal'],
      ['https://www.timeout.com/lisbon/things-to-do', 'The best things to do in Lisbon'],
    ],
  },
];

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The page Chromium gets for each demo address: its title, and for the article a page worth showing. */
function demoPage(url) {
  const all = [...FOLDERS.flatMap((f) => f.tabs), ...LOOSE, ...OPEN_WINDOWS.flatMap((w) => w.pages)];
  const title = all.find(([u]) => u === url)?.[1] ?? new URL(url).hostname;
  if (url.includes('lisbon-notes.example')) return articlePage(title);
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font:16px system-ui;margin:40px;color:#222"><h1 style="font-size:22px">${escapeHtml(title)}</h1></body>`;
}

function articlePage(title) {
  const p = (text) => `<p>${text}</p>`;
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  html { overflow: hidden; }
  body { margin: 0; font: 17px/1.65 Georgia, 'Times New Roman', serif; color: #2b2622; background: #fbf8f3; }
  header { padding: 18px 48px; border-bottom: 1px solid #e8e0d4; font: 600 15px system-ui, sans-serif; letter-spacing: .02em; color: #8a5a2b; }
  main { max-width: 640px; margin: 0 auto; padding: 36px 32px 60px; }
  .kicker { font: 600 12px system-ui, sans-serif; text-transform: uppercase; letter-spacing: .12em; color: #b0703a; }
  h1 { font-size: 38px; line-height: 1.15; margin: 10px 0 14px; }
  .by { font: 14px system-ui, sans-serif; color: #7d7268; margin-bottom: 26px; }
  .hero { height: 250px; border-radius: 10px; margin-bottom: 28px;
    background: linear-gradient(160deg, #f3c58a 0%, #e8956b 38%, #b85c5c 64%, #5d4a7a 100%); position: relative; overflow: hidden; }
  .hero::after { content: ''; position: absolute; inset: auto 0 0 0; height: 110px;
    background: repeating-linear-gradient(90deg, #6b4a3a 0 34px, #7d5844 34px 58px, #5e4033 58px 96px); clip-path: polygon(0 40%, 8% 30%, 15% 45%, 24% 20%, 33% 38%, 42% 25%, 53% 42%, 61% 18%, 70% 36%, 80% 22%, 90% 40%, 100% 28%, 100% 100%, 0 100%); }
</style>
<header>Lisbon notes</header>
<main>
  <div class="kicker">Neighbourhoods</div>
  <h1>Three slow days in Alfama</h1>
  <div class="by">By Inês Duarte · 9 min read</div>
  <div class="hero"></div>
  ${p('Alfama is the oldest part of Lisbon, and the best way to see it is to give up on seeing it all. The streets climb, fold back on themselves and end in staircases; the trick is to pick a viewpoint for each evening and wander towards it.')}
  ${p('Start at the Miradouro de Santa Luzia in the morning, when the tiles are in shade and the trams are still half empty. From there, take the stairs down towards the river and stop for a coffee wherever the smell of grilled sardines starts.')}
  ${p('On the second day, book a fado dinner early: the small houses fill up by eight, and the best seats are by the door, where the street joins in.')}
</main>`;
}

const DEMO_ORIGINS = [
  ...new Set([...FOLDERS.flatMap((f) => f.tabs), ...LOOSE, ...OPEN_WINDOWS.flatMap((w) => w.pages)].map(([u]) => new URL(u).origin)),
];

// ---------------------------------------------------------------------------------------------
// Chromium

const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tabfold-store-'));
const workDir = mkdtempSync(path.join(os.tmpdir(), 'tabfold-store-work-'));
let browser;
try {
  browser = await launchChrome({ extensionDir: EXT, userDataDir, width: 1280, height: 800 });
} catch (error) {
  console.error(`Chromium didn't start: ${error.message}`);
  process.exit(1);
}

// Every request to a demo site is answered here: real addresses and titles, no internet.
browser.on((message) => {
  if (message.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = message.params;
  const html = demoPage(request.url.split('#')[0]);
  browser
    .send(
      'Fetch.fulfillRequest',
      {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
        body: Buffer.from(html).toString('base64'),
      },
      message.sessionId,
    )
    .catch(() => undefined);
});
await browser.send('Fetch.enable', { patterns: DEMO_ORIGINS.map((origin) => ({ urlPattern: `${origin}/*`, requestStage: 'Request' })) });

const extId = await browser.extensionId();
const ext = (p) => `chrome-extension://${extId}/${p}`;
const control = await browser.openPage(ext('library.html'), { width: 1280, height: 800 });
await control.colorScheme('light');
const send = (command) => control.evaluate((c) => new Promise((res) => chrome.runtime.sendMessage({ __tabfold: true, command: c }, res)), command);

/** Writes the demo folders and folds straight into the extension's IndexedDB, as the e2e tests do. */
async function seed() {
  const folds = [];
  const sessionOf = (index, name, createdAt, tabs) => ({ id: `demofold${String(index).padStart(4, '0')}`, name, createdAt, tabs });
  FOLDERS.forEach((folder, i) => folds.push(sessionOf(i, '', NOW - (i * 2 + 1) * DAY, folder.tabs.map(([url, title]) => ({ url, title, folderId: folder.id })))));
  folds.push(sessionOf(7, '', NOW - 2 * HOUR, LOOSE.slice(0, 9).map(([url, title]) => ({ url, title }))));
  folds.push(sessionOf(8, '', NOW - 26 * HOUR, LOOSE.slice(9).map(([url, title]) => ({ url, title }))));
  const folders = FOLDERS.map((f, order) => ({
    id: f.id,
    name: f.name,
    color: f.color,
    order,
    createdAt: NOW - 14 * DAY,
    updatedAt: NOW - DAY,
    deletedAt: 0,
    source: 'person',
    ...(f.starredAt ? { starredAt: f.starredAt } : {}),
    ...(f.note ? { note: f.note, noteAt: NOW - DAY } : {}),
  }));
  await control.evaluate(
    async ([folds, folders]) => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('tabfold');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const stores = ['sessions', 'windows', 'tabs', 'meta', 'folders'].filter((s) => db.objectStoreNames.contains(s));
      const tx = db.transaction(stores, 'readwrite');
      if (stores.includes('folders')) for (const folder of folders) tx.objectStore('folders').put(folder);
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
          deviceId: 'store-demo',
          version: 1,
          tabCount: fold.tabs.length,
          windowCount: 1,
          preview: fold.tabs.slice(0, 3).map((t) => ({ url: t.url, title: t.title })),
        });
        tx.objectStore('windows').put({ id: `${fold.id}w0`, sessionId: fold.id, name: '', order: 0, wasFocused: false, bounds: null, state: null });
        fold.tabs.forEach((t, i) =>
          tx.objectStore('tabs').put({
            id: `${fold.id}t${String(i).padStart(2, '0')}`,
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
            savedAt: fold.createdAt - i * 60_000,
            keywords: [],
            urlTruncated: false,
            ...(t.folderId ? { folderId: t.folderId, placedAt: fold.createdAt } : {}),
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
    },
    [folds, folders],
  );
}

/** Opens the demo windows and names them (the 1.0 command, else the names the screens read). */
async function openWindows() {
  for (const win of OPEN_WINDOWS) {
    const id = await control.evaluate((urls) => chrome.windows.create({ url: urls, focused: false }).then((w) => w.id), win.pages.map(([u]) => u));
    const renamed = await send({ type: 'window-rename', windowId: id, name: win.name }).catch(() => null);
    if (!renamed?.ok) {
      await control.evaluate(
        ([windowId, name]) => chrome.storage.session.get('windowNames').then((r) => chrome.storage.session.set({ windowNames: { ...(r.windowNames ?? {}), [windowId]: name } })),
        [id, win.name],
      );
    }
  }
  const titles = OPEN_WINDOWS.flatMap((w) => w.pages.map(([, t]) => t));
  await until(() => control.evaluate((t) => chrome.tabs.query({}).then((tabs) => t.every((title) => tabs.some((tab) => tab.title === title))), titles), 15_000);
}

// Tidy the browser: the welcome tab that opens on install goes.
await until(() => control.evaluate(() => chrome.tabs.query({}).then((t) => t.some((x) => (x.url ?? '').includes('onboarding.html')))), 5000);
await control.evaluate(() => chrome.tabs.query({}).then((t) => chrome.tabs.remove(t.filter((x) => (x.url ?? '').includes('onboarding.html')).map((x) => x.id))));
await seed();
await openWindows();

// ---------------------------------------------------------------------------------------------
// Shooting

const textOf = (page) => page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
const hasText = (page, text, timeout = 8000) => until(async () => (await textOf(page)).includes(text), timeout);

async function capture(page, file, { fullPage = false } = {}) {
  await page.send('Page.bringToFront').catch(() => undefined);
  await sleep(300);
  await page.screenshot(file, { fullPage });
}

async function metrics(page, width, height, scale = 1) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
}

/** A PNG's size, from its header. */
function pngSize(file) {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function keep(name, expected) {
  const file = path.join(OUT, name);
  const size = pngSize(file);
  if (size.width !== expected.width || size.height !== expected.height) {
    skipped.push(`${name}: came out ${size.width} × ${size.height}, not ${expected.width} × ${expected.height}`);
    return;
  }
  saved.push(name);
}

/**
 * The full list is laid out at 1440 × 900 (wide enough for its left column of folders) and
 * photographed at 1280 × 800, the store's size.
 */
const LIST = { width: 1440, height: 900, scale: 1280 / 1440 };

/** Opens an extension page in its own tab at a size, light. */
async function openExt(p, width, height, scale = 1) {
  const page = await browser.openPage('about:blank', { width, height });
  await metrics(page, width, height, scale);
  await page.colorScheme('light');
  await page.goto(ext(p));
  return page;
}

/** Renders an HTML file (which may use images from workDir) at 1280 × 800 and saves it. */
async function compose(name, html, size = { width: 1280, height: 800 }) {
  const file = path.join(workDir, `${name}.html`);
  writeFileSync(file, html);
  const page = await browser.openPage('about:blank', size);
  await metrics(page, size.width, size.height, 1);
  await page.goto(pathToFileURL(file).href);
  await page.waitFor(() => [...document.images].every((img) => img.complete), undefined, 5000);
  await sleep(200);
  await capture(page, path.join(OUT, name));
  await page.close().catch(() => undefined);
  keep(name, size);
}

const FONT = `font-family: Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;`;
const BG = `background: radial-gradient(120% 140% at 0% 0%, #eef0fb 0%, #f6f6f8 55%, #ececf2 100%);`;
const LOGO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="9" width="16" height="11" rx="2.5"/><path d="M7 5.5h10"/><path d="M9.5 2.5h5"/></svg>`;
const caption = (title, text) => `
  <div style="display:flex;align-items:center;gap:10px;font-weight:600;font-size:17px;color:#17171a">
    <span style="width:30px;height:30px;border-radius:8px;background:#4f5bd5;display:flex;align-items:center;justify-content:center">${LOGO}</span>Tabfold
  </div>
  <h1 style="margin:26px 0 12px;font-size:40px;line-height:1.12;font-weight:650;letter-spacing:-.015em;color:#17171a">${title}</h1>
  <p style="margin:0;font-size:18px;line-height:1.5;color:#4c4c55">${text}</p>`;

async function shotFullList() {
  const name = '1-full-list.png';
  const page = await openExt('library.html', LIST.width, LIST.height, LIST.scale);
  if (!(await hasText(page, 'Checkout app', 10_000))) {
    skipped.push(`${name}: the full list didn't show the demo folders`);
    return page;
  }
  await hasText(page, 'Client work', 3000);
  await sleep(800);
  await capture(page, path.join(OUT, name));
  keep(name, { width: 1280, height: 800 });
  return page;
}

async function shotPopup() {
  const name = '2-popup.png';
  const page = await openExt('popup.html', 400, 600, 2);
  if (!(await hasText(page, 'Fold', 8000))) {
    skipped.push(`${name}: the popup didn't load`);
    await page.close().catch(() => undefined);
    return;
  }
  await sleep(1200);
  await capture(page, path.join(workDir, 'popup.png'));
  await page.close().catch(() => undefined);
  await compose(
    name,
    `<!doctype html><meta charset="utf-8"><body style="margin:0;width:1280px;height:800px;overflow:hidden;${BG}${FONT}">
    <div style="position:absolute;left:96px;top:236px;width:520px">${caption('Fold a window in one click.', 'Your tabs go into one list and Chrome gets their memory back. Undo for 10 seconds; find any of them again later.')}</div>
    <img src="popup.png" style="position:absolute;right:120px;top:100px;width:400px;height:600px;border-radius:12px;box-shadow:0 2px 6px rgba(16,16,20,.08),0 24px 60px rgba(16,16,20,.18);border:1px solid #d4d4da">
    </body>`,
  );
}

async function shotSidePanel() {
  const name = '3-side-panel.png';
  // Chrome's real side panel, opened in the "Weekend" window next to the article it's shown beside
  // (sidePanel.open needs a click: a real one, on a button put into the control page). Falls back
  // to the panel page as a tab when Chrome won't open the panel.
  const weekend = await control.evaluate(() =>
    chrome.windows.getAll({ populate: true }).then((all) => {
      const win = all.find((w) => w.tabs?.some((t) => (t.url ?? '').includes('lisbon-notes.example')));
      const article = win?.tabs?.find((t) => (t.url ?? '').includes('lisbon-notes.example'));
      return win && article ? { windowId: win.id, articleTabId: article.id } : null;
    }),
  );
  const url = ext('sidepanel.html');
  let panel;
  if (weekend) {
    await control.evaluate((id) => chrome.tabs.update(id, { active: true }), weekend.articleTabId);
    await control.send('Page.bringToFront').catch(() => undefined);
    const box = await control.evaluate((windowId) => {
      const button = document.createElement('button');
      button.id = 'tf-open-panel';
      button.textContent = 'open panel';
      button.style.cssText = 'position:fixed;left:10px;top:10px;width:120px;height:40px;z-index:99999';
      button.onclick = () => void chrome.sidePanel.open({ windowId });
      document.body.append(button);
      const r = button.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, weekend.windowId);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await control.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await control.evaluate(() => document.getElementById('tf-open-panel')?.remove());
    const target = await until(async () => (await browser.targets()).find((t) => t.url === url), 8000, 200);
    if (target) {
      panel = await browser.attach(target.targetId, { width: 360, height: 764 });
      await metrics(panel, 360, 764, 2);
      await panel.colorScheme('light');
    }
  }
  const real = !!panel;
  panel ??= await openExt('sidepanel.html', 360, 764, 2);
  await sleep(1500);
  const text = (await textOf(panel)).trim();
  // The placeholder says only "Tabfold"; the real panel lists open and folded tabs.
  const ready = text.length > 40 && /Checkout app|Client work/.test(text);
  if (!ready) {
    skipped.push(`${name}: the side panel isn't built in this copy yet (it shows only "${text.slice(0, 40)}")`);
    await panel.close().catch(() => undefined);
    return;
  }
  if (!real) skipped.push(`${name}: saved, but Chrome didn't open its side panel, so the panel is shown as a tab (it lists itself)`);
  await panel.screenshot(path.join(workDir, 'panel.png'));
  if (!real) await panel.close().catch(() => undefined);
  const article = await browser.openPage('about:blank', { width: 920, height: 800 });
  await article.goto('https://lisbon-notes.example/alfama-in-three-days');
  await sleep(500);
  await capture(article, path.join(workDir, 'article.png'));
  await article.close().catch(() => undefined);
  await compose(
    name,
    `<!doctype html><meta charset="utf-8"><body style="margin:0;width:1280px;height:800px;overflow:hidden;background:#fff;${FONT}">
    <img src="article.png" style="position:absolute;left:0;top:0;width:920px;height:800px">
    <div style="position:absolute;left:920px;top:0;width:359px;height:800px;border-left:1px solid #d4d4da;background:#fff">
      <div style="height:36px;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid #e6e6ea;font-size:13px;font-weight:600;color:#3c4043">
        <span style="width:16px;height:16px;border-radius:4px;background:#4f5bd5;display:flex;align-items:center;justify-content:center">${LOGO.replace('width="18" height="18"', 'width="11" height="11"')}</span>Tabfold
        <span style="margin-left:auto;color:#5f6368;font-size:16px;font-weight:400">×</span>
      </div>
      <img src="panel.png" style="display:block;width:360px;height:764px">
    </div>
    </body>`,
  );
}

async function shotFoldersDrag(list) {
  const name = '4-folders-drag.png';
  if (!list) {
    skipped.push(`${name}: no full list`);
    return;
  }
  await list.goto(ext('library.html'));
  if (!(await hasText(list, 'Holiday in Lisbon', 10_000))) {
    skipped.push(`${name}: the full list didn't show the demo folders`);
    return;
  }
  await sleep(800);
  // Hold a folded tab ("Alfama - Wikipedia", under Reading) over the "Holiday in Lisbon" folder: in
  // the left column when there is one, else its heading in the list. The list only draws the rows
  // on screen, so go to Reading first (its link in the left column, else scroll down to it).
  const TITLES = ['Alfama - Wikipedia', '36 Hours in Lisbon - The New York Times'];
  const FOLDER = 'Holiday in Lisbon';
  const rowShown = () =>
    list.evaluate((titles) => [...document.querySelectorAll('[draggable=true]')].some((e) => titles.some((t) => (e.innerText ?? '').includes(t))), TITLES);
  await list.evaluate(() => {
    const link = [...document.querySelectorAll('nav a, aside a, [role=navigation] a')].find((e) => (e.innerText ?? '').trim().startsWith('Reading'));
    link?.click();
  });
  await sleep(600);
  for (let step = 0; step < 20 && !(await rowShown()); step += 1) {
    await list.evaluate(() => {
      const scrollers = [document.scrollingElement, ...document.querySelectorAll('main, [data-scroll], div')].filter(
        (e) => e && e.scrollHeight > e.clientHeight + 10 && getComputedStyle(e).overflowY !== 'hidden',
      );
      for (const el of scrollers.slice(0, 3)) el.scrollTop += 500;
    });
    await sleep(250);
  }
  const dragged = await list.evaluate(([titles, folder]) => {
    const text = (e) => (e.innerText ?? '').trim();
    const draggables = () => [...document.querySelectorAll('[draggable=true]')];
    const findRow = () => {
      for (const title of titles) {
        // The smallest draggable with the title: the row, not a section around it.
        const row =
          draggables()
            .filter((e) => text(e).includes(title))
            .sort((a, b) => text(a).length - text(b).length)[0] ??
          [...document.querySelectorAll('[aria-label]')].find((e) => (e.getAttribute('aria-label') ?? '').includes(title))?.closest('[draggable=true]');
        if (row) return row;
      }
      return null;
    };
    const row = findRow();
    const named = (e) => text(e).split('\n')[0].trim() === folder || e.querySelector?.('span[dir=auto]')?.textContent === folder;
    const target =
      [...document.querySelectorAll('nav a, nav button, aside a, aside button, [role=navigation] a')].find(named) ??
      [...document.querySelectorAll('h2 button[aria-expanded], h3 button[aria-expanded]')].find(named) ??
      null;
    if (!row || !target) return { row: !!row, target: !!target };
    const dataTransfer = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer });
    target.dispatchEvent(over);
    // Chromium doesn't paint the drag image in a screenshot: draw the row being carried instead.
    const box = target.getBoundingClientRect();
    const ghost = row.cloneNode(true);
    const width = Math.min(row.getBoundingClientRect().width, 520);
    // Beside a left-column folder; under a heading in the list.
    const beside = box.right + 18 + width < window.innerWidth;
    Object.assign(ghost.style, {
      position: 'fixed',
      left: `${beside ? box.right + 18 : box.left + 40}px`,
      top: `${beside ? box.top + box.height / 2 - 6 : box.bottom + 4}px`,
      width: `${width}px`,
      zIndex: 2147483647,
      pointerEvents: 'none',
      opacity: '0.96',
      background: getComputedStyle(document.body).backgroundColor || '#fff',
      borderRadius: '8px',
      boxShadow: '0 2px 6px rgba(16,16,20,.10), 0 16px 40px rgba(16,16,20,.20)',
      transform: 'rotate(-1.5deg)',
    });
    ghost.setAttribute('aria-hidden', 'true');
    document.body.appendChild(ghost);
    return { row: true, target: true, accepts: over.defaultPrevented };
  }, [TITLES, FOLDER]);
  if (!dragged.row || !dragged.target) skipped.push(`${name}: saved without the drag (couldn't find ${dragged.row ? 'the folder to drop on' : 'the tab to drag'})`);
  else if (!dragged.accepts) skipped.push(`${name}: the folder didn't take the dragged tab, so it shows no drop highlight`);
  await sleep(400);
  await capture(list, path.join(OUT, name));
  keep(name, { width: 1280, height: 800 });
  // Let go, so nothing moves.
  await list.evaluate(() => document.querySelectorAll('[draggable=true]').forEach((e) => e.dispatchEvent(new DragEvent('dragend', { bubbles: true })))).catch(() => undefined);
}

async function shotPlans(list) {
  const name = '5-plans.png';
  const page = list ?? (await openExt('library.html', LIST.width, LIST.height, LIST.scale));
  await page.goto(ext('library.html#/pro'));
  // A fresh page: nothing left over from the drag shot (only the hash changed).
  await page.send('Page.reload').catch(() => undefined);
  await sleep(800);
  const ready = await until(async () => /Pro AI/.test(await textOf(page)) && /\$\s?\d/.test(await textOf(page)), 10_000);
  if (!ready) {
    skipped.push(`${name}: the plans page didn't show the plans and prices`);
    return;
  }
  if ((await textOf(page)).includes('isn’t switched on')) skipped.push(`${name}: saved, but this build has no server address, so the page says Pro isn’t switched on`);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll('*')) if (el.scrollTop > 0) el.scrollTop = 0;
  });
  await sleep(800);
  await capture(page, path.join(OUT, name));
  keep(name, { width: 1280, height: 800 });
}

async function promoTile() {
  const name = 'promo-small-440x280.png';
  const row = (color, text, count) => `
    <div style="display:flex;align-items:center;gap:9px;height:30px;padding:0 10px;border-radius:7px;background:#fff;box-shadow:0 1px 2px rgba(16,16,20,.06);font-size:12.5px;color:#17171a">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
      <span style="font-weight:600">${text}</span><span style="margin-left:auto;color:#6b6b75">${count}</span>
    </div>`;
  await compose(
    name,
    `<!doctype html><meta charset="utf-8"><body style="margin:0;width:440px;height:280px;overflow:hidden;background:linear-gradient(150deg,#5b66dd 0%,#4f5bd5 45%,#3d48b8 100%);${FONT}">
    <div style="position:absolute;left:28px;top:30px;display:flex;align-items:center;gap:10px;color:#fff;font-weight:650;font-size:22px">
      <span style="width:36px;height:36px;border-radius:10px;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center">${LOGO.replace('width="18" height="18"', 'width="20" height="20"')}</span>Tabfold
    </div>
    <div style="position:absolute;left:28px;top:96px;width:190px;color:#fff;font-size:21px;line-height:1.25;font-weight:650;letter-spacing:-.01em">Fold your tabs, find them later.</div>
    <div style="position:absolute;left:28px;top:186px;width:180px;color:rgba(255,255,255,.82);font-size:12.5px;line-height:1.45">One list, folders, and the memory back.</div>
    <div style="position:absolute;right:24px;top:58px;width:180px;display:flex;flex-direction:column;gap:7px;padding:12px;border-radius:12px;background:rgba(255,255,255,.16)">
      ${row('#1a73e8', 'Checkout app', 7)}${row('#188038', 'Lisbon', 5)}${row('#fa903e', 'Kitchen', 4)}${row('#a142f4', 'AI', 1)}${row('#d93025', 'Video', 1)}
    </div>
    </body>`,
    { width: 440, height: 280 },
  );
}

let list = null;
for (const [label, step] of [
  ['full list', async () => (list = await shotFullList())],
  ['popup', shotPopup],
  ['side panel', shotSidePanel],
  ['folders and drag', () => shotFoldersDrag(list)],
  ['plans', () => shotPlans(list)],
  ['promo tile', promoTile],
]) {
  try {
    await step();
  } catch (error) {
    skipped.push(`${label}: ${error.message.split('\n')[0]}`);
  }
}

await browser.close();
rmSync(userDataDir, { recursive: true, force: true });
rmSync(workDir, { recursive: true, force: true });

const shown = path.relative(ROOT, OUT);
console.log(`\nSaved in ${shown && !shown.startsWith('..') ? shown : OUT}:`);
for (const name of saved) console.log(`  ${name}`);
if (skipped.length) {
  console.log('\nSkipped or not quite right:');
  for (const line of skipped) console.log(`  ${line}`);
}
