import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft' | 'accent-soft';
export type ButtonSize = 'lg' | 'md' | 'sm' | 'xs';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent font-semibold hover:bg-accent-hover disabled:bg-hover disabled:text-text-3',
  secondary: 'border border-border-strong bg-surface text-text hover:bg-hover disabled:text-text-3 disabled:border-border',
  ghost: 'text-text-2 hover:bg-hover hover:text-text disabled:text-text-3',
  danger: 'bg-red-solid text-white font-semibold hover:brightness-95',
  'danger-soft': 'border border-red-line bg-red-soft text-red font-semibold hover:brightness-95',
  'accent-soft': 'border border-accent-line bg-accent-soft text-accent-text font-semibold hover:brightness-95',
};

const SIZES: Record<ButtonSize, string> = {
  lg: 'h-10 px-4 gap-2',
  md: 'h-9 px-3 gap-2',
  sm: 'h-8 px-3 gap-1.5',
  xs: 'h-7 px-2.5 gap-1.5 text-small font-semibold',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  trailing?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, trailing, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-control whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
      {trailing}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'default' | 'muted' | 'on-hover';
}

const ICON_SIZES = { sm: 'size-6 rounded-md', md: 'size-7 rounded-md', lg: 'size-8 rounded-control' };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', tone = 'default', className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center transition-colors duration-150 hover:bg-hover hover:text-text disabled:opacity-50',
        tone === 'muted' ? 'text-text-3' : 'text-text-2',
        ICON_SIZES[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
