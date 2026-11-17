/** An in-memory stand-in for Redis and Reddit, for tests and the local preview. */
import type { Platform, RequestContext, ZMember } from '../src/server/platform.ts';

export interface MemoryWorld {
  platform: Platform;
  /** Change who is asking, which post they are on, and what time it is. */
  as(context: RequestContext): void;
  setNow(ms: number): void;
  posts: { id: string; title: string; postData?: Record<string, unknown> }[];
  comments: { id: string; text: string; runAs?: string }[];
  flair: Map<string, string>;
  usernames: Map<string, string>;
}

export function createMemoryWorld(start = Date.now()): MemoryWorld {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const zsets = new Map<string, Map<string, number>>();
  let context: RequestContext = {};
  let offset = 0;
  let fixed: number | null = start;
  const world: MemoryWorld = {
    posts: [],
    comments: [],
    flair: new Map(),
    usernames: new Map(),
    as: (next) => {
      context = next;
    },
    setNow: (ms) => {
      fixed = ms;
      offset = 0;
    },
    platform: undefined as unknown as Platform,
  };
  const hash = (key: string) => hashes.get(key) ?? hashes.set(key, new Map()).get(key)!;
  const zset = (key: string) => zsets.get(key) ?? zsets.set(key, new Map()).get(key)!;

  world.platform = {
    now: () => (fixed ?? Date.now()) + offset++,
    context: () => context,
    redis: {
      get: async (key) => strings.get(key),
      set: async (key, value) => void strings.set(key, value),
      incrBy: async (key, value) => {
        const next = Number(strings.get(key) ?? 0) + value;
        strings.set(key, String(next));
        return next;
      },
      hGet: async (key, field) => hash(key).get(field),
      hSet: async (key, fieldValues) => {
        for (const [field, value] of Object.entries(fieldValues)) hash(key).set(field, value);
      },
      hGetAll: async (key) => Object.fromEntries(hash(key)),
      hIncrBy: async (key, field, value) => {
        const next = Number(hash(key).get(field) ?? 0) + value;
        hash(key).set(field, String(next));
        return next;
      },
      zAdd: async (key, ...members: ZMember[]) => {
        for (const { member, score } of members) zset(key).set(member, score);
      },
      zRange: async (key, startAt, stop, options) => {
        const rows = [...zset(key)].map(([member, score]) => ({ member, score }));
        rows.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
        if (options?.reverse) rows.reverse();
        return rows.slice(startAt, stop < 0 ? undefined : stop + 1);
      },
      zRem: async (key, members) => {
        for (const member of members) zset(key).delete(member);
      },
    },
    reddit: {
      getCurrentUsername: async () => (context.userId ? world.usernames.get(context.userId) : undefined),
      getSnoovatarUrl: async () => undefined,
      submitCustomPost: async (options) => {
        const post = { id: `t3_local${world.posts.length + 1}`, title: options.title, postData: options.postData };
        world.posts.push(post);
        return post;
      },
      submitComment: async (options) => void world.comments.push(options),
      setUserFlair: async (options) => void world.flair.set(options.username, options.text),
      subscribeToCurrentSubreddit: async () => undefined,
    },
  };
  return world;
}
