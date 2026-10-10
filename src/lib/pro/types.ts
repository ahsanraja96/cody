import type { TabGroupColor } from '../types';

/**
 * Tabfold Pro and Pro AI (Pro-* boards). Free stays complete; Pro adds sync of every folded tab
 * through the Tabfold account, a daily backup kept 30 days and more export formats; Pro AI adds
 * Organise with AI, smart fold names and "Copy as context". Payments and sign-in are ExtensionPay;
 * the server (server/) checks the plan before sync, backups or AI.
 */

export type Tier = 'free' | 'pro' | 'pro-ai';
export type BillingInterval = 'month' | 'year';

/** What this install is entitled to, as last read from ExtensionPay (cached in storage). */
export interface PlanState {
  tier: Tier;
  /** The 7-day Pro AI trial, while it runs. */
  trial: { startedAt: number; endsAt: number } | null;
  /** The email the plan belongs to (payment or trial sign-up). */
  email: string | null;
  /** A paid plan's billing period. */
  interval: BillingInterval | null;
  /** Subscription state from the payment provider. */
  status: 'active' | 'past_due' | 'canceled' | null;
  /** The subscription ends at this time (cancelled but still paid up). */
  cancelAt: number | null;
  /** When this was read. 0: never. */
  checkedAt: number;
}

export const FREE_PLAN: PlanState = {
  tier: 'free',
  trial: null,
  email: null,
  interval: null,
  status: null,
  cancelAt: null,
  checkedAt: 0,
};

/** Plan nicknames as set up in the ExtensionPay dashboard (one per tier and period). */
export const PLAN_NICKNAMES: Record<Exclude<Tier, 'free'>, Record<BillingInterval, string>> = {
  pro: { month: 'pro-monthly', year: 'pro-yearly' },
  'pro-ai': { month: 'pro-ai-monthly', year: 'pro-ai-yearly' },
};

/** Prices in US dollars (Pro-Plans board). */
export const PRICES: Record<Exclude<Tier, 'free'>, Record<BillingInterval, number>> = {
  pro: { month: 5, year: 48 },
  'pro-ai': { month: 9, year: 84 },
};

export const TRIAL_DAYS = 7;
export const AI_RUNS_PER_MONTH = 300;
/** Organise sends at most this many tabs (the newest); the rest stay sorted by site. */
export const AI_MAX_TABS = 300;
/** Titles sent to the AI are cut to this many characters. */
export const AI_MAX_TITLE = 200;

export interface AiRuns {
  used: number;
  limit: number;
  /** Start of next month (ms). */
  resetsAt: number;
}

/** A tab as sent to the AI: only its title and site, never the page. */
export interface AiTab {
  id: string;
  title: string;
  host: string;
}

/** A project the AI proposed: its tabs, by saved tab id. */
export interface AiGroup {
  name: string;
  color: TabGroupColor;
  tabIds: string[];
}

export interface OrganiseResult {
  groups: AiGroup[];
  /** Tabs sent but not put in any project ("Everything else"). */
  ungrouped: string[];
  /** Folded tabs not sent (older than the newest 300, or folded from Incognito). */
  notSent: number;
  runs: AiRuns;
}

/** A project in the list (By project view). Tabs carry the project's name. */
export interface Project {
  name: string;
  color: TabGroupColor;
}

export interface ProjectsState {
  projects: Project[];
  /** When the list was last organised; tabs folded after it without a project are "new". */
  organisedAt: number;
}

export interface BackupInfo {
  /** YYYY-MM-DD (UTC). */
  day: string;
  tabCount: number;
  createdAt: number;
}

/** The occasional "You've freed 12.4 GB with Tabfold this month" line (Pro-Popup-Milestone). */
export interface MilestoneState {
  /** First time Tabfold ran (ms); no milestone in the first 3 days. */
  firstSeenAt: number;
  /** YYYY-MM of the running total. */
  month: string;
  /** Memory freed by folds this month (bytes). */
  freedBytes: number;
  lastShownAt: number;
  /** "Not now": hidden until then (30 days). */
  dismissedUntil: number;
}

/** Why a Pro request failed, for the pages to explain. */
export type ProErrorCode =
  | 'not-configured'
  | 'offline'
  | 'not-signed-in'
  | 'needs-pro'
  | 'needs-pro-ai'
  | 'runs-used-up'
  | 'ai-failed'
  | 'server';
