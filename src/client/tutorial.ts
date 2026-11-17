/**
 * Two tiny practice towns that teach the game by playing it: first that a rumor
 * follows the arrows, then that the puzzle is choosing who hears it first.
 */
import type { TileView } from '../shared/api.ts';
import type { Dir, Kind } from '../shared/engine.ts';
import { LOGO, starRow, starsFor } from './art.ts';
import { showWho } from './card.ts';
import { journey } from './net.ts';
import * as sound from './sound.ts';
import { TownView, type TownData } from './town.ts';
import { storage } from './util.ts';

const TAUGHT = 'psst:taught';

export const wasTaught = (): boolean => Boolean(storage.get<number>(TAUGHT));

interface Lesson {
  town: TownData;
  title: string;
  intro: string;
  /** The villager to point a newcomer at. */
  start: number;
  /** Said when a whisper stops short. */
  fizzled: string;
}

const folk = (kind: Kind, dir: Dir, name: string, look: number): TileView => ({ kind, dir, name, look });

const LESSONS: Lesson[] = [
  {
    town: {
      w: 4,
      h: 1,
      tiles: [
        folk('whisperer', 1, 'Mabel', 1),
        folk('whisperer', 1, 'Otis', 0),
        folk('whisperer', 1, 'Agnes', 5),
        folk('shy', 1, 'Gus', 3),
      ],
    },
    title: 'A rumor follows the arrows',
    intro: 'Every villager passes it on to whoever their arrow points at. Tap <b>Mabel</b>, then <b>Whisper</b>.',
    start: 0,
    fizzled: 'It never went backwards, so someone missed out. Whisper again to anyone who has not heard.',
  },
  {
    town: {
      w: 3,
      h: 3,
      tiles: [
        folk('whisperer', 1, 'Pearl', 2),
        folk('whisperer', 2, 'Hugo', 0),
        folk('shy', 0, 'Dot', 4),
        folk('whisperer', 2, 'Silas', 6),
        folk('gossip', 0, 'Winnie', 0),
        folk('whisperer', 0, 'Clem', 3),
        folk('whisperer', 1, 'Nell', 1),
        folk('whisperer', 1, 'Ira', 4),
        folk('whisperer', 0, 'Maud', 5),
      ],
    },
    title: 'Now pick who hears it first',
    intro: 'Coloured villagers are special: tap one to see what they do. <b>One</b> whisper can reach all nine. Whose?',
    start: -1,
    fizzled: 'Not everyone heard. You can whisper again, but every extra whisper costs a star.',
  },
];

/** Runs the practice towns over `root`, then calls `done`. */
export function showTutorial(root: HTMLElement, done: () => void): void {
  const layer = document.createElement('section');
  layer.className = 'lesson';
  // The daily town waits underneath, out of reach of taps and screen readers.
  const beneath = [...root.children] as HTMLElement[];
  beneath.forEach((el) => (el.inert = true));
  root.append(layer);
  journey.interaction('tutorial', 'open');

  const leave = (how: 'done' | 'skip'): void => {
    storage.set(TAUGHT, 1);
    journey.interaction('tutorial', how);
    beneath.forEach((el) => (el.inert = false));
    layer.remove();
    done();
  };

  const run = (at: number): void => {
    const lesson = LESSONS[at] as Lesson;
    const last = at === LESSONS.length - 1;
    const town = new TownView(lesson.town);
    let used = 0;

    layer.innerHTML = `
      <header class="bar">
        <div class="brand">${LOGO}<b>Psst!</b><span>How to play · ${at + 1} of ${LESSONS.length}</span></div>
        <button class="ghost" id="skip" type="button">Skip</button>
      </header>
      <div class="teach">
        <h1>${lesson.title}</h1>
        <p>${lesson.intro}</p>
      </div>
      <div class="meter" id="meter" role="img"><span class="stars" id="stars">${starRow(3)}</span><i></i><b id="meterText"></b></div>
      <div class="stage"><div class="fit" id="fit"></div></div>
      <footer class="card" id="card" aria-live="polite"></footer>`;

    const $ = <T extends HTMLElement>(selector: string) => layer.querySelector(selector) as T;
    const stage = $('.stage');
    const card = $('#card');
    const meter = $('#meter');
    $('#fit').append(town.el);
    $('#skip').addEventListener('click', () => leave('skip'));

    const resize = () => {
      const tile = Math.floor(Math.min(stage.clientWidth / lesson.town.w, stage.clientHeight / lesson.town.h, 104));
      town.el.style.setProperty('--tile', `${Math.max(tile, 30)}px`);
    };
    new ResizeObserver(resize).observe(stage);
    resize();

    const count = (known: number) => {
      meter.style.setProperty('--known', String(known / town.total));
      meter.setAttribute('aria-label', `${known} of ${town.total} villagers know`);
      $('#meterText').textContent = `${known} of ${town.total} know`;
    };
    const stars = (lit: number) => {
      $('#stars').innerHTML = starRow(lit);
    };

    const hint = (title: string, text: string, buttons = ''): void => {
      // With buttons the card stacks: words on top, the choices in a row beneath.
      card.classList.toggle('stacked', Boolean(buttons));
      card.innerHTML = `<div class="hint"><h2>${title}</h2><p>${text}</p></div>${buttons}`;
    };

    const idle = (): void => {
      if (!used) hint('Your turn', 'Tap a villager. The yellow path shows who they would tell.');
      else hint(`It stopped at ${town.known} of ${town.total}`, lesson.fizzled);
    };

    const solved = (): void => {
      town.celebrate();
      sound.bells();
      const perfect = used === 1;
      town.banner(perfect ? 'Perfect!' : 'Everyone knows', perfect ? 'one whisper' : `${used} whispers`, 'win');
      const next = last ? 'Play today’s town' : 'Next';
      const retry = perfect ? '' : '<button class="ghost" id="again" type="button">Try again</button>';
      hint(
        perfect ? 'A perfect whisper!' : `Done in ${used} whispers`,
        perfect
          ? last
            ? 'That is the whole game. A new town opens every day.'
            : 'One whisper, three stars. Not every town is this easy.'
          : 'There is always one whisper that reaches everybody. Fewer whispers, more stars.',
        `<div class="stack">${retry}<button class="go" id="next" type="button">${next}</button></div>`,
      );
      card.querySelector('#again')?.addEventListener('click', () => run(at));
      card.querySelector('#next')?.addEventListener('click', () => (last ? leave('done') : run(at + 1)));
    };

    const whisperTo = async (index: number): Promise<void> => {
      if (town.busy || town.state.knows[index]) return;
      sound.wake();
      used++;
      hint('Psst, psst, psst…', 'Watch it travel.');
      await town.play(index, count);
      if (town.known === town.total) {
        stars(starsFor(used));
        solved();
        return;
      }
      sound.fizzle();
      stars(starsFor(used + 1));
      town.markLeft();
      idle();
    };

    town.onSelect = (index) => {
      if (town.busy || town.known === town.total) return;
      if (index === null) {
        idle();
        return;
      }
      card.classList.remove('stacked');
      showWho(card, town, index, () => void whisperTo(index));
    };

    count(0);
    idle();
    if (lesson.start >= 0) town.nudge(lesson.start);
  };

  run(0);
}
