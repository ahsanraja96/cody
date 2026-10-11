import type { Command, CommandResults } from '../messages';
import { notBuilt } from './notBuilt';

/** Ask your tabs and the weekly tidy-up (Mx-Ask board, Pro AI). Placeholder: built in 0.6. */
export type TidyCommand = Extract<Command, { type: 'ai-ask' | 'tidy-run' | 'tidy-apply' | 'tidy-dismiss' }>;

export async function handleTidyCommand(command: TidyCommand): Promise<CommandResults[TidyCommand['type']]> {
  return notBuilt(command.type);
}
