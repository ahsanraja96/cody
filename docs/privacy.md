# Tabfold privacy policy

_Last updated: October 10, 2026_

Tabfold is a tab manager. It works on your computer. Free Tabfold has no account and sends nothing to Tabfold's servers; only if you choose Pro or Pro AI does anything go to them (see "Pro and Pro AI" below).

## What Tabfold stores

When you fold tabs, Tabfold stores, for each tab: its address, title, favicon link, pinned state, tab group name and colour, the keywords you pick, which window it was in, and when it was folded. It also stores your settings and recent snapshots of your open windows, used to bring your tabs back after a crash or restart.

## Where it is stored

On your computer, in your browser's own extension storage (IndexedDB and `chrome.storage`). On Free, Tabfold never sends anything to Tabfold or to anyone else, and makes no network requests of its own.

## Chrome sync

So your list shows up on your other computers, Tabfold puts your newest folded tabs, about 500 of them, in Chrome's own sync storage (`chrome.storage.sync`). For each of those tabs it shares only:

- its address,
- its title (shortened to 120 characters),
- when it was folded,
- its keywords.

It also shares a short note of tabs you removed, so they disappear on your other computers too.

This goes through your own Chrome sync, the same way Chrome syncs your bookmarks and settings, and only reaches computers where you're signed in to Chrome with the same account. If you aren't signed in to Chrome, or Chrome sync is off, it stays on this computer. Tabfold has no account and can't see any of it.

You can turn it off at any time: in Tabfold's settings ("Sync folded tabs with Chrome"), or in Chrome's own sync settings. Older folded tabs, tab groups, windows, favicons and snapshots are never shared, and neither are tabs folded from Incognito windows. On Free, nothing else leaves your computer.

## Pro and Pro AI

Pro and Pro AI are optional paid plans. Nothing in this section happens on Free.

**Payments and sign-in.** Payments, the 7-day Pro AI trial and signing in on another computer are handled by ExtensionPay (extensionpay.com), with Stripe taking the payment. When you open one of their pages, Tabfold asks ExtensionPay for a random key for this browser and keeps it in Chrome's sync storage, so your other computers signed in to Chrome can use the same plan. ExtensionPay holds your email address and payment details; Tabfold never sees your card. Tabfold reads your plan from ExtensionPay (which plan, whether it's active, and your email) from time to time, to know what's included.

**Sync with your Tabfold account (Pro).** Instead of Chrome sync, Pro keeps your folded tabs on Tabfold's server, so every folded tab, not just the newest 500, reaches your other computers. For each tab it sends:

- its address,
- its title (shortened to 200 characters),
- when it was folded,
- its keywords,

and a short note of tabs you removed, as with Chrome sync. Tab groups, windows, favicons and snapshots are never sent, and neither are tabs folded from Incognito windows. While Pro syncs, Chrome sync pauses; when the plan ends, Tabfold goes back to Chrome sync and nothing on your computer is removed.

**Daily backups (Pro).** Once a day, the server keeps a copy of what's synced, for 30 days. Older copies are deleted automatically. Restoring a backup only adds back tabs that are missing; it never removes anything.

**Organise with AI, smart names and Copy as context (Pro AI).** When you ask Tabfold to organise your list, name a fold, or summarise a group, it sends the tabs' titles (shortened to 200 characters) and sites (like `github.com`, not full addresses) to Tabfold's server, at most 300 tabs at a time, and the server asks Anthropic's Claude to group or name them. It never sends the content of pages, and never tabs folded from Incognito windows. The answer comes back to your computer, and the server doesn't keep the titles once it has answered. Under Anthropic's commercial terms, they aren't used to train its models.

Tabfold's server keeps your synced tabs, your daily backups, how many AI runs you've used this month, and your plan's email address, which identifies your account. Requests to it are identified by the ExtensionPay key, never stored on the server itself (only a fingerprint of it, for a few minutes).

**Deleting it.** Settings › Clear everything removes your folded tabs on this computer and empties the copy in your Tabfold account; the daily backups that are left are deleted within 30 days. Cancelling your plan (from Tabfold's settings, through ExtensionPay) stops syncing and AI requests. To have your account's synced tabs and backups deleted right away, use Clear everything before you cancel, or write to the address below. Nothing on your computer is ever deleted or locked when a plan ends.

## Free memory

After you fold tabs, Tabfold reads how much free memory your computer has (Chrome's `system.memory`), to show how much folding freed. This number stays on your computer and is never stored or shared.

## Incognito

Tabfold doesn't touch Incognito windows unless you turn on "Fold Incognito windows too" in its settings and also allow Tabfold in Incognito in Chrome's extension settings. Tabs folded from Incognito are kept on this computer in Tabfold's storage (so they survive closing the Incognito window), never go to Chrome sync, and only ever reopen in an Incognito window. Remove them with × or Clear everything like any other tab.

## What Tabfold never does

- It never reads, collects or changes the content of web pages. It has no permission to access pages and runs no scripts in them.
- It never reads form data, passwords or your browsing history.
- It never sells or shares data, and never sends anything beyond what "Pro and Pro AI" describes.

## Keyword suggestions

Suggested keywords are worked out on your computer from a tab's title and address only.

## Deleting your data

Remove tabs from your list with ×, or use Settings › Clear everything, which also removes your tabs from Chrome sync (and, with Pro, from your Tabfold account). Removing the extension deletes its data from this browser; Settings › Remove Tabfold… first offers to reopen your tabs, save them to Chrome bookmarks or download them. To remove the copy in Chrome sync or your Tabfold account as well, use Clear everything first.

## Changes

If a future version changes what Tabfold stores or shares, this policy will be updated first.

## Contact

[Contact email]
