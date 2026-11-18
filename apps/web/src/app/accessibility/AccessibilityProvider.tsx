'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/** Layout-level accessibility provider — applies the persisted settings
 *  from the Accessibility page on EVERY page, not just /accessibility.
 *
 *  Settings (exactly the ones the Accessibility page offers — no new
 *  settings are invented here):
 *    large text      — localStorage pakdam.a11y.large-text ('1'/'0')
 *    high contrast   — localStorage pakdam.a11y.high-contrast ('1'/'0')
 *  (No map-style setting: one-map decision, 2026-11-17 — the map is
 *  one bundled offline map with no style switcher.)
 *  There is no theme setting any more (2026-11-18, simplification):
 *  Pakdam has ONE dark theme, applied by the base tokens in
 *  tokens.css — no light theme, no toggle, no class to apply.
 *  Reduced motion has no toggle: the Accessibility page states it is
 *  respected where the browser requests it, so there is nothing to apply.
 *
 *  Effects are applied to <html>, the same way the Accessibility page
 *  applied them to itself: font-size 112.5% for large text and a
 *  contrast filter for high contrast. Settings are re-applied from
 *  storage on every navigation as a safety net. */
const KEYS = {
  largeText: 'pakdam.a11y.large-text',
  highContrast: 'pakdam.a11y.high-contrast',
} as const;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function applyFromStorage(): void {
  const root = document.documentElement;
  const largeText = read(KEYS.largeText) === '1';
  const highContrast = read(KEYS.highContrast) === '1';

  root.style.fontSize = largeText ? '112.5%' : '';
  root.style.filter = highContrast ? 'contrast(1.25)' : '';
}

export default function AccessibilityProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Re-apply from storage on mount and on every navigation.
  useEffect(() => {
    applyFromStorage();
  }, [pathname]);

  return <>{children}</>;
}
