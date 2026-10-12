# Tabfold Pro server API (contract)

One Supabase Edge Function, `tabfold`. The extension's base URL is `WXT_TABFOLD_API`, e.g.
`https://<project>.supabase.co/functions/v1/tabfold`. Free never calls it.

Payments are Stripe Checkout (Stripe's own page, opened in a tab) and Stripe's billing portal.
Accounts are an email address, proved with a 6-digit code sent by email. The 7-day Pro AI trial
lives on this server (one per email, no card). Nothing about payments runs inside the extension.

## Auth: device tokens

Every request from the extension sends `Authorization: Bearer <device token>`: 32 random bytes,
base64url (43 characters), made by the extension on first use and kept in `chrome.storage.local`
as `tabfoldDevice`. The server stores only its SHA-256 (`devices.token_hash`). A token the server
doesn't know is simply not signed in: `GET /me` answers with the Free plan, Pro routes answer 401.
Tokens must match `^[A-Za-z0-9_-]{32,128}$` (401 `not-signed-in` otherwise).

**Chrome profile key.** After signing in, the extension also makes a *profile key* (same format),
keeps it in `chrome.storage.sync` as `tabfold_profile` and registers it (`POST /profile`). Another
computer signed in to the same Chrome profile finds it and signs itself in with it
(`POST /signin/profile`), so most people sign in once. Signing out on one computer
(`POST /signout`) unlinks only that computer's device token; the extension then remembers not to
use the profile key on that computer until the person signs in again.

## The plan (`PlanState`)

Shared shape (`src/lib/pro/types.ts` and `server/supabase/functions/_shared/plan.ts`; keep them
the same):

```ts
interface PlanState {
  tier: 'free' | 'pro' | 'pro-ai';
  /** The server's 7-day Pro AI trial, while it runs and there's no live subscription. */
  trial: { startedAt: number; endsAt: number } | null;
  /** This email has had its trial (one per email). */
  trialUsed: boolean;
  /** The signed-in account's email; null when this computer isn't signed in. */
  email: string | null;
  /** A live subscription's billing period. */
  interval: 'month' | 'year' | null;
  /** A live subscription's state: 'active' (Stripe's active or trialing) or 'past_due'; else null. */
  status: 'active' | 'past_due' | 'canceled' | null;
  /** Cancelled but still on until then (ms). */
  cancelAt: number | null;
  /** Next charge (ms): the period end, or when billing starts after a trial. Null when cancelled. */
  renewsAt: number | null;
  /** When the server worked this out (ms). */
  checkedAt: number;
}
```

Rules (`planFor` in `_shared/plan.ts`):

1. A **live subscription** is one whose Stripe status is `active`, `trialing` or `past_due`. If the
   account has one (the best: Pro AI over Pro, then the latest), its price's lookup key gives the
   tier (`pro-ai-*` → `pro-ai`, other `pro-*` → `pro`), `interval` its period, `status` is
   `active` (for `active` and `trialing`) or `past_due`; `cancelAt` is Stripe's `cancel_at`, or the
   period end when `cancel_at_period_end`; `renewsAt` is Stripe's `trial_end` while `trialing`,
   else the period end; null when cancelled. `trial` is null.
2. Otherwise, while the server trial runs (`trial_started_at + 7 days > now`): tier `pro-ai`,
   `trial` set, `status`/`interval`/`cancelAt`/`renewsAt` null.
3. Otherwise Free (`email` still set when signed in).

Stripe Price **lookup keys**: `pro-monthly` ($5), `pro-yearly` ($48), `pro-ai-monthly` ($9),
`pro-ai-yearly` ($84). `server/scripts/stripe-setup.mjs` creates them.

## Errors

JSON `{ "error": <code>, "message": <text for people>, ... }`, codes as in `ProErrorCode`
(`src/lib/pro/types.ts`):

| Status | error | When |
| --- | --- | --- |
| 400 | `server` | Malformed request |
| 400 | `invalid-email` | `POST /signin/start` with something that isn't an email address |
| 400 | `wrong-code` | `POST /signin/finish`: the code doesn't match (body also has `triesLeft`) |
| 400 | `code-expired` | `POST /signin/finish`: no code for that email, it's older than 10 minutes, or 5 wrong tries used it up |
| 400 | `invalid` | 1.0: `POST /account/delete` without the account's email typed as confirmation |
| 401 | `not-signed-in` | Missing or malformed token; a Pro route from a computer that isn't signed in; an unknown profile key |
| 402 | `needs-pro` / `needs-pro-ai` | The plan doesn't include it (0.6: also a team's routes once its plan has ended) |
| 403 | `server` | 0.6: a team member (not the owner) asking for an owner's team route |
| 404 | `server` | No such route, backup or shared folder; 0.6: a team route from someone in no team |
| 409 | `conflict` | `POST /sync` with an out-of-date `baseVersion` (body also has `version`) |
| 409 | `already-subscribed` | `POST /checkout` when the account already has a live subscription (use `POST /billing`) |
| 413 | `server` | Request too large |
| 429 | `runs-used-up` | 300 AI runs used this month (body also has `runs`) |
| 429 | `rate-limited` | Too many codes asked for, checkouts started, team invitations or public share reads (body also has `retryAfter`, seconds) |
| 502 | `ai-failed` | The model refused, failed twice, or returned invalid JSON twice (the run isn't counted) |
| 502 | `send-failed` | The email with the code (0.6: or a team invitation) couldn't be sent |
| 502 | `server` | Stripe couldn't be reached or refused |
| 500 | `server` | Anything else |

CORS: every response (and `OPTIONS` preflight) has `Access-Control-Allow-Origin` set to the
request's `Origin` when it is a `chrome-extension://` origin listed in `ALLOWED_ORIGINS` (comma
separated; `*` allows any extension during development), `Access-Control-Allow-Headers:
authorization, content-type`, `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`
(0.6 adds the last three). The one exception is `GET /public/shares/<id>`: `Access-Control-Allow-Origin: *`.

## Routes: account and payments

### `GET /me` (any token)
`{ "plan": PlanState, "runs": AiRuns | null }` (`runs` only with Pro AI). Free for a token the
server doesn't know. If this token started a Stripe checkout in the last 24 hours that hasn't been
processed yet, the server asks Stripe about it first (so a payment shows up even before Stripe's
webhook arrives) and, when it's complete, signs this computer in to the paying account.

Optional `"needsSignIn": { "email": string }` (only while this computer isn't signed in): a checkout
it started was paid with an email that already had a Tabfold account. The payment is on that
account, but the computer must sign in with a code first (see `POST /checkout`).

### `POST /signin/start` (any token)
Body `{ "email": string, "purpose": "signin" | "trial" }` → `{ "sent": true }`.
Emails a 6-digit code, valid 10 minutes and for 5 tries; a new code replaces the old one. The
answer is the same whether or not the email has an account. Limits: 5 codes an hour per email,
10 an hour per token (429 `rate-limited`). Emails are trimmed and lower-cased. `purpose` only
changes the email's wording.

### `POST /signin/finish` (any token)
Body `{ "email": string, "code": string, "startTrial": boolean }` →
`{ "plan": PlanState, "runs": AiRuns | null, "trialStarted": boolean, "trialUsed": boolean }`.
Checks the code; creates the account on first sign-in; links this token to the account (replacing
any account it was linked to). With `startTrial`, starts the 7-day Pro AI trial if this email
never had one and has no live subscription (`trialStarted: true`); `trialUsed: true` means it had
one before (the person stays signed in). Codes are stored only as an HMAC and deleted once used.
An account made by a signed-out checkout hasn't proved its email: the first code sign-in proves it
and unlinks every other computer and Chrome profile key linked to that account (the plan, synced
tabs and backups stay; this computer is then linked as usual).

### `POST /trial` (signed in)
`{ "plan": PlanState, "runs": AiRuns | null, "trialStarted": boolean, "trialUsed": boolean }`.
Starts the trial for an account that is already signed in (same rules as `startTrial` above), so a
signed-in person doesn't need another code.

### `POST /signin/profile` (any token)
Body `{ "profileKey": string }` → `{ "plan": PlanState, "runs": AiRuns | null }`. Links this
token to the account the profile key belongs to; 401 `not-signed-in` if the key is unknown.

### `POST /profile` (signed in)
Body `{ "profileKey": string }` → `{ "ok": true }`. Registers the Chrome profile key for this
token's account (a key already registered moves to this account).

### `POST /signout` (any token)
`{ "ok": true }`. Unlinks this token. Other computers and the profile key stay.

### `POST /checkout` (any token)
Body `{ "tier": "pro" | "pro-ai", "interval": "month" | "year" }` → `{ "url": string, "sessionId": string }`.
Creates a Stripe Checkout Session (`mode=subscription`) for the matching price and remembers which
token started it. The extension opens `url` in a tab.

- Signed in: checkout uses the account (its Stripe customer, or its email, which Stripe then
  can't change). Not signed in: Stripe asks for an email, and that email becomes the account.
  Stripe doesn't check that email, so the payment signs this computer in only when it creates the
  account. If the email already had an account, the plan lands on it, but the computer signs in
  with a code (`GET /me` answers `needsSignIn`); otherwise anyone could reach someone else's
  synced tabs by paying with their email.
- During the server trial, a Pro AI checkout starts billing when the trial ends
  (`subscription_data.trial_end`), unless fewer than 48 hours are left (Stripe's minimum); then it
  charges at once. A Pro checkout charges at once (and the trial stops counting).
- `success_url` is `<public URL>/checkout/done?session_id={CHECKOUT_SESSION_ID}`, `cancel_url`
  `<public URL>/checkout/cancel`. The extension watches its checkout tab and turns these into its
  own pages, so people rarely see them.
- Stripe Tax (`automatic_tax`) when `STRIPE_AUTOMATIC_TAX=true`. Promotion codes are allowed.
- 409 `already-subscribed` when the account already has a live subscription.
- At most 20 checkouts an hour per token (429 `rate-limited`, with `retryAfter`).

### `POST /billing` (signed in, with a Stripe customer)
Body `{ "flow"?: "payment-method" }` → `{ "url": string }`. A Stripe billing portal session
(change plan, card, invoices, cancel), returning to `<public URL>/billing/done`. With
`flow: "payment-method"` it opens straight on the card form. 402 `needs-pro` when the account has
never paid.

### `GET /checkout/done`, `GET /checkout/cancel`, `GET /billing/done`
Plain text pages ("You can close this tab and go back to Tabfold."), for when the extension doesn't
catch the tab first.

### `POST /stripe/webhook` (Stripe only)
Checked with `Stripe-Signature` and `STRIPE_WEBHOOK_SECRET` (5-minute tolerance); 400 otherwise.
Handles `checkout.session.completed` (links the Stripe customer to the account, stores the
subscription, signs in the token that started the checkout, as `POST /checkout` says) and
`customer.subscription.created|updated|deleted` (re-reads the subscription from Stripe, so events
arriving out of order don't matter). Each event id is processed once.

## Routes: Pro and Pro AI

### `GET /sync` (Pro)
`{ "items": { "<key>": <value>, ... }, "version": number }` — the account's sync items, in the same
`tf.m` / `tf.c*` / `tf.t*` format as Chrome sync (`src/lib/sync/records.ts`), with the larger
cloud limits (`CLOUD_LIMITS`). `version` is 0 before the first write.

### `POST /sync` (Pro)
Body `{ "set": { "<key>": <value> }, "remove": ["<key>"], "baseVersion": number }`.
Applies atomically only if the stored version equals `baseVersion`, then returns
`{ "version": newVersion }`; otherwise 409 `{ "error": "conflict", "version": current }`.
Keys must start with `tf.`; the stored total stays under 8 MB (413 otherwise).
After a successful write, if the account has no backup for today (UTC), the server stores one: the
full items map and its tab count (records in `tf.c*` chunks). Backups older than 30 days are deleted.

### `GET /backups` (Pro)
`{ "backups": BackupInfo[] }`, newest first.

### `GET /backups/<YYYY-MM-DD>` (Pro)
`{ "day": "YYYY-MM-DD", "items": { ... } }` (404 `server` if none).

### `POST /ai` (Pro AI)
Only titles and sites are ever sent; at most 300 tabs, titles cut to 200 characters (the server
enforces both).

- `{ "task": "organise", "tabs": AiTab[] }` → `{ "groups": [{ "name": string, "tabIds": string[] }], "runs": AiRuns }`.
  Counts one run (300 a month, reset on the 1st, UTC). Groups: 2–8 projects of related tabs with
  short names (≤ 32 characters, e.g. "Checkout app", "Holiday in Lisbon"); tabs that fit no project
  are left out. Every returned id is one that was sent; a tab is in at most one group.
- `{ "task": "name", "tabs": AiTab[] }` → `{ "name": string }` — a short name for one fold
  (≤ 40 characters, e.g. "Checkout app · Stripe webhooks"). Not counted as a run; capped at
  1,000 a month.
- `{ "task": "context", "name": string, "tabs": AiTab[] }` → `{ "summary": string }` — one or two
  sentences on what the group is about, for "Copy as context". Not counted; same 1,000 cap.

Model: Claude Haiku 5.5 (`claude-haiku-5-5`) at low effort, JSON via structured outputs; invalid
output is retried once. The Anthropic API key is a server secret (`ANTHROPIC_API_KEY`) and never
reaches the extension.

## Secrets (`supabase secrets set …`)

| Name | What |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_…` / `sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | The webhook endpoint's signing secret (`whsec_…`), printed by the setup script |
| `STRIPE_AUTOMATIC_TAX` | `true` to turn on Stripe Tax at checkout (optional) |
| `STRIPE_PORTAL_CONFIGURATION` | Billing portal configuration id (`bpc_…`), printed by the setup script (optional) |
| `RESEND_API_KEY` | Resend API key, for the sign-in emails |
| `EMAIL_FROM` | Sender, e.g. `Tabfold <hello@tabfold.app>` (a domain verified in Resend) |
| `ANTHROPIC_API_KEY` | For Pro AI |
| `ALLOWED_ORIGINS` | `chrome-extension://<id>` of the store copy (and the development copy), comma separated |
| `CODE_SECRET` | Optional but recommended: the key for hashing sign-in codes and (1.0) the trial fingerprints (defaults to the service role key); set it once and keep it |
| `PUBLIC_URL` | Optional: the function's public URL (defaults to `$SUPABASE_URL/functions/v1/tabfold`) |
| `STRIPE_API_BASE` | Test only: a fake Stripe for the end-to-end test |

---

# 0.6 additions

## Plans: Pro for life and Teams

Two more things a checkout can buy (`POST /checkout`, `tier`):

- **`pro-lifetime`**: one payment (`mode=payment`, price lookup key `pro-lifetime`, $99). Stored in a
  `purchases` table. The plan then reads `lifetime: true`, and the tier is at least `pro` forever
  (a live Pro AI subscription or the trial still gives `pro-ai`). 409 `already-subscribed` when the
  account already has it.
  Body `{ tier: "pro-lifetime" }`; an `interval` is ignored. Stripe always makes a customer for it
  (billing portal: receipts, card). A completed payment is processed like a subscription checkout
  (the webhook and the `GET /me` check, the same sign-in protections for a computer that wasn't
  signed in), once it is paid: a bank debit that completes unpaid is recorded on
  `checkout.session.async_payment_succeeded`. A live subscription doesn't stop it (someone on Pro
  can buy it, then cancel the subscription).
- **`teams`**: body `{ tier: "teams", interval, seats, teamName }` (seats 1–100, default 3; name ≤ 60
  characters). A subscription with `quantity = seats` (lookup keys `teams-monthly` $10 a person,
  `teams-yearly` $96 a person). When it completes, the server makes the team with the payer as
  its owner. 409 `already-subscribed` when the account already owns a team.
  An account is in one team at most, so the 409 also covers a member of a team whose plan is on.
  A name that is missing or blank is "My team"; a longer one is cut to 60 characters. When the
  owner of a team whose plan ended pays again, that same team (its people and folders) takes the
  new subscription; a member of an ended team who pays starts their own team and leaves the old one.

`PlanState` gains two optional fields (`src/lib/pro/types.ts`):

```ts
lifetime?: boolean;                 // Pro for life
team?: { id: string; name: string; role: 'owner' | 'member'; seats: number } | null;
```

The server sends `lifetime` only when it is true and `team` only while the team's subscription is
live; otherwise they are left out (read them as false and null).

Plan rules, in addition to the ones above: a lifetime purchase makes the tier at least `pro`
(`lifetime: true`, `renewsAt` null unless a subscription renews). Belonging to a team whose
subscription is live makes the tier `pro-ai` and sets `team`; for the owner, `interval`, `status`,
`cancelAt` and `renewsAt` describe the team's subscription. When a team's subscription ends, its
members fall back to their own plans; the team's folders stay readable for 30 days.
For a member, `interval`, `status`, `cancelAt` and `renewsAt` describe their own subscription, if
any. While a team gives Pro AI, `trial` is null and a trial isn't started (it keeps for later).

## Teams

Every member's requests carry their own device token, as now. Not signed in: 401. Signed in but in
no team: 404 `server`. An owner's route asked by a member: 403 `server`.

- `GET /team` (a member) → `{ team: { id, name, seats, role }, members: [{ id, email, role, joinedAt }], invites: [{ email, invitedAt }] }`. 404 `server` when not in a team.
  `team.status` is also there: `active`, `past_due` (still on) or `ended`. Members come owner
  first, then in the order they joined; invitations oldest first. A member's `id` is what
  `DELETE /team/members/<id>` takes.
- `PATCH /team` (owner) body `{ name }` → `{ team }`. Blank: 400; longer than 60 characters: cut.
- `POST /team/invites` (owner) body `{ emails: string[] }` (at most 20 at a time) → `{ invited: number }`.
  Emails each address an invitation ("<owner> invited you to <team> on Tabfold"). Inviting someone
  already in the team or already invited is a no-op.
  `invited` counts the new invitations. Emails are trimmed and lower-cased; one that isn't an
  email address: 400 `invalid-email` (nobody is invited). A team has at most 100 people,
  invitations included (400). At most 100 invitations are emailed a day per team (429
  `rate-limited`, with `retryAfter` and `invited`). An invitation whose email couldn't be sent
  isn't kept: 502 `send-failed`, with `invited`. Needs the team's plan on (402 `needs-pro-ai`).
- `DELETE /team/invites/<email>` (owner) → `{ ok: true }`. The email URL-encoded; fine if there was
  no such invitation.
- `DELETE /team/members/<id>` (owner; not themself) → `{ ok: true }`. The Stripe quantity goes down
  (prorated).
  By one seat, never below the people left or 1. Someone not in the team: 404; the owner: 400.
- `POST /team/leave` (a member who isn't the owner) → `{ ok: true }`.
  The Stripe quantity goes down the same way. The owner: 400 (they cancel the plan in billing).
- **Joining**: when someone signs in with a code (`POST /signin/finish`) and that email has an
  invitation, they join the team (role `member`), the invitation goes, and if the team now has more
  members than seats the Stripe quantity goes up to match (prorated). The answer's plan shows the
  team.
  The oldest invitation from a team whose plan is on wins; someone already in a team stays there
  (their other invitations wait). If Stripe can't be reached, the sign-in still works (the server
  logs it and the next change catches up).
- `GET /team/sync`, `POST /team/sync` (a member): the team's shared folders, exactly like `/sync`
  (same item format and limits, `baseVersion`, 409 `conflict`), kept per team. Items are opaque to
  the server.
  No daily backups. After the team's plan ends, `GET` works for 30 days and `POST` answers 402
  `needs-pro-ai`; after the 30 days, both do.

## Share a folder (Pro)

A shared folder is a public, read-only page at `<SHARE_BASE_URL>/s/<id>` (default
`https://tabfold.app`, a small static site in `web/`). Anyone with the link sees the folder's name and
its pages' titles and addresses; nothing else.

- `POST /shares` (Pro) body `{ name, color, tabs: [{ title, url }], live: boolean }` (at most 1,000
  tabs; titles cut to 200 characters, addresses longer than 2,000 left out) → `{ id, url }`. `id`:
  10 random letters and digits.
  Only `http:` and `https:` addresses are kept (others left out), without a user name or password.
  `color` is one of Chrome's tab group colours (anything else is `grey`); `name` is cut to 60
  characters (blank: 400); `live` is false unless `true`. An account has at most 500 shares (400).
- `PUT /shares/<id>` (its owner, Pro) same body → `{ id, url, views, live }`. Replaces the contents.
- `GET /shares/<id>` (its owner) → `{ id, url, views, live, updatedAt }`.
- `DELETE /shares/<id>` (its owner) → `{ ok: true }`. The link stops working at once.
  Fine to ask twice. `GET` and `DELETE` need no plan, only the owner signed in; anyone else's
  share answers 404 (and isn't touched).
- `GET /public/shares/<id>` (no token; CORS `*`) → `{ name, color, tabs: [{ title, url }], updatedAt }`;
  each read counts a view. 404 when there's no such share. At most 60 reads a minute per address
  (429).
  The address is `CF-Connecting-IP`, else the first `X-Forwarded-For` entry, kept only as a keyed
  HMAC in the rate limit (1.0; see "Rate-limit keys"). Times (`updatedAt`) are ms.
- A share outlives the plan (people may already have the link), but only Pro can change it.

## AI tasks (Pro AI), in addition to organise, name and context

- `{ "task": "ask", "query": string, "tabs": AiTab[] }` → `{ "matches": [{ "id": string, "reason": string }] }`.
  Finds the tabs that best answer the question, from titles and sites only: at most 8, best first,
  each `reason` ≤ 80 characters ("Folded 6 days ago · pricing page"). The query is cut to 200
  characters. Counts against the 1,000-a-month cap for light tasks.
  The model sees no dates, so `reason` is the part after the dot ("Pricing page"); the extension
  can put "Folded 6 days ago · " before it. A blank query: 400. No match is a fine answer
  (`matches: []`, still counted).
- `{ "task": "tidy", "tabs": AiTab[], "folders": [{ "id": string, "name": string }] }` →
  `{ "suggestions": [{ "summary": string, "folderId": string | null, "folderName": string, "tabIds": string[] }] }`.
  Groups tabs nobody has opened in a month by what they're about, and says where each group
  belongs: an existing folder (`folderId`) or a new one (`folderName`). At most 3 suggestions of at
  least 5 tabs each; `summary` ≤ 80 characters ("38 tabs about Lisbon"). Counts one run.
  Like organise, the answer also has `runs`. `folders` may be left out (at most 200 are used, names
  cut to 60 characters). An existing folder's `folderName` is its name; a new one's is ≤ 32
  characters, and a new one named like an existing folder comes back as that folder. The count at
  the start of `summary` is the real one. Fewer than 5 tabs: `{ suggestions: [], runs }` without
  asking the model or counting a run. No suggestion is a fine answer (still counted).

## Secrets added

| Name | What |
| --- | --- |
| `SHARE_BASE_URL` | Where shared pages live, e.g. `https://tabfold.app` (the `web/` site); also the link in team invitations. Default `https://tabfold.app` |

The Stripe webhook also handles `checkout.session.async_payment_succeeded` (a Pro for life payment
that completed before it was paid); `server/scripts/stripe-setup.mjs` adds it to the endpoint.

## 1.0 additions

### `POST /account/delete` (signed in)

Body `{ confirm }`: the account's email, as the person typed it (compared ignoring case and spaces at
the ends); a mismatch is `400 invalid` "Type your account’s email to confirm." Deletes the account:
cancels its Stripe subscriptions at once (no further charges; Stripe keeps its own payment records),
ends a team it owns (the team's subscription is cancelled and its members lose the team at once) or
leaves the team it's in, and deletes its devices (every computer is signed out), synced copy, backups,
shares (their links stop working), invitations it sent, sign-in codes and AI usage. A Pro for life
purchase goes with it. → `{ ok: true }`.

In order: Stripe first, so that when Stripe can't be reached (502 `server`) nothing is deleted and the
person can try again. Every subscription stored for the account that Stripe hasn't ended is cancelled
at once (`DELETE /v1/subscriptions/<id>`: its own, and the Teams subscription of a team it owns); one
Stripe already ended is left alone. Then the database deletes the account in one step
(`tabfold_account_delete`, migration `20261013000000_v10.sql`): the account row and, through its
foreign keys, its devices and Chrome profile key, synced items, backups, AI usage, subscriptions and
purchases as stored here, shares, its team membership, and a team it owns with that team's members,
invitations and shared folders; plus its sign-in code and the checkouts its computers started (or
that wait for it to sign in). A member's team then gets one seat fewer, as when someone leaves.

Afterwards: every computer that was signed in is a token the server doesn't know (`GET /me` answers
Free; Pro routes 401). Stripe's `customer.subscription.deleted` events find no account and change
nothing. Invitations other teams sent to the email are theirs and stay on their lists. Signing in
again with the same email makes a new, empty account, which can't start the trial again if the old
one had it (below). The Stripe customer and its payment records stay in Stripe.

Not signed in: 401. The server's log has a line only when something fails (never the email).

### One trial per email, also after deleting the account

The server keeps a one-way **trial fingerprint** of every email that had the trial: HMAC-SHA256 of
`trial:<email>` (trimmed, lower-cased), keyed with `CODE_SECRET` (else the service role key), in hex,
in the `trial_used` table (migration `20261014000000_v10_trials.sql`). No email is kept in clear, and
the key isn't in the database. It's written when a trial starts (`tabfold_start_trial`, atomically
with the check) and when an account that had a trial is deleted (`tabfold_account_delete`, which
covers trials started before 1.0), and it stays after the account is gone.

`POST /signin/finish` with `startTrial`, and `POST /trial`, start no trial when the email's
fingerprint is there (`trialStarted: false, trialUsed: true`); the plan's `trialUsed` says so too
wherever a trial could be offered. Changing `CODE_SECRET` (or the service role key while it isn't
set) makes the kept fingerprints unrecognisable, so set it once and keep it.

### Rate-limit keys

Every rate limit's key is `<kind>:` and an HMAC-SHA256 of what it counts by, keyed with
`CODE_SECRET` (else the service role key) like the trial fingerprint: `email:` (codes per email),
`token:` and `checkout:` (per computer, of its token's hash), `share-read:` (per visitor IP address).
Before 1.0 these were plain SHA-256, which can be matched by hashing every IPv4 address; old rows
expire within a day. A team's invitation limit is `invite:<team id>`.

### Deleting an account when Stripe doesn't know a subscription

If Stripe answers 404 for a subscription stored for the account (for example a test-mode id after
switching to live keys), it counts as ended and the deletion goes on; any other Stripe error stops
it (502, nothing deleted).

### Once a day: old backups, and ended teams' folders

The first sync write of each day (`POST /sync`, any account) runs a clean-up:

- backups older than 30 days are deleted for every account, including accounts whose plan ended
  and that no longer write or list backups;
- the shared folders (team sync items and version) of every team whose plan ended more than 30 days
  ago are deleted (`tabfold_team_sync_prune`): its subscription isn't active, trialing or past due,
  and its end (else its cancellation time, else its period's end) is more than 30 days back. Until
  then `GET /team/sync` keeps working for its people, so they can keep a copy. The team, its people
  and invitations stay; if the owner starts the plan again, its folders start empty.

Each part is logged when it fails and never fails the sync write.

### Shares carry a folder's note

`POST /shares` and `PUT /shares/<id>` take an optional `note` (one line, at most 140 characters after
squeezing whitespace; longer is cut, never mid-character); `GET /shares/<id>` and
`GET /public/shares/<id>` return `note` ('' when none).

Control characters and line breaks become spaces; a note that isn't text is ''. "Characters" are
Unicode code points, and the cut keeps whole user-perceived characters: an emoji, a flag or a letter
with its accent is kept whole or left out. A `PUT` without `note` removes it (it replaces the
contents). Stored in `shares.note` (`''` by default, at most 140 characters).
