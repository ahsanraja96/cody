import { browser } from 'wxt/browser';

/** chrome.runtime.getURL without WXT's known-path typing, for URLs with hashes, queries or _favicon. */
export function extUrl(path: string): string {
  return (browser.runtime.getURL as (p: string) => string)(path);
}

/** Chrome's local favicon cache (needs the "favicon" permission). No network request is made. */
export function faviconUrl(pageUrl: string, size = 32): string {
  return `${extUrl('/_favicon/')}?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`;
}
