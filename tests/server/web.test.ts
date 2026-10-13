import { describe, expect, it } from 'vitest';

// The public site (web/) has no build step: these check the files as Vercel will serve them.

interface NodeFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string): string[];
}

const fs = (globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): NodeFs } }).process.getBuiltinModule('node:fs');
const WEB = new URL('../../web/', import.meta.url).pathname;
const read = (name: string) => fs.readFileSync(`${WEB}${name}`, 'utf8');

describe('web/', () => {
  it('has the pages, the settings and Vercel’s file', () => {
    expect(fs.readdirSync(WEB).sort()).toEqual(
      [
        'README.md',
        'config.js',
        'favicon.svg',
        'home.js',
        'index.html',
        'privacy.html',
        's.html',
        's.js',
        'style.css',
        'terms.html',
        'vercel.json',
      ].sort(),
    );
  });

  it('sends every /s/<id> to s.html, and /privacy and /terms to their pages', () => {
    const vercel = JSON.parse(read('vercel.json'));
    // With clean URLs, s.html is /s (a rewrite to /s.html finds nothing), privacy.html is /privacy.
    expect(vercel.cleanUrls).toBe(true);
    expect(vercel.rewrites).toEqual([{ source: '/s/:id', destination: '/s' }]);
  });

  it('loads only its own files, by absolute paths (s.html is served at /s/<id>)', () => {
    for (const page of ['s.html', 'index.html', 'privacy.html', 'terms.html']) {
      const html = read(page);
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
      const assets = refs.filter((ref) => /\.(js|css|svg)$/.test(ref));
      expect(assets.length, page).toBeGreaterThan(0);
      for (const asset of assets) expect(asset, `${page}: ${asset}`).toMatch(/^\/[a-z.]+$/);
      // No inline script, style or event handler: the Content-Security-Policy in vercel.json allows none.
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
    const headers: { source: string; headers: { key: string; value: string }[] }[] = JSON.parse(read('vercel.json')).headers;
    const on = (source: string) => Object.fromEntries(headers.find((rule) => rule.source === source)!.headers.map((h) => [h.key, h.value]));
    expect(on('/s/(.*)')['X-Robots-Tag']).toBe('noindex');
    expect(on('/s(.html)?')['X-Robots-Tag']).toBe('noindex');
    expect(on('/(.*)')['Referrer-Policy']).toBe('no-referrer');
    expect(on('/(.*)')['Content-Security-Policy']).toContain("script-src 'self';");
    expect(read('s.html')).toContain('<meta name="robots" content="noindex">');
    expect(read('s.html')).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('follows the system’s light or dark', () => {
    expect(read('style.css')).toContain('@media (prefers-color-scheme: dark)');
  });

  it('links the privacy policy and terms from every page’s footer', () => {
    for (const page of ['index.html', 's.html', 'privacy.html', 'terms.html']) {
      const footer = /<footer class="site-foot">([\s\S]*?)<\/footer>/.exec(read(page))?.[1] ?? '';
      expect(footer, page).toContain('href="/privacy"');
      expect(footer, page).toContain('href="/terms"');
    }
  });

  it('has every placeholder filled in: the owner, the date, the contact, the law and the region', () => {
    for (const page of ['privacy.html', 'terms.html']) {
      const html = read(page);
      expect(html, page).not.toContain('class="placeholder"');
      expect(html, page).not.toMatch(/\[[A-Z][^\]]*\]/);
      expect(html, page).toContain('Truewidgets, a division of Loom Factor Ltd');
      expect(html, page).toContain('Effective 13 October 2026');
      expect(html, page).toContain('<a href="mailto:hello@truewidgets.com">hello@truewidgets.com</a>');
    }
    expect(read('terms.html')).toContain('governed by the laws of England and Wales');
    expect(read('privacy.html')).toContain('runs on Supabase (supabase.com) in\n    the United Kingdom (London).');
  });

  it('shows a shared folder’s note as text, under its name, only when there is one', () => {
    const html = read('s.html');
    expect(html.indexOf('id="name"')).toBeLessThan(html.indexOf('id="note"'));
    expect(html).toContain('<p class="note" id="note" hidden></p>');
    const script = read('s.js');
    expect(script).toContain("$('note').textContent = share.note;");
    expect(script).toContain("$('note').hidden = !share.note;");
  });
});
