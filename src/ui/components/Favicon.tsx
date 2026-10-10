import { memo, useState } from 'react';
import { faviconUrl } from '@/lib/extUrl';
import { classifyUrl, displayHost } from '@/lib/urls';
import { cx } from '../cx';

const PALETTE = [
  ['#e9ecfb', '#3f4bc2'],
  ['#e5f4f1', '#0b6b62'],
  ['#fbeee4', '#9a4a12'],
  ['#f6e8f1', '#9a2c6a'],
  ['#eef3e2', '#4d6618'],
  ['#efe9f9', '#6a3fb0'],
  ['#e6f0fa', '#1f5c99'],
  ['#f4f0e1', '#7a5d0a'],
] as const;

function letterColors(host: string): readonly [string, string] {
  let hash = 0;
  for (let i = 0; i < host.length; i += 1) hash = (hash * 31 + host.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

/**
 * Favicon from Chrome's local cache. Pages without one (or non-web addresses) get a letter
 * avatar for the domain.
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
  const [failed, setFailed] = useState(false);
  const kind = classifyUrl(url);
  const host = displayHost(url) || '?';
  const style = { width: size, height: size, opacity: dim ? 0.45 : 1 };
  if (failed || kind !== 'web') {
    const [bg, fg] = letterColors(host);
    return (
      <span
        aria-hidden="true"
        className={cx('inline-flex shrink-0 items-center justify-center rounded font-semibold', className)}
        style={{ ...style, background: bg, color: fg, fontSize: Math.max(9, Math.round(size * 0.6)) }}
      >
        {host.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      aria-hidden="true"
      alt=""
      src={faviconUrl(url, size > 16 ? 32 : 16)}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      className={cx('shrink-0 rounded-[3px]', className)}
      style={style}
    />
  );
});
