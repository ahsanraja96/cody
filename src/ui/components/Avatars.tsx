import { initials } from '@/lib/teams';
import type { TabGroupColor } from '@/lib/types';
import { cx } from '../cx';
import './FoldedList.css';

/** Someone in a team, as the pages show them: their email and avatar colour. */
export interface Person {
  email: string;
  color: TabGroupColor;
}

/** A round avatar with two initials from the email, in a Chrome tab group colour (Mx-Share). */
export function Avatar({ email, color, size = 22, className }: Person & { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      title={email}
      className={cx(`tf-cg-${color}`, 'inline-flex shrink-0 items-center justify-center rounded-full leading-none font-semibold select-none', className)}
      style={{
        width: size,
        height: size,
        background: 'var(--tf-cg)',
        color: 'var(--tf-cg-on)',
        fontSize: size < 26 ? 10 : 12,
        boxShadow: '0 0 0 2px var(--tf-surface)',
      }}
    >
      {initials(email)}
    </span>
  );
}

/** Overlapping avatars ("IH SA MK"): the first `max`, then "+2". Read as "<label>". */
export function AvatarStack({ people, size = 22, max = 4, label, className }: { people: Person[]; size?: number; max?: number; label: string; className?: string }) {
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  return (
    <span role="img" aria-label={label} title={people.map((p) => p.email).join(', ')} className={cx('inline-flex shrink-0 items-center', className)}>
      {shown.map((person, index) => (
        <span key={person.email} className="inline-flex" style={{ marginLeft: index === 0 ? 0 : -6 }}>
          <Avatar {...person} size={size} />
        </span>
      ))}
      {more > 0 && (
        <span
          aria-hidden
          className="ml-1 inline-flex shrink-0 items-center text-meta font-semibold text-text-3"
          style={{ height: size }}
        >
          +{more}
        </span>
      )}
    </span>
  );
}
