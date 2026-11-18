'use client';
import { useEffect, useState } from 'react';

/** Colour-blind theme switch (07 §8). One switch, persisted per player in
 *  localStorage, toggles a class on <html>. Team encoding never changes:
 *  Hunters stay ◆ "H" solid, Runners stay ▲ "R" hatched — the theme only
 *  changes hues, never the redundant shape/letter/pattern encoding.
 *
 *  Dark mode (2026-11-17): a second switch on the same strip, same
 *  pattern — key pakdam.dark-mode ('on'/'off'), toggles the `dark`
 *  class on <html>, applied site-wide by AccessibilityProvider from
 *  the same key.
 *
 *  Sync (2026-11-17, UI worker): this strip lives in the root layout,
 *  so it does NOT remount on client-side navigation — its checkbox
 *  used to go stale when dark mode was toggled on the Accessibility
 *  page (and vice versa). Both controls now dispatch
 *  `pakdam:theme-change` on every toggle and re-read localStorage when
 *  they hear it (or a cross-tab `storage` event), so the two checkboxes
 *  always agree without a reload. */
const KEY = 'pakdam.colorblind-theme';
const DARK_KEY = 'pakdam.dark-mode';
/** Fired on window whenever either theme control changes a setting. */
export const THEME_CHANGE_EVENT = 'pakdam:theme-change';

export function isColorBlindTheme(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(KEY) === 'on';
}

export function isDarkMode(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(DARK_KEY) === 'on';
}

function readState(): { cb: boolean; dark: boolean } {
  return {
    cb: localStorage.getItem(KEY) === 'on',
    dark: localStorage.getItem(DARK_KEY) === 'on',
  };
}

function applyState(cb: boolean, dark: boolean): void {
  document.documentElement.classList.toggle('cb-theme', cb);
  document.documentElement.classList.toggle('dark', dark);
}

export default function ThemeControls() {
  const [on, setOn] = useState(false);
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const sync = () => {
      const s = readState();
      setOn(s.cb);
      setDark(s.dark);
      applyState(s.cb, s.dark);
    };
    sync();
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const toggle = () => {
    const next = !on;
    setOn(next);
    localStorage.setItem(KEY, next ? 'on' : 'off');
    document.documentElement.classList.toggle('cb-theme', next);
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  };
  const toggleDark = () => {
    const next = !dark;
    setDark(next);
    localStorage.setItem(DARK_KEY, next ? 'on' : 'off');
    document.documentElement.classList.toggle('dark', next);
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  };
  return (
    <>
      <label className="theme-toggle">
        <input type="checkbox" checked={on} onChange={toggle} aria-label="Colour-blind theme" />
        Colour-blind theme: {on ? 'on' : 'off'}
        <span className="small"> Hunters ◆ H solid · Runners ▲ R hatched — shape and letter never change.</span>
      </label>
      {' '}
      <label className="theme-toggle">
        <input type="checkbox" checked={dark} onChange={toggleDark} aria-label="Dark mode" />
        Dark mode: {dark ? 'on' : 'off'}
      </label>
    </>
  );
}
