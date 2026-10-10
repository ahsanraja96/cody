# Tabfold

A Chrome extension that saves and restores tabs and whole windows, frees memory, and finds any tab by title, address or keyword. Promise: *free your memory without losing your place.*

This is **v1: Free, local only**, from the build spec. Everything runs on the user's machine: no account, no server, no network requests.

Design: [Tabfold design canvas](https://claude.ai/artifact/MGqcUEKEqHvcmZdSboDKP3): every screen, flow, dialog and edge case (52 boards, light and dark), plus the Chrome Web Store assets. v1 implements all of the Free boards; the Pro and Pro AI boards are the plan for v2 and v3.

## What's in v1

- **Save**: all tabs in every window, the current window, selected tabs (⌘/Ctrl-click or Shift-click a range in the popup, or Chrome's highlighted tabs), or a single tab from the right-click menu or a shortcut. Each window is saved as its own named group, with pinned state and tab groups (name, colour, collapsed). Tabs close only after the save is confirmed written to IndexedDB. Undo for 10 seconds, also from a popup reopened in that time.
- **Before closing**: tabs playing audio can stay open, addresses too long to store in full are flagged, and tabs already saved in another session can be skipped, saved again, or asked about (Settings › General). Tabs that refuse to close ("Leave site?") are listed with "Show tab"; nothing closes if the save fails.
- **Keywords**: pick keywords for a tab when you save it (suggested from its title and address, or typed, or reused) and edit them later in the library. Search ranks keyword matches first; `#keyword` matches keywords only.
- **Restore**: as the original windows (with tab groups and pinned tabs), into the current window, or one new window (the choice is remembered). Lazy restore: background tabs open muted, 10 at a time, load once (so they keep their real title, icon and address), then sleep with Chrome's native discard until clicked; per-window progress and Cancel in the popup and the library. A tab is never put to sleep before its page exists, which would leave a blank tab. Offers "Switch to it" when a session is already open. Failed pages (for example `chrome://` ones) are listed with "Copy links"; local files explain how to allow file access. Never restores into Incognito.
- **Memory**: suspend inactive tabs with Chrome's native discard (the real address stays on the tab), by hand or automatically after a set idle time. Pinned, audible, active and protected sites (video-call sites by default) are skipped, and the popup lists each tab kept awake and why. The banner shows tabs open and an estimated memory figure.
- **Library**: sessions as cards or a list (virtualised) with multi-select and bulk actions, pinned and recent views, tags (5 on Free; rename and delete from Manage tags), session detail with drag and drop between windows and onto other sessions, rename, duplicate, export, Trash with 30-day recovery, keyboard shortcuts (press ?), and a compact layout down to 1024px.
- **Search**: instant search over open and saved tabs in a web worker (MiniSearch), in the popup and the library: prefix and typo-tolerant, non-Latin scripts, highlighted matches, keyboard navigation, and a Trash scope.
- **Safety**: a rolling background snapshot (debounced on tab changes plus a 5-minute alarm), safety snapshots before bulk closes, restores and imports, and a "Restore your last session?" offer after a browser restart.
- **Import / export**: OneTab export text, Session Buddy JSON, browser bookmark HTML files: drop or paste, preview (including how the Free session limit applies), progress with Cancel (which takes back what was added), and a result listing skipped lines. Export as a standalone UTF-8 HTML file, plus a monthly backup reminder.
- **Data safety**: a copy of the latest snapshot and a count of what was saved live outside IndexedDB, so if Chrome's data for Tabfold is erased the library says so and can recover the last session. Storage-nearly-full warning at 80%. When Chrome downloads an update, open pages offer "Reload" instead of breaking.
- **Plans**: Free is complete on one device. The Free cap is 50 named sessions and 5 tags, never tabs. Past 50 sessions, new saves go into one "Unsorted" session, so nothing is ever blocked. Pro features show a small "Pro" lock that explains what Pro adds.
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
- Popup: first paint in about 120 to 145 ms (headless Chromium); about 138 KB of JavaScript gzipped (budget 250 KB).
- 135 unit tests and a 31-check end-to-end smoke test pass.

## Decisions and known limits

- **Save window shortcut is Alt+Shift+W**, not Ctrl/Cmd+Shift+W: Chrome already uses that to close the window. Save all is Ctrl/Cmd+Shift+S, save tab is Alt+Shift+S, open Tabfold is Alt+Shift+F. All can be changed at `chrome://extensions/shortcuts`.
- **Tabs already saved default to "Ask"**: the popup asks before saving duplicates (with "Remember my choice"). Saves with no page to ask in (shortcuts, the right-click menu) save them again, so nothing is dropped silently.
- **Incognito**: never saved by "Save all" or snapshots. From an Incognito window (when Tabfold is allowed there) the popup can save that window after a confirmation; undo reopens it in Incognito.
- **No `sessions` permission**: crash recovery uses Tabfold's own snapshots, so it isn't needed.
- **Camera, microphone and unsaved form text can't be detected** without reading pages, which Tabfold never does. Video-call sites are on the never-suspend list by default, and audio-playing tabs are kept open on "Save all" unless you choose otherwise.
- **Memory figures are estimates** (about 48 MB per loaded tab); Chrome doesn't give extensions per-tab memory.
- **Pro, sync and AI are not in v1**, per the build order. The data model already carries device id and version fields for sync.
