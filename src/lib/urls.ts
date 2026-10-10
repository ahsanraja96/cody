/** Longest URL we store. Longer ones (huge data: URLs, giant query strings) are cut and flagged. */
export const MAX_URL_LENGTH = 8192;
/** Favicons given as data: URLs are only kept when small. */
export const MAX_FAVICON_LENGTH = 4096;

export type UrlKind = 'web' | 'blank' | 'browser' | 'own' | 'extension' | 'file' | 'data' | 'other';

const BLANK_URLS = new Set([
  'about:blank',
  'about:newtab',
  'about:home',
  'chrome://newtab/',
  'chrome://new-tab-page/',
  'chrome-search://local-ntp/local-ntp.html',
  'edge://newtab/',
  'brave://newtab/',
  'opera://startpage/',
  'vivaldi://newtab/',
]);

const BROWSER_SCHEMES = [
  'chrome:',
  'edge:',
  'brave:',
  'opera:',
  'vivaldi:',
  'about:',
  'view-source:',
  'chrome-untrusted:',
  'devtools:',
  'chrome-search:',
];

/** Chrome's built-in PDF viewer extension. Older versions show its URL instead of the PDF's. */
const PDF_VIEWER_PREFIX = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';

export function classifyUrl(url: string, ownOrigin?: string): UrlKind {
  if (!url) return 'blank';
  const lower = url.toLowerCase();
  if (BLANK_URLS.has(lower) || BLANK_URLS.has(`${lower}/`)) return 'blank';
  if (lower.startsWith('http://') || lower.startsWith('https://')) return 'web';
  if (ownOrigin && lower.startsWith(ownOrigin.toLowerCase())) return 'own';
  if (
    lower.startsWith('chrome-extension:') ||
    lower.startsWith('moz-extension:') ||
    lower.startsWith('extension:')
  ) {
    return 'extension';
  }
  if (lower.startsWith('file:')) return 'file';
  if (lower.startsWith('data:') || lower.startsWith('blob:') || lower.startsWith('javascript:')) {
    return 'data';
  }
  if (BROWSER_SCHEMES.some((scheme) => lower.startsWith(scheme))) return 'browser';
  return 'other';
}

/** Pages Chrome may refuse to reopen from an extension; shown as copyable text when a restore fails. */
export function isLikelyRestorable(url: string, ownOrigin?: string): boolean {
  const kind = classifyUrl(url, ownOrigin);
  return kind === 'web' || kind === 'blank' || kind === 'file' || kind === 'browser';
}

/** Turn the built-in PDF viewer's address back into the real PDF address. */
export function unwrapViewerUrl(url: string): string {
  if (!url.startsWith(PDF_VIEWER_PREFIX)) return url;
  try {
    const parsed = new URL(url);
    const src = parsed.searchParams.get('src') ?? parsed.searchParams.get('file');
    return src ?? url;
  } catch {
    return url;
  }
}

export function capUrl(url: string): { url: string; truncated: boolean } {
  if (url.length <= MAX_URL_LENGTH) return { url, truncated: false };
  return { url: url.slice(0, MAX_URL_LENGTH), truncated: true };
}

export function capFavicon(favIconUrl: string | undefined): string {
  if (!favIconUrl) return '';
  if (favIconUrl.startsWith('data:') && favIconUrl.length > MAX_FAVICON_LENGTH) return '';
  return favIconUrl.length > MAX_URL_LENGTH ? '' : favIconUrl;
}

/** Host without a leading "www.", or a readable label for non-web addresses. */
export function displayHost(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.hostname.replace(/^www\./, '');
    }
    if (parsed.protocol === 'file:') return 'file';
    if (parsed.protocol === 'chrome-extension:' || parsed.protocol === 'moz-extension:') return 'extension';
    if (parsed.host) return parsed.host;
    return parsed.protocol.replace(':', '');
  } catch {
    return url.split(/[/?#]/)[0] ?? url;
  }
}

/** Short address without the scheme, for second lines in rows. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}

/** The URL used for duplicate detection: exact address, ignoring a trailing slash. */
export function dedupeKey(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
