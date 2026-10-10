import MiniSearch, { type SearchResult as MiniResult } from 'minisearch';
import { normalizeKeyword } from '../keywords';
import { displayHost } from '../urls';

/**
 * Search over open and saved tabs by title, address and keyword. Runs inside a web worker in the
 * extension; the same code runs in unit tests. Keyword matches rank first; "#keyword" in a query
 * matches keywords exactly.
 */

export interface SearchDoc {
  /** "open:<tabId>" or "saved:<tabRecordId>" */
  id: string;
  kind: 'open' | 'saved';
  title: string;
  url: string;
  keywords: string[];
  favIconUrl: string;
  /** Saved tabs */
  tabRecordId?: string;
  sessionId?: string;
  sessionName?: string;
  savedAt?: number;
  deleted?: boolean;
  /** Folded from Incognito (reopens only in Incognito). */
  incognito?: boolean;
  /** Open tabs */
  tabId?: number;
  windowId?: number;
  windowLabel?: string;
  discarded?: boolean;
}

export interface ParsedQuery {
  /** Free text, matched against title, address and keywords. */
  text: string;
  /** "#keyword" terms; every one must be on the tab. */
  keywords: string[];
}

export interface SearchHit {
  doc: SearchDoc;
  score: number;
  /** Words to highlight in title/address. */
  terms: string[];
  /** Keywords on the tab that matched the query. */
  matchedKeywords: string[];
}

export interface SearchOptions {
  limit?: number;
  scope?: 'live' | 'trash';
}

export function parseQuery(input: string): ParsedQuery {
  const keywords: string[] = [];
  const words: string[] = [];
  for (const part of input.trim().split(/\s+/)) {
    if (!part) continue;
    if (part.startsWith('#') && part.length > 1) {
      const keyword = normalizeKeyword(part);
      if (keyword && !keywords.includes(keyword)) keywords.push(keyword);
    } else {
      words.push(part);
    }
  }
  return { text: words.join(' '), keywords };
}

export function tokenize(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname} ${parsed.search}`;
  } catch {
    return url;
  }
}

type Indexed = SearchDoc & { host: string; path: string; keywordText: string };

export class TabSearchIndex {
  private index: MiniSearch<Indexed>;
  private docs = new Map<string, SearchDoc>();

  constructor() {
    this.index = new MiniSearch<Indexed>({
      fields: ['title', 'host', 'path', 'keywordText'],
      storeFields: [],
      tokenize,
      processTerm: (term) => term.toLowerCase(),
      searchOptions: {
        boost: { keywordText: 4, title: 2, host: 1.5, path: 1 },
        prefix: true,
        fuzzy: (term) => (term.length > 4 ? 0.2 : false),
        combineWith: 'AND',
      },
    });
  }

  get size(): number {
    return this.docs.size;
  }

  private toIndexed(doc: SearchDoc): Indexed {
    return { ...doc, host: displayHost(doc.url), path: pathOf(doc.url), keywordText: doc.keywords.join(' ') };
  }

  addAll(docs: SearchDoc[]): void {
    const fresh = docs.filter((doc) => !this.docs.has(doc.id));
    for (const doc of fresh) this.docs.set(doc.id, doc);
    this.index.addAll(fresh.map((doc) => this.toIndexed(doc)));
  }

  removeAll(): void {
    this.index.removeAll();
    this.docs.clear();
  }

  get(id: string): SearchDoc | undefined {
    return this.docs.get(id);
  }

  all(): IterableIterator<SearchDoc> {
    return this.docs.values();
  }

  search(query: ParsedQuery, options: SearchOptions = {}): SearchHit[] {
    const limit = options.limit ?? 200;
    const scope = options.scope ?? 'live';
    const inScope = (doc: SearchDoc) => (scope === 'trash' ? !!doc.deleted : !doc.deleted);
    const hasKeywords = (doc: SearchDoc) => query.keywords.every((k) => doc.keywords.includes(k));
    const textTerms = tokenize(query.text);

    if (textTerms.length === 0) {
      if (query.keywords.length === 0) return [];
      const hits: SearchHit[] = [];
      for (const doc of this.docs.values()) {
        if (!inScope(doc) || !hasKeywords(doc)) continue;
        hits.push({ doc, score: 1, terms: [], matchedKeywords: [...query.keywords] });
      }
      return hits.sort(compareHits).slice(0, limit);
    }

    const raw: MiniResult[] = this.index.search(query.text, {
      filter: (result) => {
        const doc = this.docs.get(result.id as string);
        return !!doc && inScope(doc) && hasKeywords(doc);
      },
    });

    const hits: SearchHit[] = [];
    for (const result of raw) {
      const doc = this.docs.get(result.id as string);
      if (!doc) continue;
      const matchedKeywords = doc.keywords.filter(
        (keyword) =>
          query.keywords.includes(keyword) ||
          textTerms.some((term) => keyword === term || keyword.startsWith(term) || keyword.split(/[-_.]/).includes(term)),
      );
      // Tabs whose keywords match a typed word rank above title and address matches.
      const exactKeyword = doc.keywords.some((keyword) => textTerms.includes(keyword));
      const score = result.score * (exactKeyword ? 3 : matchedKeywords.length ? 1.5 : 1);
      hits.push({ doc, score, terms: result.terms, matchedKeywords });
    }
    return hits.sort(compareHits).slice(0, limit);
  }
}

function compareHits(a: SearchHit, b: SearchHit): number {
  return b.score - a.score || (b.doc.savedAt ?? Number.MAX_SAFE_INTEGER) - (a.doc.savedAt ?? Number.MAX_SAFE_INTEGER);
}

/** Split text into plain and highlighted parts for rendering <mark>. */
export function highlightParts(text: string, terms: string[]): Array<{ text: string; match: boolean }> {
  const clean = [...new Set(terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0))];
  if (clean.length === 0 || !text) return [{ text, match: false }];
  const escaped = clean.sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${escaped.join('|')})`, 'giu');
  const parts: Array<{ text: string; match: boolean }> = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start), match: false });
    parts.push({ text: match[0], match: true });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts;
}
