/**
 * Snooze choices and times as the Mx-Auto board words them ("Later today 18:00", "Tomorrow
 * morning Tue 9:00"), in local time. The worker's context menu offers the same choices
 * (src/lib/snooze.ts on the worker side); this copy keeps the pages free of worker code.
 */

export interface SnoozeChoice {
  id: 'later' | 'tomorrow' | 'weekend' | 'next-week' | 'month';
  label: string;
  /** The time it comes back, short: "18:00", "Tue 9:00", "11 Nov". */
  detail: string;
  at: number;
}

const HOUR = 3_600_000;

function at(base: Date, days: number, hour: number, minute = 0): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function clock(d: Date): string {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function clock2(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function weekday(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

function dayMonth(d: Date): string {
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function snoozeChoices(now = Date.now()): SnoozeChoice[] {
  const today = new Date(now);
  // Later today: 18:00, or three hours from now (on the hour) once it's past five.
  const evening = at(today, 0, 18);
  const later = evening.getTime() - now >= HOUR ? evening : new Date(Math.ceil((now + 3 * HOUR) / HOUR) * HOUR);
  const tomorrow = at(today, 1, 9);
  const day = today.getDay();
  // This weekend: the coming Saturday 9:00 (next week's on a weekend).
  const toSaturday = (6 - day + 7) % 7 || 7;
  const weekend = at(today, toSaturday, 9);
  // Next week: the coming Monday 9:00.
  const toMonday = (1 - day + 7) % 7 || 7;
  const monday = at(today, toMonday, 9);
  const month = new Date(today);
  month.setMonth(month.getMonth() + 1);
  month.setHours(9, 0, 0, 0);
  return [
    { id: 'later', label: 'Later today', detail: clock2(later), at: later.getTime() },
    { id: 'tomorrow', label: 'Tomorrow morning', detail: `${weekday(tomorrow)} ${clock(tomorrow)}`, at: tomorrow.getTime() },
    { id: 'weekend', label: 'This weekend', detail: `${weekday(weekend)} ${clock(weekend)}`, at: weekend.getTime() },
    { id: 'next-week', label: 'Next week', detail: `${weekday(monday)} ${clock(monday)}`, at: monday.getTime() },
    { id: 'month', label: 'In a month', detail: dayMonth(month), at: month.getTime() },
  ];
}

/** When a snoozed tab comes back: "Today 18:00", "Tomorrow 9:00", "Mon 9:00", "11 Nov 9:00". */
export function snoozeTime(timestamp: number, now = Date.now()): string {
  const d = new Date(timestamp);
  const start = (t: number) => {
    const x = new Date(t);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const days = Math.round((start(timestamp) - start(now)) / (24 * HOUR));
  const time = d.getMinutes() === 0 && days !== 0 ? clock(d) : clock2(d);
  if (days === 0) return `Today ${clock2(d)}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${weekday(d)} ${time}`;
  return `${dayMonth(d)} ${time}`;
}

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
