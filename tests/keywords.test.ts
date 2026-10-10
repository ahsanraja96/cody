import { describe, expect, it } from 'vitest';
import { cleanKeywords, MAX_KEYWORDS_PER_TAB, normalizeKeyword, parseKeywordInput, suggestKeywords } from '@/lib/keywords';

describe('normalizeKeyword', () => {
  it('lower-cases, trims, drops a leading # and hyphenates spaces', () => {
    expect(normalizeKeyword('  #Stripe Docs ')).toBe('stripe-docs');
    expect(normalizeKeyword('Checkout_App')).toBe('checkout_app');
  });

  it('keeps letters in any script', () => {
    expect(normalizeKeyword('Café')).toBe('café');
    expect(normalizeKeyword('東京')).toBe('東京');
    expect(normalizeKeyword('مرحبا')).toBe('مرحبا');
  });

  it('strips punctuation and collapses hyphens', () => {
    expect(normalizeKeyword('web---hooks!!')).toBe('web-hooks');
    expect(normalizeKeyword('---')).toBe('');
  });

  it('caps length', () => {
    expect(normalizeKeyword('a'.repeat(100))).toHaveLength(40);
  });
});

describe('cleanKeywords / parseKeywordInput', () => {
  it('dedupes after normalising and keeps order', () => {
    expect(cleanKeywords(['API', 'api', '#Api', 'react'])).toEqual(['api', 'react']);
  });

  it('caps the number per tab', () => {
    const many = Array.from({ length: 40 }, (_, i) => `k${i}`);
    expect(cleanKeywords(many)).toHaveLength(MAX_KEYWORDS_PER_TAB);
  });

  it('splits typed text on commas', () => {
    expect(parseKeywordInput('api, Stripe Docs, ,payments')).toEqual(['api', 'stripe-docs', 'payments']);
  });
});

describe('suggestKeywords', () => {
  it('ranks words found in both title and address first (the design example)', () => {
    expect(suggestKeywords('Webhooks | Stripe Documentation', 'https://docs.stripe.com/webhooks')).toEqual([
      'webhooks',
      'stripe',
      'documentation',
      'docs',
    ]);
  });

  it('drops stopwords, numbers, ids and the TLD', () => {
    const out = suggestKeywords('How to use the API in 2024', 'https://example.com/a1b2c3d4e5f6a7b8/123');
    expect(out).toContain('api');
    expect(out).toContain('example');
    expect(out).not.toContain('the');
    expect(out).not.toContain('2024');
    expect(out).not.toContain('com');
    expect(out).not.toContain('a1b2c3d4e5f6a7b8');
  });

  it('leaves out keywords already picked and respects the limit', () => {
    const out = suggestKeywords('Webhooks | Stripe Documentation', 'https://docs.stripe.com/webhooks', {
      exclude: ['stripe'],
      limit: 2,
    });
    expect(out).toEqual(['webhooks', 'documentation']);
  });

  it('works without a web address', () => {
    expect(suggestKeywords('Settings - Extensions', 'chrome://extensions')).toEqual(['settings', 'extensions']);
  });
});
