'use client';

import { memo } from 'react';

/**
 * Bottom tabs — SCRAM-SPEC §8d / §11.
 * Three tabs: Map | Radio | ··· (More). Dark bar (#141416), top border
 * #26262B, safe-area padded. Active tab: red-tinted pill background
 * (rgba(239,68,68,0.15)) + red icon/label. Radio carries an unread badge
 * (red dot with white number). Labels always shown under icons.
 */
export type BottomTabId = 'map' | 'radio' | 'more';

export interface BottomTabsProps {
  active: BottomTabId;
  onChange: (tab: BottomTabId) => void;
  /** Unread radio count; badge shows only when > 0. */
  radioUnread?: number;
}

const tabs: { id: BottomTabId; label: string; icon: string }[] = [
  { id: 'map', label: 'Map', icon: '◈' },
  { id: 'radio', label: 'Radio', icon: '◉' },
  { id: 'more', label: '···', icon: '···' },
];

/** Memoized: the parent re-renders every second on its clock tick — the
 *  tab bar only re-renders when the active tab or unread count changes. */
export const BottomTabs = memo(function BottomTabs({ active, onChange, radioUnread = 0 }: BottomTabsProps) {
  return (
    <nav
      aria-label="Game"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[#26262B] bg-[#141416] pb-[env(safe-area-inset-bottom,0px)]"
    >
      <div className="grid grid-cols-3">
        {tabs.map((tab) => {
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onChange(tab.id)}
              className={`relative flex h-16 flex-col items-center justify-center gap-1 ${
                isActive
                  ? 'bg-[rgba(239,68,68,0.15)] text-[#EF4444]'
                  : 'text-[#A1A1AA]'
              }`}
            >
              <span aria-hidden className="text-[20px] leading-none">
                {tab.icon}
              </span>
              <span className="text-[12px] font-semibold leading-none">
                {tab.label}
              </span>
              {tab.id === 'radio' && radioUnread > 0 ? (
                <span className="absolute right-6 top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#EF4444] px-1 text-[11px] font-bold text-white pakdam-numeric">
                  {radioUnread > 99 ? '99+' : radioUnread}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
});
