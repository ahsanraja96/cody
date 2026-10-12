import { ArrowRight, Clock, ClipboardCopy, ExternalLink, FolderPlus, Layers, Link, Pencil, Radio, Star, StarOff, StickyNote, Trash2, Undo2, Folder } from 'lucide-react';
import { CATEGORIES, categorize, type SiteKinds } from '@/lib/categories';
import type { PlanState } from '@/lib/pro/types';
import type { LiveFolder } from '@/lib/state';
import type { FolderRecord, TabRecord } from '@/lib/types';
import { ColorDot, FolderIcon } from '@/ui/components/FolderIcon';
import type { MenuEntry } from '@/ui/components/Menu';
import { ProTag } from '@/ui/components/ProBits';
import { cx } from '@/ui/cx';
import { starFolder } from '@/ui/components/NoteField';
import { personalFolders, teamFolders } from '@/lib/teams';
import { FOLDER_COLORS, type TabGroup } from '@/ui/folders';
import { hasFreeLimits } from '@/ui/hooks';
import { snoozeChoices } from '@/ui/snooze';
import { copyAsContext, openFolded, openGroup, removeGroup, removeOne } from './actions';
import {
  folderLimitReached,
  moveSiteToKind,
  moveToFolder,
  openLive,
  recolorFolder,
  snoozeTabs,
} from './folderActions';
import { count } from './format';
import { goToPlans } from './router';
import { openDialog, useLibraryUi } from './uiStore';

/** What the menus need to know about the list around them. */
export interface MenuContext {
  folders: readonly FolderRecord[];
  siteKinds: SiteKinds;
  plan: PlanState;
  liveFolders: Record<string, LiveFolder>;
  /** Pro AI: Copy as context works (others see a Pro AI tag that opens the plans). */
  canCopyContext: boolean;
  /** Is this folder starred for this person (1.0)? */
  isStarred?: (folder: FolderRecord) => boolean;
}

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/**
 * "Move to ›": the person's folders, New folder…, the team's folders under "Team" (Mx-Share), Kind
 * of site ›, Out of its folder (Fo-Folders-States).
 */
function moveEntries(tab: TabRecord, ctx: MenuContext): MenuEntry[] {
  const current = ctx.folders.find((f) => f.id === tab.folderId) ?? null;
  const kind = categorize(tab.url, ctx.siteKinds);
  const entry = (folder: FolderRecord): MenuEntry => ({
    key: `f:${folder.id}`,
    label: folder.name,
    icon: <FolderIcon color={folder.color} />,
    checked: folder.id === tab.folderId,
    onSelect: () => {
      if (folder.id !== tab.folderId) void moveToFolder([tab], folder, current);
    },
  });
  const entries: MenuEntry[] = personalFolders(ctx.folders).map(entry);
  entries.push({
    key: 'new',
    label: 'New folder…',
    icon: <FolderPlus {...ICON} />,
    onSelect: () => openDialog(folderLimitReached(ctx.plan, ctx.folders) ? { kind: 'folder-limit' } : { kind: 'new-folder', tabRecordIds: [tab.id] }),
  });
  const team = teamFolders(ctx.folders);
  // Folded from Incognito: it stays on this computer, so never in a team folder.
  if (team.length && !tab.incognito) {
    entries.push({ type: 'separator', key: 'st' });
    entries.push({ type: 'heading', key: 'team', label: 'Team' });
    entries.push(...team.map(entry));
  }
  entries.push({ type: 'separator', key: 's1' });
  entries.push({
    key: 'kind',
    label: 'Kind of site',
    icon: <Layers {...ICON} />,
    submenuWidth: 184,
    submenu: CATEGORIES.map((c) => ({
      key: c.id,
      label: c.name,
      icon: <ColorDot color={c.color} size={8} />,
      // In a folder no kind is "current": choosing one takes it out of the folder.
      checked: !current && c.id === kind,
      onSelect: () => {
        if (current || c.id !== kind) void moveSiteToKind(tab, c.id, ctx.siteKinds, current);
      },
    })),
  });
  if (current) {
    entries.push({
      key: 'out',
      label: 'Out of its folder',
      icon: <Undo2 {...ICON} />,
      onSelect: () => void moveToFolder([tab], null, current),
    });
  }
  return entries;
}

/** "Snooze ›": the board's times, then "Pick a date and time…" (Mx-Auto). */
export function snoozeEntries(tabs: TabRecord[], title: string): MenuEntry[] {
  const entries: MenuEntry[] = snoozeChoices().map((choice) => ({
    key: choice.id,
    label: choice.label,
    icon: <Clock {...ICON} />,
    hint: choice.hint,
    onSelect: () => void snoozeTabs(tabs, choice.at),
  }));
  entries.push({ type: 'separator', key: 's' });
  entries.push({
    key: 'pick',
    label: 'Pick a date and time…',
    icon: <Clock {...ICON} />,
    onSelect: () => openDialog({ kind: 'snooze-at', tabRecordIds: tabs.map((t) => t.id), title }),
  });
  return entries;
}

/** A folded tab's ⋯ menu, also on right-click and Shift+F10 (Up-Move-States). A team's tab doesn't snooze (it's everyone's). */
export function tabMenu(tab: TabRecord, ctx: MenuContext): MenuEntry[] {
  const title = tab.title || tab.url;
  const inTeam = !!ctx.folders.find((f) => f.id === tab.folderId)?.teamId;
  return [
    { key: 'move', label: 'Move to', icon: <ArrowRight {...ICON} />, submenu: moveEntries(tab, ctx), submenuWidth: 220 },
    ...(inTeam ? [] : [{ key: 'snooze', label: 'Snooze', icon: <Clock {...ICON} />, submenu: snoozeEntries([tab], title), submenuWidth: 252 }]),
    { key: 'bg', label: 'Open in background', icon: <ExternalLink {...ICON} />, onSelect: () => void openFolded(tab, false) },
    { type: 'separator', key: 's' },
    { key: 'remove', label: 'Remove from list', icon: <Trash2 {...ICON} />, danger: true, onSelect: () => void removeOne(tab) },
  ];
}

/** The 9 colour swatches in a folder's menu, as one row of radio items. */
function swatches(folder: FolderRecord): MenuEntry {
  return {
    type: 'custom',
    key: 'colour',
    render: (close) => (
      <div className="flex min-h-[34px] items-center gap-2.5 rounded-md px-2.5 py-1.5">
        <span className="flex shrink-0 text-text-2">
          <Folder {...ICON} aria-hidden />
        </span>
        <span id={`colour-${folder.id}`} className="flex-1">
          Colour
        </span>
        <span role="group" aria-labelledby={`colour-${folder.id}`} className="flex gap-[5px]">
          {FOLDER_COLORS.map((color) => {
            const on = color === folder.color;
            return (
              <button
                key={color}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                aria-label={color[0]!.toUpperCase() + color.slice(1)}
                title={color[0]!.toUpperCase() + color.slice(1)}
                data-menu-item=""
                onClick={() => {
                  close();
                  void recolorFolder(folder, color);
                }}
                className={cx(
                  `tf-cg-${color}`,
                  'size-3.5 rounded-full outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                )}
                style={{ background: 'var(--tf-cg)', boxShadow: on ? '0 0 0 2px var(--tf-surface), 0 0 0 3.5px var(--tf-cg)' : undefined }}
              />
            );
          })}
        </span>
      </div>
    ),
  };
}

/** A folder's ⋯ menu (Fo-Folders-States, Mx-Live-States, Mx-Share). */
export function folderMenu(group: TabGroup, ctx: MenuContext): MenuEntry[] {
  const folder = group.folder!;
  const free = hasFreeLimits(ctx.plan);
  const n = group.items.length;
  const live = !!ctx.liveFolders[folder.id];
  // A team folder's link is the owner's to share (Mx-Plans: "Owner controls: members, sharing").
  const shareable = !folder.teamId || ctx.plan.team?.role === 'owner';
  const starred = !!ctx.isStarred?.(folder);
  return [
    // 1.0 (Fi-Fold-States): Star / Unstar, Add a note / Edit the note.
    { key: 'star', label: starred ? 'Unstar' : 'Star', icon: starred ? <StarOff {...ICON} /> : <Star {...ICON} />, onSelect: () => void starFolder(folder, !starred) },
    {
      key: 'note',
      label: folder.note ? 'Edit the note' : 'Add a note',
      icon: <StickyNote {...ICON} />,
      onSelect: () => useLibraryUi.getState().setEditingNote(folder.id),
    },
    { type: 'separator', key: 's0' },
    { key: 'rename', label: 'Rename', icon: <Pencil {...ICON} />, onSelect: () => useLibraryUi.getState().setRenaming({ id: folder.id, where: 'list' }) },
    swatches(folder),
    { type: 'separator', key: 's1' },
    {
      key: 'live',
      label: live ? 'Go to the live group' : 'Open as a live group',
      icon: <Radio {...ICON} />,
      hint: free ? <ProTag /> : undefined,
      disabled: !free && n === 0 && !live,
      onSelect: () => void openLive(folder, ctx.liveFolders, ctx.folders, ctx.plan),
    },
    {
      key: 'copy',
      label: 'Open all (a copy) as a tab group',
      icon: <Layers {...ICON} />,
      disabled: n === 0,
      onSelect: () => void openGroup(group.items, folder, folder.id),
    },
    {
      key: 'share',
      label: 'Share…',
      icon: <Link {...ICON} />,
      hint: free ? <ProTag /> : undefined,
      disabled: !free && !shareable,
      description: !free && !shareable ? 'Only the team’s owner can share it' : undefined,
      onSelect: () => (free ? goToPlans() : openDialog({ kind: 'share', folderId: folder.id })),
    },
    {
      key: 'context',
      label: 'Copy as context for AI',
      icon: <ClipboardCopy {...ICON} />,
      hint: ctx.canCopyContext ? undefined : <ProTag label="Pro AI" />,
      disabled: n === 0 && ctx.canCopyContext,
      onSelect: () => (ctx.canCopyContext ? void copyAsContext(group.items, folder.name) : goToPlans()),
    },
    { type: 'separator', key: 's2' },
    {
      key: 'delete',
      label: 'Delete folder…',
      icon: <Trash2 {...ICON} />,
      danger: true,
      onSelect: () => openDialog({ kind: 'delete-folder', folder, tabs: n }),
    },
  ];
}

/** A kind-of-site group's ⋯ menu (Fo-Folders-States "Move a whole group"). */
export function siteGroupMenu(group: TabGroup, ctx: MenuContext): MenuEntry[] {
  const n = group.items.length;
  return [
    { key: 'open', label: 'Open all', icon: <Layers {...ICON} />, disabled: n === 0, onSelect: () => void openGroup(group.items, group) },
    {
      key: 'move',
      label: `Move all ${count(n, 'tab')} to a folder…`,
      icon: <Folder {...ICON} />,
      disabled: n === 0,
      onSelect: () => openDialog({ kind: 'pick-folder', tabRecordIds: group.items.map((t) => t.id), title: `Move all ${count(n, 'tab')} to a folder` }),
    },
    {
      key: 'context',
      label: 'Copy as context for AI',
      icon: <ClipboardCopy {...ICON} />,
      hint: ctx.canCopyContext ? undefined : <ProTag label="Pro AI" />,
      disabled: n === 0 && ctx.canCopyContext,
      onSelect: () => (ctx.canCopyContext ? void copyAsContext(group.items, group.name) : goToPlans()),
    },
    { type: 'separator', key: 's' },
    {
      key: 'remove',
      label: `Remove all ${count(n, 'tab')}`,
      description: 'You can undo for 10 seconds',
      icon: <Trash2 {...ICON} />,
      danger: true,
      disabled: n === 0,
      onSelect: () => void removeGroup(group.items),
    },
  ];
}
