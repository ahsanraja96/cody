import type { AutoFoldNotice } from '@/lib/state';

/**
 * Small wording helpers for the 0.6 limits and automatic folds, shared by the popup and the full
 * list.
 */

/**
 * A fold that didn't fit, from the worker's words when only the message came through (a fold
 * started elsewhere: "This fold needs room for 23 tabs; your free list has room for 18.").
 */
export function listFullFrom(message: string | undefined): { room?: number; needed?: number } | null {
  if (!message || !/free list/i.test(message)) return null;
  const num = (v?: string) => (v ? Number(v.replace(/,/g, '')) : undefined);
  const needed = num(/needs room for (\d[\d,]*)/i.exec(message)?.[1]);
  const room = num(/has room for (\d[\d,]*)/i.exec(message)?.[1]);
  return { needed, room: room ?? (/is full/i.test(message) ? 0 : undefined) };
}

function clock(timestamp: number): string {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function approx(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1000) return `~${Math.max(10, Math.round(mb / 10) * 10)} MB`;
  return `~${(mb / 1024).toFixed(1)} GB`;
}

/** "Folded 23 tabs at 18:00 (your weekday rule) · freed ~1.1 GB" (Mx-Auto). */
export function autoFoldText(notice: AutoFoldNotice): string {
  const tabs = `${notice.folded.toLocaleString()} ${notice.folded === 1 ? 'tab' : 'tabs'}`;
  return `Folded ${tabs} at ${clock(notice.at)}${notice.label ? ` (${notice.label})` : ''}${notice.freedBytes > 0 ? ` · freed ${approx(notice.freedBytes)}` : ''}`;
}
