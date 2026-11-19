'use client';

import type { ReactNode } from 'react';

/**
 * Bottom sheet / modal — SCRAM-SPEC §8d (··· More sheet) and §11.
 * Sheet radius 20 px top, drag handle, surface #141416. Renders nothing
 * when closed. Escape closes; the backdrop tap closes.
 */
export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

export function Sheet({ open, onClose, title, children }: SheetProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div className="relative max-h-[85dvh] w-full max-w-[560px] overflow-y-auto rounded-t-[20px] border-t border-[#26262B] bg-[#141416] pb-[env(safe-area-inset-bottom,0px)]">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-[#26262B]" aria-hidden />
        {title ? (
          <div className="flex items-center justify-between px-4 pb-2 pt-3">
            <h2 className="text-[18px] font-bold text-white">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close sheet"
              className="text-[15px] font-semibold text-[#EF4444]"
            >
              Done
            </button>
          </div>
        ) : null}
        <div className="px-4 pb-4">{children}</div>
      </div>
    </div>
  );
}
