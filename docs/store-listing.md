# Chrome Web Store listing (draft)

## Name

Tabfold – Tab Manager: Save Tabs & Free Memory

## Short description (132 characters max)

Save all tabs and whole windows in one click, free memory, and find any tab by title, address or keyword. Private, fast, free.

## Description

Too many tabs? Tabfold folds them into saved sessions and gives Chrome its memory back, without losing your place.

**Save everything in one click**
- Save every tab in every window, just this window, selected tabs, or a single tab.
- Each window is saved as its own named group, with pinned tabs and tab groups.
- Changed your mind? Undo for 10 seconds.

**Find any tab again**
- Instant search across open and saved tabs by title and address.
- Add keywords to a tab when you save it, suggested from its title and address, and find it by any of them. Type #keyword to match keywords only.

**Restore exactly what you had**
- Bring back the same windows with their tab groups and pinned tabs.
- Lazy restore: background tabs load a few at a time, then sleep until you click them, so restoring 200 tabs won't slow your computer down.

**Free memory without closing anything**
- Suspend inactive tabs with Chrome's own tab discarding, by hand or automatically after a set time.
- Pinned tabs, tabs playing audio and video-call sites are never suspended.

**Built to be safe and fast**
- Stays fast with thousands of saved tabs.
- Background snapshots and a "Restore your last session?" prompt after a restart.
- Deleted sessions stay in Trash for 30 days.
- Import from OneTab, Session Buddy and browser bookmarks. Export to HTML.

**Private by design**
Tabfold never reads or changes web pages. It has no access to page content, keeps everything on your device, and makes no network requests.

Free is complete on one device: unlimited saved tabs, up to 50 named sessions and 5 tags.

## Category and keywords

Productivity. Keywords to use naturally in the copy: tab manager, save tabs, free memory, session manager, tab suspender, OneTab alternative, restore windows.

## Permission justifications

| Permission | Why Tabfold needs it |
| --- | --- |
| `tabs` | Read the address, title and pinned state of open tabs so they can be saved, searched and restored; close tabs after saving; reopen them on restore. |
| `tabGroups` | Save each tab group's name, colour and collapsed state, and rebuild the groups on restore. |
| `storage` | Keep settings and small state (theme, the 10-second undo, window names) on the device. |
| `unlimitedStorage` | People save thousands of tabs; the IndexedDB database must not hit the default quota and lose saves. |
| `alarms` | Run scheduled jobs without a long-running background page: background snapshots for crash recovery, auto-suspend of idle tabs, and the daily Trash clean-up. |
| `contextMenus` | "Save this tab", "Save this tab with keywords…" and "Save this window" in the page's right-click menu. |
| `favicon` | Show site icons for saved tabs from Chrome's local favicon cache, without loading anything from the network. |

**No host permissions and no content scripts.** Tabfold never reads or modifies web pages.

## Assets

All in `docs/store/`, rendered from the Chrome Web Store row of the design canvas:

- 128 × 128 icon: `public/icon/128.png` (96 × 96 artwork with 16 px transparent padding, per Chrome's guidelines; `npm run icons` regenerates it).
- 5 screenshots at 1280 × 800: `screenshot-1.png` (save all, before and after), `screenshot-2.png` (search by keyword), `screenshot-3.png` (library windows), `screenshot-4.png` (keyword picker), `screenshot-5.png` (private by design). They show the Free plan only.
- Small promo tile 440 × 280: `promo-small-440x280.png`.

## Privacy

Link to the privacy policy: see `docs/privacy.md`. Data-use disclosures: Tabfold does not collect or transmit any user data.
