/**
 * Tabfold's public site (the `web/` folder: shared folders, the privacy policy, the terms), set at
 * build time with WXT_SHARE_ORIGIN; https://tabfold.truewidgets.com by default. Page-safe (no worker APIs).
 */
export const SITE_ORIGIN = (() => {
  const value = ((import.meta.env.WXT_SHARE_ORIGIN as string | undefined) ?? '').trim() || 'https://tabfold.truewidgets.com';
  try {
    return new URL(value).origin;
  } catch {
    return 'https://tabfold.truewidgets.com';
  }
})();

/** An address on the public site: `siteUrl('/privacy')`. */
export function siteUrl(path: string): string {
  return `${SITE_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
}
