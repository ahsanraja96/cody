import { describe, expect, it } from 'vitest';
import { capFavicon, capUrl, classifyUrl, displayHost, MAX_URL_LENGTH, unwrapViewerUrl } from '@/lib/urls';
import { OWN } from './fixtures';

describe('classifyUrl', () => {
  it.each([
    ['https://example.com', 'web'],
    ['http://localhost:5173/', 'web'],
    ['chrome://newtab/', 'blank'],
    ['about:blank', 'blank'],
    ['edge://newtab/', 'blank'],
    ['chrome://settings/', 'browser'],
    ['edge://settings', 'browser'],
    ['view-source:https://example.com', 'browser'],
    [`${OWN}library.html`, 'own'],
    ['chrome-extension://otherextension/page.html', 'extension'],
    ['file:///Users/me/a.pdf', 'file'],
    ['data:text/html,hello', 'data'],
    ['javascript:alert(1)', 'data'],
    ['zotero://select/items', 'other'],
    ['', 'blank'],
  ])('%s is %s', (url, kind) => {
    expect(classifyUrl(url, OWN)).toBe(kind);
  });
});

describe('url helpers', () => {
  it('unwraps the built-in PDF viewer', () => {
    const wrapped = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?src=https%3A%2F%2Fa.com%2Fdoc.pdf';
    expect(unwrapViewerUrl(wrapped)).toBe('https://a.com/doc.pdf');
    expect(unwrapViewerUrl('https://a.com/doc.pdf')).toBe('https://a.com/doc.pdf');
  });

  it('caps very long addresses and flags them', () => {
    const long = `data:text/plain,${'x'.repeat(MAX_URL_LENGTH * 2)}`;
    const capped = capUrl(long);
    expect(capped.truncated).toBe(true);
    expect(capped.url).toHaveLength(MAX_URL_LENGTH);
    expect(capUrl('https://a.com').truncated).toBe(false);
  });

  it('drops big data: favicons', () => {
    expect(capFavicon(`data:image/png;base64,${'A'.repeat(10_000)}`)).toBe('');
    expect(capFavicon('https://a.com/favicon.ico')).toBe('https://a.com/favicon.ico');
  });

  it('shows a readable host', () => {
    expect(displayHost('https://www.github.com/acme')).toBe('github.com');
    expect(displayHost('file:///tmp/a.html')).toBe('file');
    expect(displayHost('chrome://settings')).toBe('settings');
    expect(displayHost('chrome-extension://abcdefghijklmnop/page.html')).toBe('extension');
  });
});
