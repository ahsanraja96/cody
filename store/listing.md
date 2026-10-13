# Chrome Web Store listing: Tabfold 1.0

What goes in the Chrome Web Store developer dashboard (chrome.google.com/webstore/devconsole) for
Tabfold 1.0. Copy each block as it is. The privacy tab is in [`privacy-practices.md`](privacy-practices.md);
the images come from [`screenshots.mjs`](screenshots.mjs). `LAUNCH.md` at the repository root says
when to do what.

## Name

**Tabfold**

The store takes the name from the manifest (`name` in `wxt.config.ts`), so it can't differ from it.

## Summary (132 characters at most)

```text
Fold your tabs into one list, free the memory they used, and find any tab again. Folders, side panel, search and sync.
```

118 characters. The store also takes the summary from the manifest (`description` in
`wxt.config.ts`), which says the same; if the dashboard shows an editable summary field, paste it
there too, so the two match.

## Category and language

- **Category:** Productivity (if the dashboard asks for a narrower one: Workflow & Planning).
- **Language:** English.

## Description

Paste everything in the block below (plain text: the store keeps line breaks and doesn't render
Markdown). About 3,800 characters; the store allows 16,000.

```text
Too many tabs? Tabfold folds them into one list and gives Chrome its memory back. Find any tab again in a second, on any of your computers.

FOLD YOUR TABS
• One click folds a window, or all of them: your tabs are saved, then closed, and the memory they used is freed. Undo for 10 seconds.
• Fold into a folder: the Fold button's menu, a window's ⋯ menu, or right-click › Fold this tab into.
• Fold back: a folder you opened with "Open all" becomes a Chrome tab group; fold it and its tabs go back into the folder, including tabs you added since.
• Pinned tabs and tabs playing sound stay open. Incognito windows are folded only if you turn it on.
• Shortcuts: Ctrl+Shift+S folds (⌘+Shift+S on a Mac), Alt+Shift+S folds this tab, Alt+Shift+Z snoozes it, Alt+Shift+F opens Tabfold.

ONE LIST, WITH FOLDERS
• Your folders come first, starred ones at the top, each with an optional one-line note. Everything else sorts itself by kind of site: Dev, Docs, Mail & chat, Social, Video, AI, Shopping, Reading.
• Drag tabs onto a folder, or use Move to. Click a tab to open it; "Open all" opens a folder as a tab group.
• Snooze a tab until later today, tomorrow, the weekend or a time you pick: it comes back by itself.

TABFOLD IN THE SIDE PANEL
• Keep Tabfold open next to the page you're on: search, your open tabs by window, and your folders.
• Drag an open tab onto a folder to fold it in. Settings › "Toolbar button opens" chooses the popup or the side panel.

FIND ANY TAB, OPEN OR FOLDED
• Search by title, address or keyword. Tabs that are open now come first, with their window's name; Enter switches to the tab.
• Ctrl+K in the full list jumps to a folder, an action, a folded tab or an open one.

KEEP YOUR WINDOWS TIDY
• Close the copies: "3 pages are open twice" closes the extra copies and keeps the one you looked at last.
• Tidy into groups: a window's loose tabs become Chrome tab groups by kind of site.
• Name your windows ("Client work"): Tabfold remembers the names after Chrome restarts, and a named window's fold takes its name.
• Fold automatically: tabs you haven't looked at for days, every evening, one site's idle tabs, or a window with more than 25 tabs.
• On Mondays, a short summary of last week: what you folded and the memory you freed.

MORE
• Same list on your other computers through Chrome sync, with no account.
• Import from OneTab, Toby, Workona, Session Buddy, a Chrome bookmarks folder or a list of links.
• Export as a web page. Duplicates, crash recovery, light and dark, keyboard and screen-reader friendly.

FREE AND PAID
Free: 500 folded tabs, 3 folders, 3 snoozed tabs at a time and 1 Fold automatically rule, with everything above. No account.
Pro ($5 a month, $48 a year, or $99 once for life): no limits, every tab on every computer through your Tabfold account, daily backups for 30 days, live folders, sharing a folder as a link, Markdown, CSV and JSON export.
Pro AI ($9 a month or $84 a year, 7-day free trial, no card): Pro, plus Organise with AI, smart names for folds, Ask your tabs, Copy as context and a weekly tidy-up.
Teams ($10 a person a month, or $96 a person a year): Pro AI for everyone, plus team folders.
Payments go through Stripe. Cancel any time. When a plan ends, nothing is taken away.

PRIVACY
Tabfold never reads what's on your pages: it has no access to websites and runs no scripts in them. On Free, your folded tabs stay on your computer, and your newest ones go to your own Chrome sync (you can turn that off). With a paid plan, your folded tabs' titles and addresses are kept on Tabfold's server to sync your computers. The AI features send only tab titles and sites, never pages, never Incognito tabs. No ads, no analytics, and your data is never sold. Privacy policy: https://tabfold.truewidgets.com/privacy
```

Keep the prices in step with `server/scripts/stripe-setup.mjs` and the plans page. If the public site
isn't at `https://tabfold.truewidgets.com`, change the privacy policy's address in the last line.

## Other fields

| Field | Value |
| --- | --- |
| Store icon | `public/icon/128.png` (128 × 128, artwork 96 × 96 with transparent padding) |
| Screenshots | `store/images/1-full-list.png` … `5-plans.png` (1280 × 800, in that order) |
| Small promo tile | `store/images/promo-small-440x280.png` |
| Marquee promo tile | Leave empty (optional) |
| Official URL | Leave empty, unless the site's domain is verified in Google Search Console for this developer account |
| Homepage URL | `https://tabfold.truewidgets.com` (the public site; your own domain if different) |
| Support URL | `https://tabfold.truewidgets.com` (support email: hello@truewidgets.com) |
| Mature content | No |
| Privacy policy URL (Privacy tab) | `https://tabfold.truewidgets.com/privacy` |
