/** What a redditor sees in their feed: the rumor and one button. */
import { requestExpandedMode } from '@devvit/web/client';

import type { InitResponse } from '../shared/api.ts';
import { LOGO, villagerSvg } from './art.ts';
import { showGame } from './game.ts';
import { journey } from './net.ts';
import * as sound from './sound.ts';
import { countdown, esc } from './util.ts';

export function showSplash(root: HTMLElement, data: InitResponse): void {
  const started = data.whispers.length > 0;
  const cta = data.done ? 'See the front page' : started ? 'Keep whispering' : 'Play';
  const folk = data.tiles.filter((t) => t !== null).slice(0, 5);
  const status = data.done
    ? `Solved in ${data.result?.whispers ?? data.whispers.length} · next rumor in ${countdown(data.msToNext)}`
    : data.players > 0
      ? `${data.players} ${data.players === 1 ? 'villager is' : 'villagers are'} whispering today`
      : 'Be the first to whisper today';

  root.className = 'screen splash';
  root.innerHTML = `
    <div class="splash-top">
      <div class="brand big">${LOGO}<b>Psst!</b></div>
      <p class="dateline">No. ${data.day} · ${esc(data.label)} · ${esc(data.difficulty)}</p>
    </div>
    <blockquote class="bubble"><span>Psst…</span> ${esc(data.rumor.charAt(0).toLowerCase() + data.rumor.slice(1))}.</blockquote>
    <p class="pitch">Whisper it to one villager and watch it travel. Can you reach the whole town with a single whisper?</p>
    <button class="go big" id="play" type="button">${cta}</button>
    <p class="status">${data.stats.streak > 0 ? `<b>${data.stats.streak}-day streak</b> · ` : ''}${esc(status)}</p>
    <div class="crowd" aria-hidden="true">${folk.map((tile, i) => `<span class="tile folk ${i === 2 ? 'knows' : ''}">${villagerSvg({ ...tile, dir: i < 2 ? 1 : 3 }, 0)}</span>`).join('')}</div>`;

  (root.querySelector('#play') as HTMLButtonElement).addEventListener('click', (event) => {
    sound.wake();
    journey.interaction('play', data.done ? 'results' : started ? 'resume' : 'new');
    try {
      // The expanded view is its own page; it starts the journey on the first move.
      requestExpandedMode(event, 'game');
    } catch {
      // Outside Reddit (or on a client without expanded mode) play right here.
      showGame(root, data);
    }
  });
}
