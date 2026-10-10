# Tabfold privacy policy

_Last updated: October 10, 2026_

Tabfold is a tab manager. It works on your computer, with no Tabfold account and no Tabfold servers.

## What Tabfold stores

When you fold tabs, Tabfold stores, for each tab: its address, title, favicon link, pinned state, tab group name and colour, the keywords you pick, which window it was in, and when it was folded. It also stores your settings and recent snapshots of your open windows, used to bring your tabs back after a crash or restart.

## Where it is stored

On your computer, in your browser's own extension storage (IndexedDB and `chrome.storage`). Tabfold never sends anything to Tabfold or to anyone else, and makes no network requests of its own.

## Chrome sync

So your list shows up on your other computers, Tabfold puts your newest folded tabs, about 500 of them, in Chrome's own sync storage (`chrome.storage.sync`). For each of those tabs it shares only:

- its address,
- its title (shortened to 120 characters),
- when it was folded,
- its keywords.

It also shares a short note of tabs you removed, so they disappear on your other computers too.

This goes through your own Chrome sync, the same way Chrome syncs your bookmarks and settings, and only reaches computers where you're signed in to Chrome with the same account. If you aren't signed in to Chrome, or Chrome sync is off, it stays on this computer. Tabfold has no account and can't see any of it.

You can turn it off at any time: in Tabfold's settings ("Sync folded tabs with Chrome"), or in Chrome's own sync settings. Older folded tabs, tab groups, windows, favicons and snapshots are never shared. Nothing else leaves your computer.

## Free memory

After you fold tabs, Tabfold reads how much free memory your computer has (Chrome's `system.memory`), to show how much folding freed. This number stays on your computer and is never stored or shared.

## What Tabfold never does

- It never reads, collects or changes the content of web pages. It has no permission to access pages and runs no scripts in them.
- It never reads form data, passwords or your browsing history.
- It never sells or shares data.

## Keyword suggestions

Suggested keywords are worked out on your computer from a tab's title and address only.

## Deleting your data

Remove tabs from your list with ×, or use Settings › Clear all data, which also removes your tabs from Chrome sync. Removing the extension deletes its data from this browser; to remove the copy in Chrome sync as well, use Clear all data first.

## Changes

If a future version changes what Tabfold stores or shares, this policy will be updated first.

## Contact

[Contact email]
