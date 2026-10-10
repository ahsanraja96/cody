import { describe, expect, it } from 'vitest';
import { categorize, groupByCategory } from '@/lib/categories';

describe('categories', () => {
  it('sorts sites by kind, matching subdomains and the most specific rule', () => {
    expect(categorize('https://github.com/tabfold/extension/issues')).toBe('dev');
    expect(categorize('https://gist.github.com/x')).toBe('dev');
    expect(categorize('https://docs.google.com/document/d/1')).toBe('docs');
    expect(categorize('https://mail.google.com/mail/u/0')).toBe('mail');
    expect(categorize('https://www.youtube.com/watch?v=1')).toBe('video');
    expect(categorize('https://claude.ai/chat/1')).toBe('ai');
    expect(categorize('https://www.amazon.com/dp/1')).toBe('shopping');
    expect(categorize('https://en.wikipedia.org/wiki/Tab')).toBe('reading');
    expect(categorize('http://localhost:5173/')).toBe('dev');
    expect(categorize('https://docs.stripe.com/webhooks')).toBe('docs');
    expect(categorize('https://dashboard.stripe.com/')).toBe('other');
    expect(categorize('chrome://settings')).toBe('other');
    expect(categorize('not a url')).toBe('other');
  });

  it('groups newest first, and puts the group with the newest tab first', () => {
    const items = [
      { url: 'https://github.com/a', at: 1 },
      { url: 'https://claude.ai/b', at: 5 },
      { url: 'https://github.com/c', at: 3 },
      { url: 'https://example.com/d', at: 2 },
    ];
    const groups = groupByCategory(items, (i) => i.url, (i) => i.at);
    expect(groups.map((g) => g.category.id)).toEqual(['ai', 'dev', 'other']);
    expect(groups[1]!.items.map((i) => i.at)).toEqual([3, 1]);
    expect(groups[1]!.category).toMatchObject({ name: 'Dev', color: 'blue' });
  });
});
