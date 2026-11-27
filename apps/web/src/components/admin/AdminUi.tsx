'use client';

/**
 * Admin console shared UI — dark/red, same visual language as the game
 * (globals.css tokens: #0A0A0B bg, #141416 surface, #26262B border,
 * #EF4444 primary, #A1A1AA muted, 14 px radius, 48 px tap targets).
 */
import { useState, type ReactNode } from 'react';
import { confirmNext } from '../../lib/admin/confirm';

export function AdminCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-[14px] border border-[#26262B] bg-[#141416] p-4 ${className}`}>
      {children}
    </div>
  );
}

export function AdminSectionTitle({ title, blurb }: { title: string; blurb?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-[17px] font-bold text-white">{title}</h2>
      {blurb ? <p className="mt-0.5 text-[13px] text-[#A1A1AA]">{blurb}</p> : null}
    </div>
  );
}

/** Loading state — a real signal (data is being fetched), not a fake spinner. */
export function AdminLoading({ what }: { what: string }) {
  return (
    <p role="status" className="py-6 text-center text-[15px] text-[#A1A1AA]">
      Loading {what}…
    </p>
  );
}

/** Error state with a working Retry. */
export function AdminError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-[14px] border border-[#EF4444]/50 bg-[#141416] p-4">
      <p className="text-[15px] font-semibold text-white">Couldn&apos;t load this page.</p>
      <p className="mt-1 text-[14px] text-[#A1A1AA]">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 h-12 w-full rounded-[14px] bg-[#EF4444] text-[15px] font-bold text-white active:bg-[#DC2626]"
      >
        Try again
      </button>
    </div>
  );
}

export function AdminEmpty({ message }: { message: string }) {
  return (
    <p role="status" className="py-4 text-center text-[15px] text-[#A1A1AA]">
      {message}
    </p>
  );
}

/** Plain-words notice when the logged-in role may not do something. */
export function AdminDenied({ message }: { message: string }) {
  return (
    <p role="status" className="rounded-[14px] border border-[#26262B] bg-[#141416] px-4 py-3 text-[14px] text-[#A1A1AA]">
      {message}
    </p>
  );
}

/**
 * Destructive action button — two taps, never one.
 * Tap 1 arms: the button turns into "Tap again to confirm" and the
 * consequence line appears underneath. Tap 2 runs `onConfirm`. The
 * Cancel link disarms. A single accidental tap can never run it.
 */
export function ConfirmAction({
  label,
  confirmLabel,
  consequence,
  onConfirm,
  busy = false,
  danger = true,
}: {
  label: string;
  confirmLabel: string;
  consequence: string;
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
  danger?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const handleTap = () => {
    const next = confirmNext(armed ? 'armed' : 'idle', { type: 'tap' });
    setArmed(next.state === 'armed');
    if (next.confirmed) {
      void Promise.resolve(onConfirm()).finally(() => setArmed(false));
    }
  };
  return (
    <div>
      <button
        type="button"
        onClick={handleTap}
        disabled={busy}
        aria-label={armed ? confirmLabel : label}
        className={`h-12 w-full rounded-[14px] px-4 text-[15px] font-bold text-white disabled:opacity-50 ${
          armed
            ? 'bg-[#DC2626]'
            : danger
              ? 'bg-[#EF4444] active:bg-[#DC2626]'
              : 'bg-[#1E1E22] text-[#EF4444]'
        }`}
      >
        {busy ? 'Working…' : armed ? confirmLabel : label}
      </button>
      {armed ? (
        <div className="mt-2">
          <p className="text-[13px] leading-snug text-[#A1A1AA]">{consequence}</p>
          <button
            type="button"
            onClick={() => setArmed(false)}
            className="mt-1 min-h-[48px] text-[14px] font-semibold text-[#A1A1AA]"
          >
            Cancel — keep things as they are
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** One-line explainer under a control, in the game's muted style. */
export function Explainer({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[13px] leading-snug text-[#A1A1AA]">{children}</p>;
}

/**
 * NotAvailable — THE shared "not live yet" state (founder scope
 * addition, 2026-11-25): same copy, same layout everywhere. A
 * clock mark, the one heading "Not available at the moment — future
 * upgrade", one unlock line (what turns it on), and where relevant a
 * "what this will do" line. Never a fake number, never fake data.
 *
 * `enabled` is the LIVE flag state fetched from GET /v1/admin/flags
 * (merge, 2026-11-27 — Meera fix 1): it drives `data-future-enabled`
 * and the "Flag: … — on/off" line. It defaults to false so callers
 * that have not fetched the flag yet still render the honest OFF
 * state — never claim ON without a fetched value.
 */
export function NotAvailable({
  flagKey,
  willDo,
  unlocksWhen,
  enabled = false,
}: {
  flagKey: string;
  willDo?: string;
  unlocksWhen: string;
  enabled?: boolean;
}) {
  return (
    <div
      role="status"
      data-future-flag={flagKey}
      data-future-enabled={enabled ? 'true' : 'false'}
      className="rounded-[14px] border border-[#26262B] bg-[#141416] p-4 text-center"
    >
      <p aria-hidden className="text-[28px] leading-none text-[#A1A1AA]">
        ◷
      </p>
      <p className="mt-2 text-[15px] font-bold text-white">
        Not available at the moment — future upgrade.
      </p>
      {willDo ? <p className="mt-1 text-[14px] text-[#A1A1AA]">{willDo}</p> : null}
      <p className="mt-1 text-[13px] text-[#A1A1AA]">{unlocksWhen}</p>
      <p className="mt-2 text-[12px] text-[#A1A1AA]">Flag: {flagKey} — {enabled ? 'on' : 'off'}</p>
    </div>
  );
}

/** Small label + value row used on detail pages. */
export function AdminRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[#26262B] py-2 last:border-b-0">
      <span className="text-[14px] text-[#A1A1AA]">{label}</span>
      <span className="text-right text-[14px] font-semibold text-white">{value}</span>
    </div>
  );
}
