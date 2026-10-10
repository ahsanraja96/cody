import type { SearchDoc } from './engine';
import type { SearchRequest, SearchResponse } from './protocol';

/** Main-thread handle on the search worker. Stale answers (from earlier keystrokes) are dropped. */
export class SearchClient {
  private worker: Worker | null = null;
  private seq = 0;
  private latest = 0;
  private pending = new Map<number, (response: SearchResponse | null) => void>();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<SearchResponse>) => {
      const resolve = this.pending.get(event.data.id);
      if (!resolve) return;
      this.pending.delete(event.data.id);
      resolve(event.data.id >= this.latest ? event.data : null);
    };
    this.worker = worker;
    return worker;
  }

  /** Start building the index early (after first paint) so the first keystroke is instant. */
  warm(): void {
    const id = ++this.seq;
    this.pending.set(id, () => undefined);
    this.ensure().postMessage({ id, type: 'warm' } satisfies SearchRequest);
  }

  /** Resolves with null when a newer query has superseded this one. */
  query(
    query: string,
    open: SearchDoc[] = [],
    options: { limit?: number; scope?: 'live' | 'trash' } = {},
  ): Promise<SearchResponse | null> {
    const id = ++this.seq;
    this.latest = id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ensure().postMessage({ id, type: 'query', query, open, ...options } satisfies SearchRequest);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
  }
}
