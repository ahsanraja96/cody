/** Rough memory a loaded tab costs. Chrome exposes no per-tab memory to extensions, so the banner shows an estimate. */
export const ESTIMATED_BYTES_PER_LOADED_TAB = 48 * 1024 * 1024;

export function estimateBytes(loadedTabs: number): number {
  return Math.max(0, loadedTabs) * ESTIMATED_BYTES_PER_LOADED_TAB;
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1000) return `${Math.max(0, Math.round(mb / 10) * 10)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function timeAgo(timestamp: number, now = Date.now()): string {
  const diff = now - timestamp;
  if (diff < MINUTE) return 'Just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  const days = Math.floor(diff / DAY);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return `Today ${time}`;
  const yesterday = new Date(now.getTime() - DAY);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${day}, ${time}`;
}

/** Default session name, e.g. "Oct 10 · 14:32". */
export function defaultSessionName(timestamp: number): string {
  const date = new Date(timestamp);
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${day} · ${hh}:${mm}`;
}

export function newId(): string {
  return crypto.randomUUID();
}
