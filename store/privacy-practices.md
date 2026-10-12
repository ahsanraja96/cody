# Chrome Web Store: the Privacy practices tab

What to enter on the **Privacy practices** tab of Tabfold's item in the developer dashboard, for
1.0. Each answer is checked against the code and the built manifest
(`.output/chrome-mv3/manifest.json` after `npx wxt build`), and matches the privacy policy
(`web/privacy.html`, published at `https://tabfold.app/privacy`; the section names below are its
headings).

The 1.0 manifest asks for: `tabs`, `tabGroups`, `storage`, `unlimitedStorage`, `alarms`,
`contextMenus`, `favicon`, `system.memory`, `sidePanel`; optional `bookmarks`;
`externally_connectable` for the public site; no host permissions and no content scripts. If the
built manifest lists anything else, stop and find out why before submitting.

## Single purpose

```text
Tabfold is a tab manager: it saves ("folds") your open tabs into one searchable list, closing them to free memory, and reopens them when you need them, on any of your computers.
```

## Permission justifications

One box per permission. Paste the text as it is.

**tabs**

```text
To fold tabs Tabfold reads the address, title, pinned state and last-used time of open tabs, then closes them; it reopens them from the list, switches to an open tab from search, finds pages open twice, puts a window's tabs into groups, and lets idle tabs sleep with Chrome's own discard. It never reads page contents.
```

**tabGroups**

```text
Tabfold saves each tab group's name and colour when folding, opens a folder as a tab group ("Open all"), keeps a live folder in step with its group, folds a group back into its folder, and groups a window's loose tabs by kind of site ("Tidy into groups").
```

**storage**

```text
Settings, window names and small state (undo, the fold in progress, snooze times) are kept with chrome.storage on the computer. With Chrome sync on, the newest folded tabs and the folders go in chrome.storage.sync so the same list appears on the person's other computers; it can be turned off in Settings.
```

**unlimitedStorage**

```text
People fold thousands of tabs. The list, its folders and crash-recovery snapshots live in IndexedDB on the computer, and must not hit the default quota and lose a fold.
```

**alarms**

```text
Scheduled work without a page open: reopening snoozed tabs on time, Fold automatically rules, letting idle tabs sleep, crash-recovery snapshots and daily clean-up, sync, keeping shared folders up to date, checking a paid plan, and the weekly tidy-up (Pro AI).
```

**contextMenus**

```text
Right-click on a page: "Fold this tab", "Fold this tab into" a folder, "Fold this tab with keywords…" and "Snooze this tab".
```

**favicon**

```text
Shows each folded tab's site icon from Chrome's own local icon cache (chrome-extension://…/_favicon/), so no icon is ever fetched from the internet.
```

**system.memory**

```text
Reads the computer's free memory before and after a fold, to show how much memory folding freed. The number stays on the computer.
```

**sidePanel**

```text
Tabfold can open in Chrome's side panel, so the list stays next to the page while browsing (Settings › "Toolbar button opens": the popup or the side panel).
```

**bookmarks** (optional; asked for only when the person chooses it)

```text
Asked for only at the moment the person chooses to import a Chrome bookmarks folder, or to save their folded tabs to Chrome bookmarks before removing Tabfold. Tabfold lists the bookmark folders so the person can pick one, and reads or writes only that folder.
```

**externally_connectable** (if the dashboard asks)

```text
Only Tabfold's own website (https://tabfold.app), where someone's shared folder opens, may send one message: "Save to my Tabfold", which adds that shared folder to the person's list. No other site can talk to the extension.
```

**Host permissions:** none. Tabfold doesn't ask for access to any website and has no content scripts.

## Remote code

**Are you using remote code?** No, I am not using remote code.

```text
All of Tabfold's code, fonts and icons are in the package. The content security policy allows scripts only from the extension itself. The paid plans exchange data (JSON) with Tabfold's server; no code is ever downloaded or run from it.
```

## Data usage

**What user data do you plan to collect from users now or in the future?** Tick these:

| Category | Tick? | What and why | Privacy policy section |
| --- | --- | --- | --- |
| Personally identifiable information | **Yes** | The email address of a Tabfold account (paid plans and the trial), to sign in with emailed codes and to tie a plan, sync and a team to it. Team members see each other's emails, and a team's folders show who added each tab (their email; it stays in that team's folders after the person deletes their account, until the team removes the tabs or its folders are deleted). For an email that had the trial, a one-way fingerprint (HMAC) stays after the account is deleted, so the trial is once per email. Flood limits count by an HMAC of the email, never the email. | Your Tabfold account; What else the server keeps; Teams |
| Health information | No | | |
| Financial and payment information | **Yes** | For paid plans, the server keeps a record of the account's subscriptions and Pro for life payment (Stripe's ids, plan, status, dates, seats). Card details are typed on Stripe's own page and never reach Tabfold. | Payments; What else the server keeps |
| Authentication information | **Yes** | The 6-digit sign-in code the person types (kept on the server only as a keyed hash, for 10 minutes) and each computer's random device token (kept only as a SHA-256 fingerprint). | Your email and signing in |
| Personal communications | No | | |
| Location | No | No location is collected. The server's flood limit for shared pages counts visits against an HMAC of the IP address keyed with a server secret (never the address), for at most a day. | What else the server keeps |
| Web history | **Yes** | The titles and addresses of the tabs the person folds, and when: kept on the computer; the newest go to their own Chrome sync; with a paid plan they sync through Tabfold's server; titles and sites go to the AI features. This is the product's function. | Using Tabfold for free; Chrome sync; Your folded tabs; The AI features |
| User activity | No | | |
| Website content | No | Tabfold never reads what's on pages: no host permissions, no content scripts. | What Tabfold never does |

**Certifications** (tick all three):

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

They hold because the only parties that get user data are the service providers that run a feature
the person chose (Supabase for the server, Stripe for payments, Resend for sign-in and invitation
emails, Anthropic for Pro AI), plus Google's own Chrome sync; nothing is used for ads, sold, or
used for anything but Tabfold. See "Who handles your data" in the policy.

**Privacy policy URL:** `https://tabfold.app/privacy` (your own domain if the site is elsewhere).
Publish the site and fill in the policy's placeholders before you submit: the review opens this
address.

## If the review asks

- **Why `tabs` and not `activeTab`?** Folding works on whole windows (every tab, its title and
  address), from the popup, the side panel, the keyboard shortcut and Fold automatically rules,
  without a click on each page.
- **Why does a tab manager send data to a server?** Only on paid plans, to sync the person's own
  list between their computers, keep daily backups and run the features they bought; Free never
  does, apart from reading a shared folder the person asked to save.
