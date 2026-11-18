'use client';
import { useEffect, useState } from 'react';
import { THEME_CHANGE_EVENT } from '@/components/match/ThemeControls';

/** Accessibility settings, persisted on this device (demo).
 *  localStorage keys: pakdam.a11y.large-text, pakdam.a11y.high-contrast,
 *  pakdam.a11y.colour-blind, pakdam.dark-mode (shared with the header
 *  ThemeControls toggle — one key, one `dark` class on <html>).
 *  Settings apply on this page immediately and site-wide: the
 *  layout-level AccessibilityProvider re-applies them from storage
 *  on every page and navigation.
 *
 *  Sync (2026-11-17, UI worker): the header toggle and this page share
 *  the dark-mode key, so this page listens for `pakdam:theme-change`
 *  (and cross-tab `storage` events) and re-reads localStorage — the
 *  checkbox here stays in step with the header toggle without a
 *  reload, and this page dispatches the same event after it persists a
 *  change so the header checkbox follows it. The dispatch happens in
 *  the persisting effect, after the write, so listeners always read
 *  the fresh value; a sync that reads back identical values is a
 *  React no-op, so there is no event loop.
 *
 *  NOTE (2026-11-17, one-map decision): there is NO map-style
 *  setting any more — the map is one bundled offline map (Doranda +
 *  Hinoo), with no style switcher. The High contrast checkbox and
 *  the Colour-blind theme above are page-level treatments, not map
 *  providers, and they stay. */
const KEYS = {
  largeText: 'pakdam.a11y.large-text',
  highContrast: 'pakdam.a11y.high-contrast',
  colourBlind: 'pakdam.a11y.colour-blind',
  darkMode: 'pakdam.dark-mode',
} as const;

export default function AccessibilitySettings() {
  const [largeText, setLargeText] = useState(false);
  const [highContrast, setHighContrast] = useState(false);
  const [colourBlind, setColourBlind] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLargeText(localStorage.getItem(KEYS.largeText) === '1');
    setHighContrast(localStorage.getItem(KEYS.highContrast) === '1');
    setColourBlind(localStorage.getItem(KEYS.colourBlind) === '1');
    setDarkMode(localStorage.getItem(KEYS.darkMode) === 'on');
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const root = document.documentElement;
    root.style.fontSize = largeText ? '112.5%' : '';
    root.style.filter = highContrast ? 'contrast(1.25)' : '';
    root.dataset.colourBlind = colourBlind ? 'on' : 'off';
    root.classList.toggle('dark', darkMode);
    localStorage.setItem(KEYS.largeText, largeText ? '1' : '0');
    localStorage.setItem(KEYS.highContrast, highContrast ? '1' : '0');
    localStorage.setItem(KEYS.colourBlind, colourBlind ? '1' : '0');
    localStorage.setItem(KEYS.darkMode, darkMode ? 'on' : 'off');
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }, [largeText, highContrast, colourBlind, darkMode, loaded]);

  // Stay in sync with the header toggle (same localStorage keys): when
  // it changes a setting, re-read storage instead of showing stale
  // checkboxes until a reload.
  useEffect(() => {
    if (!loaded) return;
    const sync = () => {
      setLargeText(localStorage.getItem(KEYS.largeText) === '1');
      setHighContrast(localStorage.getItem(KEYS.highContrast) === '1');
      setColourBlind(localStorage.getItem(KEYS.colourBlind) === '1');
      setDarkMode(localStorage.getItem(KEYS.darkMode) === 'on');
    };
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [loaded]);

  return (
    <div>
      <h1>Accessibility</h1>
      <p>Pakdam targets WCAG 2.2 AA: normal text 4.5:1, large and non-text content 3:1 — across the website and the app. This statement is version 1, dated 16 November 2026, and is reviewed whenever the design system changes.</p>

      <h2>Your settings</h2>
      {!loaded ? <p>Loading your settings…</p> : (
        <div className="card">
          <p><label><input type="checkbox" checked={largeText} onChange={(e) => setLargeText(e.target.checked)} /> Large text</label></p>
          <p><label><input type="checkbox" checked={highContrast} onChange={(e) => setHighContrast(e.target.checked)} /> High contrast</label></p>
          <p><label><input type="checkbox" checked={colourBlind} onChange={(e) => setColourBlind(e.target.checked)} /> Colour-blind theme</label></p>
          <p><label><input type="checkbox" checked={darkMode} onChange={(e) => setDarkMode(e.target.checked)} /> Dark mode</label></p>
          <p className="small">Settings are saved on this device and persist between visits. They apply on this page immediately and on every page — the layout provider re-applies them whenever you navigate.</p>
        </div>
      )}

      <h2>What is provided</h2>
      <ul>
        <li>Colour-blind theme — one switch, persisted (above)</li>
        <li>Dark mode — one switch, persisted (above); also in the strip under the top bar on every page</li>
        <li>Large-text setting (above)</li>
        <li>Reduced-motion is respected where the browser requests it</li>
        <li>Keyboard operability and screen-reader labels on interactive controls</li>
      </ul>

      <h2>Known limitations</h2>
      <p>The map is a visual surface and is not itself fully accessible. The non-visual equivalents are the compass-radar view and text alternatives: hot/cold tiers, &ldquo;last reported X min ago&rdquo;, and the hunt board. We do not claim the map itself is fully accessible.</p>

      <h2>Report a barrier</h2>
      <p>If something is hard or impossible to use, tell us via the <a href="/contact">contact form</a> (topic: Accessibility) or file a <a href="/grievance">grievance</a>. We acknowledge reports and fix them through the normal review process — no fix timeline is promised here.</p>
    </div>
  );
}
