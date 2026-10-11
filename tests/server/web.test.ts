import { describe, expect, it } from 'vitest';

// The public site (web/) has no build step: these check the files as Netlify will serve them.

interface NodeFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string): string[];
}

const fs = (globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): NodeFs } }).process.getBuiltinModule('node:fs');
const WEB = new URL('../../web/', import.meta.url).pathname;
const read = (name: string) => fs.readFileSync(`${WEB}${name}`, 'utf8');

describe('web/', () => {
  it('has the pages, the settings and Netlify’s files', () => {
    expect(fs.readdirSync(WEB).sort()).toEqual(
      ['README.md', '_headers', '_redirects', 'config.js', 'favicon.svg', 'home.js', 'index.html', 's.html', 's.js', 'style.css'].sort(),
    );
  });

  it('sends every /s/<id> to s.html', () => {
    expect(read('_redirects').trim()).toBe('/s/*  /s.html  200');
  });

  it('loads only its own files, by absolute paths (s.html is served at /s/<id>)', () => {
    for (const page of ['s.html', 'index.html']) {
      const html = read(page);
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
      const assets = refs.filter((ref) => /\.(js|css|svg)$/.test(ref));
      expect(assets.length, page).toBeGreaterThan(0);
      for (const asset of assets) expect(asset, `${page}: ${asset}`).toMatch(/^\/[a-z.]+$/);
      // No inline script, style or event handler: the Content-Security-Policy in _headers allows none.
      expect(html, page).not.toMatch(/<script>|<style>|\sstyle="|\son[a-z]+="/);
    }
  });

  it('never builds markup from a shared folder', () => {
    const script = read('s.js');
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(script).toContain("url.protocol === 'https:' || url.protocol === 'http:'");
    expect(script).toContain("{ type: 'tabfold-save-share', id: id }");
  });

  it('keeps the three settings in config.js', () => {
    const settings: Record<string, unknown> = {};
    new Function('window', read('config.js'))({ set TABFOLD_CONFIG(value: Record<string, unknown>) { Object.assign(settings, value); } });
    expect(Object.keys(settings).sort()).toEqual(['API_URL', 'EXTENSION_ID', 'STORE_URL']);
  });

  it('keeps shared folders out of search engines and sends no referrer', () => {
    expect(read('_headers')).toMatch(/\/s\/\*\n\s+X-Robots-Tag: noindex/);
    expect(read('_headers')).toContain('Referrer-Policy: no-referrer');
    expect(read('s.html')).toContain('<meta name="robots" content="noindex">');
    expect(read('s.html')).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('follows the system’s light or dark', () => {
    expect(read('style.css')).toContain('@media (prefers-color-scheme: dark)');
  });
});
