import { useState } from 'react';
import { db } from '@/lib/db';
import { moveTab } from '@/lib/repo';
import { toast } from '@/ui/components/Toast';

/** Drag payload for a saved tab (its database id). Dropping on a tab, window or session card moves it. */
export const TAB_DRAG_TYPE = 'application/x-tabfold-tab';

/**
 * Move a saved tab into another session (its first window) and offer Undo, which puts the tab
 * back where it was: same window and position, or the old session if that window is gone.
 */
export async function moveTabToSession(tabId: string, target: { id: string; name: string }): Promise<boolean> {
  const tab = await db.tabs.get(tabId);
  if (!tab || tab.sessionId === target.id) return false;
  const siblings = await db.tabs.where('windowId').equals(tab.windowId).sortBy('order');
  const nextId = siblings[siblings.findIndex((t) => t.id === tabId) + 1]?.id ?? null;
  try {
    await moveTab(tabId, { sessionId: target.id });
  } catch {
    toast('Could not move the tab. Please try again.', { tone: 'error' });
    return false;
  }
  toast(`Moved 1 tab to ${target.name}`, {
    action: {
      label: 'Undo',
      onClick: async () => {
        const window = await db.windows.get(tab.windowId);
        if (window) await moveTab(tabId, { windowId: tab.windowId, beforeTabId: nextId });
        else await moveTab(tabId, { sessionId: tab.sessionId });
      },
    },
  });
  return true;
}

/** Makes an element a drop target for dragged saved tabs; `over` is true while one hovers it. */
export function useTabDrop(target: { id: string; name: string }, enabled = true) {
  const [over, setOver] = useState(false);
  const accepts = (e: React.DragEvent) => enabled && e.dataTransfer.types.includes(TAB_DRAG_TYPE);
  return {
    over,
    props: {
      onDragEnter: (e: React.DragEvent) => {
        if (!accepts(e)) return;
        e.preventDefault();
        setOver(true);
      },
      onDragOver: (e: React.DragEvent) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver(false);
      },
      onDrop: (e: React.DragEvent) => {
        setOver(false);
        if (!accepts(e)) return;
        const tabId = e.dataTransfer.getData(TAB_DRAG_TYPE);
        if (!tabId) return;
        e.preventDefault();
        void moveTabToSession(tabId, target);
      },
    },
  };
}
