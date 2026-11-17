/** The card under a town when a villager is selected. Shared by the daily town and the practice towns. */
import { KIND_NAME, KIND_RULE } from '../shared/daily.ts';
import { kindGlyph } from './art.ts';
import type { TownView } from './town.ts';
import { esc } from './util.ts';

function listNames(names: string[]): string {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
}

/** Fills `card` with who this villager is, who they would tell, and the whisper button. */
export function showWho(card: HTMLElement, town: TownView, index: number, onWhisper: () => void): void {
  const tile = town.tile(index);
  const knows = Boolean(town.state.knows[index]);
  const halfway = !knows && tile.kind === 'skeptic' && (town.state.heard[index] ?? 0) > 0;
  const told = town.targets(index).map((i) => town.tile(i).name);
  card.innerHTML = `
    <div class="who">
      <h2>${esc(tile.name)}${tile.me ? ' <em>that’s you</em>' : ''} <span class="kind ${tile.kind}">${kindGlyph(tile.kind)}${KIND_NAME[tile.kind]}</span></h2>
      <p>${KIND_RULE[tile.kind]}${halfway ? ' <b>Heard it once so far.</b>' : ''}</p>
      <p class="tells">${told.length ? `Would tell <b>${esc(listNames(told))}</b>` : 'Would tell <b>no one</b>'}</p>
    </div>
    <button class="go${knows ? '' : ' pulse'}" id="go" type="button" ${knows ? 'disabled' : ''}>${knows ? 'Already knows' : 'Whisper'}</button>`;
  card.querySelector('#go')?.addEventListener('click', onWhisper);
}
