import { describe, expect, it, vi } from 'vitest';
import {
  codeEmail,
  createSmtpMailer,
  encodeHeader,
  inviteEmail,
  parseSender,
  type SmtpConnection,
  type SmtpOptions,
} from '../../server/supabase/functions/tabfold/mail.ts';

describe('the invitation email', () => {
  it('says who invited whom to what, and how to join', () => {
    const email = inviteEmail('Truewidgets', 'hello@truewidgets.com', 'https://tabfold.truewidgets.com/');
    expect(email.subject).toBe('hello@truewidgets.com invited you to Truewidgets on Tabfold');
    expect(email.text).toBe(
      'hello@truewidgets.com invited you to Truewidgets on Tabfold. Install Tabfold and sign in with this email to join.\n\n' +
        'https://tabfold.truewidgets.com\n\nIf you don’t know them, you can ignore this email.\n',
    );
    expect(email.html).toContain('<a href="https://tabfold.truewidgets.com"');
    expect(email.html).toContain('Install Tabfold and sign in with this email to join.');
  });

  it('escapes the team’s name and keeps it on one line', () => {
    const email = inviteEmail('<b>Evil</b>\r\nBcc: x@y.z', 'a@b.co', 'https://tabfold.truewidgets.com');
    expect(email.subject).toBe('a@b.co invited you to <b>Evil</b> Bcc: x@y.z on Tabfold');
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
    expect(email.html).not.toContain('<b>Evil');
  });
});

describe('the code email', () => {
  it('says what the code is for', () => {
    const trial = codeEmail('481920', 'trial');
    expect(trial.subject).toBe('Your Tabfold code: 481920');
    expect(trial.text).toBe(
      'Your Tabfold code is 481920. It works for 10 minutes.\n\nEnter it to start your 7-day Pro AI trial.\n\n' +
        'If you didn’t ask for it, you can ignore this email.\n',
    );
    const signin = codeEmail('000123', 'signin');
    expect(signin.subject).toBe('Your Tabfold code: 000123');
    expect(signin.text).toContain('Enter it to sign in to Tabfold Pro.');
    expect(signin.text).not.toContain('trial');
  });

  it('has simple HTML with the code large', () => {
    const { html } = codeEmail('481920', 'signin');
    expect(html).toContain('<html lang="en">');
    expect(html).toMatch(/font: 700 32px[^>]*>481920<\/p>/);
    expect(html).toContain('It works for 10 minutes. Enter it to sign in to Tabfold Pro.');
    expect(html).toContain('If you didn’t ask for it, you can ignore this email.');
    expect(codeEmail('<b>', 'trial').html).toContain('&lt;b&gt;');
  });
});

// Base64 both ways, with web APIs only (the tests are type-checked without Node's types).
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const unb64 = (data: string) => new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));

/**
 * A pretend SMTP server on the other end of a connection: answers each command from `replies`
 * (by the command's first word; the default is a happy Zoho), and records what the client sent.
 */
function fakeSmtp(replies: Record<string, string> = {}, { greeting = '220 mx.zoho.eu SMTP Server ready', silent = false } = {}) {
  const sent: string[] = [];
  let data = '';
  let inData = false;
  let closed = false;
  let push!: (text: string) => void;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (text) => {
        if (!closed) controller.enqueue(new TextEncoder().encode(text));
      };
      if (!silent) push(`${greeting}\r\n`);
    },
  });
  const defaults: Record<string, string> = {
    EHLO: '250-mx.zoho.eu Hello\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 53477376',
    AUTH: '235 Authentication Successful',
    MAIL: '250 Sender <hello@truewidgets.com> OK',
    RCPT: '250 Recipient OK',
    DATA: '354 Ok Send data ending with <CRLF>.<CRLF>',
    '.': '250 Message received',
    QUIT: '221 Bye',
  };
  const answer = (key: string) => {
    const reply = replies[key] ?? defaults[key] ?? '250 OK';
    if (reply !== 'silence') push(`${reply}\r\n`);
  };
  let pending = '';
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      pending += new TextDecoder().decode(chunk);
      let end: number;
      while ((end = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            answer('.');
          } else data += `${line}\r\n`;
          continue;
        }
        sent.push(line);
        const word = line.split(' ')[0]!.toUpperCase();
        if (word === 'DATA' && !(replies.DATA ?? '354').startsWith('354')) {
          answer('DATA');
          continue;
        }
        if (word === 'DATA') inData = true;
        answer(word === 'MAIL' || word === 'RCPT' || word === 'EHLO' || word === 'AUTH' || word === 'DATA' || word === 'QUIT' ? word : 'AUTH');
      }
    },
  });
  const connection: SmtpConnection = {
    readable,
    writable,
    close: () => {
      closed = true;
    },
  };
  return { connection, sent, data: () => data, isClosed: () => closed };
}

const zoho = (server: ReturnType<typeof fakeSmtp>, extra: Partial<SmtpOptions> = {}) => {
  const connect = vi.fn(async (_host: string, _port: number) => server.connection);
  const mailer = createSmtpMailer({
    user: 'hello@truewidgets.com',
    pass: 'app-password-1',
    from: 'Tabfold <hello@truewidgets.com>',
    connect,
    now: () => Date.UTC(2026, 9, 13, 9, 30),
    randomId: () => 'abc123',
    ...extra,
  });
  return { mailer, connect };
};

const decodeParts = (data: string) =>
  data
    .split(/--tabfold-abc123(?:--)?\r\n/)
    .slice(1)
    .filter(Boolean)
    .map((part) => {
      const [headers, body] = part.split('\r\n\r\n');
      return { headers: headers!, body: unb64(body!.replace(/\r\n/g, '')) };
    });

describe('createSmtpMailer (Zoho Mail)', () => {
  it('signs in to Zoho over TLS on 465 and sends the code', async () => {
    const server = fakeSmtp();
    const { mailer, connect } = zoho(server);
    await mailer.sendCode('sam@example.com', '481920', 'trial');
    expect(connect).toHaveBeenCalledWith('smtp.zoho.eu', 465);
    expect(server.sent).toEqual([
      'EHLO truewidgets.com',
      `AUTH PLAIN ${b64('\u0000hello@truewidgets.com\u0000app-password-1')}`,
      'MAIL FROM:<hello@truewidgets.com>',
      'RCPT TO:<sam@example.com>',
      'DATA',
      'QUIT',
    ]);
    const data = server.data();
    expect(data).toContain('From: Tabfold <hello@truewidgets.com>\r\n');
    expect(data).toContain('To: sam@example.com\r\n');
    expect(data).toContain('Subject: Your Tabfold code: 481920\r\n');
    expect(data).toContain('Date: Tue, 13 Oct 2026 09:30:00 +0000\r\n');
    expect(data).toContain('Message-ID: <abc123@truewidgets.com>\r\n');
    expect(data).toContain('Content-Type: multipart/alternative; boundary="tabfold-abc123"\r\n');
    const [text, html] = decodeParts(data);
    expect(text!.headers).toContain('Content-Type: text/plain; charset=utf-8');
    expect(text!.body).toBe(codeEmail('481920', 'trial').text);
    expect(html!.headers).toContain('Content-Type: text/html; charset=utf-8');
    expect(html!.body).toBe(codeEmail('481920', 'trial').html);
    // Every line fits SMTP's limit.
    expect(Math.max(...data.split('\r\n').map((line) => line.length))).toBeLessThanOrEqual(78);
    expect(server.isClosed()).toBe(true);
  });

  it('uses AUTH LOGIN when that is all the server offers, and the host and port it is given', async () => {
    const server = fakeSmtp({ EHLO: '250-smtp.example.com\r\n250 AUTH LOGIN', AUTH: '334 VXNlcm5hbWU6' });
    const { mailer, connect } = zoho(server, { host: 'smtp.zoho.com', port: 2465 });
    // The fake answers 334 to every AUTH step; the last one (the password) must get 235.
    await expect(mailer.sendCode('sam@example.com', '1', 'signin')).rejects.toMatchObject({ name: 'MailError', message: 'SMTP answered 334 at AUTH' });
    expect(connect).toHaveBeenCalledWith('smtp.zoho.com', 2465);
    expect(server.sent.slice(1, 4)).toEqual([
      'AUTH LOGIN',
      b64('hello@truewidgets.com'),
      b64('app-password-1'),
    ]);
  });

  it('sends invitations, linking to the site it was given, with a non-English team name encoded', async () => {
    const server = fakeSmtp();
    const { mailer } = zoho(server, { siteUrl: 'https://tabfold.truewidgets.com' });
    await mailer.sendInvite('sara@example.com', 'Équipe Ünïcode', 'hello@truewidgets.com');
    const data = server.data();
    const subject = /Subject: (.*?)\r\n(?! )/s.exec(data)![1]!;
    expect(subject).toMatch(/^=\?UTF-8\?B\?/);
    const decoded = subject
      .split('\r\n ')
      .map((word) => unb64(/=\?UTF-8\?B\?(.*)\?=/.exec(word)![1]!))
      .join('');
    expect(decoded).toBe('hello@truewidgets.com invited you to Équipe Ünïcode on Tabfold');
    expect(decodeParts(data)[0]!.body).toContain('https://tabfold.truewidgets.com');
  });

  it('throws a MailError that names the step and the code, never the address, code or password', async () => {
    const server = fakeSmtp({ AUTH: '535 Authentication Failed for hello@truewidgets.com' });
    const error = (await zoho(server).mailer.sendCode('sam@example.com', '481920', 'signin').catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ name: 'MailError', message: 'SMTP answered 535 at AUTH' });
    expect(server.isClosed()).toBe(true);

    const relay = fakeSmtp({ MAIL: '553 Sender is not allowed to relay emails' });
    await expect(zoho(relay).mailer.sendCode('sam@example.com', '1', 'signin')).rejects.toThrow('SMTP answered 553 at MAIL FROM');
    const nobody = fakeSmtp({ RCPT: '550 No such user sam@example.com' });
    await expect(zoho(nobody).mailer.sendCode('sam@example.com', '1', 'signin')).rejects.toThrow('SMTP answered 550 at RCPT TO');
    const refused = fakeSmtp({ '.': '554 Message rejected' });
    await expect(zoho(refused).mailer.sendCode('sam@example.com', '1', 'signin')).rejects.toThrow('SMTP answered 554 at the message');
    const busy = fakeSmtp({}, { greeting: '421 Too many connections' });
    await expect(zoho(busy).mailer.sendCode('sam@example.com', '1', 'signin')).rejects.toThrow('SMTP answered 421 at greeting');
  });

  it('throws a MailError when the server can’t be reached or goes quiet', async () => {
    const offline = createSmtpMailer({
      user: 'u@x.co',
      pass: 'p',
      from: 'u@x.co',
      connect: async () => {
        throw new Error('Connection refused (os error 111) app-password-1');
      },
    });
    await expect(offline.sendCode('sam@example.com', '1', 'signin')).rejects.toMatchObject({
      name: 'MailError',
      message: 'smtp.zoho.eu:465 could not be reached',
    });
    const quiet = fakeSmtp({ DATA: 'silence' });
    await expect(zoho(quiet, { timeoutMs: 50 }).mailer.sendCode('sam@example.com', '1', 'signin')).rejects.toMatchObject({
      name: 'MailError',
      message: 'SMTP timed out at DATA',
    });
  });

  it('refuses an address that could break the conversation', async () => {
    const server = fakeSmtp();
    await expect(zoho(server).mailer.sendCode('sam@example.com>\r\nRCPT TO:<x@y.z', '1', 'signin')).rejects.toMatchObject({ name: 'MailError' });
    expect(server.sent).toEqual([]);
  });

  it('fails plainly (a set-up problem) without a mailbox, password or sender', async () => {
    const connect = vi.fn();
    const base = { user: 'u@x.co', pass: 'p', from: 'u@x.co', connect };
    await expect(createSmtpMailer({ ...base, user: '' }).sendCode('a@b.co', '1', 'signin')).rejects.toMatchObject({ name: 'Error', message: 'SMTP_USER is not set' });
    await expect(createSmtpMailer({ ...base, pass: '' }).sendCode('a@b.co', '1', 'signin')).rejects.toThrow('SMTP_PASS is not set');
    await expect(createSmtpMailer({ ...base, from: '' }).sendCode('a@b.co', '1', 'signin')).rejects.toThrow('EMAIL_FROM is not set');
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('the sender and headers', () => {
  it('reads "Name <address>" and a bare address', () => {
    expect(parseSender('Tabfold <hello@truewidgets.com>')).toEqual({ name: 'Tabfold', address: 'hello@truewidgets.com' });
    expect(parseSender('"Tabfold by Truewidgets" <hello@truewidgets.com>')).toEqual({ name: 'Tabfold by Truewidgets', address: 'hello@truewidgets.com' });
    expect(parseSender('hello@truewidgets.com')).toEqual({ name: '', address: 'hello@truewidgets.com' });
  });

  it('keeps short ASCII as it is, encodes the rest in whole characters, 75 at most a word', () => {
    expect(encodeHeader('Your Tabfold code: 481920')).toBe('Your Tabfold code: 481920');
    expect(encodeHeader('a\r\nBcc: x@y.z')).toBe('a Bcc: x@y.z');
    const long = '😀'.repeat(30) + ' é';
    const words = encodeHeader(long).split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
    const decoded = words.map((word) => unb64(/=\?UTF-8\?B\?(.*)\?=/.exec(word)![1]!));
    expect(decoded.join('')).toBe(long);
    for (const part of decoded) expect(part).not.toContain('\ufffd');
  });
});
