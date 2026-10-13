/**
 * Tabfold's emails, sent by SMTP (Zoho Mail, smtp.zoho.eu): the sign-in code, and the invitation to
 * a team. Web-standard APIs only: the TLS connection is passed in (`Deno.connectTls` in index.ts).
 */

export type CodePurpose = 'signin' | 'trial';

export interface Mailer {
  /** Sends the code; throws MailError when the email service refuses or can't be reached. */
  sendCode(email: string, code: string, purpose: CodePurpose): Promise<void>;
  /** Invites someone to a team; throws MailError when the email service refuses or can't be reached. */
  sendInvite(email: string, teamName: string, inviterEmail: string): Promise<void>;
}

/** Where the invitation's link goes when nothing else is set (the `web/` site). */
export const DEFAULT_SITE_URL = 'https://tabfold.truewidgets.com';

/** The email couldn't be sent. The message is safe to log: no key, no address, no code. */
export class MailError extends Error {
  override name = 'MailError';
}

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

/** A TLS connection to the SMTP server, as `Deno.connectTls` gives one. */
export interface SmtpConnection {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void;
}

export type SmtpConnect = (host: string, port: number) => Promise<SmtpConnection>;

export interface SmtpOptions {
  /** Default smtp.zoho.eu (Zoho's EU data centre; smtp.zoho.com for accounts on zoho.com). */
  host?: string;
  /** Default 465: TLS from the first byte. Supabase blocks 25 and 587, so STARTTLS isn't offered. */
  port?: number;
  /** The Zoho mailbox that signs in, e.g. hello@truewidgets.com. */
  user: string;
  /** Its app-specific password (Zoho › My Account › Security › App passwords). */
  pass: string;
  /** The sender, e.g. `Tabfold <hello@truewidgets.com>`: the mailbox or one of its aliases. */
  from: string;
  /** Where invitations link to (`SHARE_BASE_URL`, the `web/` site). Default https://tabfold.truewidgets.com. */
  siteUrl?: string;
  connect: SmtpConnect;
  /** The whole conversation's limit. Default 20 s. */
  timeoutMs?: number;
  /** For tests: the Date and Message-ID headers. */
  now?: () => number;
  randomId?: () => string;
}

export const ZOHO_SMTP_HOST = 'smtp.zoho.eu';
export const SMTP_PORT = 465;

/** `Name <address>` or a bare address → its parts. */
export function parseSender(from: string): { name: string; address: string } {
  const match = /^\s*(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(from);
  if (match) return { name: match[1]!.replace(/^"(.*)"$/, '$1'), address: match[2]! };
  return { name: '', address: from.trim() };
}

const utf8 = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * A header's text: as it is when it is short printable ASCII, otherwise as RFC 2047 encoded words
 * of whole characters, at most 75 characters each, folded onto continuation lines.
 */
export function encodeHeader(value: string): string {
  const clean = oneLine(value);
  if (/^[\x20-\x7e]*$/.test(clean) && clean.length <= 66) return clean;
  const words: string[] = [];
  let chunk: number[] = [];
  for (const char of clean) {
    const bytes = utf8.encode(char);
    if (chunk.length + bytes.length > 45) {
      words.push(`=?UTF-8?B?${base64(Uint8Array.from(chunk))}?=`);
      chunk = [];
    }
    chunk.push(...bytes);
  }
  if (chunk.length || !words.length) words.push(`=?UTF-8?B?${base64(Uint8Array.from(chunk))}?=`);
  return words.join('\r\n ');
}

/** Base64 in 76-character lines (never starts with a dot, never too long). */
const base64Lines = (text: string) => base64(utf8.encode(text)).replace(/.{1,76}/g, '$&\r\n');

/** The whole message: headers, then plain text and HTML as alternatives. CRLF line ends. */
export function smtpMessage(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  date: Date;
  messageId: string;
  boundary: string;
}): string {
  const sender = parseSender(input.from);
  const from = sender.name ? `${encodeHeader(sender.name)} <${sender.address}>` : sender.address;
  return [
    `From: ${from}`,
    `To: ${oneLine(input.to)}`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${input.date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${input.messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${input.boundary}"`,
    '',
    `--${input.boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(input.text) + `--${input.boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(input.html) + `--${input.boundary}--`,
    '',
  ].join('\r\n');
}

const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Reads SMTP replies (`250-…` lines, then `250 …`) from the connection. */
function replyReader(readable: ReadableStream<Uint8Array>) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function line(): Promise<string> {
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        const text = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        return text;
      }
      const { value, done } = await reader.read();
      if (done) throw new MailError('closed');
      buffer += decoder.decode(value, { stream: true });
    }
  }
  return {
    /** The reply's code and its lines' text (EHLO's lines list what the server offers). */
    async reply(): Promise<{ code: number; lines: string[] }> {
      const lines: string[] = [];
      for (;;) {
        const text = await line();
        lines.push(text.slice(4));
        if (!/^\d{3}/.test(text)) throw new MailError('garbled');
        if (text[3] !== '-') return { code: Number(text.slice(0, 3)), lines };
      }
    },
    /** Ends a read that is waiting (the time limit). */
    cancel: () => reader.cancel().catch(() => undefined),
    release: () => reader.releaseLock(),
  };
}

export function createSmtpMailer(options: SmtpOptions): Mailer {
  const host = options.host || ZOHO_SMTP_HOST;
  const port = options.port || SMTP_PORT;

  async function send(email: string, message: { subject: string; text: string; html: string }): Promise<void> {
    // A missing setting is a set-up problem: a plain Error, so the route answers 500.
    if (!options.user) throw new Error('SMTP_USER is not set');
    if (!options.pass) throw new Error('SMTP_PASS is not set');
    if (!options.from) throw new Error('EMAIL_FROM is not set');
    const sender = parseSender(options.from);
    if (/[\r\n<>]/.test(email) || /[\r\n<>]/.test(sender.address)) throw new MailError('An address has a character SMTP can’t carry');

    let connection: SmtpConnection;
    try {
      connection = await options.connect(host, port);
    } catch {
      throw new MailError(`${host}:${port} could not be reached`);
    }
    const replies = replyReader(connection.readable);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void replies.cancel();
      try {
        connection.close();
      } catch {
        // already closed
      }
    }, options.timeoutMs ?? 20_000);
    const writer = connection.writable.getWriter();
    // Where the conversation is, for the error message (never the address, the code or the password).
    let step = 'greeting';
    const expect = async (codes: number[]) => {
      const reply = await replies.reply();
      if (!codes.includes(reply.code)) throw new MailError(`SMTP answered ${reply.code} at ${step}`);
      return reply;
    };
    const command = async (name: string, line: string, codes: number[]) => {
      step = name;
      await writer.write(utf8.encode(`${line}\r\n`));
      return expect(codes);
    };
    try {
      await expect([220]);
      const domain = sender.address.split('@')[1] || 'localhost';
      const hello = await command('EHLO', `EHLO ${domain}`, [250]);
      const auth = hello.lines.find((line) => /^AUTH\b/i.test(line)) ?? '';
      if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
        await command('AUTH', `AUTH PLAIN ${base64(utf8.encode(`\u0000${options.user}\u0000${options.pass}`))}`, [235]);
      } else {
        await command('AUTH', 'AUTH LOGIN', [334]);
        await command('AUTH', base64(utf8.encode(options.user)), [334]);
        await command('AUTH', base64(utf8.encode(options.pass)), [235]);
      }
      await command('MAIL FROM', `MAIL FROM:<${sender.address}>`, [250]);
      await command('RCPT TO', `RCPT TO:<${email}>`, [250, 251]);
      await command('DATA', 'DATA', [354]);
      const now = new Date(options.now?.() ?? Date.now());
      const id = options.randomId?.() ?? randomHex();
      const body = smtpMessage({
        from: options.from,
        to: email,
        ...message,
        date: now,
        messageId: `<${id}@${domain}>`,
        boundary: `tabfold-${id}`,
      });
      // Dot-stuffing: a line that starts with "." gets another one (base64 lines never do).
      step = 'the message';
      await writer.write(utf8.encode(`${body.replace(/^\./gm, '..')}.\r\n`));
      await expect([250]);
      step = 'QUIT';
      await writer.write(utf8.encode('QUIT\r\n')).catch(() => undefined);
    } catch (error) {
      if (timedOut) throw new MailError(`SMTP timed out at ${step}`);
      if (error instanceof MailError && error.message !== 'closed' && error.message !== 'garbled') throw error;
      throw new MailError(`SMTP connection failed at ${step}`);
    } finally {
      clearTimeout(timer);
      try {
        replies.release();
        writer.releaseLock();
        connection.close();
      } catch {
        // already closed
      }
    }
  }

  return {
    sendCode: (email, code, purpose) => send(email, codeEmail(code, purpose)),
    sendInvite: (email, teamName, inviterEmail) =>
      send(email, inviteEmail(teamName, inviterEmail, options.siteUrl || DEFAULT_SITE_URL)),
  };
}
