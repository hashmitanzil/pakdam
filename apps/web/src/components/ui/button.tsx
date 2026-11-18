/**
 * Button — the shadcn/ui Button API shape on the app's own design
 * system (plain CSS tokens, `apps/web/src/styles/tokens.css`).
 *
 * FOUNDATION ONLY (founder-approved final stack: Tailwind + shadcn/ui).
 * Tailwind itself is NOT installed (no cached tarball, network install
 * EPERM-blocked in this sandbox), so there is no `tailwind.config`,
 * no `@tailwind` directives, and no `class-variance-authority` /
 * `clsx` / `tailwind-merge` / `lucide-react`. The variants below map
 * onto the token classes that already exist; the API shape
 * (variant + size props, `cn` for class merging) is the shadcn shape,
 * so the full Tailwind + shadcn install later swaps the class map
 * without changing call sites.
 *
 * Variants implemented: default, secondary, destructive, dark.
 * NOT implemented: outline, ghost, link — no matching token class
 * exists for them yet; adding them is a design decision for the full
 * restyle, not something to invent here. `asChild` (Radix Slot) is
 * also not implemented — this is a plain `<button>`.
 *
 * Full 85-screen restyle = remaining work. This file is the
 * foundation + one real usage (the "Retry location" buttons in
 * PlayAreaMap / ZoneEditor), not a restyle.
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary' | 'destructive' | 'dark';
  size?: 'default' | 'sm' | 'lg' | 'icon';
}

const VARIANTS: Record<NonNullable<ButtonProps['variant']>, string> = {
  default: 'btn',
  secondary: 'btn btn-secondary',
  destructive: 'btn btn-danger',
  dark: 'btn btn-dark',
};

const SIZES: Record<NonNullable<ButtonProps['size']>, string> = {
  default: '',
  sm: 'btn-sm',
  lg: 'btn-lg',
  icon: 'btn-icon',
};

export function Button({
  variant = 'default',
  size = 'default',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(VARIANTS[variant], SIZES[size], className)}
      {...props}
    />
  );
}
