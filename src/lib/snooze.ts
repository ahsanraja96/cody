/**
 * Snooze times (Mx-Auto board): the choices in a tab's Snooze menu, the page's right-click menu and
 * the popup. All in local time. Pure, so the pages and the worker share them.
 */

export type SnoozeChoiceId = 'later-today' | 'tomorrow' | 'weekend' | 'next-week' | 'month';

export interface SnoozeChoice {
  id: SnoozeChoiceId;
  /** "Later today", "Tomorrow morning", "This weekend", "Next week", "In a month". */
  label: string;
  /** When the tab comes back (ms). */
  at: number;
  /** The time as the menu shows it next to the label: "18:00", "Tue 9:00", "Sat 9:00", "Mon 9:00", "11 Nov". */
  hint: string;
}

/** "Later today" is at this hour, offered until an hour before. */
export const LATER_TODAY_HOUR = 18;
/** Mornings ("Tomorrow morning", the weekend, next week, in a month) start at this hour. */
export const MORNING_HOUR = 9;
/** The snooze shortcut (Alt+Shift+Z) snoozes the tab you're on until tomorrow morning. */
export const SHORTCUT_CHOICE: SnoozeChoiceId = 'tomorrow';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function at(base: Date, addDays: number, hour: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays, hour, 0, 0, 0);
}

/** "9:00", "18:00". */
function clock(date: Date): string {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** The same day next month at 9:00 (the 31st becomes the month's last day). */
function nextMonth(today: Date): Date {
  const lastDay = new Date(today.getFullYear(), today.getMonth() + 2, 0).getDate();
  return new Date(today.getFullYear(), today.getMonth() + 1, Math.min(today.getDate(), lastDay), MORNING_HOUR, 0, 0, 0);
}

/**
 * The menu's choices for now. "Later today" (18:00) only until 17:00; "This weekend" is the coming
 * Saturday at 9:00 (on a Saturday, Sunday; none on a Sunday); "Next week" is the next Monday.
 */
export function snoozeChoices(now = Date.now()): SnoozeChoice[] {
  const today = new Date(now);
  const day = today.getDay();
  const choices: SnoozeChoice[] = [];

  const later = at(today, 0, LATER_TODAY_HOUR);
  if (later.getTime() - now >= 60 * 60_000) choices.push({ id: 'later-today', label: 'Later today', at: later.getTime(), hint: clock(later) });

  const tomorrow = at(today, 1, MORNING_HOUR);
  choices.push({ id: 'tomorrow', label: 'Tomorrow morning', at: tomorrow.getTime(), hint: `${WEEKDAYS[tomorrow.getDay()]} ${clock(tomorrow)}` });

  if (day !== 0) {
    const weekend = at(today, day === 6 ? 1 : 6 - day, MORNING_HOUR);
    choices.push({ id: 'weekend', label: 'This weekend', at: weekend.getTime(), hint: `${WEEKDAYS[weekend.getDay()]} ${clock(weekend)}` });
  }

  const monday = at(today, ((8 - day) % 7) || 7, MORNING_HOUR);
  choices.push({ id: 'next-week', label: 'Next week', at: monday.getTime(), hint: `${WEEKDAYS[monday.getDay()]} ${clock(monday)}` });

  const month = nextMonth(today);
  choices.push({ id: 'month', label: 'In a month', at: month.getTime(), hint: `${month.getDate()} ${MONTHS[month.getMonth()]}` });
  return choices;
}

/**
 * When a choice picked from a menu built earlier comes back. A choice that isn't offered any more
 * ("Later today" after 17:00, "This weekend" on a Sunday) falls back to tomorrow morning.
 */
export function snoozeTime(id: SnoozeChoiceId, now = Date.now()): number {
  const choices = snoozeChoices(now);
  return (choices.find((c) => c.id === id) ?? choices.find((c) => c.id === 'tomorrow')!).at;
}

/** When a snoozed tab comes back, for the Snoozed list: "Today 18:00", "Tomorrow 9:00", "Mon 9:00", "11 Nov 9:00". */
export function formatSnoozeTime(time: number, now = Date.now()): string {
  const date = new Date(time);
  const today = new Date(now);
  const days = Math.round((at(date, 0, 0).getTime() - at(today, 0, 0).getTime()) / (24 * 60 * 60_000));
  if (days === 0) return `Today ${clock(date)}`;
  if (days === 1) return `Tomorrow ${clock(date)}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[date.getDay()]} ${clock(date)}`;
  const year = date.getFullYear() === today.getFullYear() ? '' : ` ${date.getFullYear()}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${year} ${clock(date)}`;
}
