/**
 * Tabfold's emails, sent through Resend (resend.com): the sign-in code, and the invitation to a
 * team. Web-standard APIs only.
 */

export type CodePurpose = 'signin' | 'trial';

export interface Mailer {
  /** Sends the code; throws MailError when the email service refuses or can't be reached. */
  sendCode(email: string, code: string, purpose: CodePurpose): Promise<void>;
  /** Invites someone to a team; throws MailError when the email service refuses or can't be reached. */
  sendInvite(email: string, teamName: string, inviterEmail: string): Promise<void>;
}

/** Where the invitation's link goes when nothing else is set (the `web/` site). */
export const DEFAULT_SITE_URL = 'https://tabfold.app';

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

/** One line, no control characters: team names and addresses go into a subject line. */
const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The invitation to a team: subject, plain text and simple HTML, with a link to the Tabfold site. */
export function inviteEmail(teamName: string, inviterEmail: string, siteUrl: string): { subject: string; text: string; html: string } {
  const team = oneLine(teamName) || 'a team';
  const inviter = oneLine(inviterEmail) || 'Someone';
  const link = siteUrl.replace(/\/+$/, '') || DEFAULT_SITE_URL;
  const lead = `${inviter} invited you to ${team} on Tabfold.`;
  const how = 'Install Tabfold and sign in with this email to join.';
  const ignore = 'If you don’t know them, you can ignore this email.';
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(lead)}</title></head>
<body style="margin: 0; padding: 24px; background: #ffffff; color: #1f2328; font: 16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
<div style="max-width: 480px; margin: 0 auto">
<p style="margin: 0 0 16px">${escapeHtml(lead)}</p>
<p style="margin: 0 0 16px">${escapeHtml(how)}</p>
<p style="margin: 0 0 16px"><a href="${escapeHtml(link)}" style="color: #4f5bd5; font-weight: 600">Get Tabfold</a></p>
<p style="margin: 0; color: #59636e; font-size: 14px">${escapeHtml(ignore)}</p>
</div>
</body>
</html>`;
  return {
    subject: `${inviter} invited you to ${team} on Tabfold`,
    text: `${lead} ${how}\n\n${link}\n\n${ignore}\n`,
    html,
  };
}

export interface ResendOptions {
  apiKey: string;
  /** The sender, e.g. `Tabfold <hello@tabfold.app>` (a domain verified in Resend). */
  from: string;
  /** Where invitations link to (`SHARE_BASE_URL`, the `web/` site). Default https://tabfold.app. */
  siteUrl?: string;
  fetch?: typeof fetch;
}

export function createResendMailer(options: ResendOptions): Mailer {
  const fetchFn: typeof fetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  async function send(email: string, message: { subject: string; text: string; html: string }): Promise<void> {
    // A missing setting is a set-up problem: a plain Error, so the route answers 500.
    if (!options.apiKey) throw new Error('RESEND_API_KEY is not set');
    if (!options.from) throw new Error('EMAIL_FROM is not set');
    let response: Response;
    try {
      response = await fetchFn(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: options.from, to: [email], ...message }),
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
  }

  return {
    sendCode: (email, code, purpose) => send(email, codeEmail(code, purpose)),
    sendInvite: (email, teamName, inviterEmail) =>
      send(email, inviteEmail(teamName, inviterEmail, options.siteUrl || DEFAULT_SITE_URL)),
  };
}
