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
| 401 | `not-signed-in` | Missing or malformed token; a Pro route from a computer that isn't signed in; an unknown profile key |
| 402 | `needs-pro` / `needs-pro-ai` | The plan doesn't include it |
| 409 | `conflict` | `POST /sync` with an out-of-date `baseVersion` (body also has `version`) |
| 409 | `already-subscribed` | `POST /checkout` when the account already has a live subscription (use `POST /billing`) |
| 413 | `server` | Request too large |
| 429 | `runs-used-up` | 300 AI runs used this month (body also has `runs`) |
| 429 | `rate-limited` | Too many codes asked for, or too many checkouts started (body also has `retryAfter`, seconds) |
| 502 | `ai-failed` | The model refused, failed twice, or returned invalid JSON twice (the run isn't counted) |
| 502 | `send-failed` | The email with the code couldn't be sent |
| 502 | `server` | Stripe couldn't be reached or refused |
| 500 | `server` | Anything else |

CORS: every response (and `OPTIONS` preflight) has `Access-Control-Allow-Origin` set to the
request's `Origin` when it is a `chrome-extension://` origin listed in `ALLOWED_ORIGINS` (comma
separated; `*` allows any extension during development), `Access-Control-Allow-Headers:
authorization, content-type`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`.

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
| `CODE_SECRET` | Optional: the key for hashing sign-in codes (defaults to the service role key) |
| `PUBLIC_URL` | Optional: the function's public URL (defaults to `$SUPABASE_URL/functions/v1/tabfold`) |
| `STRIPE_API_BASE` | Test only: a fake Stripe for the end-to-end test |
