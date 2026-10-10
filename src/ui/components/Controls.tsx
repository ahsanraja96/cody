import { useId, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cx } from '../cx';

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-150 disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-border-strong',
      )}
    >
      <span
        aria-hidden
        className={cx(
          'absolute top-0.5 size-3.5 rounded-full bg-white transition-[left] duration-150',
          checked ? 'left-4' : 'left-0.5',
        )}
      />
    </button>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
  disabled,
  indeterminate,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
  disabled?: boolean;
  indeterminate?: boolean;
}) {
  return (
    <label className={cx('inline-flex items-center gap-2', disabled ? 'text-text-3' : 'cursor-pointer')}>
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        ref={(el) => {
          if (el) el.indeterminate = !!indeterminate;
        }}
      />
      <span
        aria-hidden
        className={cx(
          'inline-flex size-4 shrink-0 items-center justify-center rounded peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
          checked || indeterminate ? 'bg-accent text-on-accent' : 'border border-border-strong bg-surface',
          disabled && (checked ? 'bg-border-strong' : ''),
        )}
      >
        {indeterminate ? (
          <span className="h-0.5 w-2 rounded bg-current" />
        ) : (
          checked && <Check size={11} strokeWidth={3} />
        )}
      </span>
      {children}
    </label>
  );
}

export function RadioGroup<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: ReactNode }>;
  label: string;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-2">
      {options.map((option) => (
        <label key={option.value} className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            className="peer sr-only"
            name={name}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span
            aria-hidden
            className={cx(
              'size-4 shrink-0 rounded-full bg-surface peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
              value === option.value ? 'border-[5px] border-accent' : 'border border-border-strong',
            )}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-8 rounded-control border border-border-strong bg-bg-subtle p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cx(
            'inline-flex h-[26px] items-center justify-center gap-1.5 rounded-md px-3',
            value === option.value ? 'border border-border bg-surface font-semibold text-text' : 'text-text-2 hover:text-text',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string | number>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  label: string;
  className?: string;
}) {
  return (
    <span className={cx('relative inline-flex', className)}>
      <select
        aria-label={label}
        value={String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const match = options.find((o) => String(o.value) === raw);
          if (match) onChange(match.value);
        }}
        className="h-8 w-full appearance-none rounded-control border border-border-strong bg-surface py-0 pr-8 pl-2.5 font-semibold text-text"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-text-3" />
    </span>
  );
}
