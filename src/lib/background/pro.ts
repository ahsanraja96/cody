import { CommandError, type Command, type CommandResults } from '../messages';
import { planState } from '../pro/state';

/**
 * Pro and Pro AI in the worker: plan refresh (ExtensionPay), checkout pages, Organise with AI,
 * Copy as context, backups and sync with the Tabfold account. Placeholder until the Pro build lands.
 */

type ProCommand = Extract<
  Command,
  {
    type:
      | 'plan-refresh'
      | 'plan-open'
      | 'ai-organise'
      | 'ai-apply'
      | 'ai-context'
      | 'backups-list'
      | 'backup-restore'
      | 'cloud-sync-now'
      | 'milestone-dismiss'
      | 'reopen-everything';
  }
>;

export async function handleProCommand(command: ProCommand): Promise<CommandResults[ProCommand['type']]> {
  switch (command.type) {
    case 'plan-refresh':
      return planState.get();
    default:
      throw new CommandError('Pro isn’t available in this build yet.', 'not-configured');
  }
}
