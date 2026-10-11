/**
 * The sign-in email: a 6-digit code, sent through Resend (resend.com). Web-standard APIs only.
 */

export type CodePurpose = 'signin' | 'trial';

export interface Mailer {
  /** Sends the code; throws MailError when the email service refuses or can't be reached. */
  sendCode(email: string, code: string, purpose: CodePurpose): Promise<void>;
}

/** The email couldn't be sent. The message is safe to log: no key, no address, no code. */
export class MailError extends Error {
  override name = 'MailError';
}

export const RESEND_URL = 'https://api.resend.com/emails';

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The email for a code: subject, plain text and simple HTML. */
export function codeEmail(code: string, purpose: CodePurpose): { subject: string; text: string; html: string } {
  const action = purpose === 'trial' ? 'Enter it to start your 7-day Pro AI trial.' : 'Enter it to sign in to Tabfold Pro.';
  const ignore = 'If you didn’t ask for it, you can ignore this email.';
  const safeCode = escapeHtml(code);
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Your Tabfold code</title></head>
<body style="margin: 0; padding: 24px; background: #ffffff; color: #1f2328; font: 16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
<div style="max-width: 480px; margin: 0 auto">
<p style="margin: 0 0 16px">Your Tabfold code is:</p>
<p style="margin: 0 0 16px; font: 700 32px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 6px; color: #1f2328">${safeCode}</p>
<p style="margin: 0 0 16px">It works for 10 minutes. ${escapeHtml(action)}</p>
<p style="margin: 0; color: #59636e; font-size: 14px">${escapeHtml(ignore)}</p>
</div>
</body>
</html>`;
  return {
    subject: `Your Tabfold code: ${code}`,
    text: `Your Tabfold code is ${code}. It works for 10 minutes.\n\n${action}\n\n${ignore}\n`,
    html,
  };
}

export interface ResendOptions {
  apiKey: string;
  /** The sender, e.g. `Tabfold <hello@tabfold.app>` (a domain verified in Resend). */
  from: string;
  fetch?: typeof fetch;
}

export function createResendMailer(options: ResendOptions): Mailer {
  const fetchFn: typeof fetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  return {
    async sendCode(email, code, purpose) {
      // A missing setting is a set-up problem: a plain Error, so the route answers 500.
      if (!options.apiKey) throw new Error('RESEND_API_KEY is not set');
      if (!options.from) throw new Error('EMAIL_FROM is not set');
      const { subject, text, html } = codeEmail(code, purpose);
      let response: Response;
      try {
        response = await fetchFn(RESEND_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: options.from, to: [email], subject, text, html }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new MailError('Resend could not be reached');
      }
      if (!response.ok) {
        // Resend's error name (e.g. validation_error) says what went wrong without quoting the email.
        const json: unknown = await response.json().catch(() => null);
        const name = typeof json === 'object' && json !== null && 'name' in json && typeof json.name === 'string' ? json.name : '';
        throw new MailError(`Resend answered ${response.status}${name ? ` (${name.slice(0, 60)})` : ''}`);
      }
    },
  };
}
