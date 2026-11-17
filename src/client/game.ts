/** The play screen: masthead, rumor, town, and the card under it that doubles as the tutorial. */
import type {
  FinishRequest,
  InitResponse,
  Result,
  TileView,
  WhisperRequest,
  WhisperResponse,
} from '../shared/api.ts';
import { KIND_NAME, KIND_RULE } from '../shared/daily.ts';
import { LOGO, villagerSvg } from './art.ts';
import { api, journey, RequestError } from './net.ts';
import { showResult } from './result.ts';
import * as sound from './sound.ts';
import { TownView } from './town.ts';
import { esc, storage } from './util.ts';

const SPEAKER_ON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9Z"/><path class="arc" d="M16 9c1.5 1.7 1.5 4.3 0 6M18.5 6.5c3 3.2 3 7.8 0 11"/></svg>';
const SPEAKER_OFF =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9Z"/><path class="arc" d="m16.5 9.5 5 5m0-5-5 5"/></svg>';

export function showGame(root: HTMLElement, data: InitResponse): void {
  const town = new TownView(data);
  const guestKey = `psst:town:${data.day}`;
  let whispers = data.user ? data.whispers.slice() : (storage.get<number[]>(guestKey) ?? []);
  let result: Result | undefined = data.result;
  let pending: Promise<WhisperResponse | null> = Promise.resolve(null);

  root.className = 'screen game';
  root.innerHTML = `
    <header class="bar">
      <div class="brand">${LOGO}<b>Psst!</b><span>No. ${data.day} · ${esc(data.difficulty)}</span></div>
      <div class="tools">
        <span class="tally" aria-live="polite"><b id="used">0</b> <span id="usedWord">whispers</span></span>
        <button class="icon" id="help" type="button" aria-label="Who is who"><b>?</b></button>
        <button class="icon" id="mute" type="button"></button>
      </div>
    </header>
    <p class="rumor"><span>Psst…</span> ${esc(data.rumor.charAt(0).toLowerCase() + data.rumor.slice(1))}.</p>
    <div class="stage"><div class="fit" id="fit"></div></div>
    <div class="meter" role="img" id="meter"><i></i></div>
    <footer class="card" id="card" aria-live="polite"></footer>`;

  const fit = root.querySelector('#fit') as HTMLElement;
  const stage = root.querySelector('.stage') as HTMLElement;
  const card = root.querySelector('#card') as HTMLElement;
  const meter = root.querySelector('#meter') as HTMLElement;
  const used = root.querySelector('#used') as HTMLElement;
  const usedWord = root.querySelector('#usedWord') as HTMLElement;
  const mute = root.querySelector('#mute') as HTMLButtonElement;
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

  (root.querySelector('#help') as HTMLButtonElement).addEventListener('click', () => {
    const kinds = [...new Set(data.tiles.flatMap((t) => (t ? [t.kind] : [])))];
    const order = ['whisperer', 'gossip', 'crier', 'skeptic', 'penpal', 'shy'];
    kinds.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.innerHTML = `
      <div class="sheet-in" role="dialog" aria-label="Who is who">
        <h2>Who’s who in town</h2>
        <ul class="legend">${kinds
          .map((kind) => {
            const sample = data.tiles.find((t) => t?.kind === kind) as TileView;
            return `<li><span class="tile folk ${kind}">${villagerSvg({ ...sample, dir: 1 }, 0)}</span><div><b>${KIND_NAME[kind]}</b><p>${KIND_RULE[kind]}</p></div></li>`;
          })
          .join('')}</ul>
        <p class="note">Arrows show who each villager tells. Trees are just trees.</p>
        <button class="go" type="button">Got it</button>
      </div>`;
    sheet.addEventListener('click', (event) => {
      if (event.target === sheet || (event.target as HTMLElement).closest('.go')) sheet.remove();
    });
    root.append(sheet);
    journey.interaction('help');
  });

  const count = (known: number) => {
    used.textContent = String(whispers.length);
    usedWord.textContent = whispers.length === 1 ? 'whisper' : 'whispers';
    meter.style.setProperty('--known', String(known / town.total));
    meter.setAttribute('aria-label', `${known} of ${town.total} villagers know`);
    meter.dataset.text = `${known} of ${town.total} know`;
  };

  const idle = (): void => {
    const known = town.known;
    let title: string;
    let text: string;
    if (!whispers.length) {
      title = 'Who should hear it first?';
      text = 'Tap a villager to see who they would tell. One perfect whisper reaches the whole town.';
    } else {
      title = `It fizzled out at ${known} of ${town.total}.`;
      text = 'Whisper to someone who has not heard. Fewer whispers is better.';
    }
    card.innerHTML = `<div class="hint"><h2>${title}</h2><p>${text}</p></div>`;
  };

  const inspect = (index: number): void => {
    const tile = town.tile(index);
    const knows = Boolean(town.state.knows[index]);
    const halfway = !knows && tile.kind === 'skeptic' && (town.state.heard[index] ?? 0) > 0;
    card.innerHTML = `
      <div class="who">
        <h2>${esc(tile.name)}${tile.me ? ' <em>that’s you</em>' : ''} <span class="kind">${KIND_NAME[tile.kind]}</span></h2>
        <p>${KIND_RULE[tile.kind]}${halfway ? ' <b>Heard it once so far.</b>' : ''}</p>
      </div>
      <button class="go" id="go" type="button" ${knows ? 'disabled' : ''}>${knows ? 'Already knows' : 'Whisper'}</button>`;
    card.querySelector('#go')?.addEventListener('click', () => void whisperTo(index));
  };

  town.onSelect = (index) => {
    if (town.busy) return;
    // The first villager a player taps is the moment they start playing.
    if (index !== null && !result && !journey.active()) journey.start();
    if (index === null) idle();
    else inspect(index);
  };

  const finish = async (): Promise<void> => {
    town.celebrate();
    sound.bells();
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
    setTimeout(() => showResult(root, data, result as Result, town, whispers), 900);
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
      await finish();
    } else {
      sound.fizzle();
      idle();
    }
  };

  town.restore(whispers);
  count(town.known);
  idle();
  // The clock runs from the moment the town is on screen.
  if (data.user && !result) void api('/api/start', { day: data.day }).catch(() => undefined);
  if (!whispers.length && !result) {
    // Point a newcomer at someone whose preview explains the game on its own.
    const example = data.tiles.findIndex((t) => t?.kind === 'gossip');
    town.nudge(example >= 0 ? example : data.tiles.findIndex((t) => t !== null));
  }
  if (result) {
    showResult(root, data, result, town, whispers);
  } else if (town.known === town.total && whispers.length) {
    void finish();
  }
}
