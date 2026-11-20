import { memo } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Primary / outline / ghost buttons — SCRAM-SPEC §11.
 * Primary: red #EF4444 fill, white bold 17 px, height 56 px, radius 14 px,
 * pressed #DC2626. A blocked action is NEVER a disabled button — callers
 * render the grey "blocked bar" variant and answer the tap in one line.
 */
export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'blocked';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

const base =
  'inline-flex w-full items-center justify-center gap-2 rounded-[14px] px-4 text-[17px] font-bold leading-none transition-colors select-none';

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-[#EF4444] text-white hover:bg-[#DC2626] active:bg-[#DC2626] h-14',
  outline:
    'bg-transparent text-[#EF4444] border-[1.5px] border-[#EF4444] h-12 text-[13px] uppercase tracking-wide',
  ghost: 'bg-transparent text-[#EF4444] h-12 text-[15px] font-semibold',
  // Blocked state (§5g): a grey bar, NOT a disabled button — it stays
  // tappable so the tap can answer in plain language.
  blocked:
    'bg-[#1E1E22] text-[#A1A1AA] h-14 border border-[#26262B]',
};

/** Memoized: the play page re-renders every second on its clock tick —
 *  a button with stable props must not re-render with it. */
export const Button = memo(function Button({
  variant = 'primary',
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button type="button" className={`${base} ${variants[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
});
