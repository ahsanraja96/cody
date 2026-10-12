import type { Command, CommandResults } from '../messages';
import { notBuilt } from './notBuilt';

/**
 * 1.0: open tabs and windows: close the copies of pages open twice, tidy a window into tab groups,
 * name windows (remembered across restarts, `namedWindows`), the weekly summary.
 */
export type WindowsCommand = Extract<Command, { type: 'copies-close' | 'window-tidy' | 'window-rename' | 'weekly-summary-dismiss' }>;

export async function handleWindowsCommand(command: WindowsCommand): Promise<CommandResults[WindowsCommand['type']]> {
  return notBuilt(command.type);
}
