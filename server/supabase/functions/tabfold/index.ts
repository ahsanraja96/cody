// The `tabfold` Edge Function (Deno): wires the real database, Stripe, Zoho Mail and Claude into
// app.ts. Not type-checked by the extension's build; app.ts, ai.ts, stripe.ts, mail.ts and plan.ts
// are, through the tests.
//
// Secrets (`supabase secrets set ...`, see server/API.md): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
// STRIPE_AUTOMATIC_TAX, STRIPE_PORTAL_CONFIGURATION, SMTP_USER, SMTP_PASS, EMAIL_FROM,
// ANTHROPIC_API_KEY, ALLOWED_ORIGINS, SHARE_BASE_URL, and optionally SMTP_HOST, SMTP_PORT,
// CODE_SECRET, PUBLIC_URL, STRIPE_API_BASE.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the Edge runtime.
//
// A missing secret only stops what needs it: without Stripe, checkout and billing answer 500 (and
// the log says which secret is missing); sync and the AI keep working.
import Anthropic from 'npm:@anthropic-ai/sdk@0.133';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { AiFailed, createModel, type CallJson } from './ai.ts';
import { handle, type Deps } from './app.ts';
import { createSmtpMailer, DEFAULT_SITE_URL } from './mail.ts';
import { createSupabaseStore } from './store.ts';
import { createStripe } from './stripe.ts';

const env = (name: string) => Deno.env.get(name)?.trim() ?? '';

const SUPABASE_URL = env('SUPABASE_URL');
const SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const ALLOWED_ORIGINS = env('ALLOWED_ORIGINS')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const MODEL = 'claude-haiku-5-5';
// Shared folders' pages and the link in team invitations (the `web/` site).
const SHARE_BASE_URL = env('SHARE_BASE_URL') || DEFAULT_SITE_URL;

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Made on first use, so a missing ANTHROPIC_API_KEY only stops the AI, not sync. One SDK retry,
// then ai.ts tries once more, so a slow day stays well inside the Edge Function's time limit.
let anthropic: Anthropic | null = null;

function claude(): Anthropic {
  try {
    anthropic ??= new Anthropic({ maxRetries: 1, timeout: 60_000 }); // reads ANTHROPIC_API_KEY
  } catch {
    throw new AiFailed('ANTHROPIC_API_KEY is not set');
  }
  return anthropic;
}

const callJson: CallJson = async (system, user, schema) => {
  let response: Anthropic.Message;
  try {
    response = await claude().messages.create({
      model: MODEL,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) throw new AiFailed('rate limited');
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      throw new AiFailed('the Anthropic API key was refused: check ANTHROPIC_API_KEY');
    }
    if (error instanceof Anthropic.BadRequestError) throw new AiFailed(`bad request: ${error.message}`);
    if (error instanceof Anthropic.APIConnectionError) throw new Error('Anthropic API unreachable');
    if (error instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${error.status}`);
    throw error;
  }
  if (response.stop_reason === 'refusal') throw new AiFailed('refused');
  const block = response.content.find((part) => part.type === 'text');
  if (!block || block.type !== 'text') throw new Error(`No text in the answer (stop reason ${response.stop_reason})`);
  return JSON.parse(block.text);
};

const deps: Deps = {
  store: createSupabaseStore(db),
  // Both check their keys on use: a missing one fails only the routes that need it.
  payments: createStripe({
    secretKey: env('STRIPE_SECRET_KEY'),
    webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
    apiBase: env('STRIPE_API_BASE') || undefined,
  }),
  // Zoho Mail over TLS on 465 (Supabase blocks outbound 25 and 587).
  mailer: createSmtpMailer({
    host: env('SMTP_HOST') || undefined,
    port: Number(env('SMTP_PORT')) || undefined,
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS'),
    from: env('EMAIL_FROM'),
    siteUrl: SHARE_BASE_URL,
    connect: (hostname, port) => Deno.connectTls({ hostname, port }),
  }),
  model: createModel(callJson),
  now: () => Date.now(),
  config: {
    allowedOrigins: ALLOWED_ORIGINS,
    publicUrl: env('PUBLIC_URL') || (SUPABASE_URL ? `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/tabfold` : ''),
    automaticTax: env('STRIPE_AUTOMATIC_TAX').toLowerCase() === 'true',
    portalConfiguration: env('STRIPE_PORTAL_CONFIGURATION') || undefined,
    codeSecret: env('CODE_SECRET') || SERVICE_ROLE_KEY,
    shareBaseUrl: SHARE_BASE_URL,
  },
  log: (message: string) => console.error(message),
};

Deno.serve((req) => handle(req, deps));
