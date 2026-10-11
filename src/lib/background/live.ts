import type { Command, CommandResults } from '../messages';
import { notBuilt } from './notBuilt';

/** Live folders: a folder open as a Chrome tab group that saves itself (Mx-Live boards, Pro). Placeholder: built in 0.6. */
export type LiveCommand = Extract<Command, { type: 'live-open' | 'live-fold' | 'live-focus' }>;

export async function handleLiveCommand(command: LiveCommand): Promise<CommandResults[LiveCommand['type']]> {
  return notBuilt(command.type);
}
