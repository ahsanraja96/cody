/** Wording for times on the full list, as on the boards ("2 min ago", "Today 15:38"). */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** "Just now", "2 min ago", "6 h ago", "Yesterday", "3 days ago", "Last week", "3 weeks ago", "Aug 3". */
export function ago(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < MINUTE) return 'Just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  const days = Math.max(1, Math.round((startOfDay(now) - startOfDay(timestamp)) / DAY));
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'Last week';
  if (days < 35) return `${Math.floor(days / 7)} weeks ago`;
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  });
}

function clock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** "Today 15:38", "Yesterday 18:40", "Mon 09:12" (this week), "Aug 3, 14:02". */
export function foldTime(timestamp: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(timestamp)) / DAY);
  if (days <= 0) return `Today ${clock(timestamp)}`;
  if (days === 1) return `Yesterday ${clock(timestamp)}`;
  const date = new Date(timestamp);
  if (days < 7) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${clock(timestamp)}`;
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${day}, ${clock(timestamp)}`;
}

/** "~2.1 GB", "~480 MB". */
export function approxBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1000) return `~${Math.max(10, Math.round(mb / 10) * 10)} MB`;
  return `~${(mb / 1024).toFixed(1)} GB`;
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
