import { createTelemetryRouter } from '@devvit/analytics/server/reddit';
import { context, createServer, getServerPort, reddit, redis } from '@devvit/web/server';

import { createApp } from './app.ts';
import type { Platform } from './platform.ts';

const platform: Platform = {
  redis,
  reddit: {
    getCurrentUsername: () => reddit.getCurrentUsername(),
    getSnoovatarUrl: (username) => reddit.getSnoovatarUrl(username),
    submitCustomPost: (options) => reddit.submitCustomPost(options as Parameters<typeof reddit.submitCustomPost>[0]),
    submitComment: (options) =>
      reddit.submitComment({ ...options, id: options.id as `t3_${string}` }),
    setUserFlair: (options) => reddit.setUserFlair(options),
    subscribeToCurrentSubreddit: () => reddit.subscribeToCurrentSubreddit(),
  },
  context: () => ({
    userId: context.userId,
    postId: context.postId,
    subredditName: context.subredditName,
    postData: context.postData as Record<string, unknown> | undefined,
  }),
  now: () => Date.now(),
};

// Journey events from the web view arrive on /api/telemetry/*.
const app = createApp(platform, [createTelemetryRouter()]);

createServer(app).listen(getServerPort());
