import type { SearchDoc, SearchHit } from './engine';

export type SearchRequest =
  | { id: number; type: 'warm' }
  | {
      id: number;
      type: 'query';
      query: string;
      open: SearchDoc[];
      limit?: number;
      scope?: 'live' | 'trash';
    };

export interface SearchResponse {
  id: number;
  open: SearchHit[];
  saved: SearchHit[];
  savedTotal: number;
  indexedTabs: number;
  ms: number;
}
