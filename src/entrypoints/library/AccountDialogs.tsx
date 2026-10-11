import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CircleAlert, Info, LoaderCircle, LogIn, Sparkles, X } from 'lucide-react';
import { create } from 'zustand';
import { send } from '@/lib/messages';
import { checkoutNotice } from '@/lib/pro/state';
import { TRIAL_DAYS, type PlanState, type SigninPurpose, type SigninResult } from '@/lib/pro/types';
import { Modal } from '@/ui/components/Modal';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { errorCode, intervalName, isTrialing, looksLikeEmail, paidTier, proErrorText, signinErrorText, tierName } from '@/ui/pro';
import { goToPlans } from './router';

/**
 * Signing in and the free trial with an emailed 6-digit code (Stripe-Signin board), and "Sign out on
 * this computer?" (Stripe-Plan-States). One host in the full list; anything opens it with
 * `openSignIn`, `startTrialFlow` or `openSignOut`. The dialog closes with a toast that says what
 * happened, or moves on to "You’ve had your free trial" / "No plan on this email".
 */

type View = 'email' | 'code' | 'expired' | 'trial-used' | 'no-plan' | 'signout';

interface Request {
  key: number;
  purpose: SigninPurpose;
  view: View;
  email: string;
  /** Send the code to `email` straight away (the payment is on that email). */
  sendNow?: boolean;
}

let nextKey = 1;

const useAccountDialog = create<{ request: Request | null; set: (request: Request | null) => void }>((set) => ({
  request: null,
  set: (request) => set({ request }),
}));

function open(purpose: SigninPurpose, view: View, email = '', sendNow = false): void {
  useAccountDialog.getState().set({ key: nextKey++, purpose, view, email, sendNow });
}

/**
 * "Already paid? Sign in" (purpose `signin`) or the trial's email step (purpose `trial`). With an
 * email, the code goes to it at once ("Your payment is on …: Sign in").
 */
export function openSignIn(purpose: SigninPurpose = 'signin', email?: string): void {
  open(purpose, 'email', email ?? '', !!email);
}

/** "Sign out" next to "Signed in as …". */
export function openSignOut(): void {
  open('signin', 'signout');
}

const TRIAL_STARTED = `Pro AI trial started · ${TRIAL_DAYS} days`;

/** What a finished sign-in or trial start says: a toast, or the next dialog. Returns the dialog to show, if any. */
function outcome(purpose: SigninPurpose, result: SigninResult): View | null {
  const { plan } = result;
  if (result.trialStarted) {
    toast(TRIAL_STARTED);
    return null;
  }
  const paid = paidTier(plan);
  if (paid) {
    toast(`Signed in · ${tierName(paid)}${plan.interval ? `, ${intervalName(plan.interval)}` : ''}`);
    return null;
  }
  if (purpose === 'trial' && (result.trialUsed || plan.trialUsed)) return 'trial-used';
  if (isTrialing(plan)) {
    toast('Signed in · Pro AI trial');
    return null;
  }
  if (purpose === 'signin') return 'no-plan';
  toast('Signed in');
  return null;
}

/**
 * "Start 7-day free trial" (plans page, Organise teaser): signed in already, the trial starts at
 * once (no code); otherwise the email-code dialog. Resolves when done.
 */
export async function startTrialFlow(plan: PlanState): Promise<void> {
  if (!plan.email) return openSignIn('trial');
  if (plan.trialUsed) return open('trial', 'trial-used', plan.email);
  try {
    const result = await send({ type: 'trial-start' });
    const next = outcome('trial', result);
    if (next) open('trial', next, result.plan.email ?? plan.email);
  } catch (error) {
    if (errorCode(error) === 'not-signed-in') openSignIn('trial');
    else toast(proErrorText(error), { tone: 'error' });
  }
}

/** "Checkout closed. Nothing was charged.": once, on whichever Tabfold page sees it first. */
export function useCheckoutClosedToast(): void {
  useEffect(() => {
    const show = (notice: { at: number } | undefined) => {
      if (!notice) return;
      void checkoutNotice.set(null).catch(() => undefined);
      if (Date.now() - notice.at > 5 * 60_000) return;
      toast('Checkout closed. Nothing was charged.', { icon: <Info size={16} aria-hidden className="shrink-0" /> });
    };
    checkoutNotice
      .get()
      .then(show)
      .catch(() => undefined);
    return checkoutNotice.watch(show);
  }, []);
}

// ---------------------------------------------------------------------------------------------

const PRIMARY =
  'flex h-10 w-full items-center justify-center gap-2 rounded-control bg-accent px-4 font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60 disabled:hover:bg-accent';
const PRIMARY_SM =
  'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-control bg-accent px-4 font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60';
const SECONDARY_SM = 'inline-flex h-9 shrink-0 items-center justify-center rounded-control border border-border-strong bg-surface px-3.5 text-text hover:bg-hover';
const LINK = 'text-small font-semibold text-accent-text hover:underline disabled:opacity-60';
const HEADING_ID = 'account-h';

function Header({ title, children, icon, onClose }: { title: string; children: ReactNode; icon?: ReactNode; onClose: () => void }) {
  return (
    <header className="flex items-start gap-3 pt-[22px] pr-4 pl-6">
      {icon && (
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent-text">
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h1 id={HEADING_ID} className="m-0 text-page font-semibold">
          {title}
        </h1>
        <p className="mt-1.5 mb-0 text-text-2">{children}</p>
      </div>
      <button
        type="button"
        aria-label="Close"
        title="Close"
        onClick={onClose}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-control text-text-2 hover:bg-hover hover:text-text"
      >
        <X size={18} strokeWidth={1.75} aria-hidden />
      </button>
    </header>
  );
}

function Alert({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <div id={id} role="alert" className="flex items-start gap-1.5 text-small text-red">
      <CircleAlert size={14} strokeWidth={2} aria-hidden className="mt-px shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function Spinner({ on }: { on: boolean }) {
  return on ? <LoaderCircle size={16} aria-hidden className="tf-spin shrink-0" /> : null;
}

const Email = ({ value }: { value: string }) => <b className="font-semibold text-text">{value}</b>;

/** Six boxes for the code: typing moves on, Backspace goes back, pasting (or Chrome's autofill) fills them all. */
function CodeBoxes({
  digits,
  onDigits,
  tone,
  disabled,
  boxRef,
}: {
  digits: string[];
  onDigits: (digits: string[]) => void;
  tone: 'normal' | 'error';
  disabled: boolean;
  boxRef: (index: number, el: HTMLInputElement | null) => void;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const focus = (index: number) => {
    const el = refs.current[Math.max(0, Math.min(5, index))];
    el?.focus();
    el?.select();
  };
  // After a wrong code, typing again starts over.
  const base = () => (tone === 'error' ? ['', '', '', '', '', ''] : [...digits]);
  const fill = (from: number, text: string) => {
    const typed = text.replace(/\D/g, '').slice(0, 6);
    if (!typed) return;
    const start = typed.length === 6 || tone === 'error' ? 0 : from;
    const next = base();
    for (let i = 0; i < typed.length && start + i < 6; i += 1) next[start + i] = typed[i]!;
    onDigits(next);
    focus(Math.min(5, start + typed.length));
  };
  const box = (index: number) => (
    <input
      key={index}
      ref={(el) => {
        refs.current[index] = el;
        boxRef(index, el);
      }}
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete={index === 0 ? 'one-time-code' : 'off'}
      aria-label={`Digit ${index + 1} of 6`}
      aria-invalid={tone === 'error' || undefined}
      disabled={disabled}
      value={digits[index] ?? ''}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (/^\d$/.test(e.key)) {
          e.preventDefault();
          fill(index, e.key);
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          const next = [...digits];
          if (next[index]) {
            next[index] = '';
            onDigits(next);
          } else if (index > 0) {
            next[index - 1] = '';
            onDigits(next);
            focus(index - 1);
          }
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          focus(index - 1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          focus(index + 1);
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        fill(index, e.clipboardData.getData('text'));
      }}
      // Chrome's one-time-code autofill and phone keyboards arrive as input events.
      onChange={(e) => fill(index, e.target.value)}
      className={cx(
        'h-[52px] w-11 rounded-[10px] border text-center text-[22px] font-semibold text-text tabular-nums caret-accent outline-none focus-visible:outline-none disabled:opacity-70',
        tone === 'error'
          ? 'border-red bg-red-soft'
          : 'border-border-strong bg-surface focus:border-accent focus:shadow-[0_0_0_3px_var(--tf-accent-line)]',
      )}
    />
  );
  return (
    <div role="group" aria-label="6-digit code" className="flex justify-between">
      {[0, 1, 2].map(box)}
      <span aria-hidden className="self-center text-text-3">
        –
      </span>
      {[3, 4, 5].map(box)}
    </div>
  );
}

const RESEND_AFTER_S = 60;

function useSecondsSince(at: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [at]);
  return Math.floor((now - at) / 1000);
}

function AccountDialogBody({ request, onClose }: { request: Request; onClose: () => void }) {
  const [view, setView] = useState<View>(request.view);
  const [purpose, setPurpose] = useState<SigninPurpose>(request.purpose);
  const [email, setEmail] = useState(request.email);
  const [signedInAs, setSignedInAs] = useState(request.email);
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [error, setError] = useState<{ text: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState(0);
  const since = useSecondsSince(sentAt);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const submitted = useRef('');

  // Each step starts with focus on what to fill in.
  useEffect(() => {
    if (view === 'email') {
      emailRef.current?.focus();
      emailRef.current?.select();
    } else if (view === 'code') boxes.current[0]?.focus();
  }, [view]);

  // Opened with the email the payment is on: the code goes out at once.
  const sentNow = useRef(false);
  useEffect(() => {
    if (!request.sendNow || sentNow.current) return;
    sentNow.current = true;
    void sendCode(request.email);
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendCode = async (address: string) => {
    if (!looksLikeEmail(address)) {
      setError({ text: 'That doesn’t look like an email address.', code: 'invalid-email' });
      setView('email');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await send({ type: 'signin-start', email: address.trim(), purpose });
      setEmail(address.trim());
      setDigits(['', '', '', '', '', '']);
      submitted.current = '';
      setSentAt(Date.now());
      setView('code');
      // Focus stays on the boxes when the code is sent again from the code step.
      setTimeout(() => boxes.current[0]?.focus(), 0);
    } catch (failure) {
      setError({ text: signinErrorText(failure), code: errorCode(failure) });
    } finally {
      setBusy(false);
    }
  };

  const checkCode = async (code: string) => {
    if (code.length !== 6 || busy) return;
    submitted.current = code;
    setBusy(true);
    setError(null);
    try {
      const result = await send({ type: 'signin-finish', email, code, startTrial: purpose === 'trial' });
      setSignedInAs(result.plan.email ?? email);
      const next = outcome(purpose, result);
      if (next) setView(next);
      else onClose();
    } catch (failure) {
      const code = errorCode(failure);
      const text = signinErrorText(failure);
      if (code === 'code-expired' || text.startsWith('That code has expired')) {
        setDigits(['', '', '', '', '', '']);
        setView('expired');
        setError({ text, code: 'code-expired' });
      } else {
        setError({ text, code });
      }
    } finally {
      setBusy(false);
    }
  };

  const onDigits = (next: string[]) => {
    if (error?.code === 'wrong-code') setError(null);
    setDigits(next);
    // The 6th digit sends it.
    const code = next.join('');
    if (code.length === 6 && code !== submitted.current) void checkCode(code);
  };

  const differentEmail = () => {
    setError(null);
    setView('email');
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await send({ type: 'signout' });
      onClose();
      toast('Signed out on this computer');
    } catch (failure) {
      setError({ text: proErrorText(failure) });
      setBusy(false);
    }
  };

  const trial = purpose === 'trial';

  if (view === 'signout') {
    return (
      <>
        <Header title="Sign out on this computer?" onClose={onClose}>
          Your folded tabs stay here. They stop syncing with your Tabfold account until you sign in again. Your plan doesn’t change.
        </Header>
        <div className="flex flex-col gap-3.5 px-6 pt-[18px] pb-[22px]">
          {error && <Alert>{error.text}</Alert>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={SECONDARY_SM}>
              Cancel
            </button>
            <button type="button" data-autofocus disabled={busy} onClick={() => void signOut()} className={PRIMARY_SM}>
              <Spinner on={busy} />
              Sign out
            </button>
          </div>
        </div>
      </>
    );
  }

  if (view === 'trial-used' || view === 'no-plan') {
    const used = view === 'trial-used';
    return (
      <>
        <Header title={used ? 'You’ve had your free trial' : 'No plan on this email'} onClose={onClose}>
          {used ? (
            <>
              You’re signed in as <Email value={signedInAs} />, which has already had its {TRIAL_DAYS}-day Pro AI trial.
            </>
          ) : (
            <>
              You’re signed in as <Email value={signedInAs} />, but there’s no Pro plan on it. Paid with another email? Sign in with that one.
            </>
          )}
        </Header>
        <div className="flex justify-end gap-2 px-6 pt-[18px] pb-[22px]">
          {used ? (
            <button type="button" onClick={onClose} className={SECONDARY_SM}>
              Not now
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setPurpose('signin');
                setEmail('');
                differentEmail();
              }}
              className={SECONDARY_SM}
            >
              Use a different email
            </button>
          )}
          <button
            type="button"
            data-autofocus
            autoFocus
            onClick={() => {
              onClose();
              goToPlans();
            }}
            className={PRIMARY_SM}
          >
            {used ? 'Choose a plan' : 'See plans'}
          </button>
        </div>
      </>
    );
  }

  if (view === 'email') {
    const failedToSend = error?.code === 'send-failed' || error?.code === 'offline';
    const submit = (e: FormEvent) => {
      e.preventDefault();
      if (!busy) void sendCode(email);
    };
    return (
      <>
        <Header
          title={trial ? 'Start your free trial' : 'Sign in to Tabfold Pro'}
          icon={trial ? <Sparkles size={18} strokeWidth={1.75} /> : <LogIn size={18} strokeWidth={1.75} />}
          onClose={onClose}
        >
          {trial
            ? `${TRIAL_DAYS} days of Pro AI, no card needed. We’ll email you a 6-digit code to confirm it’s you.`
            : 'Use the email you paid with. We’ll send a 6-digit code; there’s no password.'}
        </Header>
        <form noValidate onSubmit={submit} className="flex flex-col gap-3.5 px-6 pt-[18px] pb-[22px]">
          <div>
            <label className="block">
              <span className="mb-1.5 block text-small font-semibold">Email</span>
              <input
                ref={emailRef}
                type="email"
                name="email"
                autoComplete="email"
                spellCheck={false}
                data-autofocus
                placeholder="you@example.com"
                value={email}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'account-email-error' : undefined}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError(null);
                }}
                className={cx(
                  'h-10 w-full rounded-control border bg-surface px-3 text-[14px] text-text outline-none focus-visible:outline-none',
                  error
                    ? 'border-red shadow-[0_0_0_3px_var(--tf-red-soft)]'
                    : 'border-border-strong focus:border-accent focus:shadow-[0_0_0_3px_var(--tf-accent-line)]',
                )}
              />
            </label>
            {error && (
              <div className="mt-1.5">
                <Alert id="account-email-error">{error.text}</Alert>
              </div>
            )}
          </div>
          <button type="submit" disabled={busy} className={PRIMARY}>
            <Spinner on={busy} />
            {failedToSend ? 'Try again' : 'Email me a code'}
          </button>
          {!failedToSend && (
            <p className="m-0 text-small text-text-3">
              {trial
                ? 'Your email becomes your Tabfold account, so your plan follows you to your other computers. We only email you about your account.'
                : 'On computers where you use this Chrome profile, Tabfold signs you in by itself.'}
            </p>
          )}
        </form>
      </>
    );
  }

  // The code, or a code that expired (or was tried too many times).
  const expired = view === 'expired';
  const wait = RESEND_AFTER_S - since;
  const resend = () => void sendCode(email);
  return (
    <>
      <Header title="Check your email" onClose={onClose}>
        Enter the 6-digit code we sent to <Email value={email} />.{expired ? '' : ' It works for 10 minutes.'}
      </Header>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (expired) return resend();
          const code = digits.join('');
          // Not all six yet: back to the first empty box.
          if (code.length < 6) boxes.current[digits.findIndex((d) => !d)]?.focus();
          else void checkCode(code);
        }}
        className="flex flex-col gap-3.5 px-6 pt-[18px] pb-[22px]"
      >
        <CodeBoxes
          digits={digits}
          onDigits={onDigits}
          tone={error?.code === 'wrong-code' ? 'error' : 'normal'}
          disabled={busy || expired}
          boxRef={(index, el) => {
            boxes.current[index] = el;
          }}
        />
        {error && <Alert>{error.text}</Alert>}
        <button type="submit" disabled={busy} className={PRIMARY}>
          <Spinner on={busy} />
          {expired ? 'Email me a new code' : trial ? 'Start trial' : 'Sign in'}
        </button>
        <div className="flex flex-wrap items-center gap-4">
          {!expired &&
            (wait > 0 ? (
              <span className="text-small text-text-3 tabular-nums">
                Send again in 0:{String(Math.min(59, wait)).padStart(2, '0')}
              </span>
            ) : (
              <button type="button" disabled={busy} onClick={resend} className={LINK}>
                Send a new code
              </button>
            ))}
          <button type="button" disabled={busy} onClick={differentEmail} className={LINK}>
            Use a different email
          </button>
        </div>
        {!expired && !error && <p className="m-0 text-small text-text-3">Not there? Look in spam for an email from Tabfold.</p>}
      </form>
    </>
  );
}

/** The one host for these dialogs, in the full list. */
export function AccountDialogHost() {
  const { request, set } = useAccountDialog();
  const close = () => set(null);
  return (
    <Modal open={!!request} onClose={close} labelledBy={HEADING_ID} width={400}>
      {request && <AccountDialogBody key={request.key} request={request} onClose={close} />}
    </Modal>
  );
}
