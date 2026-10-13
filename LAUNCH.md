# Launching Tabfold 1.0

The go-live checklist, in order. Each step happens in your own accounts; the boxes already ticked
were done for you through the connectors, and no keys are written here. The detailed set-up is in
[`server/README.md`](server/README.md) (the server, Stripe, Zoho Mail, Anthropic) and
[`web/README.md`](web/README.md) (the public site); this list says when to do each part and what to
check. Tick the boxes as you go.

Tabfold lives under Truewidgets: the site at `https://tabfold.truewidgets.com` (Vercel), payments in
the Truewidgets Stripe account, email from Truewidgets' Zoho Mail. You also need accounts at
supabase.com and console.anthropic.com, and a Google account for the Chrome Web Store. Keep every
key in a password manager; none of them goes in the repository.

## 1. The privacy policy and terms

Filled in on 13 October 2026: owner "Truewidgets, a division of Loom Factor Ltd", effective date
13 October 2026, contact hello@truewidgets.com, governing law England and Wales, server region the
United Kingdom (London).

- [x] No placeholder left (`grep -n 'class="placeholder"' web/*.html` prints nothing).
- [ ] Read both pages in full. They're plain-language drafts that match what Tabfold 1.0 does, not
  legal advice: have someone qualified look at them, especially refunds, the EU's 14-day
  withdrawal right for digital services, and the liability limits. They commit you to: telling
  subscribers by email before a price change applies to their renewal; emailing account holders
  before terms change in a way that matters to them, and before the server ever shuts down; no
  refunds for unused parts of a period unless the law requires one; Pro for life lasting as long as
  you offer Tabfold Pro. Change any of these before publishing if they don't suit you.
- [ ] Check two statements about providers against their current terms: that Anthropic doesn't
  train on API requests under its commercial terms (privacy policy, "The AI features"), and that
  Supabase's request logs are short-lived (in the dashboard, **Logs** and your plan's retention).

## 2. Supabase: the database and the server

Done on 13 October 2026 through the Supabase connector, in the **Truewidgets** organization:

- [x] Project **tabfold** (`wafuqionthouhbcbyjiv`), region London (eu-west-2). Server address:
  `https://wafuqionthouhbcbyjiv.supabase.co/functions/v1/tabfold`.
- [x] The database: all five migrations, recorded in the migration history (so a later
  `supabase db push` skips them). The connector waits for a confirmation it can't show on SQL that
  deletes, drops or revokes, and the SQL Editor split the file inside a function, so a one-off
  function (`tabfold-setup`) ran the five files from GitHub at a pinned commit in one transaction,
  the way `supabase db push` does; it's now an empty stub that answers 410 and can be deleted
  (Edge Functions → tabfold-setup → Delete). Checked afterwards: 19 tables, all with row level
  security and none readable with the public keys; 16 `tabfold_…` functions, callable only by the
  server; `trial_used` there. Supabase's security advisor reports only "RLS enabled, no policy"
  (intended: only the server reads these tables).
- [x] Function **tabfold** deployed with **Verify JWT** off (it checks device tokens and Stripe's
  signature itself). Its code imports `server/supabase/functions/tabfold/index.ts` from this
  repository at a pinned commit on GitHub; to deploy a newer version, change the commit in that one
  line (Edge Functions → tabfold → Code), or run `supabase functions deploy tabfold --no-verify-jwt`
  from `server/`. `…/tabfold/me` answers `{"error":"not-signed-in", …}`.

Still to do:

- [x] **Secrets** (Edge Functions → Secrets; server/README.md step 8 says what each is): `SMTP_USER`,
  `SMTP_PASS`, `EMAIL_FROM`, `SHARE_BASE_URL`, `CODE_SECRET`, `STRIPE_SECRET_KEY` (a restricted
  key), `STRIPE_WEBHOOK_SECRET`, `STRIPE_PORTAL_CONFIGURATION`, `ANTHROPIC_API_KEY`. A real sign-in
  code reached hello@truewidgets.com through Zoho on 13 October 2026. `ALLOWED_ORIGINS` comes in
  step 8, once the store gives the extension its id. Never set `STRIPE_API_BASE` on the real
  server.
- [x] `CODE_SECRET`: a long random string (64 characters from your password manager's generator),
  set **once, before the first trial**, and kept in the password manager. It keys the sign-in codes,
  the rate limits' keys and the trial fingerprints (one trial per email, even after an account is
  deleted); changing it later lets emails that had the trial start it again. You also need it to
  delete an account by hand (server/README.md, "What the server keeps").
- [ ] Upgrade the project to **Pro** before the first paying user (Free projects pause after a week
  without activity), and keep the **spend cap** on.

## 3. Stripe in live mode

Tabfold sells through the **Truewidgets** Stripe account, next to its other products. That's safe:
every Tabfold price's lookup key starts with `tabfold-`, every checkout Tabfold starts is marked
`metadata.app = "tabfold"`, and the server ignores every other checkout and subscription in the
account. Customers see **Truewidgets** on the checkout page, receipts and their card statement.

Done on 13 October 2026, in live mode, through the Stripe connector:

- [x] Products: Tabfold Pro (`prod_VQv2070YPxI9Bo`), Tabfold Pro AI (`prod_VQv2Bsc2NmkaFB`), Tabfold
  Pro for life (`prod_VQv46071hRdzD9`), Tabfold Teams (`prod_VQv5rIB6IfOa7O`), tax code SaaS like the
  account's other products.
- [x] Prices: `tabfold-pro-monthly` $5, `tabfold-pro-yearly` $48, `tabfold-pro-ai-monthly` $9,
  `tabfold-pro-ai-yearly` $84, `tabfold-pro-lifetime` $99 once, `tabfold-teams-monthly` $10 a person,
  `tabfold-teams-yearly` $96 a person.
- [x] Billing portal settings "Tabfold" (`bpc_1UQ3JiINR0TE37QMiS1O1D9V`, not the account's default,
  so Truewidgets' own portal is unchanged): invoices, card, email and address, switching between the
  Pro and Pro AI prices, cancelling at the end of the period.

Still to do:

- [ ] **Test mode first**: the products above are live only. For a test run, the same with your
  test key: `STRIPE_SECRET_KEY=sk_test_… node server/scripts/stripe-setup.mjs --webhook-url …`
  (server/README.md step 4), then its "Test it" list with the test card.
- [ ] **Keep Truewidgets' public details** (Settings → Business → Public details): don't rename
  the account to Tabfold, it would change the name on the other products too. Optionally add
  Tabfold's privacy and terms links to Tabfold's portal settings once the site is live.
- [x] **The webhook** (`we_1UQ5ABINR0TE37QMkXEHphuV`), made through the connector: it sends
  `checkout.session.completed`, `checkout.session.async_payment_succeeded` and
  `customer.subscription.created`, `.updated`, `.deleted` to
  `https://wafuqionthouhbcbyjiv.supabase.co/functions/v1/tabfold/stripe/webhook` (made with API
  version 2024-06-20; that doesn't matter, because the server only takes each event's id and type
  and reads the checkout or subscription from Stripe itself, in its own version).
- [x] **Managed Payments**: the Truewidgets account has it on, so Stripe is the merchant of record
  for Tabfold's sales too: it works out, collects and files sales tax and VAT, and handles fraud
  and disputes. Stripe only allows API version `2025-03-31.basil` or later with it, which the server
  now uses. Don't set `STRIPE_AUTOMATIC_TAX` (Managed Payments refuses Stripe Tax settings on a
  checkout).
- [x] Its **signing secret** (Developers → Webhooks → that endpoint → Signing secret → Reveal) →
  the `STRIPE_WEBHOOK_SECRET` secret in Supabase. `STRIPE_PORTAL_CONFIGURATION` is
  `bpc_1UQ3JiINR0TE37QMiS1O1D9V`.
- [x] **The server's key**: a **restricted key** (Developers → API keys → Create restricted key,
  named "Tabfold server") rather than the account's secret key, since the account also runs
  Truewidgets' other products. Permissions: Checkout Sessions **Write**, Customers **Write**,
  Subscriptions **Write**, Prices **Read**, Products **Read**, Customer portal **Write**; everything
  else None. It (`rk_live_…`) → `STRIPE_SECRET_KEY`.
- [ ] **Truewidgets' other webhooks** also receive Tabfold's events (Stripe sends every event to
  every endpoint that listens for it): `https://api.truewidgets.com/webhooks/stripe` says it ignores
  other products; check that `https://app.truewidgets.com/stripe/webhook` does too, i.e. it ignores
  checkouts whose `metadata.app` is `tabfold` and subscriptions to `tabfold-` prices, so a Tabfold
  purchase doesn't also count as a Truewidgets app purchase.
- [ ] **Settings → Customer emails**: receipts for successful payments and refunds on; Billing's
  revenue recovery emails on.

## 4. Zoho Mail (sign-in codes and team invitations)

server/README.md step 5. Truewidgets' Zoho Mail already sends for truewidgets.com (its SPF and DKIM
are set up), so there's no domain to verify.

- [x] Choose the sending mailbox, e.g. `hello@truewidgets.com` → `SMTP_USER`. Optionally an alias
  for Tabfold (`tabfold@truewidgets.com`) in Zoho Mail's settings.
- [x] Zoho Accounts → **Security → App passwords** → generate "Tabfold server" → `SMTP_PASS`.
- [x] `EMAIL_FROM="Tabfold <hello@truewidgets.com>"` (the mailbox or its alias, nothing else).
- [x] The account is on zoho.eu (you sign in at mail.zoho.eu)? Nothing more: the server uses
  `smtp.zoho.eu:465`. On zoho.com: `SMTP_HOST=smtp.zoho.com`.
- [x] A real code reached hello@truewidgets.com (13 October 2026).
- [ ] A test code reaches a Gmail and an Outlook inbox, not spam. If it
  doesn't arrive, the function's log names the step (`535 at AUTH`: wrong app password; `553 at
  MAIL FROM`: `EMAIL_FROM` isn't the mailbox or its alias; `could not be reached`: the host or port).

## 5. Anthropic (Pro AI)

server/README.md step 6.

- [x] An API key for Tabfold → `ANTHROPIC_API_KEY`.
- [ ] **Settings → Limits**: a monthly spend limit (start around $50; a heavy Pro AI user costs well
  under $1 a month) and an email alert below it.

## 6. The public site on Vercel

Done on 13 October 2026 through the Vercel connector, in Truewidgets' Vercel team:

- [x] Project **tabfold**, deploying the `web` folder of this repository (Root Directory `web`, no
  build step). Live at `https://tabfold.vercel.app`: the home page, `/privacy`, `/terms` and
  `/s/<id>` (with `vercel.json`'s headers).
- [x] Domain `tabfold.truewidgets.com` added to the project.

Still to do:

- [x] **DNS at GoDaddy** (truewidgets.com's DNS is there): a **CNAME** record, name `tabfold`,
  value `cname.vercel-dns.com`. Vercel then issues the HTTPS certificate by itself; the project's
  **Settings → Domains** turns green.
- [x] In `web/config.js`: `API_URL` = `https://wafuqionthouhbcbyjiv.supabase.co/functions/v1/tabfold`.
  `EXTENSION_ID` and `STORE_URL` wait for step 9.
- [x] `https://tabfold.truewidgets.com` (HTTPS), `/privacy` and `/terms` open, with no placeholder
  left; the home page's footer links both.

## 7. Build the store zip

After the 1.0 branches are merged and every test passes (`npm run compile`, `npm test`,
`npx wxt build`, `node e2e/smoke.mjs`, `node e2e/folders.mjs`, `npm run e2e:pro`):

- [x] `package.json` says `"version": "1.0.0"` (the manifest takes it from there).
- [ ] Optional: the store summary comes from the manifest's `description` in `wxt.config.ts`;
  `store/listing.md` suggests a new one.
- [x] Built against the live server and site on 13 October 2026 (the manifest checked as below):

  ```sh
  WXT_TABFOLD_API=https://<project id>.supabase.co/functions/v1/tabfold WXT_SHARE_ORIGIN=https://tabfold.truewidgets.com npm run zip
  ```

  This makes `.output/tabfold-1.0.0-chrome.zip` from `.output/chrome-mv3`.
- [x] Check the manifest it was made from:

  ```sh
  node -e "const m=require(process.argv[1]);console.log({version:m.version,permissions:m.permissions,optional:m.optional_permissions,hosts:m.host_permissions??'none',contentScripts:m.content_scripts??'none',connect:/connect-src ([^;]*)/.exec(m.content_security_policy.extension_pages)[1],site:m.externally_connectable.matches})" ./.output/chrome-mv3/manifest.json
  ```

  Expect version `1.0.0`; permissions exactly `tabs, tabGroups, storage, unlimitedStorage, alarms,
  contextMenus, favicon, system.memory, sidePanel`; optional `bookmarks`; hosts and content scripts
  `none`; `connect` = `'self' https://<project id>.supabase.co`; site `https://tabfold.truewidgets.com/*`. Anything
  else: stop and find out why (the privacy tab in `store/privacy-practices.md` justifies exactly
  these).
- [ ] Load `.output/chrome-mv3` unpacked in a fresh Chrome profile and fold a window once.
- [x] Store images: `node store/screenshots.mjs` (after the 1.0 screens are merged). It prints what
  it saved in `store/images/` and anything it skipped; look at all six images.

## 8. The Chrome Web Store

- [ ] **Developer account**: chrome.google.com/webstore/devconsole with the Google account that will
  own Tabfold (2-step verification on), the one-time registration fee, and the contact email
  verified. Answer the **trader** question (selling paid plans makes you a trader in the EU: your
  address and email are then shown on the listing).
- [ ] **Items → New item**: upload `tabfold-1.0.0-chrome.zip` (the store build from step 7, made
  against the live server). The dashboard now shows the
  extension's **id** (32 letters).
- [ ] With that id, let the store copy talk to the server, and stop allowing any extension:
  `supabase secrets set ALLOWED_ORIGINS=chrome-extension://<id>` (add your development copy's id
  after a comma if you still need it). Deploy again to be sure:
  `supabase functions deploy tabfold --no-verify-jwt`.
- [ ] **Store listing** tab: everything in `store/listing.md` (description, category Productivity,
  language English, icon, the five screenshots in order, the small promo tile, homepage and
  support URLs).
- [ ] **Privacy** tab: everything in `store/privacy-practices.md` (single purpose, one justification
  per permission, remote code: no, the data categories, the three certifications, privacy policy
  `https://tabfold.truewidgets.com/privacy`).
- [ ] **Distribution**: Public; all regions (or the ones you choose); the item itself is free (paid
  plans are sold on Stripe).
- [ ] If there's a field for the reviewers: "Free needs no account. To try the paid features, start
  the 7-day Pro AI trial from the plans page with any email address; the code arrives by email."
- [ ] **Submit for review**. Choose whether to publish automatically on approval; manual gives you
  time for step 9 first.

## 9. After approval

- [ ] In `web/config.js`: `EXTENSION_ID` = the id, `STORE_URL` =
  `https://chromewebstore.google.com/detail/<id>` (the address the listing shows). Deploy the site
  again (`web/README.md`, "Deploy to Vercel").
- [ ] Publish the item if you chose manual publishing.

## 10. Live smoke test

With the store copy, on a computer and Chrome profile you don't develop on:

- [ ] Install from the store; fold a window; the welcome page and the popup work.
- [ ] **Sign up**: plans page → start the 7-day trial with a real email; the code arrives from
  `EMAIL_FROM`; Pro AI switches on; Organise with AI answers.
- [ ] **A real purchase**: buy Pro monthly with your own card. Stripe's page shows Tabfold's name
  and branding; the tab turns into "You're on Tabfold Pro"; Stripe's dashboard shows the payment and
  the webhook delivery answered 200.
- [ ] **Refund** it: Stripe → **Payments** → the payment → **Refund**. A refund doesn't cancel
  the plan: cancel it in Settings › Your plan › Manage billing, or in the next step.
- [ ] **Share a folder** with a note; open the link in a private window: the name, note and pages
  show; "Save to my Tabfold" adds it on a second profile; **Stop sharing**: the link says it
  doesn't work any more.
- [ ] **Delete the test account**: Settings › "Delete my Tabfold account…", type the email. Then: in
  Supabase **Table Editor** the `accounts` row is gone (and its `devices`, `shares`, `backups`);
  `trial_used` has one row (a 64-character fingerprint, no email); in Stripe the subscription is
  **Canceled**; the shared link answers 404; the folded tabs are still on the computer. Sign in
  again with the same email and press the trial button: it says the trial was used.

## 11. The first week

Look daily:

- **Supabase**: **Edge Functions → tabfold → Logs** for `failed` lines (Stripe or the database),
  "Changing a team's seats failed", "Pruning old backups failed" and "AI failed"; **Reports** for
  invocations and database size; the bill.
- **Stripe**: **Developers → Webhooks →** the endpoint: every delivery 200 (failed ones retry for 3
  days; fix the cause, then **Resend**); **Payments** for failures and disputes; new subscriptions
  match people on Pro in Supabase.
- **Zoho Mail**: the sending mailbox's inbox for bounces, and that it stays within Zoho's daily
  sending limit (if it gets close, ZeptoMail works with the same code: server/README.md step 5).
- **Anthropic**: **Usage** and spend against the limit; rate-limit errors in the server log.
- **Chrome Web Store**: reviews and the support tab; installs and uninstalls in **Analytics**.
- **Vercel**: the project **tabfold** is up; its usage.

## Worth knowing

- One trial per email holds even after an account is deleted: the server keeps a one-way
  fingerprint of each email that had the trial (`trial_used`), keyed with `CODE_SECRET`. The privacy
  policy says so.
- Once a day, the first sync of the day deletes backups older than 30 days (every account) and the
  folders of teams whose plan ended more than 30 days ago (the team itself stays, so its owner can
  start it again). With no paying user syncing on a day, they go the next day someone does.
- A team's folders are stored as its members' computers send them; the server can't edit them. So
  when someone deletes their account, the tabs they added to a team keep their email as "added by"
  until the team removes them or its folders are deleted. The privacy policy says so.
- Rate limits are counted under an HMAC (keyed with `CODE_SECRET`) of the email, computer or IP
  address, never the value itself or a plain hash of it.
- A subscription Stripe doesn't know (for example a test-mode id left over after switching to live
  keys) counts as ended when its account is deleted, so the deletion goes through.
