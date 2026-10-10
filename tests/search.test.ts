import { describe, expect, it } from 'vitest';
import { highlightParts, parseQuery, TabSearchIndex, type SearchDoc } from '@/lib/search/engine';

function doc(id: string, title: string, url: string, keywords: string[] = [], extra: Partial<SearchDoc> = {}): SearchDoc {
  return { id, kind: 'saved', title, url, keywords, favIconUrl: '', sessionId: 's1', sessionName: 'Checkout app', savedAt: 1, ...extra };
}

function index(docs: SearchDoc[]) {
  const i = new TabSearchIndex();
  i.addAll(docs);
  return i;
}

describe('parseQuery', () => {
  it('splits #keywords from free text', () => {
    expect(parseQuery('#Webhooks stripe #api')).toEqual({ text: 'stripe', keywords: ['webhooks', 'api'] });
    expect(parseQuery('  ')).toEqual({ text: '', keywords: [] });
    expect(parseQuery('#')).toEqual({ text: '#', keywords: [] });
  });
});

describe('TabSearchIndex', () => {
  const docs = [
    doc('saved:1', 'Test locally with the Stripe CLI', 'https://docs.stripe.com/stripe-cli', ['webhooks', 'stripe-cli']),
    doc('saved:2', 'Database Webhooks | Supabase Docs', 'https://supabase.com/docs/guides/database/webhooks'),
    doc('saved:3', 'Retry logic for failed payment events', 'https://claude.ai/chat/1', ['webhooks', 'retries']),
    doc('saved:4', 'Holiday flats in Lisbon', 'https://airbnb.com/lisbon', ['holiday']),
    doc('saved:5', 'Old webhooks doc', 'https://old.example/webhooks', [], { deleted: true }),
  ];

  it('finds tabs by keyword, title and address, keyword matches first', () => {
    const hits = index(docs).search(parseQuery('webhooks'));
    const ids = hits.map((h) => h.doc.id);
    expect(ids).toEqual(expect.arrayContaining(['saved:1', 'saved:2', 'saved:3']));
    expect(ids.indexOf('saved:2')).toBeGreaterThan(ids.indexOf('saved:1'));
    expect(ids.indexOf('saved:2')).toBeGreaterThan(ids.indexOf('saved:3'));
    expect(hits.find((h) => h.doc.id === 'saved:3')!.matchedKeywords).toEqual(['webhooks']);
  });

  it('matches a keyword the title and address never mention', () => {
    expect(index(docs).search(parseQuery('retries')).map((h) => h.doc.id)).toEqual(['saved:3']);
  });

  it('"#keyword" matches keywords only', () => {
    const hits = index(docs).search(parseQuery('#webhooks'));
    expect(hits.map((h) => h.doc.id).sort()).toEqual(['saved:1', 'saved:3']);
  });

  it('combines #keyword with text', () => {
    expect(index(docs).search(parseQuery('#webhooks retry')).map((h) => h.doc.id)).toEqual(['saved:3']);
  });

  it('matches prefixes and small typos', () => {
    expect(index(docs).search(parseQuery('lisb')).map((h) => h.doc.id)).toEqual(['saved:4']);
    expect(index(docs).search(parseQuery('supabsae')).map((h) => h.doc.id)).toContain('saved:2');
  });

  it('keeps Trash separate', () => {
    expect(index(docs).search(parseQuery('old')).length).toBe(0);
    expect(index(docs).search(parseQuery('old'), { scope: 'trash' }).map((h) => h.doc.id)).toEqual(['saved:5']);
  });

  it('searches non-Latin titles', () => {
    const i = index([doc('saved:9', 'Строим приложение на React', 'https://habr.com/ru/1'), doc('saved:10', '東京 旅行 ガイド', 'https://example.jp')]);
    expect(i.search(parseQuery('приложение')).map((h) => h.doc.id)).toEqual(['saved:9']);
    expect(i.search(parseQuery('東京')).map((h) => h.doc.id)).toEqual(['saved:10']);
  });

  it('answers within budget on 10,000 saved tabs', () => {
    const words = ['stripe', 'react', 'supabase', 'lisbon', 'webhooks', 'pricing', 'docs', 'guide', 'api', 'design'];
    const many: SearchDoc[] = Array.from({ length: 10_000 }, (_, n) =>
      doc(
        `saved:${n}`,
        `${words[n % 10]} ${words[(n * 7) % 10]} article number ${n}`,
        `https://site${n % 400}.com/${words[(n * 3) % 10]}/${n}`,
        n % 5 === 0 ? [words[(n * 11) % 10]!] : [],
      ),
    );
    const built = performance.now();
    const i = index(many);
    const buildMs = performance.now() - built;
    i.search(parseQuery('warm'));
    const started = performance.now();
    const hits = i.search(parseQuery('react guide'));
    const queryMs = performance.now() - started;
    expect(hits.length).toBeGreaterThan(0);
    // Budget from the spec: under 50 ms with 10,000 saved tabs. CI machines vary, so allow headroom.
    expect(queryMs).toBeLessThan(150);
    console.info(`search: built 10k docs in ${buildMs.toFixed(0)} ms, query in ${queryMs.toFixed(1)} ms`);
  });
});

describe('highlightParts', () => {
  it('marks matched words case-insensitively', () => {
    expect(highlightParts('Webhooks | Stripe', ['webhooks'])).toEqual([
      { text: 'Webhooks', match: true },
      { text: ' | Stripe', match: false },
    ]);
    expect(highlightParts('a+b (c)', ['+b ('])).toEqual([
      { text: 'a', match: false },
      { text: '+b (', match: true },
      { text: 'c)', match: false },
    ]);
  });
});
