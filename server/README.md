# Tabfold Pro server

Tabfold Free never talks to a server. Pro and Pro AI do: they use one small program on Supabase (an
"Edge Function" called `tabfold`) and a database. The server:

- checks with ExtensionPay who has paid or is on the free trial,
- keeps each Pro account's folded tabs (sync without the 500-tab limit) and a daily backup for 30 days,
- runs Organise with AI, smart fold names and Copy as context, sending only tab titles and sites to Claude.

This guide sets it up from nothing. It takes about 30 minutes. You'll need accounts at
[supabase.com](https://supabase.com), [extensionpay.com](https://extensionpay.com) and
[console.anthropic.com](https://console.anthropic.com).

## What's in this folder

| File | What it is |
| --- | --- |
| `API.md` | What the extension can ask the server, and what it answers. |
| `supabase/config.toml` | Supabase settings for this project. |
| `supabase/migrations/…_tabfold.sql` | The database: tables and a few small database functions. |
| `supabase/functions/tabfold/index.ts` | The starting point Supabase runs. It connects the pieces below. |
| `supabase/functions/tabfold/app.ts` | The server itself: sign-in, plans, sync, backups, AI limits. |
| `supabase/functions/tabfold/ai.ts` | What Claude is asked, and the checks on its answers. |
| `supabase/functions/tabfold/store.ts` | Reading and writing the database. |
| `supabase/functions/_shared/plan.ts` | The plan rules (a copy of the extension's `src/lib/pro/tiers.ts`; the tests keep them the same). |

## 1. Set up ExtensionPay (payments and sign-in)

1. Sign up at extensionpay.com and add the extension. Choose its **ExtensionPay ID**, for example
   `tabfold`. You'll use it twice: as `EXTPAY_ID` on the server and `WXT_EXTPAY_ID` in the extension.
2. Connect your Stripe account when ExtensionPay asks.
3. Create four plans. The nicknames must be exactly these, because the server reads them to tell
   Pro from Pro AI:

   | Nickname | Price |
   | --- | --- |
   | `pro-monthly` | $5 a month |
   | `pro-yearly` | $48 a year |
   | `pro-ai-monthly` | $9 a month |
   | `pro-ai-yearly` | $84 a year |

4. Turn on the free trial: **7 days**, no card needed. A trial gives Pro AI.
5. Find the extension's **Chrome id**: 32 letters, shown on `chrome://extensions` (turn on Developer
   mode) or in the Chrome Web Store dashboard. The copy you load unpacked while developing has a
   different id from the store copy; note both.

## 2. Create the Supabase project

1. On supabase.com, choose **New project**. Name it `tabfold`, pick the region closest to most of
   your users, and set a strong database password. Save the password in your password manager.
2. When it's ready, open **Project Settings → General** and copy the **Project ID** (also called the
   reference, 20 letters).

## 3. Install the Supabase command-line tool

Pick one:

- Mac: `brew install supabase/tap/supabase`
- Windows: `scoop bucket add supabase https://github.com/supabase/scoop-bucket.git`, then
  `scoop install supabase`
- Any computer with Node.js: put `npx supabase@latest` wherever this guide says `supabase`.

Then sign in: `supabase login` (it opens your browser).

## 4. Create the database

In a terminal, from the Tabfold folder:

```sh
cd server
supabase link --project-ref <your project id>
supabase db push
```

`link` asks for the database password from step 2. `db push` creates the tables. Every table is
locked to the server: nobody else can read it, even with the project's public key.

## 5. Add the secrets

1. On console.anthropic.com, open **API keys** and create a key for Tabfold. While you're there, set
   a monthly spend limit (Settings → Limits).
2. Still in the `server` folder, run (one line):

   ```sh
   supabase secrets set ANTHROPIC_API_KEY=<the key> EXTPAY_ID=<your ExtensionPay ID> ALLOWED_ORIGINS=chrome-extension://<Chrome id>
   ```

   For more than one Chrome id (store copy and development copy), separate them with commas and no
   spaces: `ALLOWED_ORIGINS=chrome-extension://aaaa…,chrome-extension://bbbb…`. While developing you
   can use `ALLOWED_ORIGINS=*`, which lets any extension (never a website) call the server; don't
   leave it like that once you publish.

Supabase gives the server its own address and database key; you don't set those.

## 6. Put the server online

```sh
supabase functions deploy tabfold --no-verify-jwt
```

`--no-verify-jwt` is needed because the extension signs in with its ExtensionPay key, not with a
Supabase account. The server's address is now:

```
https://<your project id>.supabase.co/functions/v1/tabfold
```

To check it, open `https://<your project id>.supabase.co/functions/v1/tabfold/me` in your browser.
You should see `{"error":"not-signed-in", …}`. That's right: the server is running and turning away a
visitor without a key.

## 7. Build the extension with Pro switched on

Create a file called `.env` in the Tabfold folder (next to `package.json`) with:

```sh
WXT_EXTPAY_ID=<your ExtensionPay ID>
WXT_TABFOLD_API=https://<your project id>.supabase.co/functions/v1/tabfold
```

Neither is a secret: both end up inside the extension. Never put the Anthropic key here. Then build
as usual (`npm run build`, or `npm run zip` for the store). Without these two lines the build is
Free only, and the Pro screens say Pro isn't available yet.

## 8. Before the first paying user

1. **Upgrade Supabase to Pro ($25 a month).** Free projects pause after a week without activity,
   and a paused project means paying users can't sync. Pro also adds Supabase's own daily database
   backups.
2. Keep Supabase's **spend cap** on (it is on by default on Pro).
3. Check the Anthropic spend limit from step 5.

## Running costs

From `docs/build-spec.md` ("Running costs"). Prices change; check them again before launch.

| Item | Cost |
| --- | --- |
| Free users | Nothing: they never use the server. |
| Supabase | $0 on the Free plan while developing and in beta; $25 a month on Pro from the day paid sync goes live. |
| Payment fees (ExtensionPay) | 5% plus Stripe's card fee. On a $5 monthly charge that's roughly 10 to 15%; yearly plans cut this because the card fee is paid once. |
| AI per Organise run (Claude Haiku 5.5, low effort) | About $0.002 for 100 tabs. Smart names and Copy as context are smaller calls. |
| AI per Pro AI user | About $0.06 a month typically (30 runs); $0.60 at most, because of the 300-run monthly cap. Names and context are capped at 1,000 a month. |
| Storage | A heavy user with 5,000 saved tabs is about 2 MB. Backups are full copies, one a day for 30 days, so an account uses up to about 31 times that: about 60 MB for a heavy user, a few MB for most. Supabase Pro includes 8 GB. |

Also worth knowing:

- Thinking tokens bill as output and are the biggest AI cost; the server already asks for low effort.
- Taxes: you sell to UK and EU consumers, so VAT applies. ExtensionPay doesn't handle tax for you;
  a merchant of record (Paddle or Lemon Squeezy) does, for a higher fee. Check with an accountant
  before switching on payments.

## What the server keeps

- The email of each Pro account (from ExtensionPay).
- That account's folded tabs (addresses, titles, keywords), as the extension syncs them, plus one
  backup a day for 30 days. Older backups are deleted automatically.
- How many AI runs the account used each month.
- ExtensionPay's answer about a key, for 5 minutes, stored under a scrambled form (SHA-256) of the
  key. The key itself is never stored.

For the AI, only tab titles (cut to 200 characters) and sites go to Anthropic, never addresses or
page content, and at most 300 tabs at a time. The server doesn't keep what it sent or got back.
The server's logs never contain keys or tab titles.

To delete someone's data: in the Supabase dashboard, open **Table Editor → accounts**, find their
email and delete the row. Their tabs, backups and AI counts go with it.

## Later

- **Changed the server code?** `supabase functions deploy tabfold --no-verify-jwt` (from `server`).
- **Changed the database?** Add a new file to `supabase/migrations` (never edit an old one), then
  `supabase db push`.
- **New Anthropic key?** `supabase secrets set ANTHROPIC_API_KEY=<new key>`, then deploy again.
- **Something wrong?** The server's logs are in the Supabase dashboard under **Edge Functions →
  tabfold → Logs**.

| The extension says | Usually means |
| --- | --- |
| Not signed in (401) | The extension has no ExtensionPay key yet, or `EXTPAY_ID` doesn't match `WXT_EXTPAY_ID`. |
| Needs Pro / Pro AI (402) | The plan doesn't include it. Check the plan nicknames in step 1. |
| AI failed (502) | Claude refused or failed twice; the run wasn't counted. If it keeps happening, check `ANTHROPIC_API_KEY` and the Anthropic console. |
| A network or CORS error | `ALLOWED_ORIGINS` doesn't list the extension's exact `chrome-extension://<id>`. |

## Tests

`npm test` in the Tabfold folder also runs the server's tests (`tests/server`), with a pretend
database, ExtensionPay and Claude, so they need no accounts.
