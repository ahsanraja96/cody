import type { Command, CommandResults } from '../messages';
import { notBuilt } from './notBuilt';

/** Snooze and Fold automatically (Mx-Auto board). Placeholder: built in 0.6. */
export type AutomationCommand = Extract<Command, { type: 'snooze' | 'snooze-wake' | 'snooze-seen' | 'autofold-run' }>;

export async function handleAutomationCommand(command: AutomationCommand): Promise<CommandResults[AutomationCommand['type']]> {
  return notBuilt(command.type);
}
