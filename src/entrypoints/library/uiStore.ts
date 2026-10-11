import { create } from 'zustand';
import type { LimitErrorCode } from '@/lib/messages';
import type { FolderRecord, TabRecord } from '@/lib/types';

/**
 * The full list's small dialogs and passing states, opened from anywhere on the page (a row's
 * menu, the left column, a toast, the palette) and shown by one host in LibraryApp.
 */
export type LibraryDialog =
  /** Name a new folder; with tabs, they move into it. */
  | { kind: 'new-folder'; tabRecordIds?: string[] }
  /** "Free has 3 folders". */
  | { kind: 'folder-limit' }
  | { kind: 'delete-folder'; folder: FolderRecord; tabs: number }
  /** "Move all 6 tabs to a folder…": pick one (or name a new one). */
  | { kind: 'pick-folder'; tabRecordIds: string[]; title: string }
  /** "Pick a date and time…" for snoozing. */
  | { kind: 'snooze-at'; tabRecordIds: string[]; title: string }
  /** "Free has 3 snoozed tabs at a time". */
  | { kind: 'snooze-limit' }
  /** Opening a folder live while another one is. */
  | { kind: 'live-switch'; from: FolderRecord; to: FolderRecord }
  | { kind: 'share'; folderId: string }
  | { kind: 'duplicates' }
  | { kind: 'palette' };

interface LibraryUi {
  dialog: LibraryDialog | null;
  open: (dialog: LibraryDialog) => void;
  close: () => void;
  /** A Free action hit a limit with no page asking (worker `limit-hit`): the banner shows. */
  limitHit: LimitErrorCode | null;
  setLimitHit: (code: LimitErrorCode | null) => void;
  /** The folder whose name is being edited in place: in its list header, or in the left column. */
  renaming: { id: string; where: 'list' | 'side' } | null;
  setRenaming: (renaming: { id: string; where: 'list' | 'side' } | null) => void;
  /** The left column's "New folder" field is open. */
  creating: boolean;
  setCreating: (on: boolean) => void;
  /** Folder or group to scroll to and open ("Move to › Client sites" then jump). */
  jumpTo: string | null;
  setJumpTo: (id: string | null) => void;
}

export const useLibraryUi = create<LibraryUi>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
  limitHit: null,
  setLimitHit: (limitHit) => set({ limitHit }),
  renaming: null,
  setRenaming: (renaming) => set({ renaming }),
  creating: false,
  setCreating: (creating) => set({ creating }),
  jumpTo: null,
  setJumpTo: (jumpTo) => set({ jumpTo }),
}));

export function openDialog(dialog: LibraryDialog): void {
  useLibraryUi.getState().open(dialog);
}

/** A tab being dragged (HTML5 drag and drop), and the group it is over. */
interface DragState {
  tab: TabRecord | null;
  /** Group id (`folder:…` or `site:…`) under the pointer. */
  over: string | null;
  start: (tab: TabRecord) => void;
  setOver: (id: string | null) => void;
  end: () => void;
}

export const useDrag = create<DragState>((set) => ({
  tab: null,
  over: null,
  start: (tab) => set({ tab, over: null }),
  setOver: (over) => set((s) => (s.over === over ? s : { over })),
  end: () => set({ tab: null, over: null }),
}));

/** The data type a dragged folded tab carries (its record id), so drops from elsewhere are ignored. */
export const TAB_DRAG_TYPE = 'application/x-tabfold-tab';
