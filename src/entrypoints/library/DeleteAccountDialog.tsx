import { useId, useState } from 'react';
import { CircleAlert, LoaderCircle, TriangleAlert } from 'lucide-react';
import { send } from '@/lib/messages';
import { toast } from '@/ui/components/Toast';
import { proErrorText } from '@/ui/pro';
import { SECONDARY, SmallDialog } from './FolderDialogs';

const DANGER =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control bg-red-solid px-3.5 font-semibold text-white hover:brightness-95 disabled:opacity-50 disabled:hover:brightness-100';

/** The email as typed matches the account's (ignoring case and spaces at the ends), as the server compares it. */
function sameEmail(typed: string, email: string): boolean {
  return typed.trim().toLowerCase() === email.trim().toLowerCase();
}

/**
 * Settings › "Delete my Tabfold account…" (1.0, signed-in accounts): what goes (the account on
 * Tabfold's server, its plan and billing, synced copy, backups, shared links, team), what stays (the
 * folded tabs on this computer), and the account's email typed to confirm. Then every computer is
 * signed out and Settings shows Free, signed out.
 */
export function DeleteAccountDialog({ email, onClose }: { email: string; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const ready = sameEmail(typed, email);

  const remove = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await send({ type: 'account-delete', confirm: typed.trim() });
      onClose();
      toast('Your Tabfold account was deleted. Your folded tabs stay on this computer.', { tone: 'success' });
    } catch (failure) {
      setError(proErrorText(failure));
      setBusy(false);
    }
  };

  return (
    <SmallDialog
      open
      onClose={onClose}
      width={460}
      closeButton
      icon={<TriangleAlert size={18} strokeWidth={1.75} aria-hidden className="mt-px shrink-0 text-red" />}
      title="Delete your Tabfold account?"
      footer={
        <>
          <button type="button" onClick={onClose} className={SECONDARY}>
            Cancel
          </button>
          <button type="button" disabled={!ready || busy} onClick={() => void remove()} className={DANGER}>
            {busy && <LoaderCircle size={14} aria-hidden className="tf-spin" />}
            Delete my account
          </button>
        </>
      }
    >
      <div className="mt-2 flex flex-col gap-2.5 text-text-2">
        <p className="m-0">
          This deletes <b className="font-semibold text-text">{email}</b> from Tabfold’s server, for good:
        </p>
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
          <li>Your plan ends now and nothing more is charged. Pro for life goes with it.</li>
          <li>Your synced copy and daily backups are deleted.</li>
          <li>Links to folders you shared stop working.</li>
          <li>A team you own ends; a team you’re in loses you.</li>
          <li>Every computer signed in to it is signed out.</li>
        </ul>
        <p className="m-0">
          <b className="font-semibold text-text">What stays:</b> the folded tabs on this computer, and your Chrome sync. Tabfold keeps working,
          on Free.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void remove();
          }}
          className="mt-1 flex flex-col gap-1.5"
        >
          <label htmlFor={inputId} className="text-small font-semibold text-text">
            Type your email to confirm
          </label>
          <input
            id={inputId}
            data-autofocus
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            placeholder={email}
            onChange={(e) => {
              setTyped(e.target.value);
              setError(null);
            }}
            className="h-8 rounded-control border border-border-strong bg-surface px-2.5 text-text outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--tf-accent-soft)]"
          />
        </form>
        {error && (
          <p role="alert" className="m-0 flex items-start gap-1.5 text-small text-red">
            <CircleAlert size={13} strokeWidth={1.75} aria-hidden className="mt-[2px] shrink-0" />
            {error}
          </p>
        )}
      </div>
    </SmallDialog>
  );
}
