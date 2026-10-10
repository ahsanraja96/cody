import { CommandError } from '../messages';
import { PRO_CONFIG, proConfigured } from './config';
import { getApiKey } from './extpay';
import type { ProErrorCode } from './types';

/**
 * The Tabfold server (server/API.md). Every request carries the install's ExtensionPay key, which
 * the server checks with ExtensionPay. Nothing here logs tab titles or the key.
 */

const PRO_ERROR_CODES: readonly ProErrorCode[] = [
  'not-configured',
  'offline',
  'not-signed-in',
  'needs-pro',
  'needs-pro-ai',
  'runs-used-up',
  'ai-failed',
  'server',
];

export function isProErrorCode(value: unknown): value is ProErrorCode {
  return typeof value === 'string' && (PRO_ERROR_CODES as readonly string[]).includes(value);
}

/** What each failure says when the server gives no message of its own. */
export const PRO_ERROR_MESSAGES: Record<ProErrorCode, string> = {
  'not-configured': 'Pro isn’t available in this build of Tabfold.',
  offline: 'Couldn’t reach Tabfold. Check your connection and try again.',
  'not-signed-in': 'Sign in to your Tabfold account to use Pro.',
  'needs-pro': 'This is part of Tabfold Pro.',
  'needs-pro-ai': 'This is part of Tabfold Pro AI.',
  'runs-used-up': 'You’ve used this month’s 300 AI runs. They start again on the 1st.',
  'ai-failed': 'The AI couldn’t do this just now, and nothing changed. Try again in a moment.',
  server: 'Something went wrong on Tabfold’s side. Try again in a moment.',
};

/** A failed Pro request. `code` is for the pages; `status` and `body` are the server's answer. */
export class ProError extends CommandError {
  declare readonly code: ProErrorCode;

  constructor(
    code: ProErrorCode,
    message?: string,
    readonly status = 0,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message || PRO_ERROR_MESSAGES[code], code);
    this.name = 'ProError';
  }
}

/** Map an HTTP failure from the server to a ProError (server/API.md, "Errors"). */
export function errorFromResponse(status: number, body: unknown, path = ''): ProError {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const named = isProErrorCode(data.error) ? data.error : null;
  const message = typeof data.message === 'string' && data.message.trim() ? data.message.trim() : undefined;
  let code: ProErrorCode;
  switch (status) {
    case 401:
      code = 'not-signed-in';
      break;
    case 402:
      code = named === 'needs-pro-ai' ? 'needs-pro-ai' : 'needs-pro';
      break;
    case 429:
      code = 'runs-used-up';
      break;
    case 502:
      code = named ?? (path.startsWith('/ai') ? 'ai-failed' : 'server');
      break;
    default:
      code = named ?? 'server';
  }
  return new ProError(code, message, status, data);
}

export interface ApiInit extends Omit<RequestInit, 'body'> {
  /** A JSON body (sent as JSON); a string is sent as it is. */
  body?: unknown;
  /** Give up (as offline) after this long. 30 s unless given. */
  timeoutMs?: number;
}

export type ApiRequest = <T>(path: string, init?: ApiInit) => Promise<T>;

/** Call the server: `api('/sync')`, `api('/ai', { method: 'POST', body: {...} })`. */
export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  if (!proConfigured()) throw new ProError('not-configured');
  const key = await getApiKey();
  if (!key) throw new ProError('not-signed-in');
  const { timeoutMs = 30_000, body, headers, signal, ...rest } = init;
  const sent = new Headers(headers);
  sent.set('Accept', 'application/json');
  sent.set('Authorization', `Bearer ${key}`);
  if (body !== undefined && !sent.has('Content-Type')) sent.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`${PRO_CONFIG.apiUrl}${path}`, {
      ...rest,
      headers: sent,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ProError('offline');
  }
  let data: unknown = null;
  try {
    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) throw errorFromResponse(response.status, data, path);
  return data as T;
}
