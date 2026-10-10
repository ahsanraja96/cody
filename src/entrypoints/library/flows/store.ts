import { create } from 'zustand';
import type { ImportSource } from '@/lib/importers';
import type { RestoreFailure, RestoreMode, WorkerEvent } from '@/lib/messages';

/** The library's flow dialogs. One is open at a time; FlowsHost renders it. */
export type FlowDialogState =
  | { kind: 'export'; sessionIds?: string[] }
  | { kind: 'restore'; sessionId: string }
  | {
      kind: 'already-open';
      sessionId: string;
      sessionName: string;
      mode: RestoreMode;
      windowRecordId?: string;
      windowIds: number[];
      openTabs: number;
      totalTabs: number;
    }
  | { kind: 'file-access'; sessionId: string | null; sessionName: string; files: RestoreFailure[]; opened: number }
  | { kind: 'import'; source?: ImportSource }
  | { kind: 'shortcuts' }
  | { kind: 'clear-data' };

/** Pages Chrome wouldn't reopen in the last restore, shown as the amber "Restored 21 of 24 tabs" card. */
export interface RestoreFailures {
  restoreId: string;
  sessionId: string | null;
  sessionName: string;
  opened: number;
  total: number;
  failed: RestoreFailure[];
}

/** A restore this page asked for, so progress can name it and mark the right windows before the worker says. */
export interface PendingRestore {
  sessionId: string;
  sessionName: string;
  windowRecordId?: string;
  startedAt: number;
}

export type LiveProgress = Extract<WorkerEvent, { type: 'restore-progress' }>;

interface FlowsState {
  dialog: FlowDialogState | null;
  /** Dialogs waiting behind the open one (e.g. the failures card after the file access dialog). */
  queue: FlowDialogState[];
  failures: RestoreFailures | null;
  pending: PendingRestore | null;
  live: LiveProgress | null;
  /** Restores this page started or cancelled; their outcome is reported here once. */
  owned: Set<string>;
  handled: Set<string>;
  open: (dialog: FlowDialogState) => void;
  enqueue: (dialog: FlowDialogState) => void;
  close: () => void;
  setFailures: (failures: RestoreFailures | null) => void;
  setPending: (pending: PendingRestore | null) => void;
  setLive: (live: LiveProgress | null) => void;
}

export const useFlows = create<FlowsState>((set) => ({
  dialog: null,
  queue: [],
  failures: null,
  pending: null,
  live: null,
  owned: new Set(),
  handled: new Set(),
  open: (dialog) => set({ dialog }),
  enqueue: (dialog) => set((state) => (state.dialog ? { queue: [...state.queue, dialog] } : { dialog })),
  close: () => set((state) => ({ dialog: state.queue[0] ?? null, queue: state.queue.slice(1) })),
  setFailures: (failures) => set({ failures }),
  setPending: (pending) => set({ pending }),
  setLive: (live) => set({ live }),
}));

export const flows = () => useFlows.getState();
