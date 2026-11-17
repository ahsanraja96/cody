import './style.css';

import type { InitResponse } from '../shared/api.ts';
import { showGame } from './game.ts';
import { api, journey } from './net.ts';
import { showSplash } from './splash.ts';
import { esc } from './util.ts';

const root = document.getElementById('app') as HTMLElement;

async function boot(): Promise<void> {
  try {
    const data = await api<InitResponse>('/api/init');
    if (document.body.dataset.entry === 'game') showGame(root, data);
    else showSplash(root, data);
    journey.ready();
  } catch (error) {
    root.className = 'screen splash';
    root.innerHTML = `<div class="brand big"><b>Psst!</b></div><p class="pitch">The town is still waking up. ${esc((error as Error).message)}</p><button class="go" id="retry" type="button">Try again</button>`;
    root.querySelector('#retry')?.addEventListener('click', () => void boot());
  }
}

void boot();
