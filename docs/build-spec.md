# Tab Manager Extension: Build Spec

Oct 10, 2026 · @Ahsan Raja

## Overview

A Chrome extension that saves and restores tabs and whole windows, frees memory, and stays fast with thousands of saved tabs. Working name: **\[App Name\]**. Promise: *free your memory without losing your place.*

**Who it is for**

- People who keep 30 to 100+ tabs open across 2 to 5 Chrome windows and whose machine slows down.
- People who work on more than one computer (often a Mac laptop plus a work PC).
- People building apps with AI tools, who juggle docs, AI chats, GitHub, dashboards and tutorials at once.

**Where competitors fall short (from reviews and comparison articles)**

- OneTab: reliable and free, but one flat list; slows down past roughly 1,000 saved tabs.
- Toby: nice visual boards, but added a 60-tab limit on free, which angered users.
- Workona: good project workspaces, but core features sit behind about $7/month.
- Session Buddy and Tabs Outliner: slow updates, no cloud sync, weak at large scale.

**How we win**

1. Windows are first-class: each window saves and restores as its own named group.
2. Fast at scale: smooth with 5,000+ saved tabs.
3. Honest pricing: a free tier that is genuinely complete on one device.
4. Paid value beyond sync: depth features for heavy users, plus AI auto-organising.
5. One codebase runs on Chrome, Edge, Brave and Opera, on Mac, Windows and Linux.

## Plans: Free, Pro, Pro AI

Free is complete on one device. Pro charges for depth of use and the cloud, not just sync. Pro AI adds the only feature that costs money per use. Prices are starting points to test.

| Feature | Free | Pro ($5/mo or $48/yr) | Pro AI ($9/mo or $84/yr) |
| --- | --- | --- | --- |
| Save all tabs and free memory | Yes | Yes | Yes |
| Save and restore whole windows as named groups | Yes | Yes | Yes |
| Suspend inactive tabs (manual and timed) | Yes | Yes | Yes |
| Saved tabs | Unlimited | Unlimited | Unlimited |
| Named sessions | Up to 50 | Unlimited | Unlimited |
| Search saved tabs (title and URL) | Yes | Yes | Yes |
| Tags | Up to 5 | Unlimited | Unlimited |
| Crash recovery (last session) | Last 1 | Last 20 snapshots | Last 20 snapshots |
| Advanced search (filters by tag, date, domain, device) | No | Yes | Yes |
| Bulk actions (merge, move, dedupe, close by domain) | Basic | Full | Full |
| Version history per session | No | 30 days | 30 days |
| Automatic cloud backup | No | Yes | Yes |
| Cloud sync across devices | No | Up to 5 devices | Up to 5 devices |
| Rules (auto-suspend or auto-save by domain or time) | No | Yes | Yes |
| Export (HTML, JSON, Markdown, CSV) | HTML only | All formats | All formats |
| AI auto-group and label open tabs | No | No | 300 runs/month |
| AI smart session names and summaries | No | No | Yes |
| AI "context pack" for coding assistants | No | No | Yes |
| Bring your own AI key (unlimited AI runs) | No | No | Optional |

**Rules that keep the pricing fair**

- Never take away a free feature after launch. Toby's surprise tab limit is the cautionary tale.
- The free cap is on sessions, never on tabs. Nobody loses saved tabs.
- When a free user hits a limit, show what Pro adds; never block access to what they already saved.
- If a Pro user downgrades, their data stays readable and exportable; sync and Pro features stop.
- 7-day free trial of Pro AI for new installs, no card needed.

## Feature specification

Every feature below is tagged by plan: **F** = Free, **P** = Pro, **AI** = Pro AI.

**1. Capture (saving tabs)**

- Save all tabs in all windows in one click, then close them to free memory. (F)
- Save only the current window. (F)
- Save selected tabs (multi-select in the popup or via Chrome's highlighted tabs). (F)
- Save a single tab from the right-click menu or a keyboard shortcut. (F)
- Each save stores: URL, title, favicon URL, pinned state, Chrome tab group name and colour, window position, and time saved. Never page content. (F)
- Option to keep pinned tabs open when saving all. (F)
- Duplicate detection: warn or skip if the same URL is already in the target session. (F)
- Undo for 10 seconds after any save-and-close. (F)

**2. Restore**

- Restore a whole session as its original windows, with tab groups and pinned tabs rebuilt. (F)
- Restore into the current window, or a new single window. (F)
- Open one tab without removing it from the session. (F)
- Lazy restore: tabs open unloaded (discarded) and load only when clicked, so restoring 200 tabs does not spike memory. (F)
- Choose whether restoring removes the session or keeps it. (F)

**3. Memory management**

- Suspend (discard) inactive tabs using Chrome's built-in discard API: tab stays visible, memory is released. (F)
- Auto-suspend after X minutes idle, with exceptions: pinned, audio playing, unsaved form input, whitelisted domains. (F)
- Memory banner: estimated memory in use and tabs open; "freed \~X" after an action. (F)
- Rules by domain or time, e.g. "always suspend YouTube after 10 min", "auto-save all tabs every evening at 6pm". (P)

**4. Organise**

- Name, rename, pin, colour and reorder sessions. (F)
- Drag tabs between sessions and windows. (F)
- Tags on sessions (5 on Free, unlimited on Pro). (F/P)
- Merge sessions, split a session by window, dedupe across sessions, close all tabs from a domain. (P)
- Trash with 30-day recovery. (F)

**5. Search**

- Instant search across open and saved tabs by title and URL, with keyboard navigation. (F)
- Filters: tag, date range, domain, device, window. (P)

**6. Recovery and safety**

- Background snapshot of open windows every few minutes and on browser close (last 1 on Free, last 20 on Pro). (F/P)
- After a crash or restart, prompt: "Restore your last session?" (F)
- Version history per session for 30 days. (P)
- Automatic cloud backup. (P)

**7. Sync and account**

- Optional account (email magic link or Google sign-in). Free works fully without one. (F)
- Cloud sync across up to 5 devices and across Chromium browsers. (P)
- Offline-first: every change saves locally first, then syncs when online. (P)
- Device list with last-seen time; sign out a device remotely. (P)

**8. Import and export**

- Import from OneTab (its export text), Session Buddy (JSON) and browser bookmarks. Key for switching users. (F)
- Export as HTML (F); JSON, Markdown, CSV (P).

**9. AI (see AI section for detail)**

- Auto-group open tabs into named groups by project or topic. (AI)
- Smart session names and one-line summaries. (AI)
- Context pack: copy a session's links and titles as a clean Markdown block to paste into Claude, ChatGPT or Cursor. (AI)

**10. Settings and billing**

- Keyboard shortcuts (editable via Chrome's shortcut page), light/dark/system theme, auto-suspend timer, what "save all" includes. (F)
- Upgrade, manage subscription, restore purchase on a new device. (F)
- Privacy page in plain words: what is stored, where, and that page content is never read. (F)

## Design specification

The product has two surfaces: a fast popup for quick actions, and a full library page for organising. Opening either should feel like relief: calm, uncluttered, instant.

**Visual system**

- Style: clean and modern, generous white space, flat with 1px borders. Reference feel: Linear, Arc, Raycast. Not a 2013 utility.
- Font: Inter (bundled locally, not loaded from the web). Sizes: 11px meta, 13px body, 15px section titles, 18px page titles, 24px empty-state headlines. Weights 400 and 600 only.
- Colour: neutral grey scale, one accent (calm indigo or teal) for primary actions and active states only. Green for "memory freed", amber for warnings, red for destructive actions and errors.
- Light, dark and system themes, all colours defined as CSS variables.
- Spacing on an 8px grid (4px for tight rows). Card radius 10px, button radius 8px, inputs 8px.
- Icons: Lucide line icons, 16px in rows, 20px in toolbars.
- Motion: 120 to 180ms ease-out; none when the OS has reduced motion on.

**Screen 1: Popup (400 x 580px)**

1. Header: logo mark, search field (auto-focused, placeholder "Search open and saved tabs"), sync status pill, settings icon.
2. Memory banner: "47 tabs open · \~2.1 GB". After a save it turns green: "Freed \~1.8 GB · Undo".
3. Primary button, full width: "Save all & free memory". Under it, two secondary buttons: "Save this window" and "Suspend inactive".
4. "Open now": one collapsible card per window, titled "Window 1 · 18 tabs" (click to rename). Tab rows: favicon, title (one line, truncated), domain in grey. Hover shows suspend, save, close. Suspended tabs are dimmed with a small pause icon. Current window is listed first and marked.
5. "Recent sessions": the 5 latest as compact cards (name, tab count, time ago, device icon) with a "Restore" button.
6. Footer: "Open library" link and plan badge (Free / Pro / Pro AI).
7. When search has text, sections are replaced by results grouped into "Open" and "Saved", with matched words highlighted; Enter opens the top result.

**Screen 2: Library (opens in its own tab, designed at 1440px, works down to 1024px)**

1. Left sidebar (240px): All sessions, Pinned, Recent, Tags (with counts), Devices (Pro), Snapshots, Trash. Plan badge and account at the bottom.
2. Top bar: global search, filter chips (tag, date, domain, device; Pro), view toggle (cards / list), sort (recent, name, size), "Save all now" button.
3. Session cards: name, tag chips, tab count, window count, a strip of the first 6 favicons, last updated, device icon. Menu: rename, tag, pin, merge, duplicate, export, delete.
4. Session detail (right panel or expanded card): windows shown as sections, each with its tabs. Tabs can be dragged between windows and sessions. Restore buttons: "Restore as original windows", "Restore into this window", "Open tab".
5. Version history drawer (Pro): list of versions by time with a "Restore this version" button.
6. Lists are virtualised so 5,000+ tabs scroll smoothly. No heavy shadows or per-row animation.

**Screen 3: AI organise (Pro AI)**

1. Button "Organise with AI" in the popup and library.
2. Preview sheet: proposed groups (e.g. "React project · 12 tabs", "Holiday research · 8 tabs") with each tab listed. User can rename a group, move a tab, or untick it before applying.
3. Actions: "Save as sessions", "Make Chrome tab groups", "Cancel". Nothing changes until the user confirms.
4. Runs-left counter shown quietly: "212 of 300 AI runs left this month".

**Screen 4: Account and sync**

- Sign-in: Google button and email magic link, one line on why ("Sign in to sync across devices and back up to the cloud").
- Devices page: device name, browser, last seen, "Sign out this device".
- Sync status pill states: "Synced", "Syncing...", "Offline, saved locally", "Sync paused, sign in again".

**Screen 5: Upgrade**

- Three-column comparison (Free, Pro, Pro AI) matching the plans table. Monthly/yearly toggle. Price shown clearly with no hidden steps.
- Copy tone: "Free stays genuinely useful. Pro adds sync, backup and power tools."
- After purchase: success screen and instant unlock, no reload needed.

**Screen 6: Onboarding (first install, 3 steps, skippable)**

1. "Save everything in one click": short animation of tabs folding into a card.
2. "Your windows stay separate": windows saved as named groups.
3. "Import from OneTab or Session Buddy" and optional sign-in, with "Skip for now".

**Screen 7: Settings**

- General: theme, what "save all" includes (pinned tabs, other windows), restore behaviour, lazy restore on/off.
- Memory: auto-suspend timer, never-suspend list.
- Shortcuts: list with a link to Chrome's shortcut page.
- Data: import, export, clear all data (with confirmation), privacy summary.
- Plan and billing.

**States every screen needs**

- Empty: no sessions yet ("Your saved tabs will live here" + big save button), no search results, no devices.
- Loading: skeleton rows, never spinners longer than 300ms.
- Success: toast with Undo ("Saved 47 tabs · Undo").
- Errors: sync failed (retry), AI failed (retry, no run counted), restore partly failed (list the tabs that failed with "Copy links").
- Limits: friendly banner when a free limit is reached, never a blocking modal.
- Confirmations only for destructive bulk actions (delete session, clear all).

**Interaction and accessibility**

- Shortcuts: Ctrl/Cmd+Shift+S save all; Ctrl/Cmd+Shift+W save window; / focus search; arrow keys move; Enter opens; Delete removes; Ctrl/Cmd+Z undo.
- Full keyboard use of the popup and library; visible focus rings.
- WCAG AA contrast in both themes; readable at 125% zoom.
- Screen-reader labels on all icon buttons.

**Design deliverables**

- High-fidelity screens 1 to 7 in light and dark.
- Component set: buttons (primary, secondary, ghost, danger), tab row (normal, hover, suspended, selected, dragging), session card, window card, search field, filter chip, sync pill, memory banner, toast, upgrade card, AI group preview.
- Chrome Web Store assets: 128px icon, 5 screenshots at 1280 x 800, small promo tile 440 x 280.

## Tech stack and architecture

Use boring, well-supported tools: WXT + TypeScript + React on Manifest V3, IndexedDB locally, Supabase for accounts and sync, and a small server function for AI. One codebase ships to Chrome, Edge, Brave and Opera.

| Layer | Choice | Why |
| --- | --- | --- |
| Extension framework | [WXT](https://merginit.com/blog/23082026-plasmo-vs-wxt-vs-crxjs-extension-js) (Vite-based) | The current default for new extensions: Manifest V3, hot reload, TypeScript, cross-browser builds, zip for store upload. |
| Language | TypeScript (strict mode) | Catches bugs before users see them; AI coding tools write it well. |
| UI | React 18+ with Tailwind CSS | Huge ecosystem, easy to hire or get AI help for. Svelte is a lighter alternative if bundle size matters more. |
| UI components | shadcn/ui + Lucide icons | Clean, modern look out of the box; you own the code. |
| Long lists | TanStack Virtual | Renders only visible rows, so 5,000 tabs scroll smoothly. |
| State | Zustand | Tiny, simple, no boilerplate. |
| Local database | IndexedDB via Dexie.js | Fast, indexed, handles thousands of records; far better than one big chrome.storage blob. |
| Small settings | chrome.storage.local / sync | Theme, preferences, small flags only. |
| Search | MiniSearch (or FlexSearch) in a web worker | Instant fuzzy search over titles and URLs without freezing the UI. |
| Background logic | MV3 service worker + chrome.alarms | Wakes up, does the job, sleeps. No always-on background page leaking memory. |
| Backend (Pro) | [Supabase](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/) (Postgres, Auth, Row Level Security, Edge Functions) | Auth, database and server functions in one place; free tier to start, $25/month Pro after. |
| Payments | [Stripe](https://stripe.com/) Checkout and its billing portal, opened in a tab; a merchant of record (Paddle or Lemon Squeezy) if tax filing becomes a burden | No payment code inside the extension and no install warning. Stripe Tax can add VAT and sales tax at checkout; a merchant of record also files it for you. |
| AI (Pro AI) | Claude Haiku 5.5 via a Supabase Edge Function | Very cheap and fast for sorting and labelling; the API key never ships inside the extension. |
| Error tracking | Sentry (browser SDK) | See crashes and errors from real users, with no page content logged. |
| Testing | Vitest (unit) + Playwright (end-to-end with a real Chrome) | Test the save/restore logic and full flows automatically. |
| CI and publishing | GitHub Actions + WXT zip + chrome-webstore-upload | Every release built and uploaded the same way. |

**Permissions (keep them minimal)**

- Needed: `tabs`, `tabGroups`, `storage`, `unlimitedStorage`, `alarms`, `contextMenus`, `favicon`, `sessions` (for crash recovery).
- Not needed: host permissions or content scripts. The extension never reads or changes web pages.
- Why it matters: no scary "read and change all your data on all websites" warning, faster Chrome Web Store review, and a real privacy promise you can advertise.
- Network: only your own Supabase and payment domains, set in the content security policy.

**How the parts fit**

- **Popup and library page (UI)**: read from IndexedDB through a small data layer; send commands (save, restore, suspend) to the service worker.
- **Service worker**: owns all tab and window actions, snapshots, alarms, and the sync queue. Stateless between wake-ups; everything it needs is in IndexedDB.
- **Web worker**: builds and queries the search index.
- **Sync engine (Pro)**: every change is written locally first and added to an outbox; the outbox pushes to Supabase when online and pulls changes from other devices.
- **Supabase**: users, devices, sessions, windows, tabs, and change log, protected by Row Level Security so each user only sees their own rows.
- **AI function**: receives only tab titles and domains, calls the model, returns proposed groups. Counts runs per user per month.

**Data model (local and cloud)**

- `sessions`: id, name, tags, pinned, colour, created\_at, updated\_at, device\_id, version, deleted\_at.
- `windows`: id, session\_id, name, order, was\_focused, bounds.
- `tabs`: id, window\_id, url, title, favicon\_url, pinned, group\_name, group\_colour, order, saved\_at.
- `snapshots`: id, created\_at, reason (timer, shutdown, before-restore), data.
- `changes` (outbox): id, entity, entity\_id, op, payload, created\_at, synced.

## Why extensions slow or crash browsers, and how we avoid it

Most extension problems come from doing too much, too often, in the wrong place. Each cause below has a matching rule in our build.

| Common cause | What users see | Our rule |
| --- | --- | --- |
| Always-running background pages (old Manifest V2) holding memory forever | Chrome uses more RAM the longer it runs | Manifest V3 service worker only; it sleeps when idle and keeps no state in memory. |
| Content scripts injected into every page | Every tab gets slower; privacy warnings | No content scripts at all. We only use the tabs and windows APIs. |
| Storing everything in one large chrome.storage blob, re-read and re-written on every change | Popup lags; data lost if a write is cut off | IndexedDB with one row per tab; small, indexed reads and writes. |
| Rendering thousands of rows at once | Popup freezes, library page stutters | Virtualised lists; popup shows recent items only, library loads in pages. |
| Heavy work on the main thread (search indexing, imports, exports) | UI hangs | Run it in a web worker; show progress for anything over 300ms. |
| Reacting to every tab event (onUpdated fires many times per page load) | High CPU while browsing | Debounce and batch tab events; ignore events we do not need. |
| Restoring hundreds of tabs fully loaded | Memory spike, fans spin, browser may crash | Lazy restore: tabs open discarded and load on click; restore in batches of 10. |
| Timers via setInterval in the background | Timers die when the service worker sleeps, or keep it awake | chrome.alarms for every scheduled job (snapshots, auto-suspend, sync). |
| Memory leaks: listeners added repeatedly, caches that never clear | Slow creep until restart | Register listeners once at top level; cap in-memory caches; test with Chrome Task Manager over 8 hours. |
| Suspending tabs by replacing them with a custom "suspended" page | Lost tabs if the extension is removed or updated (a known failure of older suspenders) | Use Chrome's native tab discard API; the real URL always stays on the tab. |
| Network calls on every change | Slow, battery drain, rate limits | Local-first writes; sync outbox batched every few seconds and on alarms. |
| Breaking data changes between versions | Users lose sessions after an update | Versioned database schema with tested migrations; snapshot before every migration. |
| Unhandled errors in the service worker | Features silently stop working | Wrap every handler; log to Sentry; never let one failed tab stop a whole save. |

**Performance budgets (test before each release)**

- Popup opens and is usable in under 150ms with 5,000 saved tabs.
- Save all of 100 tabs completes in under 1 second.
- Library search returns in under 50ms with 10,000 saved tabs.
- Extension's own memory under 50MB idle, as shown in Chrome Task Manager.
- Service worker CPU near zero when the user is not interacting.
- Bundle size: popup JavaScript under 250KB gzipped.

**Data-safety rules**

- Never close a tab until its save is confirmed written to IndexedDB.
- Snapshot open windows before any bulk close, restore, import or migration.
- Deletes go to Trash for 30 days; nothing is hard-deleted by default.
- Chrome deletes extension data on uninstall and allows only a web page to open afterwards, so remind Free users monthly to export a backup; Pro users are covered by cloud backup.

## AI features and the AI app-builder angle

People building apps with AI tools are the ideal heavy user: they keep docs, AI chats, GitHub, dashboards and tutorials open across several windows, project after project. Position Pro AI as "workspaces for builders" and make three AI features the reason to pay.

**1. Auto-organise (flagship)**

- One click sends the titles and domains of open tabs (never page content) to the AI.
- It returns named groups, e.g. "Checkout app: Stripe docs, Supabase dashboard, GitHub repo", "Research: competitor pages", "Personal".
- The user previews, edits, then saves as sessions or turns them into Chrome tab groups.
- Also works on a large saved session to split it into sensible smaller ones.

**2. Project workspaces for builders**

- A session can be marked as a Project with a type (e.g. "App build").
- Restoring a Project reopens its windows exactly: docs window, dashboards window, AI chat window.
- Quick switch: close project A's windows (saved) and open project B's in one action. This is the "get back into flow in one click" promise.
- AI suggests a name and a one-line summary when a project is saved.

**3. Context pack for AI coding assistants**

- One click copies a project's links as clean Markdown: grouped by type (docs, repos, dashboards, references) with titles.
- Paste into Claude, ChatGPT, Cursor or a project README so the assistant knows which docs and APIs you are using.
- Optional template: "I'm building X. Reference docs: ... Repos: ... Please use these."

**Ideas for later**

- Natural-language search: "the Stripe webhook page I had open last Tuesday".
- Weekly digest: "You have 3 stale projects with 140 tabs; archive them?"
- Duplicate-topic detection across sessions.

**Our key or the user's own key?**

Default to our own key, built into Pro AI. Offer "bring your own key" as an optional extra for technical users.

| Option | Pros | Cons | Use for |
| --- | --- | --- | --- |
| Our key (default) | Works instantly, no setup; this is what most people pay for | We pay per use, so we need caps | All Pro AI users |
| User's own key (optional) | Zero cost to us; unlimited runs for power users | Big setup hurdle; most users will not do it | Developers who already have API keys |

**Rules for the AI feature**

- The API key lives only in the Supabase Edge Function, never in the extension code (extension code can be read by anyone).
- The function checks the user is Pro AI and under their monthly cap before calling the model.
- Send only titles and domains, trimmed to 200 characters each, max 300 tabs per run.
- Ask the model for strict JSON (group name, tab ids) and validate it; if invalid, retry once, then show a friendly error and do not count the run.
- Model: Claude Haiku 5.5 (`claude-haiku-5-5`), the cheap, fast model for classification-type tasks. Keep prompts under 100,000 tokens to stay on the lowest price tier.
- Cap: 300 runs a month on Pro AI; show runs left; BYOK users are uncapped.
- Privacy: state clearly that only titles and domains are sent, and allow excluding domains (e.g. banking, email) from AI.
- AI is never needed for the core product. If the AI service is down, everything else works.

## Running costs

The free version costs nothing to run because everything happens on the user's machine. Real costs start only with Pro: about $25/month for the backend, payment fees per sale, and well under $1 per Pro AI user per month for AI.

**Fixed costs**

| Item | Cost | When |
| --- | --- | --- |
| Chrome Web Store developer registration | $5, one time | Before first upload |
| Domain for website, privacy policy and emails | About £10 to £15 a year | Before launch |
| Supabase Free (500 MB database, 50,000 monthly active users) | $0 | Development and beta |
| [Supabase Pro](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/) (8 GB database, 100,000 monthly active users, daily backups) | $25 a month | From the day paid sync goes live (Free projects pause after 7 days without activity, which is not acceptable for paying users) |
| Sentry, GitHub, email (e.g. Resend) | $0 on free tiers at this size | Launch |

**Per-user costs**

| Item | Cost | Notes |
| --- | --- | --- |
| Free user | $0 | No server use at all. |
| Pro user sync storage | Pennies | A heavy user with 5,000 saved tabs is roughly 2 MB; 8 GB covers thousands of users. |
| Payment fees, [Stripe](https://stripe.com/pricing) | Stripe's card fee, plus Stripe Billing's fee (and Stripe Tax's, if on) | On a $5 monthly charge the fixed part of the card fee weighs most; yearly plans cut this because it is paid once. |
| AI per run, Claude Haiku 5.5 | About $0.002 | Assumes 100 tabs: about 3,500 input tokens and up to 3,500 output tokens (including thinking at low effort) at [$0.10 / $0.50 per million](https://www.vktr.com/ai-platforms/anthropic-cuts-smallmodel-pricing-90-with-claude-haiku-55/). |
| AI per Pro AI user per month | About $0.06 typical (30 runs); $0.60 maximum (300-run cap) | The cap makes the worst case predictable. |

**What to watch**

- Set Haiku's effort to low for auto-organise; thinking tokens bill as output and are the biggest AI cost driver.
- Keep Supabase's spend cap on (it is on by default on Pro).
- Taxes: you sell to UK and EU consumers, so VAT applies. Stripe Tax can work it out and collect it at checkout, but you still register and file; a merchant of record (Paddle or Lemon Squeezy) does that for you, for a higher fee. Check with an accountant before switching on payments.
- Prices for AI models and Supabase change; recheck before launch.

Sources: [Supabase pricing summary](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/) · [Haiku 5.5 pricing report](https://www.vktr.com/ai-platforms/anthropic-cuts-smallmodel-pricing-90-with-claude-haiku-55/) · [Extension payment options](https://fungies.io/monetize-chrome-extension-2026) · [Stripe pricing](https://stripe.com/pricing)

## Edge cases

Tick these off as you build; each one needs a test. Grouped by area, with the expected behaviour.

**Saving**

- [ ] Save all with 0 or 1 tab open: do not close the last window; Chrome would exit. Keep or open a new tab page.
- [ ] Save closes the window the popup belongs to: finish the database write before closing anything.
- [ ] Save interrupted (browser quits, service worker killed mid-save): tabs stay open unless the write is confirmed.
- [ ] Same URL already saved in the session: follow the duplicate setting (skip, keep both, ask).
- [ ] Tabs still loading (no title yet): save URL, fill title later or use the domain.
- [ ] Very long URLs (data URLs, huge query strings): cap stored length; warn if a tab cannot be saved in full.
- [ ] Pinned tabs: respect "keep pinned open" setting.
- [ ] Tabs inside Chrome tab groups: save group name, colour and collapsed state.
- [ ] Tabs playing audio or video, or with unsaved form text: warn before closing.
- [ ] Tabs with a beforeunload "leave site?" prompt: those tabs may refuse to close; report them, do not hang.
- [ ] Save triggered twice quickly (double-click, shortcut and button): run once.
- [ ] Save while another window is being created or dragged: re-read windows right before closing.

**Special pages**

- [ ] chrome:// pages, chrome-extension:// pages, the Web Store, edge:// pages: save the URL; restoring may be blocked, so show it as copyable text.
- [ ] Local files (file://): save; restore works only if the user allowed file access.
- [ ] PDFs in the built-in viewer: save the real PDF URL.
- [ ] about:blank and new tab pages: skip by default.
- [ ] Our own extension pages (library, settings): never save them.
- [ ] Pages behind a login: restore opens them; the site may ask the user to sign in again (expected).
- [ ] Pages that redirect or no longer exist: restore anyway; let the user fix or delete.
- [ ] Tabs opened by other extensions with unusual schemes: save as text if not a web URL.

**Restoring**

- [ ] Restore 500+ tabs: lazy restore in batches; show progress; allow cancel.
- [ ] Restore when a window with the same tabs is already open: offer "switch to it" or "open copy".
- [ ] Some tabs fail to open: open the rest, list the failures with "Copy links".
- [ ] Restored window on a monitor that is no longer connected: place it on the current screen.
- [ ] Restore into an incognito window: blocked unless allowed in incognito; explain.
- [ ] Tab group colours or names that no longer exist in Chrome's list: fall back to a default colour.
- [ ] Restore from another device (Pro) with different screen size: ignore saved window bounds when off-screen.

**Memory and suspension**

- [ ] Suspending the active tab: not allowed; skip it.
- [ ] Tabs Chrome refuses to discard (playing audio, pinned per setting, active): skip and report.
- [ ] Discarded tabs that Chrome reloads by itself on focus: expected; do not treat as an error.
- [ ] Auto-suspend while the user is on a video call: never suspend tabs using camera or microphone.
- [ ] Laptop wakes from sleep: alarms fire late; run missed jobs once, not many times.
- [ ] Chrome's own Memory Saver is also on: avoid fighting it; just read tab state.

**Windows and profiles**

- [ ] Many windows (10+) and popup-type windows (app windows, devtools): save normal windows only by default.
- [ ] Multiple Chrome profiles: each profile has separate local data; sync maps to the signed-in account of the extension, not the profile.
- [ ] Incognito windows: off by default; if enabled, never save without asking, never sync.
- [ ] Guest mode: extension may not run; nothing to do.
- [ ] Window closed while the popup is open: refresh the list, no errors.

**Storage and data**

- [ ] Database grows huge (50,000+ tabs): stays fast thanks to indexes; test it.
- [ ] Disk full or browser storage quota reached: stop, show a clear message, never close tabs.
- [ ] IndexedDB corrupted or wiped by "clear browsing data": recover from latest snapshot or cloud backup (Pro); show what happened.
- [ ] Schema migration after an update fails halfway: roll back using the pre-migration snapshot.
- [ ] Import of a huge or malformed OneTab/Session Buddy file: parse in a worker, skip bad lines, report counts.
- [ ] Export with emoji, non-Latin titles and right-to-left text: correct encoding (UTF-8).
- [ ] Extension updated while the popup or library is open: reload the page cleanly.
- [ ] Extension disabled then re-enabled: data still there; listeners re-registered.
- [ ] User uninstalls and reinstalls: local data is gone (Chrome deletes it); Pro data comes back after sign-in.

**Sync and accounts (Pro)**

- [ ] Same session edited on two devices at once: merge by item; if the same item changed on both, newest wins and the other version goes into version history.
- [ ] Session deleted on one device, edited on another while offline: keep the edited one, ask the user.
- [ ] Offline for days, then reconnects: push the outbox in order, then pull; no duplicates.
- [ ] Clock wrong on one device: use server timestamps for ordering.
- [ ] First sign-in on a device that already has local sessions: offer "merge with cloud" or "keep separate".
- [ ] Signing out: keep local data, stop syncing; option to remove local data.
- [ ] Session token expired: pause sync, show "Sign in again", keep saving locally.
- [ ] Device limit reached (5): ask to remove an old device.
- [ ] Account deleted: remove all cloud data; local copy stays until the user clears it.
- [ ] Supabase outage or rate limit: retry with backoff; app keeps working locally.
- [ ] Two browsers (Chrome and Edge) on the same computer: treated as two devices.

**Payments and plans**

- [ ] Payment succeeds but the extension does not unlock: re-check status on popup open and every few hours.
- [ ] Subscription cancelled or card fails: keep Pro until the period ends; then downgrade without deleting data.
- [ ] Downgrade with more than 50 sessions or 5 tags: everything stays readable; only creating new ones is limited.
- [ ] Refund: revoke Pro, keep data.
- [ ] User pays on one browser, installs on another: "Restore purchase" by email sign-in.
- [ ] Trial ends: soft reminder 2 days before; no data loss after.
- [ ] Offline user with Pro: honour the last known paid status for up to 7 days.

**AI (Pro AI)**

- [ ] AI returns invalid JSON or tab ids that do not exist: validate, drop bad ids, retry once.
- [ ] AI puts every tab in one group or 50 tiny groups: enforce 2 to 12 groups in the prompt and check the result.
- [ ] Titles in many languages: group names in the user's browser language.
- [ ] Sensitive tabs (banking, email, health): excluded-domains list; never sent.
- [ ] More than 300 tabs: send the first 300 by most recent use, or split into several runs (each counts).
- [ ] Monthly cap reached: clear message with reset date; core features unaffected.
- [ ] AI service slow or down: time out after 20 seconds, do not count the run.
- [ ] User edits the preview then cancels: nothing changes.
- [ ] Abuse (scripts calling the AI function directly): require a signed-in token and server-side cap checks.

**Interface**

- [ ] Very long titles and URLs: truncate with full text on hover.
- [ ] Missing or broken favicons: show a letter avatar for the domain.
- [ ] Popup opened on a small laptop screen or at 125%+ zoom: no cut-off content.
- [ ] Dark mode switches while open: colours update live.
- [ ] Keyboard-only and screen-reader use: every action reachable and labelled.
- [ ] Undo after the popup closed: undo still available from the library for 10 seconds or via the toast in the next popup open.

**Store and platform**

- [ ] Chrome Web Store review asks why each permission is needed: written justifications ready.
- [ ] Chrome changes or removes an API: monitor Chrome release notes; keep features behind small adapters.
- [ ] Edge, Brave, Opera differences (e.g. Opera's sidebar, Brave's tab behaviour): test the core flows on each before claiming support.
- [ ] Enterprise-managed Chrome that blocks some APIs: fail gracefully with a clear message.

## Build order

Build the free local version first and get it into users' hands; add sync and payments only when reviews and requests show demand, then AI. Ads come after real users convert.

&#91;embedded content: build order · 3 versions, 2 gates\]

**v1: Free, local only**

1. Scaffold with WXT + React + TypeScript; set up IndexedDB (Dexie) and the service worker.
2. Save all, save window, save selected; close only after confirmed write; undo.
3. Restore (original windows, current window, single tab) with lazy loading.
4. Suspend inactive tabs (native discard) with auto-suspend timer and exceptions.
5. Popup and library screens from the design spec, with virtualised lists.
6. Search in a web worker.
7. Snapshots and crash-recovery prompt.
8. Import from OneTab and Session Buddy; export HTML.
9. Meet the performance budgets; run the Saving, Special pages, Restoring, Memory, Windows and Storage edge cases.
10. Store listing: keyword-rich title and description ("tab manager", "save tabs", "free memory"), 5 screenshots, privacy policy, permission justifications. Publish.

**Gate 1:** good ratings and reviews, and users asking for sync or more power features.

**v2: Pro (sync and depth)**

1. Supabase project: auth, tables, Row Level Security; move to Supabase Pro.
2. Sync engine: outbox, push/pull, conflict handling; device list.
3. Cloud backup and 30-day version history.
4. Pro depth features: advanced filters, bulk actions, rules, all export formats.
5. Payments via Stripe Checkout (or a merchant of record), upgrade screen, restore purchase.
6. Run the Sync and Payments edge cases.

**Gate 2:** Pro users paying and not cancelling; then test small ad campaigns.

**v3: Pro AI for builders**

1. Supabase Edge Function calling Claude Haiku 5.5, with caps and run counting.
2. AI auto-organise with preview.
3. Project workspaces and quick switch.
4. Context pack export.
5. Optional bring-your-own-key.
6. Run the AI edge cases; update the store listing to target people building with AI.
