import { describe, expect, it } from 'vitest';

import * as game from '../src/server/game.ts';
import { dayStart, rumorChoices, townFor } from '../src/shared/daily.ts';
import { createMemoryWorld } from '../tools/memory.ts';

function setup(day = 3) {
  const world = createMemoryWorld(dayStart(day) + 3_600_000);
  world.usernames.set('t2_ann', 'ann').set('t2_bob', 'bob');
  const as = (user: string | undefined, postDay = day) =>
    world.as({ userId: user, postId: 't3_post', subredditName: 'psst', postData: { day: postDay } });
  return { world, as, p: world.platform };
}

const wrongTile = (day: number) => {
  const town = townFor(day);
  return town.board.tiles.findIndex((t, i) => t && t.kind !== 'shy' && !town.perfect.includes(i));
};

describe('a day in town', () => {
  it('serves the board without giving the answer away', async () => {
    const { p, as } = setup();
    as('t2_ann');
    const view = await game.init(p);
    expect(view.day).toBe(3);
    expect(view.tiles.filter(Boolean).length).toBe(townFor(3).villagers);
    expect(view.result).toBeUndefined();
    expect(view.firstTime).toBe(true);
    expect(JSON.stringify(view)).not.toContain('"perfect":');
    expect((await game.init(p)).firstTime).toBe(false);
  });

  it('scores a perfect whisper, starts a streak and sets flair', async () => {
    const { p, as, world } = setup();
    as('t2_ann');
    await game.start(p, 3);
    const done = await game.whisperTo(p, 3, townFor(3).perfect[0]);
    expect(done.done).toBe(true);
    expect(done.result?.whispers).toBe(1);
    expect(done.result?.title).toBe('Perfect whisper');
    expect(done.result?.stats).toMatchObject({ streak: 1, best: 1, solved: 1, perfects: 1 });
    expect(done.result?.crowd.spread).toEqual([1, 0, 0, 0, 0]);
    expect(world.flair.get('ann')).toBe('1-day streak · 1 perfect');
    const again = await game.init(p);
    expect(again.done).toBe(true);
    expect(again.result?.whispers).toBe(1);
  });

  it('keeps going after a whisper that fizzles and rejects repeats', async () => {
    const { p, as } = setup();
    as('t2_bob');
    const miss = wrongTile(3);
    const first = await game.whisperTo(p, 3, miss);
    expect(first.done).toBe(false);
    await expect(game.whisperTo(p, 3, miss)).rejects.toThrow('They already know');
    await expect(game.whisperTo(p, 3, 999)).rejects.toThrow();
    const second = await game.whisperTo(p, 3, townFor(3).perfect[0]);
    expect(second.done).toBe(true);
    expect(second.result?.whispers).toBe(2);
    expect(second.result?.stats.perfects).toBe(0);
  });

  it('compares a player with the rest of the town', async () => {
    const { p, as } = setup();
    as('t2_bob');
    await game.whisperTo(p, 3, wrongTile(3));
    await game.whisperTo(p, 3, townFor(3).perfect[0]);
    as('t2_ann');
    const ann = await game.whisperTo(p, 3, townFor(3).perfect[0]);
    expect(ann.result?.crowd.spread).toEqual([1, 1, 0, 0, 0]);
    expect(ann.result?.crowd.beat).toBe(100);
    const board = await game.leaderboard(p, 3);
    expect(board.today.map((row) => row.name)).toEqual(['ann', 'bob']);
    expect(board.today[0]?.me).toBe(true);
  });

  it('casts yesterday’s solvers in today’s town', async () => {
    const { p, as, world } = setup();
    as('t2_ann');
    await game.whisperTo(p, 3, townFor(3).perfect[0]);
    world.setNow(dayStart(4) + 60_000);
    as('t2_bob', 4);
    const view = await game.init(p);
    const guests = view.tiles.filter((t) => t?.guest);
    expect(guests.map((t) => t?.name)).toEqual(['u/ann']);
    expect(guests[0]?.me).toBeUndefined();
    as('t2_ann', 4);
    expect((await game.init(p)).tiles.find((t) => t?.guest)?.me).toBe(true);
  });

  it('extends a streak on consecutive days and drops it after a gap', async () => {
    const { p, as, world } = setup();
    as('t2_ann');
    await game.whisperTo(p, 3, townFor(3).perfect[0]);
    world.setNow(dayStart(4) + 60_000);
    as('t2_ann', 4);
    expect((await game.whisperTo(p, 4, townFor(4).perfect[0])).result?.stats.streak).toBe(2);
    world.setNow(dayStart(7) + 60_000);
    as('t2_ann', 7);
    expect((await game.init(p)).stats).toMatchObject({ streak: 0, best: 2 });
    expect((await game.whisperTo(p, 7, townFor(7).perfect[0])).result?.stats.streak).toBe(1);
  });

  it('lets an older town be played without touching the streak', async () => {
    const { p, as } = setup(5);
    as('t2_ann', 2);
    const old = await game.whisperTo(p, 2, townFor(2).perfect[0]);
    expect(old.result?.stats).toMatchObject({ streak: 0, solved: 1 });
    expect(old.result?.cast).toBe(false);
  });

  it('lets the town vote on tomorrow’s rumor', async () => {
    const { p, as, world } = setup();
    as('t2_ann');
    await expect(game.vote(p, 3, 1)).rejects.toThrow('closed');
    expect((await game.vote(p, 4, 2)).counts).toEqual([0, 0, 1]);
    expect((await game.vote(p, 4, 1)).counts).toEqual([0, 1, 0]);
    as('t2_bob');
    const tally = await game.vote(p, 4, 1);
    expect(tally.counts).toEqual([0, 2, 0]);
    expect(tally.mine).toBe(1);
    world.setNow(dayStart(4) + 1000);
    expect(await game.rumorFor(p, 4)).toBe(rumorChoices(4)[1]);
  });

  it('checks a logged-out solve without recording it', async () => {
    const { p, as } = setup();
    as(undefined);
    await expect(game.whisperTo(p, 3, 0)).rejects.toThrow('Log in');
    await expect(game.finishAsGuest(p, 3, [wrongTile(3)])).rejects.toThrow();
    const result = await game.finishAsGuest(p, 3, [townFor(3).perfect[0]]);
    expect(result.whispers).toBe(1);
    expect(result.crowd.solved).toBe(0);
  });

  it('posts one comment per town, only after solving', async () => {
    const { p, as, world } = setup();
    as('t2_ann');
    await expect(game.comment(p, 3, true)).rejects.toThrow('Finish');
    await game.whisperTo(p, 3, townFor(3).perfect[0]);
    await game.comment(p, 3, false);
    expect(world.comments[0]?.text).toContain('Psst! #3');
    expect(world.comments[0]?.text).toContain('u/ann');
    await expect(game.comment(p, 3, true)).rejects.toThrow('already');
  });

  it('opens one post per day', async () => {
    const { p, as, world } = setup();
    as(undefined);
    const first = await game.openTown(p);
    const second = await game.openTown(p);
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, id: first.id });
    expect(world.posts).toHaveLength(1);
    expect(world.posts[0]?.title).toMatch(/^Psst! #3 — [A-Z]/);
    expect(world.posts[0]?.postData).toEqual({ day: 3 });
  });
});
