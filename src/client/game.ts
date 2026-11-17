/** The play screen: masthead, rumor, goal, town, the cast list, and the card that coaches each move. */
import type {
  FinishRequest,
  InitResponse,
  Result,
  TileView,
  WhisperRequest,
  WhisperResponse,
} from '../shared/api.ts';
import { KIND_NAME, KIND_RULE } from '../shared/daily.ts';
import type { Kind } from '../shared/engine.ts';
import { kindGlyph, LOGO, starRow, starsFor, villagerSvg } from './art.ts';
import { showWho } from './card.ts';
import { api, journey, RequestError } from './net.ts';
import { showResult } from './result.ts';
import * as sound from './sound.ts';
import { TownView } from './town.ts';
import { showTutorial, wasTaught } from './tutorial.ts';
import { esc, storage } from './util.ts';

const SPEAKER_ON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9Z"/><path class="arc" d="M16 9c1.5 1.7 1.5 4.3 0 6M18.5 6.5c3 3.2 3 7.8 0 11"/></svg>';
const SPEAKER_OFF =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9Z"/><path class="arc" d="m16.5 9.5 5 5m0-5-5 5"/></svg>';

const KIND_ORDER: Kind[] = ['whisperer', 'gossip', 'crier', 'skeptic', 'penpal', 'shy'];
const STAR_WORDS = ['', 'one star', 'two stars', 'three stars'];

export function showGame(root: HTMLElement, data: InitResponse): void {
  const town = new TownView(data);
  const guestKey = `psst:town:${data.day}`;
  let whispers = data.user ? data.whispers.slice() : (storage.get<number[]>(guestKey) ?? []);
  let result: Result | undefined = data.result;
  let pending: Promise<WhisperResponse | null> = Promise.resolve(null);

  const kinds = KIND_ORDER.filter((kind) => data.tiles.some((t) => t?.kind === kind));
  const headcount = (kind: Kind): number => data.tiles.filter((t) => t?.kind === kind).length;

  root.className = 'screen game';
  root.innerHTML = `
    <header class="bar">
      <div class="brand">${LOGO}<b>Psst!</b><span>No. ${data.day} · ${esc(data.difficulty)}</span></div>
      <div class="tools">
        <span class="tally" aria-live="polite"><b id="used">0</b> <span id="usedWord">whispers</span></span>
        <button class="icon" id="help" type="button" aria-label="How to play"><b>?</b></button>
        <button class="icon" id="mute" type="button"></button>
      </div>
    </header>
    <p class="rumor"><span>Psst…</span> ${esc(data.rumor.charAt(0).toLowerCase() + data.rumor.slice(1))}.</p>
    <div class="meter" role="img" id="meter"><span class="stars" id="stars"></span><i></i><b id="meterText"></b></div>
    <div class="stage"><div class="fit" id="fit"></div></div>
    <div class="cast" id="cast" role="group" aria-label="Who lives in this town">${kinds
      .map(
        (kind) =>
          `<button class="chip ${kind}" type="button" data-kind="${kind}" aria-pressed="false"><i>${kindGlyph(kind)}</i>${KIND_NAME[kind]}<em>${headcount(kind)}</em></button>`,
      )
      .join('')}</div>
    <footer class="card" id="card" aria-live="polite"></footer>`;

  const $ = <T extends HTMLElement>(selector: string) => root.querySelector(selector) as T;
  const fit = $('#fit');
  const stage = $('.stage');
  const card = $('#card');
  const meter = $('#meter');
  const meterText = $('#meterText');
  const starBox = $('#stars');
  const used = $('#used');
  const usedWord = $('#usedWord');
  const mute = $<HTMLButtonElement>('#mute');
  const chips = [...root.querySelectorAll<HTMLButtonElement>('.chip')];
  fit.append(town.el);

  const resize = () => {
    const tile = Math.floor(Math.min(stage.clientWidth / data.w, stage.clientHeight / data.h, 92));
    town.el.style.setProperty('--tile', `${Math.max(tile, 30)}px`);
  };
  new ResizeObserver(resize).observe(stage);
  resize();

  const paintMute = () => {
    mute.innerHTML = sound.isMuted() ? SPEAKER_OFF : SPEAKER_ON;
    mute.setAttribute('aria-label', sound.isMuted() ? 'Turn sound on' : 'Turn sound off');
    mute.setAttribute('aria-pressed', String(sound.isMuted()));
  };
  mute.addEventListener('click', () => {
    sound.setMuted(!sound.isMuted());
    sound.wake();
    paintMute();
    journey.interaction('sound', sound.isMuted() ? 'off' : 'on');
  });
  paintMute();

  $('#help').addEventListener('click', () => {
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.innerHTML = `
      <div class="sheet-in" role="dialog" aria-label="How to play">
        <h2>How to play</h2>
        <ol class="steps">
          <li><b>1</b><span>Tap a villager to see who they would tell.</span></li>
          <li><b>2</b><span>Whisper, and the rumor runs along the arrows.</span></li>
          <li><b>3</b><span>Reach the whole town. Doing it in one whisper earns <span class="stars">${starRow(3)}</span></span></li>
        </ol>
        <h3>Who’s who in town</h3>
        <ul class="legend">${kinds
          .map((kind) => {
            const sample = data.tiles.find((t) => t?.kind === kind) as TileView;
            return `<li><span class="tile folk ${kind}">${villagerSvg({ ...sample, dir: 1 }, 0)}</span><div><b>${KIND_NAME[kind]}</b><p>${KIND_RULE[kind]}</p></div></li>`;
          })
          .join('')}</ul>
        <p class="note">Trees are just trees. A town crier cannot shout past one.</p>
        <div class="stack"><button class="ghost" id="replay" type="button">Play the lesson</button><button class="go" type="button">Got it</button></div>
      </div>`;
    sheet.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('#replay')) {
        sheet.remove();
        showTutorial(root, () => undefined);
      } else if (target === sheet || target.closest('.go')) {
        sheet.remove();
      }
    });
    root.append(sheet);
    journey.interaction('help');
  });

  /** Stars still on offer: a solved town shows what was earned, an open one what the next whisper could earn. */
  let shown = -1;
  const paintStars = (animate: boolean) => {
    const lit = starsFor(result || town.known === town.total ? whispers.length : whispers.length + 1);
    if (lit === shown) return;
    const lost = animate && shown > lit;
    shown = lit;
    starBox.innerHTML = starRow(lit);
    starBox.setAttribute('aria-label', `${STAR_WORDS[lit]} ${result ? 'earned' : 'still possible'}`);
    if (lost) {
      starBox.children[lit]?.classList.add('lost');
      sound.starLost();
    }
  };

  const count = (known: number) => {
    used.textContent = String(whispers.length);
    usedWord.textContent = whispers.length === 1 ? 'whisper' : 'whispers';
    meter.style.setProperty('--known', String(known / town.total));
    meter.setAttribute('aria-label', `${known} of ${town.total} villagers know`);
    meterText.textContent = `${known} of ${town.total} know`;
  };

  const unpick = () => chips.forEach((chip) => chip.setAttribute('aria-pressed', 'false'));

  const idle = (): void => {
    const known = town.known;
    let title: string;
    let text: string;
    if (!whispers.length) {
      title = 'Who should hear it first?';
      text = `Tap a villager to see who they would tell. One perfect whisper reaches all ${town.total}.`;
    } else {
      const left = town.total - known;
      title = `It fizzled out at ${known} of ${town.total}.`;
      text =
        left === 1
          ? 'Just one villager has not heard. Whisper to them.'
          : `${left} villagers have not heard. Whisper to one of them.`;
    }
    card.innerHTML = `<div class="hint"><h2>${title}</h2><p>${text}</p></div>`;
  };

  chips.forEach((chip) =>
    chip.addEventListener('click', () => {
      if (town.busy) return;
      const kind = chip.dataset.kind as Kind;
      const on = chip.getAttribute('aria-pressed') === 'true';
      town.select(null);
      unpick();
      if (on) return;
      chip.setAttribute('aria-pressed', 'true');
      town.spotlight(kind);
      sound.wake();
      sound.tap();
      const n = headcount(kind);
      card.innerHTML = `
        <div class="who">
          <h2><span class="kind ${kind}">${kindGlyph(kind)}${KIND_NAME[kind]}</span></h2>
          <p>${KIND_RULE[kind]}</p>
          <p class="tells">${n} in town today, hopping now.</p>
        </div>`;
      journey.interaction('legend', kind);
    }),
  );

  town.onSelect = (index) => {
    if (town.busy) return;
    // The first villager a player taps is the moment they start playing.
    if (index !== null && !result && !journey.active()) journey.start();
    if (index !== null) unpick();
    if (index === null) idle();
    else showWho(card, town, index, () => void whisperTo(index));
  };

  const finish = async (): Promise<void> => {
    town.celebrate();
    sound.bells();
    const perfect = whispers.length === 1;
    town.banner(perfect ? 'Perfect!' : 'Everyone knows', perfect ? 'one whisper' : `${whispers.length} whispers`, 'win');
    card.innerHTML = `<div class="hint"><h2>The whole town knows!</h2><p>Stopping the presses…</p></div>`;
    try {
      if (data.user) {
        const saved = await pending;
        result = saved?.result ?? result;
        // The save can lag behind the animation; ask once more if it did.
        if (!result) result = (await api<InitResponse>('/api/init')).result;
      } else {
        const body: FinishRequest = { day: data.day, whispers };
        result = await api<Result>('/api/finish', body);
      }
    } catch (error) {
      card.innerHTML = `<div class="hint"><h2>Solved, but not saved.</h2><p>${esc((error as Error).message)}</p></div>`;
      return;
    }
    if (!result) return;
    journey.end(result.whispers === 1, Math.max(0, 6 - result.whispers));
    setTimeout(() => showResult(root, data, result as Result, town, whispers), 1500);
  };

  const whisperTo = async (index: number): Promise<void> => {
    if (town.busy || town.state.knows[index]) return;
    sound.wake();
    whispers.push(index);
    if (data.user) {
      const body: WhisperRequest = { day: data.day, index };
      pending = pending.then(() =>
        api<WhisperResponse>('/api/whisper', body).catch((error: unknown) => {
          // A whisper the server never heard would be lost on reload; say so.
          if (!(error instanceof RequestError) || error.status >= 500) throw error;
          return null;
        }),
      );
      pending.catch(() => undefined);
    } else {
      storage.set(guestKey, whispers);
    }
    card.innerHTML = `<div class="hint"><h2>Psst, psst, psst…</h2><p>Tap the town to hurry it along.</p></div>`;
    await town.play(index, count);
    const known = town.known;
    journey.progress(known / town.total, 'whisper');
    if (known === town.total) {
      paintStars(false);
      await finish();
    } else {
      sound.fizzle();
      const left = town.total - known;
      town.banner(`${known} of ${town.total}`, left <= 3 ? `so close: ${left} to go` : `${left} to go`, 'miss');
      town.markLeft();
      paintStars(true);
      idle();
    }
  };

  town.restore(whispers);
  count(town.known);
  paintStars(false);
  idle();
  if (!result && whispers.length && town.known < town.total) town.markLeft();
  // The clock runs from the moment the town is on screen.
  if (data.user && !result) void api('/api/start', { day: data.day }).catch(() => undefined);

  const welcome = (): void => {
    if (whispers.length || result) return;
    // Point a newcomer at someone whose preview explains the game on its own.
    const example = data.tiles.findIndex((t) => t?.kind === 'gossip');
    town.nudge(example >= 0 ? example : data.tiles.findIndex((t) => t !== null));
  };

  if (result) {
    showResult(root, data, result, town, whispers);
  } else if (town.known === town.total && whispers.length) {
    void finish();
  } else if (!whispers.length && !wasTaught() && data.stats.solved === 0) {
    // Someone who has never solved a town learns by playing two tiny ones first.
    showTutorial(root, welcome);
  } else {
    welcome();
  }
}
