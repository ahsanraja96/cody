/**
 * Build-time configuration for Pro (set in `.env` or the environment when building):
 * - WXT_EXTPAY_ID: the extension's id on ExtensionPay.com.
 * - WXT_TABFOLD_API: the server's base URL, e.g. https://<project>.supabase.co/functions/v1/tabfold
 * Without them the build is Free-only: Pro screens explain that Pro isn't available yet.
 */
export const PRO_CONFIG = {
  extpayId: (import.meta.env.WXT_EXTPAY_ID as string | undefined) ?? '',
  apiUrl: ((import.meta.env.WXT_TABFOLD_API as string | undefined) ?? '').replace(/\/+$/, ''),
};

export function proConfigured(): boolean {
  return !!PRO_CONFIG.extpayId && !!PRO_CONFIG.apiUrl;
}

export const EXTPAY_HOST = 'https://extensionpay.com';
