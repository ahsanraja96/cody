import { CommandError } from '../messages';

/** Placeholder for 0.6 commands while they're being built in parallel; replaced by the real handlers. */
export function notBuilt(type: string): never {
  throw new CommandError(`“${type}” isn’t built yet.`, 'not-built');
}
