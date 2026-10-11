import { MailError, type CodePurpose, type Mailer } from '../../server/supabase/functions/tabfold/mail.ts';

/**
 * A Mailer that keeps the codes instead of emailing them, for the server tests and the end-to-end
 * Pro test (e2e/pro.mjs). No test-runner imports, so plain Node can load it.
 */

export interface SentCode {
  email: string;
  code: string;
  purpose: CodePurpose;
}

export interface MemoryMailer extends Mailer {
  /** Every code "sent", oldest first. */
  sent: SentCode[];
  /** The latest code sent to this email, or null. */
  lastCode(email: string): string | null;
  /** While true, sending fails as if the email service were down. */
  failing: boolean;
}

export function memoryMailer(): MemoryMailer {
  const mailer: MemoryMailer = {
    sent: [],
    failing: false,
    async sendCode(email, code, purpose) {
      if (mailer.failing) throw new MailError('The email service is down (memory mailer)');
      mailer.sent.push({ email, code, purpose });
    },
    lastCode(email) {
      for (let i = mailer.sent.length - 1; i >= 0; i--) if (mailer.sent[i]!.email === email) return mailer.sent[i]!.code;
      return null;
    },
  };
  return mailer;
}
