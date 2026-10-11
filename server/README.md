# Tabfold Pro server

Tabfold Free never talks to a server. Pro and Pro AI do: they use one small program on Supabase (an
"Edge Function" called `tabfold`) and a database. The server:

- signs people in with their email address and a 6-digit code it emails them (no passwords),
- runs the 7-day Pro AI trial (one per email, no card),
- takes payments through Stripe Checkout (Stripe's own payment page) and lets people manage their
  plan in Stripe's billing portal,
- keeps each Pro account's folded tabs (sync without the 500-tab limit) and a daily backup for 30 days,
- runs Organise with AI, smart fold names and Copy as context, sending only tab titles and sites to Claude.

This guide sets it up from nothing. It takes about an hour. You'll need accounts at
[supabase.com](https://supabase.com), [stripe.com](https://stripe.com), [resend.com](https://resend.com)
and [console.anthropic.com](https://console.anthropic.com), and a domain name you can add DNS
records to (for sending the sign-in emails), for example `tabfold.app`.

## What's in this folder

| File | What it is |
| --- | --- |
| `API.md` | What the extension can ask the server, and what it answers. |
| `supabase/config.toml` | Supabase settings for this project. |
| `supabase/migrations/` | The database: tables and a few small database functions, one file per change. |
| `supabase/functions/tabfold/index.ts` | The starting point Supabase runs. It connects the pieces below. |
| `supabase/functions/tabfold/app.ts` | The server itself: sign-in, the trial, checkout, plans, sync, backups, AI limits. |
| `supabase/functions/tabfold/stripe.ts` | Talking to Stripe. |
| `supabase/functions/tabfold/mail.ts` | The sign-in email, sent through Resend. |
| `supabase/functions/tabfold/ai.ts` | What Claude is asked, and the checks on its answers. |
| `supabase/functions/tabfold/store.ts` | Reading and writing the database. |
| `supabase/functions/_shared/plan.ts` | The plan rules: which plan an account has, from its Stripe subscription and trial. |
| `scripts/stripe-setup.mjs` | Creates the products, prices, billing portal settings and webhook in Stripe. |

## 1. Create the Supabase project

1. On supabase.com, choose **New project**. Name it `tabfold`, pick the region closest to most of
   your users, and set a strong database password. Save the password in your password manager.
2. When it's ready, open **Project Settings → General** and copy the **Project ID** (also called the
   reference, 20 letters).

The server's address will be `https://<project id>.supabase.co/functions/v1/tabfold`. You'll need
it below.

## 2. Install the Supabase command-line tool

Pick one:

- Mac: `brew install supabase/tap/supabase`
- Windows: `scoop bucket add supabase https://github.com/supabase/scoop-bucket.git`, then
  `scoop install supabase`
- Any computer with Node.js: put `npx supabase@latest` wherever this guide says `supabase`.

Then sign in: `supabase login` (it opens your browser).

## 3. Create the database

In a terminal, from the Tabfold folder:

```sh
cd server
supabase link --project-ref <your project id>
supabase db push
```

`link` asks for the database password from step 1. `db push` creates the tables. Every table is
locked to the server: nobody else can read it, even with the project's public key.

## 4. Set up Stripe (in test mode first)

Stripe takes the payments. Start in **test mode**: everything works the same, but no real money
moves and you pay with test cards. You switch to live mode at the end (step 10).

1. Sign up at stripe.com. You can do everything below before Stripe has checked your business.
2. At the top of the dashboard, turn on **Test mode**.
3. Make Checkout look like Tabfold: **Settings → Business → Public details** (name: Tabfold, support
   email, website) and **Settings → Branding** (icon, logo, brand colour, accent colour). The
   payment page and the billing portal use these.
4. Turn on receipts and payment reminders: **Settings → Customer emails** (successful payments,
   refunds), and the **Revenue recovery** settings under Billing (retries, and emails when a card
   fails or is about to expire).
5. Copy the test **secret key**: **Developers → API keys → Secret key** (it starts with `sk_test_`).
   Treat it like a password.
6. Run the setup script from the Tabfold folder, with your project id in the address:

   ```sh
   STRIPE_SECRET_KEY=sk_test_… node server/scripts/stripe-setup.mjs \
     --webhook-url https://<project id>.supabase.co/functions/v1/tabfold/stripe/webhook
   ```

   (On Windows PowerShell: `$env:STRIPE_SECRET_KEY="sk_test_…"; node server/scripts/stripe-setup.mjs --webhook-url https://…`.)

   It creates:

   - the products **Tabfold Pro** and **Tabfold Pro AI**, with four prices: $5 a month, $48 a year,
     $9 a month and $84 a year (their "lookup keys" `pro-monthly`, `pro-yearly`, `pro-ai-monthly`
     and `pro-ai-yearly` are how the server finds them),
   - the **billing portal** settings: invoices, changing card and address, switching between the
     four prices, and cancelling at the end of the paid period,
   - a **webhook**: Stripe tells the server when a checkout finishes or a subscription changes.

   At the end it prints a line like
   `supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_… STRIPE_PORTAL_CONFIGURATION=bpc_…`. Keep it
   for step 7. Running the script again is safe: it only adds what's missing. (Stripe shows a
   webhook's signing secret only when it is created; if you lose it, it's in **Developers →
   Webhooks →** the endpoint **→ Signing secret**.)

**Taxes (optional).** Stripe Tax can work out and add VAT and sales tax at checkout. Set it up in
the dashboard under **Tax** (your address, where you're registered, and **Default tax behavior**:
choose whether the prices include tax or tax is added on top). Then set `STRIPE_AUTOMATIC_TAX=true`
in step 7. Stripe Tax calculates and collects; registering and filing returns is still up to you.
Check with an accountant before switching on live payments.

## 5. Set up Resend (the sign-in emails)

1. Sign up at resend.com.
2. **Domains → Add domain**: add your domain (for example `tabfold.app`). Resend shows a few DNS
   records; add them where you bought the domain, then press **Verify**. It can take a few minutes
   to an hour.
3. **API Keys → Create API key**, with **Sending access** only. Copy it (it starts with `re_`).
4. Choose the sender, for example `Tabfold <hello@tabfold.app>`. The part after `@` must be the
   domain you verified. This is `EMAIL_FROM` in step 7.

The email says: "Your Tabfold code is 481920. It works for 10 minutes." and what it's for (signing
in, or starting the trial).

## 6. Get an Anthropic key (for Pro AI)

On console.anthropic.com, open **API keys** and create a key for Tabfold. While you're there, set a
monthly spend limit (**Settings → Limits**).

## 7. Add the secrets

Find the extension's **Chrome id**: 32 letters, shown on `chrome://extensions` (turn on Developer
mode) or in the Chrome Web Store dashboard. The copy you load unpacked while developing has a
different id from the store copy; note both.

Still in the `server` folder, run (one command per line is fine; values with spaces need quotes):

```sh
supabase secrets set STRIPE_SECRET_KEY=sk_test_…
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_… STRIPE_PORTAL_CONFIGURATION=bpc_…
supabase secrets set RESEND_API_KEY=re_… EMAIL_FROM="Tabfold <hello@tabfold.app>"
supabase secrets set ANTHROPIC_API_KEY=sk-ant-…
supabase secrets set ALLOWED_ORIGINS=chrome-extension://<Chrome id>
```

| Secret | What it is | Needed for |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_…`, later `sk_live_…`) | Checkout, billing |
| `STRIPE_WEBHOOK_SECRET` | The webhook's signing secret (`whsec_…`), printed by the setup script | Payments showing up |
| `STRIPE_PORTAL_CONFIGURATION` | Billing portal settings (`bpc_…`), printed by the setup script | Optional: without it Stripe uses its default portal |
| `STRIPE_AUTOMATIC_TAX` | `true` to add tax at checkout with Stripe Tax | Optional |
| `RESEND_API_KEY` | Resend API key (`re_…`) | Sign-in and trial emails |
| `EMAIL_FROM` | The sender, on your verified domain | Sign-in and trial emails |
| `ANTHROPIC_API_KEY` | Anthropic API key | Pro AI |
| `ALLOWED_ORIGINS` | `chrome-extension://<id>`, comma separated for more than one (no spaces) | Everything (the extension is turned away without it) |
| `CODE_SECRET` | Optional: a long random string for hashing sign-in codes. Defaults to the project's service role key | — |
| `PUBLIC_URL` | Optional: the server's address, if it isn't `https://<project id>.supabase.co/functions/v1/tabfold` | — |
| `STRIPE_API_BASE` | Tests only: points the server at a pretend Stripe. Never set it on the real server | — |

A missing secret only stops what needs it: without the Stripe secrets, checkout and billing fail
(and the log says which secret is missing), but sync and the AI keep working.

While developing you can use `ALLOWED_ORIGINS=*`, which lets any extension (never a website) call
the server; don't leave it like that once you publish.

Supabase gives the server its own address and database key; you don't set those.

## 8. Put the server online

```sh
supabase functions deploy tabfold --no-verify-jwt
```

`--no-verify-jwt` is needed because neither the extension nor Stripe signs in to Supabase: the
server checks each computer's device token, and Stripe's signature, itself.

To check it, open `https://<project id>.supabase.co/functions/v1/tabfold/me` in your browser.
You should see `{"error":"not-signed-in", …}`. That's right: the server is running and turning away
a visitor without a device token.

## 9. Build the extension with Pro switched on

Create a file called `.env` in the Tabfold folder (next to `package.json`) with:

```sh
WXT_TABFOLD_API=https://<project id>.supabase.co/functions/v1/tabfold
```

It isn't a secret: it ends up inside the extension. Never put any of the keys above here. Then
build as usual (`npm run build`, or `npm run zip` for the store). Without it the build is Free only.

## Test it

Everything in test mode, with the extension built against your server:

1. **Trial.** On the plans page choose **Start 7-day free trial**, enter your email, and type the
   code from the email. Pro AI switches on. Settings › Your plan shows the trial.
2. **Pay.** Choose a plan. Stripe's page opens in a tab. Pay with the test card
   `4242 4242 4242 4242`, any future expiry date, any 3-digit CVC and any postcode. The tab turns
   into Tabfold's welcome page and the plan switches on. Paying for Pro AI during the trial starts
   billing on the day the trial ends (if at least 2 days are left), and Stripe's page says so.
3. **Another computer.** On a second computer signed in to the same Chrome profile, Tabfold signs
   itself in. On a different profile, use **Already paid? Sign in** with the same email.
4. **Manage.** Settings › Your plan › **Manage billing** opens Stripe's portal: change plan, card,
   see invoices, cancel. Cancelling keeps Pro until the end of the paid period.

Where to look when something's off:

- Stripe: **Developers → Webhooks →** your endpoint shows every event sent and the server's answer.
  Stripe retries an answer other than 200 (for up to 3 days in live mode, a few hours in test mode).
- Supabase: **Edge Functions → tabfold → Logs**.
- Resend: **Emails** shows each email and whether it was delivered.

`npm test` runs the server's own tests with a pretend database, Stripe, email service and Claude,
so they need no accounts. `npm run e2e:pro` drives the whole thing in Chromium against a pretend
Stripe.

## 10. Going live

1. In Stripe, finish **activating your account** (business details and bank account), then turn
   off **Test mode**.
2. Copy the **live** secret key (`sk_live_…`) and run the setup script again with it. Live mode has
   its own products, prices, portal settings and webhook, so this creates them all again:

   ```sh
   STRIPE_SECRET_KEY=sk_live_… node server/scripts/stripe-setup.mjs \
     --webhook-url https://<project id>.supabase.co/functions/v1/tabfold/stripe/webhook
   ```

3. Store the live values (the old test ones are replaced):

   ```sh
   supabase secrets set STRIPE_SECRET_KEY=sk_live_… STRIPE_WEBHOOK_SECRET=whsec_… STRIPE_PORTAL_CONFIGURATION=bpc_…
   ```

4. Check the Branding and Customer emails settings in live mode too.
5. Test once with a real card and a small plan, then refund yourself in the Stripe dashboard.

Before the first paying user:

1. **Upgrade Supabase to Pro ($25 a month).** Free projects pause after a week without activity,
   and a paused project means paying users can't sync. Pro also adds Supabase's own daily database
   backups.
2. Keep Supabase's **spend cap** on (it is on by default on Pro).
3. Check the Anthropic spend limit from step 6.

## Running costs

Prices change; check them again before launch.

| Item | Cost |
| --- | --- |
| Free users | Nothing: they never use the server. |
| Supabase | $0 on the Free plan while developing and in beta; $25 a month on Pro from the day paid sync goes live. |
| Stripe | Card fees (2.9% + 30¢ for US cards, more for international cards) plus 0.7% for subscriptions (Stripe Billing), and 0.5% more with Stripe Tax. On a $5 monthly charge that's roughly 10%; yearly plans cut this because the fixed fee is paid once. |
| Resend | Free up to 3,000 emails a month (100 a day); $20 a month above that. One email per sign-in. |
| AI per Organise run (Claude Haiku 5.5, low effort) | About $0.002 for 100 tabs. Smart names and Copy as context are smaller calls. |
| AI per Pro AI user | About $0.06 a month typically (30 runs); $0.60 at most, because of the 300-run monthly cap. Names and context are capped at 1,000 a month. |
| Storage | A heavy user with 5,000 saved tabs is about 2 MB. Backups are full copies, one a day for 30 days, so an account uses up to about 31 times that: about 60 MB for a heavy user, a few MB for most. Supabase Pro includes 8 GB. |

Thinking tokens bill as output and are the biggest AI cost; the server already asks for low effort.

## What the server keeps

- Each account's email, its Stripe customer id, and its subscriptions' plan, status and dates
  (Stripe keeps the card details; the server never sees them).
- When the account's trial started, and when its email was first proved with a code.
- For each signed-in computer, and each Chrome profile key, only a scrambled form (SHA-256) of its
  token, and when it was last seen.
- The latest sign-in code for an email, scrambled (HMAC), for 10 minutes; deleted once used.
- Counters for how many codes were asked for and checkouts started in the last hour, under
  scrambled emails and tokens.
- Which computer started a checkout, for a day, and Stripe's event ids, for 30 days.
- The account's folded tabs (addresses, titles, keywords), as the extension syncs them, plus one
  backup a day for 30 days. Older backups are deleted automatically.
- How many AI runs the account used each month.

For the AI, only tab titles (cut to 200 characters) and sites go to Anthropic, never addresses or
page content, and at most 300 tabs at a time. The server doesn't keep what it sent or got back.
The server's logs never contain tokens, codes or tab titles.

To delete someone's data: in the Supabase dashboard, open **Table Editor → accounts**, find their
email and delete the row. Their computers, subscriptions, tabs, backups and AI counts go with it.
Cancel their subscription and delete the customer in Stripe too.

## Later

- **Changed the server code?** `supabase functions deploy tabfold --no-verify-jwt` (from `server`).
- **Changed the database?** Add a new file to `supabase/migrations` (never edit an old one), then
  `supabase db push`.
- **New key?** `supabase secrets set <NAME>=<new key>`. It applies to new requests within a minute
  or so; deploy again to be sure.
- **Changed prices?** The prices are in `scripts/stripe-setup.mjs`. Change them there, archive the
  old price in Stripe, and run the script again: it makes the new price with the same lookup key.
  The server picks it up within 10 minutes; existing subscribers keep their old price until you
  move them.
- **Something wrong?** The server's logs are in the Supabase dashboard under **Edge Functions →
  tabfold → Logs**.

| The extension says | Usually means |
| --- | --- |
| Couldn't send the code (502 `send-failed`) | Resend refused: check `RESEND_API_KEY`, that `EMAIL_FROM` uses the verified domain, and Resend's **Emails** page. |
| Not signed in (401) | This computer hasn't signed in, or signed out. Sign in with the email again. |
| Needs Pro / Pro AI (402) | The plan doesn't include it. Check the subscription in Stripe and that its price has one of the four lookup keys. |
| Paid, but Pro doesn't switch on | The webhook isn't getting through: check `STRIPE_WEBHOOK_SECRET` and the endpoint's events in Stripe (**Developers → Webhooks**). The extension also asks the server, which asks Stripe directly, for a day after paying. |
| Stripe error (502 `server`) | Stripe refused or couldn't be reached. The log says why, for example a missing price ("run server/scripts/stripe-setup.mjs"). |
| AI failed (502) | Claude refused or failed twice; the run wasn't counted. If it keeps happening, check `ANTHROPIC_API_KEY` and the Anthropic console. |
| A network or CORS error | `ALLOWED_ORIGINS` doesn't list the extension's exact `chrome-extension://<id>`. |

## Tests

`npm test` in the Tabfold folder also runs the server's tests (`tests/server`), with a pretend
database, Stripe, email service and Claude, so they need no accounts. `tests/server/fakeStripe.ts`
is the pretend Stripe: it answers the same requests as the real one and has simple pages standing
in for Stripe's payment page and billing portal.
