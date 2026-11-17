/** HTTP routes. Kept apart from the Devvit bootstrap so they can run anywhere. */
import express, { type NextFunction, type Request, type Response, type Router } from 'express';

import {
  comment,
  finishAsGuest,
  GameError,
  init,
  leaderboard,
  openTown,
  start,
  subscribe,
  vote,
  whisperTo,
} from './game.ts';
import type { Platform } from './platform.ts';

type Handler = (req: Request, res: Response) => Promise<unknown>;

export function createApp(platform: Platform, extra: Router[] = []): express.Express {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  for (const router of extra) app.use(router);

  const route = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => {
    handler(req, res)
      .then((body) => {
        if (!res.headersSent) res.json(body ?? { ok: true });
      })
      .catch(next);
  };

  app.get('/api/init', route(() => init(platform)));
  app.post('/api/start', route((req) => start(platform, req.body?.day)));
  app.post('/api/whisper', route((req) => whisperTo(platform, req.body?.day, req.body?.index)));
  app.post('/api/finish', route((req) => finishAsGuest(platform, req.body?.day, req.body?.whispers)));
  app.post('/api/vote', route((req) => vote(platform, req.body?.day, req.body?.choice)));
  app.get('/api/leaderboard', route((req) => leaderboard(platform, Number(req.query.day))));
  app.post('/api/comment', route((req) => comment(platform, req.body?.day, req.body?.asUser === true)));
  app.post('/api/subscribe', route(() => subscribe(platform)));

  app.post(
    '/internal/menu/open-town',
    route(async () => {
      const post = await openTown(platform);
      const sub = platform.context().subredditName;
      return {
        showToast: post.created ? `Town #${post.day} is open.` : `Town #${post.day} is already open.`,
        navigateTo: `https://www.reddit.com/r/${sub}/comments/${post.id.replace(/^t3_/, '')}`,
      };
    }),
  );
  app.post('/internal/cron/open-town', route(async () => ({ status: 'ok', ...(await openTown(platform)) })));
  app.post('/internal/triggers/install', route(async () => ({ status: 'ok', ...(await openTown(platform)) })));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof GameError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'The town hall is in a muddle. Try again in a moment.' });
  });
  return app;
}
