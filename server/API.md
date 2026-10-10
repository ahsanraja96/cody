# Tabfold Pro server API (contract)

One Supabase Edge Function, `tabfold`. The extension's base URL is `WXT_TABFOLD_API`, e.g.
`https://<project>.supabase.co/functions/v1/tabfold`. Free never calls it.

## Auth

Every request sends `Authorization: Bearer <ExtensionPay api key>`. That is the per-install key
ExtensionPay creates (`POST https://extensionpay.com/extension/<EXTPAY_ID>/api/new-key`), which
the extension keeps in `chrome.storage.sync` as `extensionpay_api_key` (the same key ExtensionPay's
own library uses, so a person signed in to Chrome gets it on every computer).

The server checks it with ExtensionPay:
`GET https://extensionpay.com/extension/<EXTPAY_ID>/api/v2/user?api_key=<key>` → an `ExtPayUser`
(`src/lib/pro/tiers.ts`), turned into a plan with the same rules as the extension (`planFromUser`).
Results are cached for 5 minutes (table `extpay_cache`, keyed by a SHA-256 of the key; the key
itself is never stored). The account is the plan's email, lower-cased (`accounts.email`). A key
whose user has no email or no paid/trial plan gets 402 on Pro routes.

## Errors

JSON `{ "error": <code>, "message": <text for people> }`, codes as in `ProErrorCode`
(`src/lib/pro/types.ts`):

| Status | error | When |
| --- | --- | --- |
| 401 | `not-signed-in` | No or unknown key |
| 402 | `needs-pro` / `needs-pro-ai` | Plan doesn't include it |
| 409 | `conflict` | `POST /sync` with an out-of-date `baseVersion` (body also has `version`) |
| 413 | `server` | Request too large |
| 429 | `runs-used-up` | 300 AI runs used this month (body also has `runs`) |
| 502 | `ai-failed` | The model refused, failed twice, or returned invalid JSON twice (the run isn't counted) |
| 500 | `server` | Anything else |

CORS: every response (and `OPTIONS` preflight) has `Access-Control-Allow-Origin` set to the
request's `Origin` when it is a `chrome-extension://` origin listed in `ALLOWED_ORIGINS` (comma
separated; `*` allows any extension during development), `Access-Control-Allow-Headers:
authorization, content-type`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`.

## Routes

### `GET /me` (any key)
`{ "plan": PlanState, "runs": AiRuns | null }`

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
