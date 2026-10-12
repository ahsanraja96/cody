import type { Browser } from 'wxt/browser';
import { create } from 'zustand';
import type { TabRecord } from '@/lib/types';

/**
 * A tab being dragged in the side panel (HTML5 drag and drop): an open tab (dropped on a folder it
 * folds into it) or a folded one (dropped on a folder it moves), and the group it's over.
 */
export type Dragged = { kind: 'open'; tab: Browser.tabs.Tab } | { kind: 'folded'; tab: TabRecord };

interface DragState {
  dragged: Dragged | null;
  /** `folder:<id>` or `site:<kind>`. */
  over: string | null;
  start: (dragged: Dragged) => void;
  setOver: (id: string | null) => void;
  end: () => void;
}

export const useDrag = create<DragState>((set) => ({
  dragged: null,
  over: null,
  start: (dragged) => set({ dragged, over: null }),
  setOver: (over) => set((s) => (s.over === over ? s : { over })),
  end: () => set({ dragged: null, over: null }),
}));

/** The data type the panel's drags carry, so drops from elsewhere are ignored. */
export const PANEL_DRAG_TYPE = 'application/x-tabfold-panel';
