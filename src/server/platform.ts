/**
 * The slice of the Devvit platform the game needs. The real server passes in
 * `@devvit/web/server`; tests and the local preview pass in an in-memory copy.
 */
export interface ZMember {
  member: string;
  score: number;
}

export interface RedisLike {
  get(key: string): Promise<string | undefined | null>;
  set(key: string, value: string): Promise<unknown>;
  incrBy(key: string, value: number): Promise<number>;
  hGet(key: string, field: string): Promise<string | undefined | null>;
  hSet(key: string, fieldValues: Record<string, string>): Promise<unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hIncrBy(key: string, field: string, value: number): Promise<number>;
  zAdd(key: string, ...members: ZMember[]): Promise<unknown>;
  zRange(
    key: string,
    start: number,
    stop: number,
    options?: { by: 'rank' | 'score' | 'lex'; reverse?: boolean },
  ): Promise<ZMember[]>;
  zRem(key: string, members: string[]): Promise<unknown>;
}

export interface RedditLike {
  getCurrentUsername(): Promise<string | undefined>;
  getSnoovatarUrl(username: string): Promise<string | undefined>;
  submitCustomPost(options: {
    subredditName: string;
    title: string;
    entry?: string;
    postData?: Record<string, unknown>;
    textFallback?: { text: string };
  }): Promise<{ id: string; permalink?: string }>;
  submitComment(options: { id: string; text: string; runAs?: 'USER' | 'APP' }): Promise<unknown>;
  setUserFlair(options: { subredditName: string; username: string; text: string }): Promise<unknown>;
  subscribeToCurrentSubreddit(): Promise<unknown>;
}

export interface RequestContext {
  userId?: string | undefined;
  postId?: string | undefined;
  subredditName?: string | undefined;
  postData?: Record<string, unknown> | undefined;
}

export interface Platform {
  redis: RedisLike;
  reddit: RedditLike;
  context(): RequestContext;
  now(): number;
}
