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
 *    colour-blind    — localStorage pakdam.a11y.colour-blind ('1'/'0')
 *    dark mode       — localStorage pakdam.dark-mode ('on'/'off'), the
 *                      `dark` class on <html> (tokens.css html.dark)
 *  (No map-style setting: one-map decision, 2026-11-17 — the map is
 *  one bundled offline map with no style switcher.)
 *  Reduced motion has no toggle: the Accessibility page states it is
 *  respected where the browser requests it, so there is nothing to apply.
 *
 *  Effects are applied to <html>, the same way the Accessibility page
 *  applied them to itself: font-size 112.5% for large text, a contrast
 *  filter for high contrast, and the data-colour-blind attribute.
 *  Colour-blind additionally mirrors to the `cb-theme` class,
 *  because that is the only hook tokens.css styles (data-colour-blind
 *  alone has no CSS rule).
 *
 *  Colour-blind has two pre-existing keys: the Accessibility page's
 *  pakdam.a11y.colour-blind and ThemeControls' pakdam.colorblind-theme
 *  (the nav toggle in the root layout). The provider reconciles them on
 *  load — either one on means on — and writes the resolved value back to
 *  both, so the two controls agree from then on.
 *
 *  The Accessibility page keeps its own state and writes the keys
 *  directly; a MutationObserver mirrors its data-colour-blind changes to
 *  the cb-theme class immediately, so toggling colour-blind on that page
 *  takes effect without a reload. Settings are re-applied from storage
 *  on every navigation as a safety net. */
const KEYS = {
  largeText: 'pakdam.a11y.large-text',
  highContrast: 'pakdam.a11y.high-contrast',
  colourBlind: 'pakdam.a11y.colour-blind',
} as const;
/** ThemeControls' key for the same colour-blind theme (see above). */
const THEME_KEY = 'pakdam.colorblind-theme';
/** ThemeControls' key for dark mode (2026-11-17) — one key, shared by
 *  the header toggle and the Accessibility page; the provider applies
 *  the `dark` class from it on every page and navigation. */
const DARK_KEY = 'pakdam.dark-mode';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — settings apply for this visit only */
  }
}

function applyFromStorage(): void {
  const root = document.documentElement;
  const largeText = read(KEYS.largeText) === '1';
  const highContrast = read(KEYS.highContrast) === '1';
  const colourBlind = read(KEYS.colourBlind) === '1' || read(THEME_KEY) === 'on';
  const dark = read(DARK_KEY) === 'on';

  root.style.fontSize = largeText ? '112.5%' : '';
  root.style.filter = highContrast ? 'contrast(1.25)' : '';
  root.dataset.colourBlind = colourBlind ? 'on' : 'off';
  root.classList.toggle('cb-theme', colourBlind);
  root.classList.toggle('dark', dark);
  // Reconcile the two colour-blind keys so both controls agree.
  write(KEYS.colourBlind, colourBlind ? '1' : '0');
  write(THEME_KEY, colourBlind ? 'on' : 'off');
}

export default function AccessibilityProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Re-apply from storage on mount and on every navigation.
  useEffect(() => {
    applyFromStorage();
  }, [pathname]);

  // Mirror the Accessibility page's own data-colour-blind toggles to the
  // cb-theme class (and the ThemeControls key) as soon as they happen.
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-colour-blind') {
          const on = root.dataset.colourBlind === 'on';
          root.classList.toggle('cb-theme', on);
          write(THEME_KEY, on ? 'on' : 'off');
        }
      }
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-colour-blind'] });
    return () => observer.disconnect();
  }, []);

  return <>{children}</>;
}
