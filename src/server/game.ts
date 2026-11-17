/** Everything the server knows about a day in town. No Express, no Devvit imports. */
import type {
  Crowd,
  InitResponse,
  LeaderboardResponse,
  Result,
  Stats,
  TileView,
  Vote,
  WhisperResponse,
} from '../shared/api.ts';
import {
  capitalise,
  dayLabel,
  dayNumber,
  difficultyFor,
  looks,
  msUntilNextDay,
  rumorChoices,
  seatGuests,
  titleFor,
  townFor,
  townsfolk,
} from '../shared/daily.ts';
import { isValidWhisper, knowCount, replay, whisper } from '../shared/engine.ts';
import type { Town } from '../shared/generate.ts';
import type { Platform } from './platform.ts';

export class GameError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface Progress {
  /** Tiles whispered to, in order. */
  w: number[];
  /** When the player pressed play. */
  t0: number;
  done?: boolean;
  seconds?: number;
  commented?: boolean;
}

interface Guest {
  seat: number;
  name: string;
  avatar?: string;
}

const MAX_WHISPERS = 60;
const SCORE_STEP = 100_000;

const key = {
  progress: (day: number, user: string) => `p:${day}:${user}`,
  spread: (day: number) => `spread:${day}`,
  first: (day: number) => `first:${day}`,
  board: (day: number) => `lb:${day}`,
  players: (day: number) => `players:${day}`,
  rumor: (day: number) => `rumor:${day}`,
  votes: (day: number) => `votes:${day}`,
  voted: (day: number) => `voted:${day}`,
  cast: (day: number) => `cast:${day}`,
  post: (day: number) => `post:${day}`,
  town: (day: number) => `town:${day}`,
  user: (user: string) => `u:${user}`,
  avatars: 'avatars',
  streaks: 'streaks',
};

const num = (value: string | undefined | null): number => Number(value ?? 0) || 0;

function parse<T>(raw: string | undefined | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const towns = new Map<number, Town>();

/**
 * A day's town, generated once and then kept in Redis so that an app update
 * can never change a puzzle people are already playing.
 */
async function townOf(p: Platform, day: number): Promise<Town> {
  let town = towns.get(day);
  if (town) return town;
  town = parse<Town>(await p.redis.get(key.town(day))) ?? undefined;
  if (!town) {
    town = townFor(day);
    await p.redis.set(key.town(day), JSON.stringify(town));
  }
  if (towns.size > 8) towns.clear();
  towns.set(day, town);
  return town;
}

/** The day a post belongs to: the one stamped on it, else today. */
export function dayOfPost(p: Platform): number {
  const today = dayNumber(p.now());
  const stamped = Number(p.context().postData?.day);
  return Number.isInteger(stamped) && stamped >= 1 && stamped <= today ? stamped : today;
}

/** The winning rumor is fixed the first time anyone opens that day. */
export async function rumorFor(p: Platform, day: number): Promise<string> {
  const saved = await p.redis.get(key.rumor(day));
  if (saved) return saved;
  const choices = rumorChoices(day);
  const votes = await p.redis.hGetAll(key.votes(day));
  let winner = 0;
  choices.forEach((_, i) => {
    if (num(votes[String(i)]) > num(votes[String(winner)])) winner = i;
  });
  const rumor = choices[winner] as string;
  if (day <= dayNumber(p.now())) await p.redis.set(key.rumor(day), rumor);
  return rumor;
}

/** Yesterday's best whisperers move into today's town. */
async function castFor(p: Platform, day: number): Promise<Guest[]> {
  const saved = parse<Guest[]>(await p.redis.get(key.cast(day)));
  if (saved) return saved;
  const town = await townOf(p, day);
  const solvers = day > 1 ? await p.redis.zRange(key.board(day - 1), 0, town.villagers - 1, { by: 'rank' }) : [];
  const seats = seatGuests(day, town.board.tiles, solvers.length);
  const avatars = solvers.length ? await p.redis.hGetAll(key.avatars) : {};
  const cast = solvers.map((solver, i): Guest => {
    const avatar = avatars[solver.member];
    return { seat: seats[i] as number, name: solver.member, ...(avatar ? { avatar } : {}) };
  });
  if (day <= dayNumber(p.now())) await p.redis.set(key.cast(day), JSON.stringify(cast));
  return cast;
}

async function statsFor(p: Platform, userId: string | undefined): Promise<Stats> {
  if (!userId) return { streak: 0, best: 0, solved: 0, perfects: 0 };
  const saved = await p.redis.hGetAll(key.user(userId));
  const alive = num(saved.last) >= dayNumber(p.now()) - 1;
  return {
    streak: alive ? num(saved.streak) : 0,
    best: num(saved.best),
    solved: num(saved.solved),
    perfects: num(saved.perfects),
  };
}

async function crowdFor(p: Platform, day: number, whispers: number): Promise<Crowd> {
  const [raw, first] = await Promise.all([p.redis.hGetAll(key.spread(day)), p.redis.hGetAll(key.first(day))]);
  const spread = [1, 2, 3, 4, 5].map((n) => num(raw[String(n)]));
  const solved = spread.reduce((a, b) => a + b, 0);
  const worse = spread.slice(Math.min(whispers, 5)).reduce((a, b) => a + b, 0);
  const others = Math.max(0, solved - 1);
  return {
    spread,
    solved,
    beat: others > 0 ? Math.round((worse / others) * 100) : 0,
    first: Object.fromEntries(Object.entries(first).map(([tile, count]) => [tile, num(count)])),
  };
}

async function voteFor(p: Platform, userId: string | undefined): Promise<Vote> {
  const day = dayNumber(p.now()) + 1;
  const [votes, mine] = await Promise.all([
    p.redis.hGetAll(key.votes(day)),
    userId ? p.redis.hGet(key.voted(day), userId) : Promise.resolve(undefined),
  ]);
  const choices = rumorChoices(day).map(capitalise);
  return {
    day,
    choices,
    counts: choices.map((_, i) => num(votes[String(i)])),
    mine: mine === undefined || mine === null ? null : num(mine),
  };
}

async function resultFor(
  p: Platform,
  day: number,
  userId: string | undefined,
  whispers: number,
  seconds: number,
): Promise<Result> {
  const [stats, crowd, vote, board] = await Promise.all([
    statsFor(p, userId),
    crowdFor(p, day, whispers),
    voteFor(p, userId),
    leaderboard(p, day),
  ]);
  return {
    whispers,
    seconds,
    title: titleFor(whispers),
    perfect: (await townOf(p, day)).perfect,
    stats,
    crowd,
    vote,
    cast: Boolean(userId) && day === dayNumber(p.now()),
    top: board.today.slice(0, 3),
  };
}

export async function init(p: Platform): Promise<InitResponse> {
  const { userId, subredditName } = p.context();
  const today = dayNumber(p.now());
  const day = dayOfPost(p);
  const town = await townOf(p, day);
  const [rumor, cast, saved, username, players, todayPost] = await Promise.all([
    rumorFor(p, day),
    castFor(p, day),
    userId ? p.redis.get(key.progress(day, userId)) : Promise.resolve(null),
    userId ? p.reddit.getCurrentUsername().catch(() => undefined) : Promise.resolve(undefined),
    p.redis.get(key.players(day)),
    day === today ? Promise.resolve(null) : p.redis.get(key.post(today)),
  ]);
  const progress = parse<Progress>(saved);

  let avatar: string | undefined;
  let firstTime = !userId;
  if (userId && username) {
    const profile = await p.redis.hGetAll(key.user(userId));
    firstTime = !profile.name;
    avatar = (await p.redis.hGet(key.avatars, username)) ?? undefined;
    if (!profile.name) {
      avatar = await p.reddit.getSnoovatarUrl(username).catch(() => undefined);
      await p.redis.hSet(key.user(userId), { name: username });
      if (avatar) await p.redis.hSet(key.avatars, { [username]: avatar });
    }
  }

  const names = townsfolk(day, town.board.tiles.length);
  const skins = looks(day, town.board.tiles.length);
  const guests = new Map(cast.map((guest) => [guest.seat, guest]));
  const tiles = town.board.tiles.map((tile, i): TileView | null => {
    if (!tile) return null;
    const guest = guests.get(i);
    return {
      kind: tile.kind,
      dir: tile.dir,
      ...(tile.pal === undefined ? {} : { pal: tile.pal }),
      name: guest ? `u/${guest.name}` : (names[i] as string),
      ...(guest?.avatar ? { avatar: guest.avatar } : {}),
      ...(guest ? { guest: true } : {}),
      ...(guest && guest.name === username ? { me: true } : {}),
      look: skins[i] as number,
    };
  });

  const done = Boolean(progress?.done);
  return {
    day,
    today,
    label: dayLabel(day),
    difficulty: difficultyFor(day),
    rumor: capitalise(rumor),
    subreddit: subredditName ?? '',
    user: username ? { name: username, ...(avatar ? { avatar } : {}) } : null,
    w: town.board.w,
    h: town.board.h,
    tiles,
    whispers: progress?.w ?? [],
    done,
    stats: await statsFor(p, userId),
    players: num(players),
    msToNext: msUntilNextDay(p.now()),
    ...(todayPost ? { todayPost } : {}),
    ...(done && progress
      ? { result: await resultFor(p, day, userId, progress.w.length, progress.seconds ?? 0) }
      : {}),
    firstTime,
  };
}

function checkDay(p: Platform, day: unknown): number {
  if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > dayNumber(p.now())) {
    throw new GameError('That town does not exist yet.');
  }
  return day as number;
}

/** Called when the player presses play: starts the clock and counts them in. */
export async function start(p: Platform, dayInput: unknown): Promise<void> {
  const day = checkDay(p, dayInput);
  const { userId } = p.context();
  if (!userId) return;
  const saved = await p.redis.get(key.progress(day, userId));
  if (saved) return;
  const progress: Progress = { w: [], t0: p.now() };
  await p.redis.set(key.progress(day, userId), JSON.stringify(progress));
  await p.redis.incrBy(key.players(day), 1);
}

export async function whisperTo(p: Platform, dayInput: unknown, index: unknown): Promise<WhisperResponse> {
  const day = checkDay(p, dayInput);
  const { userId } = p.context();
  if (!userId) throw new GameError('Log in to save your whispers.', 401);
  const town = await townOf(p, day);
  const saved = parse<Progress>(await p.redis.get(key.progress(day, userId)));
  const progress: Progress = saved ?? { w: [], t0: p.now() };
  if (!saved) await p.redis.incrBy(key.players(day), 1);
  if (progress.done) {
    return {
      whispers: progress.w,
      done: true,
      result: await resultFor(p, day, userId, progress.w.length, progress.seconds ?? 0),
    };
  }
  const state = replay(town.board, progress.w);
  if (progress.w.length >= MAX_WHISPERS || !isValidWhisper(town.board, state, index as number)) {
    throw new GameError('They already know.');
  }
  whisper(town.board, state, index as number);
  progress.w.push(index as number);
  const done = knowCount(state) === town.villagers;
  if (done) {
    progress.done = true;
    progress.seconds = Math.max(1, Math.min(SCORE_STEP - 1, Math.round((p.now() - progress.t0) / 1000)));
  }
  await p.redis.set(key.progress(day, userId), JSON.stringify(progress));
  if (!done) return { whispers: progress.w, done: false };
  await recordFinish(p, day, userId, progress);
  return {
    whispers: progress.w,
    done: true,
    result: await resultFor(p, day, userId, progress.w.length, progress.seconds ?? 0),
  };
}

async function recordFinish(p: Platform, day: number, userId: string, progress: Progress): Promise<void> {
  const today = dayNumber(p.now());
  const whispers = progress.w.length;
  const profile = await p.redis.hGetAll(key.user(userId));
  const name = profile.name ?? (await p.reddit.getCurrentUsername().catch(() => undefined));
  await Promise.all([
    p.redis.hIncrBy(key.spread(day), String(Math.min(whispers, 5)), 1),
    p.redis.hIncrBy(key.first(day), String(progress.w[0]), 1),
    name
      ? p.redis.zAdd(key.board(day), { member: name, score: whispers * SCORE_STEP + (progress.seconds ?? 0) })
      : Promise.resolve(),
  ]);

  const update: Record<string, string> = {
    solved: String(num(profile.solved) + 1),
    perfects: String(num(profile.perfects) + (whispers === 1 ? 1 : 0)),
    ...(name ? { name } : {}),
  };
  let streak = num(profile.last) >= today - 1 ? num(profile.streak) : 0;
  // Only today's town moves a streak; older towns are for practice.
  if (day === today && num(profile.last) !== today) {
    streak += 1;
    update.streak = String(streak);
    update.last = String(today);
    update.best = String(Math.max(num(profile.best), streak));
    if (name) await p.redis.zAdd(key.streaks, { member: name, score: streak });
  }
  await p.redis.hSet(key.user(userId), update);

  const { subredditName } = p.context();
  if (name && subredditName && day === today) {
    const perfects = num(update.perfects);
    const text = `${streak}-day streak${perfects ? ` · ${perfects} perfect` : ''}`;
    // Flair is a nicety: a community may have it switched off.
    await p.reddit.setUserFlair({ subredditName, username: name, text }).catch(() => undefined);
  }
}

/** Logged-out players keep their own progress; the server only checks the solve. */
export async function finishAsGuest(p: Platform, dayInput: unknown, whispers: unknown): Promise<Result> {
  const day = checkDay(p, dayInput);
  const town = await townOf(p, day);
  if (!Array.isArray(whispers) || whispers.length < 1 || whispers.length > MAX_WHISPERS) {
    throw new GameError('Those whispers do not add up.');
  }
  const state = replay(town.board, []);
  for (const index of whispers) {
    if (!isValidWhisper(town.board, state, index as number)) throw new GameError('Those whispers do not add up.');
    whisper(town.board, state, index as number);
  }
  if (knowCount(state) !== town.villagers) throw new GameError('The town has not all heard yet.');
  return resultFor(p, day, undefined, whispers.length, 0);
}

export async function vote(p: Platform, dayInput: unknown, choice: unknown): Promise<Vote> {
  const { userId } = p.context();
  if (!userId) throw new GameError('Log in to vote.', 401);
  const day = dayNumber(p.now()) + 1;
  if (dayInput !== day) throw new GameError('That vote has closed.');
  if (!Number.isInteger(choice) || (choice as number) < 0 || (choice as number) > 2) {
    throw new GameError('Pick one of the three rumors.');
  }
  const before = await p.redis.hGet(key.voted(day), userId);
  if (before === undefined || before === null || num(before) !== choice) {
    if (before !== undefined && before !== null) await p.redis.hIncrBy(key.votes(day), before, -1);
    await p.redis.hIncrBy(key.votes(day), String(choice), 1);
    await p.redis.hSet(key.voted(day), { [userId]: String(choice) });
  }
  return voteFor(p, userId);
}

export async function leaderboard(p: Platform, dayInput: unknown): Promise<LeaderboardResponse> {
  const day = checkDay(p, dayInput);
  const { userId } = p.context();
  const me = userId ? (await p.redis.hGet(key.user(userId), 'name')) ?? '' : '';
  const [today, streaks] = await Promise.all([
    p.redis.zRange(key.board(day), 0, 9, { by: 'rank' }),
    p.redis.zRange(key.streaks, 0, 9, { by: 'rank', reverse: true }),
  ]);
  return {
    today: today.map((row) => ({
      name: row.member,
      whispers: Math.floor(row.score / SCORE_STEP),
      seconds: row.score % SCORE_STEP,
      ...(row.member === me ? { me: true } : {}),
    })),
    streaks: streaks
      .filter((row) => row.score > 0)
      .map((row) => ({ name: row.member, streak: row.score, ...(row.member === me ? { me: true } : {}) })),
  };
}

const clock = (seconds: number): string =>
  seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;

/** The player asked to post their result under the town. One per town. */
export async function comment(p: Platform, dayInput: unknown, asUser: boolean): Promise<void> {
  const day = checkDay(p, dayInput);
  const { userId, postId } = p.context();
  if (!userId || !postId) throw new GameError('Log in to comment.', 401);
  const progress = parse<Progress>(await p.redis.get(key.progress(day, userId)));
  if (!progress?.done) throw new GameError('Finish the town first.');
  if (progress.commented) throw new GameError('You already told the comments.');
  const whispers = progress.w.length;
  const marks = '🤫' + '🗣️'.repeat(Math.min(whispers - 1, 8));
  const line =
    whispers === 1
      ? `**Perfect whisper.** One word in the right ear and the whole town knew in ${clock(progress.seconds ?? 0)}.`
      : `**${titleFor(whispers)}.** It took me ${whispers} whispers and ${clock(progress.seconds ?? 0)} to tell the whole town.`;
  // Until an app is approved, comments made for a player come from the app
  // account, so the player is named in the text.
  const name = asUser ? undefined : await p.redis.hGet(key.user(userId), 'name');
  const text = `${marks}  Psst! #${day}\n\n${name ? `u/${name}: ` : ''}${line}`;
  await p.reddit.submitComment({ id: postId, text, runAs: asUser ? 'USER' : 'APP' });
  progress.commented = true;
  await p.redis.set(key.progress(day, userId), JSON.stringify(progress));
}

export async function subscribe(p: Platform): Promise<void> {
  if (!p.context().userId) throw new GameError('Log in to join.', 401);
  await p.reddit.subscribeToCurrentSubreddit();
}

/** Opens today's town as a new post. Safe to call twice: the second call finds the first post. */
export async function openTown(p: Platform): Promise<{ id: string; created: boolean; day: number }> {
  const { subredditName } = p.context();
  if (!subredditName) throw new GameError('No community to post in.');
  const day = dayNumber(p.now());
  const existing = await p.redis.get(key.post(day));
  if (existing) return { id: existing, created: false, day };
  const rumor = capitalise(await rumorFor(p, day));
  await castFor(p, day);
  const post = await p.reddit.submitCustomPost({
    subredditName,
    title: `Psst! #${day} — ${rumor}`,
    entry: 'default',
    postData: { day },
    textFallback: {
      text: `Psst… ${rumor}. One whisper can reach the whole town. Open this post in the Reddit app or on reddit.com to find the villager who starts it.`,
    },
  });
  await p.redis.set(key.post(day), post.id);
  // A first comment gives the thread somewhere to start; the town works without it.
  await p.reddit
    .submitComment({
      id: post.id,
      text:
        `**Psst… ${rumor.charAt(0).toLowerCase()}${rumor.slice(1)}.**\n\n` +
        'Tap a villager to see who they would tell, then whisper. The fewer whispers it takes to reach the whole town, the better, and one perfect whisper always exists.\n\n' +
        'Solve it today and you move into tomorrow’s town. No spoilers below, please: brag with your whisper count instead.',
    })
    .catch(() => undefined);
  return { id: post.id, created: true, day };
}
