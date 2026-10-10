import { create } from 'zustand';
import { UNDO_WINDOW_MS } from '@/lib/state';

/**
 * Everything on the page that can be undone for 10 seconds (a fold, a removed row, a removed
 * group), newest last, so ⌘Z / Ctrl+Z undoes the latest one whichever way it is shown.
 */
interface UndoEntry {
  key: string;
  expiresAt: number;
  run: () => void;
}

interface UndoState {
  entries: UndoEntry[];
  push: (entry: UndoEntry) => void;
  drop: (key: string) => void;
}

export const useUndo = create<UndoState>((set) => ({
  entries: [],
  push: (entry) => set((s) => ({ entries: [...s.entries.filter((e) => e.key !== entry.key && e.expiresAt > Date.now()), entry] })),
  drop: (key) => set((s) => ({ entries: s.entries.filter((e) => e.key !== key) })),
}));

export function registerUndo(key: string, run: () => void, expiresAt = Date.now() + UNDO_WINDOW_MS): void {
  useUndo.getState().push({ key, run, expiresAt });
}

export function dropUndo(key: string): void {
  useUndo.getState().drop(key);
}

/** Run the newest undo that hasn't expired. False when there is nothing to undo. */
export function undoLatest(): boolean {
  const { entries, drop } = useUndo.getState();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.expiresAt > Date.now()) {
      drop(entry.key);
      entry.run();
      return true;
    }
  }
  return false;
}
