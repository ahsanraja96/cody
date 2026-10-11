import { describe, expect, it, vi } from 'vitest';
import { codeEmail, createResendMailer, RESEND_URL } from '../../server/supabase/functions/tabfold/mail.ts';

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

describe('createResendMailer', () => {
  const ok = () => new Response(JSON.stringify({ id: 'email_1' }), { status: 200 });

  it('sends through Resend', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ok());
    await createResendMailer({ apiKey: 're_123', from: 'Tabfold <hello@tabfold.app>', fetch }).sendCode('sam@example.com', '481920', 'trial');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(RESEND_URL);
    expect(init!.method).toBe('POST');
    expect(init!.headers).toEqual({ Authorization: 'Bearer re_123', 'Content-Type': 'application/json' });
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({
      from: 'Tabfold <hello@tabfold.app>',
      to: ['sam@example.com'],
      subject: 'Your Tabfold code: 481920',
      text: expect.stringContaining('start your 7-day Pro AI trial'),
      html: expect.stringContaining('481920'),
    });
  });

  it('throws a MailError that names Resend’s error but not the address, key or code', async () => {
    const refused = vi.fn(async () => new Response(JSON.stringify({ name: 'validation_error', message: 'Invalid `to`: sam@example.com' }), { status: 422 }));
    const error = (await createResendMailer({ apiKey: 're_123', from: 'x@tabfold.app', fetch: refused })
      .sendCode('sam@example.com', '481920', 'signin')
      .catch((e: unknown) => e)) as Error;
    expect(error.name).toBe('MailError');
    expect(error.message).toBe('Resend answered 422 (validation_error)');
    const down = vi.fn(async () => new Response('bad gateway', { status: 502 }));
    await expect(createResendMailer({ apiKey: 're_123', from: 'x@tabfold.app', fetch: down }).sendCode('a@b.co', '1', 'signin')).rejects.toThrow(
      'Resend answered 502',
    );
  });

  it('throws a MailError when Resend can’t be reached', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed re_123');
    });
    const error = (await createResendMailer({ apiKey: 're_123', from: 'x@tabfold.app', fetch: offline })
      .sendCode('sam@example.com', '481920', 'signin')
      .catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ name: 'MailError', message: 'Resend could not be reached' });
  });

  it('fails plainly (a set-up problem) without a key or sender', async () => {
    const fetch = vi.fn(async () => ok());
    await expect(createResendMailer({ apiKey: '', from: 'x@tabfold.app', fetch }).sendCode('a@b.co', '1', 'signin')).rejects.toMatchObject({
      name: 'Error',
      message: 'RESEND_API_KEY is not set',
    });
    await expect(createResendMailer({ apiKey: 're_1', from: '', fetch }).sendCode('a@b.co', '1', 'signin')).rejects.toThrow('EMAIL_FROM is not set');
    expect(fetch).not.toHaveBeenCalled();
  });
});
