/// <reference lib="webworker" />
import { db, getSearchVersion } from '../db';
import { parseQuery, TabSearchIndex, type SearchDoc } from './engine';
import type { SearchRequest, SearchResponse } from './protocol';
import { keywordsByUrl, loadSavedDocs } from './savedDocs';

/**
 * Builds and queries the search index off the main thread. The saved-tab index is rebuilt only
 * when the database's search version moves; open tabs are small and indexed per query.
 */

declare const self: DedicatedWorkerGlobalScope;

let saved = new TabSearchIndex();
let savedKeywordsByUrl = new Map<string, string[]>();
let builtVersion = -1;
let building: Promise<void> | null = null;

let openIndex = new TabSearchIndex();
let openKey = '';

async function ensureSaved(): Promise<void> {
  const version = await getSearchVersion(db);
  if (version === builtVersion) return;
  if (!building) {
    building = (async () => {
      const docs = await loadSavedDocs(db);
      const next = new TabSearchIndex();
      next.addAll(docs);
      saved = next;
      savedKeywordsByUrl = keywordsByUrl(docs);
      builtVersion = version;
    })().finally(() => {
      building = null;
    });
  }
  await building;
}

function ensureOpen(docs: SearchDoc[]): void {
  const key = docs.map((d) => `${d.id}\u0001${d.title}\u0001${d.url}`).join('\u0002');
  if (key === openKey) return;
  const next = new TabSearchIndex();
  next.addAll(docs.map((doc) => ({ ...doc, keywords: savedKeywordsByUrl.get(doc.url) ?? doc.keywords })));
  openIndex = next;
  openKey = key;
}

self.onmessage = async (event: MessageEvent<SearchRequest>) => {
  const request = event.data;
  const started = performance.now();
  try {
    await ensureSaved();
    if (request.type === 'warm') {
      self.postMessage({ id: request.id, open: [], saved: [], savedTotal: 0, indexedTabs: saved.size, ms: 0 } satisfies SearchResponse);
      return;
    }
    ensureOpen(request.open);
    const parsed = parseQuery(request.query);
    const scope = request.scope ?? 'live';
    const savedHits = saved.search(parsed, { scope, limit: 5000 });
    const openHits = scope === 'live' ? openIndex.search(parsed, { limit: 50 }) : [];
    const limit = request.limit ?? 200;
    const response: SearchResponse = {
      id: request.id,
      open: openHits,
      saved: savedHits.slice(0, limit),
      savedTotal: savedHits.length,
      indexedTabs: saved.size,
      ms: Math.round(performance.now() - started),
    };
    self.postMessage(response);
  } catch (error) {
    console.error('[tabfold] search failed', error);
    self.postMessage({ id: request.id, open: [], saved: [], savedTotal: 0, indexedTabs: 0, ms: 0 } satisfies SearchResponse);
  }
};
