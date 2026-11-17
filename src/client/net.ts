/** Talking to the server, and to Reddit's journey telemetry. */
import { telemetry } from '@devvit/analytics/client/reddit';

import type { ApiError } from '../shared/api.ts';

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as T & Partial<ApiError>;
  if (!response.ok) throw new RequestError(data.error ?? 'Something went wrong.', response.status);
  return data;
}

/** Telemetry must never get in the way of play. */
const quiet = (work: () => Promise<unknown>): void => {
  try {
    work().catch(() => undefined);
  } catch {
    /* not running inside Reddit */
  }
};

export const journey = {
  ready: () => quiet(() => telemetry.appReady()),
  start: () => quiet(() => telemetry.startJourney()),
  progress: (progress: number, action: string) => quiet(() => telemetry.progress({ progress, action })),
  interaction: (action: string, actionDetails?: string) =>
    quiet(() => telemetry.interaction({ action, ...(actionDetails ? { actionDetails } : {}) })),
  end: (win: boolean, score: number) => quiet(() => telemetry.endJourney({ complete: true, game: { win, score } })),
  active: (): boolean => {
    try {
      return Boolean(telemetry.getActiveJourneyId());
    } catch {
      return false;
    }
  },
};
