import { useEffect, useId, useRef, useState } from 'react';
import { ExternalLink, LoaderCircle, LogOut, UserPlus, Users } from 'lucide-react';
import { send } from '@/lib/messages';
import { parseInviteEmails } from '@/lib/pro/team';
import type { PlanState, TeamInfo } from '@/lib/pro/types';
import { avatarColors, displayName } from '@/lib/teams';
import { Avatar } from '@/ui/components/Avatars';
import { confirmAction } from '@/ui/components/Dialog';
import { toast } from '@/ui/components/Toast';
import { cx } from '@/ui/cx';
import { useTeamDetails } from '@/ui/hooks';
import { openBilling, teamErrorText, teamSeatsLine } from '@/ui/pro';
import { useLibraryUi } from './uiStore';

const PRIMARY =
  'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-control bg-accent px-4 font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60';
const SECONDARY_SM =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold text-text hover:bg-hover disabled:opacity-60';
const QUIET = 'inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-small font-semibold text-text-2 hover:bg-hover hover:text-text disabled:opacity-60';
const LINK = 'text-small font-semibold text-accent-text hover:underline';

/** The team's name, renamed in place by its owner (Enter saves, Esc cancels). */
function TeamName({ team }: { team: TeamInfo }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const done = useRef(false);
  const finish = async (save: boolean) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!save || !clean || clean === team.name) return;
    try {
      await send({ type: 'team-rename', name: clean });
    } catch (error) {
      toast(teamErrorText(error), { tone: 'error' });
    }
  };
  if (editing) {
    return (
      <input
        autoFocus
        aria-label="Team name"
        value={name}
        maxLength={60}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            void finish(false);
          }
        }}
        onBlur={() => void finish(true)}
        className="h-8 min-w-0 max-w-[320px] flex-1 rounded-control border border-accent bg-surface px-2 text-section font-semibold text-text shadow-[0_0_0_3px_var(--tf-accent-line)] outline-none"
      />
    );
  }
  return (
    <>
      <span dir="auto" className="min-w-0 truncate text-section font-semibold">
        {team.name}
      </span>
      {team.role === 'owner' && (
        <button
          type="button"
          onClick={() => {
            done.current = false;
            setName(team.name);
            setEditing(true);
          }}
          className={LINK}
        >
          Rename
        </button>
      )}
    </>
  );
}

/** "Invite": emails separated by commas or spaces, checked here before the server checks them. */
function InviteField({ team }: { team: TeamInfo }) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const focusInvite = useLibraryUi((s) => s.focusInvite);

  // "Invite people" on the welcome page opens Settings here (once Settings has opened and focused itself).
  useEffect(() => {
    if (!focusInvite) return;
    const timer = setTimeout(() => {
      useLibraryUi.getState().setFocusInvite(false);
      const input = inputRef.current;
      if (!input) return;
      input.scrollIntoView({ block: 'center' });
      input.focus();
    }, 80);
    return () => clearTimeout(timer);
  }, [focusInvite]);

  const submit = async () => {
    const parsed = parseInviteEmails(text);
    if (!parsed.ok) {
      setProblem(parsed.message);
      inputRef.current?.focus();
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      const { invited } = await send({ type: 'team-invite', emails: parsed.emails });
      setText('');
      toast(
        invited === 0
          ? parsed.emails.length === 1
            ? 'They’re already in the team or invited.'
            : 'They’re all in the team or invited already.'
          : `Invited ${invited === 1 ? '1 person' : `${invited} people`}. They get an email; signing in with it joins ${team.name}.`,
        { tone: 'success' },
      );
    } catch (error) {
      setProblem(teamErrorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex gap-2">
        <label
          className={cx(
            'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-control border bg-surface px-2.5 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--tf-accent-soft)]',
            problem ? 'border-red' : 'border-border-strong',
          )}
        >
          <Users size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-3" />
          <span className="sr-only">Emails to invite</span>
          <input
            ref={inputRef}
            type="text"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            value={text}
            placeholder="sara@example.com, mike@example.com"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? errorId : undefined}
            onChange={(e) => {
              setText(e.target.value);
              if (problem) setProblem(null);
            }}
            className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-text outline-none placeholder:text-text-3"
          />
        </label>
        <button type="submit" disabled={busy} className={PRIMARY}>
          {busy ? <LoaderCircle size={14} aria-hidden className="tf-spin" /> : <UserPlus size={15} strokeWidth={1.75} aria-hidden />}
          Invite
        </button>
      </div>
      {problem ? (
        <p id={errorId} role="alert" className="m-0 text-small text-red">
          {problem}
        </p>
      ) : (
        <p className="m-0 text-small text-text-3">Separate emails with commas or spaces. Each one gets an invitation to sign in with a code.</p>
      )}
    </form>
  );
}

function PersonRow({
  email,
  color,
  title,
  sub,
  role,
  action,
}: {
  email: string;
  color: Parameters<typeof Avatar>[0]['color'];
  title: string;
  sub: string;
  role: string;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex min-h-[44px] items-center gap-2.5 py-1">
      <Avatar email={email} color={color} size={26} />
      <span className="min-w-0 flex-1">
        <span dir="auto" className="block truncate font-semibold">
          {title}
        </span>
        <span className="block truncate text-small text-text-3">{sub}</span>
      </span>
      <span className="shrink-0 text-small text-text-2">{role}</span>
      {action}
    </li>
  );
}

/**
 * Settings › Team (Mx-Share "Inviting people", Mx-Plans Teams): the team's name (its owner renames
 * it in place), its people with their roles ("you" marked; the owner can remove someone), open
 * invitations (the owner can cancel one), "Invite" (emails, comma or space separated), the seats
 * line, and "Manage billing" for the owner or "Leave team" for everyone else.
 */
export function TeamSection({ plan, open }: { plan: PlanState; open: boolean }) {
  const team = plan.team!;
  const details = useTeamDetails();
  const current = details && details.team.id === team.id ? details : undefined;
  const [busy, setBusy] = useState<string | null>(null);
  const owner = team.role === 'owner';
  const me = plan.email ?? '';

  // Fresh from the server each time Settings opens.
  useEffect(() => {
    if (!open) return;
    send({ type: 'team-get' }).catch((error) => toast(teamErrorText(error), { tone: 'error' }));
  }, [open, team.id]);

  const colors = avatarColors(current);
  const colorOf = (email: string) => colors.get(email) ?? 'grey';

  const run = async (key: string, task: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await task();
    } catch (error) {
      toast(teamErrorText(error), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string, email: string) => {
    const ok = await confirmAction({
      title: `Remove ${displayName(email)} from ${team.name}?`,
      body: `${email} loses the team’s folders and goes back to their own plan. A seat comes off the next bill.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await run(`remove:${id}`, async () => {
      await send({ type: 'team-remove', memberId: id });
      toast(`Removed ${email} from ${team.name}.`, { tone: 'success' });
    });
  };

  const leave = async () => {
    const ok = await confirmAction({
      title: `Leave ${team.name}?`,
      body: 'You lose the team’s folders (you can keep a copy on this computer) and go back to your own plan. The owner can invite you again.',
      confirmLabel: 'Leave team',
      danger: true,
    });
    if (!ok) return;
    await run('leave', async () => {
      await send({ type: 'team-leave' });
      toast(`You left ${team.name}.`, { tone: 'success' });
    });
  };

  const billing = () =>
    run('billing', async () => {
      const problem = await openBilling();
      if (problem) toast(problem, { tone: 'error' });
    });

  return (
    <section aria-labelledby="team-h" className="border-b border-border py-6">
      <h2 id="team-h" className="m-0 mb-2.5 text-body font-semibold">
        Team
      </h2>
      <div className="flex flex-col gap-3.5 rounded-card border border-border p-4">
        <div className="flex min-h-8 items-center gap-2.5">
          <Users size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-2" />
          <TeamName key={team.name} team={team} />
        </div>
        {owner && <InviteField team={team} />}
        {current ? (
          <ul aria-label={`People in ${team.name}`} className="m-0 flex list-none flex-col p-0">
            {current.members.map((member) => {
              const you = member.email === me;
              return (
                <PersonRow
                  key={member.id}
                  email={member.email}
                  color={colorOf(member.email)}
                  title={`${displayName(member.email)}${you ? ' (you)' : ''}`}
                  sub={member.email}
                  role={member.role === 'owner' ? 'Owner' : 'Member'}
                  action={
                    owner && !you && member.role !== 'owner' ? (
                      <button
                        type="button"
                        aria-label={`Remove ${member.email}`}
                        title={`Remove ${member.email} from ${team.name}`}
                        disabled={busy !== null}
                        onClick={() => void remove(member.id, member.email)}
                        className={QUIET}
                      >
                        Remove
                      </button>
                    ) : owner ? (
                      <span aria-hidden className="w-[62px] shrink-0" />
                    ) : undefined
                  }
                />
              );
            })}
            {current.invites.map((invite) => (
              <PersonRow
                key={invite.email}
                email={invite.email}
                color={colorOf(invite.email)}
                title={displayName(invite.email)}
                sub={`${invite.email} · Invited · waiting`}
                role="Member"
                action={
                  owner ? (
                    <button
                      type="button"
                      aria-label={`Cancel the invitation to ${invite.email}`}
                      title="Cancel the invitation"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(`cancel:${invite.email}`, async () => {
                          await send({ type: 'team-cancel-invite', email: invite.email });
                          toast(`Cancelled the invitation to ${invite.email}.`, { tone: 'success' });
                        })
                      }
                      className={QUIET}
                    >
                      Cancel
                    </button>
                  ) : undefined
                }
              />
            ))}
          </ul>
        ) : (
          <div aria-hidden className="flex flex-col gap-2">
            <div className="h-[44px] rounded-control bg-bg-subtle" />
            <div className="h-[44px] rounded-control bg-bg-subtle" />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
          <p className="m-0 min-w-0 flex-1 text-small text-text-2">{teamSeatsLine(team.seats, owner ? plan.interval : null)}</p>
          {owner ? (
            <button type="button" disabled={busy !== null} onClick={() => void billing()} className={SECONDARY_SM}>
              {busy === 'billing' ? <LoaderCircle size={12} aria-hidden className="tf-spin" /> : <ExternalLink size={14} strokeWidth={1.75} aria-hidden className="text-text-2" />}
              Manage billing
            </button>
          ) : (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void leave()}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control px-2 text-small font-semibold text-red hover:bg-red-soft disabled:opacity-60"
            >
              {busy === 'leave' ? <LoaderCircle size={12} aria-hidden className="tf-spin" /> : <LogOut size={14} strokeWidth={1.75} aria-hidden />}
              Leave team
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
