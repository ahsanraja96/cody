import type { Command, CommandResults } from '../messages';
import { notBuilt } from './notBuilt';

/** Share a folder as a link (Mx-Share board, Pro). Placeholder: built in 0.6. */
export type ShareCommand = Extract<Command, { type: 'share-create' | 'share-update' | 'share-stop' | 'share-info' }>;

export async function handleShareCommand(command: ShareCommand): Promise<CommandResults[ShareCommand['type']]> {
  return notBuilt(command.type);
}
