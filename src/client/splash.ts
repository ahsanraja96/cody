/** What a redditor sees in their feed: the rumor, a little demo of it travelling, and one button. */
import { requestExpandedMode } from '@devvit/web/client';

import type { InitResponse, TileView } from '../shared/api.ts';
import { LOGO, villagerSvg } from './art.ts';
import { showGame } from './game.ts';
import { journey } from './net.ts';
import * as sound from './sound.ts';
import { countdown, esc } from './util.ts';

/** Passes the rumor down the row of villagers, over and over, so the idea lands before a single tap. */
function demo(crowd: HTMLElement): void {
  const folk = [...crowd.querySelectorAll<HTMLElement>('.tile')];
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    folk.forEach((el) => el.classList.add('knows'));
    return;
  }
  let at = 0;
  const step = (): void => {
    if (!crowd.isConnected) return;
    if (at >= folk.length) {
      at = 0;
      folk.forEach((el) => el.classList.remove('knows', 'pop'));
      setTimeout(step, 700);
      return;
    }
    const el = folk[at] as HTMLElement;
    el.classList.add('knows', 'pop');
    setTimeout(() => el.classList.remove('pop'), 420);
    at++;
    setTimeout(step, at >= folk.length ? 1700 : 520);
  };
  setTimeout(step, 600);
}

export function showSplash(root: HTMLElement, data: InitResponse): void {
  const started = data.whispers.length > 0;
  const cta = data.done ? 'See the front page' : started ? 'Keep whispering' : 'Play';
  const cast = data.tiles.filter((t): t is TileView => t !== null).slice(0, 5);
  const count = data.tiles.filter((t) => t !== null).length;
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
    <div class="crowd" id="crowd" aria-hidden="true">${cast
      .map((tile, i) => {
        // The demo cast are all plain whisperers in a row, each telling the next.
        const actor: TileView = { ...tile, kind: 'whisperer', dir: i === cast.length - 1 ? 3 : 1 };
        return `<span class="tile folk whisperer">${villagerSvg(actor, 0)}</span>`;
      })
      .join('')}</div>
    <p class="pitch">Tell <b>one</b> villager and the rumor runs along the arrows. Can a single whisper reach all <b>${count}</b>?</p>
    <button class="go big pulse" id="play" type="button">${cta}</button>
    <p class="status">${data.stats.streak > 0 ? `<b>${data.stats.streak}-day streak</b> · ` : ''}${esc(status)}</p>`;

  demo(root.querySelector('#crowd') as HTMLElement);

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
