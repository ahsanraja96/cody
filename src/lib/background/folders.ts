import type { Command, CommandResults } from '../messages';
import { notBuilt } from './notBuilt';

/**
 * Folders, kinds of site, the free list's limit ("Make room") and duplicates (Fo-* boards).
 * Placeholder: built in 0.6.
 */
export type FolderCommand = Extract<
  Command,
  {
    type:
      | 'folder-create'
      | 'folder-update'
      | 'folder-reorder'
      | 'folder-delete'
      | 'tabs-move'
      | 'site-kind-set'
      | 'room-list'
      | 'room-free'
      | 'duplicates-list'
      | 'duplicates-remove';
  }
>;

export async function handleFolderCommand(command: FolderCommand): Promise<CommandResults[FolderCommand['type']]> {
  return notBuilt(command.type);
}
