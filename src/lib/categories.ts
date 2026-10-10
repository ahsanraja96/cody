import type { TabGroupColor } from './types';
import { displayHost } from './urls';

/**
 * Folded tabs are grouped by kind of site, with no setup: a built-in list of sites per category,
 * and everything else in "Other". The colours are Chrome's tab group colours, so "Open all" can
 * open a group as a real Chrome tab group that looks the same.
 */

export type CategoryId = 'dev' | 'docs' | 'mail' | 'social' | 'video' | 'ai' | 'shopping' | 'reading' | 'other';

export interface Category {
  id: CategoryId;
  name: string;
  color: TabGroupColor;
}

export const CATEGORIES: Category[] = [
  { id: 'dev', name: 'Dev', color: 'blue' },
  { id: 'docs', name: 'Docs', color: 'cyan' },
  { id: 'mail', name: 'Mail & chat', color: 'yellow' },
  { id: 'social', name: 'Social', color: 'pink' },
  { id: 'video', name: 'Video', color: 'red' },
  { id: 'ai', name: 'AI', color: 'purple' },
  { id: 'shopping', name: 'Shopping', color: 'orange' },
  { id: 'reading', name: 'Reading', color: 'green' },
  { id: 'other', name: 'Other', color: 'grey' },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function category(id: CategoryId): Category {
  return BY_ID.get(id) ?? BY_ID.get('other')!;
}

/** Site → category. A site also covers its subdomains; the most specific match wins. */
export const SITE_RULES: Record<string, CategoryId> = {
  // Dev
  'github.com': 'dev', 'gitlab.com': 'dev', 'bitbucket.org': 'dev', 'stackoverflow.com': 'dev',
  'stackexchange.com': 'dev', 'npmjs.com': 'dev', 'pypi.org': 'dev', 'vercel.com': 'dev',
  'netlify.com': 'dev', 'supabase.com': 'dev', 'firebase.google.com': 'dev', 'console.cloud.google.com': 'dev',
  'aws.amazon.com': 'dev', 'console.aws.amazon.com': 'dev', 'portal.azure.com': 'dev', 'cloudflare.com': 'dev',
  'heroku.com': 'dev', 'render.com': 'dev', 'railway.app': 'dev', 'codepen.io': 'dev',
  'codesandbox.io': 'dev', 'stackblitz.com': 'dev', 'replit.com': 'dev', 'developer.mozilla.org': 'dev',
  'developer.chrome.com': 'dev', 'localhost': 'dev', '127.0.0.1': 'dev', 'linear.app': 'dev',
  'atlassian.net': 'dev', 'sentry.io': 'dev', 'docker.com': 'dev', 'hub.docker.com': 'dev',
  // Docs
  'docs.google.com': 'docs', 'drive.google.com': 'docs', 'notion.so': 'docs', 'notion.site': 'docs',
  'confluence.com': 'docs', 'dropbox.com': 'docs', 'onedrive.live.com': 'docs', 'office.com': 'docs',
  'sharepoint.com': 'docs', 'airtable.com': 'docs', 'coda.io': 'docs', 'quip.com': 'docs',
  'figma.com': 'docs', 'miro.com': 'docs', 'canva.com': 'docs', 'docs.stripe.com': 'docs',
  'react.dev': 'docs', 'nextjs.org': 'docs', 'readthedocs.io': 'docs',
  // Mail & chat
  'mail.google.com': 'mail', 'calendar.google.com': 'mail', 'outlook.live.com': 'mail', 'outlook.office.com': 'mail',
  'mail.yahoo.com': 'mail', 'proton.me': 'mail', 'slack.com': 'mail', 'app.slack.com': 'mail',
  'discord.com': 'mail', 'teams.microsoft.com': 'mail', 'web.whatsapp.com': 'mail', 'web.telegram.org': 'mail',
  'messenger.com': 'mail', 'meet.google.com': 'mail', 'zoom.us': 'mail',
  // Social
  'x.com': 'social', 'twitter.com': 'social', 'facebook.com': 'social', 'instagram.com': 'social',
  'linkedin.com': 'social', 'reddit.com': 'social', 'threads.net': 'social', 'bsky.app': 'social',
  'mastodon.social': 'social', 'pinterest.com': 'social', 'tiktok.com': 'social', 'news.ycombinator.com': 'social',
  // Video
  'youtube.com': 'video', 'youtu.be': 'video', 'vimeo.com': 'video', 'netflix.com': 'video',
  'twitch.tv': 'video', 'primevideo.com': 'video', 'disneyplus.com': 'video', 'hulu.com': 'video',
  'loom.com': 'video', 'dailymotion.com': 'video', 'spotify.com': 'video', 'open.spotify.com': 'video',
  // AI
  'claude.ai': 'ai', 'chatgpt.com': 'ai', 'chat.openai.com': 'ai', 'gemini.google.com': 'ai',
  'perplexity.ai': 'ai', 'copilot.microsoft.com': 'ai', 'poe.com': 'ai', 'huggingface.co': 'ai',
  'midjourney.com': 'ai', 'console.anthropic.com': 'ai', 'platform.openai.com': 'ai', 'cursor.com': 'ai',
  // Shopping
  'amazon.com': 'shopping', 'amazon.co.uk': 'shopping', 'amazon.de': 'shopping', 'ebay.com': 'shopping',
  'etsy.com': 'shopping', 'aliexpress.com': 'shopping', 'walmart.com': 'shopping', 'target.com': 'shopping',
  'ikea.com': 'shopping', 'bestbuy.com': 'shopping', 'shopify.com': 'shopping', 'temu.com': 'shopping',
  // Reading
  'medium.com': 'reading', 'substack.com': 'reading', 'wikipedia.org': 'reading', 'nytimes.com': 'reading',
  'theguardian.com': 'reading', 'bbc.com': 'reading', 'bbc.co.uk': 'reading', 'theverge.com': 'reading',
  'arstechnica.com': 'reading', 'wired.com': 'reading', 'dev.to': 'reading', 'hashnode.com': 'reading',
  'arxiv.org': 'reading', 'economist.com': 'reading', 'cnn.com': 'reading', 'reuters.com': 'reading',
};

/** The category of a tab's address. */
export function categorize(url: string): CategoryId {
  let host = displayHost(url).toLowerCase();
  if (!host) return 'other';
  host = host.replace(/^www\./, '').replace(/:\d+$/, '');
  // Walk from the full host to its parent domains: docs.google.com, then google.com.
  for (let candidate = host; candidate.includes('.') || candidate === 'localhost'; ) {
    const hit = SITE_RULES[candidate];
    if (hit) return hit;
    const dot = candidate.indexOf('.');
    if (dot < 0) break;
    candidate = candidate.slice(dot + 1);
  }
  return 'other';
}

export interface CategoryGroup<T> {
  category: Category;
  items: T[];
  /** Newest item's time, used to sort groups (groups that just received tabs come first). */
  newest: number;
}

/**
 * Group items by category: newest first inside each group, and groups ordered by their newest
 * item, so a fold moves the groups it added to to the top.
 */
export function groupByCategory<T>(items: T[], urlOf: (item: T) => string, timeOf: (item: T) => number): CategoryGroup<T>[] {
  const groups = new Map<CategoryId, CategoryGroup<T>>();
  for (const item of items) {
    const id = categorize(urlOf(item));
    let group = groups.get(id);
    if (!group) {
      group = { category: category(id), items: [], newest: 0 };
      groups.set(id, group);
    }
    group.items.push(item);
    group.newest = Math.max(group.newest, timeOf(item));
  }
  const list = [...groups.values()];
  for (const group of list) group.items.sort((a, b) => timeOf(b) - timeOf(a));
  return list.sort((a, b) => b.newest - a.newest || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
}
