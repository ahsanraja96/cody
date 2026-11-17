/**
 * Local preview: the real routes and the built web view, backed by memory
 * instead of Reddit. `npm run build && npm run local`, then open
 *   http://localhost:5173/game.html?as=ann&day=5
 * Query options: as=<name> (omit for logged out), day=<n>, crowd=1 (fake players).
 */
import express from 'express';

import { createApp } from '../src/server/app.ts';
import * as game from '../src/server/game.ts';
import { dayNumber, dayStart, townFor } from '../src/shared/daily.ts';
import { reachFrom } from '../src/shared/engine.ts';
import { makeRng } from '../src/shared/rng.ts';
import { createMemoryWorld } from './memory.ts';

const world = createMemoryWorld(Date.now());
const telemetry = express.Router();
telemetry.post(/^\/api\/telemetry\/.*/, (_req, res) => res.json({ journeyId: 'local', receipt: { status: 'LOCAL' } }));

const seeded = new Set<number>();
async function seedCrowd(day: number): Promise<void> {
  if (seeded.has(day)) return;
  seeded.add(day);
  const rng = makeRng(`crowd-${day}`);
  for (const d of [day - 1, day]) {
    if (d < 1) continue;
    const town = townFor(d);
    const folk = town.board.tiles.map((t, i) => (t && t.kind !== 'shy' ? i : -1)).filter((i) => i >= 0);
    world.setNow(dayStart(d) + 3_600_000);
    for (let n = 0; n < 23; n++) {
      const id = `t2_fake${n}`;
      world.usernames.set(id, ['moss_and_marble', 'quietkettle', 'OwlPostOffice', 'turnip_baron', 'lamplighter7'][n % 5]! + (n > 4 ? n : ''));
      world.as({ userId: id, postId: 't3_local', subredditName: 'PsstDaily', postData: { day: d } });
      await game.start(world.platform, d);
      const misses = rng() < 0.3 ? 0 : 1 + Math.floor(rng() * 3);
      for (let m = 0; m < misses; m++) {
        const pickTile = folk[Math.floor(rng() * folk.length)] as number;
        if (reachFrom(town.board, pickTile).reach === town.villagers) continue;
        await game.whisperTo(world.platform, d, pickTile).catch(() => undefined);
      }
      world.setNow(dayStart(d) + 3_600_000 + (20 + Math.floor(rng() * 200)) * 1000);
      await game.whisperTo(world.platform, d, town.perfect[0]).catch(() => undefined);
    }
  }
  // Stand-in portraits so the cast can be previewed without Reddit.
  const tints = ['#7fb7a4', '#e9a23b', '#8f7fd6', '#e0736c', '#5b9bd5'];
  const avatars: Record<string, string> = {};
  [...world.usernames.values()].forEach((name, n) => {
    if (n % 3 === 2) return;
    const art = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 60 90'><rect width='60' height='90' fill='${tints[n % 5]}'/><circle cx='30' cy='30' r='17' fill='#fde3c8'/><circle cx='24' cy='28' r='2.500' fill='#222'/><circle cx='36' cy='28' r='2.500' fill='#222'/><path d='M23 37q7 6 14 0' stroke='#222' stroke-width='2' fill='none'/><rect x='12' y='50' width='36' height='40' rx='12' fill='#fff'/></svg>`;
    avatars[name] = `data:image/svg+xml,${encodeURIComponent(art.replaceAll('2.500', '2.5'))}`;
  });
  await world.platform.redis.hSet('avatars', avatars);
}

const outer = express();
outer.use(async (req, _res, next) => {
  const referer = new URL(req.get('referer') ?? `http://x${req.url}`);
  const query = req.path.endsWith('.html') ? new URL(`http://x${req.url}`).searchParams : referer.searchParams;
  const as = query.get('as');
  const day = Number(query.get('day')) || dayNumber(Date.now());
  if (query.get('crowd')) await seedCrowd(day);
  world.setNow(dayStart(day) + 9 * 3_600_000 + (Date.now() % 3_600_000));
  if (as) world.usernames.set(`t2_${as}`, as);
  world.as({
    userId: as ? `t2_${as}` : undefined,
    postId: 't3_local',
    subredditName: 'PsstDaily',
    postData: { day: Number(query.get('post')) || day },
  });
  next();
});
outer.use(createApp(world.platform, [telemetry]));
outer.use(express.static('dist/client'));
const port = Number(process.env.PORT) || 5173;
outer.listen(port, () => console.log(`Psst! local preview on http://localhost:${port}/index.html?as=ann`));
