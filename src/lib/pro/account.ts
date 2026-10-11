import { browser } from 'wxt/browser';

/**
 * Who this computer is to the Tabfold server (server/API.md, "Auth"). None of these is ever logged.
 * - The device token: 32 random bytes, base64url, made the first time it is needed and kept in
 *   chrome.storage.local (`tabfoldDevice`). Every request carries it; signing in links it to the
 *   account. Free never makes one.
 * - The Chrome profile key (same format) in chrome.storage.sync (`tabfold_profile`), made and
 *   registered after signing in, so other computers on the same Chrome profile sign themselves in.
 * - `tabfoldSignedOut` (local): the person signed out here, so this computer leaves the profile key
 *   alone until they sign in again.
 */

export const DEVICE_TOKEN_KEY = 'tabfoldDevice';
export const PROFILE_KEY = 'tabfold_profile';
export const SIGNED_OUT_KEY = 'tabfoldSignedOut';

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

export function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

/** 32 random bytes as base64url (43 characters). */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** This computer's device token, or null before one was made. */
export async function peekDeviceToken(): Promise<string | null> {
  const value = (await browser.storage.local.get(DEVICE_TOKEN_KEY))[DEVICE_TOKEN_KEY];
  return isToken(value) ? value : null;
}

let creating: Promise<string> | null = null;

/** The device token, made and stored the first time it is needed. */
export function getDeviceToken(): Promise<string> {
  creating ??= (async () => {
    const existing = await peekDeviceToken();
    if (existing) return existing;
    const token = newToken();
    await browser.storage.local.set({ [DEVICE_TOKEN_KEY]: token });
    return token;
  })().finally(() => {
    creating = null;
  });
  return creating;
}

/** Drop the device token (after signing out): the next request makes a new one that isn't signed in. */
export async function forgetDeviceToken(): Promise<void> {
  await browser.storage.local.remove(DEVICE_TOKEN_KEY);
}

/** The Chrome profile key, or null (none yet, or Chrome sync storage isn't available). */
export async function getProfileKey(): Promise<string | null> {
  try {
    const value = (await browser.storage.sync.get(PROFILE_KEY))[PROFILE_KEY];
    return isToken(value) ? value : null;
  } catch {
    return null;
  }
}

/** The profile key, made when there's none. Null when Chrome sync storage can't be used (then each computer signs in on its own). */
export async function ensureProfileKey(): Promise<string | null> {
  const existing = await getProfileKey();
  if (existing) return existing;
  const key = newToken();
  try {
    await browser.storage.sync.set({ [PROFILE_KEY]: key });
    return key;
  } catch {
    return null;
  }
}

export async function signedOutHere(): Promise<boolean> {
  return (await browser.storage.local.get(SIGNED_OUT_KEY))[SIGNED_OUT_KEY] === true;
}

export async function setSignedOutHere(value: boolean): Promise<void> {
  if (value) await browser.storage.local.set({ [SIGNED_OUT_KEY]: true });
  else await browser.storage.local.remove(SIGNED_OUT_KEY);
}

/** The profile key, when this computer may sign itself in with it (there is one, and the person didn't sign out here). */
export async function usableProfileKey(): Promise<string | null> {
  if (await signedOutHere()) return null;
  return getProfileKey();
}
