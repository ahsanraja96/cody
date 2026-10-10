# Tabfold

A minimal Chrome extension that takes the load off your browser: **fold** your tabs to free memory, find them again in **one list** sorted by kind of site, and see the **same list on your other computers**. Promise: *fold your tabs, find them later.*

Design: [Tabfold design canvas](https://claude.ai/artifact/MGqcUEKEqHvcmZdSboDKP3) (the minimal design: popup, full list, settings, welcome, the memory bar and small states, light and dark). The earlier, fuller design is kept in the canvas project files for reference.

## What it does

- **Fold**: one button saves every tab in every normal window, then closes it. Pinned tabs (setting) and tabs playing sound stay open; Incognito is never touched; tabs already in the list aren't saved twice. Tabs close only after the save is written, in batches, with live progress in the popup and the full list (a popup closed mid-fold picks it back up). Pages that show Chrome's "Leave site?" are named with "Show tab" and are saved either way. Undo for 10 seconds. Shortcut: Ctrl/⌘+Shift+S.
- **Memory**: the popup shows the estimated memory in use (about 48 MB per loaded tab; Chrome doesn't tell extensions per-tab memory) as a bar with one segment per open tab, and after a fold the real change in the computer's free memory (chrome.system.memory). Idle tabs go to sleep after 30 minutes with Chrome's own discard; pinned, playing and active tabs never do. A "How Tabfold frees memory" page explains it.
- **One list**: every folded tab, grouped automatically by kind of site (Dev, Docs, Mail & chat, Social, Video, AI, Shopping, Reading, Other) from built-in site rules, newest first. Click a tab to open it (it stays in the list), × removes it (Undo), "Open all" opens a group as a Chrome tab group with the same name and colour. The full-list page adds "Recent folds", which reopens a fold as its original windows.
- **Search**: open and folded tabs by title, address or keyword (MiniSearch in a web worker), with `#keyword` for keywords only.
- **Keywords**, hidden until wanted: right-click › "Fold this tab with keywords…" (suggested from the title and address).
- **Same list on every computer**: the newest folded tabs (up to 500, within Chrome's sync quota) are shared through `chrome.storage.sync`, so they appear wherever the person is signed in to Chrome. No account, no server. Removals travel as tombstones; an emptied store never deletes anything; quota errors back off and retry. Can be turned off in Settings.
- **Restore**: lazy (background tabs load once, muted, then sleep, so they keep their real title, icon and address), with tab groups and pinned tabs rebuilt; failures listed with "Copy links".
- **Safety**: background snapshots and a "Chrome closed unexpectedly. Reopen your tabs?" line after a crash; a record outside IndexedDB detects wiped data and can recover the last snapshot; updates install cleanly; every message to the background must come from Tabfold itself.
- **Settings** (five things): keep pinned tabs open, idle sleep time, Chrome sync, theme, import from OneTab and export to HTML, plus "Clear everything".
- **Welcome tab** on install, light and dark themes, keyboard use, screen-reader labels.

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
- Popup: first paint in about 60 to 150 ms in headless Chromium, with thousands of folded tabs.
- 189 unit tests and a 36-check end-to-end smoke test pass.

## Decisions and known limits

- **Shortcuts**: Fold all tabs is Ctrl/⌘+Shift+S, fold this tab is Alt+Shift+S, open Tabfold is Alt+Shift+F. All can be changed at `chrome://extensions/shortcuts`.
- **Folding never saves a tab twice**: tabs already in the list are closed but not added again (undo reopens them too).
- **Incognito** is never folded, snapshotted or synced.
- **Chrome sync status**: Chrome doesn't tell extensions whether the person is signed in to Chrome, so "Synced with Chrome" means written to Chrome's sync storage; it reaches other computers when Chrome sync is on. Sync carries the newest 500 folded tabs (Chrome's quota is about 100 KB); older ones stay on the computer that folded them.
- **Unsaved typing can't be detected** without reading pages, which Tabfold never does. Sites that ask "Leave site?" are reported during a fold; others close normally.
- **Memory in use is an estimate** (about 48 MB per loaded tab); the "Your computer" figure after a fold is a real reading of free memory (`system.memory`, which adds no install warning).
- **No `sessions` permission**: crash recovery uses Tabfold's own snapshots.
- **Pro (account sync without the 500-tab limit, backup) and Pro AI** are designed for later; nothing in this build talks to a server.
