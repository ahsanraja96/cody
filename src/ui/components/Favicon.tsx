import { memo, useState, type ReactNode } from 'react';
import { Folder, Image as ImageIcon, Link2, Puzzle, Settings, ShoppingBag } from 'lucide-react';
import { faviconUrl } from '@/lib/extUrl';
import { classifyUrl, displayHost } from '@/lib/urls';
import { cx } from '../cx';

/** Pages that aren't ordinary web pages, which get a type icon (and, in rows, a text badge) instead of a favicon. */
export type SpecialPage = 'browser' | 'web-store' | 'file' | 'extension' | 'data' | 'text';

const WEB_STORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/i;

export function specialPage(url: string): SpecialPage | null {
  if (WEB_STORE.test(url)) return 'web-store';
  switch (classifyUrl(url)) {
    case 'web':
    case 'blank':
    case 'own':
      return null;
    case 'browser':
      return 'browser';
    case 'extension':
      return 'extension';
    case 'file':
      return 'file';
    case 'data':
      return 'data';
    default:
      return 'text';
  }
}

/** The badge text for a special page, as in the session detail ("Chrome page", "Local file"...). */
export const SPECIAL_PAGE_LABEL: Record<SpecialPage, string> = {
  browser: 'Chrome page',
  'web-store': 'Web Store',
  file: 'Local file',
  extension: 'Extension page',
  data: 'Saved in page',
  text: 'Saved as text',
};

function typeIcon(kind: SpecialPage, size: number): ReactNode {
  const props = { size, strokeWidth: 2, 'aria-hidden': true } as const;
  switch (kind) {
    case 'browser':
      return <Settings {...props} />;
    case 'web-store':
      return <ShoppingBag {...props} />;
    case 'file':
      return <Folder {...props} />;
    case 'extension':
      return <Puzzle {...props} />;
    case 'data':
      return <ImageIcon {...props} />;
    case 'text':
      return <Link2 {...props} />;
  }
}

/**
 * Chrome's favicon cache answers with a generic globe (not an error) for pages it has no icon for.
 * Each icon is compared once with that globe so those pages get the letter tile instead.
 */
const checked = new Map<string, boolean>();
const defaultSignatures = new Map<number, Promise<string | null>>();

function signature(img: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 16, 16);
    const data = ctx.getImageData(0, 0, 16, 16).data;
    let hash = 0;
    for (let i = 0; i < data.length; i += 1) hash = (hash * 31 + data[i]!) | 0;
    return String(hash);
  } catch {
    return null;
  }
}

function defaultSignature(size: number): Promise<string | null> {
  let promise = defaultSignatures.get(size);
  if (!promise) {
    promise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(signature(img));
      img.onerror = () => resolve(null);
      img.src = faviconUrl('https://tabfold-no-icon.invalid/', size);
    });
    defaultSignatures.set(size, promise);
  }
  return promise;
}

/** The first character of the host without "www.", for the letter tile. */
export function avatarLetter(url: string): string {
  const host = displayHost(url).replace(/^www\./, '');
  const first = [...host][0] ?? '?';
  return first.toUpperCase();
}

/**
 * Favicon from Chrome's local cache. Pages without one (or where it fails to load) get the first
 * letter of the host on a neutral tile, so it never competes with real icons; non-web pages get a
 * type icon on the same tile. Works in both themes because the tile uses the theme tokens.
 */
export const Favicon = memo(function Favicon({
  url,
  size = 16,
  dim = false,
  className,
}: {
  url: string;
  size?: number;
  dim?: boolean;
  className?: string;
}) {
  const iconSize = size > 16 ? 32 : 16;
  const src = faviconUrl(url, iconSize);
  const [state, setState] = useState<'unknown' | 'icon' | 'none'>(() => {
    const known = checked.get(src);
    return known === undefined ? 'unknown' : known ? 'icon' : 'none';
  });
  const failed = state === 'none';
  const special = specialPage(url);
  const style = { width: size, height: size, opacity: dim ? 0.45 : 1 };
  const tile = cx(
    'inline-flex shrink-0 items-center justify-center rounded border bg-hover text-text-2 font-semibold leading-none select-none',
    className,
  );
  if (special && special !== 'web-store') {
    return (
      <span aria-hidden="true" className={cx(tile, 'border-border-strong')} style={style}>
        {typeIcon(special, Math.max(9, Math.round(size * 0.68)))}
      </span>
    );
  }
  const letter = (
    <span aria-hidden="true" className={cx(tile, 'border-border')} style={{ ...style, fontSize: Math.max(8, Math.round(size * 0.62)) }}>
      {avatarLetter(url)}
    </span>
  );
  if (failed || classifyUrl(url) !== 'web') return letter;
  const settle = (value: boolean) => {
    checked.set(src, value);
    setState(value ? 'icon' : 'none');
  };
  return (
    <img
      aria-hidden="true"
      alt=""
      src={src}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={(e) => {
        if (state !== 'unknown') return;
        const img = e.currentTarget;
        const mine = signature(img);
        void defaultSignature(iconSize).then((generic) => settle(!(mine && generic && mine === generic)));
      }}
      onError={() => settle(false)}
      className={cx('shrink-0 rounded-[3px]', className)}
      // Hidden until checked, so a generic globe never flashes before the letter tile.
      style={{ ...style, visibility: state === 'icon' ? 'visible' : 'hidden' }}
    />
  );
});
