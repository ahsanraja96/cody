// The `tabfold` Edge Function (Deno): wires the real database, ExtensionPay and Claude into app.ts.
// Not type-checked by the extension's build; app.ts, ai.ts and plan.ts are, through the tests.
//
// Secrets (`supabase secrets set ...`): ANTHROPIC_API_KEY, EXTPAY_ID, ALLOWED_ORIGINS.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the Edge runtime.
import Anthropic from 'npm:@anthropic-ai/sdk@0.133';
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { ExtPayUser } from '../_shared/plan.ts';
import { AiFailed, createModel, type CallJson } from './ai.ts';
import { handle, readExtPayUser } from './app.ts';
import { createSupabaseStore } from './store.ts';

const EXTPAY_ID = Deno.env.get('EXTPAY_ID') ?? '';
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').filter((origin) => origin.trim());
const MODEL = 'claude-haiku-5-5';

const db = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
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

async function extpayUser(apiKey: string): Promise<ExtPayUser | null> {
  const url = `https://extensionpay.com/extension/${encodeURIComponent(EXTPAY_ID)}/api/v2/user?api_key=${encodeURIComponent(apiKey)}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  } catch {
    // Fetch errors quote the URL, which holds the key: never let it reach the logs.
    throw new Error('ExtensionPay could not be reached');
  }
  // ExtensionPay refuses a key it doesn't know; anything else is its own trouble.
  if (response.status >= 400 && response.status < 500 && response.status !== 429) return null;
  if (!response.ok) throw new Error(`ExtensionPay answered ${response.status}`);
  return readExtPayUser(await response.json());
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

const deps = {
  store: createSupabaseStore(db),
  extpayUser,
  model: createModel(callJson),
  now: () => Date.now(),
  config: { extpayId: EXTPAY_ID, allowedOrigins: ALLOWED_ORIGINS },
  log: (message: string) => console.error(message),
};

Deno.serve((req) => handle(req, deps));
