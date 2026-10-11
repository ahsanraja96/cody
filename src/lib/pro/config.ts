/**
 * Build-time configuration for Pro (set in `.env` or the environment when building):
 * - WXT_TABFOLD_API: the server's base URL, e.g. https://<project>.supabase.co/functions/v1/tabfold
 * Without it the build is Free-only: Pro screens explain that Pro isn't available yet.
 */
export const PRO_CONFIG = {
  apiUrl: ((import.meta.env.WXT_TABFOLD_API as string | undefined) ?? '').replace(/\/+$/, ''),
};

export function proConfigured(): boolean {
  return !!PRO_CONFIG.apiUrl;
}
