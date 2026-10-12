# Launching Tabfold 1.0

The go-live checklist, in order. Each step happens in your own accounts; nothing here has been done
for you, and no ids or keys are filled in. The detailed set-up is in
[`server/README.md`](server/README.md) (the server, Stripe, Resend, Anthropic) and
[`web/README.md`](web/README.md) (the public site); this list says when to do each part and what to
check. Tick the boxes as you go.

You need: a domain (below, `tabfold.app`; use yours everywhere it appears), and accounts at
supabase.com, stripe.com, resend.com, console.anthropic.com, netlify.com and a Google account for
the Chrome Web Store. Keep every key in a password manager; none of them goes in the repository.

## 1. Fill in the placeholders

The privacy policy and terms have highlighted placeholders. Replace each
`<span class="placeholder">[…]</span>` with plain text (`web/README.md`, "Before you publish").

| Placeholder | Where | What to put |
| --- | --- | --- |
| `[Company or owner name]` | `web/privacy.html`, `web/terms.html` | Your company's legal name, or your own name if you sell as a person |
| `[Contact email]` | `web/privacy.html`, `web/terms.html`; the store's Support URL (`store/listing.md`) | An address you read, e.g. `privacy@tabfold.app` (it can be the same for support) |
| `[Effective date]` | `web/privacy.html`, `web/terms.html` | The day you publish them, e.g. 20 October 2026 |
| `[Country/State for governing law]` | `web/terms.html` | Where your business is, e.g. "England and Wales", "the State of Delaware, USA" |
| `[Server region]` | `web/privacy.html` | Your Supabase project's region (step 2), e.g. "the EU (Frankfurt)" |

- [ ] All five filled in; `grep -n 'class="placeholder"' web/*.html` prints nothing.
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

Follow `server/README.md` steps 1 to 3, then 8 and 9 after Stripe, Resend and Anthropic (steps 3–5
here) give you their keys.

- [ ] Project created; its **region** written into `[Server region]`.
- [ ] `cd server && supabase link --project-ref <project id> && supabase db push` applies all five
  migrations, including `20261013000000_v10.sql` (a shared folder's note, account deletion) and
  `20261014000000_v10_trials.sql` (one trial per email, clearing ended teams' folders). In
  **Database → Functions** you should see `tabfold_account_delete` and `tabfold_team_sync_prune`, and
  in **Table Editor** a `trial_used` table.
- [ ] Upgrade the project to **Pro** before the first paying user (Free projects pause after a week
  without activity), and keep the **spend cap** on.
- [ ] Secrets set (server/README.md step 8): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_PORTAL_CONFIGURATION`, `RESEND_API_KEY`, `EMAIL_FROM`, `ANTHROPIC_API_KEY`,
  `SHARE_BASE_URL=https://tabfold.app`, optionally `STRIPE_AUTOMATIC_TAX=true`. `ALLOWED_ORIGINS`
  comes in step 8, once the store gives the extension its id. Never set `STRIPE_API_BASE` on the real
  server. `supabase secrets list` shows the names.
- [ ] `CODE_SECRET`: a long random string (`openssl rand -hex 32`), set **once, before the first
  trial**, and kept in your password manager. It keys the sign-in codes, the rate limits' keys and
  the trial fingerprints (one trial per email, even after an account is deleted); changing it later
  lets emails that had the trial start it again. You also need it to delete an account by hand (server/README.md, "What
  the server keeps").
- [ ] `supabase functions deploy tabfold --no-verify-jwt`, then
  `https://<project id>.supabase.co/functions/v1/tabfold/me` in a browser answers
  `{"error":"not-signed-in", …}`.

## 3. Stripe in live mode

Do server/README.md step 4 in **test mode** first and run its "Test it" list end to end with the
test card. Then live mode (server/README.md step 11):

- [ ] **Activate the account** (business details, bank account), then turn off **Test mode**.
- [ ] **Settings → Business → Public details**: name Tabfold, support email (`[Contact email]`),
  website `https://tabfold.app`, **Privacy policy** `https://tabfold.app/privacy`, **Terms of
  service** `https://tabfold.app/terms`. **Settings → Branding**: icon, colours (live mode has its
  own copy of these).
- [ ] Products, prices, billing portal and webhook, with the **live** key:
  `STRIPE_SECRET_KEY=sk_live_… node server/scripts/stripe-setup.mjs --webhook-url https://<project id>.supabase.co/functions/v1/tabfold/stripe/webhook`.
  It prints the `supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_… STRIPE_PORTAL_CONFIGURATION=bpc_…`
  line: run it, plus `supabase secrets set STRIPE_SECRET_KEY=sk_live_…`.
- [ ] **Developers → Webhooks**: the endpoint is the address above and listens to
  `checkout.session.completed`, `checkout.session.async_payment_succeeded` and
  `customer.subscription.created`, `.updated`, `.deleted`.
- [ ] **Settings → Billing → Customer portal** (live): invoices, card, the four Pro and Pro AI
  prices to switch between, cancelling at the end of the period. The script set these; check them.
- [ ] **Tax**: either set up Stripe Tax (**Tax**: your address, registrations, default tax
  behaviour) and `supabase secrets set STRIPE_AUTOMATIC_TAX=true`, or decide with your accountant
  that you don't need it yet. Stripe Tax collects; registering and filing is up to you.
- [ ] **Settings → Customer emails**: receipts for successful payments and refunds on; Billing's
  revenue recovery emails on.

## 4. Resend (sign-in codes and team invitations)

server/README.md step 5.

- [ ] **Domains → Add domain** `tabfold.app`; add the DNS records it shows at your registrar;
  **Verify** turns green.
- [ ] An API key with **Sending access** only → `RESEND_API_KEY`; `EMAIL_FROM="Tabfold <hello@tabfold.app>"`.
- [ ] A test code reaches a Gmail and an Outlook inbox, not spam.

## 5. Anthropic (Pro AI)

server/README.md step 6.

- [ ] An API key for Tabfold → `ANTHROPIC_API_KEY`.
- [ ] **Settings → Limits**: a monthly spend limit (start around $50; a heavy Pro AI user costs well
  under $1 a month) and an email alert below it.

## 6. The public site on Netlify

Follow `web/README.md`.

- [ ] In `web/config.js`: `API_URL` = `https://<project id>.supabase.co/functions/v1/tabfold`.
  Leave `EXTENSION_ID` empty and `STORE_URL` as it is until step 9.
- [ ] Deploy the `web` folder; add the domain `tabfold.app` (**Domain management**); HTTPS is on.
- [ ] `https://tabfold.app/privacy` and `https://tabfold.app/terms` open, with no placeholder left;
  the home page's footer links both.

## 7. Build the store zip

After the 1.0 branches are merged and every test passes (`npm run compile`, `npm test`,
`npx wxt build`, `node e2e/smoke.mjs`, `node e2e/folders.mjs`, `npm run e2e:pro`):

- [ ] `package.json` says `"version": "1.0.0"` (the manifest takes it from there).
- [ ] Optional: the store summary comes from the manifest's `description` in `wxt.config.ts`;
  `store/listing.md` suggests a new one.
- [ ] Build against the live server and site:

  ```sh
  WXT_TABFOLD_API=https://<project id>.supabase.co/functions/v1/tabfold WXT_SHARE_ORIGIN=https://tabfold.app npm run zip
  ```

  This makes `.output/tabfold-1.0.0-chrome.zip` from `.output/chrome-mv3`.
- [ ] Check the manifest it was made from:

  ```sh
  node -e "const m=require(process.argv[1]);console.log({version:m.version,permissions:m.permissions,optional:m.optional_permissions,hosts:m.host_permissions??'none',contentScripts:m.content_scripts??'none',connect:/connect-src ([^;]*)/.exec(m.content_security_policy.extension_pages)[1],site:m.externally_connectable.matches})" ./.output/chrome-mv3/manifest.json
  ```

  Expect version `1.0.0`; permissions exactly `tabs, tabGroups, storage, unlimitedStorage, alarms,
  contextMenus, favicon, system.memory, sidePanel`; optional `bookmarks`; hosts and content scripts
  `none`; `connect` = `'self' https://<project id>.supabase.co`; site `https://tabfold.app/*`. Anything
  else: stop and find out why (the privacy tab in `store/privacy-practices.md` justifies exactly
  these).
- [ ] Load `.output/chrome-mv3` unpacked in a fresh Chrome profile and fold a window once.
- [ ] Store images: `node store/screenshots.mjs` (after the 1.0 screens are merged). It prints what
  it saved in `store/images/` and anything it skipped; look at all six images.

## 8. The Chrome Web Store

- [ ] **Developer account**: chrome.google.com/webstore/devconsole with the Google account that will
  own Tabfold (2-step verification on), the one-time registration fee, and the contact email
  verified. Answer the **trader** question (selling paid plans makes you a trader in the EU: your
  address and email are then shown on the listing).
- [ ] **Items → New item**: upload `tabfold-1.0.0-chrome.zip`. The dashboard now shows the
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
  `https://tabfold.app/privacy`).
- [ ] **Distribution**: Public; all regions (or the ones you choose); the item itself is free (paid
  plans are sold on Stripe).
- [ ] If there's a field for the reviewers: "Free needs no account. To try the paid features, start
  the 7-day Pro AI trial from the plans page with any email address; the code arrives by email."
- [ ] **Submit for review**. Choose whether to publish automatically on approval; manual gives you
  time for step 9 first.

## 9. After approval

- [ ] In `web/config.js`: `EXTENSION_ID` = the id, `STORE_URL` =
  `https://chromewebstore.google.com/detail/<id>` (the address the listing shows). Deploy the site
  again (drag the folder, or push).
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
- **Resend**: **Emails** for bounces and complaints (a rising bounce rate puts sending at risk);
  delivery times.
- **Anthropic**: **Usage** and spend against the limit; rate-limit errors in the server log.
- **Chrome Web Store**: reviews and the support tab; installs and uninstalls in **Analytics**.
- **Netlify**: the site is up; bandwidth.

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
