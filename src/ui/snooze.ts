/**
 * Snooze times for the pages. The choices and their wording come from the worker's own helpers
 * (src/lib/snooze.ts: "Later today 18:00", "Tomorrow morning Tue 9:00"); this adds what the
 * "Pick a date and time…" field needs.
 */
export { formatSnoozeTime, snoozeChoices, type SnoozeChoice } from '@/lib/snooze';

/** The value for an <input type="datetime-local"> (local time, minutes). */
export function toLocalInput(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}
