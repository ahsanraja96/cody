import { CommandError } from '../messages';
import { getDeviceToken } from './account';
import { PRO_CONFIG, proConfigured } from './config';
import type { ProErrorCode } from './types';

/**
 * The Tabfold server (server/API.md). Every request carries this computer's device token
 * (`Authorization: Bearer …`, made on first use). Nothing here logs tab titles, tokens or codes.
 */

const PRO_ERROR_CODES: readonly ProErrorCode[] = [
  'not-configured',
  'offline',
  'not-signed-in',
  'needs-pro',
  'needs-pro-ai',
  'conflict',
  'already-subscribed',
  'runs-used-up',
  'rate-limited',
  'ai-failed',
  'send-failed',
  'invalid-email',
  'wrong-code',
  'code-expired',
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
  conflict: 'Your folded tabs changed on another computer. Trying again.',
  'already-subscribed': 'You already have a plan. Change it in Manage billing.',
  'runs-used-up': 'You’ve used this month’s 300 AI runs. They start again on the 1st.',
  'rate-limited': 'Too many tries. Try again in a few minutes.',
  'ai-failed': 'The AI couldn’t do this just now, and nothing changed. Try again in a moment.',
  'send-failed': 'Couldn’t send the code. Check your connection and try again.',
  'invalid-email': 'That doesn’t look like an email address.',
  'wrong-code': 'That code doesn’t match.',
  'code-expired': 'That code has expired or was tried too many times. Ask for a new one.',
  server: 'Something went wrong on Tabfold’s side. Try again in a moment.',
};

/** Fields of an error answer the pages may need (tries left, seconds to wait); nothing else crosses to them. */
const DETAIL_FIELDS = ['triesLeft', 'retryAfter'] as const;

/** A failed Pro request. `code` is for the pages; `status` and `body` are the server's answer. */
export class ProError extends CommandError {
  declare readonly code: ProErrorCode;
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(code: ProErrorCode, message?: string, status = 0, body: Record<string, unknown> = {}) {
    const details: Record<string, number> = {};
    for (const field of DETAIL_FIELDS) {
      const value = body[field];
      if (typeof value === 'number' && Number.isFinite(value)) details[field] = value;
    }
    super(message || PRO_ERROR_MESSAGES[code], code, Object.keys(details).length ? details : undefined);
    this.name = 'ProError';
    this.status = status;
    this.body = body;
  }
}

/** The named code when it is one of `allowed`. */
function pick(named: ProErrorCode | null, allowed: readonly ProErrorCode[]): ProErrorCode | null {
  return named && allowed.includes(named) ? named : null;
}

/** Map an HTTP failure from the server to a ProError (server/API.md, "Errors"). */
export function errorFromResponse(status: number, body: unknown, path = ''): ProError {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const named = isProErrorCode(data.error) ? data.error : null;
  const message = typeof data.message === 'string' && data.message.trim() ? data.message.trim() : undefined;
  let code: ProErrorCode;
  switch (status) {
    case 400:
      code = pick(named, ['wrong-code', 'code-expired', 'invalid-email']) ?? 'server';
      break;
    case 401:
      code = 'not-signed-in';
      break;
    case 402:
      code = named === 'needs-pro-ai' ? 'needs-pro-ai' : 'needs-pro';
      break;
    case 409:
      code = named === 'already-subscribed' ? 'already-subscribed' : 'conflict';
      break;
    case 429:
      code = pick(named, ['runs-used-up', 'rate-limited']) ?? (path.startsWith('/signin') ? 'rate-limited' : 'runs-used-up');
      break;
    case 502:
      code =
        pick(named, ['ai-failed', 'send-failed', 'server']) ??
        (path.startsWith('/ai') ? 'ai-failed' : path.startsWith('/signin/start') ? 'send-failed' : 'server');
      break;
    default:
      code = pick(named, ['server']) ?? 'server';
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

/** Call the server: `api('/me')`, `api('/ai', { method: 'POST', body: {...} })`. */
export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  if (!proConfigured()) throw new ProError('not-configured');
  const token = await getDeviceToken();
  const { timeoutMs = 30_000, body, headers, signal, ...rest } = init;
  const sent = new Headers(headers);
  sent.set('Accept', 'application/json');
  sent.set('Authorization', `Bearer ${token}`);
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
