/** The front page of The Daily Whisper: one card with the score, the crowd, and what to do next. */
import { canRunAsUser, navigateTo, showLoginPrompt } from '@devvit/web/client';

import type { InitResponse, LeaderboardResponse, Result, Vote, VoteRequest } from '../shared/api.ts';
import { api, journey } from './net.ts';
import type { TownView } from './town.ts';
import { clock, countdown, effect, esc, toast } from './util.ts';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function showResult(
  root: HTMLElement,
  data: InitResponse,
  result: Result,
  town: TownView,
  whispers: readonly number[],
): void {
  root.querySelector('.page')?.remove();
  town.reveal(result.perfect, result.crowd.first);
  const loggedIn = Boolean(data.user);
  const isToday = data.day === data.today;
  const { crowd, stats } = result;
  const mine = Math.min(result.whispers, 5) - 1;
  const tallest = Math.max(1, ...crowd.spread);
  const opened = Date.now();

  const share = crowd.solved ? Math.round(((crowd.spread[0] ?? 0) / crowd.solved) * 100) : 0;
  const folk = `${crowd.solved} ${crowd.solved === 1 ? 'villager' : 'villagers'}`;
  const standing =
    crowd.solved < 2
      ? loggedIn
        ? 'You are the first to crack this town.'
        : 'Nobody has cracked this town yet.'
      : loggedIn && result.whispers > 1 && crowd.beat >= 50
        ? `You beat ${crowd.beat}% of ${folk}.`
        : `${share}% of ${folk} found the perfect whisper.`;
  const aside = result.cast
    ? 'You have a place in tomorrow’s town.'
    : !loggedIn
      ? 'Streaks, and a place in tomorrow’s town, need a Reddit account.'
      : isToday
        ? ''
        : 'An older town: streaks only grow on today’s.';

  const page = document.createElement('section');
  page.className = 'page';
  page.innerHTML = `
    <div class="paper">
      <header class="mast">
        <span>No. ${data.day}</span><b>The Daily Whisper</b><span>${esc(data.label.split(',')[1]?.trim() ?? data.label)}</span>
      </header>
      <div class="lead">
        <div class="stamp${result.whispers === 1 ? ' gold' : ''}"><b>${result.whispers}</b>${result.whispers === 1 ? 'whisper' : 'whispers'}</div>
        <div>
          <p class="kicker">${esc(result.title)}${result.seconds ? ` · ${clock(result.seconds)}` : ''}</p>
          <h1>Whole town knows: ${esc(data.rumor.charAt(0).toLowerCase() + data.rumor.slice(1))}</h1>
        </div>
      </div>
      <div class="cols">
        <div class="col">
          <h3>Your record</h3>
          ${
            loggedIn
              ? `<dl class="stats"><div><dt>Streak</dt><dd>${stats.streak}</dd></div><div><dt>Best</dt><dd>${stats.best}</dd></div><div><dt>Perfect</dt><dd>${stats.perfects}</dd></div></dl>`
              : `<button class="link" id="login" type="button">Log in to keep score</button>`
          }
          <p class="note">${aside}</p>
        </div>
        <div class="col">
          <h3>How the town did</h3>
          <ol class="bars" aria-label="Whispers needed by other players">
            ${crowd.spread
              .map(
                (n, i) =>
                  `<li class="${i === mine ? 'mine' : ''}" style="--h:${Math.round((n / tallest) * 100)}%" aria-label="${i === 4 ? '5 or more' : i + 1} whispers: ${n}"><i></i><span>${i === 4 ? '5+' : i + 1}</span></li>`,
              )
              .join('')}
          </ol>
          <p class="note">${standing}</p>
        </div>
      </div>
      <div class="vote" id="vote"></div>
      ${
        result.top.length
          ? `<div class="top3"><h3>Today’s best whisperers</h3><ol class="ranks">${result.top
              .map(
                (row, i) =>
                  `<li class="${row.me ? 'me' : ''}"><span>${i + 1}</span><b>u/${esc(row.name)}</b><em>${plural(row.whispers, 'whisper')} · ${clock(row.seconds)}</em></li>`,
              )
              .join('')}</ol></div>`
          : ''
      }
      <div class="acts">
        <button class="go" id="primary" type="button"></button>
        <button class="ghost" id="seeTown" type="button">See the town</button>
        <button class="ghost" id="ranks" type="button">Top whisperers</button>
      </div>
      <p class="next" id="next"></p>
    </div>`;
  root.append(page);

  const $ = <T extends HTMLElement>(selector: string) => page.querySelector(selector) as T;

  const next = $('#next');
  const tick = () => {
    const left = data.msToNext - (Date.now() - opened);
    next.textContent = left > 0 ? `Next rumor in ${countdown(left)}` : 'A new rumor is out. Refresh to hear it.';
  };
  tick();
  const timer = setInterval(() => (page.isConnected ? tick() : clearInterval(timer)), 1000);

  const paintVote = (vote: Vote) => {
    const total = vote.counts.reduce((a, b) => a + b, 0);
    const box = $('#vote');
    box.innerHTML =
      `<h3>Tomorrow’s rumor: the town decides</h3>` +
      vote.choices
        .map((choice, i) => {
          const share = total ? Math.round(((vote.counts[i] ?? 0) / total) * 100) : 0;
          const shown = vote.mine !== null;
          return `<button type="button" class="pick${vote.mine === i ? ' on' : ''}" data-i="${i}" style="--share:${shown ? share : 0}%" aria-pressed="${vote.mine === i}"><span>${esc(choice)}</span>${shown ? `<b>${share}%</b>` : ''}</button>`;
        })
        .join('');
    box.querySelectorAll<HTMLButtonElement>('.pick').forEach((button) =>
      button.addEventListener('click', async () => {
        if (!loggedIn) {
          if (!effect(() => showLoginPrompt())) toast('Log in to vote.');
          return;
        }
        try {
          const body: VoteRequest = { day: vote.day, choice: Number(button.dataset.i) };
          paintVote(await api<Vote>('/api/vote', body));
          journey.interaction('vote');
        } catch (error) {
          toast((error as Error).message);
        }
      }),
    );
  };
  paintVote(result.vote);

  const primary = $<HTMLButtonElement>('#primary');
  if (!isToday && data.todayPost) {
    primary.textContent = 'Play today’s town';
    primary.addEventListener('click', () => effect(() => navigateTo(`https://www.reddit.com/comments/${data.todayPost?.replace(/^t3_/, '')}`)));
  } else if (!loggedIn) {
    primary.textContent = 'Log in to join the town';
    primary.addEventListener('click', () => {
      if (!effect(() => showLoginPrompt())) toast('Open this post on Reddit to log in.');
    });
  } else {
    primary.textContent = 'Tell the comments';
    primary.addEventListener('click', async (event) => {
      primary.disabled = true;
      try {
        const asUser = await canRunAsUser(event).catch(() => false);
        await api('/api/comment', { day: data.day, asUser });
        primary.textContent = 'Posted to the comments';
        journey.interaction('comment');
      } catch (error) {
        toast((error as Error).message);
        primary.textContent = 'Already in the comments';
      }
    });
  }
  $('#login')?.addEventListener('click', () => {
    if (!effect(() => showLoginPrompt())) toast('Open this post on Reddit to log in.');
  });

  const card = root.querySelector('#card') as HTMLElement;
  $('#seeTown').addEventListener('click', () => {
    page.hidden = true;
    const firsts = Object.keys(crowd.first).length > 0;
    card.innerHTML = `
      <div class="hint"><h2>Solved in ${plural(whispers.length, 'whisper')}</h2>
      <p>The crown marks the perfect whisper.${firsts ? ' Numbers show where others whispered first.' : ''}</p></div>
      <button class="go" id="back" type="button">Front page</button>`;
    town.onSelect = () => undefined;
    card.querySelector('#back')?.addEventListener('click', () => (page.hidden = false));
    journey.interaction('see_town');
  });

  $('#ranks').addEventListener('click', async () => {
    try {
      const board = await api<LeaderboardResponse>(`/api/leaderboard?day=${data.day}`);
      showRanks(page, board);
      journey.interaction('leaderboard');
    } catch (error) {
      toast((error as Error).message);
    }
  });
}

function showRanks(page: HTMLElement, board: LeaderboardResponse): void {
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  const rows = board.today.length
    ? board.today
        .map(
          (row, i) =>
            `<li class="${row.me ? 'me' : ''}"><span>${i + 1}</span><b>u/${esc(row.name)}</b><em>${row.whispers} · ${clock(row.seconds)}</em></li>`,
        )
        .join('')
    : '<li class="empty">Nobody yet. Log in and be the first.</li>';
  const streaks = board.streaks
    .slice(0, 5)
    .map((row) => `<li class="${row.me ? 'me' : ''}"><b>u/${esc(row.name)}</b><em>${row.streak} days</em></li>`)
    .join('');
  sheet.innerHTML = `
    <div class="sheet-in" role="dialog" aria-label="Top whisperers">
      <h2>Top whisperers</h2>
      <p class="note">Fewest whispers first, then fastest.</p>
      <ol class="ranks">${rows}</ol>
      ${streaks ? `<h3>Longest streaks</h3><ol class="ranks plain">${streaks}</ol>` : ''}
      <button class="go" type="button">Close</button>
    </div>`;
  sheet.addEventListener('click', (event) => {
    if (event.target === sheet || (event.target as HTMLElement).closest('.go')) sheet.remove();
  });
  page.append(sheet);
}
