# Tabfold

A Chrome extension that saves and restores tabs and whole windows, frees memory, and finds any tab by title, address or keyword. Promise: *free your memory without losing your place.*

This is **v1: Free, local only**, from the build spec. Everything runs on the user's machine: no account, no server, no network requests.

Design: [Tabfold design canvas](https://claude.ai/artifact/MGqcUEKEqHvcmZdSboDKP3) (popup, library, onboarding, settings, states, components; light and dark).

## What's in v1

- **Save**: all tabs in every window, the current window, selected tabs (⌘/Ctrl-click in the popup, or Chrome's highlighted tabs), or a single tab from the right-click menu or a shortcut. Each window is saved as its own named group, with pinned state and tab groups (name, colour, collapsed). Tabs close only after the save is confirmed written to IndexedDB. Undo for 10 seconds.
- **Keywords**: pick keywords for a tab when you save it (suggested from its title and address, or typed, or reused) and edit them later in the library. Search ranks keyword matches first; `#keyword` matches keywords only.
- **Restore**: as the original windows (with tab groups and pinned tabs), into the current window, or one window from a session. Lazy restore: background tabs open discarded and load when clicked, in batches of 10, with progress and cancel. Notices when a session is already open. Failed pages (for example `chrome://` ones) are listed with "Copy links".
- **Memory**: suspend inactive tabs with Chrome's native discard (the real address stays on the tab), by hand or automatically after a set idle time. Pinned, audible, active and protected sites (video-call sites by default) are skipped. The banner shows tabs open and an estimated memory figure.
- **Library**: sessions as cards or a list (virtualised), pinned and recent views, tags (5 on Free), session detail with drag and drop between windows and sessions, rename, duplicate, export, Trash with 30-day recovery.
- **Search**: instant search over open and saved tabs in a web worker (MiniSearch): prefix and typo-tolerant, non-Latin scripts, highlighted matches, keyboard navigation.
- **Safety**: a rolling background snapshot (debounced on tab changes plus a 5-minute alarm), safety snapshots before bulk closes, restores and imports, and a "Restore your last session?" offer after a browser restart.
- **Import / export**: OneTab export text, Session Buddy JSON, browser bookmark HTML files (parsed in a worker; bad lines are skipped and counted). Export everything as a standalone UTF-8 HTML file, plus a monthly backup reminder.
- **Plans**: Free is complete on one device. The Free cap is 50 named sessions and 5 tags, never tabs. Past 50 sessions, new saves go into one "Unsorted" session, so nothing is ever blocked.
- **Onboarding** (3 steps, skippable), **settings**, light/dark/system themes, full keyboard use, screen-reader labels.

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
npm run icons        # regenerate PNG icons
```

The e2e test needs a Chromium binary: it uses `$CHROME_PATH`, or finds one in `/opt/pw-browsers` or common install paths. It drives Chromium over the DevTools protocol directly rather than through Playwright, because Playwright attaches to every tab and drops the browser connection when a tab it watches is discarded.

Load the build by hand: `chrome://extensions` → Developer mode → Load unpacked → `.output/chrome-mv3`.

## How it fits together

| Part | Where | Notes |
| --- | --- | --- |
| Service worker | `src/lib/background/` | Owns every tab and window action (save, close, restore, suspend), snapshots, alarms, context menus and shortcuts. Keeps no state in memory between wake-ups. |
| Data | `src/lib/db.ts`, `src/lib/repo.ts` | IndexedDB through Dexie: one row per session, window and tab, plus snapshots. Writes bump a search version so the search index knows to rebuild. |
| Capture rules | `src/lib/capture.ts` | Pure functions: what gets saved, kept open or closed. Unit tested. |
| Search | `src/lib/search/` | MiniSearch index in a web worker; keyword boost and `#keyword` filter. |
| Messages | `src/lib/messages.ts` | Typed commands from the pages to the worker. |
| Popup | `src/entrypoints/popup/` | 400 × 580, opens in well under 150 ms (reads recent sessions only). |
| Library | `src/entrypoints/library/` | Sessions, detail, search, snapshots, Trash, settings. |
| Onboarding | `src/entrypoints/onboarding/` | Opens on first install. |
| Design tokens | `src/assets/styles.css` | CSS variables for light and dark, mapped to Tailwind utilities. |

## Measured

- Search over 10,000 saved tabs: about 19 ms per query, 190 ms to build the index (unit test, Node).
- Popup JavaScript: about 126 KB gzipped (budget 250 KB).
- 93 unit tests and a 31-check end-to-end smoke test pass.

## Decisions and known limits

- **Save window shortcut is Alt+Shift+W**, not Ctrl/Cmd+Shift+W: Chrome already uses that to close the window. Save all is Ctrl/Cmd+Shift+S, save tab is Alt+Shift+S, open Tabfold is Alt+Shift+F. All can be changed at `chrome://extensions/shortcuts`.
- **No `sessions` permission**: crash recovery uses Tabfold's own snapshots, so it isn't needed.
- **Camera, microphone and unsaved form text can't be detected** without reading pages, which Tabfold never does. Video-call sites are on the never-suspend list by default, and audio-playing tabs are kept open on "Save all" unless you choose otherwise.
- **Memory figures are estimates** (about 48 MB per loaded tab); Chrome doesn't give extensions per-tab memory.
- **Lazily restored tabs show their address in Chrome's tab strip** until clicked, because they haven't loaded yet. Clicking loads the page normally.
- **Pro, sync and AI are not in v1**, per the build order. The data model already carries device id and version fields for sync.
