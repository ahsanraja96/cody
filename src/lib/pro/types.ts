import type { TabGroupColor } from '../types';

/**
 * Tabfold Pro and Pro AI (Pro-* and Stripe-* boards). Free stays complete; Pro adds sync of every
 * folded tab through the Tabfold account, a daily backup kept 30 days and more export formats; Pro
 * AI adds Organise with AI, smart fold names and "Copy as context". Payments are Stripe Checkout
 * and Stripe's billing page, opened in a tab; the account is an email address proved with an
 * emailed code. The server (server/API.md) works out the plan and checks it before sync, backups
 * or AI.
 */

export type Tier = 'free' | 'pro' | 'pro-ai';
export type BillingInterval = 'month' | 'year';

/** What this computer is entitled to, as the server last said (`GET /me`, cached in storage). Same shape as server/API.md. */
export interface PlanState {
  tier: Tier;
  /** The server's 7-day Pro AI trial, while it runs and there's no live subscription. */
  trial: { startedAt: number; endsAt: number } | null;
  /** This email has had its trial (one per email). */
  trialUsed: boolean;
  /** The signed-in account's email; null when this computer isn't signed in. */
  email: string | null;
  /** A live subscription's billing period. */
  interval: BillingInterval | null;
  /** A live subscription's state: 'active' (Stripe's active or trialing) or 'past_due'; else null. */
  status: 'active' | 'past_due' | 'canceled' | null;
  /** Cancelled but still on until then (ms). */
  cancelAt: number | null;
  /** Next charge (ms): the period end, or when billing starts after a trial. Null when cancelled. */
  renewsAt: number | null;
  /** When the server worked this out (ms). 0: never. */
  checkedAt: number;
}

export const FREE_PLAN: PlanState = {
  tier: 'free',
  trial: null,
  trialUsed: false,
  email: null,
  interval: null,
  status: null,
  cancelAt: null,
  renewsAt: null,
  checkedAt: 0,
};

/** Stripe Price lookup keys (server/scripts/stripe-setup.mjs creates them), one per tier and period. */
export const PRICE_LOOKUP_KEYS: Record<Exclude<Tier, 'free'>, Record<BillingInterval, string>> = {
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

/** Why a Pro request failed, for the pages to explain (server/API.md, "Errors", plus the first two). */
export type ProErrorCode =
  /** This build has no server (extension only). */
  | 'not-configured'
  /** The server couldn't be reached (extension only). */
  | 'offline'
  | 'not-signed-in'
  | 'needs-pro'
  | 'needs-pro-ai'
  | 'conflict'
  | 'already-subscribed'
  | 'runs-used-up'
  | 'rate-limited'
  | 'ai-failed'
  | 'send-failed'
  | 'invalid-email'
  | 'wrong-code'
  | 'code-expired'
  | 'server';

/** Why a sign-in code is emailed; it only changes the email's wording. */
export type SigninPurpose = 'signin' | 'trial';

/** After a code (`POST /signin/finish`) or `POST /trial`: the plan now, whether the trial started, and whether this email had one before. */
export interface SigninResult {
  plan: PlanState;
  trialStarted: boolean;
  trialUsed: boolean;
}

/** A Stripe Checkout tab Tabfold opened and watches (`checkoutState` in chrome.storage.session). */
export interface CheckoutState {
  tabId: number;
  sessionId: string;
  tier: Exclude<Tier, 'free'>;
  interval: BillingInterval;
  startedAt: number;
  /** The Tabfold page it was opened from, focused again when the person cancels. */
  openerTabId?: number;
}
