# Tabfold

A minimal Chrome extension that takes the load off your browser: **fold** your tabs to free memory, find them again in **one list** sorted by kind of site, and see the **same list on your other computers**. Promise: *fold your tabs, find them later.*

Design: [Tabfold design canvas](https://claude.ai/artifact/MGqcUEKEqHvcmZdSboDKP3) (the minimal design: popup, full list, settings, welcome, the memory bar and small states, light and dark). The earlier, fuller design is kept in the canvas project files for reference.

## What it does

- **The side panel** (1.0): Tabfold in Chrome's side panel stays open while you browse: search, your open tabs by window (click to switch, × to close), folders (starred first, with their notes) and kinds of site. Drag an open tab onto a folder to fold it in. Settings › "Toolbar button opens: The popup / The side panel" (the Open Tabfold shortcut follows it); the popup's side panel button opens it once.
- **Fold**: the popup and the full list show your open windows first. With one window open, Fold saves every tab in it, then closes them; with several, it asks "Just this window" or "All windows" (each window also has its own Fold). Folding the window you're in leaves it open with a new tab. Pinned tabs (setting) and tabs playing sound stay open, and so do app and pop-up windows; Tabfold's own pages close without being saved (except the one you folded from); Incognito windows only with "Fold Incognito windows too"; tabs already in the list aren't saved twice. The popup says what stayed open and why. Tabs close only after the save is written, in batches, with live progress in the popup and the full list (a popup closed mid-fold picks it back up). Pages that show Chrome's "Leave site?" are named with "Show tab" and are saved either way. Undo for 10 seconds. Shortcut: Ctrl/⌘+Shift+S (with several windows open it opens Tabfold already asking; Enter folds this window).
- **Fold into a folder** (1.0): the popup's Fold ▾, each window's ⋯ › Fold into…, and right-click › "Fold this tab into ›" (starred and recent folders, or "Choose a folder…") put what you fold straight into a folder, or a new one. **Fold back**: a folder opened with "Open all" becomes a Chrome tab group; folding it later puts its tabs, including ones you added, back into that folder ("Folded 12 tabs · 5 went back into Client sites").
- **Open windows** (1.0): name a window ("Client work") by clicking its name; the name comes back after Chrome restarts, and folding the window names the fold after it. "3 pages are open twice · Close the copies" closes the extra copies (keeping the one you looked at last; Undo). A window's ⋯ › "Tidy into groups" puts its loose tabs into Chrome tab groups by kind of site (Undo).
- **Memory**: the popup shows the estimated memory in use (about 48 MB per loaded tab; Chrome doesn't tell extensions per-tab memory) as a bar with one segment per open tab, and after a fold the real change in the computer's free memory (chrome.system.memory). Idle tabs go to sleep after 30 minutes with Chrome's own discard; pinned, playing and active tabs never do. A "How Tabfold frees memory" page explains it.
- **One list, with folders**: your named folders come first (in the list and in a column on the left), then every other folded tab grouped by kind of site (Dev, Docs, Mail & chat, Social, Video, AI, Shopping, Reading, Other), newest first. Make a folder from the left column or "New folder", rename it (double-click), give it a colour, delete it (its tabs go back by site; Undo). Move tabs by dragging them onto a folder or a kind of site, or with a tab's ⋯ menu (right-click, Shift+F10): Move to a folder, Out of its folder, or Kind of site, which Tabfold remembers for that site from then on (Settings › "Sites you moved" puts them back). Click a tab to open it (it stays in the list), × removes it (Undo), "Open all" opens a group as a Chrome tab group with the same name and colour. "Recent folds" reopens a fold as its original windows, or deletes it (Undo).
- **Search**: open and folded tabs by title, address or keyword (MiniSearch in a web worker), with `#keyword` for keywords only; open tabs come first with their window's name, and Enter switches to one. **Ctrl/⌘+K** in the full list jumps to a folder, an action (New folder, Make room, Find duplicates, Organise with AI, Import…, Settings), an open tab or a folded tab.
- **Snooze**: a tab's ⋯ menu, the popup's search actions, right-click › "Snooze this tab" or Alt+Shift+Z (until tomorrow morning) folds a tab until later today, tomorrow, the weekend, next week, in a month or a time you pick. It reopens in the background on the computer that snoozed it (at the next start if Chrome was closed), and the toolbar icon counts what came back. Snoozed tabs wait in their own section with "Wake now".
- **Fold automatically** (Settings): rules that fold tabs you haven't looked at for some days, cap a window's tabs ("A window has more than 25 tabs": the ones looked at longest ago fold), every evening at a set time, or one site's tabs after some idle minutes, into their kind of site or a folder. Never pinned, playing, active or live-folder tabs. A notice says what a rule folded, with Undo.
- **Same page twice**: Settings › "Find duplicates" lists folded tabs that are the same page and keeps the newest of each (and its folder).
- **Keywords**, hidden until wanted: right-click › "Fold this tab with keywords…" (suggested from the title and address).
- **Same list on every computer**: the newest folded tabs (up to 500, within Chrome's sync quota), your folders and the sites you moved are shared through `chrome.storage.sync`, so they appear wherever the person is signed in to Chrome. No account, no server. Removals travel as tombstones; an emptied store never deletes anything; quota errors back off and retry. Can be turned off in Settings.
- **Restore**: lazy (background tabs load once, muted, then sleep, so they keep their real title, icon and address), with tab groups and pinned tabs rebuilt; failures listed with "Copy links".
- **Safety**: background snapshots and a "Chrome closed unexpectedly. Reopen your tabs?" line after a crash; a record outside IndexedDB detects wiped data and can recover the last snapshot; updates install cleanly; every message to the background must come from Tabfold itself.
- **Import** (Settings › Import…): OneTab, Toby, Workona, Session Buddy, a Chrome bookmarks folder (the bookmarks permission is asked for only then), a list of links (pasted or a file), or any JSON with links. Named collections become folders (on Free while there's room for them; the rest go by site).
- **Stars and notes** (1.0): star a folder to keep it first everywhere (the list, the popup, the side panel, Fold into); give it a one-line note ("Waiting on the client's feedback"). Both sync; a team folder's note is the team's, its star is yours; a shared folder's page shows its note.
- **Weekly summary** (1.0): on Mondays, "Last week you folded 340 tabs and freed about 12 GB. 28 came back when you needed them." at the top of the full list and in the popup (Settings › Weekly summary).
- **Settings**: your plan, the toolbar button, keep pinned tabs open, idle sleep time, Fold automatically, sync, Incognito, theme, import, find duplicates, sites you moved, the weekly tidy-up, and export (a web page; Markdown, CSV and JSON with Pro; folders included), plus "Clear everything", "Remove Tabfold…", "Delete my Tabfold account…" (signed in: cancels the subscription at once and deletes everything the server holds), and links to the privacy policy and terms.
- **Remove Tabfold…** (Settings): before uninstalling, take the tabs along: reopen them all (asleep until clicked), save them to Chrome bookmarks (a "Tabfold · date" folder, sorted by kind of site; the bookmarks permission is asked for only then), or download the web page export. Then Chrome's own confirmation removes the extension.

### Plans

| | Free | Pro | Pro AI | Teams |
| --- | --- | --- | --- | --- |
| Price | free | $5 a month or $48 a year, **or $99 once, for life** | $9 a month or $84 a year (7-day free trial, no card) | $10 a person a month, or $8 a person a month billed yearly ($96) |
| Folded tabs | 500 | unlimited | unlimited | unlimited |
| Folders | 3 | unlimited | unlimited | unlimited, plus team folders |
| Snoozed at a time | 3 | unlimited | unlimited | unlimited |
| Fold automatically | 1 rule (tabs not looked at for some days, or a cap on a window's tabs) | every kind of rule | every kind of rule | every kind of rule |
| Sync | Chrome sync (newest 500) | Tabfold account, every tab, daily backups for 30 days | same | same |
| Live folders, sharing a folder, Markdown/CSV/JSON export | | ✓ | ✓ | ✓ |
| Organise with AI, smart names, Copy as context, Ask your tabs, the weekly tidy-up | | | ✓ | ✓ (everyone on the team) |

- **The free list's 500 tabs**: the count turns amber from 450 ("18 spaces left"). When a fold doesn't fit, nothing is closed and Tabfold says how much room it needs; "Make room" lists the oldest folds to remove (with Undo, or export everything first). Imports and Chrome sync stop at the limit too. Nothing is ever taken away when a plan ends: folders and tabs past Free's limits stay; only adding more waits.
- **Live folders** (Pro): open a folder as a Chrome tab group that stays connected: tabs you add to the group join the folder, tabs you close leave it, pages you move to update it. "Fold the group" closes it and keeps everything. The popup shows "Working in <folder>".
- **Share a folder** (Pro): a public link (`https://tabfold.truewidgets.com/s/…`, the small static site in `web/`) showing the folder's pages with "Open all", "Copy links" and "Save to my Tabfold" (which asks the installed extension to add it as a folder). "Keep it up to date" pushes changes; "Stop sharing" makes the link stop working. Only titles and addresses are shared, never Incognito tabs.
- **Pro AI**: **Organise with AI** puts the newest 300 folded tabs into folders (existing ones when the names match, new ones marked "new"), after a preview; **smart names** for folds ("Checkout app · Stripe webhooks"); **Copy as context for AI** on a folder or group; **Ask your tabs**: a question in search ("where were the flats for our trip") gets "Best matches" with why; **the weekly tidy-up** (Mondays, can be turned off) suggests folders for month-old tabs and removing duplicates, one click each. 300 runs a month. Only titles and sites are sent, never pages, never Incognito tabs.
- **Teams**: one person pays for the team's seats and invites people by email (Settings › Team); they join by signing in to Tabfold with that email, and everyone gets Pro AI. Team folders sit under "Team · <name>" on the left and in the list, with who added what ("Sara added 3 tabs · 2 h ago"). Moving a tab into a team folder shares it with the team; team folders sync between the members, apart from each person's own sync. The owner renames the team, removes people and manages billing; a member can leave. Whoever leaves or is removed sees it once, with "Keep a copy" to keep the team's folders as their own.
- **Paying** happens on Stripe's own checkout page, opened in a tab; when Stripe confirms, that tab turns into a "You're on Tabfold Pro" page ("…for life", or "Your team is ready"). Plan changes, the card, invoices and cancelling go through Stripe's billing page ("Manage billing" in Settings). The account is an email address: signing in and starting the trial use a 6-digit code sent by email, no password and no card. Other computers on the same Chrome profile sign themselves in.
- **Asking for Pro** happens in quiet places only: "Upgrade" in the full list's top bar and the popup's header (Free only), the sync line when more than 500 tabs are folded, a limit when you reach it, "Organise with AI" in the full list, an occasional milestone after a fold (Free only, at most weekly, never in the first 3 days, 30 days quiet after "Not now"), and "Your plan" in Settings. When a plan or the trial ends, the list, folders and backups stay; a one-time notice says what paused.
- **Welcome tab** on install, light and dark themes, keyboard use (every drag has a menu alternative), screen-reader labels.

## Develop

```bash
npm install
npm run dev          # Chrome with hot reload (WXT)
npm run build        # production build in .output/chrome-mv3
npm run build:edge   # Edge build (same code)
npm run zip          # store-ready zip
npm run compile      # TypeScript, strict
npm test             # unit tests (Vitest, fake IndexedDB, fake browser APIs)
npm run e2e          # end-to-end smoke test in real Chromium (run `npm run build` first)
npm run e2e:folders  # end-to-end test of the Free plan's folders, limits, snooze, imports and more (run `npm run build` first)
npm run e2e:v10      # end-to-end test of the 1.0 features: the side panel, Fold into, fold back, copies, tidy, names, cap, stars, notes, summary (run `npm run build` first)
npm run e2e:pro      # end-to-end Pro test: builds a copy against the real server code, a fake Stripe, a fake email service and the share site
npm run icons        # regenerate PNG icons
```

The e2e test needs a Chromium binary: it uses `$CHROME_PATH`, or finds one in `/opt/pw-browsers` or common install paths. It drives Chromium over the DevTools protocol directly rather than through Playwright, because Playwright attaches to every tab and drops the browser connection when a tab it watches is discarded.

Load the build by hand: `chrome://extensions` → Developer mode → Load unpacked → `.output/chrome-mv3`.

### Going live

[`LAUNCH.md`](LAUNCH.md) is the go-live checklist, in order: the server, Stripe live mode, email, the AI key, the public site (`web/`, with the privacy policy and terms), the store build, the Chrome Web Store listing (`store/`: listing text, privacy practices, `node store/screenshots.mjs` for the images) and a live smoke test.

### Building with Pro switched on

Pro needs the Tabfold server, a Stripe account and a mailbox to send email from (Zoho Mail, over SMTP); [`server/README.md`](server/README.md) sets them all up from nothing. Then build with the server's address (in the environment or a `.env` file):

```bash
WXT_TABFOLD_API=https://<project id>.supabase.co/functions/v1/tabfold npm run zip
```

Without it the build is Free: the Pro screens still show, say "Pro isn't switched on in this build yet", and nothing talks to a server. The extension's content security policy only allows that server address; Stripe's pages open in ordinary tabs.

Shared folders open on the public site in `web/` (see [`web/README.md`](web/README.md); the owner deploys it to Vercel). If it isn't at `https://tabfold.truewidgets.com`, build with its address so its "Save to my Tabfold" button may talk to the extension (`externally_connectable`, no install warning):

```bash
WXT_TABFOLD_API=https://<project id>.supabase.co/functions/v1/tabfold WXT_SHARE_ORIGIN=https://<your share site> npm run zip
```

## How it fits together

| Part | Where | Notes |
| --- | --- | --- |
| Service worker | `src/lib/background/` | Owns every tab and window action (save, close, restore, suspend), snapshots, alarms, context menus and shortcuts. Keeps no state in memory between wake-ups. |
| Data | `src/lib/db.ts`, `src/lib/repo.ts`, `src/lib/folders.ts` | IndexedDB through Dexie: one row per session, window, tab and folder, plus snapshots. A tab's folder is its `folderId`; tabs without one show by kind of site. Writes bump a search version so the search index knows to rebuild. |
| Free limits | `src/lib/limits.ts`, `src/lib/pro/tiers.ts` | 500 tabs, 3 folders, 3 snoozed, 1 rule; `hasFreeLimits(plan)` is the one rule for who has them. The worker refuses with `list-full`, `folder-limit` or `snooze-limit` and the screens show the matching card. |
| Automation | `src/lib/background/automation.ts`, `live.ts`, `share.ts`, `tidy.ts` | Snooze and Fold automatically (alarms), live folders (tab group listeners), shared folders (pushed when they change), Ask and the weekly tidy-up. |
| Capture rules | `src/lib/capture.ts` | Pure functions: what gets saved, kept open or closed. Unit tested. |
| Search | `src/lib/search/` | MiniSearch index in a web worker; keyword boost and `#keyword` filter. |
| Messages | `src/lib/messages.ts` | Typed commands from the pages to the worker. |
| Popup | `src/entrypoints/popup/` | 400 × 580, opens in well under 150 ms (reads recent sessions only). |
| Library | `src/entrypoints/library/` | The full list (folders, kinds of site, drag and drop, menus, Ctrl+K), search and Ask, Make room, settings, plans and welcome pages. |
| Onboarding | `src/entrypoints/onboarding/` | Opens on first install. |
| Pro | `src/lib/pro/`, `src/lib/background/pro.ts` | The plan from Tabfold's server, sign-in (device token, Chrome profile key), the checkout and billing tabs, account sync (`src/lib/sync/`, the same format as Chrome sync with larger limits), AI requests, milestones. |
| Server | `server/` | A Supabase Edge Function and Postgres: accounts and email codes, the trial, Stripe Checkout (subscriptions, Pro for life, team seats), the billing portal and Stripe's webhooks, teams and invitations, sync (personal and per team), daily backups, shared folders, AI limits and the Claude calls. Every secret (Stripe, the Zoho mailbox's app password, Anthropic) lives only there. See `server/README.md` and `server/API.md`. |
| Share site | `web/` | Plain HTML, CSS and JS for Vercel (`vercel.json`): a short home page and `/s/<id>`, a shared folder's page. No build step, no external scripts. |
| Design tokens | `src/assets/styles.css` | CSS variables for light and dark, mapped to Tailwind utilities. |

## Measured

- Search over 10,000 saved tabs: about 19 ms per query, 190 ms to build the index (unit test, Node).
- Popup: first paint in about 60 to 150 ms in headless Chromium, with thousands of folded tabs.
- 991 unit tests (including the server, run in Node, and a 0.6-vs-1.0 sync test that runs 0.6's own sync code) and four end-to-end tests in real Chromium pass: a 57-check smoke test (including real Incognito windows); a 177-check Free-plan test (folders and their limit, moving tabs by menu and drag and drop, kinds of site and Zoho Mail, the 500-tab limit and Make room, snooze and its limit, fold automatically, duplicates, imports, Ctrl+K); a 145-check 1.0 test (the side panel, Chrome's real side panel opening, the toolbar setting, Fold into, fold back, Close the copies, Tidy into groups, window names, the window cap and Undo, stars and notes, the weekly summary, open tabs first in search and Ctrl+K); and a 141-check Pro test that runs the real server code against a fake Stripe (its API, checkout and billing pages, and signed webhooks), a mailbox that keeps the codes, a fake model and the share site: the trial by email code, account sync, Organise with AI into folders, smart names, backups, Ask your tabs, the weekly tidy-up, a live folder, sharing a folder with its note (the public page, Save to my Tabfold, Stop sharing), paying in the Stripe tab, a failed payment, Update card, cancelling, signing out and in, the plan ending, a new buyer, paying with someone else's email, Pro for life, starting a team, a team on two computers, deleting an account (and no second trial for that email), and Remove Tabfold.

## Decisions and known limits

- **Shortcuts**: Fold tabs is Ctrl/⌘+Shift+S (asks which windows when several are open), fold this tab is Alt+Shift+S, snooze this tab until tomorrow morning is Alt+Shift+Z, open Tabfold is Alt+Shift+F. All can be changed at `chrome://extensions/shortcuts`.
- **Folding never saves a tab twice**: tabs already in the list are closed but not added again (undo reopens them too).
- **Incognito** is folded only with Settings › "Fold Incognito windows too" (off by default), which also needs "Allow in Incognito" for Tabfold in `chrome://extensions` (Chrome hides Incognito windows from extensions otherwise). Those tabs are marked in the list, stay on this computer (never in Chrome sync or snapshots), and reopen only in an Incognito window: clicking one, "Open all", "Reopen" and Undo all respect that. The same address in a normal and an Incognito window counts as two tabs.
- **Chrome sync status**: Chrome doesn't tell extensions whether the person is signed in to Chrome, so "Synced with Chrome" means written to Chrome's sync storage; it reaches other computers when Chrome sync is on. Sync carries the newest 500 folded tabs (Chrome's quota is about 100 KB); older ones stay on the computer that folded them.
- **Unsaved typing can't be detected** without reading pages, which Tabfold never does. Sites that ask "Leave site?" are reported during a fold; others close normally.
- **Memory in use is an estimate** (about 48 MB per loaded tab); the "Your computer" figure after a fold is a real reading of free memory (`system.memory`, which adds no install warning).
- **No `sessions` permission**: crash recovery uses Tabfold's own snapshots.
- **Payments go straight through Stripe** (Checkout and the billing portal), with no payment code in the extension: no library, no content script, no install warning. Tabfold's server creates each checkout, and Stripe's webhooks tell it about payments, renewals, failed payments and cancellations. While the checkout tab is open, Tabfold also checks the plan every 5 seconds, so a payment shows up even before the webhook does.
- **Accounts are an email address.** Codes are 6 digits, last 10 minutes and 5 tries, and are stored only as a hash. Each computer has its own random device token (only its fingerprint is stored on the server); a profile key in Chrome sync lets other computers on the same Chrome profile sign in, and "Sign out" signs out just that computer.
- **The trial lives on Tabfold's server**: 7 days of Pro AI, one per email, no card. Paying for Pro AI during the trial starts billing when the trial ends.
- **AI uses Claude Haiku 5.5** at low effort with structured outputs; a run counts only when it succeeds, and a bad answer is retried once.
- **Folders travel with sync**: a folder's name, colour and deletion, a tab's folder and snooze, and the sites you moved all sync (Chrome sync and the Tabfold account); the newest change wins. Snoozed tabs only reopen on the computer that snoozed them. 0.5's projects became folders on update.
- **Not yet tried against the live services**: the Stripe, Zoho Mail, Supabase and Anthropic calls are covered by unit tests and by the end-to-end test against fakes and the real server code, not yet by real accounts. Prices are in USD; Stripe Tax can add VAT and sales tax at checkout (`STRIPE_AUTOMATIC_TAX=true`, a paid Stripe feature).
