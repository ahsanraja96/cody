/** The wire format between the web view and the server. */
import type { Kind, Dir } from './engine.ts';

export interface TileView {
  kind: Kind;
  dir: Dir;
  pal?: number;
  /** Townsfolk name, or a redditor's username when they have been cast. */
  name: string;
  /** Present when this villager is a real member of the community. */
  avatar?: string;
  guest?: boolean;
  me?: boolean;
  look: number;
}

export interface Stats {
  streak: number;
  best: number;
  solved: number;
  perfects: number;
}

export interface Crowd {
  /** Players who finished with 1, 2, 3, 4 and 5+ whispers. */
  spread: number[];
  solved: number;
  /** Share of finishers who needed more whispers than you. */
  beat: number;
  /** First whispers per tile index. */
  first: Record<string, number>;
}

export interface Vote {
  /** The day this vote decides. */
  day: number;
  choices: string[];
  counts: number[];
  mine: number | null;
}

export interface Result {
  whispers: number;
  seconds: number;
  title: string;
  perfect: number[];
  stats: Stats;
  crowd: Crowd;
  vote: Vote;
  /** True when the player will appear in tomorrow's town. */
  cast: boolean;
  /** The day's three best whisperers. */
  top: Leader[];
}

export interface InitResponse {
  day: number;
  today: number;
  label: string;
  difficulty: string;
  rumor: string;
  subreddit: string;
  user: { name: string; avatar?: string } | null;
  w: number;
  h: number;
  tiles: (TileView | null)[];
  whispers: number[];
  done: boolean;
  stats: Stats;
  players: number;
  msToNext: number;
  /** Post that holds today's town, when this post is an older one. */
  todayPost?: string;
  result?: Result;
  firstTime: boolean;
}

export interface WhisperRequest {
  day: number;
  index: number;
}

export interface WhisperResponse {
  whispers: number[];
  done: boolean;
  result?: Result;
}

export interface FinishRequest {
  day: number;
  whispers: number[];
}

export interface VoteRequest {
  day: number;
  choice: number;
}

export interface Leader {
  name: string;
  whispers: number;
  seconds: number;
  me?: boolean;
}

export interface LeaderboardResponse {
  today: Leader[];
  streaks: { name: string; streak: number; me?: boolean }[];
}

export interface ApiError {
  error: string;
}
