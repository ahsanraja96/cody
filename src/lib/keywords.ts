/**
 * Keywords are short labels a person picks for a saved tab ("webhooks", "checkout-app").
 * Search ranks keyword matches first. Suggestions come only from the tab's title and address,
 * worked out on this device; the page itself is never read.
 */

export const MAX_KEYWORD_LENGTH = 40;
export const MAX_KEYWORDS_PER_TAB = 20;
export const MAX_SUGGESTIONS = 6;

/** Lower-case, trimmed, spaces become hyphens, a leading # is dropped. Letters in any script are kept. */
export function normalizeKeyword(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-_.+]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, MAX_KEYWORD_LENGTH);
}

/** Normalise, drop empties and duplicates, keep order, cap the count. */
export function cleanKeywords(list: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const keyword = normalizeKeyword(raw);
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    out.push(keyword);
    if (out.length >= MAX_KEYWORDS_PER_TAB) break;
  }
  return out;
}

/** Split typed text on commas into keywords ("api, Stripe Docs" -> ["api", "stripe-docs"]). */
export function parseKeywordInput(text: string): string[] {
  return cleanKeywords(text.split(','));
}

const STOPWORDS = new Set(
  [
    // English function words
    'a an and are as at be but by can do does for from has have how i if in into is it its of on or our',
    'so than that the their then there these this to up use using vs was we what when where which who why will',
    'with without you your yours new get got just more most not now one all any about after before over out',
    // Web and title noise
    'http https www com org net io co uk dev app html htm php aspx index page home login signin sign welcome',
    'untitled tab tabs search results result official site website online free best top guide',
  ]
    .join(' ')
    .split(' '),
);

const TLDS = new Set([
  'com', 'org', 'net', 'io', 'co', 'uk', 'de', 'fr', 'es', 'it', 'nl', 'jp', 'cn', 'in', 'au', 'ca',
  'us', 'eu', 'ai', 'app', 'dev', 'me', 'info', 'biz', 'tv', 'gov', 'edu', 'ly', 'so', 'sh', 'gg', 'xyz',
]);

function tokenize(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function isUseful(token: string): boolean {
  if (token.length < 3 && !/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(token)) {
    return false;
  }
  if (/^\d+$/.test(token)) return false;
  if (/^[0-9a-f]{12,}$/.test(token)) return false; // ids and hashes
  if (token.length > MAX_KEYWORD_LENGTH) return false;
  return !STOPWORDS.has(token);
}

function urlTokens(url: string): string[] {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [];
    const hostParts = parsed.hostname
      .replace(/^www\./, '')
      .split('.')
      .filter((part) => !TLDS.has(part));
    const pathParts = parsed.pathname.split('/').flatMap((segment) => tokenize(decodeURIComponentSafe(segment)));
    return [...hostParts.flatMap(tokenize), ...pathParts];
  } catch {
    return [];
  }
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Suggest keywords from a tab's title and address. Words found in both rank first, then title
 * words in order, then address words. Already-picked keywords are left out.
 */
export function suggestKeywords(
  title: string,
  url: string,
  options: { exclude?: Iterable<string>; limit?: number } = {},
): string[] {
  const exclude = new Set(options.exclude ?? []);
  const limit = options.limit ?? MAX_SUGGESTIONS;
  const fromTitle = tokenize(title).filter(isUseful);
  const fromUrl = urlTokens(url).filter(isUseful);
  const urlSet = new Set(fromUrl);
  const both = fromTitle.filter((token) => urlSet.has(token));
  const ordered = [...both, ...fromTitle, ...fromUrl];
  const out: string[] = [];
  for (const token of ordered) {
    const keyword = normalizeKeyword(token);
    if (!keyword || exclude.has(keyword) || out.includes(keyword)) continue;
    out.push(keyword);
    if (out.length >= limit) break;
  }
  return out;
}
